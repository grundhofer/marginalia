// marginalia's hooks module. Every function that uses `$` lives in this one file: the plugin directory
// accepts `$` only when it is passed to a function declared at the top level of the same file. The logic
// that needs no `$` is in core.ts.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'
import type { PaneData, PaneRow } from '../types'
import {
  DEFAULT_TEAM_TYPES,
  applyBlock,
  compactSuggestions,
  indexAsLoaded,
  indexCost,
  isSafeNoteName,
  lintNotes,
  memoryDirFor,
  normalizeRemote,
  notListedOutsideBlock,
  parseNote,
  personalKey,
  planInbound,
  planOutbound,
  privacyScan,
  removalMark,
  renderBlock,
  setShare,
  type Note,
  type OutboundItem,
  type PrivacyFinding,
  type Rejections,
  type SyncState,
} from './core'

// ================================================================================================
// context
// ================================================================================================
// What both sync directions need: the repo, the folders, and whether marginalia may act here.

export type SyncContext = {
  repoRoot: string
  remoteKey: string | null
  /** `<repo>/.claude/memory`, committed. */
  teamDir: string
  /** Claude Code's auto-memory folder for this repo. */
  memoryDir: string
  stateKey: string
}

export type ContextResult = { ok: true; ctx: SyncContext } | { ok: false; reason: string; repoRoot?: string }

export const TEAM_DIR = '.claude/memory'
const VISIBILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Visibility = 'public' | 'private' | 'unknown'

/** GitHub only: an unauthenticated API read answers 200 for a public repo and 404 for a private one. */
async function visibilityOf($: EngineInterface, remoteKey: string | null): Promise<Visibility> {
  if (!remoteKey) return 'private' // no remote: nothing is published
  const [host, owner, name] = remoteKey.split('/')
  if (host !== 'github.com' || !owner || !name) return 'private' // other hosts: not checked yet, see PLAN.md
  const cacheKey = `visibility:${remoteKey}`
  const cached = (await $.store.get(cacheKey)) as { value: Visibility; at: number } | undefined
  const now = Date.now()
  if (cached && now - cached.at < VISIBILITY_TTL_MS) return cached.value
  try {
    const res = await $.http.fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'marginalia-claude-code-plugin' },
    })
    const value: Visibility = res.status === 200 ? 'public' : res.status === 404 ? 'private' : 'unknown'
    if (value !== 'unknown') await $.store.set(cacheKey, { value, at: now })
    return value === 'unknown' && cached ? cached.value : value
  } catch {
    return cached?.value ?? 'unknown'
  }
}

export async function readIfExists($: EngineInterface, path: string): Promise<string | undefined> {
  if (!(await $.fs.exists(path))) return undefined
  const text = await $.fs.read(path)
  return typeof text === 'string' ? text : undefined
}

export async function resolveMemoryDir($: EngineInterface, projectRoot: string): Promise<string | null> {
  const disabledEnv = await $.env.get('CLAUDE_CODE_DISABLE_AUTO_MEMORY')
  if (disabledEnv && disabledEnv !== '0' && disabledEnv.toLowerCase() !== 'false') return null
  if ((await $.settings.read({ key: 'autoMemoryEnabled' })) === false) return null
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const autoMemoryDirectory = await $.settings.read({ key: 'autoMemoryDirectory' })
  return memoryDirFor({
    home,
    configDir,
    projectRoot,
    autoMemoryDirectory: typeof autoMemoryDirectory === 'string' ? autoMemoryDirectory : undefined,
    projectDirNameOverride: await $.env.get('CLAUDE_CODE_PROJECT_DIR_NAME'),
  })
}

/**
 * Marginalia acts in a repo only when the team switched it on (the repo has `.claude/memory/`),
 * the repo is not public, and auto memory is on.
 */
export async function resolveContext($: EngineInterface): Promise<ContextResult> {
  const repo = await $.session.repo()
  if (!repo) return { ok: false, reason: 'not inside a git repository' }

  const teamDir = `${repo.root}/${TEAM_DIR}`
  if (!(await $.fs.exists(teamDir))) {
    return { ok: false, reason: `the repo has no ${TEAM_DIR}/ folder (run /marginalia init to switch it on)`, repoRoot: repo.root }
  }

  const remoteKey = normalizeRemote(repo.remote)
  const visibility = await visibilityOf($, remoteKey)
  if (visibility === 'public') return { ok: false, reason: 'public repository: marginalia stays off until switched on', repoRoot: repo.root }
  if (visibility === 'unknown') return { ok: false, reason: 'could not check whether the repository is public', repoRoot: repo.root }

  const memoryDir = await resolveMemoryDir($, repo.root)
  if (!memoryDir) return { ok: false, reason: 'auto memory is turned off', repoRoot: repo.root }

  return { ok: true, ctx: { repoRoot: repo.root, remoteKey, teamDir, memoryDir, stateKey: `sync:${memoryDir}` } }
}

/** Every plain note file in a folder, by name. A missing folder reads as empty. */
export async function readNotes($: EngineInterface, dir: string): Promise<Map<string, string>> {
  const notes = new Map<string, string>()
  if (!(await $.fs.exists(dir))) return notes
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !isSafeNoteName(entry.name)) continue
    const text = await readIfExists($, `${dir}/${entry.name}`)
    if (text !== undefined) notes.set(entry.name, text)
  }
  return notes
}

export async function readState($: EngineInterface, ctx: SyncContext): Promise<SyncState> {
  return ((await $.store.get(ctx.stateKey)) as SyncState | undefined) ?? {}
}

/** Deletes one note file inside `dir`; the fs API has no delete. */
export async function removeNote($: EngineInterface, dir: string, file: string): Promise<string | null> {
  if (!isSafeNoteName(file)) return 'not a plain note file name'
  const ran = await $.process.run(['rm', '-f', '--', `${dir}/${file}`])
  return ran.exitCode === 0 ? null : ran.stderr.trim() || `exit ${ran.exitCode}`
}

// ================================================================================================
// inbound
// ================================================================================================
// Inbound sync (M1): team notes committed in <repo>/.claude/memory/ -> the local auto-memory folder.

export type InboundResult =
  | { status: 'skipped'; reason: string }
  | { status: 'synced'; memoryDir: string; written: string[]; deleted: string[]; held: { file: string; reason: string }[]; teamNotes: number }

export async function syncInbound($: EngineInterface): Promise<InboundResult> {
  const resolved = await resolveContext($)
  if (!resolved.ok) return { status: 'skipped', reason: resolved.reason }
  const { ctx } = resolved

  const repoNotes = await readNotes($, ctx.teamDir)
  const state = await readState($, ctx)

  const local = new Map<string, string>()
  for (const file of new Set([...repoNotes.keys(), ...Object.keys(state)])) {
    if (!isSafeNoteName(file)) continue
    const text = await readIfExists($, `${ctx.memoryDir}/${file}`)
    if (text !== undefined) local.set(file, text)
  }

  const plan = planInbound(repoNotes, local, state)
  const written: string[] = []
  const deleted: string[] = []
  const held: { file: string; reason: string }[] = []

  for (const action of plan.actions) {
    if (!isSafeNoteName(action.file)) continue
    if (action.kind === 'write') {
      await $.fs.write(`${ctx.memoryDir}/${action.file}`, action.text)
      local.set(action.file, action.text)
      written.push(action.file)
    } else if (action.kind === 'delete') {
      const failed = await removeNote($, ctx.memoryDir, action.file)
      if (failed === null) {
        local.delete(action.file)
        deleted.push(action.file)
      } else {
        held.push({ file: action.file, reason: `could not delete: ${failed}` })
      }
    } else {
      held.push({ file: action.file, reason: action.reason })
    }
  }

  await $.store.set(ctx.stateKey, plan.state)
  const teamNotes = await refreshIndex($, ctx.memoryDir, local)
  return { status: 'synced', memoryDir: ctx.memoryDir, written, deleted, held, teamNotes }
}

/**
 * Rewrites marginalia's block in MEMORY.md: one line per note marginalia synced (team notes and
 * personal notes) that is present locally, skipping notes Claude already lists itself outside
 * the block. Returns the count of synced notes present locally.
 */
export async function refreshIndex(
  $: EngineInterface,
  memoryDir: string,
  local?: ReadonlyMap<string, string>,
): Promise<number> {
  const team = ((await $.store.get(`sync:${memoryDir}`)) as SyncState | undefined) ?? {}
  const personal = ((await $.store.get(`personal:${memoryDir}`)) as SyncState | undefined) ?? {}
  const teamNotes: Note[] = []
  for (const file of new Set([...Object.keys(team), ...Object.keys(personal)])) {
    const text = local?.get(file) ?? (await readIfExists($, `${memoryDir}/${file}`))
    if (text !== undefined) teamNotes.push(parseNote(file, text))
  }
  const indexPath = `${memoryDir}/MEMORY.md`
  const before = (await readIfExists($, indexPath)) ?? ''
  const after = applyBlock(before, renderBlock(notListedOutsideBlock(teamNotes, before)))
  if (after !== before) await $.fs.write(indexPath, after)
  return teamNotes.length
}

// ================================================================================================
// outbound
// ================================================================================================
// Outbound sync (M2): team notes from the local auto-memory folder -> <repo>/.claude/memory/.
// Marginalia writes the files; it never commits. The person commits like any other change.

export type ShareMode = 'confirm' | 'auto'

export type Pending = { item: OutboundItem; findings: PrivacyFinding[] }

export type OutboundScan = { ok: false; reason: string; repoRoot?: string } | { ok: true; ctx: SyncContext; pending: Pending[] }

const rejectedKey = (ctx: SyncContext) => `rejected:${ctx.memoryDir}`

export async function scanOutbound($: EngineInterface, privacyCheck: boolean): Promise<OutboundScan> {
  const resolved = await resolveContext($)
  if (!resolved.ok) return resolved
  const { ctx } = resolved
  const local = await readNotes($, ctx.memoryDir)
  const repo = await readNotes($, ctx.teamDir)
  const state = await readState($, ctx)
  const rejected = ((await $.store.get(rejectedKey(ctx))) as Rejections | undefined) ?? {}
  const pending = planOutbound(local, repo, state, rejected).map(item => ({
    item,
    findings: privacyCheck && item.kind !== 'remove' ? privacyScan(item.text) : [],
  }))
  return { ok: true, ctx, pending }
}

export type Applied = { applied: OutboundItem[]; failed: { file: string; reason: string }[] }

export async function applyItems($: EngineInterface, ctx: SyncContext, items: readonly OutboundItem[]): Promise<Applied> {
  const state = { ...(await readState($, ctx)) }
  const applied: OutboundItem[] = []
  const failed: { file: string; reason: string }[] = []
  for (const item of items) {
    if (item.kind === 'remove') {
      const err = await removeNote($, ctx.teamDir, item.file)
      if (err === null) {
        delete state[item.file]
        applied.push(item)
      } else {
        failed.push({ file: item.file, reason: err })
      }
    } else {
      await $.fs.write(`${ctx.teamDir}/${item.file}`, item.text)
      state[item.file] = item.fp
      applied.push(item)
    }
  }
  await $.store.set(ctx.stateKey, state)
  await refreshIndex($, ctx.memoryDir)
  return { applied, failed }
}

export async function reject($: EngineInterface, ctx: SyncContext, items: readonly OutboundItem[]): Promise<void> {
  const rejected = { ...(((await $.store.get(rejectedKey(ctx))) as Rejections | undefined) ?? {}) }
  for (const item of items) rejected[item.file] = item.kind === 'remove' ? removalMark(item.fp) : item.fp
  await $.store.set(rejectedKey(ctx), rejected)
}

export type OutboundRun = { ok: false; reason: string } | { ok: true; applied: OutboundItem[]; failed: { file: string; reason: string }[]; waiting: Pending[] }

/** In `auto` mode, shares what passes the privacy check; everything else waits for the person. */
export async function runOutbound($: EngineInterface, mode: ShareMode, privacyCheck: boolean): Promise<OutboundRun> {
  const scan = await scanOutbound($, privacyCheck)
  if (!scan.ok) return { ok: false, reason: scan.reason }
  if (mode === 'confirm') return { ok: true, applied: [], failed: [], waiting: scan.pending }
  const clean = scan.pending.filter(p => p.findings.length === 0).map(p => p.item)
  const { applied, failed } = await applyItems($, scan.ctx, clean)
  return { ok: true, applied, failed, waiting: scan.pending.filter(p => p.findings.length > 0) }
}

export function describe(p: Pending): string {
  const what = p.item.kind === 'remove' ? `remove (${p.item.why})` : p.item.kind
  const flags = p.findings.length
    ? ` — privacy check: ${[...new Set(p.findings.map(f => `${f.kind} (line ${f.line})`))].join(', ')}`
    : ''
  return `${what} ${p.item.file}${flags}`
}

// ================================================================================================
// personal
// ================================================================================================
// Personal sync (M3): the person's own notes <-> their private git store, on every machine.
// Next to a team-synced repo the store holds the private notes; for any other project it holds
// all notes, so project knowledge of a solo project still follows the person.

export type PersonalConfig = {
  /** The private store's git URL; empty switches personal sync off. */
  store: string
  mode: ShareMode
  privacyCheck: boolean
}

export type PersonalContext = {
  memoryDir: string
  storeDir: string
  /** The store folder for this project. */
  folder: string
  key: string
  stateKey: string
  rejectedKey: string
  wanted: 'private' | 'all'
}

type Resolved = { ok: true; pctx: PersonalContext } | { ok: false; reason: string }

export async function resolvePersonal($: EngineInterface, cfg: PersonalConfig): Promise<Resolved> {
  if (!cfg.store.trim()) return { ok: false, reason: 'no personal store configured' }
  const repo = await $.session.repo()
  let root = repo?.root
  if (root === undefined) root = await $.session.root()
  const memoryDir = await resolveMemoryDir($, root)
  if (!memoryDir) return { ok: false, reason: 'auto memory is turned off' }
  const home = (await $.env.get('HOME')) ?? ''
  const key = personalKey(normalizeRemote(repo?.remote), root, home)
  if (!key || key.split('/').some(part => part === '..' || part === '.' || part === '')) {
    return { ok: false, reason: 'this project has no remote and is outside the home folder' }
  }
  const team = await resolveContext($)
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const storeDir = `${configDir}/marginalia/personal`
  return {
    ok: true,
    pctx: {
      memoryDir,
      storeDir,
      folder: `${storeDir}/${key}`,
      key,
      stateKey: `personal:${memoryDir}`,
      rejectedKey: `personalRejected:${memoryDir}`,
      wanted: team.ok ? 'private' : 'all',
    },
  }
}

// One git operation at a time: parallel turns must not fight over the store's index.
let gitQueue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = gitQueue.then(work, work)
  gitQueue = next.catch(() => undefined)
  return next
}

async function git($: EngineInterface, storeDir: string, args: readonly string[], timeoutMs = 30000) {
  return $.process.run(['git', '-C', storeDir, ...args], { timeoutMs })
}

const failure = (r: { exitCode: number; stderr: string }) => r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`

/**
 * Whether the local clone exists and belongs to the configured store. A clone whose `origin`
 * differs (the setting changed) is never written to, so notes cannot land in the wrong repo.
 */
async function storeStatus($: EngineInterface, pctx: PersonalContext, url: string): Promise<'ok' | 'missing' | string> {
  if (!(await $.fs.exists(`${pctx.storeDir}/.git`))) return 'missing'
  const origin = await git($, pctx.storeDir, ['remote', 'get-url', 'origin'])
  const actual = origin.stdout.trim()
  if (origin.exitCode !== 0) return `the personal store clone at ${pctx.storeDir} has no origin`
  return actual === url.trim() ? 'ok' : `the personal store clone at ${pctx.storeDir} points to ${actual}, not to the configured ${url.trim()}; move it away to re-clone`
}

/** Clones the store on first use, then pulls. A failed pull still lets the local copy work. */
async function updateStore($: EngineInterface, pctx: PersonalContext, url: string): Promise<{ usable: boolean; warning: string | null }> {
  const status = await storeStatus($, pctx, url)
  if (status === 'missing') {
    const cloned = await $.process.run(['git', 'clone', '--quiet', url, pctx.storeDir], { timeoutMs: 120000 })
    return cloned.exitCode === 0 ? { usable: true, warning: null } : { usable: false, warning: `could not clone the personal store: ${failure(cloned)}` }
  }
  if (status !== 'ok') return { usable: false, warning: status }
  const pulled = await git($, pctx.storeDir, ['pull', '--rebase', '--autostash', '--quiet'])
  return { usable: true, warning: pulled.exitCode === 0 ? null : `could not pull the personal store: ${failure(pulled)}` }
}

async function commitAndPush($: EngineInterface, pctx: PersonalContext, message: string): Promise<string | null> {
  const added = await git($, pctx.storeDir, ['add', '-A', '--', pctx.key])
  if (added.exitCode !== 0) return `could not stage: ${failure(added)}`
  const staged = await git($, pctx.storeDir, ['diff', '--cached', '--quiet'])
  if (staged.exitCode === 0) return null // nothing to commit
  const committed = await git($, pctx.storeDir, ['commit', '--quiet', '-m', message])
  if (committed.exitCode !== 0) return `could not commit: ${failure(committed)}`
  let pushed = await git($, pctx.storeDir, ['push', '--quiet'])
  if (pushed.exitCode !== 0) {
    await git($, pctx.storeDir, ['pull', '--rebase', '--autostash', '--quiet'])
    pushed = await git($, pctx.storeDir, ['push', '--quiet'])
  }
  return pushed.exitCode === 0 ? null : `committed, but could not push: ${failure(pushed)}`
}

export type PersonalInbound =
  | { status: 'skipped'; reason: string }
  | { status: 'synced'; memoryDir: string; written: string[]; deleted: string[]; held: { file: string; reason: string }[]; warning: string | null }

/** At session start: pull the store and bring this project's notes into the local memory folder. */
export function syncPersonalInbound($: EngineInterface, cfg: PersonalConfig): Promise<PersonalInbound> {
  return serial(async () => {
    const resolved = await resolvePersonal($, cfg)
    if (!resolved.ok) return { status: 'skipped', reason: resolved.reason }
    const { pctx } = resolved
    const { usable, warning } = await updateStore($, pctx, cfg.store)
    if (!usable) return { status: 'skipped', reason: warning ?? 'the personal store is not usable' }

    const storeNotes = await readNotes($, pctx.folder)
    const state = ((await $.store.get(pctx.stateKey)) as SyncState | undefined) ?? {}
    const local = new Map<string, string>()
    for (const file of new Set([...storeNotes.keys(), ...Object.keys(state)])) {
      if (!isSafeNoteName(file)) continue
      const text = await readIfExists($, `${pctx.memoryDir}/${file}`)
      if (text !== undefined) local.set(file, text)
    }

    const plan = planInbound(storeNotes, local, state)
    const written: string[] = []
    const deleted: string[] = []
    const held: { file: string; reason: string }[] = []
    for (const action of plan.actions) {
      if (!isSafeNoteName(action.file)) continue
      if (action.kind === 'write') {
        await $.fs.write(`${pctx.memoryDir}/${action.file}`, action.text)
        local.set(action.file, action.text)
        written.push(action.file)
      } else if (action.kind === 'delete') {
        const err = await removeNote($, pctx.memoryDir, action.file)
        if (err === null) {
          local.delete(action.file)
          deleted.push(action.file)
        } else held.push({ file: action.file, reason: `could not delete: ${err}` })
      } else held.push({ file: action.file, reason: action.reason })
    }
    await $.store.set(pctx.stateKey, plan.state)
    await refreshIndex($, pctx.memoryDir, local)
    return { status: 'synced', memoryDir: pctx.memoryDir, written, deleted, held, warning }
  })
}

export type PersonalScan = { ok: false; reason: string } | { ok: true; pctx: PersonalContext; pending: Pending[] }

export async function scanPersonal($: EngineInterface, cfg: PersonalConfig): Promise<PersonalScan> {
  const resolved = await resolvePersonal($, cfg)
  if (!resolved.ok) return resolved
  const { pctx } = resolved
  const status = await storeStatus($, pctx, cfg.store)
  if (status === 'missing') return { ok: false, reason: 'the personal store is not cloned yet (that happens at session start)' }
  if (status !== 'ok') return { ok: false, reason: status }
  const local = await readNotes($, pctx.memoryDir)
  const storeNotes = await readNotes($, pctx.folder)
  const state = ((await $.store.get(pctx.stateKey)) as SyncState | undefined) ?? {}
  const rejected = ((await $.store.get(pctx.rejectedKey)) as Rejections | undefined) ?? {}
  const pending = planOutbound(local, storeNotes, state, rejected, DEFAULT_TEAM_TYPES, pctx.wanted).map(item => ({
    item,
    // The store is private: hits are shown as warnings, they never hold a note back.
    findings: cfg.privacyCheck && item.kind !== 'remove' ? privacyScan(item.text) : [],
  }))
  return { ok: true, pctx, pending }
}

export type PersonalApplied = { applied: OutboundItem[]; failed: { file: string; reason: string }[]; warning: string | null }

export function applyPersonal($: EngineInterface, pctx: PersonalContext, items: readonly OutboundItem[]): Promise<PersonalApplied> {
  return serial(async () => {
    const state = { ...(((await $.store.get(pctx.stateKey)) as SyncState | undefined) ?? {}) }
    const applied: OutboundItem[] = []
    const failed: { file: string; reason: string }[] = []
    for (const item of items) {
      if (item.kind === 'remove') {
        const err = await removeNote($, pctx.folder, item.file)
        if (err === null) {
          delete state[item.file]
          applied.push(item)
        } else failed.push({ file: item.file, reason: err })
      } else {
        await $.fs.write(`${pctx.folder}/${item.file}`, item.text)
        state[item.file] = item.fp
        applied.push(item)
      }
    }
    await $.store.set(pctx.stateKey, state)
    let warning: string | null = null
    if (applied.length) {
      const count = (k: OutboundItem['kind']) => applied.filter(i => i.kind === k).length
      warning = await commitAndPush($, pctx, `${pctx.key}: add ${count('add')}, update ${count('update')}, remove ${count('remove')}`)
    }
    await refreshIndex($, pctx.memoryDir)
    return { applied, failed, warning }
  })
}

export async function rejectPersonal($: EngineInterface, pctx: PersonalContext, items: readonly OutboundItem[]): Promise<void> {
  const rejected = { ...(((await $.store.get(pctx.rejectedKey)) as Rejections | undefined) ?? {}) }
  for (const item of items) rejected[item.file] = item.kind === 'remove' ? removalMark(item.fp) : item.fp
  await $.store.set(pctx.rejectedKey, rejected)
}

export type PersonalRun = { ok: false; reason: string } | ({ ok: true; waiting: Pending[] } & PersonalApplied)

/** After a turn: in `auto` mode (the default) everything goes to the store at once, committed and pushed. */
export async function runPersonalOutbound($: EngineInterface, cfg: PersonalConfig): Promise<PersonalRun> {
  const scan = await scanPersonal($, cfg)
  if (!scan.ok) return scan
  if (cfg.mode === 'confirm') return { ok: true, waiting: scan.pending, applied: [], failed: [], warning: null }
  const result = await applyPersonal($, scan.pctx, scan.pending.map(p => p.item))
  return { ok: true, waiting: [], ...result }
}

// ================================================================================================
// commands
// ================================================================================================
// /marginalia: status, approve, reject, share, unshare, sync, lint, compact, pane, init.

export const COMMAND = 'marginalia'

export type Config = {
  teamShare: ShareMode
  privacyCheck: boolean
  personal: PersonalConfig
}

export const HELP = [
  '/marginalia                     show what waits to be shared',
  '/marginalia approve <file|all>  share it (team: written to .claude/memory/, you commit;',
  '                                personal: committed and pushed to your store)',
  '/marginalia approve <file> --force   share a team note despite a privacy-check hit',
  '/marginalia reject <file|all>   keep it local; asked again only if it changes',
  '/marginalia share <file>        mark a note for the team (share: team)',
  '/marginalia unshare <file>      mark a note private (share: private)',
  '/marginalia sync                sync both ways now',
  '/marginalia lint                check the memory folder',
  '/marginalia compact             suggest how to keep memory small (never deletes)',
  '/marginalia pane                open the review pane',
  '/marginalia init                switch team sharing on for this repo',
].join('\n')

const TEAM_README = `# Team memory

This folder holds Claude Code memory notes shared by the team, one fact per file.
The [marginalia](https://github.com/grundhofer/marginalia) plugin copies them into each
person's local Claude Code auto memory and proposes new team notes here.

Review changes to these files like any other change. Do not put secrets or personal
data here.
`

type Entry = { target: 'team' | 'personal'; pending: Pending }

async function memoryDirHere($: EngineInterface): Promise<string | null> {
  const repo = await $.session.repo()
  let root = repo?.root
  if (root === undefined) root = await $.session.root()
  return resolveMemoryDir($, root)
}

/** Every verb but `sync` and `pane`, which need the sync runs and the pane (see actions.ts). */
export async function runCommand($: EngineInterface, args: string, cfg: Config): Promise<string> {
  const [verb = '', target = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const force = rest.includes('--force') || target === '--force'

  if (verb === 'help') return HELP

  if (verb === 'init') {
    const repo = await $.session.repo()
    if (!repo) return 'not inside a git repository.'
    const readme = `${repo.root}/${TEAM_DIR}/README.md`
    if (await $.fs.exists(readme)) return `already on (${TEAM_DIR}/ exists).`
    await $.fs.write(readme, TEAM_README)
    return `created ${TEAM_DIR}/README.md. Commit it to switch marginalia on for the team.`
  }

  if (verb === 'share' || verb === 'unshare') {
    if (!target) return `name a note file.\n\n${HELP}`
    if (!isSafeNoteName(target)) return `"${target}" is not a note file name.`
    const memoryDir = await memoryDirHere($)
    if (!memoryDir) return 'auto memory is turned off.'
    const text = await readIfExists($, `${memoryDir}/${target}`)
    if (text === undefined) return `no note ${target} in the memory folder.`
    await $.fs.write(`${memoryDir}/${target}`, setShare(text, verb === 'share' ? 'team' : 'private'))
    const after = await runCommand($, 'status', cfg)
    return `${target} is now ${verb === 'share' ? 'a team note' : 'private'}.\n${after}`
  }

  if (verb === 'lint' || verb === 'compact') {
    const memoryDir = await memoryDirHere($)
    if (!memoryDir) return 'auto memory is turned off.'
    const local = await readNotes($, memoryDir)
    if (verb === 'lint') {
      const issues = lintNotes(local, (await readIfExists($, `${memoryDir}/MEMORY.md`)) ?? '')
      if (issues.length === 0) return `no issues in ${local.size} note(s).`
      return [`${issues.length} issue(s) in ${local.size} note(s):`, ...issues.map(i => `  ${i.file}: ${i.problem}`)].join('\n')
    }
    const ideas = compactSuggestions(local)
    if (ideas.length === 0) return `nothing to suggest for ${local.size} note(s).`
    return [`${ideas.length} suggestion(s); nothing was changed:`, ...ideas.map(i => `  ${i.files.join(' + ')}: ${i.suggestion}`)].join('\n')
  }

  const team = await scanOutbound($, cfg.privacyCheck)
  const personal = await scanPersonal($, cfg.personal)
  if (!team.ok && !personal.ok) return `off here: ${team.reason}; personal sync: ${personal.reason}.`

  // Personal changes wait only in confirm mode; in auto mode they are pushed after each turn.
  const entries: Entry[] = [
    ...(team.ok ? team.pending.map(pending => ({ target: 'team' as const, pending })) : []),
    ...(personal.ok && cfg.personal.mode === 'confirm' ? personal.pending.map(pending => ({ target: 'personal' as const, pending })) : []),
  ]
  const label = (e: Entry) => `${e.target}: ${describe(e.pending)}`

  if (verb === '' || verb === 'status') {
    const notes: string[] = []
    if (!team.ok) notes.push(`team sharing is off here: ${team.reason}.`)
    if (!personal.ok) notes.push(`personal sync is off: ${personal.reason}.`)
    else notes.push(`personal store: ${personal.pctx.key} (${cfg.personal.mode}).`)
    if (entries.length === 0) return ['nothing waits to be shared.', ...notes].join('\n')
    return [`${entries.length} change(s) wait to be shared:`, ...entries.map(e => `  ${label(e)}`), '', ...notes, '', HELP].join('\n')
  }

  if (verb !== 'approve' && verb !== 'reject') return `unknown command "${verb}".\n\n${HELP}`
  if (!target || target === '--force') return `name a file or "all".\n\n${HELP}`

  const chosen = target === 'all' ? entries : entries.filter(e => e.pending.item.file === target)
  if (chosen.length === 0) return `nothing waits under "${target}".`
  const teamItems = (list: Entry[]) => list.filter(e => e.target === 'team').map(e => e.pending.item)
  const personalItems = (list: Entry[]): OutboundItem[] => list.filter(e => e.target === 'personal').map(e => e.pending.item)

  if (verb === 'reject') {
    if (team.ok && teamItems(chosen).length) await reject($, team.ctx, teamItems(chosen))
    if (personal.ok && personalItems(chosen).length) await rejectPersonal($, personal.pctx, personalItems(chosen))
    return `kept local: ${chosen.map(e => e.pending.item.file).join(', ')}.`
  }

  // A privacy hit holds a team note (the repo is shared); the private store only warns.
  const blocked = force ? [] : chosen.filter(e => e.target === 'team' && e.pending.findings.length > 0)
  const go = chosen.filter(e => !blocked.includes(e))
  const lines: string[] = []
  if (team.ok && teamItems(go).length) {
    const { applied, failed } = await applyItems($, team.ctx, teamItems(go))
    if (applied.length) lines.push(`shared to ${TEAM_DIR}/ (uncommitted): ${applied.map(i => i.file).join(', ')}.`)
    for (const f of failed) lines.push(`failed ${f.file}: ${f.reason}`)
  }
  if (personal.ok && personalItems(go).length) {
    const { applied, failed, warning } = await applyPersonal($, personal.pctx, personalItems(go))
    if (applied.length) lines.push(`personal store (${personal.pctx.key}): ${applied.map(i => i.file).join(', ')}.`)
    for (const f of failed) lines.push(`failed ${f.file}: ${f.reason}`)
    if (warning) lines.push(`personal store: ${warning}`)
  }
  for (const b of blocked) lines.push(`held ${label(b)}. Fix the note, or approve it with --force.`)
  return lines.join('\n')
}

// ================================================================================================
// sync
// ================================================================================================
// The sync runs: both inbound directions at session start, both outbound directions after a turn.

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export type Held = { file: string; reason: string }

export type InboundSummary = {
  /** The memory folder that was synced, if any. */
  memoryDir: string | null
  /** One line per thing that happened, for a toast or a command's answer. */
  lines: string[]
  held: Held[]
}

/** Both inbound directions: team notes from the repo, personal notes from the store. */
export async function syncAllInbound($: EngineInterface, cfg: Config): Promise<InboundSummary> {
  let memoryDir: string | null = null
  const lines: string[] = []
  const held: Held[] = []
  try {
    const team = await syncInbound($)
    if (team.status === 'synced') {
      memoryDir = team.memoryDir
      if (team.written.length) lines.push(`${team.written.length} team note(s) updated`)
      if (team.deleted.length) lines.push(`${team.deleted.length} team note(s) removed`)
      held.push(...team.held)
    }
  } catch (err) {
    lines.push(`team sync failed: ${message(err)}`)
  }
  try {
    const personal = await syncPersonalInbound($, cfg.personal)
    if (personal.status === 'skipped' && cfg.personal.store.trim() && /personal store/.test(personal.reason)) {
      lines.push(personal.reason)
    }
    if (personal.status === 'synced') {
      memoryDir ??= personal.memoryDir
      if (personal.written.length) lines.push(`${personal.written.length} personal note(s) updated`)
      if (personal.deleted.length) lines.push(`${personal.deleted.length} personal note(s) removed`)
      if (personal.warning) lines.push(personal.warning)
      held.push(...personal.held)
    }
  } catch (err) {
    lines.push(`personal sync failed: ${message(err)}`)
  }
  if (held.length) lines.push(`held: ${held.map(entry => entry.file).join(', ')}`)
  return { memoryDir, lines, held }
}

export type OutboundSummary = { lines: string[]; waiting: number; signature: string }

/** Both outbound directions; in auto mode they share, otherwise they report what waits. */
export async function syncAllOutbound($: EngineInterface, cfg: Config): Promise<OutboundSummary> {
  const lines: string[] = []
  const waiting: string[] = []
  try {
    const r = await runOutbound($, cfg.teamShare, cfg.privacyCheck)
    if (r.ok) {
      if (r.applied.length) lines.push(`shared ${r.applied.length} team note(s) to .claude/memory/ (uncommitted)`)
      for (const f of r.failed) lines.push(`could not share ${f.file}: ${f.reason}`)
      for (const p of r.waiting) waiting.push(`t:${p.item.kind}:${p.item.file}:${p.item.fp}`)
    }
  } catch (err) {
    lines.push(`team check failed: ${message(err)}`)
  }
  try {
    const r = await runPersonalOutbound($, cfg.personal)
    if (r.ok) {
      if (r.applied.length) lines.push(`pushed ${r.applied.length} personal note change(s)`)
      if (r.warning) lines.push(`personal store: ${r.warning}`)
      for (const f of r.failed) lines.push(`personal store: ${f.file}: ${f.reason}`)
      for (const p of r.waiting) waiting.push(`p:${p.item.kind}:${p.item.file}:${p.item.fp}`)
    }
  } catch (err) {
    lines.push(`personal check failed: ${message(err)}`)
  }
  return { lines, waiting: waiting.length, signature: waiting.join('|') }
}

// ================================================================================================
// snapshot
// ================================================================================================
// The snapshot the review pane draws from, rebuilt after every sync and action.

export const PANE = 'marginalia'
export const PANE_TITLE = 'Marginalia'

// Change the tag when PaneData's fields change: it declines what an earlier version stored.
const pane = atom({ plugin: 'marginalia', key: 'pane' } as const, null, { shape: 'pane-1' })

const unique = <T,>(xs: readonly T[]) => [...new Set(xs)]

/** Reads the current state of both sync directions into the snapshot the pane draws. */
export async function buildSnapshot($: EngineInterface, cfg: Config, held: PaneData['held'], last: string): Promise<PaneData> {
  const team = await scanOutbound($, cfg.privacyCheck)
  const personal = await scanPersonal($, cfg.personal)
  const rows = (target: PaneRow['target'], pending: readonly Pending[]): PaneRow[] =>
    pending.map(p => ({
      target,
      kind: p.item.kind,
      file: p.item.file,
      ...(p.item.kind === 'remove' ? { why: p.item.why } : {}),
      findings: unique(p.findings.map(f => `${f.kind} (line ${f.line})`)),
    }))
  const waiting: PaneRow[] = [
    ...(team.ok ? rows('team', team.pending) : []),
    ...(personal.ok && cfg.personal.mode === 'confirm' ? rows('personal', personal.pending) : []),
  ]

  let memoryDir = team.ok ? team.ctx.memoryDir : personal.ok ? personal.pctx.memoryDir : null
  if (!memoryDir) {
    const repo = await $.session.repo()
    let root = repo?.root
    if (root === undefined) root = await $.session.root()
    memoryDir = await resolveMemoryDir($, root)
  }
  let cost: PaneData['cost'] = null
  let lintIssues = 0
  if (memoryDir) {
    const index = (await readIfExists($, `${memoryDir}/MEMORY.md`)) ?? ''
    cost = indexCost(index)
    lintIssues = lintNotes(await readNotes($, memoryDir), index).length
  }

  return {
    team: team.ok ? 'on' : `off: ${team.reason}`,
    personal: personal.ok ? `${personal.pctx.key} (${cfg.personal.mode})` : `off: ${personal.reason}`,
    cost,
    waiting,
    held,
    lintIssues,
    last,
  }
}

/** Rebuilds the snapshot; the pane redraws by itself. Keeps the held list and last answer unless given. */
export async function refreshPane($: EngineInterface, cfg: Config, change: { held?: PaneData['held']; last?: string } = {}): Promise<void> {
  const before = await read($, pane)
  const snapshot = await buildSnapshot($, cfg, change.held ?? before?.held ?? [], change.last ?? before?.last ?? '')
  await update($, pane, () => snapshot)
}

// ================================================================================================
// actions
// ================================================================================================
// What hooks, the command and the pane's buttons do. Every function that takes `$` is declared
// at the top level: the engine accepts `$` only there.

// What the last toast announced as waiting, so an unchanged list is not announced every turn.
let lastWaiting = ''
let paneFailureShown = false

export async function inbound($: EngineInterface, cfg: Config): Promise<InboundSummary> {
  const summary = await syncAllInbound($, cfg)
  if (summary.lines.length) $.ui.toast(summary.lines.join(', '))
  return summary
}

export async function outbound($: EngineInterface, cfg: Config): Promise<void> {
  const summary = await syncAllOutbound($, cfg)
  for (const line of summary.lines) $.ui.toast(line)
  if (summary.signature && summary.signature !== lastWaiting) {
    $.ui.toast(`${summary.waiting} note change(s) wait for approval: /${COMMAND}`)
  }
  lastWaiting = summary.signature
}

/** The pane is a view: a failure to refresh it never stops a sync. */
export async function refresh($: EngineInterface, cfg: Config, change: Parameters<typeof refreshPane>[2] = {}): Promise<void> {
  try {
    await refreshPane($, cfg, change)
  } catch (err) {
    if (!paneFailureShown) $.ui.toast(`could not refresh the pane: ${message(err)}`)
    paneFailureShown = true
  }
}

/** `/marginalia sync`: both directions now. */
export async function syncNow($: EngineInterface, cfg: Config): Promise<string> {
  const i = await syncAllInbound($, cfg)
  const o = await syncAllOutbound($, cfg)
  lastWaiting = o.signature
  await refresh($, cfg, { held: i.held })
  const lines = [...i.lines, ...o.lines]
  if (o.waiting) lines.push(`${o.waiting} change(s) wait for approval: /${COMMAND}`)
  return lines.length ? lines.join('\n') : 'in sync; nothing changed.'
}

export async function syncFromPane($: EngineInterface, cfg: Config): Promise<void> {
  const text = await syncNow($, cfg)
  await refresh($, cfg, { last: text.split('\n')[0] ?? '' })
}

export async function openPane($: EngineInterface, cfg: Config): Promise<string> {
  await refresh($, cfg)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  return 'pane opened.'
}

/** A pane button: runs the command's verb, then shows its first line in the pane. */
export async function paneAct($: EngineInterface, cfg: Config, args: string): Promise<void> {
  const text = await runCommand($, args, cfg)
  await refresh($, cfg, { last: text.split('\n')[0] ?? '' })
}

/** The command: `sync` and `pane` run here, every other verb in runCommand. */
export async function command($: EngineInterface, cfg: Config, args: string): Promise<string> {
  const verb = args.trim().split(/\s+/)[0] ?? ''
  if (verb === 'sync') return syncNow($, cfg)
  if (verb === 'pane') return openPane($, cfg)
  const text = await runCommand($, args, cfg)
  await refresh($, cfg)
  return text
}

// ================================================================================================
// pane
// ================================================================================================
// The review pane: what waits to be shared, what is held, and what the memory index costs.


// The buttons' handlers. The plugin directory reads `$` only when it is passed whole to a
// function declared at the top level of the same file, so each button calls one of these.
async function pressRefresh($: EngineInterface, cfg: Config): Promise<void> {
  await refresh($, cfg)
}

async function pressCommand($: EngineInterface, cfg: Config, args: string): Promise<void> {
  await paneAct($, cfg, args)
}

async function pressSync($: EngineInterface, cfg: Config): Promise<void> {
  await syncFromPane($, cfg)
}

/** Draws the pane. register.ts hooks `ui.render` and calls this, so this file declares no hook. */
export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>, cfg: Config) {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const data = await read($, pane)
    if (!data) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading memory…</Text>
          <Button key="refresh" label="Refresh" onPress={() => pressRefresh($, cfg)} />
        </Box>
      )
    }
    const kb = (n: number) => `${(n / 1024).toFixed(1)}`
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Team sharing </Text>
          {data.team}
        </Text>
        <Text>
          <Text bold>Personal sync </Text>
          {data.personal}
        </Text>

        {data.cost && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>MEMORY.md </Text>≈ {data.cost.tokens} tokens · {data.cost.lines}/{data.cost.maxLines} lines ·{' '}
              {kb(data.cost.bytes)}/{kb(data.cost.maxBytes)} KB
            </Text>
            <Progress label="Load limit" value={Math.min(1, data.cost.used)} valueText={`${Math.round(data.cost.used * 100)}%`} />
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Waiting ({data.waiting.length})</Text>
          {data.waiting.length === 0 && <Text dimColor>Nothing waits to be shared.</Text>}
          {data.waiting.map(row => {
            const id = `${row.target}:${row.file}`
            const blocked = row.target === 'team' && row.findings.length > 0
            return (
              <Box flexDirection="column">
                <Text>
                  {row.target}: {row.kind === 'remove' ? `remove (${row.why})` : row.kind} {row.file}
                </Text>
                {row.findings.length > 0 && <Text color="warning">  privacy check: {row.findings.join(', ')}</Text>}
                <Box flexDirection="row" gap={1}>
                  {blocked ? (
                    <Button key={`force:${id}`} label="Share anyway" onPress={() => pressCommand($, cfg, `approve ${row.file} --force`)} />
                  ) : (
                    <Button key={`approve:${id}`} label="Approve" variant="primary" onPress={() => pressCommand($, cfg, `approve ${row.file}`)} />
                  )}
                  <Button key={`reject:${id}`} label="Keep local" onPress={() => pressCommand($, cfg, `reject ${row.file}`)} />
                </Box>
              </Box>
            )
          })}
        </Box>

        {data.held.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Held ({data.held.length})</Text>
            {data.held.map(item => (
              <Text>
                {item.file} <Text dimColor>— {item.reason}</Text>
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {data.lintIssues === 0 ? 'Lint: no issues.' : `Lint: ${data.lintIssues} issue(s), see /${COMMAND} lint`}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="sync" label="Sync now" onPress={() => pressSync($, cfg)} />
            <Button key="refresh" label="Refresh" onPress={() => pressRefresh($, cfg)} />
          </Box>
          {data.last !== '' && <Text dimColor>{data.last}</Text>}
        </Box>
      </Box>
    )
}

// ================================================================================================
// register
// ================================================================================================
// The sync started at session start. Claude Code may read MEMORY.md for the first prompt's
// context before that sync finishes, so the context hook waits for it and puts the fresh
// MEMORY.md into the instruction files the context is rendered from.
let inflight: Promise<InboundSummary> | undefined

export const register: Register = (on, options) => {
  const mode = (value: unknown, fallback: ShareMode): ShareMode => (value === 'auto' || value === 'confirm' ? value : fallback)
  const privacyCheck = options.privacyCheck !== false && options.privacyCheck !== 'false'
  const cfg: Config = {
    teamShare: mode(options.teamShare, 'confirm'),
    privacyCheck,
    personal: {
      store: typeof options.personalStore === 'string' ? options.personalStore : '',
      mode: mode(options.personalSync, 'auto'),
      privacyCheck,
    },
  }

  on('ui.render', { component: 'Pane', requestId: 'marginalia' }, async ($, e) => renderPane($, e, cfg))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    inflight = inbound($, cfg)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Share Claude Code memory with your team and your other machines',
        argumentHint: '[approve|reject|share|unshare <file>] [sync|lint|compact|pane|init]',
      })
    } catch (err) {
      $.ui.toast(`could not register /${COMMAND}: ${message(err)}`)
    }
    const summary = await inflight
    await outbound($, cfg)
    await refresh($, cfg, { held: summary.held })
    return result
  })

  // Fires once per conversation (also after /clear, which has no session.start).
  on('prompt.context', async ($, e, next) => {
    const started = inflight
    const { memoryDir } = started ? await started : await inbound($, cfg)
    inflight = undefined
    const result = await next(e)
    if (!memoryDir) return result

    const files = result.instructionFiles ?? e.instructionFiles
    if (files === undefined) return result // a hook above rewrote the text: leave it alone

    const path = `${memoryDir}/MEMORY.md`
    if (!(await $.fs.exists(path))) return result
    const raw = await $.fs.read(path)
    if (typeof raw !== 'string') return result
    const content = indexAsLoaded(raw)

    const at = files.findIndex(f => f.path === path)
    if (at !== -1 && files[at]?.content === content) return result
    const updated =
      at === -1
        ? [...files, { path, kind: 'memory' as const, content }]
        : files.map((f, i) => (i === at ? { ...f, content } : f))
    return { ...result, instructionFiles: updated }
  })

  // After each turn of the main conversation: what Claude wrote becomes proposals, or is shared.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await outbound($, cfg)
      await refresh($, cfg)
    }
    return result
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== COMMAND) return next(e)
    return { text: await command($, cfg, e.args) }
  }).catch(($, e, next) => (next.called ? next(e) : { text: `/${COMMAND} failed.` }))
}

// Personal sync (M3): the person's own notes <-> their private git store, on every machine.
// Next to a team-synced repo the store holds the private notes; for any other project it holds
// all notes, so project knowledge of a solo project still follows the person.

import type { EngineInterface } from 'claude-code'
import {
  DEFAULT_TEAM_TYPES,
  isSafeNoteName,
  normalizeRemote,
  personalKey,
  planInbound,
  planOutbound,
  privacyScan,
  removalMark,
  type OutboundItem,
  type Rejections,
  type SyncState,
} from './core'
import { readIfExists, readNotes, removeNote, resolveContext, resolveMemoryDir } from './context'
import { refreshIndex } from './inbound'
import type { Pending, ShareMode } from './outbound'

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

// What both sync directions need: the repo, the folders, and whether marginalia may act here.

import type { EngineInterface } from 'claude-code'
import { isSafeNoteName, memoryDirFor, normalizeRemote, type SyncState } from './core'

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

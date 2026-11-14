// Pure logic for marginalia: no engine calls, so every rule here is unit-tested.

export type NoteType = 'user' | 'feedback' | 'project' | 'reference'
export type Scope = 'team' | 'private'

export type Note = {
  file: string
  name?: string
  description?: string
  type?: NoteType
  share?: Scope
}

const NOTE_TYPES: readonly string[] = ['user', 'feedback', 'project', 'reference']

/** Files in a memory folder that are never notes. */
const NOT_NOTES = new Set(['MEMORY.md', 'README.md'])

export function isNoteFile(name: string): boolean {
  return name.endsWith('.md') && !NOT_NOTES.has(name) && !name.startsWith('.') && !name.includes('/')
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Reads the frontmatter fields marginalia needs. Accepts `type` and `share` at the top level
 * (Claude Code's documented form) and under `metadata:` (the form Claude writes in practice).
 */
export function parseNote(file: string, text: string): Note {
  const note: Note = { file }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return note
  let inMetadata = false
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      const key = top[1] ?? ''
      const value = top[2] ?? ''
      inMetadata = key === 'metadata' && value.trim() === ''
      assign(note, key, value)
      continue
    }
    const nested = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (nested && inMetadata) assign(note, nested[1] ?? '', nested[2] ?? '')
  }
  return note
}

function assign(note: Note, key: string, raw: string): void {
  const value = unquote(raw)
  if (key === 'name' && value) note.name = value
  else if (key === 'description' && value) note.description = value
  else if (key === 'type' && NOTE_TYPES.includes(value)) note.type = value as NoteType
  else if (key === 'share' && (value === 'team' || value === 'private')) note.share = value
}

export const DEFAULT_TEAM_TYPES: readonly NoteType[] = ['project', 'reference']

/** Where a note belongs: a per-note `share` wins, otherwise its type decides. Untyped notes stay private. */
export function scopeOf(note: Note, teamTypes: readonly NoteType[] = DEFAULT_TEAM_TYPES): Scope {
  if (note.share) return note.share
  return note.type && teamTypes.includes(note.type) ? 'team' : 'private'
}

/**
 * The folder name Claude Code uses under `~/.claude/projects/` for a project path: every character
 * other than a letter, digit or hyphen becomes a hyphen. Observed on this machine
 * (`/Users/x/Projects` -> `-Users-x-Projects`); very long paths may be shortened by Claude Code,
 * which this does not model.
 */
export function projectDirName(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9-]/g, '-')
}

export type MemoryDirInput = {
  /** `CLAUDE_CONFIG_DIR`, or `<home>/.claude`. */
  configDir: string
  /** The repository root (the main working tree for a worktree). */
  projectRoot: string
  /** The `autoMemoryDirectory` setting, if set. */
  autoMemoryDirectory?: string
  /** `CLAUDE_CODE_PROJECT_DIR_NAME`, if set. */
  projectDirNameOverride?: string
  home: string
}

export function memoryDirFor(input: MemoryDirInput): string {
  const custom = input.autoMemoryDirectory?.trim()
  if (custom) return trimSlash(custom.startsWith('~/') ? `${input.home}/${custom.slice(2)}` : custom)
  const dirName = input.projectDirNameOverride?.trim() || projectDirName(input.projectRoot)
  return `${trimSlash(input.configDir)}/projects/${dirName}/memory`
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * A stable key for a repository across machines: `host/owner/repo`, lower-case host, no
 * credentials, no `.git`. Returns null for a remote it cannot read.
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null
  const u = url.trim()
  let host: string
  let path: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u)
  if (!/^[a-z+]+:\/\//i.test(u) && scp) {
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  } else {
    try {
      const parsed = new URL(u)
      if (!parsed.hostname) return null
      host = parsed.hostname
      path = parsed.pathname
    } catch {
      return null
    }
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  if (!path) return null
  return `${host.toLowerCase()}/${path}`
}

/** A small, stable content fingerprint (FNV-1a, 32 bit) plus length. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}:${text.length}`
}

/** Frontmatter fields Claude Code stamps per machine and session; they never go to the team. */
const VOLATILE_FIELDS = ['originSessionId', 'modified']

/** A note as it is shared: without the per-session and per-machine stamps Claude Code adds. */
export function teamText(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(text)
  if (!match) return text
  const body = (match[1] ?? '')
    .split(/\r?\n/)
    .filter(line => !VOLATILE_FIELDS.some(f => new RegExp(`^\\s*${f}:`).test(line)))
    .join('\n')
  return `---\n${body}\n---${text.slice(match[0].length)}`
}

/** The fingerprint sync decisions use: equal when two copies differ only in volatile stamps. */
export function noteFingerprint(text: string): string {
  return fingerprint(teamText(text))
}

/** Per team-note file: the fingerprint both sides had at the last sync. */
export type SyncState = Record<string, string>

export type InboundAction =
  | { kind: 'write'; file: string; text: string }
  | { kind: 'delete'; file: string }
  | { kind: 'held'; file: string; reason: string }

export type InboundPlan = {
  actions: InboundAction[]
  /** The sync state after the actions are applied. */
  state: SyncState
}

/**
 * Brings team notes from the repo into the local memory folder.
 *
 * - A repo note missing locally is copied, unless it was synced before and then deleted
 *   locally (a pending outbound deletion, left for the outbound path).
 * - A repo note changed upstream replaces the local copy only when the local copy is unchanged
 *   since the last sync.
 * - A local edit since the last sync is left alone (pending outbound).
 * - Both sides changed, or an unrelated local note with the same file name: held, nothing
 *   overwritten.
 * - A note removed from the repo is removed locally only when the local copy is unchanged.
 *
 * `local` needs to hold only the files named in `repo` or `state`.
 */
export function planInbound(
  repo: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
  state: SyncState,
): InboundPlan {
  const actions: InboundAction[] = []
  const next: SyncState = {}

  for (const [file, repoText] of repo) {
    const repoFp = noteFingerprint(repoText)
    const synced = state[file]
    const localText = local.get(file)

    if (localText === undefined) {
      if (synced === undefined) {
        actions.push({ kind: 'write', file, text: repoText })
        next[file] = repoFp
      } else {
        // Deleted locally after a sync: keep the record so the outbound path can propose the deletion.
        next[file] = synced
      }
      continue
    }

    const localFp = noteFingerprint(localText)
    if (localFp === repoFp) {
      next[file] = repoFp
    } else if (synced === undefined) {
      actions.push({ kind: 'held', file, reason: 'a local note with the same file name differs from the team note' })
    } else if (localFp === synced) {
      actions.push({ kind: 'write', file, text: repoText })
      next[file] = repoFp
    } else if (repoFp === synced) {
      next[file] = synced // local edit, pending outbound
    } else {
      actions.push({ kind: 'held', file, reason: 'changed both locally and in the repo since the last sync' })
      next[file] = synced
    }
  }

  for (const [file, synced] of Object.entries(state)) {
    if (repo.has(file)) continue
    const localText = local.get(file)
    if (localText === undefined) continue // gone on both sides
    if (noteFingerprint(localText) === synced) {
      actions.push({ kind: 'delete', file })
    } else {
      actions.push({ kind: 'held', file, reason: 'removed from the repo but changed locally' })
      next[file] = synced
    }
  }

  return { actions, state: next }
}

export const BLOCK_START = '<!-- marginalia:team:start -->'
export const BLOCK_END = '<!-- marginalia:team:end -->'

/** One index line per team note, in the style of Claude Code's MEMORY.md. */
export function renderBlock(notes: readonly Note[]): string {
  if (notes.length === 0) return ''
  const lines = [...notes]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(n => {
      const title = n.name ?? n.file.replace(/\.md$/, '')
      return n.description ? `- [${title}](${n.file}) — ${n.description}` : `- [${title}](${n.file})`
    })
  return [BLOCK_START, ...lines, BLOCK_END].join('\n')
}

/**
 * Puts `block` into MEMORY.md between the markers, replacing an earlier block, or appends it.
 * An empty block removes the markers. Lines outside the block are never changed.
 */
export function applyBlock(memoryMd: string, block: string): string {
  const start = memoryMd.indexOf(BLOCK_START)
  const end = start === -1 ? -1 : memoryMd.indexOf(BLOCK_END, start)
  if (start !== -1 && end !== -1) {
    const before = memoryMd.slice(0, start)
    const after = memoryMd.slice(end + BLOCK_END.length)
    if (block) return before + block + after
    return (before.replace(/\n+$/, '') + after.replace(/^\n+/, before.trim() ? '\n' : '')).replace(/^\n+/, '')
  }
  if (!block) return memoryMd
  if (!memoryMd.trim()) return `${block}\n`
  return `${memoryMd.replace(/\n*$/, '\n')}${block}\n`
}

/** Whether `file` is a plain note file name, safe to join to a memory folder. */
export function isSafeNoteName(file: string): boolean {
  return isNoteFile(file) && !file.includes('..') && !file.includes('\\') && !file.includes('\0')
}

/** Claude Code loads only the first 200 lines or 25 KB of MEMORY.md. */
export const INDEX_MAX_LINES = 200
export const INDEX_MAX_BYTES = 25 * 1024

/**
 * MEMORY.md as Claude Code hands it to the model: HTML comments stripped (so marginalia's
 * markers cost nothing), cut to the documented load limit.
 */
export function indexAsLoaded(raw: string): string {
  const stripped = raw
    .replace(/<!--[\s\S]*?-->[ \t]*\r?\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
  let out = stripped.split('\n').slice(0, INDEX_MAX_LINES).join('\n')
  const bytes = new TextEncoder().encode(out)
  if (bytes.length > INDEX_MAX_BYTES) {
    out = new TextDecoder().decode(bytes.slice(0, INDEX_MAX_BYTES)).replace(/�+$/, '')
    out = out.slice(0, Math.max(0, out.lastIndexOf('\n')))
  }
  return out
}

/** Notes that MEMORY.md does not already link outside marginalia's block (Claude's own lines). */
export function notListedOutsideBlock(notes: readonly Note[], memoryMd: string): Note[] {
  const start = memoryMd.indexOf(BLOCK_START)
  const end = start === -1 ? -1 : memoryMd.indexOf(BLOCK_END, start)
  const outside = start !== -1 && end !== -1 ? memoryMd.slice(0, start) + memoryMd.slice(end + BLOCK_END.length) : memoryMd
  return notes.filter(n => !outside.includes(`](${n.file})`))
}

// ---------------------------------------------------------------------------------------------
// Outbound (M2)

export type PrivacyFinding = { kind: string; line: number }

const PRIVACY_RULES: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'local path with a user name', pattern: /(?:\/Users\/|\/home\/)(?!x\/|you\/|me\/|user\/|username\/|<)[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\(?!x\\|user\\|<)[A-Za-z0-9._-]+/ },
  { kind: 'e-mail address', pattern: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net|test)\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'API key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { kind: 'password or secret assignment', pattern: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"'`]{8,}/i },
  { kind: 'invisible or direction-changing character', pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/ },
]

/** Looks for what should not leave the machine. Reports the kind and line, never the value. */
export function privacyScan(text: string): PrivacyFinding[] {
  const findings: PrivacyFinding[] = []
  text.split('\n').forEach((line, i) => {
    for (const rule of PRIVACY_RULES) {
      if (rule.pattern.test(line)) findings.push({ kind: rule.kind, line: i + 1 })
    }
  })
  return findings
}

export type OutboundItem =
  | { kind: 'add' | 'update'; file: string; text: string; fp: string }
  | { kind: 'remove'; file: string; why: 'deleted locally' | 'marked private' | 'marked team'; fp: string }

/** What the person turned down, by file: the fingerprint of the version they rejected. */
export type Rejections = Record<string, string>

/** The fingerprint a rejected removal is remembered under. */
export const removalMark = (synced: string) => `remove:${synced}`

/**
 * What should go from the local memory folder to a target (the project repo for `team` notes,
 * the personal store for `private` ones):
 * - add: a wanted note that the target does not have and that was never synced
 * - update: a synced wanted note edited locally while the target copy is unchanged
 * - remove: a synced note deleted locally, or moved to the other scope, while the target copy
 *   is unchanged
 *
 * Anything the repo changed since the last sync is left to the inbound side (it holds the note).
 * A version the person rejected stays out until it changes again.
 */
export function planOutbound(
  local: ReadonlyMap<string, string>,
  repo: ReadonlyMap<string, string>,
  state: SyncState,
  rejected: Rejections = {},
  teamTypes: readonly NoteType[] = DEFAULT_TEAM_TYPES,
  /**
   * Which notes this target holds: `team` for the project repo, `private` for the personal store
   * next to a team-synced repo, `all` for the personal store where the project has no team sync.
   */
  wanted: Scope | 'all' = 'team',
): OutboundItem[] {
  const items: OutboundItem[] = []
  const repoUnchanged = (file: string) => {
    const repoText = repo.get(file)
    return repoText !== undefined && noteFingerprint(repoText) === state[file]
  }

  for (const [file, text] of local) {
    const fp = noteFingerprint(text)
    const shared = teamText(text)
    const synced = state[file]
    const scope = scopeOf(parseNote(file, text), teamTypes)
    if (wanted === 'all' || scope === wanted) {
      if (synced === undefined) {
        if (!repo.has(file) && rejected[file] !== fp) items.push({ kind: 'add', file, text: shared, fp })
      } else if (fp !== synced && repoUnchanged(file) && rejected[file] !== fp) {
        items.push({ kind: 'update', file, text: shared, fp })
      }
    } else if (synced !== undefined && repoUnchanged(file) && rejected[file] !== removalMark(synced)) {
      items.push({ kind: 'remove', file, why: wanted === 'team' ? 'marked private' : 'marked team', fp: synced })
    }
  }

  for (const [file, synced] of Object.entries(state)) {
    if (local.has(file)) continue
    if (repoUnchanged(file) && rejected[file] !== removalMark(synced)) {
      items.push({ kind: 'remove', file, why: 'deleted locally', fp: synced })
    }
  }

  return items.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Where a project's personal notes live in the personal store: `<host>/<owner>/<repo>` for a
 * repo with a remote, `home/<path below home>` for a folder outside any repo (the same layout
 * on every machine finds the same folder). Null when neither applies.
 */
export function personalKey(remoteKey: string | null, root: string, home: string): string | null {
  if (remoteKey) return remoteKey
  const h = home.replace(/\/+$/, '')
  if (h && (root === h || root.startsWith(`${h}/`))) {
    const rel = root.slice(h.length).replace(/^\/+/, '')
    return rel ? `home/${rel}` : 'home'
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// M4: share/unshare, lint, compact, index cost

/** Sets `share:` in a note's frontmatter (under `metadata:` when the note has one). */
export function setShare(text: string, scope: Scope): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(text)
  if (!match) return `---\nmetadata:\n  share: ${scope}\n---\n\n${text}`
  const lines = (match[1] ?? '').split(/\r?\n/).filter(l => !/^\s*share:/.test(l))
  const meta = lines.findIndex(l => /^metadata:\s*$/.test(l))
  if (meta === -1) lines.push(`share: ${scope}`)
  else {
    let end = meta + 1
    while (end < lines.length && /^\s+\S/.test(lines[end] ?? '')) end++
    const indent = /^(\s+)/.exec(lines[meta + 1] ?? '')?.[1] ?? '  '
    lines.splice(end, 0, `${indent}share: ${scope}`)
  }
  return `---\n${lines.join('\n')}\n---${text.slice(match[0].length)}`
}

export type IndexCost = {
  lines: number
  bytes: number
  /** A rough estimate: about four characters per token. */
  tokens: number
  maxLines: number
  maxBytes: number
  /** The share of the load limit in use, 0 to 1 and past 1 when over. */
  used: number
}

export function indexCost(memoryMd: string): IndexCost {
  const loaded = indexAsLoaded(memoryMd)
  const full = memoryMd.replace(/<!--[\s\S]*?-->[ \t]*\r?\n?/g, '')
  const lines = full.split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').length
  const bytes = new TextEncoder().encode(full).length
  return {
    lines,
    bytes,
    tokens: Math.ceil(loaded.length / 4),
    maxLines: INDEX_MAX_LINES,
    maxBytes: INDEX_MAX_BYTES,
    used: Math.max(lines / INDEX_MAX_LINES, bytes / INDEX_MAX_BYTES),
  }
}

export type LintIssue = { file: string; problem: string }

const linkTargets = (md: string) => [...md.matchAll(/\]\(([^)\s]+\.md)\)/g)].map(m => m[1] ?? '')

/**
 * Checks a memory folder: missing type or description, index lines pointing at missing files,
 * notes the index never mentions (Claude does not see them at session start), duplicate names,
 * [[links]] to names that do not exist, and an index near or over the load limit.
 */
export function lintNotes(local: ReadonlyMap<string, string>, memoryMd: string): LintIssue[] {
  const issues: LintIssue[] = []
  const notes = [...local].map(([file, text]) => ({ ...parseNote(file, text), text }))
  const names = new Map<string, string[]>()
  for (const n of notes) {
    if (!n.type) issues.push({ file: n.file, problem: 'no type (user, feedback, project or reference); it stays private' })
    if (!n.description) issues.push({ file: n.file, problem: 'no description, so its index line says little' })
    const key = (n.name ?? n.file.replace(/\.md$/, '')).toLowerCase()
    names.set(key, [...(names.get(key) ?? []), n.file])
  }
  const linked = new Set(linkTargets(memoryMd))
  for (const target of linked) {
    if (!local.has(target)) issues.push({ file: 'MEMORY.md', problem: `links to ${target}, which does not exist` })
  }
  for (const n of notes) {
    if (!linked.has(n.file)) issues.push({ file: n.file, problem: 'not in MEMORY.md, so Claude does not see it at session start' })
  }
  for (const [name, files] of names) {
    if (files.length > 1) issues.push({ file: files.join(', '), problem: `share the name "${name}"` })
  }
  const known = new Set([...names.keys(), ...notes.map(n => n.file.replace(/\.md$/, '').toLowerCase())])
  for (const n of notes) {
    for (const m of n.text.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = (m[1] ?? '').trim().toLowerCase()
      if (target && !known.has(target)) issues.push({ file: n.file, problem: `links to [[${m[1]}]], which no note is named` })
    }
  }
  const cost = indexCost(memoryMd)
  if (cost.used > 1) {
    issues.push({ file: 'MEMORY.md', problem: `over the load limit (${cost.lines}/${cost.maxLines} lines, ${cost.bytes}/${cost.maxBytes} bytes): the end is cut off` })
  } else if (cost.used > 0.8) {
    issues.push({ file: 'MEMORY.md', problem: `at ${Math.round(cost.used * 100)}% of the load limit` })
  }
  return issues
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9äöüß]+/).filter(w => w.length > 3))

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return common / Math.min(a.size, b.size)
}

export type CompactSuggestion = { files: string[]; suggestion: string }

/**
 * Suggestions to keep memory small; it never deletes. Pairs whose descriptions say much the
 * same are merge candidates; long notes are candidates for shortening.
 */
export function compactSuggestions(local: ReadonlyMap<string, string>, longNoteChars = 2000): CompactSuggestion[] {
  const out: CompactSuggestion[] = []
  const notes = [...local].map(([file, text]) => ({ ...parseNote(file, text), text })).sort((a, b) => a.file.localeCompare(b.file))
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i]
      const b = notes[j]
      if (!a || !b || a.type !== b.type) continue
      const score = overlap(words(`${a.name ?? ''} ${a.description ?? ''}`), words(`${b.name ?? ''} ${b.description ?? ''}`))
      if (score >= 0.6) out.push({ files: [a.file, b.file], suggestion: 'say much the same; consider merging them into one note' })
    }
  }
  for (const n of notes) {
    if (n.text.length > longNoteChars) out.push({ files: [n.file], suggestion: `is ${n.text.length} characters long; consider shortening it` })
  }
  return out
}

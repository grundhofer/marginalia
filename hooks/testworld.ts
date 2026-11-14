// Test helpers: a small file system, git and host beneath the plugin, answered by the test's hooks.
import type { On } from 'claude-code'
import { mock, type Engine } from 'claude-code/testing'

export const ROOT = '/work/repo'
export const TEAM = `${ROOT}/.claude/memory`
export const MEM = '/home/me/.claude/projects/-work-repo/memory'
export const STORE = '/home/me/.claude/marginalia/personal'

export const team = (name: string, type = 'project') =>
  `---\nname: ${name}\ndescription: about ${name}\nmetadata:\n  type: ${type}\n---\n\n${name} body\n`

export type World = {
  files: Map<string, string>
  removed: string[]
  fetched: string[]
  toasts: string[]
  /** Every git command, as `git <args after -C dir>`. */
  git: string[]
}

export type WorldOptions = {
  remote?: string | null
  githubStatus?: number
  /** No git repository: the session runs in `root`. */
  noRepo?: boolean
  root?: string
  pushExit?: number
  /** What `git remote get-url origin` answers in the personal store clone. */
  storeOrigin?: string
}

/** A small file system and host beneath the plugin, answered by the test's hooks. */
export function world(on: On, files: Record<string, string>, opts: WorldOptions = {}): World {
  const w: World = { files: new Map(Object.entries(files)), removed: [], fetched: [], toasts: [], git: [] }
  const isDir = (p: string) => [...w.files.keys()].some(f => f.startsWith(`${p}/`))
  on('session.repo', () => ({
    value: opts.noRepo
      ? null
      : { root: opts.root ?? ROOT, remote: opts.remote === undefined ? 'git@github.com:acme/repo.git' : opts.remote, internal: false, name: null },
  }))
  on('session.root', () => ({ value: opts.root ?? ROOT }))
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) || isDir(e.path) }))
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...w.files.keys()]
      .filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  const ran = (exitCode = 0, stderr = '', stdout = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    const argv = e.argv
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1] ?? ''
      w.removed.push(path)
      w.files.delete(path)
      return ran()
    }
    if (argv[0] === 'git') {
      const args = argv[1] === '-C' ? argv.slice(3) : argv.slice(1)
      w.git.push(`git ${args.join(' ')}`)
      if (args[0] === 'clone') w.files.set(`${args[args.length - 1]}/.git`, 'gitdir')
      if (args[0] === 'remote') return ran(0, '', `${opts.storeOrigin ?? 'git@github.com:me/claude-memory.git'}\n`)
      if (args[0] === 'diff') return ran(1) // there are staged changes
      if (args[0] === 'push') return ran(opts.pushExit ?? 0, opts.pushExit ? 'rejected' : '')
      return ran()
    }
    return ran(127, 'unexpected command')
  })
  on('http.fetch', (_, e) => {
    w.fetched.push(e.url)
    return { value: { status: opts.githubStatus ?? 404, ok: false, headers: {}, text: '' } }
  })
  on('settings.read', () => ({ value: {} }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'marginalia' } }))
  mock.env(on, { HOME: '/home/me' })
  return w
}

/** Starts a session the way the REPL does; marginalia syncs inside it. */
export async function start($: { session: { start: (e: { cwd: string; surface: 'terminal'; isInteractive: boolean }) => Promise<unknown> } }) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}


/** Runs /marginalia with the given arguments and returns its text. */
export const run = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'marginalia',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
  ).text ?? ''

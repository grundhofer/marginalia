import { describe, expect, test } from 'claude-code/testing'
import {
  BLOCK_END,
  BLOCK_START,
  compactSuggestions,
  indexCost,
  lintNotes,
  setShare,
  applyBlock,
  fingerprint,
  indexAsLoaded,
  noteFingerprint,
  notListedOutsideBlock,
  planOutbound,
  privacyScan,
  isSafeNoteName,
  memoryDirFor,
  normalizeRemote,
  parseNote,
  planInbound,
  projectDirName,
  renderBlock,
  scopeOf,
  teamText,
} from './core'

const note = (type: string, extra = '') =>
  `---\nname: n\ndescription: "d"\nmetadata:\n  type: ${type}\n${extra}---\n\nbody\n`

describe('parseNote', () => {
  test('reads type and share under metadata', async () => {
    const n = parseNote('a.md', note('project', '  share: private\n'))
    expect(n).toEqual({ file: 'a.md', name: 'n', description: 'd', type: 'project', share: 'private' })
  })
  test('reads a top-level type', async () => {
    expect(parseNote('b.md', '---\ntype: reference\n---\nx').type).toBe('reference')
  })
  test('ignores an unknown type and a file without frontmatter', async () => {
    expect(parseNote('c.md', '---\ntype: secret\n---\n').type).toBeUndefined()
    expect(parseNote('d.md', 'just text')).toEqual({ file: 'd.md' })
  })
  test('does not read nested keys outside metadata', async () => {
    expect(parseNote('e.md', '---\nother:\n  type: project\n---\n').type).toBeUndefined()
  })
})

describe('scopeOf', () => {
  test('project and reference go to the team, user and feedback stay private', async () => {
    expect(scopeOf({ file: 'a', type: 'project' })).toBe('team')
    expect(scopeOf({ file: 'a', type: 'reference' })).toBe('team')
    expect(scopeOf({ file: 'a', type: 'user' })).toBe('private')
    expect(scopeOf({ file: 'a', type: 'feedback' })).toBe('private')
  })
  test('a per-note share wins, an untyped note stays private', async () => {
    expect(scopeOf({ file: 'a', type: 'feedback', share: 'team' })).toBe('team')
    expect(scopeOf({ file: 'a', type: 'project', share: 'private' })).toBe('private')
    expect(scopeOf({ file: 'a' })).toBe('private')
  })
})

describe('memory folder', () => {
  test('matches the folder names Claude Code uses on this machine', async () => {
    expect(projectDirName('/Users/x/Projects')).toBe('-Users-x-Projects')
    expect(projectDirName('/private/tmp/claude-501/-Users-x')).toBe('-private-tmp-claude-501--Users-x')
  })
  test('builds the default path and honours the overrides', async () => {
    const base = { home: '/h', configDir: '/h/.claude/', projectRoot: '/w/repo' }
    expect(memoryDirFor(base)).toBe('/h/.claude/projects/-w-repo/memory')
    expect(memoryDirFor({ ...base, projectDirNameOverride: 'custom' })).toBe('/h/.claude/projects/custom/memory')
    expect(memoryDirFor({ ...base, autoMemoryDirectory: '~/mem/' })).toBe('/h/mem')
    expect(memoryDirFor({ ...base, autoMemoryDirectory: '/abs/mem' })).toBe('/abs/mem')
  })
})

describe('normalizeRemote', () => {
  test('gives one key for the usual spellings of a remote', async () => {
    const key = 'github.com/owner/repo'
    expect(normalizeRemote('git@github.com:owner/repo.git')).toBe(key)
    expect(normalizeRemote('https://github.com/owner/repo.git')).toBe(key)
    expect(normalizeRemote('https://user:token@GitHub.com/owner/repo/')).toBe(key)
    expect(normalizeRemote('ssh://git@github.com:22/owner/repo.git')).toBe(key)
  })
  test('returns null for nothing usable', async () => {
    expect(normalizeRemote(null)).toBeNull()
    expect(normalizeRemote('')).toBeNull()
    expect(normalizeRemote('https://github.com/')).toBeNull()
  })
})

describe('isSafeNoteName', () => {
  test('accepts plain note files only', async () => {
    expect(isSafeNoteName('project_x.md')).toBe(true)
    expect(isSafeNoteName('MEMORY.md')).toBe(false)
    expect(isSafeNoteName('../x.md')).toBe(false)
    expect(isSafeNoteName('sub/x.md')).toBe(false)
    expect(isSafeNoteName('.hidden.md')).toBe(false)
    expect(isSafeNoteName('x.txt')).toBe(false)
  })
})

describe('planInbound', () => {
  const m = (entries: Record<string, string>) => new Map(Object.entries(entries))

  test('copies a new team note and records it', async () => {
    const plan = planInbound(m({ 'a.md': 'A' }), m({}), {})
    expect(plan.actions).toEqual([{ kind: 'write', file: 'a.md', text: 'A' }])
    expect(plan.state).toEqual({ 'a.md': fingerprint('A') })
  })

  test('updates an unchanged local copy when the repo changed', async () => {
    const plan = planInbound(m({ 'a.md': 'A2' }), m({ 'a.md': 'A' }), { 'a.md': fingerprint('A') })
    expect(plan.actions).toEqual([{ kind: 'write', file: 'a.md', text: 'A2' }])
    expect(plan.state['a.md']).toBe(fingerprint('A2'))
  })

  test('leaves a local edit alone (pending outbound)', async () => {
    const plan = planInbound(m({ 'a.md': 'A' }), m({ 'a.md': 'A-local' }), { 'a.md': fingerprint('A') })
    expect(plan.actions).toEqual([])
    expect(plan.state['a.md']).toBe(fingerprint('A'))
  })

  test('holds a note changed on both sides and overwrites nothing', async () => {
    const plan = planInbound(m({ 'a.md': 'A-repo' }), m({ 'a.md': 'A-local' }), { 'a.md': fingerprint('A') })
    expect(plan.actions).toEqual([{ kind: 'held', file: 'a.md', reason: expect.stringContaining('both') }])
  })

  test('holds an unrelated local note with the same name', async () => {
    const plan = planInbound(m({ 'a.md': 'team' }), m({ 'a.md': 'mine' }), {})
    expect(plan.actions[0]?.kind).toBe('held')
    expect(plan.state).toEqual({})
  })

  test('adopts an identical local note without writing', async () => {
    const plan = planInbound(m({ 'a.md': 'same' }), m({ 'a.md': 'same' }), {})
    expect(plan.actions).toEqual([])
    expect(plan.state).toEqual({ 'a.md': fingerprint('same') })
  })

  test('does not re-create a team note deleted locally after a sync', async () => {
    const plan = planInbound(m({ 'a.md': 'A' }), m({}), { 'a.md': fingerprint('A') })
    expect(plan.actions).toEqual([])
    expect(plan.state).toEqual({ 'a.md': fingerprint('A') })
  })

  test('removes a note a teammate deleted, unless it changed locally', async () => {
    const gone = planInbound(m({}), m({ 'a.md': 'A' }), { 'a.md': fingerprint('A') })
    expect(gone.actions).toEqual([{ kind: 'delete', file: 'a.md' }])
    expect(gone.state).toEqual({})

    const kept = planInbound(m({}), m({ 'a.md': 'A-local' }), { 'a.md': fingerprint('A') })
    expect(kept.actions[0]?.kind).toBe('held')
  })

  test('never touches private notes it was not asked about', async () => {
    const plan = planInbound(m({}), m({ 'mine.md': 'private' }), {})
    expect(plan.actions).toEqual([])
  })
})

describe('MEMORY.md block', () => {
  const block = renderBlock([
    { file: 'b.md', name: 'B', description: 'second' },
    { file: 'a.md', name: 'A' },
  ])

  test('renders sorted index lines between markers', async () => {
    expect(block).toBe(`${BLOCK_START}\n- [A](a.md)\n- [B](b.md) — second\n${BLOCK_END}`)
    expect(renderBlock([])).toBe('')
  })

  test('appends to an index and keeps Claude\'s own lines', async () => {
    const out = applyBlock('# Memory\n- [mine](mine.md) — x\n', block)
    expect(out).toBe(`# Memory\n- [mine](mine.md) — x\n${block}\n`)
  })

  test('replaces an earlier block in place', async () => {
    const old = `top\n${BLOCK_START}\n- old\n${BLOCK_END}\nbottom\n`
    expect(applyBlock(old, block)).toBe(`top\n${block}\nbottom\n`)
  })

  test('an empty block removes the markers and nothing else', async () => {
    const old = `top\n${BLOCK_START}\n- old\n${BLOCK_END}\nbottom\n`
    expect(applyBlock(old, '')).toBe('top\nbottom\n')
    expect(applyBlock(`${BLOCK_START}\n- old\n${BLOCK_END}\n`, '')).toBe('')
    expect(applyBlock('untouched\n', '')).toBe('untouched\n')
  })

  test('starts an empty index with the block', async () => {
    expect(applyBlock('', block)).toBe(`${block}\n`)
  })
})

describe('indexAsLoaded', () => {
  test('strips the markers and keeps the lines', async () => {
    const raw = `# Memory\n- [mine](mine.md)\n${BLOCK_START}\n- [a](a.md) — x\n${BLOCK_END}\n`
    expect(indexAsLoaded(raw)).toBe('# Memory\n- [mine](mine.md)\n- [a](a.md) — x\n')
  })
  test('cuts at 200 lines', async () => {
    const raw = Array.from({ length: 250 }, (_, i) => `- line ${i}`).join('\n')
    const out = indexAsLoaded(raw).split('\n')
    expect(out.length).toBe(200)
    expect(out[199]).toBe('- line 199')
  })
})

describe('privacyScan', () => {
  test('finds personal data and secrets by kind and line', async () => {
    const kinds = (t: string) => privacyScan(t).map(f => f.kind)
    expect(kinds('see /Users/alice/x')).toEqual(['local path with a user name'])
    expect(kinds('see /home/bob/x')).toEqual(['local path with a user name'])
    expect(kinds('write to dev@acme.io')).toEqual(['e-mail address'])
    // Fake secrets are joined at run time so the source holds no secret-shaped literal.
    expect(kinds('AKIA' + 'ABCDEFGHIJKLMNOP')).toEqual(['AWS access key'])
    expect(kinds('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----')).toEqual(['private key'])
    expect(kinds('zero​width')).toEqual(['invisible or direction-changing character'])
    expect(privacyScan('ok\nsk-' + 'ant-api03-abcdefghijklmnopqrstuvwx')[0]).toEqual({ kind: 'API key', line: 2 })
  })
  test('lets placeholders and safe examples through', async () => {
    expect(privacyScan('/Users/x/Projects and /home/you/repo')).toEqual([])
    expect(privacyScan('mail a@example.com or 1+me@users.noreply.github.com')).toEqual([])
    expect(privacyScan('the deploy codename is BLUE-HERON-42')).toEqual([])
  })
})

describe('planOutbound', () => {
  const m = (entries: Record<string, string>) => new Map(Object.entries(entries))
  const proj = (body: string) => `---\nmetadata:\n  type: project\n---\n${body}`
  const user = (body: string) => `---\nmetadata:\n  type: user\n---\n${body}`

  test('proposes a new team note, never a private one', async () => {
    const items = planOutbound(m({ 'p.md': proj('a'), 'u.md': user('b') }), m({}), {})
    expect(items.map(i => [i.kind, i.file])).toEqual([['add', 'p.md']])
  })

  test('proposes an edit only while the repo copy is unchanged', async () => {
    const synced = { 'p.md': fingerprint(proj('a')) }
    expect(planOutbound(m({ 'p.md': proj('b') }), m({ 'p.md': proj('a') }), synced).map(i => i.kind)).toEqual(['update'])
    expect(planOutbound(m({ 'p.md': proj('b') }), m({ 'p.md': proj('c') }), synced)).toEqual([])
  })

  test('proposes removal for a local deletion and for a note re-marked private', async () => {
    const synced = { 'p.md': fingerprint(proj('a')) }
    expect(planOutbound(m({}), m({ 'p.md': proj('a') }), synced)).toEqual([
      { kind: 'remove', file: 'p.md', why: 'deleted locally', fp: synced['p.md'] },
    ])
    const priv = proj('a').replace('type: project', 'type: project\n  share: private')
    expect(planOutbound(m({ 'p.md': priv }), m({ 'p.md': proj('a') }), synced)[0]).toEqual(
      expect.objectContaining({ kind: 'remove', why: 'marked private' }),
    )
  })

  test('skips a rejected version until it changes', async () => {
    const rejected = { 'p.md': fingerprint(proj('a')) }
    expect(planOutbound(m({ 'p.md': proj('a') }), m({}), {}, rejected)).toEqual([])
    expect(planOutbound(m({ 'p.md': proj('b') }), m({}), {}, rejected).length).toBe(1)
  })

  test('leaves a same-named repo note to the inbound side', async () => {
    expect(planOutbound(m({ 'p.md': proj('mine') }), m({ 'p.md': proj('theirs') }), {})).toEqual([])
  })
})

describe('notListedOutsideBlock', () => {
  test('drops notes Claude already lists itself', async () => {
    const md = `- [a](a.md) — mine\n${BLOCK_START}\n- [b](b.md)\n${BLOCK_END}\n`
    expect(notListedOutsideBlock([{ file: 'a.md' }, { file: 'b.md' }], md).map(n => n.file)).toEqual(['b.md'])
  })
})

describe('teamText', () => {
  const stamped =
    '---\nname: n\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: 0ede3444-9bad\n  modified: 2026-11-14T17:35:25.338Z\n---\n\nbody\n'
  test('drops the session id and timestamp Claude Code stamps', async () => {
    expect(teamText(stamped)).toBe('---\nname: n\nmetadata:\n  node_type: memory\n  type: project\n---\n\nbody\n')
  })
  test('copies that differ only in stamps count as equal', async () => {
    expect(noteFingerprint(stamped)).toBe(noteFingerprint(teamText(stamped)))
    expect(noteFingerprint(stamped)).not.toBe(noteFingerprint(stamped.replace('body', 'other')))
  })
  test('the shared text of a proposal carries no stamps, and a stamped local copy is not re-proposed', async () => {
    const [item] = planOutbound(new Map([['p.md', stamped]]), new Map(), {})
    expect(item && 'text' in item ? item.text : '').not.toContain('originSessionId')
    const synced = { 'p.md': noteFingerprint(stamped) }
    const restamped = stamped.replace('17:35:25', '18:00:00')
    expect(planOutbound(new Map([['p.md', restamped]]), new Map([['p.md', teamText(stamped)]]), synced)).toEqual([])
  })
})

describe('setShare', () => {
  test('adds share under metadata and replaces an earlier one', async () => {
    const t = '---\nname: n\nmetadata:\n  type: project\n---\nbody'
    expect(setShare(t, 'private')).toBe('---\nname: n\nmetadata:\n  type: project\n  share: private\n---\nbody')
    expect(setShare(setShare(t, 'private'), 'team')).toBe('---\nname: n\nmetadata:\n  type: project\n  share: team\n---\nbody')
  })
  test('uses the top level without metadata, and adds frontmatter when there is none', async () => {
    expect(setShare('---\ntype: user\n---\nb', 'team')).toBe('---\ntype: user\nshare: team\n---\nb')
    expect(parseNote('x.md', setShare('plain', 'team')).share).toBe('team')
  })
})

describe('indexCost', () => {
  test('counts lines, bytes and tokens without the markers', async () => {
    const c = indexCost(`- [a](a.md) — x\n${BLOCK_START}\n- [b](b.md)\n${BLOCK_END}\n`)
    expect(c.lines).toBe(2)
    expect(c.used).toBe(2 / 200)
    expect(c.tokens).toBeGreaterThan(0)
  })
})

describe('lintNotes', () => {
  const m = (entries: Record<string, string>) => new Map(Object.entries(entries))
  const n = (name: string, type = 'project', extra = '') => `---\nname: ${name}\ndescription: d\nmetadata:\n  type: ${type}\n---\n${extra}`
  test('finds missing fields, index gaps, broken links and duplicate names', async () => {
    const issues = lintNotes(
      m({ 'a.md': n('a', 'project', 'see [[b]] and [[ghost]]'), 'b.md': n('b'), 'c.md': '---\nname: a\n---\n' }),
      '- [a](a.md)\n- [gone](gone.md)\n',
    ).map(i => `${i.file}: ${i.problem}`)
    expect(issues).toContain('c.md: no type (user, feedback, project or reference); it stays private')
    expect(issues).toContain('c.md: no description, so its index line says little')
    expect(issues).toContain('MEMORY.md: links to gone.md, which does not exist')
    expect(issues).toContain('b.md: not in MEMORY.md, so Claude does not see it at session start')
    expect(issues).toContain('a.md, c.md: share the name "a"')
    expect(issues).toContain('a.md: links to [[ghost]], which no note is named')
    expect(issues.some(i => i.includes('[[b]]'))).toBe(false)
  })
  test('a clean folder has no issues', async () => {
    expect(lintNotes(m({ 'a.md': n('a') }), '- [a](a.md)\n')).toEqual([])
  })
})

describe('compactSuggestions', () => {
  test('pairs notes that say much the same and flags long ones, of the same type only', async () => {
    const note = (name: string, description: string, type = 'project', body = '') =>
      `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n${body}`
    const ideas = compactSuggestions(
      new Map([
        ['a.md', note('staging reset', 'staging database reset every sunday night')],
        ['b.md', note('staging wipe', 'the staging database gets reset every sunday')],
        ['c.md', note('staging reset', 'staging database reset every sunday night', 'user')],
        ['d.md', note('long', 'something else entirely', 'project', 'x'.repeat(2100))],
      ]),
    )
    expect(ideas).toEqual([
      { files: ['a.md', 'b.md'], suggestion: 'say much the same; consider merging them into one note' },
      { files: ['d.md'], suggestion: expect.stringContaining('consider shortening') },
    ])
  })
})

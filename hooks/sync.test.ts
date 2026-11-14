import { expect, mock, test } from 'claude-code/testing'
import { BLOCK_START, fingerprint } from './core'
import { MEM, ROOT, TEAM, run, start, team, world } from './testworld'

test('imports team notes and adds the index block, leaving private notes alone', async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/project_api.md`]: team('api'),
    [`${TEAM}/reference_docs.md`]: team('docs', 'reference'),
    [`${MEM}/MEMORY.md`]: '- [mine](user_me.md) — private\n',
    [`${MEM}/user_me.md`]: team('me', 'user'),
  })

  await start($)

  expect(w.files.get(`${MEM}/project_api.md`)).toBe(team('api'))
  expect(w.files.get(`${MEM}/reference_docs.md`)).toBe(team('docs', 'reference'))
  expect(w.files.get(`${MEM}/user_me.md`)).toBe(team('me', 'user'))
  const index = w.files.get(`${MEM}/MEMORY.md`) ?? ''
  expect(index.startsWith('- [mine](user_me.md) — private\n')).toBe(true)
  expect(index).toContain(`${BLOCK_START}\n- [api](project_api.md) — about api\n- [docs](reference_docs.md) — about docs\n`)
  expect(w.fetched).toEqual(['https://api.github.com/repos/acme/repo'])
  expect(w.toasts).toEqual(['2 team note(s) updated'])
})

test('a second run changes nothing', async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${TEAM}/project_api.md`]: team('api') })

  await start($)
  const snapshot = new Map(w.files)
  await start($)

  expect(w.files).toEqual(snapshot)
  expect(w.toasts).toEqual(['1 team note(s) updated'])
  expect(w.fetched.length).toBe(1) // visibility is cached
})

test('removes a note a teammate deleted from the repo', async ($, on) => {
  mock.store(on, { [`sync:${MEM}`]: { 'project_old.md': fingerprint(team('old')) } })
  const w = world(on, {
    [`${TEAM}/project_api.md`]: team('api'),
    [`${MEM}/project_old.md`]: team('old'),
  })

  await start($)

  expect(w.toasts).toEqual(['1 team note(s) updated, 1 team note(s) removed'])
  expect(w.removed).toEqual([`${MEM}/project_old.md`])
})

test('holds a local note that clashes with a team note', async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/project_api.md`]: team('api'),
    [`${MEM}/project_api.md`]: 'my own note\n',
  })

  await start($)

  expect(w.toasts).toEqual(['held: project_api.md'])
  expect(w.files.get(`${MEM}/project_api.md`)).toBe('my own note\n')
})

test('stays off in a public GitHub repository', async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${TEAM}/project_api.md`]: team('api') }, { githubStatus: 200 })

  await start($)

  expect(w.files.has(`${MEM}/project_api.md`)).toBe(false)
  expect(w.toasts).toEqual([])
})

test('does nothing in a repo without .claude/memory', async ($, on) => {
  mock.store(on)
  const w = world(on, {})

  await start($)

  expect(w.fetched).toEqual([])
  expect(w.toasts).toEqual([])
})

test('the first context gets the fresh MEMORY.md even when Claude Code read it too early', async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${TEAM}/project_api.md`]: team('api') })
  // Stands for the engine: it rendered the context before the sync, with no MEMORY.md.
  on('prompt.context', (_, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))

  await start($)
  const ctx = await $.prompt.context({ blocks: [], instructionFiles: [] })

  expect(ctx.instructionFiles).toEqual([
    { path: `${MEM}/MEMORY.md`, kind: 'memory', content: '- [api](project_api.md) — about api\n' },
  ])
  expect(w.files.get(`${MEM}/MEMORY.md`)).toContain(BLOCK_START)
})

test('a stale MEMORY.md entry is replaced, other instruction files stay', async ($, on) => {
  mock.store(on)
  world(on, {
    [`${TEAM}/project_api.md`]: team('api'),
    [`${MEM}/MEMORY.md`]: '- [mine](user_me.md)\n',
  })
  on('prompt.context', (_, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  const claudeMd = { path: `${ROOT}/CLAUDE.md`, kind: 'project' as const, content: 'rules' }

  await start($)
  const ctx = await $.prompt.context({
    blocks: [],
    instructionFiles: [claudeMd, { path: `${MEM}/MEMORY.md`, kind: 'memory', content: '- [mine](user_me.md)\n' }],
  })

  expect(ctx.instructionFiles).toEqual([
    claudeMd,
    { path: `${MEM}/MEMORY.md`, kind: 'memory', content: '- [mine](user_me.md)\n- [api](project_api.md) — about api\n' },
  ])
})

// ---------------------------------------------------------------------------------------------
// Outbound (M2)

test('confirm mode: a team note Claude wrote waits for approval, then goes to the repo uncommitted', async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/project_new.md`]: team('new'),
    [`${MEM}/feedback_style.md`]: team('style', 'feedback'),
  })

  await start($)
  expect(w.toasts).toEqual(['1 note change(s) wait for approval: /marginalia'])
  expect(w.files.has(`${TEAM}/project_new.md`)).toBe(false)
  expect(await run($, '')).toContain('add project_new.md')

  expect(await run($, 'approve project_new.md')).toContain('shared to .claude/memory/ (uncommitted): project_new.md')
  expect(w.files.get(`${TEAM}/project_new.md`)).toBe(team('new'))
  expect(w.files.has(`${TEAM}/feedback_style.md`)).toBe(false) // feedback stays private
  expect(w.files.get(`${MEM}/MEMORY.md`)).toContain('- [new](project_new.md) — about new')
  expect(await run($, '')).toContain('nothing waits to be shared.')
})

test('the privacy check holds a note until it is fixed or forced', async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/project_paths.md`]: team('paths').replace('paths body', 'build lives in /Users/alice/work and mail bob@acme.io'),
  })

  await start($)
  const status = await run($, '')
  expect(status).toContain('local path with a user name (line 8)')
  expect(status).toContain('e-mail address (line 8)')
  expect(status).not.toContain('alice') // never echoes the value

  expect(await run($, 'approve all')).toContain('held team: add project_paths.md')
  expect(w.files.has(`${TEAM}/project_paths.md`)).toBe(false)

  expect(await run($, 'approve project_paths.md --force')).toContain('shared')
  expect(w.files.has(`${TEAM}/project_paths.md`)).toBe(true)
})

test('a rejected note stays local until it changes', async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${TEAM}/README.md`]: 'team memory', [`${MEM}/project_x.md`]: team('x') })

  await start($)
  expect(await run($, 'reject project_x.md')).toBe('kept local: project_x.md.')
  expect(await run($, '')).toContain('nothing waits to be shared.')

  w.files.set(`${MEM}/project_x.md`, team('x2'))
  expect(await run($, '')).toContain('add project_x.md')
})

test('deleting a shared note locally proposes removing it from the repo', async ($, on) => {
  mock.store(on, { [`sync:${MEM}`]: { 'project_old.md': fingerprint(team('old')) } })
  const w = world(on, { [`${TEAM}/project_old.md`]: team('old') })
  // Locally deleted after the last sync; inbound must not bring it back.

  await start($)
  expect(w.files.has(`${MEM}/project_old.md`)).toBe(false)
  expect(await run($, '')).toContain('remove (deleted locally) project_old.md')

  await run($, 'approve all')
  expect(w.removed).toEqual([`${TEAM}/project_old.md`])
})

test('auto mode shares clean notes at once and holds the ones with privacy hits', { options: { teamShare: 'auto' } }, async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/project_clean.md`]: team('clean'),
    [`${MEM}/project_leaky.md`]: team('leaky').replace('leaky body', 'token = ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'),
  })

  await start($)

  expect(w.files.get(`${TEAM}/project_clean.md`)).toBe(team('clean'))
  expect(w.files.has(`${TEAM}/project_leaky.md`)).toBe(false)
  expect(w.toasts).toContain('shared 1 team note(s) to .claude/memory/ (uncommitted)')
  expect(w.toasts).toContain('1 note change(s) wait for approval: /marginalia')
})

test('/marginalia init switches a repo on', async ($, on) => {
  mock.store(on)
  const w = world(on, {})

  expect(await run($, '')).toContain('run /marginalia init')
  expect(await run($, 'init')).toContain('created .claude/memory/README.md')
  expect(w.files.get(`${TEAM}/README.md`)).toContain('# Team memory')
  expect(await run($, '')).toContain('nothing waits to be shared.')
})

import { expect, mock, test } from 'claude-code/testing'
import { MEM, TEAM, run, start, team, world } from './testworld'

const PANE = {
  plugin: 'marginalia',
  component: 'Pane',
  requestId: 'marginalia',
  props: {
    title: 'Marginalia',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the pane shows what waits, and Approve shares it', async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/MEMORY.md`]: '- [new](project_new.md) — about new\n',
    [`${MEM}/project_new.md`]: team('new'),
  })
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Waiting \(1\)/ }))?.text).toBe('Waiting (1)')
    expect(await ui.find({ type: 'Text', text: /team: add project_new\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tokens/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'approve:team:project_new.md' })
  expect(w.files.get(`${TEAM}/project_new.md`)).toBe(team('new'))
  expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toBe('Waiting (0)')
  expect(await ui.find({ type: 'Text', text: /shared to \.claude\/memory/ })).toBeDefined()
  await ui.unmount()
})

test('a privacy hit offers "Share anyway" instead of Approve', async ($, on) => {
  mock.store(on)
  world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/project_p.md`]: team('p').replace('p body', 'mail bob@acme.io'),
  })
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /privacy check: e-mail address/ })).toBeDefined()
  expect(await ui.find({ key: 'force:team:project_p.md' })).toBeDefined()
  expect(await ui.find({ key: 'approve:team:project_p.md' })).toBeUndefined()
  await ui.unmount()
})

test('share, unshare, lint and compact work from the command', async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/MEMORY.md`]: '- [s](feedback_s.md)\n',
    [`${MEM}/feedback_s.md`]: team('s', 'feedback'),
  })
  await start($)

  expect(await run($, 'share feedback_s.md')).toContain('feedback_s.md is now a team note.')
  expect(w.files.get(`${MEM}/feedback_s.md`)).toContain('  share: team')
  expect(await run($, '')).toContain('team: add feedback_s.md')

  expect(await run($, 'unshare feedback_s.md')).toContain('is now private')
  expect(await run($, '')).toContain('nothing waits to be shared.')

  expect(await run($, 'lint')).toBe('no issues in 1 note(s).')
  expect(await run($, 'compact')).toBe('nothing to suggest for 1 note(s).')
  expect(await run($, 'share ../etc.md')).toContain('is not a note file name')
})

test('/marginalia sync reports what it did', async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${TEAM}/README.md`]: 'team memory' })
  await start($)

  w.files.set(`${TEAM}/project_late.md`, team('late'))
  expect(await run($, 'sync')).toBe('1 team note(s) updated')
  expect(w.files.get(`${MEM}/project_late.md`)).toBe(team('late'))
  expect(await run($, 'sync')).toBe('in sync; nothing changed.')
})

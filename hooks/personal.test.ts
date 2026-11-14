import { expect, mock, test } from 'claude-code/testing'
import { fingerprint } from './core'
import { MEM, STORE, TEAM, run, start, team, world } from './testworld'

const STORE_URL = 'git@github.com:me/claude-memory.git'
const withStore = { options: { personalStore: STORE_URL } }
const FOLDER = `${STORE}/github.com/acme/repo`

test('auto: a private note goes to the store, committed and pushed; a team note stays with the team flow', withStore, async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${TEAM}/README.md`]: 'team memory',
    [`${MEM}/user_role.md`]: team('role', 'user'),
    [`${MEM}/project_api.md`]: team('api'),
  })

  await start($)

  expect(w.files.get(`${FOLDER}/user_role.md`)).toBe(team('role', 'user'))
  expect(w.files.has(`${FOLDER}/project_api.md`)).toBe(false) // team note: proposed to the repo instead
  // Reads of the clone's origin (before every write and for the pane) are left out here.
  expect(w.git.filter(g => g !== 'git remote get-url origin')).toEqual([
    `git clone --quiet ${STORE_URL} ${STORE}`,
    'git add -A -- github.com/acme/repo',
    'git diff --cached --quiet',
    'git commit --quiet -m github.com/acme/repo: add 1, update 0, remove 0',
    'git push --quiet',
  ])
  expect(w.toasts).toContain('1 note change(s) wait for approval: /marginalia')
})

test('without team sync, the store holds every note of the project', withStore, async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${MEM}/user_role.md`]: team('role', 'user'),
    [`${MEM}/project_api.md`]: team('api'),
  })

  await start($)

  expect(w.files.has(`${FOLDER}/user_role.md`)).toBe(true)
  expect(w.files.has(`${FOLDER}/project_api.md`)).toBe(true)
})

test('a folder outside any repo is keyed by its path below home', withStore, async ($, on) => {
  mock.store(on)
  const projects = '/home/me/Projects'
  const mem = '/home/me/.claude/projects/-home-me-Projects/memory'
  const w = world(on, { [`${mem}/feedback_short.md`]: team('short', 'feedback') }, { noRepo: true, root: projects })

  await start($)

  expect(w.files.get(`${STORE}/home/Projects/feedback_short.md`)).toBe(team('short', 'feedback'))
})

test('on another machine, the store\'s notes arrive in the local memory and the index', withStore, async ($, on) => {
  mock.store(on)
  const w = world(on, {
    [`${STORE}/.git`]: 'gitdir',
    [`${FOLDER}/user_role.md`]: team('role', 'user'),
  })

  await start($)

  expect(w.git.slice(0, 2)).toEqual(['git remote get-url origin', 'git pull --rebase --autostash --quiet'])
  expect(w.files.get(`${MEM}/user_role.md`)).toBe(team('role', 'user'))
  expect(w.files.get(`${MEM}/MEMORY.md`)).toContain('- [role](user_role.md) — about role')
  expect(w.toasts).toContain('1 personal note(s) updated')
  expect(w.git.filter(g => g.startsWith('git commit'))).toEqual([]) // nothing new to push
})

test('confirm: personal changes wait for /marginalia approve', { options: { personalStore: STORE_URL, personalSync: 'confirm' } }, async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${MEM}/user_role.md`]: team('role', 'user') })

  await start($)
  expect(w.files.has(`${FOLDER}/user_role.md`)).toBe(false)
  expect(await run($, '')).toContain('personal: add user_role.md')

  expect(await run($, 'approve user_role.md')).toContain('personal store (github.com/acme/repo): user_role.md.')
  expect(w.files.has(`${FOLDER}/user_role.md`)).toBe(true)
  expect(w.git).toContain('git push --quiet')
})

test('a failed push is reported, the commit stays', { options: { personalStore: STORE_URL } }, async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${MEM}/user_role.md`]: team('role', 'user') }, { pushExit: 1 })

  await start($)

  expect(w.toasts).toContain('personal store: committed, but could not push: rejected')
  expect(w.git.filter(g => g === 'git push --quiet').length).toBe(2) // retried after a pull
})

test('a note re-marked as team leaves the store once team sync is on', withStore, async ($, on) => {
  const moved = team('api')
  mock.store(on, { [`personal:${MEM}`]: { 'project_api.md': fingerprint(moved) } })
  const w = world(on, {
    [`${STORE}/.git`]: 'gitdir',
    [`${TEAM}/README.md`]: 'team memory',
    [`${FOLDER}/project_api.md`]: moved,
    [`${MEM}/project_api.md`]: moved,
  })

  await start($)

  expect(w.removed).toContain(`${FOLDER}/project_api.md`)
  expect(w.git).toContain('git commit --quiet -m github.com/acme/repo: add 0, update 0, remove 1')
})

test('without a configured store, personal sync is off and says so', async ($, on) => {
  mock.store(on)
  const w = world(on, { [`${TEAM}/README.md`]: 'team memory', [`${MEM}/user_role.md`]: team('role', 'user') })

  await start($)

  expect(w.git).toEqual([])
  expect(await run($, '')).toContain('personal sync is off: no personal store configured.')
})

test('a clone of a different store is never written to', withStore, async ($, on) => {
  mock.store(on)
  const w = world(
    on,
    { [`${STORE}/.git`]: 'gitdir', [`${MEM}/user_role.md`]: team('role', 'user') },
    { storeOrigin: 'git@github.com:someone/else.git' },
  )

  await start($)

  expect(w.files.has(`${FOLDER}/user_role.md`)).toBe(false)
  expect(w.git.some(g => g.startsWith('git pull') || g.startsWith('git commit'))).toBe(false)
  expect(w.toasts.some(t => t.includes('points to git@github.com:someone/else.git'))).toBe(true)
})

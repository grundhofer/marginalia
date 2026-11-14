// /marginalia: status, approve, reject, share, unshare, sync, lint, compact, pane, init.

import type { EngineInterface } from 'claude-code'
import { compactSuggestions, isSafeNoteName, lintNotes, setShare, type OutboundItem } from './core'
import { readIfExists, readNotes, resolveMemoryDir, TEAM_DIR } from './context'
import { applyItems, describe, reject, scanOutbound, type Pending, type ShareMode } from './outbound'
import { applyPersonal, rejectPersonal, scanPersonal, type PersonalConfig } from './personal'

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

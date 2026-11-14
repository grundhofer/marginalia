// The snapshot the review pane draws from, rebuilt after every sync and action.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { PaneData, PaneRow } from '../types'
import type { Config } from './commands'
import { readIfExists, readNotes, resolveMemoryDir } from './context'
import { indexCost, lintNotes } from './core'
import { scanOutbound, type Pending } from './outbound'
import { scanPersonal } from './personal'

export const PANE = 'marginalia'
export const PANE_TITLE = 'Marginalia'

// Change the tag when PaneData's fields change (here and in pane.tsx): it declines what an
// earlier version stored.
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


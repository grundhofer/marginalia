// What hooks, the command and the pane's buttons do. Every function that takes `$` is declared
// at the top level: the engine accepts `$` only there.

import type { EngineInterface } from 'claude-code'
import { COMMAND, runCommand, type Config } from './commands'
import { PANE, PANE_TITLE, refreshPane } from './snapshot'
import { syncAllInbound, syncAllOutbound, type InboundSummary } from './sync'

// What the last toast announced as waiting, so an unchanged list is not announced every turn.
let lastWaiting = ''
let paneFailureShown = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export async function inbound($: EngineInterface, cfg: Config): Promise<InboundSummary> {
  const summary = await syncAllInbound($, cfg)
  if (summary.lines.length) $.ui.toast(summary.lines.join(', '))
  return summary
}

export async function outbound($: EngineInterface, cfg: Config): Promise<void> {
  const summary = await syncAllOutbound($, cfg)
  for (const line of summary.lines) $.ui.toast(line)
  if (summary.signature && summary.signature !== lastWaiting) {
    $.ui.toast(`${summary.waiting} note change(s) wait for approval: /${COMMAND}`)
  }
  lastWaiting = summary.signature
}

/** The pane is a view: a failure to refresh it never stops a sync. */
export async function refresh($: EngineInterface, cfg: Config, change: Parameters<typeof refreshPane>[2] = {}): Promise<void> {
  try {
    await refreshPane($, cfg, change)
  } catch (err) {
    if (!paneFailureShown) $.ui.toast(`could not refresh the pane: ${message(err)}`)
    paneFailureShown = true
  }
}

/** `/marginalia sync`: both directions now. */
export async function syncNow($: EngineInterface, cfg: Config): Promise<string> {
  const i = await syncAllInbound($, cfg)
  const o = await syncAllOutbound($, cfg)
  lastWaiting = o.signature
  await refresh($, cfg, { held: i.held })
  const lines = [...i.lines, ...o.lines]
  if (o.waiting) lines.push(`${o.waiting} change(s) wait for approval: /${COMMAND}`)
  return lines.length ? lines.join('\n') : 'in sync; nothing changed.'
}

export async function syncFromPane($: EngineInterface, cfg: Config): Promise<void> {
  const text = await syncNow($, cfg)
  await refresh($, cfg, { last: text.split('\n')[0] ?? '' })
}

export async function openPane($: EngineInterface, cfg: Config): Promise<string> {
  await refresh($, cfg)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  return 'pane opened.'
}

/** A pane button: runs the command's verb, then shows its first line in the pane. */
export async function paneAct($: EngineInterface, cfg: Config, args: string): Promise<void> {
  const text = await runCommand($, args, cfg)
  await refresh($, cfg, { last: text.split('\n')[0] ?? '' })
}

/** The command: `sync` and `pane` run here, every other verb in runCommand. */
export async function command($: EngineInterface, cfg: Config, args: string): Promise<string> {
  const verb = args.trim().split(/\s+/)[0] ?? ''
  if (verb === 'sync') return syncNow($, cfg)
  if (verb === 'pane') return openPane($, cfg)
  const text = await runCommand($, args, cfg)
  await refresh($, cfg)
  return text
}

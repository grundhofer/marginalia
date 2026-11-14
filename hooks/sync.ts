// The sync runs: both inbound directions at session start, both outbound directions after a turn.

import type { EngineInterface } from 'claude-code'
import type { Config } from './commands'
import { syncInbound } from './inbound'
import { runOutbound } from './outbound'
import { runPersonalOutbound, syncPersonalInbound } from './personal'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export type Held = { file: string; reason: string }

export type InboundSummary = {
  /** The memory folder that was synced, if any. */
  memoryDir: string | null
  /** One line per thing that happened, for a toast or a command's answer. */
  lines: string[]
  held: Held[]
}

/** Both inbound directions: team notes from the repo, personal notes from the store. */
export async function syncAllInbound($: EngineInterface, cfg: Config): Promise<InboundSummary> {
  let memoryDir: string | null = null
  const lines: string[] = []
  const held: Held[] = []
  try {
    const team = await syncInbound($)
    if (team.status === 'synced') {
      memoryDir = team.memoryDir
      if (team.written.length) lines.push(`${team.written.length} team note(s) updated`)
      if (team.deleted.length) lines.push(`${team.deleted.length} team note(s) removed`)
      held.push(...team.held)
    }
  } catch (err) {
    lines.push(`team sync failed: ${message(err)}`)
  }
  try {
    const personal = await syncPersonalInbound($, cfg.personal)
    if (personal.status === 'skipped' && cfg.personal.store.trim() && /personal store/.test(personal.reason)) {
      lines.push(personal.reason)
    }
    if (personal.status === 'synced') {
      memoryDir ??= personal.memoryDir
      if (personal.written.length) lines.push(`${personal.written.length} personal note(s) updated`)
      if (personal.deleted.length) lines.push(`${personal.deleted.length} personal note(s) removed`)
      if (personal.warning) lines.push(personal.warning)
      held.push(...personal.held)
    }
  } catch (err) {
    lines.push(`personal sync failed: ${message(err)}`)
  }
  if (held.length) lines.push(`held: ${held.map(h => h.file).join(', ')}`)
  return { memoryDir, lines, held }
}

export type OutboundSummary = { lines: string[]; waiting: number; signature: string }

/** Both outbound directions; in auto mode they share, otherwise they report what waits. */
export async function syncAllOutbound($: EngineInterface, cfg: Config): Promise<OutboundSummary> {
  const lines: string[] = []
  const waiting: string[] = []
  try {
    const r = await runOutbound($, cfg.teamShare, cfg.privacyCheck)
    if (r.ok) {
      if (r.applied.length) lines.push(`shared ${r.applied.length} team note(s) to .claude/memory/ (uncommitted)`)
      for (const f of r.failed) lines.push(`could not share ${f.file}: ${f.reason}`)
      for (const p of r.waiting) waiting.push(`t:${p.item.kind}:${p.item.file}:${p.item.fp}`)
    }
  } catch (err) {
    lines.push(`team check failed: ${message(err)}`)
  }
  try {
    const r = await runPersonalOutbound($, cfg.personal)
    if (r.ok) {
      if (r.applied.length) lines.push(`pushed ${r.applied.length} personal note change(s)`)
      if (r.warning) lines.push(`personal store: ${r.warning}`)
      for (const f of r.failed) lines.push(`personal store: ${f.file}: ${f.reason}`)
      for (const p of r.waiting) waiting.push(`p:${p.item.kind}:${p.item.file}:${p.item.fp}`)
    }
  } catch (err) {
    lines.push(`personal check failed: ${message(err)}`)
  }
  return { lines, waiting: waiting.length, signature: waiting.join('|') }
}

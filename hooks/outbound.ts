// Outbound sync (M2): team notes from the local auto-memory folder -> <repo>/.claude/memory/.
// Marginalia writes the files; it never commits. The person commits like any other change.

import type { EngineInterface } from 'claude-code'
import { planOutbound, privacyScan, removalMark, type OutboundItem, type PrivacyFinding, type Rejections } from './core'
import { readNotes, readState, removeNote, resolveContext, type SyncContext } from './context'
import { refreshIndex } from './inbound'

export type ShareMode = 'confirm' | 'auto'

export type Pending = { item: OutboundItem; findings: PrivacyFinding[] }

export type OutboundScan = { ok: false; reason: string; repoRoot?: string } | { ok: true; ctx: SyncContext; pending: Pending[] }

const rejectedKey = (ctx: SyncContext) => `rejected:${ctx.memoryDir}`

export async function scanOutbound($: EngineInterface, privacyCheck: boolean): Promise<OutboundScan> {
  const resolved = await resolveContext($)
  if (!resolved.ok) return resolved
  const { ctx } = resolved
  const local = await readNotes($, ctx.memoryDir)
  const repo = await readNotes($, ctx.teamDir)
  const state = await readState($, ctx)
  const rejected = ((await $.store.get(rejectedKey(ctx))) as Rejections | undefined) ?? {}
  const pending = planOutbound(local, repo, state, rejected).map(item => ({
    item,
    findings: privacyCheck && item.kind !== 'remove' ? privacyScan(item.text) : [],
  }))
  return { ok: true, ctx, pending }
}

export type Applied = { applied: OutboundItem[]; failed: { file: string; reason: string }[] }

export async function applyItems($: EngineInterface, ctx: SyncContext, items: readonly OutboundItem[]): Promise<Applied> {
  const state = { ...(await readState($, ctx)) }
  const applied: OutboundItem[] = []
  const failed: { file: string; reason: string }[] = []
  for (const item of items) {
    if (item.kind === 'remove') {
      const err = await removeNote($, ctx.teamDir, item.file)
      if (err === null) {
        delete state[item.file]
        applied.push(item)
      } else {
        failed.push({ file: item.file, reason: err })
      }
    } else {
      await $.fs.write(`${ctx.teamDir}/${item.file}`, item.text)
      state[item.file] = item.fp
      applied.push(item)
    }
  }
  await $.store.set(ctx.stateKey, state)
  await refreshIndex($, ctx.memoryDir)
  return { applied, failed }
}

export async function reject($: EngineInterface, ctx: SyncContext, items: readonly OutboundItem[]): Promise<void> {
  const rejected = { ...(((await $.store.get(rejectedKey(ctx))) as Rejections | undefined) ?? {}) }
  for (const item of items) rejected[item.file] = item.kind === 'remove' ? removalMark(item.fp) : item.fp
  await $.store.set(rejectedKey(ctx), rejected)
}

export type OutboundRun = { ok: false; reason: string } | { ok: true; applied: OutboundItem[]; failed: { file: string; reason: string }[]; waiting: Pending[] }

/** In `auto` mode, shares what passes the privacy check; everything else waits for the person. */
export async function runOutbound($: EngineInterface, mode: ShareMode, privacyCheck: boolean): Promise<OutboundRun> {
  const scan = await scanOutbound($, privacyCheck)
  if (!scan.ok) return { ok: false, reason: scan.reason }
  if (mode === 'confirm') return { ok: true, applied: [], failed: [], waiting: scan.pending }
  const clean = scan.pending.filter(p => p.findings.length === 0).map(p => p.item)
  const { applied, failed } = await applyItems($, scan.ctx, clean)
  return { ok: true, applied, failed, waiting: scan.pending.filter(p => p.findings.length > 0) }
}

export function describe(p: Pending): string {
  const what = p.item.kind === 'remove' ? `remove (${p.item.why})` : p.item.kind
  const flags = p.findings.length
    ? ` — privacy check: ${[...new Set(p.findings.map(f => `${f.kind} (line ${f.line})`))].join(', ')}`
    : ''
  return `${what} ${p.item.file}${flags}`
}

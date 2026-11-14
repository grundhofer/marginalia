// Inbound sync (M1): team notes committed in <repo>/.claude/memory/ -> the local auto-memory folder.

import type { EngineInterface } from 'claude-code'
import { applyBlock, isSafeNoteName, notListedOutsideBlock, parseNote, planInbound, renderBlock, type Note, type SyncState } from './core'
import { readIfExists, readNotes, readState, removeNote, resolveContext } from './context'

export type InboundResult =
  | { status: 'skipped'; reason: string }
  | { status: 'synced'; memoryDir: string; written: string[]; deleted: string[]; held: { file: string; reason: string }[]; teamNotes: number }

export async function syncInbound($: EngineInterface): Promise<InboundResult> {
  const resolved = await resolveContext($)
  if (!resolved.ok) return { status: 'skipped', reason: resolved.reason }
  const { ctx } = resolved

  const repoNotes = await readNotes($, ctx.teamDir)
  const state = await readState($, ctx)

  const local = new Map<string, string>()
  for (const file of new Set([...repoNotes.keys(), ...Object.keys(state)])) {
    if (!isSafeNoteName(file)) continue
    const text = await readIfExists($, `${ctx.memoryDir}/${file}`)
    if (text !== undefined) local.set(file, text)
  }

  const plan = planInbound(repoNotes, local, state)
  const written: string[] = []
  const deleted: string[] = []
  const held: { file: string; reason: string }[] = []

  for (const action of plan.actions) {
    if (!isSafeNoteName(action.file)) continue
    if (action.kind === 'write') {
      await $.fs.write(`${ctx.memoryDir}/${action.file}`, action.text)
      local.set(action.file, action.text)
      written.push(action.file)
    } else if (action.kind === 'delete') {
      const failed = await removeNote($, ctx.memoryDir, action.file)
      if (failed === null) {
        local.delete(action.file)
        deleted.push(action.file)
      } else {
        held.push({ file: action.file, reason: `could not delete: ${failed}` })
      }
    } else {
      held.push({ file: action.file, reason: action.reason })
    }
  }

  await $.store.set(ctx.stateKey, plan.state)
  const teamNotes = await refreshIndex($, ctx.memoryDir, local)
  return { status: 'synced', memoryDir: ctx.memoryDir, written, deleted, held, teamNotes }
}

/**
 * Rewrites marginalia's block in MEMORY.md: one line per note marginalia synced (team notes and
 * personal notes) that is present locally, skipping notes Claude already lists itself outside
 * the block. Returns the count of synced notes present locally.
 */
export async function refreshIndex(
  $: EngineInterface,
  memoryDir: string,
  local?: ReadonlyMap<string, string>,
): Promise<number> {
  const team = ((await $.store.get(`sync:${memoryDir}`)) as SyncState | undefined) ?? {}
  const personal = ((await $.store.get(`personal:${memoryDir}`)) as SyncState | undefined) ?? {}
  const teamNotes: Note[] = []
  for (const file of new Set([...Object.keys(team), ...Object.keys(personal)])) {
    const text = local?.get(file) ?? (await readIfExists($, `${memoryDir}/${file}`))
    if (text !== undefined) teamNotes.push(parseNote(file, text))
  }
  const indexPath = `${memoryDir}/MEMORY.md`
  const before = (await readIfExists($, indexPath)) ?? ''
  const after = applyBlock(before, renderBlock(notListedOutsideBlock(teamNotes, before)))
  if (after !== before) await $.fs.write(indexPath, after)
  return teamNotes.length
}

import type { Register } from 'claude-code'
import { command, inbound, outbound, refresh } from './actions'
import { COMMAND, type Config } from './commands'
import { indexAsLoaded } from './core'
import type { ShareMode } from './outbound'
import { renderPane } from './pane'
import type { InboundSummary } from './sync'

// The sync started at session start. Claude Code may read MEMORY.md for the first prompt's
// context before that sync finishes, so the context hook waits for it and puts the fresh
// MEMORY.md into the instruction files the context is rendered from.
let inflight: Promise<InboundSummary> | undefined

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const register: Register = (on, options) => {
  const mode = (value: unknown, fallback: ShareMode): ShareMode => (value === 'auto' || value === 'confirm' ? value : fallback)
  const privacyCheck = options.privacyCheck !== false && options.privacyCheck !== 'false'
  const cfg: Config = {
    teamShare: mode(options.teamShare, 'confirm'),
    privacyCheck,
    personal: {
      store: typeof options.personalStore === 'string' ? options.personalStore : '',
      mode: mode(options.personalSync, 'auto'),
      privacyCheck,
    },
  }

  on('ui.render', { component: 'Pane', requestId: 'marginalia' }, async ($, e) => renderPane($, e, cfg))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    inflight = inbound($, cfg)
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Share Claude Code memory with your team and your other machines',
        argumentHint: '[approve|reject|share|unshare <file>] [sync|lint|compact|pane|init]',
      })
    } catch (err) {
      $.ui.toast(`could not register /${COMMAND}: ${message(err)}`)
    }
    const summary = await inflight
    await outbound($, cfg)
    await refresh($, cfg, { held: summary.held })
    return result
  })

  // Fires once per conversation (also after /clear, which has no session.start).
  on('prompt.context', async ($, e, next) => {
    const started = inflight
    const { memoryDir } = started ? await started : await inbound($, cfg)
    inflight = undefined
    const result = await next(e)
    if (!memoryDir) return result

    const files = result.instructionFiles ?? e.instructionFiles
    if (files === undefined) return result // a hook above rewrote the text: leave it alone

    const path = `${memoryDir}/MEMORY.md`
    if (!(await $.fs.exists(path))) return result
    const raw = await $.fs.read(path)
    if (typeof raw !== 'string') return result
    const content = indexAsLoaded(raw)

    const at = files.findIndex(f => f.path === path)
    if (at !== -1 && files[at]?.content === content) return result
    const updated =
      at === -1
        ? [...files, { path, kind: 'memory' as const, content }]
        : files.map((f, i) => (i === at ? { ...f, content } : f))
    return { ...result, instructionFiles: updated }
  })

  // After each turn of the main conversation: what Claude wrote becomes proposals, or is shared.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await outbound($, cfg)
      await refresh($, cfg)
    }
    return result
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== COMMAND) return next(e)
    return { text: await command($, cfg, e.args) }
  }).catch(($, e, next) => (next.called ? next(e) : { text: `/${COMMAND} failed.` }))
}

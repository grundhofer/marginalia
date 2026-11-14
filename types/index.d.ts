// marginalia's $.state contract: the snapshot the pane draws from.

export type PaneRow = {
  target: 'team' | 'personal'
  kind: 'add' | 'update' | 'remove'
  file: string
  why?: string
  /** Privacy-check hits, as "kind (line n)". */
  findings: string[]
}

export type PaneData = {
  /** Where team sharing stands here: on, or why it is off. */
  team: string
  /** Where personal sync stands: the store folder and mode, or why it is off. */
  personal: string
  cost: { lines: number; bytes: number; tokens: number; maxLines: number; maxBytes: number; used: number } | null
  waiting: PaneRow[]
  held: { file: string; reason: string }[]
  lintIssues: number
  /** The answer to the last action taken in the pane. */
  last: string
}

declare module 'claude-code' {
  interface PluginState {
    marginalia: { pane: Shaped<PaneData | null> }
  }
}

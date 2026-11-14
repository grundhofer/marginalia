// The review pane: what waits to be shared, what is held, and what the memory index costs.

import { atom, read } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'
import { paneAct, refresh, syncFromPane } from './actions'
import { COMMAND, type Config } from './commands'

// The same value snapshot.ts writes. The engine's scan wants each file's state reference
// spelled in that file, so it is declared here again; keep the tag in step with snapshot.ts.
const pane = atom({ plugin: 'marginalia', key: 'pane' } as const, null, { shape: 'pane-1' })

// The buttons' handlers. The plugin directory reads `$` only when it is passed whole to a
// function declared at the top level of the same file, so each button calls one of these.
async function pressRefresh($: EngineInterface, cfg: Config): Promise<void> {
  await refresh($, cfg)
}

async function pressCommand($: EngineInterface, cfg: Config, args: string): Promise<void> {
  await paneAct($, cfg, args)
}

async function pressSync($: EngineInterface, cfg: Config): Promise<void> {
  await syncFromPane($, cfg)
}

/** Draws the pane. register.ts hooks `ui.render` and calls this, so this file declares no hook. */
export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>, cfg: Config) {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const data = await read($, pane)
    if (!data) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Reading memory…</Text>
          <Button key="refresh" label="Refresh" onPress={() => pressRefresh($, cfg)} />
        </Box>
      )
    }
    const kb = (n: number) => `${(n / 1024).toFixed(1)}`
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Team sharing </Text>
          {data.team}
        </Text>
        <Text>
          <Text bold>Personal sync </Text>
          {data.personal}
        </Text>

        {data.cost && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>MEMORY.md </Text>≈ {data.cost.tokens} tokens · {data.cost.lines}/{data.cost.maxLines} lines ·{' '}
              {kb(data.cost.bytes)}/{kb(data.cost.maxBytes)} KB
            </Text>
            <Progress label="Load limit" value={Math.min(1, data.cost.used)} valueText={`${Math.round(data.cost.used * 100)}%`} />
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Waiting ({data.waiting.length})</Text>
          {data.waiting.length === 0 && <Text dimColor>Nothing waits to be shared.</Text>}
          {data.waiting.map(row => {
            const id = `${row.target}:${row.file}`
            const blocked = row.target === 'team' && row.findings.length > 0
            return (
              <Box flexDirection="column">
                <Text>
                  {row.target}: {row.kind === 'remove' ? `remove (${row.why})` : row.kind} {row.file}
                </Text>
                {row.findings.length > 0 && <Text color="warning">  privacy check: {row.findings.join(', ')}</Text>}
                <Box flexDirection="row" gap={1}>
                  {blocked ? (
                    <Button key={`force:${id}`} label="Share anyway" onPress={() => pressCommand($, cfg, `approve ${row.file} --force`)} />
                  ) : (
                    <Button key={`approve:${id}`} label="Approve" variant="primary" onPress={() => pressCommand($, cfg, `approve ${row.file}`)} />
                  )}
                  <Button key={`reject:${id}`} label="Keep local" onPress={() => pressCommand($, cfg, `reject ${row.file}`)} />
                </Box>
              </Box>
            )
          })}
        </Box>

        {data.held.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Held ({data.held.length})</Text>
            {data.held.map(h => (
              <Text>
                {h.file} <Text dimColor>— {h.reason}</Text>
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {data.lintIssues === 0 ? 'Lint: no issues.' : `Lint: ${data.lintIssues} issue(s), see /${COMMAND} lint`}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="sync" label="Sync now" onPress={() => pressSync($, cfg)} />
            <Button key="refresh" label="Refresh" onPress={() => pressRefresh($, cfg)} />
          </Box>
          {data.last !== '' && <Text dimColor>{data.last}</Text>}
        </Box>
      </Box>
    )
}

# Marginalia: plan

Status: draft v2, 2026-11-14. M1–M4 are built and tested. M1–M3 are verified in real headless sessions and M4 in a real interactive one. Owner decisions are marked **(decided)**;
everything else is a proposal.

## 1. Goal (decided, re-scoped 2026-11-14)

Share **Claude Code's built-in auto memory** with the teammates who work on the same repository.

The owner noticed that the auto memory is good, but it lives only on one machine, so
colleagues on the same repo don't have it. Marginalia does not invent a new memory system:

- Claude keeps writing memory exactly as it does today.
- Marginalia decides which notes are team knowledge and puts them into the repo, where git
  versions them.
- It brings teammates' notes back into each person's local memory.

## 2. How the built-in memory works (docs, checked 2026-11-14)

Source: https://code.claude.com/docs/en/memory

- The folder is `~/.claude/projects/<project>/memory/`. `<project>` is derived from the git
  repository, so all worktrees and subfolders of one repo share one folder.
- The memory is machine-local: "not shared across machines or cloud environments".
- `MEMORY.md` is the index. Only its first 200 lines or 25 KB load at session start.
- Topic files are read on demand.
- Topic files are plain markdown. Frontmatter `type` is `user | feedback | project | reference`.
  Claude Code adds a `modified` timestamp.
- `autoMemoryDirectory` can be set in any settings file (project files under workspace trust),
  but only as an absolute or `~/` path. A checked-in setting therefore cannot point to the repo
  portably, and pointing it into the repo would commit personal notes too.

## 3. Design

```
~/.claude/projects/<repo>/memory/      <-- Claude reads and writes here, as today
        |  (sync: project/reference notes)
<repo>/.claude/memory/*.md             <-- committed team notes, reviewed in PRs
```

- **Outbound.** After Claude writes, edits or deletes a note in the local memory folder, a
  `tool.call` hook on `Write`/`Edit` decides whether the note is team knowledge:
  - By default, `project` and `reference` notes are team knowledge, and `user` and
    `feedback` notes stay private.
  - A per-note override in frontmatter takes precedence: `metadata.share: team | private`.
  - Team notes are mirrored to `<repo>/.claude/memory/`, where they show up as uncommitted
    changes. Marginalia never commits; the human commits like any other change.
- **Inbound.** At `session.start`, notes in `<repo>/.claude/memory/` that are newer or missing
  locally are copied into the local memory folder. Notes a teammate deleted are removed
  locally. Local notes that were never shared are never touched.
- **Index.** Marginalia owns one marked block in the local `MEMORY.md` with one line per team
  note. The markers are HTML comments, which Claude Code strips, so they cost no tokens.
  Claude's own lines outside the block stay as they are. The repo holds no `MEMORY.md`, so
  there is no merge conflict over the index.
- **Conflicts.** One fact is one file, so two people rarely touch the same file. If they do,
  it is a normal git merge on a small markdown file. When the local copy and the repo copy
  both changed since the last sync, marginalia does not overwrite either one. It flags the
  note in the pane.
- **Budget (decided: keep memory small).** Team notes add up with every colleague. Marginalia
  therefore shows what the shared block costs in tokens and warns before the index nears
  the 200-line / 25 KB load limit. `/memory compact` suggests merges and never deletes on its
  own.
- **Privacy (decided).** Before a note is mirrored into the repo, it is scanned for personal
  data: local paths with a user name, e-mail addresses, account and session IDs, keys and
  tokens. A hit keeps the note local and shows why. In public repos, marginalia is off until
  it is switched on. Once on, the scan is on by default and can be turned off.
- **Onboarding.** Committing `extraKnownMarketplaces` and `enabledPlugins` to the repo's
  `.claude/settings.json` would prompt teammates to install marginalia when they open the
  repo. To verify. Teammates without the plugin can still read the notes in
  `.claude/memory/`.

## 3a. Personal sync (decided: part of v1)

```
~/.claude/projects/<repo>/memory/          <-- local, as today
        |  (sync: user/feedback/private notes)
<personal store>/<host>/<owner>/<repo>/    <-- the owner's private git repo, any machine
```

- The personal store is a private git repo whose URL is set in `userConfig`. Marginalia keeps
  a clone under `~/.claude/marginalia/personal/`.
- Each project is a folder keyed by its normalised git remote, for example
  `github.com/acme/webapp`. The same project matches on every machine, whatever
  its local path.
- Memory folders that are not inside a repo (for example a session started in
  `~/Projects`) use a folder named in config.
- At `session.start`, marginalia pulls and imports the notes. After a private note is
  written, it is copied into the store, committed and pushed (default `auto`; `confirm`
  holds it in the pane).
- The store is private, but the privacy scan still runs before a note leaves the machine.
  Its hits are shown as warnings and do not hold the note back.

## 4. Surfaces

- A pane listing the team notes:
  - incoming notes (new from teammates)
  - outgoing notes (waiting for a commit)
  - held notes (privacy hit or conflict)
  - the token cost of the shared block
- Commands:
  - `/memory status`
  - `/memory share <note>` and `/memory unshare <note>`
  - `/memory sync` (manual sync)
  - `/memory lint` (stale links, duplicates, missing `type`)
  - `/memory compact`

## 5. Decisions of 2026-11-14 and open questions

Decided:
1. The split by `type`: `project` and `reference` go to the team, and `user` and `feedback`
   stay private. A per-note override is possible.
2. **Personal sync is part of v1.** Private notes (`user`, `feedback`, and anything marked
   `private`) sync across the owner's own machines. Project knowledge goes with the project,
   and private notes stay private, but they still travel. See section 3a.
3. Sharing team notes is configurable as `confirm | auto`. **The default is `confirm`:**
   outgoing notes wait in the pane until a human approves each one. `auto` mirrors them
   straight into `.claude/memory/` as uncommitted changes.

4. The personal store is a private repo, for example `<you>/claude-memory`, set per
   user through `userConfig`.
5. The personal store commits and pushes on its own, configurable as `confirm | auto`. The
   default is `auto`, because the owner wants it to commit and push without asking.

Open:
1. The copyright line: handle only? `GPL-3.0-only` or `-or-later`?

## 6. Milestones

1. M0: this plan, then the owner's go.
2. M1, inbound: copy repo notes into the local memory folder and maintain the `MEMORY.md`
   block, with tests. **Built 2026-11-14** (`hooks/core.ts`, `hooks/inbound.ts`,
   `hooks/register.ts`; 35 tests pass under `claude plugin test`). Verified on 2026-11-14 in
   real `claude -p --plugin-dir` sessions on a throwaway repo:
   - the first session sees the team notes
   - a teammate's edit replaces the local copy
   - a teammate's deletion removes it
   - a private local note stays untouched
   - the HTML markers do not reach the model

   Notes from building it:
   - Claude Code read `MEMORY.md` for the first context before the `session.start` sync
     finished; the first real run proved it, because the model did not see the notes. The
     fix: the `prompt.context` hook waits for the sync and puts the fresh `MEMORY.md`
     (comments stripped, cut to 200 lines / 25 KB) into `instructionFiles`, from which the
     engine renders the `claudeMd` block. After `/clear` the hook syncs again.
   - Public check (GitHub only): an unauthenticated `api.github.com/repos/<owner>/<repo>`
     read answers 200 for public and 404 for private. The answer is cached for 7 days. Other
     hosts count as private for now. An unknown answer skips the sync and says so.
   - The local memory path is computed: `<config>/projects/<root with every non
     [A-Za-z0-9-] char as "-">/memory`, matching the folders on this machine. It honours
     `autoMemoryDirectory`, `CLAUDE_CODE_PROJECT_DIR_NAME` and both auto-memory off
     switches. Not modelled: the shortening of very long paths. Not verified: which root a
     worktree's memory uses.
   - The fs API cannot delete, so a note removed by a teammate is deleted with `rm -f --`,
     limited to plain note file names inside the memory folder.
3. M2, outbound: mirror team notes on write, edit and delete, including the privacy scan.
   **Built 2026-11-14** (`hooks/outbound.ts`, `hooks/commands.ts`, `hooks/context.ts`; 52
   tests). Verified in real `claude -p --plugin-dir` sessions:
   - `/marginalia init`
   - Claude saves a project note and a feedback note; only the project note is proposed
   - `/marginalia approve all` writes it uncommitted to `.claude/memory/`
   - a colleague's fresh clone sees the note in its first session, but not the feedback note

   How it works:
   - The repo is switched on by committing `.claude/memory/` (`/marginalia init`).
   - After each main-conversation turn and at session start, the local folder is compared
     with the repo and the sync state.
   - `confirm` (default): proposals wait for `/marginalia approve <file|all>` or
     `reject` (asked again only after the note changes). `auto`: clean proposals are written
     at once; privacy hits still wait.
   - Removal is proposed when a shared note is deleted locally or re-marked private.
   - Notes are shared without Claude Code's per-session stamps (`originSessionId`,
     `modified`), and sync decisions compare notes without them. Found in the real run:
     Claude Code writes a session id into every note.
   - Privacy check (on by default, `privacyCheck: false` turns it off): local paths with a
     user name, e-mail addresses, private keys, AWS/GitHub/Slack/API/Google keys, JWTs,
     password or secret assignments, invisible or bidi characters. It reports the kind and
     line, never the value. `--force` overrides.
   - The MEMORY.md block skips notes Claude already lists itself, so no line appears twice.
4. M3: personal sync through the private store. **Built 2026-11-14** (`hooks/personal.ts`;
   61 tests). Verified in real sessions with a local bare repo as the store and two checkouts
   of one project under different paths:
   - machine A: Claude saves a feedback note; it is committed and pushed to the store under
     `github.com/acme/demo-e2e/`
   - machine B, with its clone deleted first: the store is cloned fresh, the note is imported,
     and the model knows it in the first session

   How it works:
   - `userConfig.personalStore` is the store's git URL; empty switches personal sync off.
     `personalSync` is `auto` (default: commit and push after each turn) or `confirm`.
   - The clone lives at `<config>/marginalia/personal`. Before any write, marginalia checks
     that the clone's `origin` matches the configured URL; a mismatch stops the sync with a
     message, so notes never land in the wrong repo.
   - Key: the normalised remote (`host/owner/repo`), or `home/<path>` for a folder outside a
     repo.
   - Next to a team-synced repo the store holds only private notes. Elsewhere it holds all
     notes of the project, so solo projects follow the person too.
   - A note that moves to the team scope leaves the store.
   - Git operations are serialised in one queue. A failed push is retried once after a
     pull, then reported. Privacy hits are warnings only, because the store is private.
   - Commits in the store use the person's global git identity.

   Still open, moved to M4: the conflict view, `share`, `unshare` and `sync` (status,
   approve and reject exist since M2).
5. M4: the pane (with the conflict view), `share`, `unshare`, `sync`, `lint` and `compact`.
   **Built 2026-11-14** (`hooks/pane.tsx`, `hooks/snapshot.ts`, `hooks/actions.ts`,
   `hooks/sync.ts`, `types/index.d.ts`; 71 tests, the pane on all four surfaces including a
   press on Approve). **Verified in a real interactive terminal session** (driven through a
   pseudo-terminal): `/marginalia pane` draws the status, the MEMORY.md cost with its
   load-limit bar, the waiting note with `[Approve]` `[Keep local]`, lint, and
   `[Sync now]` `[Refresh]`. The "wait for approval" toast showed up too.
   - Pane: team and personal status; MEMORY.md tokens (about 4 characters per token), lines,
     KB and load-limit bar; waiting rows with Approve / Keep local, or "Share anyway" for a
     team note with a privacy hit; held notes with reasons; lint count; Sync now / Refresh;
     the last action's answer. It is drawn from a `$.state` snapshot rebuilt after every
     sync, turn and command.
   - `share` / `unshare <file>` set `share: team|private` in the note's frontmatter.
   - `sync` runs both directions now.
   - `lint` reports: missing type or description, index links to missing files, notes not
     in MEMORY.md (Claude does not see them), duplicate names, `[[links]]` to unknown
     names, and an index near or over the load limit.
   - `compact` suggests merging same-type notes whose name and description overlap, and
     shortening long notes. It never changes anything.
   - Found in the real session: Claude Code puts the plugin name in front of a toast and of
     a command's answer by itself, so marginalia's own prefix was removed.
   - Engine rules learned: `$` may only be passed to functions declared at a file's top
     level (or imported), and each file must spell its own `$.state` reference. That is why
     the code was split into `actions.ts`, `snapshot.ts` and `pane.tsx` (later merged into `register.tsx`, see M6).
6. M5: try it with a teammate on a real repo, and verify onboarding through project
   settings. **Started 2026-11-14:**
   - Installed for the owner at user scope, read straight from this folder.
   - Personal store: a private repo of the owner's.
   - The first real session in `~/Projects` pushed all 36 notes to `home/Projects/`, with
     the stamps stripped.
   - The local MEMORY.md stayed unchanged, because Claude already lists every note.
7. M6: Directory submission. Before that: check that the name `marginalia` is free in the
   portal, add a square PNG icon (the portal takes it only once; made with the sebaro
   blueprint and design system, owner 2026-11-14), and add the install line to the README.
   **Icon done 2026-11-14:**
   - The owner picked sign C (three lines and a bracket in the margin) on the `collaboration`
     tile (petrol), from three drafts rendered with the kit.
   - Declared in `sebaro.product.json` and drawn by the kit (product_kit 1.3.0, sebaro-blueprint
     3c0d6f5). `web/icon-512.png` became `.claude-plugin/icon.png`.
   - The sign and icon are all rights reserved (NOTICE.md), as the kit requires.
   - Not checked: the sign's distance to other sebaro signs (D33) and the screen against
     known symbols. Both need the workshop's `signs.py check`.
   - The install line is in the README.
   **Directory checks (2026-11-14, portal validate):**
   - The directory applies the documented mod rule that `$` may only go to functions declared
     at the top level of the same file (not to imported ones; `read`/`update` excepted), and
     that no name in a `.tsx` file may be `h` or `Fragment`. So every function using `$` now
     lives in `hooks/register.tsx`, and `hooks/core.ts` keeps the logic without `$`. The local
     `claude plugin validate` of this build did not enforce this.
   - Literal invisible characters in a regex were replaced with `\u` escapes.
   - README section "What marginalia reads, writes, runs and sends" answers the policy holds.
   - The name is not taken, but it is held for review next to the connector "marginal-ai".
   - The portal says that mods will later be accepted only from Verified organizations; a
     version live by then stays live, and other versions with a mod can be refused.

## 7. Competitors (scan of 2026-11-14, READMEs and docs only)

- **oraios/serena** (31k stars) keeps memories in the repo (`.serena/memories/`, meant to be
  committed). That is Serena's own memory system inside a large MCP toolkit, not Claude
  Code's auto memory.
- **zircote/mnemonic** keys a store by the git remote, but keeps it local and never shares it.
  It is its own format with automatic capture.
- **claude-mem** (117k stars) captures automatically into SQLite and sells cloud team sync.
  It is the opposite of a small budget.
- **Claude Code itself:** subagents already have `memory: project` (`.claude/agent-memory/`,
  committed) and a local scope. If the main session's auto memory gets the same, marginalia's
  sync becomes partly redundant. Nothing is announced.

**Positioning:**
- Marginalia is the small tool that shares the memory Claude Code already writes, through
  git, with privacy checks and a visible token cost.
- It adds no new memory system, no database and no extra context beyond the built-in index.

Worth borrowing:
- From Serena: `mem:` cross-links and read-only patterns.
- From alexanderop/claude-code-memory: injection and invisible-Unicode checks next to the
  privacy scan.

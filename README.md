# Marginalia

> **Status: early.** It works and is tested, but it is young. Expect rough edges and keep your
> memory folder under version control. See [PLAN.md](PLAN.md) for the design and what is
> verified.

Marginalia shares Claude Code's auto memory with your team through git, and syncs your own
notes across your machines.

Claude Code already learns as it works: it writes short notes about your project into its
auto memory. Those notes stay on one machine, so a colleague working on the same repository
starts from zero, and so does your second computer. Marginalia copies the notes that are team
knowledge into the repository, next to the code, where git versions them and pull requests
review them. When your colleagues pull, their Claude knows what yours learned. Notes about you
travel through a private git repository of your own.

Medieval readers wrote marginalia, notes in the margins, so the next reader would know what
they had learned.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install marginalia --marketplace grundhofer/marginalia
```

From a shell:

```
claude plugin install marginalia --marketplace grundhofer/marginalia
```

## Set up

**Team sharing** is per repository. In the repository, run `/marginalia init` and commit the
`.claude/memory/README.md` it creates. Marginalia stays off in repositories without that
folder, and in public GitHub repositories.

**Personal sync** needs a private, empty git repository of your own (for example
`you/claude-memory`). Set it once:

```
echo '{"personalStore":"git@github.com:you/claude-memory.git"}' | claude plugin configure marginalia@marginalia --values-stdin
```

Options (`/plugin configure marginalia@marginalia`):

| Option | Default | What it does |
|---|---|---|
| `teamShare` | `confirm` | `confirm`: new or changed team notes wait for `/marginalia approve`. `auto`: they are written to `.claude/memory/` at once. Either way you commit them. |
| `personalStore` | empty | Git URL of your private store. Empty switches personal sync off. |
| `personalSync` | `auto` | `auto`: your notes are committed and pushed after each turn. `confirm`: they wait for approval. |
| `privacyCheck` | on | Scans a note for local paths with a user name, e-mail addresses, keys and tokens before it is shared. A hit holds a team note; for your private store it only warns. |

## How it decides

- Notes of type `project` and `reference` are team knowledge. Notes of type `user` and
  `feedback` stay with you. Override one note with `/marginalia share <file>` or
  `/marginalia unshare <file>` (this sets `share: team` or `share: private` in its
  frontmatter).
- In a project without team sharing, your private store keeps all of its notes, so solo
  projects follow you too.
- Marginalia never commits in your project. It only writes files there for you to review and
  commit.
- It never overwrites a note that changed on both sides. Such a note is held and shown in the
  pane.
- Claude Code's per-session stamps (`originSessionId`, `modified`) are stripped before a note
  is shared.

## What marginalia reads, writes, runs and sends

Marginalia is a memory tool, so it touches files that Claude reads as instructions. This is everything it
does outside its own settings.

**Reads.** The notes in Claude Code's auto-memory folder for the current project
(`~/.claude/projects/<project>/memory/`, or `autoMemoryDirectory`), the notes in `<repo>/.claude/memory/`, and
the notes in the clone of your personal store. It reads the repository's root and `origin` remote, the
`autoMemoryEnabled` and `autoMemoryDirectory` settings, and the variables `HOME`, `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_PROJECT_DIR_NAME` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. It does not read your conversation.

**Writes.** Only these files:

- notes (`*.md`) and its own block in `MEMORY.md` in the auto-memory folder. Claude reads these as memory at
  the start of a session, which is the point of the plugin. `/marginalia share` and `unshare` change one
  line (`share:`) in a note's frontmatter;
- team notes in `<repo>/.claude/memory/`, and `.claude/memory/README.md` on `/marginalia init`. They are
  left uncommitted for you to review;
- your notes in the clone of your personal store, `<config>/marginalia/personal/`.

It never writes code, build files, settings or `CLAUDE.md`.

**Runs.** Two programs, with fixed arguments:

- `rm -f -- <memory folder>/<note>.md` to remove a note that a teammate deleted or that you approved removing.
  It deletes only plain note file names inside a memory folder;
- `git` in the personal store's clone, and only when `personalStore` is set: `clone`, `pull --rebase
  --autostash`, `remote get-url origin`, `add -A -- <project folder>`, `diff --cached --quiet`, `commit` and
  `push`. Git uses the credentials you already have for that remote (an SSH key or a credential helper);
  marginalia never reads them.

**Sends.**

- an unauthenticated `GET https://api.github.com/repos/<owner>/<repo>`, only in a repository that has
  `.claude/memory/`, to learn whether the repository is public (marginalia stays off in public repositories).
  The answer is kept for a week; while GitHub cannot be reached, it asks again at each session start. Nothing
  is sent but that address;
- your notes to your own personal store, through `git push`, when `personalStore` is set.

**Hooks.**

- `session.start` syncs both ways and registers `/marginalia`;
- `prompt.context` replaces one entry of the first prompt's instruction files, the one for `MEMORY.md`, with
  the file as it is after the sync (Claude Code reads it before the sync finishes). It changes nothing else;
- `turn.complete` (main conversation only) checks what Claude wrote and proposes or shares it;
- `command.run` answers `/marginalia` and passes every other command on unchanged;
- `ui.render` draws its own pane.

## Commands

| Command | |
|---|---|
| `/marginalia` | What waits to be shared |
| `/marginalia approve <file\|all>` | Share it (`--force` shares a team note despite a privacy hit) |
| `/marginalia reject <file\|all>` | Keep it local; asked again only if it changes |
| `/marginalia share <file>` / `unshare <file>` | Mark a note for the team, or private |
| `/marginalia sync` | Sync both ways now |
| `/marginalia lint` | Check the memory folder (missing types, notes Claude cannot see, broken links, index size) |
| `/marginalia compact` | Suggest merges and shortenings; changes nothing |
| `/marginalia pane` | Open the review pane: what waits, what is held, what MEMORY.md costs in tokens |
| `/marginalia init` | Switch team sharing on for this repository |

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The icon is drawn by the product kit of the [sebaro](https://github.com/grundhofer/sebaro-blueprint) design
system from `sebaro.product.json`. To redraw it, with a sebaro copy (`update-copy.mjs --profile website`) and a
folder that holds Playwright:

```
SEBARO_PLAYWRIGHT=<folder with playwright> python3 <copy>/product/product_kit.py build sebaro.product.json --copy <copy> --out <folder outside the repo> --render
cp <folder outside the repo>/web/icon-512.png .claude-plugin/icon.png
```

## Licence

[GPL-3.0](LICENSE), except the sign and icon: see [NOTICE.md](NOTICE.md).

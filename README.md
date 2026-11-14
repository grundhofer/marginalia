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

## Licence

[GPL-3.0](LICENSE)

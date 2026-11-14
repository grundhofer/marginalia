# Privacy

Marginalia runs on your machine, inside Claude Code. Its author runs no server and receives nothing from it:
no telemetry, no analytics, no accounts.

What it does with data, in short (the full list is in the README, "What marginalia reads, writes, runs and
sends"):

- It copies Claude Code's memory notes between your local memory folder, the repository you work in
  (`.claude/memory/`, left uncommitted for you to review) and, if you set one, a private git repository of
  your own. Memory notes can contain personal data, for example your name or your preferences. A privacy
  check looks for local paths with a user name, e-mail addresses, keys and tokens before a note is shared,
  and holds a team note that has a hit.
- It asks `api.github.com` whether a repository is public, by the repository's address only.
- It pushes your notes to the git remote you configured, with the git credentials you already use.

Where your notes go is decided by you: your repository and your private store, under the terms of the hosts
you chose (for example GitHub). Marginalia keeps nothing elsewhere.

Questions: <https://github.com/grundhofer/marginalia/issues>

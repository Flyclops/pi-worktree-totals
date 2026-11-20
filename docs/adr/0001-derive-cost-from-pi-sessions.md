# Derive Worktree Cost from pi's session files, not our own ledger

Worktree Cost is recomputed from the session files pi already writes. Those
files hold per-entry billed cost. We do not keep a separate ledger of our own.
This gives us past sessions for free, stores no duplicate data, needs no
locking between concurrent pi processes, and always agrees with pi's own
numbers. Any cache we add later is disposable, lives under
`$XDG_STATE_HOME/pi-worktree-totals/`, and is never inside the Worktree.

## Consequences

- Deleting a Session file removes its spend from Worktree Cost. That is
  intended: the session files are the source of truth.
- Forks and clones copy entries into new files, so counting must skip
  Inherited Entries or the cost is counted twice.
- Sessions pi never wrote to disk (`--no-session`, in-memory subagent runs)
  are not counted, apart from the live current Session.

# Changelog

## [0.1.0] - 2026-11-17

- Footer status with Worktree Totals (`wt: ↑in ↓out $cost`) across every pi
  session in the current git worktree, refreshed after each turn.
- `/worktree-totals` report: totals, per-model and per-session breakdown,
  saved in the session as a snapshot that is never sent to the model.
- Fork/clone history counted once; linked worktrees recreated at the same
  path start from zero; `--no-session` sessions included.

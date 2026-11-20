# 06: /worktree-totals command

Status: resolved
Blocked by: 05

Register `/worktree-totals`. Print the Worktree root, the Worktree Totals, one
line per Session (name or first prompt, date, cost; newest first), and totals
per model with tokens and cost (spec Q23–Q26). The token totals and the footer
token display (Q24, Q28) also land in this issue.

## Acceptance

- Formatting unit-tested on core output; command checked manually.

## Comments

- Code done. `/worktree-totals` refreshes, then
  `pi.appendEntry("worktree-totals-report", snapshot)`; an entry renderer
  formats the snapshot with the current theme (`src/format.ts`:
  `toSnapshot`, `formatReport`). Snapshots are plain JSON with a `version`;
  sessions are capped at 20 and warnings at 10, so entries stay small.
- Tokens throughout (Q23–Q28), R/W hidden for now (Q32), `wt:` prefix.
- Skill-started session labels show as `/skill:name [args]` (Q31).
- Verified via RPC: the command is handled and the entry is appended.
  **Needs a human look in the interactive TUI** (how the rendered card
  looks; whether it reappears on resume).
- Found and fixed a bug from issue 05: with `--no-session`, pi reports
  `getSessionDir() === ""`, which we treated as a flat folder at the cwd,
  so saved sessions were missed. It now uses the default layout.
- Renamed to `/worktree-totals` (user, UX), and the entry type to
  `worktree-totals-report`. Earlier test snapshots no longer render; that's
  accepted.
- Q35 (trial): session lines show tokens then cost, column-aligned;
  per-session tokens are counted in `aggregate`.
- Reviewed in the TUI by the user; approved.

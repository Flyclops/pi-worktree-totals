# 01: Package scaffold

Status: resolved
Blocked by: none

Create the pi package: `package.json` with a `pi` key pointing at the extension
entry, TypeScript config, Vitest, and an extension entry that loads and does
nothing yet. Follow `docs/packages.md` and `docs/extensions.md` in the pi
install.

## Acceptance

- `pi install ./` loads the extension without errors.
- `npm test` runs (no tests yet is fine).

## Comments

- Verified loading with `pi -e . --list-models` (clean). An extension that
  throws on load does produce a "Failed to load extension" error that way.
  Skipped `pi install ./` because it writes to the global
  `~/.pi/agent/settings.json`.
- Pinned the pi-coding-agent devDependency to 1.5.2 (types only; it's a
  `*` peer at runtime). Using TS ^5 and Vitest ^4, not the newest majors
  (TS 7, Vitest 5).

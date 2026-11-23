# 08: Bound memory when parsing large session files

Status: resolved
Blocked by: none

From the pre-push security review (low severity).

`readSessionFile` (`src/session-file.ts`) reads the whole unread part of a
file into one `Buffer`, decodes it to one string, splits it, and keeps every
parsed entry in an array before folding. Up to 16 files are read at once
(`src/worktree-totals.ts`). On a cold start, several image-heavy sessions of
100 MB or more could briefly use GBs inside pi's process. A file over ~512 MB
fails the decode and silently drops out with a warning.

## Fix

- Read in fixed chunks (4–8 MB), carrying the partial trailing line over to
  the next chunk; `offset` still only advances past complete lines.
- Fold each entry into the state as it's parsed (no `entries` array).
- Optionally lower concurrency for files above a size threshold.
- Truncate `firstPrompt` when stored, not only at display (holds full
  prompts in memory today).
- Dedupe the malformed-line warning by file path, so a growing count doesn't
  notify again each time (the review's info note).

## Acceptance

- A test with a chunk size forced small (e.g. 64 bytes) produces the same
  results as whole-file parsing, including lines that span chunks and
  multi-byte UTF-8 split across a chunk boundary.
- Benchmark: peak RSS when parsing a synthetic 500 MB session stays bounded,
  with the number noted in Comments.

## Comments

- Done on branch `bounded-parsing`. `readSessionFile` reads 4 MB chunks
  (`CHUNK_BYTES`), carrying a partial line over to the next chunk. Text is
  decoded only up to a newline byte, so split UTF-8 sequences are safe.
  Each line is folded into a mutable accumulator as it's parsed (no entry
  list), and a new `ParseState` is built once at the end, so cached state
  is never mutated.
- First prompts and session names are stored shortened (60 chars).
- The malformed-line warning has no count, so it notifies once per file.
- Tests: chunk sizes 1/2/3/7/64/4096 equal one whole read (multi-byte text,
  malformed line, name); half-written last line; resume with tiny chunks;
  stored prompt length; stable warning. Mutation-checked: dropping either
  carry, a wrong offset, or aliasing the reused buffer each fail tests.
- `npm run bench:large` (peak RSS of a fresh process, image-heavy file):

  | File   | Before                   | After           |
  | ------ | ------------------------ | --------------- |
  | 100 MB | 376 MB, 57 ms            | 137 MB, 51 ms   |
  | 500 MB | 1,585 MB, 512 ms         | 207 MB, 232 ms  |
  | 600 MB | fails (string too long)  | 202 MB, 274 ms  |
  | 1.5 GB | fails                    | 214 MB, 787 ms  |

  Cold-start and refresh benchmarks unchanged.
- Copilot (PR #2): a line spanning many chunks was re-copied every chunk
  (quadratic). It now keeps owned pieces, scans only fresh bytes, and joins
  once per line. One-line file, before → after:

  | Line   | Before              | After            |
  | ------ | ------------------- | ---------------- |
  | 50 MB  | 202 ms, 794 MB      | 51 ms, 425 MB    |
  | 100 MB | 880 ms, 2,598 MB    | 94 ms, 637 MB    |
  | 200 MB | 3,004 ms, 8,532 MB  | 189 ms, 1,078 MB |

  (Peak includes the generator's copy and the unavoidable whole-line parse.)
  Test: 1 MB line over 8-byte chunks finishes within 3 s (times out before).

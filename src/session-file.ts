/**
 * Read pi session files (JSONL) and pull out what Worktree Cost needs: the
 * header, a display label, and every billed entry.
 *
 * Billed entries mirror pi's own accounting (`getSessionStats` and
 * `getUsageCostBreakdown` in pi-coding-agent `core/`), so Session Cost here
 * matches pi's footer. Entry formats: pi docs/session-format.md.
 *
 * Parsing is incremental. pi only appends to a session file, except for
 * format migrations, which rewrite the header line. So a ParseState can
 * resume from its byte offset when the header line is unchanged and the file
 * has grown. Only complete, newline-terminated lines are consumed; a line
 * another process is still writing is picked up next time.
 */
import { open } from "node:fs/promises";

export interface SessionHeader {
  id: string;
  /** Session creation time (ms since epoch). */
  startedAt: number;
  /** Working directory the Session was created in. */
  cwd: string;
  /** Set for sessions created by fork/clone. */
  parentSession?: string;
}

/** Token counts, as in pi's usage totals (input excludes cache reads). */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface BilledEntry {
  /** Dedupe key across files: entry `id` + `timestamp` (spec Q8). */
  key: string;
  /** Entry time (ms since epoch). */
  at: number;
  /** Billed cost in USD (`usage.cost.total`). */
  cost: number;
  /** Breakdown key, same as pi's: `provider/model` or "Tools/summaries". */
  model: string;
  tokens: TokenTotals;
}

export interface ParsedSession {
  path: string;
  header: SessionHeader;
  /** Session name if set, else first user prompt, else "(no prompt)". */
  label: string;
  /** Billed entries, excluding Inherited Entries. */
  billed: readonly BilledEntry[];
  /** Lines that weren't valid entries. */
  malformedLines: number;
}

/** Resumable parse of one session file. Treat as immutable. */
export interface ParseState {
  header: SessionHeader;
  /** Exact header line, used to detect in-place rewrites. */
  headerLine: string;
  /** Bytes consumed: always just past a newline. */
  offset: number;
  billed: readonly BilledEntry[];
  malformedLines: number;
  name?: string;
  firstPrompt?: string;
}

export type HeaderRead =
  | { kind: "ok"; header: SessionHeader; line: string; bytes: number }
  | { kind: "incomplete" }
  | { kind: "invalid" };

/** Bucket pi uses for usage not attributed to one model. */
export const TOOLS_BUCKET = "Tools/summaries";

const LABEL_MAX = 60;
const HEADER_CHUNK = 4096;
/** Session headers are tiny; anything bigger isn't a pi session. */
const HEADER_MAX = 64 * 1024;
const NL = 0x0a;

/** Parse a header line. Returns undefined if it isn't a pi session header. */
export function parseHeader(line: string): SessionHeader | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined; // Not a header; callers report the file as invalid.
  }
  return headerFrom(obj);
}

function headerFrom(obj: unknown): SessionHeader | undefined {
  if (!isRecord(obj) || obj.type !== "session") return undefined;
  const { id, timestamp, cwd, parentSession } = obj;
  const startedAt = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  if (typeof cwd !== "string" || Number.isNaN(startedAt)) return undefined;
  return {
    id: typeof id === "string" ? id : "",
    startedAt,
    cwd,
    ...(typeof parentSession === "string" ? { parentSession } : {}),
  };
}

/**
 * Read only the first line of a session file. That's cheap even for
 * multi-MB transcripts, and it's all discovery needs to filter by cwd.
 */
export async function readSessionHeader(path: string): Promise<HeaderRead> {
  const fh = await open(path, "r");
  try {
    return await readHeaderFrom(fh);
  } finally {
    await fh.close();
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

async function readHeaderFrom(fh: FileHandle): Promise<HeaderRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < HEADER_MAX) {
    const buf = Buffer.alloc(HEADER_CHUNK);
    const { bytesRead } = await fh.read(buf, 0, HEADER_CHUNK, total);
    if (bytesRead === 0) return { kind: "incomplete" };
    const nl = buf.subarray(0, bytesRead).indexOf(NL);
    if (nl !== -1) {
      chunks.push(buf.subarray(0, nl));
      const line = Buffer.concat(chunks).toString("utf8");
      const header = parseHeader(line);
      return header
        ? { kind: "ok", header, line, bytes: total + nl + 1 }
        : { kind: "invalid" };
    }
    chunks.push(buf.subarray(0, bytesRead));
    total += bytesRead;
  }
  return { kind: "invalid" };
}

export interface FileRead {
  state: ParseState;
  /** File size and mtime when the read started (content is at least this new). */
  size: number;
  mtimeMs: number;
}

/**
 * Bytes read per chunk. Bounds memory per file to roughly one chunk plus the
 * longest single line, instead of the whole unread region (issue 08).
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Read a session file, resuming from `prev` when the file was only appended
 * to. Returns undefined for files that aren't (yet) valid pi sessions.
 *
 * Reads in `chunkBytes` chunks and folds each line into the totals as it's
 * parsed, so no whole-file buffer, string or entry list is ever held. A
 * partial line at a chunk boundary is kept as pieces and joined once it
 * completes, so even a line spanning many chunks is linear. Text is
 * only decoded up to a newline byte, which never occurs inside a UTF-8
 * sequence, so multi-byte characters split across chunks decode correctly.
 *
 * Cost: O(new bytes) time when resuming, O(file bytes) otherwise; memory
 * O(chunkBytes + longest line).
 */
export async function readSessionFile(
  path: string,
  prev?: ParseState,
  chunkBytes = CHUNK_BYTES,
): Promise<{ read?: FileRead; header: HeaderRead["kind"] }> {
  const fh = await open(path, "r");
  try {
    // Stat first: whatever we read afterwards is at least this new, so a
    // later mtime/size change always triggers another read.
    const st = await fh.stat();
    const head = await readHeaderFrom(fh);
    if (head.kind !== "ok") return { header: head.kind };

    let base = initialState(head.header, head.line, head.bytes);
    if (
      prev &&
      prev.headerLine === head.line &&
      st.size >= prev.offset &&
      (await byteAt(fh, prev.offset - 1)) === NL
    ) {
      base = prev;
    }

    const acc = startAcc(base);
    let pos = base.offset; // next byte to read
    let consumed = base.offset; // just past the last complete line
    // Pieces of the unfinished line so far, each an owned copy (`chunk` is
    // reused). Only fresh bytes are scanned for newlines, and the pieces are
    // joined once when the line completes, so a line spanning many chunks
    // costs O(line length), not O(length²).
    let pending: Buffer[] = [];
    const chunk = Buffer.alloc(Math.max(1, Math.min(chunkBytes, st.size - pos)));
    while (pos < st.size) {
      const want = Math.min(chunk.length, st.size - pos);
      const { bytesRead } = await fh.read(chunk, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const fresh = chunk.subarray(0, bytesRead);
      const nl = fresh.lastIndexOf(NL);
      if (nl === -1) {
        pending.push(Buffer.from(fresh));
        continue;
      }
      const complete = fresh.subarray(0, nl);
      const text = pending.length
        ? Buffer.concat([...pending, complete]).toString("utf8")
        : complete.toString("utf8");
      addLines(acc, text);
      consumed = pos - bytesRead + nl + 1;
      pending = nl + 1 < bytesRead ? [Buffer.from(fresh.subarray(nl + 1))] : [];
    }
    return {
      header: "ok",
      read: {
        state: finish(base, acc, consumed),
        size: st.size,
        mtimeMs: st.mtimeMs,
      },
    };
  } finally {
    await fh.close();
  }
}

async function byteAt(fh: FileHandle, pos: number): Promise<number> {
  if (pos < 0) return -1;
  const b = Buffer.alloc(1);
  const { bytesRead } = await fh.read(b, 0, 1, pos);
  return bytesRead === 1 ? b[0]! : -1;
}

/**
 * Parse complete session JSONL text in one go (the trailing line need not
 * end in a newline). Returns undefined when the header is invalid.
 */
export function parseSessionText(
  path: string,
  text: string,
): ParsedSession | undefined {
  const nl = text.indexOf("\n");
  const headerLine = nl === -1 ? text : text.slice(0, nl);
  const header = parseHeader(headerLine);
  if (!header) return undefined;
  const base = initialState(header, headerLine, 0);
  const acc = startAcc(base);
  if (nl !== -1) addLines(acc, text.slice(nl + 1));
  return toParsedSession(path, finish(base, acc, 0));
}

/**
 * Build a ParsedSession from already-parsed entries, such as pi's in-memory
 * `sessionManager.getEntries()` for the live Session (spec Q19).
 * Returns undefined when the header is invalid.
 */
export function parseSessionEntries(
  path: string,
  header: unknown,
  entries: readonly unknown[],
): ParsedSession | undefined {
  const h = headerFrom(header);
  if (!h) return undefined;
  const base = initialState(h, "", 0);
  const acc = startAcc(base);
  for (const entry of entries) addEntry(acc, entry);
  return toParsedSession(path, finish(base, acc, 0));
}

export function toParsedSession(path: string, s: ParseState): ParsedSession {
  return {
    path,
    header: s.header,
    label: truncate(s.name ?? s.firstPrompt ?? "(no prompt)"),
    billed: s.billed,
    malformedLines: s.malformedLines,
  };
}

function initialState(
  header: SessionHeader,
  headerLine: string,
  offset: number,
): ParseState {
  return { header, headerLine, offset, billed: [], malformedLines: 0 };
}

/**
 * Mutable accumulator for one parse pass. Starts from a ParseState and is
 * folded into a *new* ParseState by finish(), so cached state is never
 * mutated and a failed read can't corrupt it.
 */
interface Acc {
  header: SessionHeader;
  forked: boolean;
  /** Only entries billed in this pass. */
  billed: BilledEntry[];
  malformedLines: number;
  name: string | undefined;
  firstPrompt: string | undefined;
}

function startAcc(s: ParseState): Acc {
  return {
    header: s.header,
    forked: s.header.parentSession !== undefined,
    billed: [],
    malformedLines: s.malformedLines,
    name: s.name,
    firstPrompt: s.firstPrompt,
  };
}

function finish(prev: ParseState, acc: Acc, offset: number): ParseState {
  return {
    ...prev,
    offset,
    billed: acc.billed.length ? prev.billed.concat(acc.billed) : prev.billed,
    malformedLines: acc.malformedLines,
    // Always set: an empty session_info name clears the title in pi, so a
    // cleared name must override an earlier one from `prev`.
    name: acc.name,
    firstPrompt: acc.firstPrompt,
  };
}

/** Parse newline-separated lines, folding each entry in as it's parsed. */
function addLines(acc: Acc, text: string): void {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      acc.malformedLines++; // Reported via ParsedSession.malformedLines.
      continue;
    }
    addEntry(acc, entry);
  }
}

/**
 * Fold one entry into the accumulator. Entries that aren't objects count as
 * malformed.
 *
 * Inherited Entries: fork/clone copies the parent's entries, keeping their
 * original timestamps, into a file whose header is stamped at fork time. So
 * in a session with `parentSession`, entries older than the header are
 * inherited. That holds even when the parent lives outside this Worktree,
 * which the id+timestamp dedupe alone can't catch.
 */
function addEntry(acc: Acc, entry: unknown): void {
  if (!isRecord(entry)) {
    acc.malformedLines++;
    return;
  }

  if (entry.type === "session_info" && typeof entry.name === "string") {
    // Latest name wins; empty clears it. Stored shortened (issue 08).
    acc.name = truncate(entry.name) || undefined;
  }
  if (acc.firstPrompt === undefined) {
    const prompt = userPromptText(entry);
    if (prompt !== undefined) acc.firstPrompt = truncate(prompt);
  }

  const billing = billingOf(entry);
  if (!billing) return;
  const at =
    typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (Number.isNaN(at)) {
    acc.malformedLines++;
    return;
  }
  if (acc.forked && at < acc.header.startedAt) return; // Inherited Entry.
  acc.billed.push({
    key: `${String(entry.id)}|${entry.timestamp as string}`,
    at,
    ...billing,
  });
}

type Billing = { cost: number; model: string; tokens: TokenTotals };

/** Cost, tokens and breakdown key for a billed entry; undefined if not billed. */
function billingOf(entry: Record<string, unknown>): Billing | undefined {
  const { type } = entry;
  if (type === "message" && isRecord(entry.message)) {
    const msg = entry.message;
    if (msg.role === "assistant") {
      const model = msg.responseModel ?? msg.model;
      return withCost(msg.usage, `${String(msg.provider)}/${String(model)}`);
    }
    if (msg.role === "toolResult") return withCost(msg.usage, TOOLS_BUCKET);
    return undefined;
  }
  if (type === "usage") {
    return withCost(
      entry.usage,
      `${String(entry.provider)}/${String(entry.model)}`,
    );
  }
  if (type === "compaction" || type === "branch_summary") {
    return withCost(entry.usage, TOOLS_BUCKET);
  }
  return undefined;
}

function withCost(usage: unknown, model: string): Billing | undefined {
  if (!isRecord(usage) || !isRecord(usage.cost)) return undefined;
  const total = usage.cost.total;
  if (typeof total !== "number" || !Number.isFinite(total)) return undefined;
  return {
    cost: total,
    model,
    tokens: {
      input: num(usage.input),
      output: num(usage.output),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function userPromptText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const { role, content } = entry.message;
  if (role !== "user") return undefined;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((c) => isRecord(c) && c.type === "text")
      .map((c) => String((c as Record<string, unknown>).text))
      .join(" ");
  } else {
    return undefined;
  }
  return promptLabel(text.trim()) || undefined;
}

/**
 * pi's expanded skill-command prompt (same regex as pi-coding-agent
 * `core/agent-session.js`): `<skill name=… location=…>\n…\n</skill>` plus
 * optional `\n\n<user text>`.
 */
const SKILL_BLOCK =
  /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * Display label for a first prompt. A skill invocation shows as the command
 * the user typed (`/skill:name args`), not the expanded skill file.
 */
export function promptLabel(text: string): string {
  const m = SKILL_BLOCK.exec(text);
  if (!m) return text;
  const args = m[4]?.trim();
  return args ? `/skill:${m[1]} ${args}` : `/skill:${m[1]}`;
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1)}…` : flat;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

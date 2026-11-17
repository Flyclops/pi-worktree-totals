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
 * Read a session file, resuming from `prev` when the file was only appended
 * to. Returns undefined for files that aren't (yet) valid pi sessions.
 *
 * Cost: O(new bytes) when resuming, O(file bytes) otherwise.
 */
export async function readSessionFile(
  path: string,
  prev?: ParseState,
): Promise<{ read?: FileRead; header: HeaderRead["kind"] }> {
  const fh = await open(path, "r");
  try {
    // Stat first: whatever we read afterwards is at least this new, so a
    // later mtime/size change always triggers another read.
    const st = await fh.stat();
    const head = await readHeaderFrom(fh);
    if (head.kind !== "ok") return { header: head.kind };

    let state = initialState(head.header, head.line, head.bytes);
    if (
      prev &&
      prev.headerLine === head.line &&
      st.size >= prev.offset &&
      (await byteAt(fh, prev.offset - 1)) === NL
    ) {
      state = prev;
    }

    const len = st.size - state.offset;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, state.offset);
      const lastNl = buf.subarray(0, bytesRead).lastIndexOf(NL);
      if (lastNl !== -1) {
        state = feed(state, buf.toString("utf8", 0, lastNl), lastNl + 1);
      }
    }
    return {
      header: "ok",
      read: { state, size: st.size, mtimeMs: st.mtimeMs },
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
  const body = nl === -1 ? "" : text.slice(nl + 1);
  return toParsedSession(
    path,
    feed(initialState(header, headerLine, 0), body, 0),
  );
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
 * Consume newline-separated entry lines, returning a new state that has
 * advanced `bytes`. `prev` is left untouched, so a failed read never corrupts
 * cached state.
 *
 * O(bytes): one JSON.parse per line.
 */
function feed(prev: ParseState, text: string, bytes: number): ParseState {
  const entries: unknown[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      bad++; // Reported via ParsedSession.malformedLines.
    }
  }
  const next = applyEntries(prev, entries);
  return {
    ...next,
    offset: prev.offset + bytes,
    malformedLines: next.malformedLines + bad,
  };
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
  return toParsedSession(path, applyEntries(initialState(h, "", 0), entries));
}

/**
 * Fold entries into a new state. Entries that aren't objects count as
 * malformed.
 *
 * Inherited Entries: fork/clone copies the parent's entries, keeping their
 * original timestamps, into a file whose header is stamped at fork time. So
 * in a session with `parentSession`, entries older than the header are
 * inherited. That holds even when the parent lives outside this Worktree,
 * which the id+timestamp dedupe alone can't catch.
 */
function applyEntries(
  prev: ParseState,
  entries: readonly unknown[],
): ParseState {
  const { header } = prev;
  const forked = header.parentSession !== undefined;
  const billed: BilledEntry[] = [];
  let { malformedLines, name, firstPrompt } = prev;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      malformedLines++;
      continue;
    }

    if (entry.type === "session_info" && typeof entry.name === "string") {
      name = entry.name.trim() || undefined; // Latest name wins.
    }
    if (firstPrompt === undefined) firstPrompt = userPromptText(entry);

    const billing = billingOf(entry);
    if (!billing) continue;
    const at =
      typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(at)) {
      malformedLines++;
      continue;
    }
    if (forked && at < header.startedAt) continue; // Inherited Entry.
    billed.push({
      key: `${String(entry.id)}|${entry.timestamp as string}`,
      at,
      ...billing,
    });
  }

  return {
    ...prev,
    billed: billed.length ? prev.billed.concat(billed) : prev.billed,
    malformedLines,
    ...(name !== undefined ? { name } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
  };
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

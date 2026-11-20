/**
 * Builders for fixture pi session folders. They write real JSONL in pi's
 * format (pi docs/session-format.md) into a temp agent dir.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Entry = Record<string, unknown>;

const iso = (ms: number) => new Date(ms).toISOString();

function usage(cost: number) {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(8, "0");

export const e = {
  user: (at: number, text: string, id = nextId()): Entry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: iso(at),
    message: { role: "user", content: text, timestamp: at },
  }),
  assistant: (
    at: number,
    cost: number,
    model = "claude-sonnet-4-5",
    provider = "anthropic",
    id = nextId(),
  ): Entry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: iso(at),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      provider,
      model,
      usage: usage(cost),
      stopReason: "stop",
      timestamp: at,
    },
  }),
  toolResult: (at: number, cost?: number, id = nextId()): Entry => ({
    type: "message",
    id,
    parentId: null,
    timestamp: iso(at),
    message: {
      role: "toolResult",
      toolCallId: "c",
      toolName: "bash",
      content: [],
      isError: false,
      ...(cost === undefined ? {} : { usage: usage(cost) }),
      timestamp: at,
    },
  }),
  usage: (at: number, cost: number, id = nextId()): Entry => ({
    type: "usage",
    id,
    parentId: null,
    timestamp: iso(at),
    kind: "cache_warm",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: usage(cost),
  }),
  compaction: (at: number, cost: number, id = nextId()): Entry => ({
    type: "compaction",
    id,
    parentId: null,
    timestamp: iso(at),
    summary: "s",
    firstKeptEntryId: id,
    tokensBefore: 1,
    usage: usage(cost),
  }),
  branchSummary: (at: number, cost: number, id = nextId()): Entry => ({
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: iso(at),
    fromId: "x",
    summary: "s",
    usage: usage(cost),
  }),
  name: (at: number, name: string, id = nextId()): Entry => ({
    type: "session_info",
    id,
    parentId: null,
    timestamp: iso(at),
    name,
  }),
  custom: (at: number, id = nextId()): Entry => ({
    type: "custom",
    id,
    parentId: null,
    timestamp: iso(at),
    customType: "x",
    data: { usage: usage(99) },
  }),
};

export interface SessionSpec {
  cwd: string;
  startedAt: number;
  entries: Entry[];
  parentSession?: string;
  /** Extra raw lines appended verbatim (for malformed-line tests). */
  rawLines?: string[];
}

export class Fixture {
  readonly base: string;
  readonly agentDir: string;
  readonly sessionsRoot: string;

  constructor() {
    this.base = realpathSync(mkdtempSync(join(tmpdir(), "pwc-fx-")));
    this.agentDir = join(this.base, "agent");
    this.sessionsRoot = join(this.agentDir, "sessions");
    mkdirSync(this.sessionsRoot, { recursive: true });
  }

  /** A real directory under the fixture base (to act as a cwd). */
  dir(...parts: string[]): string {
    const p = join(this.base, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  }

  /** A default-layout per-cwd folder. Name is arbitrary on purpose. */
  folder(name: string): string {
    const p = join(this.sessionsRoot, `--${name}--`);
    mkdirSync(p, { recursive: true });
    return p;
  }

  write(folder: string, spec: SessionSpec): string {
    const id = nextId();
    const path = join(folder, `${spec.startedAt}_${id}.jsonl`);
    const header = {
      type: "session",
      version: 3,
      id,
      timestamp: iso(spec.startedAt),
      cwd: spec.cwd,
      ...(spec.parentSession ? { parentSession: spec.parentSession } : {}),
    };
    const lines = [header, ...spec.entries].map((x) => JSON.stringify(x));
    lines.push(...(spec.rawLines ?? []));
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}

/**
 * Cold-start benchmark for computeWorktreeTotals (issue 03).
 *
 *   node bench/cold-start.ts                 # synthetic sessions root
 *   node bench/cold-start.ts --real [cwd]    # your ~/.pi/agent/sessions (read-only)
 *
 * "First" is the first run in this process; the OS page cache may already
 * be warm from earlier runs, so it's an optimistic cold number.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorktree } from "../src/worktree.ts";
import {
  computeWorktreeTotals,
  WorktreeTotalsIndex,
  type WorktreeTotalsInput,
} from "../src/worktree-totals.ts";

const RUNS = 7;

/** Steady-state refresh with nothing changed (the per-turn cost). */
async function warm(label: string, input: WorktreeTotalsInput) {
  const index = new WorktreeTotalsIndex(input);
  await index.refresh();
  await time(`${label} refresh (unchanged)`, () => index.refresh());
}

async function time(label: string, fn: () => Promise<unknown>) {
  const ms: number[] = [];
  let last: unknown;
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    last = await fn();
    ms.push(performance.now() - t);
  }
  const sorted = [...ms].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `${label}: first ${ms[0]!.toFixed(1)} ms, median ${median.toFixed(1)} ms`,
  );
  return last;
}

function synthetic() {
  const FOLDERS = 100;
  const FILES = 10;
  const ENTRIES = 200;
  const MATCHING_FOLDERS = 5;
  const pad = "x".repeat(1000); // ~1 KB tool output per entry

  const base = mkdtempSync(join(tmpdir(), "pwc-bench-"));
  const agentDir = join(base, "agent");
  const repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  let bytes = 0;
  for (let f = 0; f < FOLDERS; f++) {
    const dir = join(agentDir, "sessions", `--f${f}--`);
    mkdirSync(dir, { recursive: true });
    const cwd = f < MATCHING_FOLDERS ? join(repo, `sub${f}`) : `/other/${f}`;
    for (let n = 0; n < FILES; n++) {
      const t0 = Date.UTC(2026, 0, 1) + (f * FILES + n) * 3_600_000;
      const lines = [
        JSON.stringify({
          type: "session",
          version: 3,
          id: `s${f}-${n}`,
          timestamp: new Date(t0).toISOString(),
          cwd,
        }),
      ];
      for (let i = 0; i < ENTRIES; i++) {
        const ts = new Date(t0 + i * 1000).toISOString();
        lines.push(
          JSON.stringify(
            i % 2
              ? {
                  type: "message",
                  id: `${f}-${n}-${i}`,
                  timestamp: ts,
                  message: {
                    role: "assistant",
                    provider: "anthropic",
                    model: "m",
                    usage: { cost: { total: 0.001 } },
                    content: [{ type: "text", text: pad }],
                  },
                }
              : {
                  type: "message",
                  id: `${f}-${n}-${i}`,
                  timestamp: ts,
                  message: { role: "toolResult", content: pad },
                },
          ),
        );
      }
      const text = `${lines.join("\n")}\n`;
      bytes += text.length;
      writeFileSync(join(dir, `${n}.jsonl`), text);
    }
  }
  console.log(
    `synthetic: ${FOLDERS} folders, ${FOLDERS * FILES} files, ` +
      `${(bytes / 1e6).toFixed(0)} MB; ${MATCHING_FOLDERS * FILES} files match`,
  );
  return {
    base,
    input: {
      activeSessionDir: join(agentDir, "sessions", "--f0--"),
      agentDir,
      worktreeRoot: repo,
      lifetimeStart: null,
    },
  };
}

if (process.argv[2] === "--real") {
  const cwd = process.argv[3] ?? process.cwd();
  const agentDir = join(homedir(), ".pi", "agent");
  const wt = await resolveWorktree(cwd);
  const input = {
    activeSessionDir: join(agentDir, "sessions", "--placeholder--"),
    agentDir,
    worktreeRoot: wt.root,
    lifetimeStart: wt.lifetimeStart,
  };
  const r = (await time(`real (${wt.root})`, () =>
    computeWorktreeTotals(input),
  )) as Awaited<ReturnType<typeof computeWorktreeTotals>>;
  await warm("real", input);
  console.log(
    `  → $${r.cost.toFixed(3)} across ${r.sessions.length} session(s), ` +
      `${r.warnings.length} warning(s)`,
  );
} else {
  const { base, input } = synthetic();
  try {
    await time("synthetic", () => computeWorktreeTotals(input));
    await warm("synthetic", input);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

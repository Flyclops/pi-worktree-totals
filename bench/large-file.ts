/**
 * Peak-memory benchmark for parsing one large session file (issue 08).
 *
 *   node bench/large-file.ts [sizeMB=500]
 *
 * Writes a synthetic image-heavy session (1 MB base64-like tool results
 * between small billed messages), then parses it in a fresh child process
 * and reports that process's peak RSS and parse time. A child process keeps
 * the measurement free of the generator's own memory.
 */
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = process.argv[2] === "--child";

if (CHILD) {
  const { readSessionFile } = await import("../src/session-file.ts");
  const path = process.argv[3]!;
  const t = performance.now();
  const { read } = await readSessionFile(path);
  const ms = performance.now() - t;
  const billed = read?.state.billed.length ?? 0;
  const peakMB = process.resourceUsage().maxRSS / 1024; // maxRSS is KB
  console.log(
    JSON.stringify({ billed, ms: Math.round(ms), peakMB: Math.round(peakMB) }),
  );
} else {
  const sizeMB = Number(process.argv[2] ?? 500);
  const dir = mkdtempSync(join(tmpdir(), "pwt-large-"));
  const path = join(dir, "big.jsonl");
  const fd = openSync(path, "w");
  let bytes = 0;
  let n = 0;
  const ts = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  const write = (o: object) => {
    const s = `${JSON.stringify(o)}\n`;
    writeSync(fd, s);
    bytes += s.length;
  };
  write({ type: "session", version: 3, id: "big", timestamp: ts(0), cwd: "/r" });
  const image = "A".repeat(1024 * 1024);
  while (bytes < sizeMB * 1024 * 1024) {
    n++;
    write({
      type: "message",
      id: `t${n}`,
      timestamp: ts(n * 2),
      message: { role: "toolResult", content: [{ type: "image", data: image }] },
    });
    write({
      type: "message",
      id: `a${n}`,
      timestamp: ts(n * 2 + 1),
      message: {
        role: "assistant",
        provider: "p",
        model: "m",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        content: [{ type: "text", text: "ok" }],
      },
    });
  }
  closeSync(fd);
  console.log(`file: ${(bytes / 1024 / 1024).toFixed(0)} MB, ${n} billed`);
  try {
    const self = fileURLToPath(import.meta.url);
    const out = execFileSync(process.execPath, [self, "--child", path], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
    });
    console.log(`parse: ${out.trim()}`);
  } catch (err) {
    console.log(`parse failed: ${(err as { stderr?: string }).stderr?.split("\n").find((l) => /Error/.test(l)) ?? err}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

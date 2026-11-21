import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  parseSessionText,
  promptLabel,
  readSessionFile,
} from "../src/session-file.ts";

const skill = (body: string) =>
  `<skill name="grill-with-docs" location="/s/SKILL.md">\n${body}\n</skill>`;

describe("promptLabel", () => {
  it("shows a skill invocation as the typed command", () => {
    expect(promptLabel(skill("References…\n\nCall the Skill tool"))).toBe(
      "/skill:grill-with-docs",
    );
  });

  it("keeps the user's text after the skill block", () => {
    expect(promptLabel(`${skill("x")}\n\nfix the auth bug`)).toBe(
      "/skill:grill-with-docs fix the auth bug",
    );
  });

  it("leaves ordinary prompts alone", () => {
    expect(promptLabel("hello <skill> there")).toBe("hello <skill> there");
  });
});

describe("session labels", () => {
  it("uses the skill command form for a skill-started session", () => {
    const lines = [
      { type: "session", id: "s", timestamp: "2026-01-01T00:00:00Z", cwd: "/r" },
      {
        type: "message",
        id: "u",
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: [{ type: "text", text: skill("b") }] },
      },
    ];
    const text = lines.map((l) => JSON.stringify(l)).join("\n");
    expect(parseSessionText("/f", text)!.label).toBe("/skill:grill-with-docs");
  });
});

describe("chunked reading (issue 08)", () => {
  // Multi-byte text (emoji, CJK) in prompts and model names, so tiny chunks
  // split UTF-8 sequences; a malformed line; a session name.
  const lines = [
    { type: "session", id: "s", timestamp: "2026-01-01T00:00:00Z", cwd: "/r" },
    msg("u1", 1, { role: "user", content: "héllo 🌍 世界 ".repeat(20) }),
    msg("a1", 2, assistant("模型-🚀", 0.5)),
    "{not json",
    msg("t1", 3, { role: "toolResult", content: "x".repeat(300), usage: usage(0.25) }),
    { type: "session_info", id: "n", timestamp: "2026-01-01T00:00:04Z", name: "Ünïcode ✨" },
    msg("a2", 5, assistant("m", 1)),
  ];
  const text = lines
    .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
    .join("\n")
    .concat("\n");

  it.each([1, 2, 3, 7, 64, 4096])(
    "chunk size %i gives the same result as one whole read",
    async (chunk) => {
      const path = tmpFile(text);
      const whole = (await readSessionFile(path)).read!.state;
      const chunked = (await readSessionFile(path, undefined, chunk)).read!.state;
      expect(chunked).toEqual(whole);
      expect(whole.billed.map((b) => b.model)).toEqual([
        "undefined/模型-🚀",
        "Tools/summaries",
        "undefined/m",
      ]);
      expect(whole.malformedLines).toBe(1);
      expect(whole.offset).toBe(Buffer.byteLength(text));
    },
  );

  it("leaves a half-written last line for later, with tiny chunks", async () => {
    const partial = `${text}{"type":"message","id":"a3"`;
    const path = tmpFile(partial);
    const st = (await readSessionFile(path, undefined, 5)).read!.state;
    expect(st.offset).toBe(Buffer.byteLength(text));
    expect(st.malformedLines).toBe(1);
  });

  it("resumes from the offset with tiny chunks", async () => {
    const path = tmpFile(text);
    const first = (await readSessionFile(path, undefined, 3)).read!.state;
    appendFileSync(path, `${JSON.stringify(msg("a3", 6, assistant("m", 2)))}\n`);
    const next = (await readSessionFile(path, first, 3)).read!.state;
    expect(next.billed.map((b) => b.cost)).toEqual([0.5, 0.25, 1, 2]);
  });

  it("stores the first prompt already shortened", async () => {
    const st = (await readSessionFile(tmpFile(text))).read!.state;
    expect(st.firstPrompt!.length).toBeLessThanOrEqual(60);
  });
});

function usage(cost: number) {
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: cost } };
}
function assistant(model: string, cost: number) {
  return { role: "assistant", model, content: [], usage: usage(cost) };
}
function msg(id: string, sec: number, message: object) {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
  return { type: "message", id, timestamp, message };
}
const tmpDir = mkdtempSync(join(tmpdir(), "pwt-sf-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));
let tmpN = 0;
function tmpFile(content: string): string {
  const p = join(tmpDir, `${++tmpN}.jsonl`);
  writeFileSync(p, content);
  return p;
}

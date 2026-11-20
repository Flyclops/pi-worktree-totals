import { describe, expect, it } from "vitest";
import { parseSessionText, promptLabel } from "../src/session-file.ts";

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

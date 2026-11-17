/**
 * pi-worktree-totals extension entry point.
 *
 * Shows the Worktree Cost (see GLOSSARY.md), the total billed model cost of
 * every pi Session run inside the current git worktree, as a footer status
 * item (spec Q12).
 *
 * `/worktree-totals` appends a point-in-time report to the session as a custom
 * entry, rendered in the chat but never sent to the model (spec Q30).
 *
 * This file stays a thin layer over pi's API; the logic lives in tracker.ts
 * and below. All work runs in the background: handlers return immediately,
 * so a slow scan never delays pi's startup or a turn.
 */
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { WorktreeTotals } from "./aggregate.ts";
import {
  formatReport,
  formatStatus,
  isSnapshot,
  type ReportSnapshot,
  STATUS_PREFIX,
  toSnapshot,
} from "./format.ts";
import { WorktreeTotalsTracker } from "./tracker.ts";

/** Extension name: status key and prefix for notifications. */
export const NAME = "worktree-totals";
/** Status key used with ctx.ui.setStatus. */
export const STATUS_KEY = NAME;
/** Slash command that shows the Worktree Totals report. */
export const COMMAND = "worktree-totals";
/** Custom entry type for report snapshots. */
export const REPORT_ENTRY = "worktree-totals-report";

export interface ExtensionDeps {
  agentDir: () => string;
  startTracker: typeof WorktreeTotalsTracker.start;
}

const defaultDeps: ExtensionDeps = {
  agentDir: getAgentDir,
  startTracker: (session, agentDir, resolve) =>
    WorktreeTotalsTracker.start(session, agentDir, resolve),
};

export function createExtension(deps: ExtensionDeps = defaultDeps) {
  return function worktreeCost(pi: ExtensionAPI): void {
    let tracker: Promise<WorktreeTotalsTracker> | undefined;
    // Bumped on shutdown so background work from an old session runtime
    // never touches a stale ctx (pi docs: session replacement footguns).
    let generation = 0;
    const reported = new Set<string>();

    /** Refresh in the background and update the footer. */
    function update(ctx: ExtensionContext): void {
      if (!ctx.hasUI || !tracker) return;
      const gen = generation;
      const session = ctx.sessionManager;
      tracker.then((t) => t.refresh(session)).then(
        (cost) => {
          if (gen === generation) show(ctx, cost);
        },
        (err: unknown) => {
          if (gen !== generation) return;
          setStatus(ctx, `${STATUS_PREFIX} $?`);
          report(ctx, `${NAME}: ${(err as Error)?.message ?? err}`, "error");
        },
      );
    }

    function show(ctx: ExtensionContext, cost: WorktreeTotals): void {
      setStatus(ctx, formatStatus(cost));
      for (const w of cost.warnings) report(ctx, `${NAME}: ${w}`, "warning");
    }

    /**
     * Set the footer status in the theme's "dim" color, matching pi's own
     * footer stats. Reads the theme each time, so theme switches apply.
     */
    function setStatus(ctx: ExtensionContext, text: string): void {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
    }

    /** Notify each distinct problem once per session runtime, not per turn. */
    function report(
      ctx: ExtensionContext,
      message: string,
      level: "warning" | "error",
    ): void {
      if (reported.has(message)) return;
      reported.add(message);
      ctx.ui.notify(message, level);
    }

    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI) return; // print/JSON mode: nothing to show.
      setStatus(ctx, `${STATUS_PREFIX} …`);
      tracker = deps.startTracker(ctx.sessionManager, deps.agentDir());
      update(ctx);
    });

    // Spend lands in the session at these points: assistant turns, retries
    // and auto-compaction (settled), manual compaction, and /tree summaries.
    pi.on("turn_end", (_event, ctx) => update(ctx));
    pi.on("agent_settled", (_event, ctx) => update(ctx));
    pi.on("session_compact", (_event, ctx) => update(ctx));
    pi.on("session_tree", (_event, ctx) => update(ctx));

    /** The tracker, started on demand (e.g. a command without a UI). */
    function ensureTracker(ctx: ExtensionContext): Promise<WorktreeTotalsTracker> {
      tracker ??= deps.startTracker(ctx.sessionManager, deps.agentDir());
      return tracker;
    }

    pi.registerCommand(COMMAND, {
      description:
        "Show cost and tokens across every session in this worktree",
      handler: async (_args, ctx) => {
        // Errors propagate: pi reports command failures in the UI.
        const t = await ensureTracker(ctx);
        const totals = await t.refresh(ctx.sessionManager);
        pi.appendEntry<ReportSnapshot>(
          REPORT_ENTRY,
          toSnapshot(t.worktree, totals, Date.now()),
        );
        if (ctx.hasUI) show(ctx, totals);
      },
    });

    pi.registerEntryRenderer(REPORT_ENTRY, (entry, _options, theme) => {
      // Entries from a future, incompatible version render as nothing.
      if (!isSnapshot(entry.data)) return undefined;
      const text = formatReport(entry.data, {
        fg: (color, t) => theme.fg(color, t),
        bold: (t) => theme.bold(t),
      });
      const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(text, 0, 0));
      return box;
    });

    pi.on("session_shutdown", (_event, ctx) => {
      generation++;
      tracker = undefined;
      reported.clear();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    });
  };
}

export default createExtension();

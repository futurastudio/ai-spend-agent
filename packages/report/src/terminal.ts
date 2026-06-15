import Table from "cli-table3";
import pc from "picocolors";
import {
  computePlanChecks,
  generateCutList,
  totalEstimatedMonthlySavingsUsd,
  usageWindowDays,
  type CostConfidence,
  type CutAction,
  type SpendBreakdownEntry,
  type SpendSummary,
  type UsageRecord
} from "@agent-finops/core";

/**
 * Dimensions the terminal summary can drill down by. Mirrors the breakdown
 * arrays already computed in {@link SpendSummary}.
 */
export type GroupByDimension =
  | "source"
  | "model"
  | "client"
  | "project"
  | "agent"
  | "user"
  | "workspace"
  | "apiKey";

export const groupByDimensions: GroupByDimension[] = [
  "source",
  "model",
  "client",
  "project",
  "agent",
  "user",
  "workspace",
  "apiKey"
];

export type PlainEnglishSummaryOptions = {
  /** Records the summary was computed from (used to derive the cut list). */
  records: UsageRecord[];
  /** Drill-down dimension for the breakdown table. Defaults to "model". */
  groupBy?: GroupByDimension;
  /** Force-enable or force-disable color. Defaults to TTY auto-detection. */
  color?: boolean;
  /** Terminal width for bar rendering. Defaults to 72. */
  width?: number;
  /**
   * Demo banner (sample data), real connected/synced data, or real usage
   * estimated from local agent logs (Claude Code / Codex transcripts).
   */
  mode?: "demo" | "connected" | "local-logs";
  /** Optional next-step CTA lines printed in the footer. */
  nextSteps?: string[];
};

/**
 * Best-in-class terminal summary: a big headline spend number, a ranked
 * ACTIONABLE cut list with exact dollar savings, then a drill-down table by
 * the chosen dimension. Degrades gracefully (no color, ASCII) when not a TTY.
 */
export function generatePlainEnglishSummary(
  summary: SpendSummary,
  options: PlainEnglishSummaryOptions
): string {
  const useColor = options.color ?? isColorTty();
  const c = makeColors(useColor);
  const width = options.width ?? 72;
  const groupBy = options.groupBy ?? "model";
  const cutList = generateCutList(options.records);
  const totalMonthlySavings = totalEstimatedMonthlySavingsUsd(cutList);

  const lines: string[] = [];

  // --- Headline ----------------------------------------------------------
  lines.push("");
  lines.push(c.dim(rule(width)));
  lines.push(
    `  ${c.bold("AI SPEND")}  ${c.dim("your AI spend in one view")}`
  );
  lines.push(c.dim(rule(width)));
  lines.push("");
  lines.push(`  ${c.bold(c.cyan(formatBigUsd(summary.totalUsd)))}  ${c.dim(`tracked across ${summary.recordCount} call${summary.recordCount === 1 ? "" : "s"}`)}`);
  lines.push(
    `  ${confidenceBadge(summary.confidence, c)}  ${c.dim(coverageLine(summary))}`
  );
  if (options.mode === "demo") {
    lines.push("");
    lines.push(
      `  ${c.yellow("DEMO")} ${c.dim("sample data — run")} ${c.bold("ai-spend-agent connect openai")} ${c.dim("for your real numbers")}`
    );
  }
  if (options.mode === "local-logs") {
    lines.push("");
    lines.push(
      `  ${c.green("YOUR USAGE")} ${c.dim("found in local agent logs (Claude Code / Codex) — priced at API-equivalent rates")}`
    );
  }
  lines.push("");

  // --- The wow: ranked, actionable cut list ------------------------------
  lines.push(c.bold("  Where to cut") + c.dim("  (ranked by monthly savings)"));
  lines.push("");
  if (cutList.length === 0) {
    lines.push(c.dim("  No high-confidence cut found in this window. Connect more usage to surface savings."));
  } else {
    for (const [index, action] of cutList.slice(0, 5).entries()) {
      lines.push(...cutActionLines(action, index + 1, c));
    }
    const days = usageWindowDays(options.records);
    lines.push("");
    lines.push(
      `  ${c.green(c.bold(`~${formatUsd(totalMonthlySavings)}/mo`))} ${c.dim(`estimated savings — a 30-day projection from ${days} day${days === 1 ? "" : "s"} of data`)}`
    );
    // Honest math: short windows extrapolate hard. Flag it rather than let a
    // 4-hour sample read as a confident monthly number.
    if (days < 3) {
      lines.push(
        `  ${c.dim(`assumes this ${days === 1 ? "day's" : "window's"} pattern repeats; collect more days for a firmer number`)}`
      );
    }
    // Model-downgrade suggestions trade quality for cost — say so once.
    if (cutList.some((action) => action.kind === "model_downgrade")) {
      lines.push(
        `  ${c.dim("downgrades assume the cheaper model holds quality for that workload — verify before switching")}`
      );
    }
  }
  lines.push("");

  // --- Plan check (subscription vs API arbitrage) -------------------------
  const planChecks = computePlanChecks(options.records);
  if (planChecks.length > 0) {
    lines.push(c.bold("  Plan check") + c.dim("  (subscription vs pay-per-token — the math no provider shows you)"));
    lines.push("");
    for (const check of planChecks) {
      lines.push(`  ${c.cyan("›")} ${check.headline}`);
    }
    lines.push("");
  }

  // --- Drill-down table --------------------------------------------------
  const entries = breakdownFor(summary, groupBy);
  lines.push(c.bold(`  Spend by ${groupByLabel(groupBy)}`) + c.dim(`  (--group-by ${dimensionFlags()})`));
  lines.push("");
  lines.push(indentBlock(renderBreakdownTable(entries, summary.totalUsd, c, useColor), "  "));
  lines.push("");

  // --- Footer / next steps ----------------------------------------------
  const nextSteps = options.nextSteps ?? defaultNextSteps(options.mode);
  if (nextSteps.length > 0) {
    lines.push(c.dim(rule(width)));
    lines.push(c.bold("  Next"));
    for (const step of nextSteps) {
      lines.push(`  ${c.cyan("›")} ${step}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function cutActionLines(action: CutAction, rank: number, c: Colors): string[] {
  const savings = c.green(c.bold(`save ~${formatUsd(action.estimatedMonthlySavingsUsd)}/mo`));
  const head = `  ${c.bold(`${rank}.`)} ${c.bold(action.title)}  ${savings}`;
  const detail = `     ${c.dim(action.action)}`;
  const grounding = `     ${c.dim(`${action.recordCount} call${action.recordCount === 1 ? "" : "s"} · ${formatUsd(action.affectedSpendUsd)} in window · ${confidenceWord(action.confidence)}`)}`;
  return [head, detail, grounding, ""];
}

function renderBreakdownTable(
  entries: SpendBreakdownEntry[],
  total: number,
  c: Colors,
  useColor: boolean
): string {
  if (entries.length === 0) {
    return c.dim("(no breakdown available for this dimension)");
  }

  const table = new Table({
    head: [c.bold(""), c.bold("Spend"), c.bold("Share"), c.bold("Calls"), c.bold("Confidence")],
    colAligns: ["left", "right", "left", "right", "left"],
    style: useColor
      ? { head: [], border: ["dim"] }
      : { head: [], border: [] },
    chars: tableChars()
  });

  for (const entry of entries.slice(0, 10)) {
    const share = total > 0 ? entry.amountUsd / total : 0;
    table.push([
      labelOf(entry.key),
      formatUsd(entry.amountUsd),
      `${bar(share, c)} ${formatPercent(share)}`,
      String(entry.recordCount),
      confidenceWord(entry.confidence)
    ]);
  }

  return table.toString();
}

// --- formatting helpers ---------------------------------------------------

function coverageLine(summary: SpendSummary): string {
  const breakdown = summary.confidenceBreakdown;
  const verified = breakdown.verified ?? 0;
  const estimated = breakdown.estimated ?? 0;
  const detected = breakdown.detected_unverified ?? 0;
  const parts: string[] = [];
  if (verified > 0) parts.push(`${formatUsd(verified)} verified`);
  if (estimated > 0) parts.push(`${formatUsd(estimated)} estimated`);
  if (detected > 0) parts.push(`${formatUsd(detected)} detected`);
  return parts.length > 0 ? parts.join(" · ") : "no cost breakdown yet";
}

function confidenceBadge(confidence: CostConfidence, c: Colors): string {
  const word = confidenceWord(confidence);
  if (confidence === "verified") return c.green(`● ${word}`);
  if (confidence === "estimated") return c.yellow(`● ${word}`);
  if (confidence === "detected_unverified") return c.yellow(`● ${word}`);
  return c.dim(`● ${word}`);
}

function confidenceWord(confidence: CostConfidence): string {
  switch (confidence) {
    case "verified":
      return "verified";
    case "estimated":
      return "estimated";
    case "detected_unverified":
      return "detected";
    default:
      return "missing";
  }
}

function breakdownFor(summary: SpendSummary, dimension: GroupByDimension): SpendBreakdownEntry[] {
  switch (dimension) {
    case "source":
      return summary.bySource;
    case "client":
      return summary.byClient;
    case "project":
      return summary.byProject;
    case "agent":
      return summary.byAgent;
    case "user":
      return summary.byUser;
    case "workspace":
      return summary.byWorkspace;
    case "apiKey":
      return summary.byApiKey;
    case "model":
    default:
      return summary.byModel;
  }
}

function groupByLabel(dimension: GroupByDimension): string {
  switch (dimension) {
    case "apiKey":
      return "API key";
    case "user":
      return "user";
    case "workspace":
      return "workspace";
    default:
      return dimension;
  }
}

function dimensionFlags(): string {
  return groupByDimensions.join("|");
}

function labelOf(key: string): string {
  return key === "unmapped" ? "(unmapped)" : key;
}

function defaultNextSteps(mode: PlainEnglishSummaryOptions["mode"]): string[] {
  if (mode === "connected") {
    return [
      "ai-spend-agent report           write a shareable Markdown + HTML report",
      "ai-spend-agent --group-by agent drill into another dimension"
    ];
  }
  if (mode === "local-logs") {
    return [
      "ai-spend-agent connect openai    add verified billing data (org-owner admin key)",
      "ai-spend-agent connect anthropic add verified billing data (admin key)",
      "ai-spend-agent --group-by project see which project burns the most",
      "Want this watched while your laptop is off? Hosted beta waitlist: https://ai-spend-agent.vercel.app"
    ];
  }
  return [
    "ai-spend-agent connect openai    pull your real OpenAI spend (org-owner admin key)",
    "ai-spend-agent connect anthropic pull your real Anthropic spend (admin key)",
    "ai-spend-agent report            write a shareable Markdown + HTML report"
  ];
}

/** Unicode bar that degrades to ASCII when color is off. */
function bar(ratio: number, c: Colors): string {
  const slots = 10;
  const filled = Math.max(0, Math.min(slots, Math.round(ratio * slots)));
  const full = c.cyan("█".repeat(filled));
  const empty = c.dim("░".repeat(slots - filled));
  return `${full}${empty}`;
}

function rule(width: number): string {
  return "─".repeat(Math.max(8, width));
}

function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function formatBigUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function tableChars(): Record<string, string> {
  return {
    top: "─",
    "top-mid": "┬",
    "top-left": "┌",
    "top-right": "┐",
    bottom: "─",
    "bottom-mid": "┴",
    "bottom-left": "└",
    "bottom-right": "┘",
    left: "│",
    "left-mid": "├",
    mid: "─",
    "mid-mid": "┼",
    right: "│",
    "right-mid": "┤",
    middle: "│"
  };
}

// --- color plumbing -------------------------------------------------------

type Colorize = (text: string) => string;
type Colors = {
  bold: Colorize;
  dim: Colorize;
  cyan: Colorize;
  green: Colorize;
  yellow: Colorize;
};

const identity: Colorize = (text) => text;

function makeColors(useColor: boolean): Colors {
  if (!useColor) {
    return { bold: identity, dim: identity, cyan: identity, green: identity, yellow: identity };
  }
  // picocolors' default export is bound to process/TTY state at import time.
  // createColors(true) is the explicit override path for tests and --color-like
  // callers that need ANSI even when stdout is not a TTY.
  const forced = pc.createColors(true);
  return {
    bold: forced.bold,
    dim: forced.dim,
    cyan: forced.cyan,
    green: forced.green,
    yellow: forced.yellow
  };
}

function isColorTty(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout && process.stdout.isTTY);
}

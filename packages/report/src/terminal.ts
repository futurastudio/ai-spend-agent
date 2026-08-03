import Table from "cli-table3";
import pc from "picocolors";
import {
  computePlanChecks,
  generateCutList,
  buildRecommendedPlan,
  usageWindowDays,
  type CostConfidence,
  type CutAction,
  type DeadContextResult,
  type DetectedPlan,
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
  /**
   * Optional dead-context cost (loaded-but-never-invoked tools), priced from
   * the local agent inventory vs. real transcript invocations. Rendered only
   * when it carries real data.
   */
  deadContext?: DeadContextResult;
  /**
   * Plans detected from the coding agents' own local config (or a --plan
   * override). Drives persona framing: subscription users get facts +
   * headroom language; API payers get dollars.
   */
  detectedPlans?: DetectedPlan[];
  /**
   * "full" renders the complete diagnose→recommend→apply→verify readout.
   * "breakdown" is the focused drill-down for an explicit --group-by: the
   * headline, the requested table, its definition, and the data window —
   * without repeating the whole readout.
   */
  view?: "full" | "breakdown";
};

/**
 * Best-in-class terminal summary: a clearly labeled cost/value headline, a
 * ranked ACTIONABLE opportunity list, then a drill-down table by
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
  // Deduplicated so the modeled opportunity can never exceed the value it draws
  // from (overlapping recommendations are shown separately, non-additively).
  const plan = buildRecommendedPlan(cutList);

  const lines: string[] = [];

  // --- Headline ----------------------------------------------------------
  lines.push("");
  lines.push(c.dim(rule(width)));
  lines.push(
    `  ${c.bold(headlineMetricLabel(options.mode))}  ${c.dim("evidence-labeled financial view")}`
  );
  lines.push(c.dim(rule(width)));
  lines.push("");
  // Local-log records are day-level session aggregates — calling them "calls"
  // overstates precision to the audience most likely to check.
  const recordNoun = options.mode === "local-logs"
    ? "session-day record"
    : options.mode === "demo"
      ? "illustrative record"
      : "provider record";
  const totalDescription = options.mode === "demo"
    ? `combined illustrative evidence across ${summary.recordCount} ${recordNoun}${summary.recordCount === 1 ? "" : "s"}`
    : `tracked across ${summary.recordCount} ${recordNoun}${summary.recordCount === 1 ? "" : "s"}`;
  lines.push(`  ${c.bold(c.cyan(formatBigUsd(summary.totalUsd)))}  ${c.dim(totalDescription)}`);
  lines.push(
    `  ${confidenceBadge(summary.confidence, c)}  ${c.dim(coverageLine(summary))}`
  );
  if (options.mode === "demo") {
    lines.push("");
    lines.push(
      `  ${c.yellow("DEMO")} ${c.dim("sample data — combined cost/value evidence, not one invoice or homogeneous spend basis")}`
    );
    lines.push(
      `  ${c.dim("run")} ${c.bold("npx aibill")} ${c.dim("without --sample for your local evidence")}`
    );
  }
  if (options.mode === "local-logs") {
    lines.push("");
    lines.push(
      `  ${c.green("YOUR USAGE")} ${c.dim("found in local agent logs (Claude Code / Codex) — priced at API-equivalent rates")}`
    );
  }
  // Persona line: when the agents' own local config tells us the user's plan,
  // say so up front — the whole readout reads differently on a flat-price plan.
  const detectedPlans = options.detectedPlans ?? [];
  const subscriptionPlansDetected = detectedPlans.filter((plan) => plan.billing === "subscription");
  const subscriptionPersona = subscriptionPlansDetected.length > 0 && options.mode === "local-logs";
  // Plan checks are needed up front for the value-led header (and again in
  // the DIAGNOSE section) — pure computation, so hoisting is free.
  const planChecks = computePlanChecks(options.records, detectedPlans);
  if (subscriptionPlansDetected.length > 0 && options.mode !== "demo") {
    lines.push(
      `  ${c.green("PLAN")} ${c.dim(`${subscriptionPlansDetected.map((plan) => plan.planLabel).join(" · ")} — detected from your agents' local config (read-only, nothing connected)`)}`
    );
  }
  // Subscription users' headline stat is a comparison, not billed spend: the
  // dollars above are API-equivalent estimates. Keep that boundary explicit.
  const primaryValueCheck = planChecks.find(
    (check) => check.detectedPlan?.billing === "subscription" && typeof check.valueMultiple === "number" && check.suggestedPlan
  );
  if (subscriptionPersona && primaryValueCheck) {
    lines.push(
      `  ${c.green(c.bold("COMPARED WITH"))} ${c.bold(`${primaryValueCheck.suggestedPlan!.name} ($${primaryValueCheck.suggestedPlan!.monthlyUsd}/mo)`)} ${c.dim("— API-equivalent usage is")} ${c.bold(`~${primaryValueCheck.valueMultiple}×`)} ${c.dim("the listed price")}`
    );
  }
  lines.push("");

  // Focused drill-down: an explicit --group-by asks one question — render
  // just the answer (table + definition + data window), not the whole loop.
  if (options.view === "breakdown") {
    const focusedEntries = breakdownFor(summary, groupBy);
    lines.push(c.bold(`  ${evidenceBreakdownLabel(options.mode)} by ${groupByLabel(groupBy)}`) + c.dim(`  (--group-by ${dimensionFlags()})`));
    if (groupBy === "project" && options.mode === "local-logs") {
      lines.push(`  ${c.dim(localProjectDefinition())}`);
    }
    lines.push(`  ${c.dim(dataWindowLine(options.records))}`);
    lines.push("");
    lines.push(indentBlock(renderBreakdownTable(
      focusedEntries,
      summary.totalUsd,
      c,
      useColor,
      evidenceAmountColumnLabel(options.mode),
      options.mode === "demo" ? "Illustrative records" : "Records",
      groupBy === "project" && options.mode === "local-logs"
    ), "  "));
    lines.push("");
    lines.push(`  ${c.dim("run")} ${c.bold("npx aibill")} ${c.dim("for the full diagnose → recommend → apply → verify readout")}`);
    lines.push("");
    return lines.join("\n");
  }

  // TL;DR before the detail: an engineer decides in the first five lines
  // whether the next sixty are worth reading. Three bullets — value, where it
  // goes, the one action — each traceable to a section below.
  if (options.mode === "local-logs") {
    const tldr: string[] = [];
    if (primaryValueCheck) {
      const limits = planChecks.some((check) => check.upgradeHint) ? " — check the reported limit signal" : "";
      tldr.push(`API-equivalent usage is ~${primaryValueCheck.valueMultiple}× the ${primaryValueCheck.suggestedPlan!.name} list price${limits}`);
    }
    const topProject = summary.byProject[0];
    if (topProject && summary.totalUsd > 0) {
      const share = Math.round((topProject.amountUsd / summary.totalUsd) * 100);
      tldr.push(
        isUnattributedProjectKey(topProject.key)
          ? `${share}% is not yet attributable to a project · sessions launched from home need stronger folder evidence`
          : `${labelOf(topProject.key)} accounts for ${share}% of it`
      );
    }
    const dcCount = options.deadContext && options.deadContext.hasData && !options.deadContext.isSample ? options.deadContext.deadCount : 0;
    const topCut = cutList[0];
    if (topCut || dcCount > 0) {
      const cutPhrase = topCut?.impactBasis === "observed_value_no_counterfactual"
        ? "investigate cumulative context"
        : topCut?.kind === "context_trim"
          ? "trim heavy context"
          : topCut
            ? topCut.title.toLowerCase()
            : "";
      const parts = [
        dcCount > 0
          ? `inspect ${dcCount} context candidate${dcCount === 1 ? "" : "s"} with no matching invocation`
          : "",
        cutPhrase
      ].filter(Boolean);
      tldr.push(`one action: ${parts.join(" + ")} — run npx aibill apply`);
    }
    if (tldr.length > 0) {
      lines.push(c.bold("  TL;DR"));
      for (const line of tldr) lines.push(`  ${c.cyan("›")} ${line}`);
      lines.push("");
    }
  }

  // The readout is structured as the loop the product sells: DIAGNOSE what
  // your coding agents cost -> RECOMMEND cuts -> APPLY them (copy artifact)
  // -> VERIFY the delta. Sections are numbered so a first-time reader knows
  // what each block is and what to do next.

  // ══ 1 · DIAGNOSE ════════════════════════════════════════════════════════
  lines.push(sectionHeader(1, "DIAGNOSE", subscriptionPersona ? "compare observed usage with plan context" : "what the available cost and usage evidence shows", c));
  lines.push("");

  // Basis-aware source bars: at-a-glance evidence without implying a mixed
  // sample total is one invoice or one homogeneous spend basis.
  const spendBars = renderSpendBars(summary.bySource, summary.totalUsd, c);
  if (spendBars.length > 0) {
    lines.push(c.bold(`  ${sourceBreakdownLabel(options.mode)}`) + c.dim("  (by source)"));
    lines.push("");
    lines.push(...spendBars);
    lines.push("");
  }

  // --- Context candidates: configured/catalogued, no matching invocation --
  // Count-led (the defensible, shareable part). A token/$ figure shows ONLY
  // for items we measured (skills/agents); MCP servers are counted, not priced.
  const dc = options.deadContext;
  if (dc && dc.hasData && dc.deadCount > 0) {
    const pct = Math.round(dc.wastePercent * 100);
    const header = c.bold("  Context candidates") + c.dim(`  (configured/catalogued, no matching invocation in ${dc.windowDays} days)`);
    lines.push(dc.isSample ? `${header}  ${c.yellow("SAMPLE")}` : header);
    lines.push("");
    lines.push(
      `  ${c.bold(`${dc.deadCount} of ${dc.loadedCount}`)} ${c.dim(`observable inventory items had no matching invocation (${pct}%)`)}`
    );
    if (dc.measuredDeadCount > 0 && dc.monthlyDeadTokens > 0) {
      const plural = dc.measuredDeadCount === 1 ? "" : "s";
      lines.push(
        `  ${c.cyan(c.bold(`~${formatTokens(dc.monthlyDeadTokens)} modeled catalog tokens/mo`))} ` +
          c.dim(`from ${dc.measuredDeadCount} skill${plural}/agent${plural} with no matching invocation · modeled context cost ~${formatUsd(dc.monthlyUsd)}/mo · estimated`)
      );
    }
    if (dc.unmeasuredDeadCount > 0) {
      const plural = dc.unmeasuredDeadCount === 1 ? "" : "s";
      lines.push(
        `  ${c.dim(`${dc.unmeasuredDeadCount} configured MCP server${plural} had no matching invocation — schema loading and token weight are unmeasured; verify host loading and future need before changing config`)}`
      );
    }
    if (dc.isSample) {
      lines.push(`  ${c.dim("illustrative — your first run shows your own skills, agents, and MCP")}`);
    }
    lines.push("");
  } else if (dc && dc.hasData && dc.deadCount === 0 && !dc.isSample) {
    // A genuinely clean setup gets congratulated, never shown fabricated waste.
    lines.push(c.bold("  Context candidates") + c.dim(`  (configured/catalogued, no matching invocation in ${dc.windowDays} days)`));
    lines.push("");
    lines.push(
      `  ${c.green("none found")} ${c.dim(`— every one of ${dc.loadedCount} observable inventory item${dc.loadedCount === 1 ? "" : "s"} had matching use in the last ${dc.windowDays} days.`)}`
    );
    lines.push("");
  }

  // Plan check (subscription vs API arbitrage) — part of the diagnosis.
  if (planChecks.length > 0) {
    lines.push(c.bold("  Plan check") + c.dim("  (subscription vs pay-per-token — the math no provider shows you)"));
    lines.push("");
    for (const check of planChecks) {
      // Headlines are fact-dense; split at the first dash so narrow terminals
      // get a short lead line + a dim continuation instead of a 200-char wrap.
      const [head, ...rest] = check.headline.split(" — ");
      lines.push(`  ${c.cyan("›")} ${head}`);
      if (rest.length > 0) {
        lines.push(`    ${c.dim(rest.join(" — "))}`);
      }
      if (check.upgradeHint) {
        lines.push(`    ${c.yellow("!")} ${c.dim(check.upgradeHint)}`);
      }
    }
    lines.push(
      planChecks.some((check) => check.detectedPlan)
        ? `  ${c.dim("plan read from your agents' local config (read-only); prices are published list prices — no account was accessed")}`
        : `  ${c.dim("compares published list prices — this tool never sees or connects to your subscription account")}`
    );
    lines.push("");
  }

  // Drill-down table — the last diagnostic block.
  const entries = breakdownFor(summary, groupBy);
  lines.push(c.bold(`  ${evidenceBreakdownLabel(options.mode)} by ${groupByLabel(groupBy)}`) + c.dim(`  (--group-by ${dimensionFlags()})`));
  if (groupBy === "project" && options.mode === "local-logs") {
    lines.push(`  ${c.dim(localProjectDefinition())}`);
  }
  lines.push("");
  lines.push(indentBlock(renderBreakdownTable(
    entries,
    summary.totalUsd,
    c,
    useColor,
    evidenceAmountColumnLabel(options.mode),
    options.mode === "demo" ? "Illustrative records" : "Records",
    groupBy === "project" && options.mode === "local-logs"
  ), "  "));
  lines.push("");

  // ══ 2 · RECOMMEND ═══════════════════════════════════════════════════════
  lines.push(sectionHeader(
    2,
    "RECOMMEND",
    options.mode === "local-logs"
      ? "What to investigate — evidence first; reduction is not yet established"
      : options.mode === "demo"
        ? "Illustrative hypotheses only — not recommendations for this user"
      : subscriptionPersona
        ? "What to test — possible plan headroom, ranked by modeled monthly value"
        : "What to test, ranked by modeled monthly API-rate opportunity",
    c
  ));
  lines.push("");
  if (cutList.length === 0) {
    lines.push(c.dim("  No high-confidence opportunity found in this window. Collect more evidence before changing anything."));
  } else {
    // Sub-$1/mo cuts are noise on the readout (often near-duplicates of a big
    // cut) — collapse them into one line. They still count in the plan math
    // and still ship in the apply-artifact.
    const visibleCuts = cutList.filter((action) => (
      action.impactBasis === "observed_value_no_counterfactual" ||
      action.estimatedMonthlySavingsUsd >= 1
    ));
    const minorCuts = cutList.filter((action) => (
      action.impactBasis === "modeled_savings" &&
      action.estimatedMonthlySavingsUsd < 1
    ));
    const shown = visibleCuts.length > 0 ? visibleCuts : cutList;
    for (const [index, action] of shown.slice(0, 5).entries()) {
      lines.push(...cutActionLines(action, index + 1, c, options.mode));
    }
    if (visibleCuts.length > 0 && minorCuts.length > 0) {
      const minorTotal = minorCuts.reduce((total, action) => total + action.estimatedMonthlySavingsUsd, 0);
      lines.push(
        `  ${c.dim(`+ ${minorCuts.length} smaller cut${minorCuts.length === 1 ? "" : "s"} under $1/mo (~${formatUsd(minorTotal)}/mo combined) — included in apply-artifact`)}`
      );
      lines.push("");
    }
    const days = usageWindowDays(options.records);
    lines.push("");
    if (options.mode === "local-logs") {
      const observedValue = cutList
        .filter((action) => action.impactBasis === "observed_value_no_counterfactual")
        .reduce((total, action) => total + action.affectedSpendUsd, 0);
      lines.push(
        `  ${c.cyan(c.bold(formatUsd(observedValue)))} ${c.dim(`API-equivalent value observed in flagged daily aggregates — potential reduction and cash savings are not established`)}`
      );
      lines.push(
        `  ${c.dim(`apply one approved change, then compare matched future sessions and accepted output; the ${days}-day evidence window is a baseline, not a monthly forecast`)}`
      );
    } else if (options.mode === "demo") {
      lines.push(
        `  ${c.yellow(c.bold(`~${formatUsd(plan.recommendedSavingsUsd)}/mo`))} ${c.dim("illustrative modeled opportunity from bundled sample records — not this user's savings, bill, or ROI")}`
      );
    } else {
      lines.push(
        `  ${c.green(c.bold(`~${formatUsd(plan.recommendedSavingsUsd)}/mo`))} ${c.dim(`modeled API-rate opportunity (deduplicated) — verify quality and the next provider report; projected from ${days} day${days === 1 ? "" : "s"} of data`)}`
      );
    }
    if (plan.additionalSavingsUsd > 0) {
      lines.push(
        `  ${c.dim(`+ ~${formatUsd(plan.additionalSavingsUsd)}/mo more from overlapping opportunities (not additive — they target the same spend)`)}`
      );
    }
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
    // Honest framing for subscription users: when a flat-price plan covers
    // this usage, trimming doesn't return cash — it returns headroom. Saying
    // "$224/mo cash savings" to someone whose marginal cost is $0 is the kind of
    // overclaim a technical reader will (rightly) call out.
    if (
      subscriptionPlansDetected.length > 0 ||
      planChecks.some((check) => typeof check.monthlySavingsVsApiUsd === "number")
    ) {
      lines.push(
        `  ${c.dim("for agents with a detected flat-price subscription, an approved change may improve rate-limit headroom or speed; it is not a cash-savings claim unless comparable provider-reported cost falls")}`
      );
    }
  }
  lines.push("");

  // ══ 3 · APPLY ═══════════════════════════════════════════════════════════
  lines.push(sectionHeader(
    3,
    "APPLY",
    options.mode === "demo"
      ? "disabled for sample data — collect the user's evidence first"
      : "inspect, approve, and test one change",
    c
  ));
  lines.push("");
  // Every command is npx-prefixed: most users run via `npx aibill`
  // and have NO `aibill` on PATH — a bare command is a guaranteed
  // "command not found" for exactly the person who just got motivated.
  if (options.mode === "demo") {
    lines.push(
      `  ${c.cyan("›")} ${c.bold("npx aibill apply")}   ${c.dim("prints a NON-EXECUTABLE DEMO boundary; it does not authorize or propose a user change")}`
    );
    lines.push(
      `  ${c.dim("    run npx aibill without --sample, or connect a provider, before generating an evidence-scoped Apply plan (long form: npx aibill apply-artifact)")}`
    );
  } else {
    lines.push(
      `  ${c.cyan("›")} ${c.bold("npx aibill apply")}   ${c.dim("prints a paste-ready evidence, approval, rollback, and verification plan")}`
    );
    lines.push(
      `  ${c.dim("    paste it into Claude Code / Codex — it carries the candidates above without authorizing a change (long form: npx aibill apply-artifact)")}`
    );
  }
  lines.push("");

  // ══ 4 · VERIFY ══════════════════════════════════════════════════════════
  lines.push(sectionHeader(4, "VERIFY", "prove the approved change worked before trusting it", c));
  lines.push("");
  lines.push(
    `  ${c.cyan("›")} ${c.dim("re-run")} ${c.bold("npx aibill")} ${c.dim("after a few days and compare — or")} ${c.bold("npx aibill watch")} ${c.dim("to track deltas per cycle")}`
  );
  if (options.mode === "local-logs") {
    lines.push(
      `  ${c.cyan("›")} ${c.dim("these numbers are API-equivalent ESTIMATES from local logs — no account was connected or authorized")}`
    );
    lines.push(
      `  ${c.cyan("›")} ${c.dim("pay for API usage too? add official provider-reported cost:")} ${c.bold("npx aibill connect anthropic|openai")} ${c.dim("(org admin key)")}`
    );
  } else if (options.mode === "demo") {
    lines.push(
      `  ${c.cyan("›")} ${c.dim("these are illustrative SAMPLE API-equivalent estimates — no local logs or account data were used")}`
    );
    lines.push(
      `  ${c.cyan("›")} ${c.dim("want your own evidence? run without --sample, or add official provider-reported cost:")} ${c.bold("npx aibill connect openai")} ${c.dim("or")} ${c.bold("npx aibill connect anthropic")} ${c.dim("(org admin/owner key)")}`
    );
  } else {
    lines.push(
      `  ${c.cyan("›")} ${c.dim("re-sync official provider reporting with")} ${c.bold("npx aibill sync-provider")} ${c.dim("after the test; final invoices may still include credits, discounts, tax, or adjustments")}`
    );
  }
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

/** Numbered stage banner: `── 2 · RECOMMEND ──  blurb`. */
function sectionHeader(step: number, name: string, blurb: string, c: Colors): string {
  return `  ${c.dim("──")} ${c.bold(c.cyan(`${step} · ${name}`))} ${c.dim("──")}  ${c.dim(blurb)}`;
}

/** "window: 14 days of data (2026-06-20 → 2026-07-04)" for drill-down tables. */
function dataWindowLine(records: UsageRecord[]): string {
  const days = [...new Set(records.map((record) => record.timestamp.slice(0, 10)))].sort();
  if (days.length === 0) return "window: no dated records";
  const span = days.length === 1 ? days[0] : `${days[0]} → ${days[days.length - 1]}`;
  return `window: ${days.length} day${days.length === 1 ? "" : "s"} of data (${span})`;
}

function cutActionLines(
  action: CutAction,
  rank: number,
  c: Colors,
  mode: PlainEnglishSummaryOptions["mode"]
): string[] {
  const opportunity = mode === "demo"
    ? c.yellow(c.bold(`illustrative model ~${formatUsd(action.estimatedMonthlySavingsUsd)}/mo`))
    : action.impactBasis === "observed_value_no_counterfactual"
    ? c.yellow(c.bold("reduction unproven"))
    : c.green(c.bold(`model ~${formatUsd(action.estimatedMonthlySavingsUsd)}/mo`));
  const head = `  ${c.bold(`${rank}.`)} ${c.bold(action.title)}  ${opportunity}`;
  const detail = `     ${c.dim(action.action)}`;
  // Honest unit: local-log records are day-level session aggregates, not calls.
  const unit = action.recordUnit === "daily-aggregates"
    ? `daily aggregate${action.recordCount === 1 ? "" : "s"}`
    : action.recordUnit === "tools"
      ? `tool${action.recordCount === 1 ? "" : "s"}`
      : `call${action.recordCount === 1 ? "" : "s"}`;
  const valueLabel = action.impactBasis === "observed_value_no_counterfactual"
    ? `${formatUsd(action.affectedSpendUsd)} API-equivalent value observed in window`
    : `${formatUsd(action.affectedSpendUsd)} in window`;
  const grounding = `     ${c.dim(`${action.recordCount} ${unit} · ${valueLabel} · ${confidenceWord(action.confidence)}`)}`;
  return [head, detail, grounding, ""];
}

function renderBreakdownTable(
  entries: SpendBreakdownEntry[],
  total: number,
  c: Colors,
  useColor: boolean,
  amountLabel = "Evidence",
  recordLabel = "Calls",
  labelUnattributedProject = false
): string {
  if (entries.length === 0) {
    return c.dim("(no breakdown available for this dimension)");
  }

  const table = new Table({
    head: [c.bold(""), c.bold(amountLabel), c.bold("Share"), c.bold(recordLabel), c.bold("Confidence")],
    colAligns: ["left", "right", "left", "right", "left"],
    style: useColor
      ? { head: [], border: ["dim"] }
      : { head: [], border: [] },
    chars: tableChars()
  });

  for (const entry of entries.slice(0, 10)) {
    const share = total > 0 ? entry.amountUsd / total : 0;
    table.push([
      labelUnattributedProject && isUnattributedProjectKey(entry.key)
        ? "Unattributed"
        : labelOf(entry.key),
      formatUsd(entry.amountUsd),
      `${bar(share, c)} ${formatPercent(share)}`,
      String(entry.recordCount),
      confidenceWord(entry.confidence)
    ]);
  }

  return table.toString();
}

function isUnattributedProjectKey(key: string): boolean {
  return ["unmapped", "(home)", "home", "unattributed", "unknown"].includes(key.trim().toLowerCase());
}

function localProjectDefinition(): string {
  return "project = observed working folder; Unattributed = no reliable project evidence (often launched from home); Records = day + agent + model + project aggregates";
}

// --- formatting helpers ---------------------------------------------------

function coverageLine(summary: SpendSummary): string {
  const breakdown = summary.confidenceBreakdown;
  const verified = breakdown.verified ?? 0;
  const estimated = breakdown.estimated ?? 0;
  const detected = breakdown.detected_unverified ?? 0;
  const parts: string[] = [];
  if (verified > 0) parts.push(`${formatUsd(verified)} provider-reported`);
  if (estimated > 0) parts.push(`${formatUsd(estimated)} API-equivalent/estimated`);
  if (detected > 0) parts.push(`${formatUsd(detected)} detected/unverified`);
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
      return "provider-reported";
    case "estimated":
      return "estimated";
    case "detected_unverified":
      return "detected/unverified";
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

function headlineMetricLabel(mode: PlainEnglishSummaryOptions["mode"]): string {
  if (mode === "connected") return "PROVIDER-REPORTED COST";
  if (mode === "local-logs") return "OBSERVED API-EQUIVALENT VALUE";
  return "ILLUSTRATIVE COST / VALUE EVIDENCE";
}

function evidenceBreakdownLabel(mode: PlainEnglishSummaryOptions["mode"]): string {
  if (mode === "connected") return "Provider-reported cost";
  if (mode === "local-logs") return "API-equivalent value";
  return "Cost/value evidence";
}

function evidenceAmountColumnLabel(mode: PlainEnglishSummaryOptions["mode"]): string {
  if (mode === "connected") return "Cost";
  if (mode === "local-logs") return "Value";
  return "Evidence";
}

function sourceBreakdownLabel(mode: PlainEnglishSummaryOptions["mode"]): string {
  if (mode === "connected") return "Where provider-reported cost goes";
  if (mode === "local-logs") return "Where observed API-equivalent value goes";
  return "Cost/value evidence by source";
}

function defaultNextSteps(mode: PlainEnglishSummaryOptions["mode"]): string[] {
  if (mode === "connected") {
    return [
      "npx aibill report           write a shareable Markdown + HTML report",
      "npx aibill --group-by agent drill into another dimension"
    ];
  }
  if (mode === "local-logs") {
    return [
      "npx aibill report              write a shareable Markdown + HTML report",
      "npx aibill --group-by project  see which project has the most observed activity",
      "Need team reconciliation, allocation, budgets, and approvals? Workspace design partners: https://ai-spend-agent.vercel.app"
    ];
  }
  return [
    "npx aibill connect openai    add official OpenAI-reported cost (org-owner admin key)",
    "npx aibill connect anthropic add official Anthropic-reported cost (admin key)",
    "npx aibill report            write a shareable Markdown + HTML report"
  ];
}

/**
 * The "where your money goes" block: aligned label + proportional bar + dollar
 * + share. This is the screenshot-able artifact — kept deliberately compact
 * (top 5 sources) so the terminal stays clean.
 */
function renderSpendBars(entries: SpendBreakdownEntry[], total: number, c: Colors): string[] {
  if (entries.length === 0) return [];
  const top = entries.slice(0, 5);
  const labelWidth = Math.min(16, Math.max(...top.map((entry) => labelOf(entry.key).length)));
  return top.map((entry) => {
    const share = total > 0 ? entry.amountUsd / total : 0;
    const label = labelOf(entry.key).slice(0, labelWidth).padEnd(labelWidth);
    const amount = formatUsd(entry.amountUsd).padStart(9);
    const pct = `${Math.round(share * 100)}%`.padStart(4);
    return `  ${c.dim(label)}  ${spendBar(share, c)}  ${c.bold(amount)}  ${c.dim(pct)}`;
  });
}

/** Wider bar for the headline spend block; the dominant source reads bold. */
function spendBar(ratio: number, c: Colors): string {
  const slots = 22;
  const filled = Math.max(ratio > 0 ? 1 : 0, Math.min(slots, Math.round(ratio * slots)));
  const block = "█".repeat(filled);
  const colored = ratio >= 0.5 ? c.cyan(c.bold(block)) : c.cyan(block);
  return `${colored}${c.dim("░".repeat(slots - filled))}`;
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
  // A real-but-tiny amount rendered as "$0.00" reads as a data bug to a
  // technical audience; "<$0.01" says what actually happened.
  if (amount > 0 && amount < 0.005) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Compact token count: 2,140,000 -> "2.1M", 8,300 -> "8.3K". */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
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

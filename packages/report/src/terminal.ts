/* Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5 · CLI-adapted slop: pass */
import { roundUsdCents } from "./money.js";
import Table from "cli-table3";
import pc from "picocolors";
import {
  analyzeSpend,
  buildResultCard,
  classifyResultCardRecordBasis,
  computePlanChecks,
  formatApproxUsd,
  formatBilledUsdExact,
  formatCommittedPerMonth,
  generateCutList,
  buildRecommendedPlan,
  largestRemainderPercents,
  resultCardVocabulary,
  usageWindowDays,
  type ResultCardMode,
  type CostConfidence,
  type CutAction,
  type DeadContextResult,
  type DetectedPlan,
  type ResultCard,
  type ResultCardSubscriptionRow,
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

/** One footer CTA: a command the user can copy, and what it does. */
export type TerminalNextStep = {
  /** The literal command. Rendered bold; never wrapped or merged with prose. */
  command: string;
  /** What it does. Rendered dim, always separated from the command. */
  description?: string;
};

export type PlainEnglishSummaryOptions = {
  /** Records the summary was computed from (used to derive the cut list). */
  records: UsageRecord[];
  /**
   * Ranked action candidates, ALREADY derived from {@link records}. Supplied
   * by a caller that must render the identical candidate set on a second
   * surface (0.9.6: the machine-wide `report` artifact and this readout are
   * fed one array from one CLI call site, so the two can never diverge —
   * the founder-found regression where `--full` from home showed real
   * recommendations and the report from the same home showed none).
   *
   * Omitted — every library caller and project mode — derives the list here
   * exactly as before via {@link generateCutList}.
   */
  cutList?: readonly CutAction[];
  /** Drill-down dimension for the breakdown table. Defaults to "model". */
  groupBy?: GroupByDimension;
  /** Force-enable or force-disable color. Defaults to TTY auto-detection. */
  color?: boolean;
  /** Terminal width for bar rendering. Defaults to 72. */
  width?: number;
  /**
   * Evidence window in days for the canonical result card header (C-lane
   * §1.4 "30d window"). Defaults to 30; records must already be
   * window-scoped by the caller.
   */
  windowDays?: number;
  /**
   * Provider-side subscription plan facts (e.g. a priced Cursor plan) for
   * the result card's provider-only rows. Nothing detects these today;
   * absent entries render the honest §1.4 plan-not-priced variant.
   */
  providerPlans?: readonly {
    provider: string;
    planLabel: string | null;
    committedUsdPerMonth: number | null;
  }[];
  /**
   * Demo banner (sample data), real connected/synced data, or real usage
   * estimated from supported local coding-agent session evidence.
   */
  mode?: "demo" | "connected" | "local-logs";
  /**
   * Next-step CTA lines printed in the footer.
   *
   * A COMMAND step must be given as `{ command, description }`, never as one
   * hand-padded string (0.9.6). Every option handed to this function goes
   * through `sanitizeTerminalText`, which collapses `\s+` to a single space —
   * so `"npx aibill report              write a shareable report"` reached the
   * user as `"npx aibill report write a shareable report"` and the reader had
   * no way to see where the command ended. Structure survives sanitization;
   * padding does not.
   *
   * Plain strings remain supported for prose-only lines that carry no command.
   */
  nextSteps?: readonly (string | TerminalNextStep)[];
  /**
   * When the CLI entrypoint runs with telemetry enabled AND noticed, the
   * receipt's "nothing uploaded" claim is replaced by this line so the
   * printed privacy claim never understates what leaves the machine.
   */
  telemetryDisclosureLine?: string;
  /** Provider response completeness; independent from row-level confidence. */
  providerCoverage?: "complete" | "partial";
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
   * Optional canonical action projection supplied by the CLI. The report
   * renderer does not derive or verify these facts; it only places the one
   * evidence-backed insight, test, progress, and result into the compact card.
   */
  guidedAction?: {
    driverHeading: "MAIN DRIVER" | "TOP OBSERVED PROJECT";
    insightHeading: "WHY IS IT HIGH?" | "WHAT STANDS OUT" | "WHAT STANDS OUT IN INDEXED EVIDENCE";
    insightHeadline: string;
    insightDetail: string;
    actionHeadline: string;
    actionDetail: string;
    command: string;
    progress?: { headline: string; detail: string };
    result?: { headline: string; detail: string };
  };
  /**
   * Where this readout is being rendered from (0.9.5). From a broad root
   * ("machine-wide", e.g. the user's home directory) the full view's
   * project-scoped command pointers (apply, apply-artifact, watch, connect)
   * render with the same `cd /path/to/project && …` prefix the machine-wide report
   * summary uses, so a readout printed from home never advertises a command
   * that then friendly-refuses the broad root. Omitted or "project" renders
   * the bare commands exactly as before.
   */
  commandScope?: "project" | "machine-wide";
  /**
   * "compact" renders one decision receipt: trust, headline, primary driver,
   * coverage, one evidence-linked next step, and one details command.
   * "full" renders the complete diagnose→recommend→apply→verify readout.
   * "breakdown" is the focused drill-down for an explicit --group-by: the
   * headline, the requested table, its definition, and the data window —
   * without repeating the whole readout.
   *
   * Omitted remains equivalent to "full" for API compatibility. The CLI can
   * deliberately select the compact default without changing library callers.
   */
  view?: "compact" | "full" | "breakdown";
  /**
   * How much of the session-transcript evidence was actually read (0.9.6).
   *
   * The written artifact has always disclosed this; the readout did not, so
   * the terminal drew plan and candidate conclusions from partly-read
   * evidence with NO caveat while the artifact next to it disclosed the gap.
   * Two surfaces, one set of facts: whenever coverage is partial BOTH say so.
   *
   * This does not gate anything. Ranked candidates come from local financial
   * records, not transcripts, so an unread transcript cannot make them wrong
   * — it only means the transcript-derived analyses are not drafted yet.
   */
  qualitativeCoverage?: {
    status: "complete" | "partial" | "unknown";
    selectedFiles: number;
    readCompletely: number;
    skippedForBudget: number;
  };
};

/**
 * The readout's half of the shared coverage disclosure (0.9.6). Same counts,
 * same voice, same command as the artifact's banner.
 */
export function terminalCoverageCaveat(
  coverage: PlainEnglishSummaryOptions["qualitativeCoverage"]
): string | undefined {
  if (!coverage || coverage.status === "complete") return undefined;
  if (coverage.selectedFiles === 0) {
    return "No session transcripts were read for this window, so Context Health and configuration evidence are not drafted. " +
      "Candidates above come from local financial records.";
  }
  const remaining = Math.max(0, coverage.selectedFiles - coverage.readCompletely);
  return `${coverage.readCompletely} of ${coverage.selectedFiles} session transcripts read so far` +
    `${remaining > 0 ? ` (${remaining} still queued)` : ""}` +
    `${coverage.skippedForBudget > 0 ? `; ${coverage.skippedForBudget} ${coverage.skippedForBudget === 1 ? "file was" : "files were"} skipped by budget` : ""}. ` +
    "Candidates above come from local financial records and are unaffected; Context Health and configuration evidence wait on the rest — run npx aibill index.";
}

/**
 * Evidence-first terminal receipt: mode/trust, headline, sources, plan context,
 * actionable cuts, context evidence, Apply/Verify, then one deterministic
 * receipt CTA. Degrades gracefully (no color, ASCII) when not a TTY.
 */
export function generatePlainEnglishSummary(
  summary: SpendSummary,
  options: PlainEnglishSummaryOptions
): string {
  return renderPlainEnglishSummary(
    sanitizeTerminalMetadata(summary),
    sanitizeTerminalMetadata(options)
  );
}

function renderPlainEnglishSummary(
  summary: SpendSummary,
  options: PlainEnglishSummaryOptions
): string {
  const useColor = options.color ?? isColorTty();
  const c = makeColors(useColor);
  const width = options.width ?? 72;
  const groupBy = options.groupBy ?? "model";
  // One candidate set per invocation. A caller that also renders these
  // candidates into a written artifact hands the SAME array in, so the
  // terminal and the artifact are provably one derivation (0.9.6).
  const cutList = options.cutList ? [...options.cutList] : generateCutList(options.records);
  // Deduplicated so the modeled opportunity can never exceed the value it draws
  // from (overlapping recommendations are shown separately, non-additively).
  const plan = buildRecommendedPlan(cutList);
  const detectedPlans = options.detectedPlans ?? [];
  const subscriptionPlansDetected = detectedPlans.filter((detectedPlan) => detectedPlan.billing === "subscription");
  const subscriptionPersona = subscriptionPlansDetected.length > 0 && options.mode === "local-logs";
  const planChecks = computePlanChecks(options.records, detectedPlans);
  const primaryValueCheck = planChecks.find(
    (check) => check.detectedPlan?.billing === "subscription" && typeof check.valueMultiple === "number" && check.suggestedPlan
  );
  const presentationBasis = financialPresentationBasis(options.mode, options.records);
  const rawTotalUsd = options.records.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
  const hasHeadlineAmount = presentationBasis !== "connected_missing" &&
    presentationBasis !== "local_missing";
  // QA finding M2: record buckets follow the shared basis classifier, not
  // raw confidence words — an estimated dollar is API-equivalent ONLY when it
  // was priced at published API rates; other priced-but-unverified dollars
  // (beta connectors) are detected (unverified) and never join these bars.
  const cardBasisMode = resultCardModeFor(options.mode, options.records);
  const verifiedRecords = options.records.filter((record) => (
    classifyResultCardRecordBasis(record, cardBasisMode) === "provider_billed"
  ));
  const estimatedRecords = options.records.filter((record) => (
    classifyResultCardRecordBasis(record, cardBasisMode) === "api_equivalent"
  ));
  const detectedRecords = options.records.filter((record) => (
    classifyResultCardRecordBasis(record, cardBasisMode) === "detected_unverified"
  ));
  // Full and breakdown views also obey the no-blending rule. When the
  // evidence carries multiple accounting bases — connected data, or local
  // transcripts alongside beta-connector rows — the tables and hero use one
  // primary basis (provider-reported first), while the Evidence lines
  // disclose every other basis separately.
  const localMixed = options.mode === "local-logs" && detectedRecords.length > 0 &&
    (verifiedRecords.length > 0 || estimatedRecords.length > 0);
  const fullRecords = presentationBasis === "connected_mixed"
    ? verifiedRecords.length > 0
      ? verifiedRecords
      : estimatedRecords.length > 0
        ? estimatedRecords
        : detectedRecords
    : localMixed
      ? options.records.filter((record) => (
          classifyResultCardRecordBasis(record, cardBasisMode) !== "detected_unverified"
        ))
      : options.records;
  const fullPresentationBasis: FinancialPresentationBasis = presentationBasis === "connected_mixed"
    ? verifiedRecords.length > 0
      ? "provider_reported"
      : estimatedRecords.length > 0
        ? "connected_estimated"
        : "connected_unverified"
    : presentationBasis;
  const fullSummary = presentationBasis === "connected_mixed" || localMixed
    ? analyzeSpend(fullRecords)
    : summary;
  const fullRawTotalUsd = fullRecords.reduce((total, record) => total + (record.amountUsd ?? 0), 0);
  const fullHasHeadlineAmount = fullPresentationBasis !== "connected_missing" &&
    fullPresentationBasis !== "local_missing" && fullRecords.length > 0;
  const rawSourceAmounts = rawBreakdownAmounts(fullRecords, "source");
  const rawGroupAmounts = rawBreakdownAmounts(fullRecords, groupBy);

  if (options.view === "compact") {
    return renderCompactDecisionReceipt({
      summary,
      options,
      c,
      width,
      presentationBasis,
      rawTotalUsd,
      hasHeadlineAmount,
      cutList
    });
  }

  const lines: string[] = [];

  // --- Mode / trust, then headline ---------------------------------------
  lines.push("");
  lines.push(c.dim(rule(width)));
  lines.push(modeTrustLine(options.mode, summary.confidence, options.providerCoverage, presentationBasis, c));
  lines.push("");
  // C-lane §1.5: with detected subscriptions the --full hero IS the same
  // Subscriptions + Total + By-project card block as the default receipt —
  // one card contract, two zoom levels, not two framings. The single-basis
  // hero remains for the no-subscription fallback and the breakdown view.
  const fullResultCard = options.view !== "breakdown"
    ? buildResultCardForOptions(options)
    : undefined;
  const useCardHero = fullResultCard !== undefined && fullResultCard.subscriptions.length > 0;
  if (useCardHero) {
    // Evidence rides the --full card too (QA finding M2): with mixed bases,
    // the detected-unverified disclosure must exist somewhere on this screen.
    lines.push(...renderResultCardBlocks(fullResultCard, width, c, { includeEvidence: true }));
  } else {
  lines.push(
    `  ${c.bold(headlineMetricLabel(fullPresentationBasis))}  ${c.dim("evidence-labeled financial view")}`
  );
  // Local-log records are day-level session aggregates — calling them "calls"
  // overstates precision to the audience most likely to check.
  const recordNoun = options.mode === "local-logs"
    ? "session-day record"
    : options.mode === "demo"
      ? "illustrative record"
      : "provider record";
  const totalDescription = presentationBasis === "connected_mixed"
    ? `primary basis across ${fullSummary.recordCount} ${recordNoun}${fullSummary.recordCount === 1 ? "" : "s"}; other bases stay separate below`
    : options.mode === "demo"
      ? `combined illustrative evidence across ${fullSummary.recordCount} ${recordNoun}${fullSummary.recordCount === 1 ? "" : "s"}`
      : `tracked across ${fullSummary.recordCount} ${recordNoun}${fullSummary.recordCount === 1 ? "" : "s"}`;
  const headlineAmount = fullHasHeadlineAmount
    ? formatBigUsd(fullSummary.totalUsd, fullRawTotalUsd)
    : "Unavailable";
  lines.push(`  ${c.bold(evidenceAmount(headlineAmount, fullSummary.confidence, c))}  ${c.dim(totalDescription)}`);
  lines.push(
    `  ${confidenceBadge(summary.confidence, c)}  ${c.dim(`· evidence mix: ${coverageLine(summary, options.records)}`)}`
  );
  lines.push("");
  }

  // Focused drill-down: an explicit --group-by asks one question — render
  // just the answer (table + definition + data window), not the whole loop.
  if (options.view === "breakdown") {
    const focusedEntries = breakdownFor(fullSummary, groupBy);
    lines.push(c.bold(`  ${evidenceBreakdownLabel(fullPresentationBasis)} by ${groupByLabel(groupBy)}`) + c.dim(`  (--group-by ${dimensionFlags()})`));
    if (groupBy === "project" && options.mode === "local-logs") {
      lines.push(`  ${c.dim(localProjectDefinition())}`);
    }
    lines.push(`  ${c.dim(dataWindowLine(fullRecords))}`);
    lines.push("");
    lines.push(indentBlock(renderBreakdownTable(
      focusedEntries,
      fullSummary.totalUsd,
      c,
      useColor,
      evidenceAmountColumnLabel(fullPresentationBasis),
      "#",
      groupBy === "project" && options.mode === "local-logs",
      rawGroupAmounts,
      fullRawTotalUsd,
      fullHasHeadlineAmount,
      width,
      isApproximateBasis(fullPresentationBasis)
    ), "  "));
    lines.push("");
    lines.push(`  ${c.dim("run")} ${c.bold("npx aibill --full")} ${c.dim("for the full diagnose → recommend → apply → verify readout")}`);
    lines.push("");
    return renderTerminalLines(lines, width);
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
  const spendBars = renderSpendBars(
    fullSummary.bySource,
    fullSummary.totalUsd,
    c,
    rawSourceAmounts,
    fullRawTotalUsd,
    fullHasHeadlineAmount,
    isApproximateBasis(fullPresentationBasis)
  );
  if (spendBars.length > 0) {
    lines.push(c.bold(`  ${sourceBreakdownLabel(fullPresentationBasis)}`) + c.dim("  (by source)"));
    lines.push("");
    lines.push(...spendBars);
    lines.push("");
  }

  // Source attribution table. The plan comparison intentionally follows all
  // source evidence so a detected subscription can never redefine the money.
  const entries = breakdownFor(fullSummary, groupBy);
  lines.push(c.bold(`  ${evidenceBreakdownLabel(fullPresentationBasis)} by ${groupByLabel(groupBy)}`) + c.dim(`  (--group-by ${groupBy})`));
  if (groupBy === "project" && options.mode === "local-logs") {
    lines.push(`  ${c.dim(localProjectDefinition())}`);
  }
  lines.push(`  ${c.dim(dataWindowLine(fullRecords))}`);
  lines.push("");
  lines.push(indentBlock(renderBreakdownTable(
    entries,
    fullSummary.totalUsd,
    c,
    useColor,
    evidenceAmountColumnLabel(fullPresentationBasis),
    "#",
    groupBy === "project" && options.mode === "local-logs",
    rawGroupAmounts,
    fullRawTotalUsd,
    fullHasHeadlineAmount,
    width,
    // Parity nit: this is the SAME table --group-by renders — the tilde
    // discipline must match (both mark estimated bases approximate).
    isApproximateBasis(fullPresentationBasis)
  ), "  "));
  lines.push("");
  const topProject = summary.byProject[0];
  if (
    options.mode === "local-logs" &&
    groupBy === "project" &&
    topProject &&
    summary.totalUsd > 0 &&
    isUnattributedProjectKey(topProject.key)
  ) {
    const share = Math.round((topProject.amountUsd / summary.totalUsd) * 100);
    lines.push(`  ${c.yellow("ATTRIBUTION GAP")} ${share}% is not yet attributable to a project`);
    lines.push("");
  }

  // Plan context (detected locally and modeled against published list prices).
  lines.push(c.bold("  Plan context") + c.dim("  (subscription vs API; published list prices)"));
  lines.push("");
  if (subscriptionPlansDetected.length > 0 && options.mode !== "demo") {
    lines.push(
      `  ${c.yellow("DETECTED PLAN")} ${subscriptionPlansDetected.map((detectedPlan) => detectedPlan.planLabel).join(" · ")} ${c.dim("— detected from your agents' local config (read-only; nothing connected)")}`
    );
  }
  if (subscriptionPersona && primaryValueCheck) {
    lines.push(
      `  ${c.yellow(c.bold("COMPARED WITH"))} ${c.bold(`${primaryValueCheck.suggestedPlan!.name} ($${primaryValueCheck.suggestedPlan!.monthlyUsd}/mo)`)} ${c.dim("— API-equivalent usage is")} ${c.yellow(c.bold(`~${primaryValueCheck.valueMultiple}×`))} ${c.dim("the listed price")}`
    );
  }
  if (planChecks.length > 0) {
    for (const check of planChecks) {
      // Split the evidence label from its caveat to keep the lead line legible
      // at the default width; these remain modeled/detected, therefore amber.
      const [head, ...rest] = check.headline.split(" — ");
      lines.push(`  ${c.yellow("›")} ${head}`);
      if (rest.length > 0) lines.push(`    ${c.dim(rest.join(" — "))}`);
      if (check.upgradeHint) lines.push(`    ${c.yellow("!")} ${c.dim(check.upgradeHint)}`);
    }
    lines.push(
      planChecks.some((check) => check.detectedPlan)
        ? `  ${c.dim("published list-price comparison; no subscription account was accessed")}`
        : `  ${c.dim("published list-price comparison; no subscription account was connected")}`
    );
  } else if (subscriptionPlansDetected.length > 0) {
    lines.push(`  ${c.dim("Plan metadata was detected, but no comparable usage record matched it in this window.")}`);
  } else {
    lines.push(`  ${c.dim("No local subscription-plan metadata detected; keep usage evidence and plan price as separate evidence.")}`);
  }
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
    // 0.9.3 (founder feedback: "the five recommendations seem generic — only
    // the amount changes"): the same candidate-action kind+agent repeating
    // across projects renders as ONE grouped recommendation with per-project
    // amounts under it, followed by any different-kind items. Display-level
    // only — plan math, dedup, and the apply-artifact see the full list.
    // 0.9.6: selection/collapse/ordering moved into rankCutCandidates so the
    // written report renders the SAME candidates in the SAME order.
    const { candidates, minorCuts } = rankCutCandidates(cutList);
    for (const entry of candidates) {
      lines.push(...(entry.members.length === 1
        ? cutActionLines(entry.members[0]!, entry.rank, c, options.mode)
        : groupedCutActionLines(
            { sharedTitle: entry.title, members: [...entry.members] },
            entry.rank,
            c,
            options.mode
          )));
    }
    // Unchanged guard, restated: only when at least one NON-minor cut was
    // displayed (minor cuts are the exact complement of the visible set).
    if (minorCuts.length > 0 && minorCuts.length < cutList.length) {
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
        `  ${c.yellow(c.bold(formatUsd(observedValue)))} ${c.dim(`API-equivalent value observed in flagged daily aggregates — potential reduction and cash savings are not established`)}`
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
        `  ${c.yellow(c.bold(`~${formatUsd(plan.recommendedSavingsUsd)}/mo`))} ${c.dim(`modeled API-rate opportunity (deduplicated) — verify quality and the next provider report; projected from ${days} day${days === 1 ? "" : "s"} of data`)}`
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
  // 0.9.6: the artifact discloses partial transcript coverage and this readout
  // did not — so the terminal drew conclusions from partly-read evidence with
  // no caveat while the file next to it disclosed the gap. Both say it now.
  const coverageCaveat = terminalCoverageCaveat(options.qualitativeCoverage);
  if (coverageCaveat) {
    lines.push("");
    lines.push(`  ${c.dim(coverageCaveat)}`);
  }
  lines.push("");

  // Context evidence follows the actionable cuts: it explains why a context
  // hypothesis was surfaced without turning absence of invocation into proof.
  lines.push(...renderContextEvidence(options.deadContext, c));

  const hasActionCandidate = hasEvidenceActionCandidate(cutList, options.deadContext);
  // Every command is npx-prefixed: most users run via `npx aibill`
  // and have NO `aibill` on PATH — a bare command is a guaranteed
  // "command not found" for exactly the person who just got motivated.
  // From a broad root the project-scoped commands additionally carry the
  // machine-wide report's `cd /path/to/project && …` prefix (0.9.5): apply,
  // apply-artifact, watch, and connect friendly-refuse a broad root, and a
  // --full readout printed from home must never advertise a command that
  // then refuses to run where it was printed.
  const scoped = scopedCommandRenderer(options.commandScope);
  if (hasActionCandidate) {
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
  if (options.mode === "demo") {
    lines.push(
      `  ${c.cyan("›")} ${c.bold(scoped("npx aibill apply --sample"))}   ${c.dim("prints a NON-EXECUTABLE DEMO boundary; it does not authorize or propose a user change")}`
    );
    lines.push(
      `  ${c.dim(`    run npx aibill without --sample, or connect a provider, before generating an evidence-scoped Apply plan (long form: ${scoped("npx aibill apply-artifact")})`)}`
    );
  } else {
    lines.push(
      `  ${c.cyan("›")} ${c.bold(scoped("npx aibill apply"))}   ${c.dim("prints a paste-ready evidence, approval, rollback, and verification plan")}`
    );
    lines.push(
      `  ${c.dim(`    paste it into Claude Code / Codex — it carries the candidates above without authorizing a change (long form: ${scoped("npx aibill apply-artifact")})`)}`
    );
  }
  lines.push("");

  // ══ 4 · VERIFY ══════════════════════════════════════════════════════════
  }

  lines.push(sectionHeader(
    hasActionCandidate ? 4 : 3,
    "VERIFY",
    hasActionCandidate
      ? "prove the approved change worked before trusting it"
      : "keep collecting evidence; no action candidate is being advertised",
    c
  ));
  lines.push("");
  lines.push(
    `  ${c.cyan("›")} ${c.dim("re-run")} ${c.bold("npx aibill")} ${c.dim("after a few days and compare — or")} ${c.bold(scoped("npx aibill watch"))} ${c.dim("to track deltas per cycle")}`
  );
  if (options.mode === "local-logs") {
    lines.push(hasHeadlineAmount
      ? `  ${c.cyan("›")} ${c.dim("priced local values are API-equivalent estimates — no account was connected or authorized")}`
      : `  ${c.cyan("›")} ${c.dim("local activity was detected, but financial evidence is unavailable — no account was connected or authorized")}`
    );
    lines.push(
      `  ${c.cyan("›")} ${c.dim("pay for API usage too? set up an admin connector, then run its printed sync command:")} ${c.bold(scoped("npx aibill connect openai"))} ${c.dim("or")} ${c.bold(scoped("npx aibill connect anthropic"))}`
    );
  } else if (options.mode === "demo") {
    lines.push(
      `  ${c.cyan("›")} ${c.dim("these are illustrative SAMPLE API-equivalent estimates — no local logs or account data were used")}`
    );
    lines.push(
      `  ${c.cyan("›")} ${c.dim("want your own evidence? run without --sample, or set up an admin connector and sync it:")} ${c.bold(scoped("npx aibill connect openai"))} ${c.dim("or")} ${c.bold(scoped("npx aibill connect anthropic"))}`
    );
  } else {
    lines.push(
      `  ${c.cyan("›")} ${c.dim("re-sync official provider reporting with")} ${c.bold("npx aibill sync-provider")} ${c.dim("after the test; final invoices may still include credits, discounts, tax, or adjustments")}`
    );
  }
  lines.push("");

  // Supporting next steps stay ahead of the deterministic receipt CTA so the
  // last visible action is always the shareable evidence artifact.
  const nextSteps = options.nextSteps ?? defaultNextSteps(options.mode);
  if (nextSteps.length > 0) {
    lines.push(c.dim(rule(width)));
    lines.push(c.bold("  Next"));
    // The command column is shared across the block and the gap is REBUILT
    // here, after sanitization, so it cannot be collapsed away.
    const commandSteps = nextSteps.filter((step): step is TerminalNextStep => typeof step !== "string");
    const commandWidth = Math.max(0, ...commandSteps.map((step) => step.command.length));
    for (const step of nextSteps) {
      if (typeof step === "string") {
        lines.push(`  ${c.cyan("›")} ${step}`);
        continue;
      }
      if (step.description === undefined) {
        lines.push(`  ${c.cyan("›")} ${c.bold(step.command)}`);
        continue;
      }
      const aligned = 4 + commandWidth + 2 + step.description.length <= width;
      if (aligned) {
        lines.push(`  ${c.cyan("›")} ${c.bold(step.command.padEnd(commandWidth))}  ${c.dim(step.description)}`);
        continue;
      }
      // Too wide to align: the description drops to its own line rather than
      // running into the command with a single space.
      lines.push(`  ${c.cyan("›")} ${c.bold(step.command)}`);
      lines.push(`    ${c.dim(step.description)}`);
    }
    lines.push("");
  }
  lines.push(c.dim(rule(width)));
  lines.push(c.bold("  AI RECEIPT") + c.dim("  evidence labels + generic action candidates in one redacted card"));
  const receiptCommand = options.mode === "demo"
    ? "npx aibill report-card --sample"
    : "npx aibill report-card";
  lines.push(`  ${c.cyan("›")} ${c.bold(receiptCommand)}  ${c.dim("write a redacted, shareable SVG + caption")}`);
  lines.push("");

  return renderTerminalLines(lines, width);
}

type CompactDecisionReceiptInput = {
  summary: SpendSummary;
  options: PlainEnglishSummaryOptions;
  c: Colors;
  width: number;
  presentationBasis: FinancialPresentationBasis;
  rawTotalUsd: number;
  hasHeadlineAmount: boolean;
  cutList: CutAction[];
};

/**
 * The default CLI card should answer one decision, not reproduce the report.
 * It deliberately has no table, spinner, carousel, or secondary CTA, so it
 * remains readable at narrow widths and deterministic in copied output.
 */
function renderCompactDecisionReceipt(input: CompactDecisionReceiptInput): string {
  const {
    summary,
    options,
    c,
    width,
    presentationBasis,
    rawTotalUsd,
    hasHeadlineAmount,
    cutList
  } = input;
  // A connected receipt can contain both provider-reported money and modeled
  // value. Those are different accounting bases and must never be added into
  // one hero number or one driver share. In the mixed case, lead with the
  // provider-reported subset and keep every other basis separated in Evidence.
  const providerReportedRecords = options.records.filter((record) => (
    record.costConfidence === "verified" && typeof record.amountUsd === "number"
  ));
  const providerReportedRawTotal = providerReportedRecords.reduce(
    (total, record) => total + (record.amountUsd ?? 0),
    0
  );
  const isMixedConnected = presentationBasis === "connected_mixed";
  const driverRecords = isMixedConnected ? providerReportedRecords : options.records;
  const driverSummary = isMixedConnected ? analyzeSpend(driverRecords) : summary;
  const driverRawTotal = isMixedConnected ? providerReportedRawTotal : rawTotalUsd;
  const driverBasis: FinancialPresentationBasis = isMixedConnected
    ? "provider_reported"
    : presentationBasis;
  const trust = compactTrust(
    options.mode,
    summary.confidence,
    options.providerCoverage,
    presentationBasis,
    c,
    options.telemetryDisclosureLine
  );
  const headline = compactHeadline(
    presentationBasis,
    summary.totalUsd,
    rawTotalUsd,
    providerReportedRawTotal,
    providerReportedRecords.length > 0
  );
  const driver = compactPrimaryDriver(
    driverSummary,
    driverRecords,
    driverBasis,
    driverRawTotal,
    isMixedConnected ? providerReportedRecords.length > 0 : hasHeadlineAmount
  );
  const next = compactNextStep(options, cutList);
  const detailsCommand = options.mode === "demo"
    ? "npx aibill --sample --full"
    : "npx aibill --full";
  // C-lane §1.4: the default card renders per-subscription rows, the labeled
  // totals stack, by-project rows, and basis-worded Evidence lines FROM the
  // canonical result card. With no detected subscriptions the card falls back
  // to today's single-basis headline (§1.4 "no subscriptions" variant).
  const resultCard = buildResultCardForOptions(options);
  const hasSubscriptionCard = resultCard.subscriptions.length > 0;
  const lines: string[] = [
    "",
    `  ${c.bold("aibill")} ${c.dim("·")} ${trust.label}`,
    `  ${c.dim(trust.note)}`,
    ""
  ];
  if (hasSubscriptionCard) {
    lines.push(...renderResultCardBlocks(resultCard, width, c, { includeEvidence: true }));
  } else {
    lines.push(
      `  ${c.bold(evidenceAmount(headline.amount, summary.confidence, c))}`,
      `  ${c.dim(headline.label)}`,
      ""
    );
  }

  const guided = options.guidedAction;
  if (!hasSubscriptionCard && driver) {
    lines.push(...compactLabeledLines(guided?.driverHeading ?? driver.kind, driver.value, width, c));
  }
  if (!hasSubscriptionCard) {
    lines.push(...compactLabeledLines("Evidence", coverageLine(summary, options.records), width, c));
  }
  if (guided) {
    lines.push("");
    lines.push(c.bold(`  ${guided.insightHeading}`));
    lines.push(...wrapProseLine(`  ${c.bold(guided.insightHeadline)}`, width));
    lines.push(...wrapProseLine(`  ${c.dim(guided.insightDetail)}`, width));
    if (guided.progress) {
      lines.push("");
      lines.push(...compactLabeledLines("Progress", c.bold(guided.progress.headline), width, c));
      lines.push(`  ${c.dim(guided.progress.detail)}`);
    }
    if (guided.result) {
      lines.push("");
      lines.push(...compactLabeledLines("Result", c.bold(guided.result.headline), width, c));
      lines.push(`  ${c.dim(guided.result.detail)}`);
    }
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  lines.push(...compactLabeledLines("Next", c.bold(guided?.actionHeadline ?? next.title), width, c));
  lines.push(`  ${c.dim(guided?.actionDetail ?? next.evidence)}`);
  const nextCommand = guided?.command ?? next.command;
  if (nextCommand.includes("improve") || nextCommand.includes("apply")) {
    // improve/apply are project-scoped; a machine-wide receipt must say
    // where to stand before handing over a command that refuses broad
    // roots (0.9.3: the founder's home receipt pointed at `apply`, which
    // then refused his home directory).
    lines.push(`  ${c.dim("run it from the project folder you want to improve")}`);
  }
  lines.push(`  ${c.cyan("›")} ${c.bold(nextCommand)}`);
  lines.push("");
  lines.push(...compactLabeledLines("Details", c.bold(detailsCommand), width, c));
  lines.push("");
  if (options.mode === "demo") {
    // Static signup pointer on the sample exit only — never a prompt, safe
    // to record (capture design moments map). Keep byte-identical to the
    // CLI's signupCopy.samplePointer (pinned by cli signup tests).
    lines.push(`  ${c.dim("launch updates: npx aibill signup <email> · optional · email only")}`);
    lines.push("");
  }

  return renderTerminalLines(lines, width);
}

function compactTrust(
  mode: PlainEnglishSummaryOptions["mode"],
  confidence: CostConfidence,
  providerCoverage: PlainEnglishSummaryOptions["providerCoverage"],
  basis: FinancialPresentationBasis,
  c: Colors,
  telemetryDisclosureLine?: string
): { label: string; note: string } {
  if (mode === "demo") {
    return {
      label: c.yellow(c.bold("DEMO SAMPLE")),
      note: "illustrative only · no user data · no action authorized"
    };
  }
  if (mode === "local-logs") {
    return {
      label: c.yellow(c.bold("LOCAL ESTIMATE")),
      note: `private transcript evidence × published API rates · ${telemetryDisclosureLine ?? "nothing uploaded"}`
    };
  }
  if (mode === "connected" && providerCoverage === "partial") {
    return {
      label: c.yellow(c.bold("CONNECTED · PARTIAL")),
      note: "available rows keep their labels · some requested evidence is missing"
    };
  }
  if (mode === "connected" && basis === "connected_mixed") {
    return {
      label: c.yellow(c.bold("CONNECTED · MIXED EVIDENCE")),
      note: "provider-reported cost and modeled value are shown separately"
    };
  }
  if (mode === "connected" && confidence === "verified") {
    return {
      label: c.green(c.bold("CONNECTED · PROVIDER-REPORTED")),
      note: "official provider evidence · reconcile against the final invoice"
    };
  }
  if (mode === "connected") {
    return {
      label: c.yellow(c.bold(`CONNECTED · ${confidenceWord(confidence).toUpperCase()}`)),
      note: "connected evidence · not fully provider-verified"
    };
  }
  return {
    label: c.yellow(c.bold("ESTIMATED EVIDENCE")),
    note: "confirm the source before acting"
  };
}

function compactHeadline(
  basis: FinancialPresentationBasis,
  totalUsd: number,
  rawTotalUsd: number,
  providerReportedRawTotal = 0,
  hasProviderReportedAmount = false
): { amount: string; label: string } {
  const amount = formatBigUsd(totalUsd, rawTotalUsd);
  // §1.2 vocabulary: "cost/value" is killed copy; each label carries its
  // basis word instead. The local_estimate headline keeps the sanctioned
  // canonical form (§1.4 no-subscription fallback).
  switch (basis) {
    case "provider_reported":
      return { amount, label: "billed cost (provider-reported)" };
    case "local_estimate":
      return { amount: `~${amount}`, label: "API-equivalent value · not billed spend" };
    case "connected_estimated":
      return { amount: `~${amount}`, label: "connected API-equivalent (estimated)" };
    case "connected_unverified":
      return { amount: `~${amount}`, label: "connected detected (unverified)" };
    case "connected_mixed":
      return hasProviderReportedAmount
        ? {
            amount: formatBigUsd(providerReportedRawTotal, providerReportedRawTotal),
            label: "billed cost (provider-reported) · other evidence bases below"
          }
        : {
            amount: "Unavailable",
            label: "billed cost (provider-reported) · other evidence bases below"
          };
    case "connected_missing":
      return { amount: "Unavailable", label: "connected evidence · financial evidence missing" };
    case "local_missing":
      return { amount: "Unavailable", label: "local activity found · financial evidence missing" };
    default:
      // Demo sample: the window total is an exact sum of the bundled
      // illustrative records, so it renders bare — the full receipt already
      // prints $87.00 without a tilde and the two surfaces must agree
      // (tilde discipline: ~ marks modeled/monthly figures only).
      return { amount, label: "illustrative evidence" };
  }
}

type CompactDriver = {
  kind: "Primary driver" | "Primary activity";
  value: string;
};

function compactPrimaryDriver(
  summary: SpendSummary,
  records: readonly UsageRecord[],
  basis: FinancialPresentationBasis,
  rawTotalUsd: number,
  hasHeadlineAmount: boolean
): CompactDriver | undefined {
  // Project attribution is itself evidence. If the largest project bucket is
  // home/unattributed, disclose that gap instead of promoting a smaller named
  // project into a false "primary driver" claim.
  const topProject = summary.byProject[0];
  const connectedFinancialBasis = !["demo", "local_estimate", "local_missing"].includes(basis);
  const fallbackChoices: Array<{ dimension: GroupByDimension; entry: SpendBreakdownEntry | undefined }> = connectedFinancialBasis
    ? [
        { dimension: "source", entry: summary.bySource[0] },
        { dimension: "model", entry: summary.byModel[0] },
        { dimension: "agent", entry: summary.byAgent[0] }
      ]
    : [
        { dimension: "agent", entry: summary.byAgent[0] },
        { dimension: "model", entry: summary.byModel[0] },
        { dimension: "source", entry: summary.bySource[0] }
      ];
  const choices: Array<{ dimension: GroupByDimension; entry: SpendBreakdownEntry | undefined }> = topProject
    ? [
        { dimension: "project", entry: topProject },
        ...fallbackChoices
      ]
    : fallbackChoices;
  const choice = choices.find(({ entry }) => entry && !isPlaceholderBreakdownKey(entry.key)) ??
    choices.find(({ entry }) => entry && entry.key.trim().length > 0);
  if (!choice?.entry) return undefined;

  const rawAmount = rawBreakdownAmounts(records, choice.dimension).get(choice.entry.key) ?? choice.entry.amountUsd;
  const amountAvailable = hasHeadlineAmount && !(
    choice.entry.confidence === "missing" && rawAmount === 0
  );
  const label = choice.dimension === "project" && isUnattributedProjectKey(choice.entry.key)
    ? "Unattributed project"
    : `${labelOf(choice.entry.key)} · ${groupByLabel(choice.dimension)}`;
  if (!amountAvailable) {
    return {
      kind: "Primary activity",
      value: `${label} · financial evidence unavailable`
    };
  }

  const prefix = basis === "local_estimate" ? "~" : "";
  // §1.2: figures carry basis words — billed / API-equivalent — never "cost/value".
  const financialLabel = basis === "provider_reported"
    ? "billed"
    : basis === "local_estimate"
      ? "API-equivalent value"
      : "evidence";
  const share = rawTotalUsd > 0
    ? ` · ${formatPercent(rawAmount / rawTotalUsd)} of priced evidence`
    : " · share unavailable";
  return {
    kind: choice.dimension === "project" && isUnattributedProjectKey(choice.entry.key)
      ? "Primary activity"
      : "Primary driver",
    value: `${label} · ${prefix}${formatUsd(rawAmount)} ${financialLabel}${share}`
  };
}

function isPlaceholderBreakdownKey(key: string): boolean {
  return ["", "unmapped", "(unmapped)", "unknown", "(unknown)", "none"].includes(key.trim().toLowerCase());
}

type CompactNextStep = {
  title: string;
  evidence: string;
  command: string;
};

function compactNextStep(
  options: PlainEnglishSummaryOptions,
  cutList: CutAction[]
): CompactNextStep {
  if (options.mode === "demo") {
    return {
      title: "Read your own local evidence",
      evidence: "sample values are illustrative; no user change is authorized",
      // `init` needs one exact project folder, and `--sample` runs anywhere —
      // including a home directory, where the bare pointer refused (0.9.6).
      command: scopedCommandRenderer(options.commandScope)("npx aibill init")
    };
  }

  const action = buildRecommendedPlan(cutList).recommended[0] ?? cutList[0];
  if (action) {
    const unit = action.recordUnit === "daily-aggregates"
      ? `session-day aggregate${action.recordCount === 1 ? "" : "s"}`
      : action.recordUnit === "tools"
        ? `tool${action.recordCount === 1 ? "" : "s"}`
        : `call${action.recordCount === 1 ? "" : "s"}`;
    const value = options.mode === "local-logs"
      ? `~${formatUsd(action.affectedSpendUsd)} API-equivalent value`
      : `${formatUsd(action.affectedSpendUsd)} evidence`;
    return {
      title: action.title,
      evidence: `${action.recordCount} ${unit} · ${value} · ${confidenceWord(action.confidence)}`,
      command: "npx aibill apply"
    };
  }

  if (options.deadContext?.hasData && options.deadContext.deadCount > 0) {
    const count = options.deadContext.deadCount;
    return {
      title: `Inspect ${count} context candidate${count === 1 ? "" : "s"} with no matching invocation`,
      evidence: `${count} of ${options.deadContext.loadedCount} observable inventory items · candidate evidence, not removal proof`,
      command: "npx aibill apply"
    };
  }

  if (
    options.records.length === 0 ||
    options.records.every((record) => record.costConfidence === "missing" || typeof record.amountUsd !== "number")
  ) {
    return {
      title: "Inspect source coverage",
      evidence: "activity may exist, but no priced financial evidence is available",
      command: "npx aibill doctor --sources"
    };
  }

  if (options.mode === "connected") {
    return {
      title: "Inspect connected source coverage",
      evidence: "no evidence-backed action candidate was found in this window",
      command: "npx aibill doctor --sources"
    };
  }

  return {
    title: "Keep observing before changing anything",
    evidence: "no evidence-backed action candidate was found in this window",
    command: "npx aibill watch"
  };
}

function compactLabeledLines(label: string, value: string, width: number, c: Colors): string[] {
  if (width < 58) {
    return [`  ${c.dim(label.toUpperCase())}`, `  ${value}`];
  }
  return [`  ${c.dim(label.padEnd(14))} ${value}`];
}

// --- canonical result card blocks (C-lane design §1.4/§1.5/§3) -------------

function resultCardModeFor(
  mode: PlainEnglishSummaryOptions["mode"],
  records: readonly UsageRecord[]
): ResultCardMode {
  if (mode === "connected") {
    // C-lane §1.4 connected/mixed variants + QA M3: billed provider evidence
    // alongside local API-equivalent transcripts is the MIXED state — billed
    // leads the headline while the estimated axis (per-subscription ~ figures,
    // local by-project attribution) is never erased. Evidence that is purely
    // provider-reported stays "connected".
    const hasBilled = records.some((record) => (
      classifyResultCardRecordBasis(record, "connected") === "provider_billed"
    ));
    const hasApiEquivalent = records.some((record) => (
      classifyResultCardRecordBasis(record, "connected") === "api_equivalent"
    ));
    return hasBilled && hasApiEquivalent ? "mixed" : "connected";
  }
  return mode === "local-logs" ? "local-logs" : "demo";
}

function buildResultCardForOptions(options: PlainEnglishSummaryOptions): ResultCard {
  return buildResultCard({
    mode: resultCardModeFor(options.mode, options.records),
    windowDays: options.windowDays ?? 30,
    records: options.records,
    detectedPlans: options.detectedPlans ?? [],
    ...(options.providerPlans ? { providerPlans: options.providerPlans } : {})
  });
}

function resultCardConnectionWord(connection: ResultCardSubscriptionRow["connection"]): string {
  return connection === "connected" ? "connected" : "detected";
}

const nr = resultCardVocabulary.notReportedShort;

/** Wide (≥58 col) subscription row — §1.4 canonical geometry. */
function wideSubscriptionRow(row: ResultCardSubscriptionRow): string {
  const prefix = `    ${row.id.padEnd(10)}`;
  const planCell = (row.planLabel ?? resultCardConnectionWord(row.connection)).padEnd(12);
  if (row.committedUsdPerMonth === null) {
    return `${prefix}${planCell}committed ${nr} · ${bareValueCell(row)}`;
  }
  const committedCell = `${formatCommittedPerMonth(row.committedUsdPerMonth).padStart(7)} committed`;
  return `${prefix}${planCell}${committedCell}${alignedValueCell(row)}`;
}

/** Right-aligned money cell following "committed" (amounts land on one column). */
function alignedValueCell(row: ResultCardSubscriptionRow): string {
  if (row.apiEquivalentUsd !== null && row.providerBilledUsd !== null) {
    return `${formatApproxUsd(row.apiEquivalentUsd).padStart(10)} API-equivalent · ` +
      `${formatBilledUsdExact(row.providerBilledUsd)} billed`;
  }
  if (row.apiEquivalentUsd !== null) {
    return `${formatApproxUsd(row.apiEquivalentUsd).padStart(10)} API-equivalent`;
  }
  if (row.providerBilledUsd !== null) {
    return `${formatBilledUsdExact(row.providerBilledUsd).padStart(10)} billed`;
  }
  return `     ${bareValueCell(row)}`;
}

/** The row's money statement without column alignment (narrow + committed-n/r). */
function bareValueCell(row: ResultCardSubscriptionRow): string {
  if (row.apiEquivalentUsd !== null) {
    return `${formatApproxUsd(row.apiEquivalentUsd)} API-equivalent`;
  }
  if (row.providerBilledUsd !== null) {
    return `${formatBilledUsdExact(row.providerBilledUsd)} billed`;
  }
  // Evidence absent is never $0: agent rows are missing API-equivalent
  // evidence; provider-only rows are missing billed evidence (§1.2).
  return row.agentId !== null ? `API-equivalent ${nr}` : `billed ${nr}`;
}

type ResultCardTotalStack = {
  parts: string[];
  amountKinds: number;
};

/**
 * "Then the total" — the labeled per-basis stack (§1.3). One figure per kind
 * of money, always committed → API-equivalent → billed, never summed across
 * kinds. A basis prints `n/r` when a source for it exists but reported
 * nothing; a basis with no verified-capable source is omitted (cursor beta).
 */
function resultCardTotalStack(card: ResultCard): ResultCardTotalStack {
  const parts: string[] = [];
  let amountKinds = 0;
  const committed = card.totals.subscriptionCommitted;
  if (committed.amountUsd !== null) {
    amountKinds += 1;
    const partial = committed.pricedSubs < committed.totalSubs
      ? ` (${committed.pricedSubs}/${committed.totalSubs} priced)`
      : "";
    parts.push(`committed ${formatCommittedPerMonth(committed.amountUsd)}${partial}`);
  } else if (committed.totalSubs > 0) {
    parts.push(`committed ${nr}`);
  }
  const hasAgentRows = card.subscriptions.some((row) => row.agentId !== null);
  if (card.totals.apiEquivalent.amountUsd !== null) {
    amountKinds += 1;
    parts.push(`API-equivalent ${formatApproxUsd(card.totals.apiEquivalent.amountUsd)}`);
  } else if (hasAgentRows) {
    parts.push(`API-equivalent ${nr}`);
  }
  if (card.totals.providerBilled.amountUsd !== null) {
    amountKinds += 1;
    parts.push(`billed ${formatBilledUsdExact(card.totals.providerBilled.amountUsd)}`);
  }
  return { parts, amountKinds };
}

/**
 * QA finding M1: a basis total spans the ENTIRE basis (§1.1), so usage from
 * agents with no subscription row (e.g. codex on an API key) can exceed the
 * row sums. Every such gap is explained ON the card — a total may never
 * silently disagree with the rows above it.
 */
function resultCardTotalGapNotes(card: ResultCard, narrow: boolean): string[] {
  const notes: string[] = [];
  const rowApi = card.subscriptions
    .reduce((total, row) => total + (row.apiEquivalentUsd ?? 0), 0);
  const apiTotal = card.totals.apiEquivalent.amountUsd;
  if (apiTotal !== null && apiTotal - rowApi > 0.005) {
    const gap = formatApproxUsd(apiTotal - rowApi);
    notes.push(narrow
      ? `includes ${gap} with no detected subscription`
      : `includes ${gap} from agents without a detected subscription`);
  }
  const rowBilled = card.subscriptions
    .reduce((total, row) => total + (row.providerBilledUsd ?? 0), 0);
  const billedTotal = card.totals.providerBilled.amountUsd;
  if (billedTotal !== null && billedTotal - rowBilled > 0.005) {
    const gap = formatBilledUsdExact(billedTotal - rowBilled);
    notes.push(narrow
      ? `includes ${gap} billed outside these rows`
      : `includes ${gap} billed from sources without a subscription row`);
  }
  return notes;
}

function resultCardTotalNotes(card: ResultCard, stack: ResultCardTotalStack, anyNr: boolean): string[] {
  // The gap note leads: it directly explains the Total arithmetic (M1).
  const notes: string[] = [...resultCardTotalGapNotes(card, false)];
  // No stack theater for one row (§1.4 single-sub variant).
  if (stack.amountKinds >= 2 && card.subscriptions.length > 1) {
    const word = stack.amountKinds === 2 ? "two" : "three";
    notes.push(`${word} kinds of money — never added into one number`);
  }
  for (const row of card.subscriptions) {
    if (row.detectedUnverifiedUsd !== null) {
      notes.push(`${row.id} beta: billed unlocks after live verification`);
    }
  }
  if (anyNr) {
    const agentRows = card.subscriptions.filter((row) => row.agentId !== null);
    const zeroUsage = agentRows.length > 0 &&
      agentRows.every((row) => row.apiEquivalentUsd === null) &&
      card.totals.apiEquivalent.amountUsd === null;
    notes.push(zeroUsage
      ? `${resultCardVocabulary.notReportedLegend} — no usage evidence in this window yet`
      : `${resultCardVocabulary.notReportedLegend} — no evidence in this window`);
  }
  return notes;
}

function resultCardProjectAmount(card: ResultCard, amountUsd: number): string {
  return card.byProject?.basis === "provider_billed"
    ? `${formatBilledUsdExact(amountUsd)} billed`
    : formatApproxUsd(amountUsd);
}

type ResultCardProjectLine = {
  named: string[];
  unattributed: string | undefined;
  everythingElse: string | undefined;
};

function resultCardProjectSegments(card: ResultCard): ResultCardProjectLine | undefined {
  const byProject = card.byProject;
  if (!byProject) return undefined;
  const weights = [
    ...byProject.rows.map((row) => row.amountUsd),
    ...(byProject.everythingElse ? [byProject.everythingElse.amountUsd] : [])
  ];
  const percents = largestRemainderPercents(weights);
  const named: string[] = [];
  let unattributed: string | undefined;
  byProject.rows.forEach((row, index) => {
    const segment = `${row.project} ${resultCardProjectAmount(card, row.amountUsd)} (${percents[index]}%)`;
    if (row.unattributed) {
      unattributed = segment;
    } else {
      named.push(segment);
    }
  });
  const everythingElse = byProject.everythingElse
    ? `${resultCardVocabulary.everythingElse} ${resultCardProjectAmount(card, byProject.everythingElse.amountUsd)} ` +
      `(${percents[byProject.rows.length]}% · ${byProject.everythingElse.projectCount} ` +
      `project${byProject.everythingElse.projectCount === 1 ? "" : "s"})`
    : undefined;
  return { named, unattributed, everythingElse };
}

function resultCardEvidenceLines(card: ResultCard): string[] {
  const lines: string[] = [];
  if (card.totals.apiEquivalent.amountUsd !== null) {
    lines.push(`${formatApproxUsd(card.totals.apiEquivalent.amountUsd)} API-equivalent (estimated)`);
  }
  if (card.totals.providerBilled.amountUsd !== null) {
    // "provider-reported" survives only here: explaining where billed comes from (§1.2).
    lines.push(`${formatBilledUsdExact(card.totals.providerBilled.amountUsd)} billed (provider-reported, verified)`);
  }
  for (const row of card.subscriptions) {
    if (row.detectedUnverifiedUsd !== null) {
      lines.push(
        `${formatBilledUsdExact(row.detectedUnverifiedUsd)} ${row.id} ` +
        resultCardVocabulary.detectedUnverifiedSuffix
      );
    }
  }
  return lines;
}

/**
 * Subscriptions + Total (+ By project, + Evidence) — the §1.4 card blocks.
 * Wide layouts use the canonical column geometry; below 58 columns every
 * labeled line splits label-above-value and sub rows drop the plan column.
 */
function renderResultCardBlocks(
  card: ResultCard,
  width: number,
  c: Colors,
  options: { includeEvidence: boolean }
): string[] {
  if (card.subscriptions.length === 0) return [];
  const stack = resultCardTotalStack(card);
  const projects = resultCardProjectSegments(card);
  const evidenceLines = options.includeEvidence ? resultCardEvidenceLines(card) : [];
  const lines: string[] = [];

  if (width < 58) {
    const subRows = card.subscriptions.map((row) => {
      const committedPart = row.committedUsdPerMonth === null
        ? `committed ${nr}`
        : `${formatCommittedPerMonth(row.committedUsdPerMonth)} committed`;
      const valuePart = row.apiEquivalentUsd !== null
        ? formatApproxUsd(row.apiEquivalentUsd)
        : bareValueCell(row);
      return `  ${row.id} ${committedPart} · ${valuePart}`;
    });
    const anyNr = [...subRows, ...stack.parts].some((line) => line.includes(nr));
    const anyApprox = [...subRows, ...stack.parts].some((line) => line.includes("~"));
    lines.push(`  ${c.dim(`SUBSCRIPTIONS (${card.windowDays}D)`)}`);
    lines.push(...subRows);
    lines.push(`  ${c.dim("TOTAL")}`);
    lines.push(...stack.parts.map((part) => `  ${part}`));
    lines.push(...resultCardTotalGapNotes(card, true).map((note) => `  ${c.dim(note)}`));
    const legendParts = [
      ...(anyApprox ? [resultCardVocabulary.estimatedMarkerLegend] : []),
      ...(anyNr ? [resultCardVocabulary.notReportedLegend] : [])
    ];
    if (legendParts.length > 0) {
      const joinedLegend = legendParts.join(" · ");
      // QA MINOR-1: a legend must never wrap mid-phrase — below the joined
      // width each part gets its own line.
      if ([...joinedLegend].length + 2 <= width) {
        lines.push(`  ${c.dim(joinedLegend)}`);
      } else {
        lines.push(...legendParts.map((part) => `  ${c.dim(part)}`));
      }
    }
    for (const row of card.subscriptions) {
      if (row.detectedUnverifiedUsd !== null) {
        lines.push(`  ${c.dim(`${row.id} beta: billed unlocks after live verification`)}`);
      }
    }
    if (projects) {
      lines.push("");
      lines.push(`  ${c.dim("BY PROJECT")}`);
      for (const segment of [...projects.named, projects.unattributed, projects.everythingElse]) {
        if (segment) lines.push(`  ${segment}`);
      }
    }
    if (evidenceLines.length > 0) {
      lines.push("");
      lines.push(`  ${c.dim("EVIDENCE")}`);
      lines.push(...evidenceLines.map((line) => `  ${line}`));
    }
    lines.push("");
    return lines;
  }

  lines.push(`  ${c.bold("Subscriptions")}   ${c.dim(`${card.windowDays}d window`)}`);
  const subRows = card.subscriptions.map((row) => wideSubscriptionRow(row));
  lines.push(...subRows);
  lines.push(`  ${c.bold("Total")}   ${stack.parts.join(" · ")}`);
  const anyNr = [...subRows, ...stack.parts].some((line) => line.includes(nr));
  for (const note of resultCardTotalNotes(card, stack, anyNr)) {
    lines.push(`          ${c.dim(note)}`);
  }
  if (projects) {
    lines.push("");
    const projectLines = [
      ...(projects.named.length > 0 ? [projects.named.join(" · ")] : []),
      ...(projects.unattributed ? [projects.unattributed] : []),
      ...(projects.everythingElse ? [projects.everythingElse] : [])
    ];
    projectLines.forEach((line, index) => {
      lines.push(index === 0
        ? `  ${c.bold("By project".padEnd(15))}${line}`
        : `                 ${line}`);
    });
  }
  if (evidenceLines.length > 0) {
    lines.push("");
    evidenceLines.forEach((line, index) => {
      lines.push(index === 0
        ? `  ${c.bold("Evidence".padEnd(15))}${line}`
        : `                 ${line}`);
    });
  }
  lines.push("");
  return lines;
}

function hasEvidenceActionCandidate(
  cutList: readonly CutAction[],
  deadContext: DeadContextResult | undefined
): boolean {
  return cutList.length > 0 || Boolean(deadContext?.hasData && deadContext.deadCount > 0);
}

/** Numbered stage banner: `── 2 · RECOMMEND ──  blurb`. */
function sectionHeader(step: number, name: string, blurb: string, c: Colors): string {
  return `  ${c.dim("──")} ${c.bold(c.cyan(`${step} · ${name}`))} ${c.dim("──")}  ${c.dim(blurb)}`;
}

function modeTrustLine(
  mode: PlainEnglishSummaryOptions["mode"],
  confidence: CostConfidence,
  providerCoverage: PlainEnglishSummaryOptions["providerCoverage"],
  basis: FinancialPresentationBasis,
  c: Colors
): string {
  const prefix = c.dim("  MODE / TRUST");
  if (mode === "demo") {
    return `${prefix}  ${c.yellow(c.bold("DEMO SAMPLE"))}\n  ${c.dim("illustrative only · not one invoice or homogeneous spend basis")}`;
  }
  if (mode === "local-logs") {
    return `${prefix}  ${c.yellow(c.bold("LOCAL ESTIMATE"))}\n  ${c.dim("transcript evidence × published API rates · not billed spend")}`;
  }
  if (mode === "connected" && providerCoverage === "partial") {
    return `${prefix}  ${c.yellow(c.bold("CONNECTED · PARTIAL COVERAGE"))}\n  ${c.dim("available rows keep their financial evidence labels; some requested data was not returned")}`;
  }
  if (mode === "connected" && basis === "connected_mixed") {
    return `${prefix}  ${c.yellow(c.bold("CONNECTED · MIXED EVIDENCE"))}\n  ${c.dim("provider-reported cost and modeled value are never added together")}`;
  }
  if (mode === "connected" && confidence === "verified") {
    return `${prefix}  ${c.green(c.bold("CONNECTED · PROVIDER-REPORTED"))}\n  ${c.dim("reconcile against the final invoice")}`;
  }
  if (mode === "connected") {
    return `${prefix}  ${c.yellow(c.bold(`CONNECTED · ${confidenceWord(confidence).toUpperCase()}`))}\n  ${c.dim("not fully provider-verified")}`;
  }
  return `${prefix}  ${c.yellow(c.bold("ESTIMATED EVIDENCE"))}\n  ${c.dim("confirm the source before acting")}`;
}

/** "window: 14 days of data (2026-06-20 → 2026-07-04)" for drill-down tables. */
function dataWindowLine(records: UsageRecord[]): string {
  const days = [...new Set(records.map((record) => record.timestamp.slice(0, 10)))].sort();
  if (days.length === 0) return "window: no dated records";
  const span = days.length === 1 ? days[0] : `${days[0]} → ${days[days.length - 1]}`;
  return `window: ${days.length} day${days.length === 1 ? "" : "s"} of data (${span})`;
}

type CollapsedCutEntry = {
  /** Shared headline: the title up to its first " · " project suffix. */
  sharedTitle: string;
  members: CutAction[];
};

/**
 * Group the per-project fan-out of ONE candidate action, e.g. "Investigate
 * cumulative context in claude-code · <project>" × 5. Only a repeat
 * collapses; ordering keeps each entry at its first member's rank. Pure
 * display grouping — no math is altered.
 *
 * DELIBERATELY restricted to kind === "context_trim": that is the only kind
 * whose builder fans one candidate out per (agent, project) with the project
 * as a " · " title suffix, so members provably share one action and one
 * agent. Other kinds can produce IDENTICAL titles for genuinely DIFFERENT
 * actions — two `cache` actions on the same operation but different
 * model/fingerprint, two `batch` actions from different sources — and
 * merging those would fabricate a group ("across 2 projects — this project …
 * · this project …") and quote one member's guidance for both. Do not
 * generalize this key without a per-kind proof like context_trim's.
 */
function collapseRepeatedCutActions(actions: readonly CutAction[]): CollapsedCutEntry[] {
  const entries: CollapsedCutEntry[] = [];
  const byKey = new Map<string, CollapsedCutEntry>();
  for (const action of actions) {
    if (action.kind !== "context_trim") {
      entries.push({ sharedTitle: action.title, members: [action] });
      continue;
    }
    const sharedTitle = action.title.split(" · ")[0]!;
    const key = `${action.kind}::${action.impactBasis}::${sharedTitle}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.members.push(action);
      continue;
    }
    const entry: CollapsedCutEntry = { sharedTitle, members: [action] };
    byKey.set(key, entry);
    entries.push(entry);
  }
  return entries;
}

/** Project label for the grouped across-line: the title's " · " suffix. */
function cutProjectLabel(action: CutAction): string {
  const separator = action.title.indexOf(" · ");
  return separator === -1 ? "this project" : action.title.slice(separator + 3);
}

const confidenceRank: Record<string, number> = { detected_unverified: 0, estimated: 1, verified: 2 };

/**
 * ONE ranked action-candidate set, shared by every surface that shows the
 * user "what to investigate" (0.9.6).
 *
 * The founder-found regression this exists to make impossible: `--full` from
 * home rendered real ranked candidates while the `report` artifact written
 * from the SAME home rendered none, because the two surfaces derived (or
 * failed to derive) their candidates independently. Selection, collapsing,
 * ordering, and the display facts now live here; each surface only decides
 * how to PAINT them (ANSI, Markdown, HTML).
 *
 * Do not re-implement the filter/collapse/slice anywhere else — call this.
 */
export type RankedCutCandidate = {
  /** 1-based rank, matching the number the terminal readout prints. */
  rank: number;
  /**
   * The title as displayed. A lone candidate keeps its full title (project
   * suffix included); a repeated per-project fan-out shows the shared
   * headline, with the projects carried in {@link projectLabels}.
   */
  title: string;
  /** The shared read-only instruction, minus any per-project count sentence. */
  guidance: string;
  members: readonly CutAction[];
  /** Per-project labels, largest observed value first (grouped entries only). */
  projectLabels: readonly string[];
  /** Per-project observed value, index-aligned with {@link projectLabels}. */
  projectAffectedSpendUsd: readonly number[];
  recordCount: number;
  recordUnit: CutAction["recordUnit"];
  affectedSpendUsd: number;
  estimatedMonthlySavingsUsd: number;
  /** True when the evidence proves exposure only — reduction is unproven. */
  observed: boolean;
  /** The weakest member's confidence: a group is never stronger than its parts. */
  confidence: CostConfidence;
};

export type RankedCutCandidates = {
  /** At most 5 displayed candidates, in rank order. */
  candidates: RankedCutCandidate[];
  /** Sub-$1/mo modeled cuts collapsed out of the display (still in the math). */
  minorCuts: CutAction[];
};

export function rankCutCandidates(cutList: readonly CutAction[]): RankedCutCandidates {
  // Sub-$1/mo cuts are noise on a readout (often near-duplicates of a big
  // cut). They still count in the plan math and still ship in the artifact.
  const visibleCuts = cutList.filter((action) => (
    action.impactBasis === "observed_value_no_counterfactual" ||
    action.estimatedMonthlySavingsUsd >= 1
  ));
  const minorCuts = cutList.filter((action) => (
    action.impactBasis === "modeled_savings" &&
    action.estimatedMonthlySavingsUsd < 1
  ));
  const shown = visibleCuts.length > 0 ? visibleCuts : [...cutList];
  const candidates = collapseRepeatedCutActions(shown).slice(0, 5).map((entry, index) => {
    const members = entry.members;
    const ranked = [...members].sort((a, b) => b.affectedSpendUsd - a.affectedSpendUsd);
    const guidanceSource = members[0]!.action;
    const guidanceStart = guidanceSource.indexOf(". ");
    const weakest = [...members].sort((a, b) =>
      (confidenceRank[a.confidence] ?? 0) - (confidenceRank[b.confidence] ?? 0))[0]!;
    return {
      rank: index + 1,
      // A lone entry keeps the full title the terminal prints for it; only a
      // real group trades the project suffix for the across-line.
      title: members.length === 1 ? members[0]!.title : entry.sharedTitle,
      guidance: members.length === 1
        ? guidanceSource
        : guidanceStart === -1 ? guidanceSource : guidanceSource.slice(guidanceStart + 2),
      members,
      projectLabels: members.length === 1 ? [] : ranked.map(cutProjectLabel),
      projectAffectedSpendUsd: members.length === 1
        ? []
        : ranked.map((action) => action.affectedSpendUsd),
      recordCount: members.reduce((total, action) => total + action.recordCount, 0),
      recordUnit: members[0]!.recordUnit,
      affectedSpendUsd: members.reduce((total, action) => total + action.affectedSpendUsd, 0),
      estimatedMonthlySavingsUsd: members.reduce(
        (total, action) => total + action.estimatedMonthlySavingsUsd, 0
      ),
      observed: members[0]!.impactBasis === "observed_value_no_counterfactual",
      confidence: weakest.confidence
    } satisfies RankedCutCandidate;
  });
  return { candidates, minorCuts };
}

function groupedCutActionLines(
  entry: CollapsedCutEntry,
  rank: number,
  c: Colors,
  mode: PlainEnglishSummaryOptions["mode"]
): string[] {
  const members = entry.members;
  const observed = members[0]!.impactBasis === "observed_value_no_counterfactual";
  const totalSavings = members.reduce((total, action) => total + action.estimatedMonthlySavingsUsd, 0);
  const opportunity = mode === "demo"
    ? c.yellow(c.bold(`illustrative model ~${formatUsd(totalSavings)}/mo`))
    : observed
    ? c.yellow(c.bold("reduction unproven"))
    : c.yellow(c.bold(`model ~${formatUsd(totalSavings)}/mo`));
  const head = `  ${c.bold(`${rank}.`)} ${c.bold(entry.sharedTitle)}  ${opportunity}`;
  // Per-project detail, largest window value first; ~rounded dollars keep the
  // line honest about precision without repeating five near-identical blocks.
  const ranked = [...members].sort((a, b) => b.affectedSpendUsd - a.affectedSpendUsd);
  const across = ranked.slice(0, 4).map((action) =>
    `${cutProjectLabel(action)} ~$${Math.round(action.affectedSpendUsd).toLocaleString("en-US")}`);
  if (ranked.length > 4) across.push(`+ ${ranked.length - 4} more`);
  const acrossLine = `     ${c.dim(`across ${members.length} projects — ${across.join(" · ")}`)}`;
  // The shared instruction: the action copy minus its leading per-project
  // count sentence (every member carries the same guidance tail).
  const guidanceSource = members[0]!.action;
  const guidanceStart = guidanceSource.indexOf(". ");
  const guidance = guidanceStart === -1 ? guidanceSource : guidanceSource.slice(guidanceStart + 2);
  const detail = `     ${c.dim(guidance)}`;
  const recordCount = members.reduce((total, action) => total + action.recordCount, 0);
  const affectedTotal = members.reduce((total, action) => total + action.affectedSpendUsd, 0);
  const unit = members[0]!.recordUnit === "daily-aggregates"
    ? `daily aggregate${recordCount === 1 ? "" : "s"}`
    : members[0]!.recordUnit === "tools"
      ? `tool${recordCount === 1 ? "" : "s"}`
      : `call${recordCount === 1 ? "" : "s"}`;
  const valueLabel = observed
    ? `${formatUsd(affectedTotal)} API-equivalent value observed in window`
    : `${formatUsd(affectedTotal)} in window`;
  const weakest = [...members].sort((a, b) =>
    (confidenceRank[a.confidence] ?? 0) - (confidenceRank[b.confidence] ?? 0))[0]!;
  const grounding = `     ${c.dim(`${recordCount} ${unit} · ${valueLabel} · ${confidenceWord(weakest.confidence)}`)}`;
  return [head, acrossLine, detail, grounding, ""];
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
    : c.yellow(c.bold(`model ~${formatUsd(action.estimatedMonthlySavingsUsd)}/mo`));
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

function renderContextEvidence(dc: DeadContextResult | undefined, c: Colors): string[] {
  const lines = [
    c.bold("  Context evidence") + c.dim("  (configured/catalogued inventory vs observed invocation)"),
    ""
  ];

  if (!dc || !dc.hasData) {
    lines.push(`  ${c.dim("No context-inventory evidence available; no context action inferred.")}`);
    lines.push("");
    return lines;
  }

  if (dc.deadCount === 0 && !dc.isSample) {
    lines.push(
      `  ${c.green("none found")} ${c.dim(`— all ${dc.loadedCount} observable inventory item${dc.loadedCount === 1 ? "" : "s"} had matching use in ${dc.windowDays} days`)}`
    );
    lines.push("");
    return lines;
  }

  if (dc.deadCount === 0) {
    lines.push(`  ${c.yellow("SAMPLE")} ${c.dim("no illustrative context candidate in this fixture")}`);
    lines.push("");
    return lines;
  }

  const pct = Math.round(dc.wastePercent * 100);
  const sampleLabel = dc.isSample ? ` ${c.yellow("SAMPLE")}` : "";
  lines.push(
    `  ${c.bold(`inspect ${dc.deadCount} context candidate${dc.deadCount === 1 ? "" : "s"} with no matching invocation`)}${sampleLabel}`
  );
  lines.push(
    `  ${c.dim(`${dc.deadCount} of ${dc.loadedCount} observable inventory items (${pct}%) · candidate evidence, not removal or waste proof`)}`
  );
  if (dc.measuredDeadCount > 0 && dc.monthlyDeadTokens > 0) {
    const plural = dc.measuredDeadCount === 1 ? "" : "s";
    lines.push(
      `  ${c.yellow(c.bold(`~${formatTokens(dc.monthlyDeadTokens)} modeled catalog tokens/mo`))} ` +
        c.dim(`from ${dc.measuredDeadCount} skill${plural}/agent${plural} · modeled context cost ~${formatUsd(dc.monthlyUsd)}/mo · estimated`)
    );
  }
  if (dc.unmeasuredDeadCount > 0) {
    const plural = dc.unmeasuredDeadCount === 1 ? "" : "s";
    lines.push(
      `  ${c.dim(`${dc.unmeasuredDeadCount} MCP server${plural}: loading/token weight unmeasured · verify host loading and future need before any change`)}`
    );
  }
  if (dc.isSample) {
    lines.push(`  ${c.dim("illustrative only — a real run inventories this user's own skills, agents, and MCP")}`);
  }
  lines.push("");
  return lines;
}

/** §1.2 marker rule: `~` rides EVERY figure of the API-equivalent basis. */
function isApproximateBasis(basis: FinancialPresentationBasis): boolean {
  return basis === "local_estimate" || basis === "connected_estimated";
}

function renderBreakdownTable(
  entries: SpendBreakdownEntry[],
  total: number,
  c: Colors,
  useColor: boolean,
  amountLabel = "Evidence",
  recordLabel = "#",
  labelUnattributedProject = false,
  rawAmounts: ReadonlyMap<string, number> = new Map(),
  rawTotal = total,
  amountsAvailable = true,
  maxWidth = 72,
  approximate = false
): string {
  if (entries.length === 0) {
    return c.dim("(no breakdown available for this dimension)");
  }

  // Parity D3: a capped table must never truncate silently — the hidden
  // remainder gets an explicit "+N more" row so visible rows + remainder
  // always reconcile to the printed header total.
  const rowCap = 10;
  const hiddenEntries = entries.slice(rowCap);
  // Founder's live machine: an independently rounded remainder made the
  // rows sum a penny off the header total ($2,192.30 vs $2,192.31). The
  // remainder is therefore computed as the DISPLAYED header total minus the
  // DISPLAYED row values, so the column reconciles by construction
  // whichever way the per-row roundings fell.
  const shownDisplayedUsd = entries.slice(0, rowCap).reduce((sum, entry) => {
    const rawAmount = rawAmounts.get(entry.key) ?? entry.amountUsd;
    const displayAmount = rawAmount > 0 && rawAmount < 0.01 ? rawAmount : entry.amountUsd;
    return sum + roundUsdCents(displayAmount);
  }, 0);
  const hiddenAmountUsd = hiddenEntries.length > 0
    ? Math.max(0, roundUsdCents(roundUsdCents(total) - roundUsdCents(shownDisplayedUsd)))
    : 0;
  const hiddenRawUsd = hiddenEntries.reduce(
    (total, entry) => total + (rawAmounts.get(entry.key) ?? entry.amountUsd),
    0
  );
  const hiddenRecords = hiddenEntries.reduce((total, entry) => total + entry.recordCount, 0);
  const hiddenShare = rawTotal > 0 ? hiddenRawUsd / rawTotal : 0;
  const hiddenLabel = `+${hiddenEntries.length} more`;
  const hiddenAmount = `${approximate ? "~" : ""}${formatUsd(hiddenAmountUsd)}`;

  // Box tables are useful at normal terminal widths, but their fixed columns
  // become horizontal noise on a narrow split pane. Degrade to a readable
  // two-line list; the outer renderer will wrap its prose to the exact width.
  if (maxWidth < 72) {
    const narrowLines = entries.slice(0, rowCap).flatMap((entry) => {
      const rawAmount = rawAmounts.get(entry.key) ?? entry.amountUsd;
      const share = rawTotal > 0 ? rawAmount / rawTotal : 0;
      const displayAmount = rawAmount > 0 && rawAmount < 0.01 ? rawAmount : entry.amountUsd;
      const entryAmountAvailable = amountsAvailable && !(
        entry.confidence === "missing" && rawAmount === 0
      );
      const label = labelUnattributedProject && isUnattributedProjectKey(entry.key)
        ? "Unattributed"
        : labelOf(entry.key);
      const evidence = entryAmountAvailable
        ? `${approximate ? "~" : ""}${formatUsd(displayAmount)} · ${formatPercent(share)}`
        : "value unavailable · share unavailable";
      return [
        c.bold(label),
        c.dim(`${evidence} · ${recordLabel} ${entry.recordCount} · ${confidenceWord(entry.confidence)}`)
      ];
    });
    if (hiddenEntries.length > 0) {
      narrowLines.push(
        c.bold(hiddenLabel),
        c.dim(`${hiddenAmount} · ${formatPercent(hiddenShare)} · ${recordLabel} ${hiddenRecords}`)
      );
    }
    return narrowLines.join("\n");
  }

  const table = new Table({
    // Column widths keep the 64-char content budget (72 with borders and
    // indent): the amount header must hold the full basis word
    // "API-equivalent" (C-lane §1.5) without truncation, and the confidence
    // column must hold "detected/unverified" whole.
    head: [c.bold(""), c.bold(amountLabel), c.bold("Share"), c.bold(recordLabel), c.bold("Confidence")],
    colWidths: [15, 15, 11, 3, 20],
    colAligns: ["left", "right", "left", "right", "left"],
    style: useColor
      ? { head: [], border: ["dim"], "padding-left": 0, "padding-right": 1 }
      : { head: [], border: [], "padding-left": 0, "padding-right": 1 },
    chars: tableChars()
  });

  for (const entry of entries.slice(0, rowCap)) {
    const rawAmount = rawAmounts.get(entry.key) ?? entry.amountUsd;
    const share = rawTotal > 0 ? rawAmount / rawTotal : 0;
    const displayAmount = rawAmount > 0 && rawAmount < 0.01 ? rawAmount : entry.amountUsd;
    const entryAmountAvailable = amountsAvailable && !(
      entry.confidence === "missing" && rawAmount === 0
    );
    table.push([
      labelUnattributedProject && isUnattributedProjectKey(entry.key)
        ? "Unattributed"
        : labelOf(entry.key),
      entryAmountAvailable ? `${approximate ? "~" : ""}${formatUsd(displayAmount)}` : "Unavailable",
      entryAmountAvailable ? `${bar(share, c)} ${formatPercent(share)}` : "Unavailable",
      String(entry.recordCount),
      confidenceWord(entry.confidence)
    ]);
  }
  if (hiddenEntries.length > 0) {
    table.push([
      hiddenLabel,
      hiddenAmount,
      `${bar(hiddenShare, c)} ${formatPercent(hiddenShare)}`,
      String(hiddenRecords),
      ""
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

function coverageLine(summary: SpendSummary, records: readonly UsageRecord[]): string {
  const breakdown = summary.confidenceBreakdown;
  const verified = breakdown.verified ?? 0;
  const estimated = breakdown.estimated ?? 0;
  const detected = breakdown.detected_unverified ?? 0;
  const rawByConfidence = (confidence: CostConfidence): number => records.reduce(
    (total, record) => total + (record.costConfidence === confidence ? record.amountUsd ?? 0 : 0),
    0
  );
  const verifiedRaw = rawByConfidence("verified");
  const estimatedRaw = rawByConfidence("estimated");
  const detectedRaw = rawByConfidence("detected_unverified");
  const parts: string[] = [];
  if (verifiedRaw > 0) parts.push(`${formatUsd(verifiedRaw < 0.01 ? verifiedRaw : verified)} provider-reported`);
  // §1.2: "API-equivalent/estimated" is killed copy — the basis word plus its
  // parenthesized evidence level replaces it.
  if (estimatedRaw > 0) parts.push(`${formatUsd(estimatedRaw < 0.01 ? estimatedRaw : estimated)} API-equivalent (estimated)`);
  // QA MINOR-8: the slash form is killed on figure labels (§1.2) — the
  // parenthesized form replaces it, matching "API-equivalent (estimated)".
  if (detectedRaw > 0) parts.push(`${formatUsd(detectedRaw < 0.01 ? detectedRaw : detected)} detected (unverified)`);
  const missingRecords = records.filter((record) => (
    record.costConfidence === "missing" || typeof record.amountUsd !== "number"
  )).length;
  if (missingRecords > 0) {
    parts.push(`${missingRecords} record${missingRecords === 1 ? "" : "s"} missing cost`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no cost breakdown yet";
}

function evidenceAmount(value: string, confidence: CostConfidence, c: Colors): string {
  if (confidence === "verified") return c.green(value);
  if (confidence === "estimated" || confidence === "detected_unverified") return c.yellow(value);
  return c.dim(value);
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

function rawBreakdownAmounts(
  records: readonly UsageRecord[],
  dimension: GroupByDimension
): ReadonlyMap<string, number> {
  const amounts = new Map<string, number>();
  for (const record of records) {
    const key = rawBreakdownKey(record, dimension) ?? "unmapped";
    amounts.set(key, (amounts.get(key) ?? 0) + (record.amountUsd ?? 0));
  }
  return amounts;
}

function rawBreakdownKey(record: UsageRecord, dimension: GroupByDimension): string | undefined {
  switch (dimension) {
    case "source": return record.source.id;
    case "client": return record.clientId;
    case "project": return record.projectId;
    case "agent": return record.agentId;
    case "user": return record.userId;
    case "workspace": return record.workspaceId;
    case "apiKey": return record.apiKeyId;
    case "model": return record.model;
  }
}

type FinancialPresentationBasis =
  | "demo"
  | "local_estimate"
  | "local_missing"
  | "provider_reported"
  | "connected_estimated"
  | "connected_unverified"
  | "connected_mixed"
  | "connected_missing";

/**
 * Presentation follows the cost-bearing records, never merely the fact that a
 * provider was connected. Cursor/Copilot and usage-only provider responses can
 * be valid connected evidence without being provider-reported billed cost.
 */
function financialPresentationBasis(
  mode: PlainEnglishSummaryOptions["mode"],
  records: readonly UsageRecord[]
): FinancialPresentationBasis {
  if (mode === "local-logs") {
    return records.some((record) => typeof record.amountUsd === "number")
      ? "local_estimate"
      : "local_missing";
  }
  if (mode !== "connected") return "demo";

  const priced = records.filter((record) => typeof record.amountUsd === "number");
  if (priced.length === 0) return "connected_missing";

  // QA finding M2: the heading basis follows the shared classifier — an
  // estimated dollar counts as API-equivalent only when priced at published
  // API rates; a beta connector's dollars are detected (unverified).
  const hasVerified = priced.some((record) => (
    classifyResultCardRecordBasis(record, "connected") === "provider_billed"
  ));
  const hasEstimated = priced.some((record) => (
    classifyResultCardRecordBasis(record, "connected") === "api_equivalent"
  ));
  const hasUnverified = priced.some((record) => (
    classifyResultCardRecordBasis(record, "connected") === "detected_unverified"
  ));
  const bearingKinds = [hasVerified, hasEstimated, hasUnverified].filter(Boolean).length;

  if (hasVerified && bearingKinds === 1) return "provider_reported";
  if (hasEstimated && bearingKinds === 1) return "connected_estimated";
  if (hasUnverified && bearingKinds === 1) return "connected_unverified";
  return "connected_mixed";
}

// C-lane §1.2/§1.5: every label routes through the basis vocabulary
// (committed / API-equivalent / billed). Killed synonyms — "cost/value",
// "observed value", "Value"/"Evidence" amount headers — do not return.
function headlineMetricLabel(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "BILLED COST";
    case "connected_estimated": return "CONNECTED API-EQUIVALENT (ESTIMATED)";
    case "connected_unverified": return "CONNECTED DETECTED (UNVERIFIED)";
    case "connected_mixed": return "MIXED CONNECTED EVIDENCE";
    case "connected_missing": return "CONNECTED EVIDENCE UNAVAILABLE";
    case "local_missing": return "API-EQUIVALENT VALUE UNAVAILABLE";
    case "local_estimate": return "API-EQUIVALENT VALUE";
    default: return "ILLUSTRATIVE EVIDENCE";
  }
}

function evidenceBreakdownLabel(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "Billed cost";
    case "connected_estimated": return "Connected API-equivalent (estimated)";
    case "connected_unverified": return "Connected detected (unverified)";
    case "connected_mixed": return "Mixed connected evidence";
    case "connected_missing": return "Connected financial coverage";
    case "local_missing": return "Local usage evidence";
    case "local_estimate": return "API-equivalent value";
    default: return "Illustrative evidence";
  }
}

function evidenceAmountColumnLabel(basis: FinancialPresentationBasis): string {
  if (basis === "provider_reported") return "Billed";
  if (basis === "local_estimate" || basis === "connected_estimated") return "API-equivalent";
  if (basis === "connected_unverified") return "Detected";
  return "Amount";
}

function sourceBreakdownLabel(basis: FinancialPresentationBasis): string {
  switch (basis) {
    case "provider_reported": return "Where billed cost goes";
    case "connected_estimated": return "Where connected API-equivalent (estimated) appears";
    case "connected_unverified": return "Where connected detected (unverified) appears";
    case "connected_mixed": return "Where mixed connected evidence appears";
    case "connected_missing": return "Connected source coverage";
    case "local_missing": return "Local usage evidence by source";
    case "local_estimate": return "Where API-equivalent value goes";
    default: return "Illustrative evidence by source";
  }
}

function defaultNextSteps(
  mode: PlainEnglishSummaryOptions["mode"]
): readonly (string | TerminalNextStep)[] {
  if (mode === "connected") {
    return [
      { command: "npx aibill --group-by agent", description: "drill into another dimension" }
    ];
  }
  if (mode === "local-logs") {
    return [
      { command: "npx aibill --group-by project", description: "see which project has the most observed activity" },
      "Need team reconciliation, allocation, budgets, and approvals? Workspace design partners: https://asktilden.com"
    ];
  }
  return [
    { command: "npx aibill connect openai", description: "set up OpenAI Admin; then run the printed sync command" },
    { command: "npx aibill connect anthropic", description: "set up Anthropic Admin; then run the printed sync command" }
  ];
}

/**
 * The "where your money goes" block: aligned label + proportional bar + dollar
 * + share. This is the screenshot-able artifact — kept deliberately compact
 * (top 5 sources) so the terminal stays clean.
 */
function renderSpendBars(
  entries: SpendBreakdownEntry[],
  total: number,
  c: Colors,
  rawAmounts: ReadonlyMap<string, number> = new Map(),
  rawTotal = total,
  amountsAvailable = true,
  approximate = false
): string[] {
  if (entries.length === 0) return [];
  const top = entries.slice(0, 5);
  const labelWidth = Math.min(16, Math.max(...top.map((entry) => labelOf(entry.key).length)));
  const barLines = top.map((entry) => {
    const rawAmount = rawAmounts.get(entry.key) ?? entry.amountUsd;
    const share = rawTotal > 0 ? rawAmount / rawTotal : 0;
    const label = labelOf(entry.key).slice(0, labelWidth).padEnd(labelWidth);
    const displayAmount = rawAmount > 0 && rawAmount < 0.01 ? rawAmount : entry.amountUsd;
    const entryAmountAvailable = amountsAvailable && !(
      entry.confidence === "missing" && rawAmount === 0
    );
    if (!entryAmountAvailable) {
      return `  ${c.dim(label)}  ${c.dim("value unavailable · share unavailable")}`;
    }
    const amount = `${approximate ? "~" : ""}${formatUsd(displayAmount)}`.padStart(10);
    const pct = `${Math.round(share * 100)}%`.padStart(4);
    return `  ${c.dim(label)}  ${spendBar(share, c)}  ${c.bold(amount)}  ${c.dim(pct)}`;
  });
  // Parity D3: never truncate silently. The remainder reconciles to the
  // displayed total by construction (same policy as the breakdown table).
  const hidden = entries.slice(5);
  if (hidden.length > 0) {
    const shownDisplayedUsd = top.reduce((sum, entry) => {
      const rawAmount = rawAmounts.get(entry.key) ?? entry.amountUsd;
      const displayAmount = rawAmount > 0 && rawAmount < 0.01 ? rawAmount : entry.amountUsd;
      return sum + roundUsdCents(displayAmount);
    }, 0);
    const hiddenAmount = Math.max(0, roundUsdCents(roundUsdCents(total) - roundUsdCents(shownDisplayedUsd)));
    const hiddenShare = rawTotal > 0
      ? hidden.reduce((sum, entry) => sum + (rawAmounts.get(entry.key) ?? entry.amountUsd), 0) / rawTotal
      : 0;
    barLines.push(
      `  ${c.dim(`+${hidden.length} more · ${approximate ? "~" : ""}${formatUsd(hiddenAmount)} · ${Math.round(hiddenShare * 100)}%`)}`
    );
  }
  return barLines;
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
  // 5 slots keep "█████ 100%" inside the narrower Share column that funds
  // the full "API-equivalent" amount header (C-lane §1.5).
  const slots = 5;
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

/**
 * Persisted labels are untrusted terminal input. Strip OSC hyperlinks, ANSI
 * control sequences, and line/control injection before adding our own color.
 */
function sanitizeTerminalMetadata<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeTerminalText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTerminalMetadata(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeTerminalMetadata(entry)])
    ) as T;
  }
  return value;
}

function sanitizeTerminalText(value: string): string {
  return value
    // OSC sequences (including hyperlinks), terminated by BEL/ST or EOF.
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/gu, "")
    .replace(/\u009d[\s\S]*?(?:\u0007|\u009c|$)/gu, "")
    // CSI plus remaining two-character escape sequences.
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function renderTerminalLines(lines: string[], width: number): string {
  return lines
    .flatMap((line) => line.split("\n"))
    .flatMap((line) => wrapProseLine(line, width))
    .join("\n");
}

function wrapProseLine(line: string, width: number): string[] {
  const safeWidth = Math.max(24, width);
  if (
    visibleLength(line) <= safeWidth ||
    /^\s*[┌┬┐├┼┤└┴┘│]/u.test(line) ||
    /^\s*─+\s*$/u.test(line)
  ) {
    return [line];
  }

  const leading = line.match(/^\s*/u)?.[0] ?? "";
  const text = line.slice(leading.length);
  const continuation = /^›\s/u.test(text)
    ? `${leading}  `
    : /^\d+\.\s/u.test(text)
      ? `${leading}   `
      : leading.length >= 5
        ? leading
        : `${leading}  `;
  // The optional `cd /path/to/project && ` prefix (0.9.5 machine-wide pointers) is
  // part of the copy-pasteable command and must never wrap away from it.
  const protectedText = text.replace(
    /(?:cd \/path\/to\/project && )?npx (?:aibill|ai-spend-agent)(?: (?:--sample --full|--full|doctor --sources|init|apply-artifact|apply(?: --sample)?|watch|connect(?: (?:openai|anthropic))?|sync-provider|report-card(?: --sample)?|report|--group-by(?: [a-zA-Z]+)?))?/gu,
    (command) => command.replace(/ /gu, "\uE000")
  );
  const words = protectedText.split(/\s+/u);
  const wrapped: string[] = [];
  let current = leading;

  for (const word of words) {
    const separator = current.trim().length > 0 ? " " : "";
    if (
      current.trim().length > 0 &&
      visibleLength(current) + 1 + visibleLength(word) > safeWidth
    ) {
      wrapped.push(current);
      current = `${continuation}${word}`;
    } else {
      current += `${separator}${word}`;
    }
  }
  if (current.length > 0) wrapped.push(current);
  return wrapped.map((wrappedLine) => wrappedLine.replace(/\uE000/gu, " "));
}

function visibleLength(text: string): number {
  let length = 0;
  let inAnsi = false;
  for (const char of text) {
    if (!inAnsi && char.charCodeAt(0) === 27) {
      inAnsi = true;
      continue;
    }
    if (inAnsi) {
      if (char === "m") inAnsi = false;
      continue;
    }
    length += 1;
  }
  return length;
}

function formatBigUsd(amount: number, rawAmount = amount): string {
  if (rawAmount > 0 && rawAmount < 0.01) return "<$0.01";
  return `$${roundUsdCents(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUsd(amount: number): string {
  // A real-but-tiny amount rendered as "$0.00" reads as a data bug to a
  // technical audience; "<$0.01" says what actually happened.
  if (amount > 0 && amount < 0.01) return "<$0.01";
  // Parity D1: the shared cents policy — every surface rounds identically.
  return `$${roundUsdCents(amount).toFixed(2)}`;
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

// --- aligned command summary (0.9.5) --------------------------------------

/**
 * Bare project-scoped commands render as-is in project scope and with the
 * machine-wide report's `cd /path/to/project && …` prefix from a broad root,
 * where they would otherwise friendly-refuse (0.9.5 rider on the 0.9.4 fix).
 *
 * The placeholder is a PATH, not `<project>` (0.9.6). Angle brackets are shell
 * redirection: pasting `cd <project> && npx aibill apply` verbatim is a syntax
 * error, and the founder has already been burned once copying a printed
 * pointer literally. `/path/to/project` pastes as a plain command and fails,
 * if it fails at all, with a legible "no such file or directory".
 */
function scopedCommandRenderer(
  commandScope: PlainEnglishSummaryOptions["commandScope"]
): (command: string) => string {
  return (command: string) => (
    commandScope === "machine-wide" ? `cd /path/to/project && ${command}` : command
  );
}

/**
 * Render `<tool> <path>` as ONE un-half-copyable shell command (0.9.6).
 *
 * Founder-found: `report --no-open` printed `› open <a long absolute path>`
 * with its description on the next line. He read "open" as a LABEL, typed
 * bare `open`, and got macOS's usage dump — "i don't know what im looking
 * at." Two changes make a partial read impossible to mistake for a label:
 *
 *   1. An artifact sitting in the invoking directory is named RELATIVELY —
 *      `open ai-spend-report.html` — short enough to read as one unit and
 *      short enough never to wrap.
 *   2. Anything else (an absolute path, or any path containing a space or a
 *      shell-significant character) is QUOTED — `open "<abs>/r.html"` —
 *      so the quotes visually glue the command to its argument.
 *
 * The quoting is SAFETY, not only optics. An unquoted path with a space was
 * already two arguments when pasted; worse, the double quotes this used to
 * emit do not stop a POSIX shell expanding `$(...)`, backticks, or `$VAR`, so
 * a path containing them executed on paste. Single quotes expand nothing.
 */
export function shellPathPointer(
  tool: string,
  path: string,
  cwd?: string,
  platform: NodeJS.Platform = process.platform
): string {
  const separator = path.lastIndexOf("/") === -1 ? path.lastIndexOf("\\") : path.lastIndexOf("/");
  const directory = separator === -1 ? "" : path.slice(0, separator);
  const base = separator === -1 ? path : path.slice(separator + 1);
  const relative = cwd !== undefined && directory === cwd && base.length > 0;
  const argument = relative ? base : path;
  const needsQuotes = !relative || /[\s'"$`\\&;|<>()*?!#~%^]/u.test(argument);
  if (!needsQuotes) return `${tool} ${argument}`;
  if (platform === "win32") {
    // cmd.exe quotes with DOUBLE quotes and has no single-quote syntax at all,
    // so the POSIX form printed `start 'C:\Users\<you>\r.html'` — quotes that
    // cmd passes through as literal characters, naming a file that does not
    // exist. Windows filenames may not contain `"`, so a double-quoted path
    // never needs escaping and can never be left unterminated.
    //
    // Known limit, stated rather than papered over: cmd expands %VAR% inside
    // double quotes and offers no in-quote escape for it. A path containing
    // %NAME% where NAME is a defined variable will still be substituted. The
    // auto-open path does not have this problem — it never goes through a
    // shell (see decideReportAutoOpen's rundll32 branch).
    return `${tool} "${argument}"`;
  }
  // SINGLE quotes. Inside double quotes a POSIX shell still expands $(...),
  // backticks and $VAR, so a double-quoted path containing a command
  // substitution ran it the moment it was pasted — the previous quoted form
  // (and 0.9.5's unquoted form) were both code-execution-on-paste. Inside
  // single quotes nothing expands. The only character that cannot appear
  // literally is the single quote itself; the standard '\'' idiom closes the
  // literal, emits an escaped quote, and reopens it, so every path is
  // representable and none is left bare.
  return `${tool} '${argument.replaceAll("'", "'\\''")}'`;
}

export type CommandSummaryRow = {
  /** Left-column label, e.g. "Scope". Rendered dim, padded to one shared column. */
  label: string;
  /** Right-column value. Long values continue at the value column, never mid-word. */
  value: string;
};

export type CommandSummaryNextStep = {
  /** The literal command to run (rendered bold after the receipt's "›"). */
  command: string;
  /** What the command does (rendered dim, on one shared column across steps). */
  description?: string;
};

export type CommandSummaryOptions = {
  /** Bold header title, e.g. "aibill report". */
  title: string;
  /** Optional bold segment after the title's dim "·", e.g. "Your AI Receipt". */
  badge?: string;
  /** Dim note line directly under the header (receipt convention). */
  note?: string;
  /** Aligned label/value rows. */
  rows: CommandSummaryRow[];
  /** Set-off blocks between the rows and Next, e.g. "Caption to share". */
  sections?: { heading: string; body: string[] }[];
  /** "Next" block; commands share one description column when every row fits. */
  nextSteps?: CommandSummaryNextStep[];
  /** Force-enable or force-disable color. Defaults to TTY auto-detection. */
  color?: boolean;
  /** Terminal width. Defaults to 72; floors at 40 like the CLI. */
  width?: number;
};

/**
 * Terminal summary for artifact-writing commands (report, report-card) in the
 * receipt's visual language: two-space indent, a dim label column shared by
 * every row, dot separators, and a "Next" block whose commands pad to ONE
 * shared description column (0.9.5 founder feedback: the old flat
 * `key: value` lines drifted per row and were "really hard to read").
 *
 * Alignment degrades deliberately and never wraps mid-word — paths stay
 * whole. A value that cannot sit beside its label continues on following
 * lines at the value column. The Next block is all-or-nothing: if any
 * description cannot fit beside the widest command, every description moves
 * to a dim continuation line under its command (the receipt's "›"
 * continuation indent) so the block never renders half-aligned. Below 58
 * columns the label column collapses to stacked label/value lines, matching
 * the receipt's own narrow-terminal behavior.
 */
export function generateCommandSummary(options: CommandSummaryOptions): string {
  const sanitized = sanitizeTerminalMetadata(options);
  const useColor = sanitized.color ?? isColorTty();
  const c = makeColors(useColor);
  const width = Math.max(40, sanitized.width ?? 72);
  const narrow = width < 58;
  const lines: string[] = [""];

  lines.push(
    `  ${c.bold(sanitized.title)}${sanitized.badge ? ` ${c.dim("·")} ${c.bold(sanitized.badge)}` : ""}`
  );
  if (sanitized.note) lines.push(`  ${c.dim(sanitized.note)}`);
  lines.push("");

  // Shared label column: the receipt's 14-char floor, widened to the longest
  // label so every value in THIS summary starts on the same column.
  const labelWidth = Math.max(14, ...sanitized.rows.map((row) => row.label.length));
  for (const row of sanitized.rows) {
    if (narrow) {
      lines.push(`  ${c.dim(row.label.toUpperCase())}`);
      for (const chunk of wrapPlainWords(row.value, width - 2)) lines.push(`  ${chunk}`);
      continue;
    }
    const [first, ...rest] = wrapPlainWords(row.value, Math.max(16, width - labelWidth - 3));
    lines.push(`  ${c.dim(row.label.padEnd(labelWidth))} ${first ?? ""}`);
    for (const chunk of rest) lines.push(`  ${" ".repeat(labelWidth)} ${chunk}`);
  }

  for (const section of sanitized.sections ?? []) {
    lines.push("");
    lines.push(`  ${c.bold(section.heading)}`);
    for (const bodyLine of section.body) {
      // Same trick as the receipt's command protector: "npx aibill" is one
      // copy-pasteable token and must never split across a narrow wrap.
      const protectedLine = bodyLine.replace(/npx (?:aibill|ai-spend-agent)\b/gu, (command) => command.replace(/ /gu, ""));
      for (const chunk of wrapPlainWords(protectedLine, width - 2)) lines.push(`  ${chunk.replace(//gu, " ")}`);
    }
  }

  const nextSteps = sanitized.nextSteps ?? [];
  if (nextSteps.length > 0) {
    lines.push("");
    lines.push(`  ${c.bold("Next")}`);
    // Description-less steps (e.g. the "opened … in your browser" status
    // line) render as-is and never inflate the shared command column.
    const describedSteps = nextSteps.filter((step) => step.description !== undefined);
    const commandWidth = Math.max(0, ...describedSteps.map((step) => step.command.length));
    const aligned = !narrow && describedSteps.every((step) => (
      4 + commandWidth + 2 + step.description!.length <= width
    ));
    for (const step of nextSteps) {
      if (step.description !== undefined && aligned) {
        lines.push(
          `  ${c.cyan("›")} ${c.bold(step.command.padEnd(commandWidth))}  ${c.dim(step.description)}`
        );
        continue;
      }
      // The command itself NEVER wraps (paths stay whole); its description
      // follows on the receipt's "›" continuation indent instead.
      lines.push(`  ${c.cyan("›")} ${c.bold(step.command)}`);
      if (step.description !== undefined) {
        for (const chunk of wrapPlainWords(step.description, width - 4)) {
          lines.push(`    ${c.dim(chunk)}`);
        }
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** Word-level wrap that never splits a word — oversize paths overflow whole. */
function wrapPlainWords(text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current += ` ${word}`;
    } else {
      chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

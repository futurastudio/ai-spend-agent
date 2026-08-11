#!/usr/bin/env node
/**
 * Standalone Claude Code status-line runtime.
 *
 * This file deliberately imports Node built-ins only. The installer copies its
 * compiled JavaScript verbatim to ~/.aibill/bin/statusline.mjs, so hook renders
 * never resolve external packages, scan transcripts, access providers, or launch a
 * subprocess.
 */
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CACHE_FILE_NAME = "statusline-v1.json";
const CACHE_MAX_BYTES = 64 * 1_024;
const DEFAULT_COLUMNS = 100;
const MAX_COLUMNS = 240;
const STALE_AFTER_MS = 5 * 60 * 1_000;
const STDIN_MAX_BYTES = 64 * 1_024;
const STDIN_DRAIN_TIMEOUT_MS = 25;
const guardedOutputs = new WeakSet<object>();

type ApiEquivalentWindow = {
  amountUsd: number | null;
  recordCount: number;
  basis: "api_equivalent";
  financialEvidence: "estimated" | "missing";
  coverage: "complete" | "partial" | "missing";
};

type BilledWindow = {
  amountUsd: number | null;
  recordCount: number;
  basis: "provider_billed";
  financialEvidence: "verified" | "missing";
  coverage: "complete" | "partial" | "missing";
};

type RollingWindows<T> = {
  oneDay: T;
  sevenDays: T;
  thirtyDays: T;
};

type ReportedLimit = {
  kind: "five-hour" | "weekly";
  usedPercent: number;
  remainingPercent: number;
  observedAt: string;
  resetsAt: string;
  source: "transcript_reported";
};

type SubscriptionAgent = {
  agent: "claude-code" | "codex";
  billing: "subscription";
  planId: string | null;
  apiEquivalent: RollingWindows<ApiEquivalentWindow>;
  limits: ReportedLimit[];
  pressure: "extra_usage_credits_exhausted" | null;
};

export type StatuslineSnapshot = {
  kind: "aibill.activity_snapshot";
  schemaVersion: 1;
  currency: "USD";
  asOf: string;
  generatedAt: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  refresh: { status: "ok" } | { status: "error"; errorCode: string };
  mode: "metered" | "subscription" | "mixed" | "unresolved" | "empty" | "error";
  subscription: { agents: SubscriptionAgent[] } | null;
  metered: {
    agents: Array<{
      agent: "claude-code" | "codex";
      billing: "api_key";
      planId: string | null;
    }>;
    apiEquivalent: RollingWindows<ApiEquivalentWindow>;
    providerBilled: RollingWindows<BilledWindow>;
  } | null;
  unresolved: {
    agents: Array<{
      agent: "claude-code" | "codex";
      billing: "unknown";
      planId: string | null;
    }>;
    apiEquivalent: RollingWindows<ApiEquivalentWindow>;
  } | null;
  overage: {
    amountUsd: number;
    currency: "USD";
    basis: "provider_billed";
    financialEvidence: "verified";
    alertEligible: true;
    recordCount: number;
  } | null;
  coverage: unknown;
  networkUploaded: false;
};

export type StatuslineCacheResult =
  | { status: "ok"; snapshot: StatuslineSnapshot }
  | { status: "missing" }
  | { status: "error" };

export type StatuslineRuntimeOptions = {
  now?: Date;
  columns?: number;
  timeZone?: string;
};

export type StatuslineCacheOptions = {
  cacheDirectory?: string;
  homeDirectory?: string;
};

type HookInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  readableEnded?: boolean;
  destroyed?: boolean;
  pause(): unknown;
  resume(): unknown;
};

type HookOutput = {
  write(value: string): unknown;
  on?(event: "error", listener: (error: unknown) => void): unknown;
};

/** Read the private fixed cache without importing the application runtime. */
export async function readStatuslineCache(
  options: StatuslineCacheOptions = {}
): Promise<StatuslineCacheResult> {
  const configuredDirectory = options.cacheDirectory?.trim() ||
    process.env.AIBILL_CACHE_DIR?.trim();
  const homeDirectory = options.homeDirectory ?? homedir();
  const requestedDirectory = resolve(
    configuredDirectory || join(homeDirectory, ".aibill", "cache")
  );

  try {
    let defaultParentIdentity: { dev: number; ino: number; mode: number } | undefined;
    if (!configuredDirectory) {
      const parentInfo = await lstat(join(homeDirectory, ".aibill"));
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() ||
          !hasPrivatePermissions(parentInfo.mode)) {
        return { status: "error" };
      }
      defaultParentIdentity = { dev: parentInfo.dev, ino: parentInfo.ino, mode: parentInfo.mode };
    }
    const directoryInfo = await lstat(requestedDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() ||
        !hasPrivatePermissions(directoryInfo.mode)) {
      return { status: "error" };
    }
    const canonicalDirectory = await realpath(requestedDirectory);
    const confirmedDirectoryInfo = await lstat(requestedDirectory);
    if (confirmedDirectoryInfo.isSymbolicLink() || !confirmedDirectoryInfo.isDirectory() ||
        confirmedDirectoryInfo.dev !== directoryInfo.dev ||
        confirmedDirectoryInfo.ino !== directoryInfo.ino) {
      return { status: "error" };
    }
    if (defaultParentIdentity) {
      const confirmedParent = await lstat(join(homeDirectory, ".aibill"));
      if (confirmedParent.isSymbolicLink() || !confirmedParent.isDirectory() ||
          confirmedParent.dev !== defaultParentIdentity.dev ||
          confirmedParent.ino !== defaultParentIdentity.ino ||
          confirmedParent.mode !== defaultParentIdentity.mode ||
          !hasPrivatePermissions(confirmedParent.mode)) {
        return { status: "error" };
      }
    }

    const cachePath = join(canonicalDirectory, CACHE_FILE_NAME);
    let cacheInfo;
    try {
      cacheInfo = await lstat(cachePath);
    } catch (error) {
      return isNodeError(error, "ENOENT") ? { status: "missing" } : { status: "error" };
    }
    if (cacheInfo.isSymbolicLink() || !cacheInfo.isFile() ||
        !hasPrivatePermissions(cacheInfo.mode) || cacheInfo.size > CACHE_MAX_BYTES) {
      return { status: "error" };
    }

    let handle;
    try {
      handle = await open(cachePath, constants.O_RDONLY | noFollowFlag());
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== cacheInfo.dev ||
          openedInfo.ino !== cacheInfo.ino || !hasPrivatePermissions(openedInfo.mode) ||
          openedInfo.size > CACHE_MAX_BYTES) {
        return { status: "error" };
      }
      const buffer = Buffer.allocUnsafe(CACHE_MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > CACHE_MAX_BYTES) return { status: "error" };
      const afterReadInfo = await handle.stat();
      if (afterReadInfo.dev !== openedInfo.dev || afterReadInfo.ino !== openedInfo.ino ||
          afterReadInfo.size !== openedInfo.size || afterReadInfo.mtimeMs !== openedInfo.mtimeMs ||
          afterReadInfo.ctimeMs !== openedInfo.ctimeMs ||
          !hasPrivatePermissions(afterReadInfo.mode)) {
        return { status: "error" };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch {
        return { status: "error" };
      }
      const snapshot = parseSnapshot(raw);
      return snapshot ? { status: "ok", snapshot } : { status: "error" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  } catch (error) {
    return isNodeError(error, "ENOENT") ? { status: "missing" } : { status: "error" };
  }
}

/** Pure, deterministic one-line renderer over the validated cache result. */
export function renderStatusline(
  result: StatuslineCacheResult,
  options: StatuslineRuntimeOptions = {}
): string {
  const now = validDate(options.now) ? options.now : new Date();
  const columns = normalizeColumns(options.columns ?? Number(process.env.COLUMNS));
  const tier = columns >= 80 ? "full" : columns >= 50 ? "compact" : "minimal";

  if (result.status === "missing") return fitStatic("aibill · run aibill init", columns);
  if (result.status === "error") {
    return fitStatic("aibill · cache error · run aibill init", columns);
  }

  const snapshot = result.snapshot;
  const freshness = freshnessSegment(snapshot, now);
  if (snapshot.mode === "error") {
    return fitStatic(`aibill · ${freshness} · run aibill init`, columns);
  }
  if (snapshot.mode === "empty") {
    return assembleLine(["no usage yet"], freshness, columns);
  }

  const overage = snapshot.overage
    ? `OVERAGE ${formatBilledUsd(snapshot.overage.amountUsd)} billed`
    : undefined;
  let segments: string[];
  switch (snapshot.mode) {
    case "metered":
      segments = renderMetered(snapshot, tier);
      break;
    case "subscription":
      segments = renderSubscription(snapshot, tier, now, options.timeZone);
      break;
    case "mixed":
      segments = renderMixed(snapshot, tier, now, options.timeZone);
      break;
    case "unresolved":
      segments = renderUnresolved(snapshot, tier);
      break;
    default:
      segments = ["cache error", "run aibill init"];
  }

  if (overage) {
    // Billed overage is the sole compact paid-alert bridge and must survive
    // narrow layouts. It never derives from plan pressure.
    if (hasMultipleSubscribedAgents(snapshot)) {
      return assembleMultiSubscriptionOverageLine(
        snapshot, segments, overage, freshness, tier, columns, now
      );
    }
    return assembleOverageLine(segments, overage, freshness, columns);
  }
  if (snapshot.mode === "subscription" && hasMultipleSubscribedAgents(snapshot)) {
    return assembleMultiSubscriptionLine(snapshot, freshness, tier, columns, now, options.timeZone);
  }
  if (snapshot.mode === "mixed") {
    if (hasMultipleSubscribedAgents(snapshot)) {
      return assembleMultiSubscriptionMixedLine(
        snapshot, segments, freshness, tier, columns, now, options.timeZone
      );
    }
    return assembleMixedLine(snapshot, segments, freshness, tier, columns, now, options.timeZone);
  }
  return assembleLine(segments, freshness, columns, overage);
}

/** Ignore at most a bounded amount of Claude's session JSON and never retain it. */
export async function drainStatuslineStdin(
  input: HookInput | null | undefined,
  maxBytes = STDIN_MAX_BYTES,
  timeoutMs = STDIN_DRAIN_TIMEOUT_MS
): Promise<void> {
  if (!input || input.isTTY || input.readableEnded || input.destroyed) return;
  const byteLimit = Number.isFinite(maxBytes) ? Math.max(0, Math.min(CACHE_MAX_BYTES, maxBytes)) : 0;
  const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(100, timeoutMs)) : 0;

  await new Promise<void>((done) => {
    let consumed = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.pause();
      input.removeListener("data", onData);
      input.removeListener("end", finish);
      input.removeListener("error", finish);
      done();
    };
    const onData = (chunk: unknown) => {
      const length = typeof chunk === "string"
        ? Buffer.byteLength(chunk, "utf8")
        : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
          ? chunk.byteLength
          : 0;
      consumed += Math.min(length, byteLimit - Math.min(consumed, byteLimit));
      if (consumed >= byteLimit) finish();
    };
    const timer = setTimeout(finish, waitMs);
    input.on("data", onData);
    input.once("end", finish);
    input.once("error", finish);
    input.resume();
  });
}

/** Hook entry: exactly one stdout line, no stderr, and exit code zero. */
export async function runStatuslineHook(options: {
  stdin?: HookInput | null;
  stdout?: HookOutput;
  cache?: StatuslineCacheOptions;
  render?: StatuslineRuntimeOptions;
} = {}): Promise<0> {
  const stdout = options.stdout ?? process.stdout;
  // Stream write failures (notably EPIPE) arrive asynchronously and cannot be
  // caught around write(). Swallow them so the hook contract stays exit-zero
  // and stderr-free when Claude or a pipe closes its consumer.
  if (stdout.on && !guardedOutputs.has(stdout)) {
    stdout.on("error", () => undefined);
    guardedOutputs.add(stdout);
  }
  let line = "aibill · cache error · run aibill init";
  try {
    const [result] = await Promise.all([
      readStatuslineCache(options.cache),
      drainStatuslineStdin(options.stdin === undefined ? process.stdin : options.stdin)
    ]);
    line = renderStatusline(result, options.render);
  } catch {
    // Hook paths fail closed and never leak local exceptions or filesystem data.
  }
  try {
    stdout.write(`${sanitizeLine(line)}\n`);
  } catch {
    // A closed output pipe still must not create an unhandled rejection.
  }
  return 0;
}

function renderMetered(snapshot: StatuslineSnapshot, tier: string): string[] {
  if (!snapshot.metered) return ["billing mode unresolved"];
  const windows: Array<["1d" | "7d" | "30d", ApiEquivalentWindow, BilledWindow]> = [
    ["1d", snapshot.metered.apiEquivalent.oneDay, snapshot.metered.providerBilled.oneDay],
    ["7d", snapshot.metered.apiEquivalent.sevenDays, snapshot.metered.providerBilled.sevenDays],
    ["30d", snapshot.metered.apiEquivalent.thirtyDays, snapshot.metered.providerBilled.thirtyDays]
  ];
  const rendered = windows.flatMap(([label, estimated, billed]) => {
    if (billed.amountUsd !== null && billed.financialEvidence === "verified") {
      return [`${formatBilledUsd(billed.amountUsd)} ${label} billed`];
    }
    if (estimated.amountUsd !== null && estimated.financialEvidence === "estimated") {
      return [`~${formatUsd(estimated.amountUsd)} ${label}`];
    }
    return [];
  });
  if (rendered.length === 0) return ["metered detected", "cost not reported"];
  if (tier === "minimal") return [rendered[0]!];
  if (tier === "compact") {
    const sevenDay = rendered.find((value) => value.includes(" 7d"));
    return [sevenDay ?? rendered[0]!];
  }
  return rendered;
}

function renderSubscription(
  snapshot: StatuslineSnapshot,
  tier: string,
  now: Date,
  timeZone?: string
): string[] {
  if (hasMultipleSubscribedAgents(snapshot)) {
    return renderMultiSubscriptionSegments(snapshot, tier, now, timeZone);
  }
  const agent = selectSubscriptionAgent(snapshot, now);
  if (!agent) return ["subscription detected", "runway not reported"];
  const limits = activeLimits(agent, now);
  const ordered = tier === "full"
    ? [...limits].sort((left, right) => limitKindOrder(left.kind) - limitKindOrder(right.kind))
    : [...limits].sort(compareUrgency).slice(0, 1);
  const segments = ordered.map((limit) => formatLimit(limit, now, timeZone));
  if (limits.length === 0) segments.push("subscription detected", "runway not reported");
  const value = agent.apiEquivalent.sevenDays;
  if (value.amountUsd !== null && value.financialEvidence === "estimated") {
    segments.push(`~${formatUsd(value.amountUsd)} 7d value`);
  }
  if (agent.pressure === "extra_usage_credits_exhausted" && tier !== "minimal") {
    segments.push("plan pressure");
  }
  return segments.length > 0 ? segments : ["subscription detected"];
}

function renderMixed(
  snapshot: StatuslineSnapshot,
  tier: string,
  now: Date,
  timeZone?: string
): string[] {
  if (hasMultipleSubscribedAgents(snapshot)) {
    const segments = renderMultiSubscriptionSegments(snapshot, tier, now, timeZone);
    appendMeteredSevenDaySegment(snapshot, segments);
    return segments.length > 0 ? segments : ["mixed billing", "amounts unavailable"];
  }
  const agent = selectSubscriptionAgent(snapshot, now);
  const limits = agent ? activeLimits(agent, now) : [];
  const selectedLimits = tier === "full"
    ? [...limits].sort((left, right) => limitKindOrder(left.kind) - limitKindOrder(right.kind))
    : [...limits].sort(compareUrgency).slice(0, 1);
  const segments = selectedLimits.map((limit) => formatLimit(limit, now, timeZone));
  if (limits.length === 0 && tier !== "minimal") segments.push("runway not reported");

  appendMeteredSevenDaySegment(snapshot, segments);
  const value = agent?.apiEquivalent.sevenDays;
  if (value?.amountUsd !== null && value?.amountUsd !== undefined &&
      value.financialEvidence === "estimated") {
    segments.push(`sub ~${formatUsd(value.amountUsd)} 7d value`);
  }
  if (agent?.pressure === "extra_usage_credits_exhausted" && tier !== "minimal") {
    segments.push("plan pressure");
  }
  return segments.length > 0 ? segments : ["mixed billing", "amounts unavailable"];
}

function renderMultiSubscriptionSegments(
  snapshot: StatuslineSnapshot,
  tier: string,
  now: Date,
  timeZone?: string
): string[] {
  const entries = orderedSubscriptionLimits(snapshot, now);
  const selected = tier === "full" ? entries : entries.slice(0, 1);
  const segments = selected.map(({ agent, limit }) => tier === "full"
    ? formatAttributedLimit(agent, limit, now, timeZone)
    : formatAttributedLimitCompact(agent, limit));
  if (entries.length === 0 && tier !== "minimal") {
    segments.push("subscription detected", "runway not reported");
  }

  const agents = orderedSubscriptionAgents(snapshot, now);
  const valueAgents = tier === "full" ? agents : agents.slice(0, 1);
  for (const agent of valueAgents) {
    const value = agent.apiEquivalent.sevenDays;
    if (value.amountUsd !== null && value.financialEvidence === "estimated") {
      segments.push(`${subscriptionAgentLabel(agent)} ~${formatUsd(value.amountUsd)} 7d value`);
    }
  }
  if (tier !== "minimal") {
    for (const agent of agents.filter(({ pressure }) => pressure === "extra_usage_credits_exhausted")) {
      segments.push(`${subscriptionAgentLabel(agent)} plan pressure`);
    }
  }
  return segments.length > 0 ? segments : ["subscription detected"];
}

function appendMeteredSevenDaySegment(snapshot: StatuslineSnapshot, segments: string[]): void {
  const billed = snapshot.metered?.providerBilled.sevenDays;
  const estimated = snapshot.metered?.apiEquivalent.sevenDays;
  if (billed?.amountUsd !== null && billed?.amountUsd !== undefined &&
      billed.financialEvidence === "verified") {
    segments.push(`metered ${formatBilledUsd(billed.amountUsd)} 7d billed`);
  } else if (estimated?.amountUsd !== null && estimated?.amountUsd !== undefined &&
             estimated.financialEvidence === "estimated") {
    segments.push(`metered ~${formatUsd(estimated.amountUsd)} 7d`);
  }
}

function renderUnresolved(snapshot: StatuslineSnapshot, tier: string): string[] {
  const value = snapshot.unresolved?.apiEquivalent.sevenDays;
  const amount = value?.amountUsd !== null && value?.amountUsd !== undefined &&
    value.financialEvidence === "estimated"
    ? `~${formatUsd(value.amountUsd)} 7d API-equivalent`
    : "usage observed";
  return tier === "minimal" ? ["billing unresolved"] : ["billing unresolved", amount];
}

function selectSubscriptionAgent(
  snapshot: StatuslineSnapshot,
  now: Date
): SubscriptionAgent | undefined {
  return [...(snapshot.subscription?.agents ?? [])].sort((left, right) => {
    const latestDifference = latestLimitObservation(right, now) - latestLimitObservation(left, now);
    if (latestDifference !== 0) return latestDifference;
    const recordsDifference = right.apiEquivalent.sevenDays.recordCount -
      left.apiEquivalent.sevenDays.recordCount;
    if (recordsDifference !== 0) return recordsDifference;
    return left.agent.localeCompare(right.agent);
  })[0];
}

type SubscriptionLimitEntry = {
  agent: SubscriptionAgent;
  limit: ReportedLimit;
};

function hasMultipleSubscribedAgents(snapshot: StatuslineSnapshot): boolean {
  return (snapshot.subscription?.agents.length ?? 0) > 1;
}

function orderedSubscriptionLimits(
  snapshot: StatuslineSnapshot,
  now: Date
): SubscriptionLimitEntry[] {
  return (snapshot.subscription?.agents ?? [])
    .flatMap((agent) => activeLimits(agent, now).map((limit) => ({ agent, limit })))
    .sort(compareSubscriptionLimitEntries);
}

function primarySubscriptionLimits(
  snapshot: StatuslineSnapshot,
  now: Date
): SubscriptionLimitEntry[] {
  return (snapshot.subscription?.agents ?? [])
    .flatMap((agent) => {
      const limit = [...activeLimits(agent, now)].sort(compareUrgency)[0];
      return limit ? [{ agent, limit }] : [];
    })
    .sort(compareSubscriptionLimitEntries);
}

function compareSubscriptionLimitEntries(
  left: SubscriptionLimitEntry,
  right: SubscriptionLimitEntry
): number {
  const urgency = compareUrgency(left.limit, right.limit);
  if (urgency !== 0) return urgency;
  const observationDifference = Date.parse(right.limit.observedAt) - Date.parse(left.limit.observedAt);
  if (observationDifference !== 0) return observationDifference;
  return left.agent.agent.localeCompare(right.agent.agent);
}

function orderedSubscriptionAgents(
  snapshot: StatuslineSnapshot,
  now: Date
): SubscriptionAgent[] {
  return [...(snapshot.subscription?.agents ?? [])].sort((left, right) => {
    const leftUrgent = [...activeLimits(left, now)].sort(compareUrgency)[0];
    const rightUrgent = [...activeLimits(right, now)].sort(compareUrgency)[0];
    if (leftUrgent && rightUrgent) {
      const urgency = compareUrgency(leftUrgent, rightUrgent);
      if (urgency !== 0) return urgency;
    } else if (leftUrgent) {
      return -1;
    } else if (rightUrgent) {
      return 1;
    }
    const latestDifference = latestLimitObservation(right, now) - latestLimitObservation(left, now);
    if (latestDifference !== 0) return latestDifference;
    const recordsDifference = right.apiEquivalent.sevenDays.recordCount -
      left.apiEquivalent.sevenDays.recordCount;
    if (recordsDifference !== 0) return recordsDifference;
    return left.agent.localeCompare(right.agent);
  });
}

function latestLimitObservation(agent: SubscriptionAgent, now: Date): number {
  return Math.max(0, ...activeLimits(agent, now).map((limit) => Date.parse(limit.observedAt)));
}

function activeLimits(agent: SubscriptionAgent, now: Date): ReportedLimit[] {
  return agent.limits.filter((limit) => Date.parse(limit.resetsAt) > now.getTime());
}

function compareUrgency(left: ReportedLimit, right: ReportedLimit): number {
  const remainingDifference = left.remainingPercent - right.remainingPercent;
  if (remainingDifference !== 0) return remainingDifference;
  const resetDifference = Date.parse(left.resetsAt) - Date.parse(right.resetsAt);
  if (resetDifference !== 0) return resetDifference;
  return limitKindOrder(left.kind) - limitKindOrder(right.kind);
}

function limitKindOrder(kind: ReportedLimit["kind"]): number {
  return kind === "five-hour" ? 0 : 1;
}

function formatLimit(limit: ReportedLimit, now: Date, timeZone?: string): string {
  const label = limit.kind === "five-hour" ? "5h" : "week";
  const reset = formatReset(limit, now, timeZone);
  return `${label} ${formatPercent(limit.remainingPercent)}% left ↻${reset}`;
}

function subscriptionAgentLabel(agent: SubscriptionAgent): "claude" | "codex" {
  return agent.agent === "claude-code" ? "claude" : "codex";
}

function formatAttributedLimit(
  agent: SubscriptionAgent,
  limit: ReportedLimit,
  now: Date,
  timeZone?: string
): string {
  const label = limit.kind === "five-hour" ? "5h" : "week";
  return `${subscriptionAgentLabel(agent)} ${label} ${formatPercent(limit.remainingPercent)}% ↻${
    formatReset(limit, now, timeZone)
  }`;
}

function formatAttributedLimitCompact(
  agent: SubscriptionAgent,
  limit: ReportedLimit
): string {
  const label = limit.kind === "five-hour" ? "5h" : "wk";
  return `${subscriptionAgentLabel(agent)} ${label} ${formatPercent(limit.remainingPercent)}%`;
}

function formatAttributedValue(
  agent: SubscriptionAgent,
  compact = false
): string | undefined {
  const value = agent.apiEquivalent.sevenDays;
  if (value.amountUsd === null || value.financialEvidence !== "estimated") return undefined;
  const window = compact ? "/7d" : " 7d";
  return `${subscriptionAgentLabel(agent)} ~${formatUsd(value.amountUsd)}${window} value`;
}

function formatReset(limit: ReportedLimit, now: Date, timeZone?: string): string {
  const reset = new Date(limit.resetsAt);
  const zone = validTimeZone(timeZone) ? timeZone : undefined;
  if (limit.kind === "weekly") {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: zone
    }).format(reset);
  }
  const sameDay = localDateKey(reset, zone) === localDateKey(now, zone);
  const formatter = new Intl.DateTimeFormat("en-US", sameDay ? {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone
  } : {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone
  });
  return formatter.format(reset).replaceAll(" ", "").toLowerCase();
}

function localDateKey(value: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  }).format(value);
}

function freshnessSegment(snapshot: StatuslineSnapshot, now: Date): string {
  if (snapshot.refresh.status === "error") {
    const attemptAge = now.getTime() - Date.parse(snapshot.lastAttemptAt);
    return attemptAge < 0 ? "update error · clock mismatch" : `update error ${formatAge(attemptAge)}`;
  }
  const ageMs = now.getTime() - Date.parse(snapshot.lastSuccessAt ?? snapshot.generatedAt);
  if (ageMs < 0) return "clock mismatch";
  return ageMs > STALE_AFTER_MS
    ? `stale ${formatAge(ageMs)}`
    : `updated ${formatAge(ageMs)}`;
}

function formatAge(rawAgeMs: number): string {
  const seconds = Math.max(0, Math.floor(rawAgeMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatUsd(amount: number): string {
  if (amount >= 1_000_000_000) return `$${compactNumber(amount / 1_000_000_000)}b`;
  if (amount >= 1_000_000) return `$${compactNumber(amount / 1_000_000)}m`;
  if (amount >= 1_000) return `$${compactNumber(amount / 1_000)}k`;
  if (amount >= 100) return `$${Math.round(amount)}`;
  return `$${amount.toFixed(2)}`;
}

/** Provider-billed money is never compacted or rounded into a different claim. */
function formatBilledUsd(amount: number): string {
  const text = String(amount);
  if (/[eE]/.test(text)) return `$${text}`;
  const [whole, fraction] = text.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimal = fraction === undefined ? ".00" : fraction.length === 1 ? `.${fraction}0` : `.${fraction}`;
  return `$${grouped}${decimal}`;
}

function compactNumber(amount: number): string {
  if (amount >= 100) return String(Math.round(amount));
  if (amount >= 10) return amount.toFixed(1).replace(/\.0$/, "");
  return amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function assembleOverageLine(
  segments: string[],
  overage: string,
  freshness: string,
  columns: number
): string {
  return firstFittingLine([
    ["aibill", ...segments, overage, freshness],
    ["aibill", overage, freshness],
    ["aibill", overage],
    [overage],
    ["OVERAGE billed"],
    ["billed"]
  ], columns);
}

function assembleMultiSubscriptionOverageLine(
  snapshot: StatuslineSnapshot,
  fullSegments: string[],
  overage: string,
  freshness: string,
  tier: string,
  columns: number,
  now: Date
): string {
  const primary = primarySubscriptionLimits(snapshot, now);
  const compactPrimary = primary.map(({ agent, limit }) =>
    formatAttributedLimitCompact(agent, limit));
  const urgent = compactPrimary[0];
  const candidates: string[][] = [];
  if (tier === "full") candidates.push(["aibill", ...fullSegments, overage, freshness]);
  if (tier !== "minimal") {
    candidates.push(["aibill", ...compactPrimary, overage, freshness]);
  }
  if (urgent) candidates.push(["aibill", urgent, overage, freshness]);
  candidates.push(
    ["aibill", overage, freshness],
    ["aibill", overage],
    [overage],
    ["OVERAGE billed"],
    ["billed"]
  );
  return firstFittingLine(candidates, columns);
}

function assembleMixedLine(
  snapshot: StatuslineSnapshot,
  fullSegments: string[],
  freshness: string,
  tier: string,
  columns: number,
  now: Date,
  timeZone?: string
): string {
  const agent = selectSubscriptionAgent(snapshot, now);
  const urgent = agent ? [...activeLimits(agent, now)].sort(compareUrgency)[0] : undefined;
  const runway = urgent ? formatLimitCompact(urgent) : "runway n/r";
  const runwayWithReset = urgent
    ? `${runway} ↻${formatReset(urgent, now, timeZone)}`
    : runway;
  const meteredBilled = snapshot.metered?.providerBilled.sevenDays;
  const meteredEstimated = snapshot.metered?.apiEquivalent.sevenDays;
  const metered = meteredBilled?.amountUsd !== null && meteredBilled?.amountUsd !== undefined &&
    meteredBilled.financialEvidence === "verified"
    ? `m${formatBilledUsd(meteredBilled.amountUsd)}/7d billed`
    : meteredEstimated?.amountUsd !== null && meteredEstimated?.amountUsd !== undefined &&
        meteredEstimated.financialEvidence === "estimated"
      ? `m~${formatUsd(meteredEstimated.amountUsd)}/7d`
      : "m n/r";
  const meteredClear = meteredBilled?.amountUsd !== null && meteredBilled?.amountUsd !== undefined &&
    meteredBilled.financialEvidence === "verified"
    ? `metered ${formatBilledUsd(meteredBilled.amountUsd)}/7d billed`
    : meteredEstimated?.amountUsd !== null && meteredEstimated?.amountUsd !== undefined &&
        meteredEstimated.financialEvidence === "estimated"
      ? `metered ~${formatUsd(meteredEstimated.amountUsd)}/7d`
      : "metered n/r";
  const value = agent?.apiEquivalent.sevenDays;
  const subscription = value?.amountUsd !== null && value?.amountUsd !== undefined &&
    value.financialEvidence === "estimated"
    ? `s~${formatUsd(value.amountUsd)}/7d value`
    : "s value n/r";
  const subscriptionClear = value?.amountUsd !== null && value?.amountUsd !== undefined &&
    value.financialEvidence === "estimated"
    ? `sub ~${formatUsd(value.amountUsd)}/7d value`
    : "sub value n/r";
  const shortFreshness = compactFreshness(freshness);

  const candidates: string[][] = [];
  if (tier === "full") candidates.push(["aibill", ...fullSegments, freshness]);
  if (tier !== "minimal") {
    candidates.push(
      ["aibill", "mix", runwayWithReset, meteredClear, subscriptionClear, freshness],
      ["aibill", "mix", runway, meteredClear, subscriptionClear, shortFreshness],
      ["aibill", "mix", runway, meteredClear, shortFreshness]
    );
  }
  candidates.push(
    ["mix", runway, meteredClear, shortFreshness],
    ["mix", runway.replace("↻", ""), meteredClear],
    ["mix", meteredClear],
    ["mix", metered],
    ["mix"]
  );
  return firstFittingLine(candidates, columns);
}

function assembleMultiSubscriptionLine(
  snapshot: StatuslineSnapshot,
  freshness: string,
  tier: string,
  columns: number,
  now: Date,
  timeZone?: string
): string {
  const entries = orderedSubscriptionLimits(snapshot, now);
  const primary = primarySubscriptionLimits(snapshot, now);
  const agents = orderedSubscriptionAgents(snapshot, now);
  const fullLimits = entries.map(({ agent, limit }) =>
    formatAttributedLimit(agent, limit, now, timeZone));
  const compactLimits = entries.map(({ agent, limit }) =>
    formatAttributedLimitCompact(agent, limit));
  const compactPrimary = primary.map(({ agent, limit }) =>
    formatAttributedLimitCompact(agent, limit));
  const fullValues = agents.flatMap((agent) => formatAttributedValue(agent) ?? []);
  const compactValues = agents.flatMap((agent) => formatAttributedValue(agent, true) ?? []);
  const pressure = agents
    .filter((agent) => agent.pressure === "extra_usage_credits_exhausted")
    .map((agent) => `${subscriptionAgentLabel(agent)} plan pressure`);
  const noRunway = entries.length === 0 ? ["subscription detected", "runway not reported"] : [];
  const urgent = compactPrimary[0];
  const urgentValue = agents[0] ? formatAttributedValue(agents[0], true) : undefined;
  const candidates: string[][] = [];

  if (tier === "full") {
    candidates.push(["aibill", ...noRunway, ...fullLimits, ...fullValues, ...pressure, freshness]);
  }
  if (tier !== "minimal") {
    candidates.push(
      ["aibill", ...noRunway, ...compactLimits, ...compactValues, ...pressure, freshness],
      ["aibill", ...noRunway, ...compactLimits, freshness],
      ["aibill", ...noRunway, ...compactPrimary, ...compactValues, freshness],
      ["aibill", ...noRunway, ...compactPrimary, freshness]
    );
  }
  if (urgent) {
    if (urgentValue) candidates.push(["aibill", urgent, urgentValue, freshness]);
    candidates.push(
      ["aibill", urgent, freshness],
      ["aibill", urgent],
      [urgent]
    );
  } else {
    candidates.push(
      ["aibill", "runway n/r", freshness],
      ["runway n/r", freshness],
      ["aibill", ...noRunway, ...compactValues, freshness],
      ["aibill", ...compactValues, freshness],
      ["aibill", "subscription detected", freshness],
      ["subscription detected"]
    );
  }
  return firstFittingLine(candidates, columns);
}

function assembleMultiSubscriptionMixedLine(
  snapshot: StatuslineSnapshot,
  fullSegments: string[],
  freshness: string,
  tier: string,
  columns: number,
  now: Date,
  timeZone?: string
): string {
  const entries = orderedSubscriptionLimits(snapshot, now);
  const primary = primarySubscriptionLimits(snapshot, now);
  const agents = orderedSubscriptionAgents(snapshot, now);
  const compactLimits = entries.map(({ agent, limit }) =>
    formatAttributedLimitCompact(agent, limit));
  const compactPrimary = primary.map(({ agent, limit }) =>
    formatAttributedLimitCompact(agent, limit));
  const compactValues = agents.flatMap((agent) => formatAttributedValue(agent, true) ?? []);
  const noRunway = entries.length === 0 ? ["subscription detected", "runway not reported"] : [];
  const urgent = compactPrimary[0];
  const urgentValue = agents[0] ? formatAttributedValue(agents[0], true) : undefined;
  const meteredBilled = snapshot.metered?.providerBilled.sevenDays;
  const meteredEstimated = snapshot.metered?.apiEquivalent.sevenDays;
  const metered = meteredBilled?.amountUsd !== null && meteredBilled?.amountUsd !== undefined &&
    meteredBilled.financialEvidence === "verified"
    ? `metered ${formatBilledUsd(meteredBilled.amountUsd)}/7d billed`
    : meteredEstimated?.amountUsd !== null && meteredEstimated?.amountUsd !== undefined &&
        meteredEstimated.financialEvidence === "estimated"
      ? `metered ~${formatUsd(meteredEstimated.amountUsd)}/7d`
      : "metered n/r";
  const shortFreshness = compactFreshness(freshness);
  const candidates: string[][] = [];

  if (tier === "full") candidates.push(["aibill", ...fullSegments, freshness]);
  if (tier !== "minimal") {
    candidates.push(
      ["aibill", "mix", ...noRunway, ...compactLimits, metered, ...compactValues, freshness],
      ["aibill", "mix", ...noRunway, ...compactPrimary, metered, freshness]
    );
  }
  if (urgent) {
    if (urgentValue) candidates.push(["aibill", "mix", urgent, metered, urgentValue, shortFreshness]);
    candidates.push(
      ["aibill", "mix", urgent, metered, shortFreshness],
      ["mix", urgent, metered],
      ["aibill", urgent, shortFreshness],
      ["aibill", urgent],
      [urgent]
    );
  } else {
    candidates.push(
      ["aibill", "mix", ...noRunway, metered, freshness],
      ["aibill", ...noRunway, freshness],
      ["aibill", "mix", "runway n/r", metered, shortFreshness],
      ["mix", "runway n/r", metered, shortFreshness],
      ["mix", "runway n/r", shortFreshness]
    );
  }
  candidates.push(["mix", metered, shortFreshness], ["mix", metered], ["mix"]);
  return firstFittingLine(candidates, columns);
}

function formatLimitCompact(limit: ReportedLimit): string {
  const label = limit.kind === "five-hour" ? "5h" : "wk";
  return `${label} ${formatPercent(limit.remainingPercent)}% left`;
}

function compactFreshness(value: string): string {
  return value
    .replace(/^updated /, "upd ")
    .replace(/^update error /, "err ");
}

function firstFittingLine(candidates: string[][], columns: number): string {
  for (const candidate of candidates) {
    const line = sanitizeLine(candidate.join(" · "));
    if (displayWidth(line) <= columns) return line;
  }
  const fallback = sanitizeLine(candidates.at(-1)?.join(" · ") ?? "aibill");
  return clipLine(fallback, columns);
}

function assembleLine(
  segments: string[],
  freshness: string,
  columns: number,
  mandatory?: string
): string {
  const prefix = "aibill";
  const complete = [prefix, ...segments, freshness].join(" · ");
  if (displayWidth(complete) <= columns) return sanitizeLine(complete);
  const prioritized = mandatory
    ? [mandatory, ...segments.filter((segment) => segment !== mandatory)]
    : segments;
  const selected: string[] = [];
  for (const segment of prioritized) {
    const candidate = [prefix, ...selected, segment, freshness].join(" · ");
    if (displayWidth(candidate) <= columns) selected.push(segment);
  }
  if (selected.length === 0 && prioritized.length > 0) selected.push(prioritized[0]!);
  const withFreshness = [prefix, ...selected, freshness].join(" · ");
  if (displayWidth(withFreshness) <= columns) return sanitizeLine(withFreshness);
  const withoutFreshness = [prefix, ...selected].join(" · ");
  if (displayWidth(withoutFreshness) <= columns) return sanitizeLine(withoutFreshness);
  return clipLine(withoutFreshness, columns);
}

function fitStatic(value: string, columns: number): string {
  return displayWidth(value) <= columns ? sanitizeLine(value) : clipLine(value, columns);
}

function clipLine(value: string, columns: number): string {
  const clean = sanitizeLine(value);
  if (displayWidth(clean) <= columns) return clean;
  if (columns <= 1) return "…".slice(0, columns);
  return `${[...clean].slice(0, columns - 1).join("")}…`;
}

function sanitizeLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function displayWidth(value: string): number {
  return [...value].length;
}

function normalizeColumns(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COLUMNS;
  return Math.max(1, Math.min(MAX_COLUMNS, Math.floor(value)));
}

function validDate(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseSnapshot(raw: unknown): StatuslineSnapshot | undefined {
  if (!isRecord(raw) || !hasExactKeys(raw, [
    "kind", "schemaVersion", "currency", "asOf", "generatedAt", "lastAttemptAt",
    "lastSuccessAt", "refresh", "mode", "subscription", "metered", "unresolved",
    "overage", "coverage", "networkUploaded"
  ])) return undefined;
  if (raw.kind !== "aibill.activity_snapshot" || raw.schemaVersion !== 1 ||
      raw.currency !== "USD" || raw.networkUploaded !== false ||
      !isIso(raw.asOf) || !isIso(raw.generatedAt) || !isIso(raw.lastAttemptAt) ||
      !(raw.lastSuccessAt === null || isIso(raw.lastSuccessAt)) ||
      !isRefresh(raw.refresh) || !isMode(raw.mode) || !isCoverage(raw.coverage) ||
      !(raw.subscription === null || isSubscription(raw.subscription)) ||
      !(raw.metered === null || isMetered(raw.metered)) ||
      !(raw.unresolved === null || isUnresolved(raw.unresolved)) ||
      !(raw.overage === null || isOverage(raw.overage))) return undefined;

  const snapshot = raw as StatuslineSnapshot;
  if (snapshot.mode === "metered" && (!snapshot.metered || snapshot.subscription)) return undefined;
  if (snapshot.mode === "subscription" && (!snapshot.subscription || snapshot.metered)) return undefined;
  if (snapshot.mode === "mixed" && (!snapshot.subscription || !snapshot.metered)) return undefined;
  if (snapshot.mode === "unresolved" && (!snapshot.unresolved || snapshot.subscription || snapshot.metered)) {
    return undefined;
  }
  if ((snapshot.mode === "empty" || snapshot.mode === "error") &&
      (snapshot.subscription || snapshot.metered || snapshot.unresolved || snapshot.overage)) {
    return undefined;
  }
  if (snapshot.mode === "error" && snapshot.refresh.status !== "error") return undefined;
  if (snapshot.refresh.status === "ok" && snapshot.lastSuccessAt === null) return undefined;
  if (snapshot.overage && !snapshot.metered) return undefined;
  const cohortAgents = [
    ...(snapshot.subscription?.agents ?? []),
    ...(snapshot.metered?.agents ?? []),
    ...(snapshot.unresolved?.agents ?? [])
  ].map((agent) => agent.agent);
  if (new Set(cohortAgents).size !== cohortAgents.length) return undefined;
  const asOfMs = Date.parse(snapshot.asOf);
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  const lastAttemptAtMs = Date.parse(snapshot.lastAttemptAt);
  const lastSuccessAtMs = snapshot.lastSuccessAt === null ? null : Date.parse(snapshot.lastSuccessAt);
  if (asOfMs > generatedAtMs) return undefined;
  const providers = (raw.coverage as Record<string, unknown>).providers as Array<Record<string, unknown>>;
  for (const provider of providers) {
    for (const field of ["checkedAt", "latestEvidenceAt", "coverageEnd"] as const) {
      const value = provider[field];
      if (typeof value === "string" && Date.parse(value) > generatedAtMs) return undefined;
    }
  }
  if (snapshot.refresh.status === "ok") {
    if (snapshot.mode === "error" || lastSuccessAtMs !== generatedAtMs || lastAttemptAtMs !== asOfMs) {
      return undefined;
    }
  } else if (snapshot.lastSuccessAt === null) {
    if (snapshot.mode !== "error" || lastAttemptAtMs !== asOfMs || generatedAtMs !== asOfMs) {
      return undefined;
    }
  } else if (snapshot.mode === "error" || lastSuccessAtMs !== generatedAtMs ||
             lastAttemptAtMs < generatedAtMs) {
    return undefined;
  }
  return snapshot;
}

function isRefresh(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.status === "ok"
    ? hasExactKeys(value, ["status"])
    : value.status === "error" && hasExactKeys(value, ["status", "errorCode"]) &&
      ["scan_failed", "source_unreadable", "invalid_evidence", "timeout", "cache_write_failed", "unknown"]
        .includes(String(value.errorCode));
}

function isSubscription(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["agents"]) && Array.isArray(value.agents) &&
    value.agents.length >= 1 && value.agents.length <= 2 && value.agents.every(isSubscriptionAgent) &&
    uniqueAgents(value.agents);
}

function isSubscriptionAgent(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "agent", "billing", "planId", "apiEquivalent", "limits", "pressure"
  ]) && isAgent(value.agent) && value.billing === "subscription" && isPlanId(value.planId) &&
    isApiWindows(value.apiEquivalent) && Array.isArray(value.limits) && value.limits.length <= 2 &&
    value.limits.every(isLimit) && new Set(value.limits.map((limit) => (limit as Record<string, unknown>).kind)).size === value.limits.length &&
    (value.pressure === null || value.pressure === "extra_usage_credits_exhausted");
}

function isLimit(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "usedPercent", "remainingPercent", "observedAt", "resetsAt", "source"
  ])) return false;
  return (value.kind === "five-hour" || value.kind === "weekly") &&
    isPercent(value.usedPercent) && isPercent(value.remainingPercent) &&
    Math.abs(Number(value.usedPercent) + Number(value.remainingPercent) - 100) <= 0.11 &&
    isIso(value.observedAt) && isIso(value.resetsAt) &&
    Date.parse(value.observedAt) < Date.parse(value.resetsAt) &&
    value.source === "transcript_reported";
}

function isMetered(value: unknown): boolean {
  if (!(isRecord(value) && hasExactKeys(value, ["agents", "apiEquivalent", "providerBilled"]) &&
    Array.isArray(value.agents) && value.agents.length <= 2 &&
    value.agents.every((agent) => isBillingAgent(agent, "api_key")) && uniqueAgents(value.agents) &&
    isApiWindows(value.apiEquivalent) && isBilledWindows(value.providerBilled))) return false;
  return value.agents.length > 0 || windowsHaveEvidence(value.apiEquivalent) ||
    windowsHaveEvidence(value.providerBilled);
}

function isUnresolved(value: unknown): boolean {
  if (!(isRecord(value) && hasExactKeys(value, ["agents", "apiEquivalent"]) &&
    Array.isArray(value.agents) && value.agents.length <= 2 &&
    value.agents.every((agent) => isBillingAgent(agent, "unknown")) && uniqueAgents(value.agents) &&
    isApiWindows(value.apiEquivalent))) return false;
  return value.agents.length > 0 || windowsHaveEvidence(value.apiEquivalent);
}

function isBillingAgent(value: unknown, billing: "api_key" | "unknown"): boolean {
  return isRecord(value) && hasExactKeys(value, ["agent", "billing", "planId"]) &&
    isAgent(value.agent) && value.billing === billing && isPlanId(value.planId);
}

function isApiWindows(value: unknown): boolean {
  return isWindows(value, isApiWindow);
}

function isBilledWindows(value: unknown): boolean {
  return isWindows(value, isBilledWindow);
}

function isWindows(value: unknown, validator: (window: unknown) => boolean): boolean {
  return isRecord(value) && hasExactKeys(value, ["oneDay", "sevenDays", "thirtyDays"]) &&
    validator(value.oneDay) && validator(value.sevenDays) && validator(value.thirtyDays);
}

function isApiWindow(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "amountUsd", "recordCount", "basis", "financialEvidence", "coverage"
  ]) || !nullableUsd(value.amountUsd) || !isCount(value.recordCount) ||
      value.basis !== "api_equivalent" ||
      !(value.financialEvidence === "estimated" || value.financialEvidence === "missing") ||
      !isWindowCoverage(value.coverage)) return false;
  if ((value.amountUsd === null) !== (value.financialEvidence === "missing")) return false;
  if (value.coverage === "missing" && value.amountUsd !== null) return false;
  return value.recordCount !== 0 || value.amountUsd === null ||
    (value.amountUsd === 0 && value.coverage === "complete");
}

function isBilledWindow(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "amountUsd", "recordCount", "basis", "financialEvidence", "coverage"
  ]) || !nullableUsd(value.amountUsd) || !isCount(value.recordCount) ||
      value.basis !== "provider_billed" ||
      !(value.financialEvidence === "verified" || value.financialEvidence === "missing") ||
      !isWindowCoverage(value.coverage)) return false;
  if ((value.amountUsd === null) !== (value.financialEvidence === "missing")) return false;
  if (value.coverage === "missing" && value.amountUsd !== null) return false;
  return value.recordCount !== 0 || value.amountUsd === null ||
    (value.amountUsd === 0 && value.coverage === "complete");
}

function isOverage(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "amountUsd", "currency", "basis", "financialEvidence", "alertEligible", "recordCount"
  ]) && isPositiveUsd(value.amountUsd) && value.currency === "USD" &&
    value.basis === "provider_billed" && value.financialEvidence === "verified" &&
    value.alertEligible === true && isPositiveCount(value.recordCount);
}

function isCoverage(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "agents", "providers", "recordsParsed", "recordsPriced", "recordsUnpriced",
    "validationStatus", "pricingAsOf", "networkUploaded"
  ]) || !Array.isArray(value.agents) || value.agents.length > 2 ||
      !value.agents.every(isAgentCoverage) || !uniqueAgents(value.agents) ||
      !Array.isArray(value.providers) || value.providers.length > 5 ||
      !value.providers.every(isProviderCoverage) || !uniqueValues(value.providers, "provider") ||
      !isCount(value.recordsParsed) || !isCount(value.recordsPriced) ||
      !isCount(value.recordsUnpriced) ||
      Number(value.recordsPriced) + Number(value.recordsUnpriced) !== Number(value.recordsParsed) ||
      !["complete", "partial", "failed", "not_checked"].includes(String(value.validationStatus)) ||
      typeof value.pricingAsOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.pricingAsOf) ||
      value.networkUploaded !== false) return false;
  return true;
}

function isAgentCoverage(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, [
    "agent", "directoryStatus", "filesDiscovered", "filesParsed", "malformedLines",
    "unreadableFiles", "unsupportedUsageSnapshots", "filesSkippedBeforeWindow",
    "filesReadFinancially", "bytesSkippedAsNonFinancialHistory", "nonFinancialLinesPrefiltered",
    "nonFinancialBytesPrefiltered", "jsonlValidationCoverage"
  ]) && isAgent(value.agent) && ["readable", "missing", "unreadable"].includes(String(value.directoryStatus)) &&
    ["filesDiscovered", "filesParsed", "malformedLines", "unreadableFiles", "unsupportedUsageSnapshots",
      "filesSkippedBeforeWindow", "filesReadFinancially", "bytesSkippedAsNonFinancialHistory",
      "nonFinancialLinesPrefiltered", "nonFinancialBytesPrefiltered"].every((key) => isCount(value[key])) &&
    ["complete", "financial_events_only", "not_reported"].includes(String(value.jsonlValidationCoverage));
}

function isProviderCoverage(value: unknown): boolean {
  if (!(isRecord(value) && hasExactKeys(value, [
    "provider", "status", "validationCoverage", "checkedAt", "latestEvidenceAt",
    "coverageStart", "coverageEnd"
  ]) && ["openai", "anthropic", "cursor", "github-copilot", "other"].includes(String(value.provider)) &&
    ["complete", "partial", "unavailable", "error"].includes(String(value.status)) &&
    ["live_verified", "fixture_verified", "untested", "failed"].includes(String(value.validationCoverage)) &&
    ["checkedAt", "latestEvidenceAt", "coverageStart", "coverageEnd"]
      .every((key) => value[key] === null || isIso(value[key])))) return false;
  const checkedAt = value.checkedAt === null ? null : Date.parse(String(value.checkedAt));
  const latest = value.latestEvidenceAt === null ? null : Date.parse(String(value.latestEvidenceAt));
  const start = value.coverageStart === null ? null : Date.parse(String(value.coverageStart));
  const end = value.coverageEnd === null ? null : Date.parse(String(value.coverageEnd));
  if ((latest !== null || start !== null || end !== null) && checkedAt === null) return false;
  if (latest !== null && checkedAt !== null && latest > checkedAt) return false;
  if ((start === null) !== (end === null)) return false;
  if (start !== null && end !== null && start > end) return false;
  if (end !== null && checkedAt !== null && end > checkedAt) return false;
  return !(latest !== null && start !== null && end !== null && (latest < start || latest > end));
}

function windowsHaveEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.oneDay, value.sevenDays, value.thirtyDays].some((window) =>
    isRecord(window) && (Number(window.recordCount) > 0 || window.amountUsd !== null)
  );
}

function isMode(value: unknown): boolean {
  return ["metered", "subscription", "mixed", "unresolved", "empty", "error"].includes(String(value));
}

function isAgent(value: unknown): boolean {
  return value === "claude-code" || value === "codex";
}

function isPlanId(value: unknown): boolean {
  return value === null || [
    "claude-pro", "claude-max-5x", "claude-max-20x", "chatgpt-plus", "chatgpt-pro"
  ].includes(String(value));
}

function isWindowCoverage(value: unknown): boolean {
  return value === "complete" || value === "partial" || value === "missing";
}

function nullableUsd(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isPositiveUsd(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPercent(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCount(value: unknown): boolean {
  return isCount(value) && Number(value) > 0;
}

function isIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[9]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[10]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function uniqueAgents(values: unknown[]): boolean {
  return uniqueValues(values, "agent");
}

function uniqueValues(values: unknown[], key: string): boolean {
  const selected = values.map((value) => isRecord(value) ? value[key] : undefined);
  return new Set(selected).size === selected.length;
}

function hasPrivatePermissions(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(resolve(entry))).href ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  process.stdout.on("error", () => {
    process.exitCode = 0;
  });
  process.stdin.on("error", () => {
    process.exitCode = 0;
  });
  void runStatuslineHook().then(() => {
    process.exitCode = 0;
  }).catch(() => {
    try {
      process.stdout.write("aibill · cache error · run aibill init\n");
    } catch {
      // No stderr or non-zero exit on a hook path.
    }
    process.exitCode = 0;
  });
}

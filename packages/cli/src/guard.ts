import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  AIBILL_POLICY_RELATIVE_PATH,
  aibillPolicyHasBudget,
  parseAibillPolicy,
  type AibillPolicy,
  type AibillPolicyIssue
} from "@agent-finops/core";
import { computeGuardUsage, type GuardBudget, type GuardUsageOptions, type GuardUsageResult } from "./guardUsage.js";
import { GUARD_LAUNCHER_RELATIVE_PATH, readGuardInstallState, type GuardInstallState } from "./guardSettings.js";
import { displayPath, formatRemaining, type TranscriptListing } from "./guardStamp.js";
import { resolveCheckoutRoot, resolveRepositoryRoot } from "./repositoryRoot.js";

/**
 * `aibill guard check`: the decision a Claude Code hook needs, and
 * `aibill guard status`: the same facts for a human. Design rule 2 governs
 * every branch here: the guard blocks only when the local transcripts make
 * the spent budget certain; a missing policy, a repository it cannot find,
 * transcripts it cannot read, hook input it could not parse (for the rule that
 * needs it) or an index still catching up all end in exit 0 with one warning
 * line, never in a blocked developer. Model limits are not the hook's job:
 * `availableModels` and `deniedModels` in the settings enforce them.
 */

export type GuardPolicyLoad =
  | { status: "ok"; path: string; policy: AibillPolicy }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; issues: AibillPolicyIssue[] }
  | { status: "unreadable"; path: string; reason: string };

export async function loadGuardPolicy(repositoryRoot: string): Promise<GuardPolicyLoad> {
  const path = join(repositoryRoot, AIBILL_POLICY_RELATIVE_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", path };
    return { status: "unreadable", path, reason: (error as NodeJS.ErrnoException).code ?? "read error" };
  }
  const parsed = parseAibillPolicy(text);
  if (!parsed.ok) return { status: "invalid", path, issues: parsed.issues };
  return { status: "ok", path, policy: parsed.policy };
}

export function describePolicyIssues(issues: readonly AibillPolicyIssue[]): string {
  return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ");
}

export type GuardCheckRequest = {
  /** The directory the hook ran in (the hook input's `cwd`, else the process cwd). */
  cwd: string;
  /** The hook input's `session_id`; that session is never counted against itself. */
  sessionId?: string;
  /**
   * True when the hook's stdin could not be read or parsed, so the current
   * session is unknown. The sessions rule is then skipped: counting the
   * running session as a new one would block a developer on missing input.
   */
  hookInputIncomplete?: boolean;
  hookEventName?: string;
  now?: Date;
};

export type GuardCheckDependencies = Partial<Pick<GuardUsageOptions,
  "claudeProjectsDir" | "cacheDirectory" | "homeDirectory" | "readBudgetBytes" | "resolveRepositoryRoot" | "listing">>;

export type GuardCheckReason =
  | "no_repository"
  | "no_policy"
  | "invalid_policy"
  | "nothing_to_enforce"
  | "usage_unavailable"
  | "usage_indexing"
  | "within_budget"
  | "tokens_spent"
  | "output_tokens_spent"
  | "sessions_spent";

export type GuardCheckOutcome = {
  exitCode: 0 | 2;
  /** Block message (exit 2) or a one-line warning (exit 0, may be empty). */
  stderr: string;
  reason: GuardCheckReason;
  repositoryRoot?: string;
  policy?: AibillPolicy;
  usage?: GuardUsageResult;
};

export function guardBudgetOf(policy: AibillPolicy): GuardBudget | undefined {
  const perDay = policy.budget?.perDay;
  if (!perDay || !aibillPolicyHasBudget(policy)) return undefined;
  return { tokens: perDay.tokens, outputTokens: perDay.outputTokens, sessions: perDay.sessions };
}

export async function checkGuard(request: GuardCheckRequest, dependencies: GuardCheckDependencies = {}): Promise<GuardCheckOutcome> {
  const now = request.now ?? new Date();
  const findRoot = dependencies.resolveRepositoryRoot ?? resolveRepositoryRoot;
  const cwd = isAbsolute(request.cwd) ? resolve(request.cwd) : resolve(process.cwd(), request.cwd);
  const repositoryRoot = findRoot(cwd);
  if (!repositoryRoot) {
    return { exitCode: 0, stderr: "aibill guard: not inside a repository; nothing to enforce.", reason: "no_repository" };
  }
  const repository = basename(repositoryRoot);
  const loaded = await loadGuardPolicy(repositoryRoot);
  if (loaded.status === "missing") {
    return {
      exitCode: 0,
      stderr: `aibill guard: ${repository} has no ${AIBILL_POLICY_RELATIVE_PATH}; nothing enforced.`,
      reason: "no_policy",
      repositoryRoot
    };
  }
  if (loaded.status === "unreadable") {
    return {
      exitCode: 0,
      stderr: `aibill guard: ${AIBILL_POLICY_RELATIVE_PATH} could not be read (${loaded.reason}); nothing enforced.`,
      reason: "invalid_policy",
      repositoryRoot
    };
  }
  if (loaded.status === "invalid") {
    return {
      exitCode: 0,
      stderr: `aibill guard: ${AIBILL_POLICY_RELATIVE_PATH} is invalid (${describePolicyIssues(loaded.issues)}); nothing enforced.`,
      reason: "invalid_policy",
      repositoryRoot
    };
  }
  const policy = loaded.policy;
  const budget = guardBudgetOf(policy);
  if (!budget) {
    return { exitCode: 0, stderr: "", reason: "nothing_to_enforce", repositoryRoot, policy };
  }

  let usage: GuardUsageResult;
  try {
    usage = await computeGuardUsage({ ...dependencies, repositoryRoot, now, budget });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 0,
      stderr: `aibill guard: today's usage could not be read (${reason}); not blocking.`,
      reason: "usage_unavailable",
      repositoryRoot,
      policy
    };
  }
  if (usage.transcripts !== "readable") {
    return {
      exitCode: 0,
      stderr: `aibill guard: the Claude Code transcript directory is ${usage.transcripts}; today's usage is unknown, not blocking.`,
      reason: "usage_unavailable",
      repositoryRoot,
      policy,
      usage
    };
  }
  if (!usage.complete) {
    return {
      exitCode: 0,
      stderr: "aibill guard: still indexing today's transcripts; not blocking until the figure is complete.",
      reason: "usage_indexing",
      repositoryRoot,
      policy,
      usage
    };
  }

  const lead = policy.message ?? `${repository}'s daily agent budget is spent.`;
  const pause = `paused until 00:00 UTC (in ${formatRemaining(usage.dayEndMs - now.getTime())})`;
  const atLeast = usage.incompleteCalls > 0 ? "at least " : "";
  if (budget.tokens !== undefined && usage.tokens >= budget.tokens) {
    return {
      exitCode: 2,
      stderr: [
        lead,
        `${repository} used ${atLeast}${formatTokenCount(usage.tokens)} tokens of its ${formatTokenCount(budget.tokens)} daily budget (UTC ${usage.dayKey}); ${pause}. aibill guard`
      ].join("\n"),
      reason: "tokens_spent",
      repositoryRoot,
      policy,
      usage
    };
  }
  if (budget.outputTokens !== undefined && usage.outputTokens >= budget.outputTokens) {
    return {
      exitCode: 2,
      stderr: [
        lead,
        `${repository} produced ${atLeast}${formatTokenCount(usage.outputTokens)} output tokens of its ${formatTokenCount(budget.outputTokens)} daily budget (UTC ${usage.dayKey}); ${pause}. aibill guard`
      ].join("\n"),
      reason: "output_tokens_spent",
      repositoryRoot,
      policy,
      usage
    };
  }
  if (budget.sessions !== undefined) {
    if (request.hookInputIncomplete) {
      return {
        exitCode: 0,
        stderr: "aibill guard: the hook input could not be read, so the current session is unknown; the sessions budget was not evaluated this time.",
        reason: "within_budget",
        repositoryRoot,
        policy,
        usage
      };
    }
    const otherSessions = usage.sessionIds.filter((id) => id !== request.sessionId).length;
    if (otherSessions >= budget.sessions) {
      const total = usage.sessionIds.length;
      return {
        exitCode: 2,
        stderr: [
          lead,
          `${repository} ran ${total} Claude Code session${total === 1 ? "" : "s"} of its ${budget.sessions} per day (UTC ${usage.dayKey}); new sessions ${pause}. aibill guard`
        ].join("\n"),
        reason: "sessions_spent",
        repositoryRoot,
        policy,
        usage
      };
    }
  }
  return { exitCode: 0, stderr: "", reason: "within_budget", repositoryRoot, policy, usage };
}

/** 1900000 → 1.9M, 950000 → 950k, 1500 → 1.5k, 42 → 42. */
export function formatTokenCount(value: number): string {
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
      return `${text}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export { formatRemaining };

/** One line naming the package the launcher resolves, `~`-relative; never an absolute home path. */
export function describeHookPackage(hookPackage: GuardInstallState["hookPackage"], homeDirectory = homedir()): string {
  if (hookPackage.source === "none") {
    return `nothing yet; ${hookPackage.reason} (looked in ${hookPackage.tried.map((root) => displayPath(root, homeDirectory)).join(", ")})`;
  }
  return `${displayPath(hookPackage.entry, homeDirectory)} (${hookPackage.source === "repository" ? "declared in package.json" : "global install"})`;
}

export type GuardStatusInput = {
  repositoryRoot: string;
  homeDirectory?: string;
  /** The checkout the settings are read from; differs from the repository in a linked worktree. */
  checkoutRoot: string;
  policy: GuardPolicyLoad;
  usage?: GuardUsageResult;
  usageError?: string;
  install: GuardInstallState;
  now: Date;
};

/** The policy in force, today's figures against it and what is installed where. Never a person. */
export function renderGuardStatus(input: GuardStatusInput): string {
  const repository = basename(input.repositoryRoot);
  const lines: string[] = [`aibill guard · ${repository}`];
  if (input.checkoutRoot !== input.repositoryRoot) {
    lines.push(`checkout    linked worktree ${basename(input.checkoutRoot)}; the policy and today's figures belong to ${repository}`);
  }
  const { policy } = input;
  if (policy.status === "missing") {
    lines.push(`policy      none: ${AIBILL_POLICY_RELATIVE_PATH} is missing, so nothing is enforced here`);
  } else if (policy.status === "invalid") {
    lines.push(`policy      invalid: ${describePolicyIssues(policy.issues)}`);
    lines.push("            nothing is enforced until the file validates");
  } else if (policy.status === "unreadable") {
    lines.push(`policy      unreadable (${policy.reason}); nothing is enforced`);
  } else {
    const current = policy.policy;
    lines.push(`policy      ${AIBILL_POLICY_RELATIVE_PATH} (version ${current.version})`);
    const allow = current.models?.allow?.join(", ");
    const deny = current.models?.deny?.join(", ");
    if (allow || deny) {
      lines.push(`  models    allow: ${allow ?? "any"} · deny: ${deny ?? "none"}${deny ? " (deniedModels is honoured from managed settings only)" : ""}`);
    } else {
      lines.push("  models    no allow or deny list");
    }
    const budget = guardBudgetOf(current);
    if (budget) {
      lines.push(`  budget    per UTC day: ${[
        budget.tokens !== undefined ? `${formatTokenCount(budget.tokens)} tokens` : undefined,
        budget.outputTokens !== undefined ? `${formatTokenCount(budget.outputTokens)} output tokens` : undefined,
        budget.sessions !== undefined ? `${budget.sessions} session${budget.sessions === 1 ? "" : "s"}` : undefined
      ].filter(Boolean).join(" · ")}`);
    } else {
      lines.push("  budget    none");
    }
    lines.push(`  hook      every prompt${current.perToolCall ? " and every tool call (perToolCall)" : ""}`);
    if (current.message) lines.push(`  message   ${current.message}`);
    if (current.codex?.model) lines.push(`  codex     model ${current.codex.model} · reported only; Codex is not enforced`);
  }

  if (input.usage) {
    const usage = input.usage;
    if (usage.transcripts !== "readable") {
      lines.push(`today       ${usage.dayKey} UTC · transcript directory ${usage.transcripts}; usage unknown`);
    } else {
      const budget = policy.status === "ok" ? guardBudgetOf(policy.policy) : undefined;
      const parts: string[] = [];
      const atLeast = usage.incompleteCalls > 0 ? "at least " : "";
      parts.push(budget?.tokens !== undefined
        ? `${atLeast}${formatTokenCount(usage.tokens)} of ${formatTokenCount(budget.tokens)} tokens (${percent(usage.tokens, budget.tokens)})`
        : `${atLeast}${formatTokenCount(usage.tokens)} tokens`);
      parts.push(budget?.outputTokens !== undefined
        ? `${atLeast}${formatTokenCount(usage.outputTokens)} of ${formatTokenCount(budget.outputTokens)} output tokens (${percent(usage.outputTokens, budget.outputTokens)})`
        : `${atLeast}${formatTokenCount(usage.outputTokens)} output tokens`);
      const sessions = usage.sessionIds.length;
      parts.push(budget?.sessions !== undefined
        ? `${sessions} of ${budget.sessions} sessions`
        : `${sessions} session${sessions === 1 ? "" : "s"}`);
      parts.push(`resets in ${formatRemaining(usage.dayEndMs - input.now.getTime())}`);
      lines.push(`today       ${usage.dayKey} UTC · ${parts.join(" · ")}`);
      lines.push(`            evidence: ${usage.filesConsidered} transcript file${usage.filesConsidered === 1 ? "" : "s"} touched today · ` +
        `${usage.complete ? "complete" : "still indexing"} · cache ${usage.cache}` +
        `${usage.filesUnreadable > 0 ? ` · ${usage.filesUnreadable} unreadable` : ""}`);
    }
  } else if (input.usageError) {
    lines.push(`today       usage could not be read: ${input.usageError}`);
  }

  const install = input.install;
  const settingsState = !install.settingsExists
    ? "absent"
    : !install.settingsReadable
      ? "unreadable"
      : [
        install.availableModels === undefined
          ? "availableModels: not set"
          : install.availableModelsMatchPolicy
            ? "availableModels: set from the policy"
            : "availableModels: set, differs from the policy",
        install.hookEvents.length === 0 ? "hooks: none" : `hooks: ${install.hookEvents.join(", ")}`
      ].join(" · ");
  lines.push(`installed   .claude/settings.json: ${settingsState}`);
  lines.push(`            ${GUARD_LAUNCHER_RELATIVE_PATH}: ${install.launcher}`);
  lines.push(`            hook runs: ${describeHookPackage(install.hookPackage, input.homeDirectory)}`);
  if (install.managed.files.length === 0) {
    lines.push(`managed     none found in ${install.managed.directory}`);
    lines.push("            project settings are a convention a developer can edit; `aibill guard install --managed` prints the enforced form");
  } else {
    const overrides = [
      install.managed.availableModels ? "availableModels" : undefined,
      install.managed.deniedModels ? "deniedModels" : undefined,
      install.managed.guardHook ? "the guard hook" : undefined
    ].filter(Boolean);
    lines.push(`managed     ${install.managed.files.length} file${install.managed.files.length === 1 ? "" : "s"} in ${install.managed.directory}` +
      (overrides.length > 0 ? ` set ${overrides.join(", ")}; managed values win over project settings` : "; none of them sets a guard key"));
  }
  return lines.join("\n");
}

function percent(used: number, limit: number): string {
  return `${Math.floor(used / limit * 100)}%`;
}

/** Everything `guard status` prints, computed read-only. */
export async function collectGuardStatus(options: {
  cwd: string;
  now?: Date;
  homeDirectory?: string;
  dependencies?: GuardCheckDependencies;
}): Promise<{ repositoryRoot: string; text: string } | { repositoryRoot: undefined; text: string }> {
  const now = options.now ?? new Date();
  const findRoot = options.dependencies?.resolveRepositoryRoot ?? resolveRepositoryRoot;
  const cwd = resolve(options.cwd);
  const repositoryRoot = findRoot(cwd);
  if (!repositoryRoot) {
    return { repositoryRoot: undefined, text: "aibill guard: not inside a repository; run it from a checkout that holds .aibill/policy.json." };
  }
  const checkoutRoot = resolveCheckoutRoot(cwd) ?? repositoryRoot;
  const policy = await loadGuardPolicy(repositoryRoot);
  const homeDirectory = options.homeDirectory ?? homedir();
  let usage: GuardUsageResult | undefined;
  let usageError: string | undefined;
  if (policy.status === "ok" && aibillPolicyHasBudget(policy.policy)) {
    try {
      usage = await computeGuardUsage({ ...options.dependencies, homeDirectory, repositoryRoot, now, budget: guardBudgetOf(policy.policy) });
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
    }
  }
  const install = await readGuardInstallState({
    checkoutRoot,
    policy: policy.status === "ok" ? policy.policy : undefined,
    homeDirectory
  });
  return { repositoryRoot, text: renderGuardStatus({ repositoryRoot, checkoutRoot, homeDirectory, policy, usage, usageError, install, now }) };
}

export type { TranscriptListing };

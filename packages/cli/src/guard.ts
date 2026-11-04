import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  AIBILL_POLICY_RELATIVE_PATH,
  aibillPolicyHasBudget,
  findMatchingPolicyModel,
  parseAibillPolicy,
  type AibillPolicy,
  type AibillPolicyIssue
} from "@agent-finops/core";
import { computeGuardUsage, type GuardUsageOptions, type GuardUsageResult } from "./guardUsage.js";
import { GUARD_LAUNCHER_RELATIVE_PATH, readGuardInstallState, type GuardInstallState } from "./guardSettings.js";
import { resolveRepositoryRoot } from "./repositoryRoot.js";

/**
 * `aibill guard check`: the decision a Claude Code hook needs, and
 * `aibill guard status`: the same facts for a human. Design rule 2 governs
 * every branch here: the guard blocks only when the local transcripts make
 * the spent budget certain; a missing policy, a repository it cannot find,
 * transcripts it cannot read or an index still catching up all end in exit 0
 * with one warning line, never in a blocked developer.
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
  /** A `model` field when the hook event carries one; refused when the policy denies it. */
  model?: string;
  hookEventName?: string;
  now?: Date;
};

export type GuardCheckDependencies = Partial<Pick<GuardUsageOptions, "claudeProjectsDir" | "cacheDirectory" | "homeDirectory" | "readBudgetBytes" | "resolveRepositoryRoot">>;

export type GuardCheckReason =
  | "no_repository"
  | "no_policy"
  | "invalid_policy"
  | "nothing_to_enforce"
  | "model_denied"
  | "usage_unavailable"
  | "usage_indexing"
  | "within_budget"
  | "tokens_spent"
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

  if (request.model) {
    const denied = findMatchingPolicyModel(request.model, policy.models?.deny);
    if (denied) {
      return {
        exitCode: 2,
        stderr: [
          ...(policy.message ? [policy.message] : []),
          `Model ${request.model} is denied by ${repository}'s policy (${AIBILL_POLICY_RELATIVE_PATH} models.deny: ${denied}). aibill guard`
        ].join("\n"),
        reason: "model_denied",
        repositoryRoot,
        policy
      };
    }
  }

  if (!aibillPolicyHasBudget(policy)) {
    return { exitCode: 0, stderr: "", reason: "nothing_to_enforce", repositoryRoot, policy };
  }
  const perDay = policy.budget!.perDay!;

  let usage: GuardUsageResult;
  try {
    usage = await computeGuardUsage({ ...dependencies, repositoryRoot, now });
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
  if (perDay.tokens !== undefined && usage.tokens >= perDay.tokens) {
    return {
      exitCode: 2,
      stderr: [
        lead,
        `${repository} used ${atLeast}${formatTokenCount(usage.tokens)} tokens of its ${formatTokenCount(perDay.tokens)} daily budget (UTC ${usage.dayKey}); ${pause}. aibill guard`
      ].join("\n"),
      reason: "tokens_spent",
      repositoryRoot,
      policy,
      usage
    };
  }
  if (perDay.sessions !== undefined) {
    const otherSessions = usage.sessionIds.filter((id) => id !== request.sessionId).length;
    if (otherSessions >= perDay.sessions) {
      const total = usage.sessionIds.length;
      return {
        exitCode: 2,
        stderr: [
          lead,
          `${repository} ran ${total} Claude Code session${total === 1 ? "" : "s"} of its ${perDay.sessions} per day (UTC ${usage.dayKey}); new sessions ${pause}. aibill guard`
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

/** 18720000 ms → 5h12m; 2700000 → 45m; under a minute → <1m. */
export function formatRemaining(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

export type GuardStatusInput = {
  repositoryRoot: string;
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
    const perDay = current.budget?.perDay;
    if (perDay && (perDay.tokens !== undefined || perDay.sessions !== undefined)) {
      lines.push(`  budget    per UTC day: ${[
        perDay.tokens !== undefined ? `${formatTokenCount(perDay.tokens)} tokens` : undefined,
        perDay.sessions !== undefined ? `${perDay.sessions} session${perDay.sessions === 1 ? "" : "s"}` : undefined
      ].filter(Boolean).join(" · ")}`);
    } else {
      lines.push("  budget    none");
    }
    if (current.message) lines.push(`  message   ${current.message}`);
    if (current.codex?.model) lines.push(`  codex     model ${current.codex.model} · reported only; Codex is not enforced`);
  }

  if (input.usage) {
    const usage = input.usage;
    if (usage.transcripts !== "readable") {
      lines.push(`today       ${usage.dayKey} UTC · transcript directory ${usage.transcripts}; usage unknown`);
    } else {
      const perDay = policy.status === "ok" ? policy.policy.budget?.perDay : undefined;
      const parts: string[] = [];
      const tokens = `${usage.incompleteCalls > 0 ? "at least " : ""}${formatTokenCount(usage.tokens)}`;
      parts.push(perDay?.tokens !== undefined
        ? `${tokens} of ${formatTokenCount(perDay.tokens)} tokens (${Math.floor(usage.tokens / perDay.tokens * 100)}%)`
        : `${tokens} tokens`);
      const sessions = usage.sessionIds.length;
      parts.push(perDay?.sessions !== undefined
        ? `${sessions} of ${perDay.sessions} sessions`
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
        install.hookEvents.length === 2
          ? "hooks: UserPromptSubmit, PreToolUse"
          : install.hookEvents.length === 1
            ? `hooks: ${install.hookEvents[0]} only`
            : "hooks: none"
      ].join(" · ");
  lines.push(`installed   .claude/settings.json: ${settingsState}`);
  lines.push(`            ${GUARD_LAUNCHER_RELATIVE_PATH}: ${install.launcher}`);
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

/** Everything `guard status` prints, computed read-only. */
export async function collectGuardStatus(options: {
  cwd: string;
  now?: Date;
  homeDirectory?: string;
  dependencies?: GuardCheckDependencies;
}): Promise<{ repositoryRoot: string; text: string } | { repositoryRoot: undefined; text: string }> {
  const now = options.now ?? new Date();
  const findRoot = options.dependencies?.resolveRepositoryRoot ?? resolveRepositoryRoot;
  const repositoryRoot = findRoot(resolve(options.cwd));
  if (!repositoryRoot) {
    return { repositoryRoot: undefined, text: "aibill guard: not inside a repository; run it from a checkout that holds .aibill/policy.json." };
  }
  const policy = await loadGuardPolicy(repositoryRoot);
  const homeDirectory = options.homeDirectory ?? homedir();
  let usage: GuardUsageResult | undefined;
  let usageError: string | undefined;
  if (policy.status === "ok" && aibillPolicyHasBudget(policy.policy)) {
    try {
      usage = await computeGuardUsage({ ...options.dependencies, homeDirectory, repositoryRoot, now });
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
    }
  }
  const install = await readGuardInstallState({
    repositoryRoot,
    policy: policy.status === "ok" ? policy.policy : undefined,
    homeDirectory
  });
  return { repositoryRoot, text: renderGuardStatus({ repositoryRoot, policy, usage, usageError, install, now }) };
}

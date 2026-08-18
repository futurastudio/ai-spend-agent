import { execFile as nodeExecFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  createAcceptedOutcomeV0,
  createProjectEconomicsReference,
  type AcceptedOutcomeV0
} from "@agent-finops/core";

const GH_FIELDS = [
  "number",
  "state",
  "mergedAt",
  "mergeCommit",
  "url",
  "headRefOid",
  "statusCheckRollup"
] as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 256 * 1_024;

export type GitHubAcceptedOutcomeRequest = {
  /** Absolute repository working tree used by `gh`; never persisted or returned. */
  projectRoot: string;
  /** When omitted, `gh pr view` uses its exact current-branch PR association. */
  pullRequestNumber?: number;
  /** Optional human-provided business meaning, explicitly labeled user-declared. */
  businessDescription?: string;
  timeoutMs?: number;
};

export type GitHubAcceptedOutcomeErrorCode =
  | "invalid_request"
  | "invalid_business_description"
  | "local_repository_unavailable"
  | "repository_mismatch"
  | "gh_unavailable"
  | "timeout"
  | "command_failed"
  | "response_too_large"
  | "malformed_response"
  | "pull_request_not_merged"
  | "merge_commit_missing"
  | "head_commit_missing"
  | "checks_missing"
  | "checks_pending"
  | "checks_failed";

export type GitHubAcceptedOutcomeResult =
  | {
      status: "ok";
      selection: "explicit_pr" | "current_branch";
      outcome: AcceptedOutcomeV0;
    }
  | {
      status: "error";
      code: GitHubAcceptedOutcomeErrorCode;
      message: string;
    };

export type GitHubExecFileError = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

export type GitHubExecFile = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
    windowsHide: true;
    env?: NodeJS.ProcessEnv;
  },
  callback: (
    error: GitHubExecFileError | null,
    stdout: string,
    stderr: string
  ) => void
) => void;

export type GitHubAcceptedOutcomeDependencies = {
  execFile?: GitHubExecFile;
};

/**
 * Explicit, opt-in GitHub evidence fetch. Nothing calls this adapter from the
 * default receipt or improve flow; the caller must deliberately invoke it.
 *
 * The adapter is deliberately conservative: it accepts only a merged PR with
 * exact head and merge commit OIDs and a non-empty rollup in which every
 * observed check reports SUCCESS. Native repository, commit, check, URL and
 * branch values are reduced to one-way project-economics references.
 */
export async function fetchGitHubAcceptedOutcomeV0(
  request: GitHubAcceptedOutcomeRequest,
  dependencies: GitHubAcceptedOutcomeDependencies = {}
): Promise<GitHubAcceptedOutcomeResult> {
  const validatedRequest = validateRequest(request);
  if (validatedRequest.status === "error") return validatedRequest;

  const executor = dependencies.execFile ?? defaultExecFile;
  const localRepository = await resolveLocalGitHubRepository(
    executor,
    validatedRequest.cwd,
    validatedRequest.timeoutMs
  );
  if (localRepository.status === "error") return localRepository;

  const selection = request.pullRequestNumber === undefined
    ? "current_branch" as const
    : "explicit_pr" as const;
  const args = request.pullRequestNumber === undefined
    ? [
        "pr",
        "view",
        "--repo",
        localRepository.selector,
        "--json",
        GH_FIELDS.join(",")
      ]
    : [
        "pr",
        "view",
        String(request.pullRequestNumber),
        "--repo",
        localRepository.selector,
        "--json",
        GH_FIELDS.join(",")
      ];
  const command = await runGh(executor, args, validatedRequest.cwd,
    validatedRequest.timeoutMs);
  if (command.status === "error") return command;

  let raw: unknown;
  try {
    raw = JSON.parse(command.stdout);
  } catch {
    return error("malformed_response", "GitHub returned malformed PR evidence.");
  }
  const parsed = parsePullRequest(
    raw,
    request.pullRequestNumber,
    localRepository.identity
  );
  if (parsed.status === "error") return parsed;

  let outcome: AcceptedOutcomeV0;
  try {
    const repositoryRef = createProjectEconomicsReference(
      "github.repository",
      parsed.repositoryIdentity
    );
    const workUnitRef = createProjectEconomicsReference(
      "github.pull_request",
      `${parsed.repositoryIdentity}\u0000${parsed.number}\u0000${parsed.headOid}`
    );
    const commitRef = createProjectEconomicsReference(
      "github.merge_commit",
      `${parsed.repositoryIdentity}\u0000${parsed.mergeOid}`
    );
    const evidenceRefs = [...new Set(parsed.checkIdentities.map((identity) =>
      createProjectEconomicsReference(
        "github.status_check",
        `${parsed.repositoryIdentity}\u0000${parsed.number}\u0000${identity}`
      )))];
    outcome = createAcceptedOutcomeV0({
      kind: "aibill.accepted_outcome",
      schemaVersion: "0.1.0",
      platform: "github",
      outcomeType: "pull_request",
      repositoryRef,
      workUnitRef,
      state: "merged",
      stateEvidence: "verified",
      acceptedAt: parsed.mergedAt,
      commit: { commitRef, evidence: "verified" },
      checks: {
        status: "passed",
        // `gh pr view` exposes the observed rollup. It does not prove which
        // checks branch protection required, so this evidence is observed.
        evidence: "observed",
        evidenceRefs
      },
      ...(request.businessDescription === undefined ? {} : {
        businessDescription: {
          value: request.businessDescription.trim(),
          evidence: "user_declared"
        }
      })
    });
  } catch {
    return error("malformed_response", "GitHub returned invalid PR evidence.");
  }
  return { status: "ok", selection, outcome };
}

type LocalGitHubRepository = {
  status: "ok";
  identity: string;
  selector: string;
};

async function resolveLocalGitHubRepository(
  executor: GitHubExecFile,
  cwd: string,
  timeout: number
): Promise<LocalGitHubRepository | Extract<
  GitHubAcceptedOutcomeResult,
  { status: "error" }
>> {
  const rootResult = await runGit(
    executor,
    ["rev-parse", "--show-toplevel"],
    cwd,
    timeout
  );
  if (rootResult.status === "error") return rootResult;
  const repositoryRoot = singleLineOutput(rootResult.stdout, 4_096);
  if (!repositoryRoot || !isAbsolute(repositoryRoot) ||
      resolve(repositoryRoot) !== cwd) {
    return error(
      "local_repository_unavailable",
      "The selected project root is not an exact local Git repository root."
    );
  }

  const remoteResult = await runGit(
    executor,
    ["remote", "get-url", "origin"],
    repositoryRoot,
    timeout
  );
  if (remoteResult.status === "error") return remoteResult;
  const remote = singleLineOutput(remoteResult.stdout, 4_096);
  const repository = remote ? normalizeGitHubRemote(remote) : null;
  if (!repository) {
    return error(
      "local_repository_unavailable",
      "The local Git origin is not an unambiguous GitHub repository."
    );
  }
  return { status: "ok", ...repository };
}

function validateRequest(
  request: GitHubAcceptedOutcomeRequest
): { status: "ok"; cwd: string; timeoutMs: number } | Extract<
  GitHubAcceptedOutcomeResult,
  { status: "error" }
> {
  if (typeof request.projectRoot !== "string" ||
      !isAbsolute(request.projectRoot) || request.projectRoot.includes("\0")) {
    return error("invalid_request", "A valid absolute project root is required.");
  }
  if (request.pullRequestNumber !== undefined &&
      (!Number.isSafeInteger(request.pullRequestNumber) ||
       request.pullRequestNumber < 1 || request.pullRequestNumber > 1_000_000_000)) {
    return error("invalid_request", "A valid pull-request number is required.");
  }
  if (request.businessDescription !== undefined) {
    const description = request.businessDescription.trim();
    if (description.length < 1 || description.length > 240 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(description) ||
        hasUnpairedSurrogate(description) || looksCredentialLike(description)) {
      return error(
        "invalid_business_description",
        "The business description must be bounded, control-free, and contain no credentials."
      );
    }
  }
  const requestedTimeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(requestedTimeout)) {
    return error("invalid_request", "A finite GitHub timeout is required.");
  }
  return {
    status: "ok",
    cwd: resolve(request.projectRoot),
    timeoutMs: Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS,
      Math.round(requestedTimeout)))
  };
}

function runGit(
  executor: GitHubExecFile,
  args: readonly string[],
  cwd: string,
  timeout: number
): Promise<
  { status: "ok"; stdout: string } |
  Extract<GitHubAcceptedOutcomeResult, { status: "error" }>
> {
  return new Promise((resolveResult) => {
    try {
      executor("git", args, {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true
      }, (commandError, stdout) => {
        if (commandError) {
          resolveResult(error(
            "local_repository_unavailable",
            "The local Git repository identity could not be resolved."
          ));
          return;
        }
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
          resolveResult(error(
            "local_repository_unavailable",
            "The local Git repository identity could not be resolved."
          ));
          return;
        }
        resolveResult({ status: "ok", stdout });
      });
    } catch {
      resolveResult(error(
        "local_repository_unavailable",
        "The local Git repository identity could not be resolved."
      ));
    }
  });
}

function runGh(
  executor: GitHubExecFile,
  args: readonly string[],
  cwd: string,
  timeout: number
): Promise<
  { status: "ok"; stdout: string } |
  Extract<GitHubAcceptedOutcomeResult, { status: "error" }>
> {
  return new Promise((resolveResult) => {
    try {
      executor("gh", args, {
        cwd,
        encoding: "utf8",
        timeout,
        maxBuffer: MAX_STDOUT_BYTES,
        windowsHide: true,
        // `GH_REPO` is a process-wide selector. Never let it redirect an
        // outcome fetch away from the repository derived from this local root.
        env: environmentWithoutGhRepo()
      }, (commandError, stdout) => {
        if (commandError) {
          if (commandError.code === "ENOENT") {
            resolveResult(error("gh_unavailable", "GitHub CLI is not available."));
            return;
          }
          if (commandError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            resolveResult(error("response_too_large", "GitHub PR evidence exceeded the safe limit."));
            return;
          }
          if (commandError.code === "ETIMEDOUT" || commandError.killed ||
              commandError.signal === "SIGTERM") {
            resolveResult(error("timeout", "GitHub PR evidence timed out."));
            return;
          }
          resolveResult(error("command_failed", "GitHub could not verify the pull request."));
          return;
        }
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
          resolveResult(error("response_too_large", "GitHub PR evidence exceeded the safe limit."));
          return;
        }
        resolveResult({ status: "ok", stdout });
      });
    } catch {
      resolveResult(error("command_failed", "GitHub could not verify the pull request."));
    }
  });
}

function environmentWithoutGhRepo(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GH_REPO;
  return environment;
}

function singleLineOutput(value: string, maxLength: number): string | null {
  if (Buffer.byteLength(value, "utf8") > maxLength) return null;
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  const line = normalized.endsWith("\r") ? normalized.slice(0, -1) : normalized;
  return line.length >= 1 && line.length <= maxLength &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(line) && !hasUnpairedSurrogate(line)
    ? line
    : null;
}

function normalizeGitHubRemote(value: string): {
  identity: string;
  selector: string;
} | null {
  const scpLike = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u
    .exec(value.replace(/\.git$/iu, ""));
  if (scpLike) {
    return normalizedRepositoryParts(scpLike[1], scpLike[2], scpLike[3]);
  }

  let remote: URL;
  try {
    remote = new URL(value);
  } catch {
    return null;
  }
  if (!new Set(["https:", "ssh:", "git:"]).has(remote.protocol) ||
      remote.password || remote.search || remote.hash || remote.port ||
      (remote.username && !(remote.protocol === "ssh:" && remote.username === "git")) ||
      !/^[A-Za-z0-9.-]+$/u.test(remote.hostname)) return null;
  const segments = remote.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const repository = segments[1]!.replace(/\.git$/iu, "");
  return normalizedRepositoryParts(remote.hostname, segments[0], repository);
}

function normalizedRepositoryParts(
  hostname: string | undefined,
  owner: string | undefined,
  repository: string | undefined
): { identity: string; selector: string } | null {
  if (!hostname || !owner || !repository ||
      !/^[A-Za-z0-9.-]+$/u.test(hostname) ||
      !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
      !/^[A-Za-z0-9_.-]+$/u.test(repository)) return null;
  const identity = `${hostname.toLowerCase()}/${owner.toLowerCase()}/${repository.toLowerCase()}`;
  return { identity, selector: identity };
}

function parsePullRequest(
  value: unknown,
  requestedNumber: number | undefined,
  expectedRepositoryIdentity: string
): {
  status: "ok";
  number: number;
  mergedAt: string;
  repositoryIdentity: string;
  headOid: string;
  mergeOid: string;
  checkIdentities: string[];
} | Extract<GitHubAcceptedOutcomeResult, { status: "error" }> {
  const object = asObject(value);
  if (!object || !Number.isSafeInteger(object.number) ||
      (object.number as number) < 1 ||
      (requestedNumber !== undefined && object.number !== requestedNumber)) {
    return error("malformed_response", "GitHub returned invalid PR evidence.");
  }
  const number = object.number as number;
  if (object.state !== "MERGED") {
    return error("pull_request_not_merged", "The pull request is not merged.");
  }
  const mergedAt = normalizeTimestamp(object.mergedAt);
  if (!mergedAt) {
    return error("malformed_response", "GitHub returned invalid merge-time evidence.");
  }
  const mergeCommit = asObject(object.mergeCommit);
  const mergeOid = normalizeOid(mergeCommit?.oid);
  if (!mergeOid) {
    return error("merge_commit_missing", "The merged pull request has no exact merge commit evidence.");
  }
  const headOid = normalizeOid(object.headRefOid);
  if (!headOid) {
    return error("head_commit_missing", "The merged pull request has no exact head commit evidence.");
  }
  const repositoryIdentity = normalizeRepositoryIdentity(object.url, number);
  if (!repositoryIdentity) {
    return error("malformed_response", "GitHub returned invalid repository evidence.");
  }
  if (repositoryIdentity !== expectedRepositoryIdentity) {
    return error(
      "repository_mismatch",
      "The pull request does not belong to the selected local Git repository."
    );
  }
  if (!Array.isArray(object.statusCheckRollup)) {
    return error("malformed_response", "GitHub returned invalid check evidence.");
  }
  if (object.statusCheckRollup.length === 0) {
    return error("checks_missing", "No GitHub status-check evidence was available.");
  }
  const checks = parseChecks(object.statusCheckRollup);
  if (checks.status === "malformed") {
    return error("malformed_response", "GitHub returned invalid check evidence.");
  }
  if (checks.status === "failed") {
    return error("checks_failed", "At least one GitHub status check failed.");
  }
  if (checks.status === "pending") {
    return error("checks_pending", "At least one GitHub status check is pending.");
  }
  return {
    status: "ok",
    number,
    mergedAt,
    repositoryIdentity,
    headOid,
    mergeOid,
    checkIdentities: checks.identities
  };
}

function parseChecks(value: unknown[]):
  | { status: "passed"; identities: string[] }
  | { status: "pending" }
  | { status: "failed" }
  | { status: "malformed" } {
  const identities: string[] = [];
  let pending = false;
  let failed = false;
  for (const item of value) {
    const check = asObject(item);
    if (!check) return { status: "malformed" };
    const name = boundedText(check.name ?? check.context, 512);
    if (!name) return { status: "malformed" };
    if ("conclusion" in check || "status" in check) {
      const status = boundedText(check.status, 32)?.toUpperCase();
      const conclusion = boundedText(check.conclusion, 32)?.toUpperCase();
      if (status !== "COMPLETED" || !conclusion) pending = true;
      else if (conclusion !== "SUCCESS") failed = true;
      identities.push(`check_run\u0000${name}\u0000${status ?? "missing"}\u0000${conclusion ?? "missing"}`);
      continue;
    }
    if ("state" in check) {
      const state = boundedText(check.state, 32)?.toUpperCase();
      if (!state) return { status: "malformed" };
      if (state === "PENDING" || state === "EXPECTED") pending = true;
      else if (state !== "SUCCESS") failed = true;
      identities.push(`status_context\u0000${name}\u0000${state}`);
      continue;
    }
    return { status: "malformed" };
  }
  if (failed) return { status: "failed" };
  if (pending) return { status: "pending" };
  return { status: "passed", identities };
}

function normalizeRepositoryIdentity(value: unknown, number: number): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[2] !== "pull" ||
      segments[3] !== String(number) ||
      !/^[A-Za-z0-9_.-]+$/.test(segments[0] ?? "") ||
      !/^[A-Za-z0-9_.-]+$/.test(segments[1] ?? "")) return null;
  return `${url.hostname.toLowerCase()}/${segments[0]!.toLowerCase()}/${segments[1]!
    .replace(/\.git$/i, "").toLowerCase()}`;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizeOid(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && !hasUnpairedSurrogate(value)
    ? value
    : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function looksCredentialLike(value: string): boolean {
  return /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|npm_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]+)/i
    .test(value);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function error(
  code: GitHubAcceptedOutcomeErrorCode,
  message: string
): Extract<GitHubAcceptedOutcomeResult, { status: "error" }> {
  return { status: "error", code, message };
}

const defaultExecFile: GitHubExecFile = (file, args, options, callback) => {
  nodeExecFile(file, [...args], options, (commandError, stdout, stderr) => {
    callback(commandError as GitHubExecFileError | null, stdout, stderr);
  });
};

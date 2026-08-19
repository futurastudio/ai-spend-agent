import { describe, expect, it, vi } from "vitest";
import {
  fetchGitHubAcceptedOutcomeV0,
  type GitHubExecFile,
  type GitHubExecFileError
} from "./githubAcceptedOutcome.js";

const ROOT = "/private/tmp/aibill-github-outcome";
const REPOSITORY_IDENTITY = "github.com/futurastudio/ai-spend-agent";
const ORIGIN = "git@github.com:futurastudio/ai-spend-agent.git\n";
const HEAD_OID = "a".repeat(40);
const MERGE_OID = "b".repeat(40);

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    state: "MERGED",
    mergedAt: "2026-08-16T16:00:00Z",
    mergeCommit: { oid: MERGE_OID },
    url: "https://github.com/futurastudio/ai-spend-agent/pull/42",
    headRefOid: HEAD_OID,
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { context: "policy", state: "SUCCESS" }
    ],
    ...overrides
  };
}

function mockExec(input: {
  stdout?: string;
  stderr?: string;
  error?: GitHubExecFileError;
  repositoryRoot?: string;
  origin?: string;
}): GitHubExecFile {
  return vi.fn((file, args, _options, callback) => {
    if (file === "git" && args[0] === "rev-parse") {
      callback(null, `${input.repositoryRoot ?? ROOT}\n`, "");
      return;
    }
    if (file === "git" && args[0] === "remote") {
      callback(null, input.origin ?? ORIGIN, "");
      return;
    }
    callback(input.error ?? null, input.stdout ?? "", input.stderr ?? "");
  });
}

describe("fetchGitHubAcceptedOutcomeV0", () => {
  it("creates privacy-reduced evidence for an explicit merged PR and observed checks", async () => {
    const execFile = mockExec({ stdout: JSON.stringify(pullRequest()) });
    const result = await fetchGitHubAcceptedOutcomeV0({
      projectRoot: ROOT,
      pullRequestNumber: 42,
      businessDescription: "Shipped the accepted launch fix"
    }, { execFile });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected accepted outcome");
    expect(result.selection).toBe("explicit_pr");
    expect(result.outcome).toMatchObject({
      kind: "aibill.accepted_outcome",
      platform: "github",
      outcomeType: "pull_request",
      state: "merged",
      stateEvidence: "verified",
      acceptedAt: "2026-08-16T16:00:00.000Z",
      commit: { evidence: "verified" },
      checks: { status: "passed", evidence: "observed" },
      businessDescription: {
        value: "Shipped the accepted launch fix",
        evidence: "user_declared"
      }
    });
    expect(result.outcome.checks.evidenceRefs).toHaveLength(2);
    expect(JSON.stringify(result.outcome)).not.toContain("futurastudio");
    expect(JSON.stringify(result.outcome)).not.toContain(MERGE_OID);
    expect(JSON.stringify(result.outcome)).not.toContain(HEAD_OID);

    expect(execFile).toHaveBeenCalledTimes(3);
    const [file, args, options] = vi.mocked(execFile).mock.calls[2]!;
    expect(file).toBe("gh");
    expect(args).toEqual([
      "pr", "view", "42", "--repo", REPOSITORY_IDENTITY, "--json",
      "number,state,mergedAt,mergeCommit,url,headRefOid,statusCheckRollup"
    ]);
    expect(options).toMatchObject({
      cwd: ROOT,
      timeout: 8_000,
      maxBuffer: 256 * 1_024,
      windowsHide: true
    });
    expect(options.env?.GH_REPO).toBeUndefined();
  });

  it("uses gh's exact current-branch association when the PR is omitted", async () => {
    const execFile = mockExec({ stdout: JSON.stringify(pullRequest()) });
    const result = await fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile });

    expect(result.status === "ok" && result.selection).toBe("current_branch");
    expect(vi.mocked(execFile).mock.calls[2]![1]).toEqual([
      "pr", "view", "--repo", REPOSITORY_IDENTITY, "--json",
      "number,state,mergedAt,mergeCommit,url,headRefOid,statusCheckRollup"
    ]);
  });

  it("ignores an adversarial GH_REPO and binds the query to the local origin", async () => {
    vi.stubEnv("GH_REPO", "attacker/redirected-repository");
    try {
      const execFile = mockExec({ stdout: JSON.stringify(pullRequest()) });
      const result = await fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile });

      expect(result.status).toBe("ok");
      const [file, args, options] = vi.mocked(execFile).mock.calls[2]!;
      expect(file).toBe("gh");
      expect(args).toContain(REPOSITORY_IDENTITY);
      expect(args).not.toContain("attacker/redirected-repository");
      expect(options.env?.GH_REPO).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a PR URL whose repository does not match the local origin", async () => {
    const execFile = mockExec({
      stdout: JSON.stringify(pullRequest({
        url: "https://github.com/attacker/redirected-repository/pull/42"
      }))
    });
    const result = await fetchGitHubAcceptedOutcomeV0({
      projectRoot: ROOT,
      pullRequestNumber: 42
    }, { execFile });

    expect(result).toEqual({
      status: "error",
      code: "repository_mismatch",
      message: "The pull request does not belong to the selected local Git repository."
    });
  });

  it("fails closed when the selected path is not the exact repository root", async () => {
    const execFile = mockExec({
      stdout: JSON.stringify(pullRequest()),
      repositoryRoot: `${ROOT}/parent`
    });
    const result = await fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile });

    expect(result).toMatchObject({
      status: "error",
      code: "local_repository_unavailable"
    });
    expect(vi.mocked(execFile).mock.calls.some(([file]) => file === "gh")).toBe(false);
  });

  it("rejects an open or otherwise unmerged pull request", async () => {
    const execFile = mockExec({
      stdout: JSON.stringify(pullRequest({ state: "OPEN", mergedAt: null }))
    });
    await expect(fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile }))
      .resolves.toMatchObject({ status: "error", code: "pull_request_not_merged" });
  });

  it("rejects pending checks without manufacturing passed quality evidence", async () => {
    const execFile = mockExec({
      stdout: JSON.stringify(pullRequest({
        statusCheckRollup: [
          { name: "test", status: "IN_PROGRESS", conclusion: null }
        ]
      }))
    });
    await expect(fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile }))
      .resolves.toMatchObject({ status: "error", code: "checks_pending" });
  });

  it("rejects failed checks", async () => {
    const execFile = mockExec({
      stdout: JSON.stringify(pullRequest({
        statusCheckRollup: [
          { name: "test", status: "COMPLETED", conclusion: "FAILURE" }
        ]
      }))
    });
    await expect(fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile }))
      .resolves.toMatchObject({ status: "error", code: "checks_failed" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong PR number", JSON.stringify(pullRequest({ number: 41 }))],
    ["missing merge commit", JSON.stringify(pullRequest({ mergeCommit: null }))],
    ["missing head commit", JSON.stringify(pullRequest({ headRefOid: null }))],
    ["malformed check", JSON.stringify(pullRequest({ statusCheckRollup: [{}] }))]
  ])("fails closed for %s", async (_label, stdout) => {
    const execFile = mockExec({ stdout });
    const result = await fetchGitHubAcceptedOutcomeV0({
      projectRoot: ROOT,
      pullRequestNumber: 42
    }, { execFile });
    expect(result.status).toBe("error");
  });

  it("returns a fixed timeout error without leaking child-process output", async () => {
    const secret = "ghp_EXAMPLESECRET123456";
    const timeout = Object.assign(new Error(`request failed ${secret}`), {
      code: "ETIMEDOUT",
      killed: true,
      signal: "SIGTERM" as const
    }) as GitHubExecFileError;
    const execFile = mockExec({ error: timeout, stderr: secret });
    const result = await fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile });

    expect(result).toMatchObject({ status: "error", code: "timeout" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(ROOT);
  });

  it("returns a fixed unavailable error when gh is not installed", async () => {
    const missing = Object.assign(new Error("spawn gh ENOENT"), {
      code: "ENOENT"
    }) as GitHubExecFileError;
    const execFile = mockExec({ error: missing });
    await expect(fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile }))
      .resolves.toEqual({
        status: "error",
        code: "gh_unavailable",
        message: "GitHub CLI is not available."
      });
  });

  it("rejects credential-like business descriptions before invoking gh", async () => {
    const execFile = mockExec({ stdout: JSON.stringify(pullRequest()) });
    const result = await fetchGitHubAcceptedOutcomeV0({
      projectRoot: ROOT,
      businessDescription: "Token ghp_EXAMPLESECRET123456"
    }, { execFile });

    expect(result).toMatchObject({
      status: "error",
      code: "invalid_business_description"
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("ghp_EXAMPLESECRET123456");
  });

  it("rejects a credential-bearing GitHub URL without retaining it", async () => {
    const secret = "ghp_EXAMPLESECRET123456";
    const execFile = mockExec({
      stdout: JSON.stringify(pullRequest({
        url: `https://oauth2:${secret}@github.com/futurastudio/ai-spend-agent/pull/42`
      }))
    });
    const result = await fetchGitHubAcceptedOutcomeV0({ projectRoot: ROOT }, { execFile });

    expect(result).toMatchObject({ status: "error", code: "malformed_response" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

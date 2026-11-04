import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalAgentCall } from "@agent-finops/core";
import {
  aggregateWorkspaceFacts, collapseRepositoryProjects, workspaceFactContentHash, workspaceFactKey
} from "./workspaceConnect.js";

const keyId = `oref_${"a".repeat(43)}`;
const evidence = {
  inputTokens: "observed", outputTokens: "observed", cacheReadTokens: "observed",
  cacheWriteTokens: "not_separately_reported", thoughtTokens: "not_separately_reported", toolTokens: "not_separately_reported",
  calculatedTotalTokens: "calculated_partial", reportedTotalTokens: "not_reported"
} as const;
const call = (overrides: Partial<LocalAgentCall>): LocalAgentCall => ({
  agent: "claude-code", model: "claude-opus-5-5", timestamp: "2026-11-05T10:00:00.000Z", sessionId: "s-1", callId: "c-1",
  usageScope: "turn", workingDirectory: "/repo/.worktrees/roi-verify", project: "roi-verify",
  usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3 }, tokenComponentEvidence: evidence, ...overrides
});
const resolveRoot = (directory: string) =>
  directory.startsWith("/repo") ? "/repo" : directory === join(homedir(), "notes") ? homedir() : undefined;

describe("collapseRepositoryProjects", () => {
  it("names unsent days after the checkout, so worktrees, sub-folders and the root are one project", () => {
    const calls = [
      call({}),
      call({ callId: "c-2", workingDirectory: "/repo/apps/web", project: "web" }),
      call({ callId: "c-3", workingDirectory: "/repo", project: "repo" })
    ];
    const collapsed = collapseRepositoryProjects(calls, {}, resolveRoot);
    expect(collapsed.map(item => item.project)).toEqual(["repo", "repo", "repo"]);
    // Only the project changes; each folder keeps its own directory identity.
    expect(collapsed.map(item => item.workingDirectory)).toEqual(calls.map(item => item.workingDirectory));
    const facts = aggregateWorkspaceFacts(collapsed, {}, keyId).facts;
    expect(facts).toHaveLength(3);
    expect(new Set(facts.map(fact => fact.projectName))).toEqual(new Set(["repo"]));
  });

  it("leaves a day alone once any of its facts was sent under folder names", () => {
    const sent = call({ timestamp: "2026-11-04T09:00:00.000Z" });
    const fact = aggregateWorkspaceFacts([sent], {}, keyId).facts[0]!;
    const previous = { [workspaceFactKey(fact)]: { revision: "1", contentHash: workspaceFactContentHash(fact) } };
    const sameDay = call({ callId: "c-9", timestamp: "2026-11-04T18:00:00.000Z", workingDirectory: "/repo/apps/web", project: "web" });
    const nextDay = call({ callId: "c-10", timestamp: "2026-11-05T09:00:00.000Z" });

    const collapsed = collapseRepositoryProjects([sent, sameDay, nextDay], previous, resolveRoot);

    expect(collapsed.map(item => item.project)).toEqual(["roi-verify", "web", "repo"]);
  });

  it("keeps the folder name without a checkout, in the home directory, and without a usable folder or time", () => {
    const { workingDirectory: _absent, ...noDirectory } = call({ callId: "c-3", project: "unknown" });
    const calls = [
      call({ workingDirectory: "/elsewhere/scratch", project: "scratch" }),
      call({ callId: "c-2", workingDirectory: join(homedir(), "notes"), project: "notes" }),
      noDirectory,
      call({ callId: "c-4", timestamp: "not a time", project: "odd" })
    ];
    expect(collapseRepositoryProjects(calls, {}, resolveRoot).map(item => item.project))
      .toEqual(["scratch", "notes", "unknown", "odd"]);
  });

  it("looks each folder up once", () => {
    const seen: string[] = [];
    const calls = [call({}), call({ callId: "c-2" }), call({ callId: "c-3", workingDirectory: "/repo/apps/web" })];
    collapseRepositoryProjects(calls, {}, directory => { seen.push(directory); return "/repo"; });
    expect(seen).toEqual(["/repo/.worktrees/roi-verify", "/repo/apps/web"]);
  });
});

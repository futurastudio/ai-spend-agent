import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalAgentCall } from "@agent-finops/core";
import {
  aggregateWorkspaceFacts, collapseRepositoryProjects, workspaceFactContentHash, workspaceFactKey, type WorkspaceFactNames, type WorkspaceFactState
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
const ledger = (calls: readonly LocalAgentCall[]): WorkspaceFactState => Object.fromEntries(aggregateWorkspaceFacts(calls, {}, keyId).facts
  .map(fact => [workspaceFactKey(fact), { revision: "1", contentHash: workspaceFactContentHash(fact) }]));
const resolveRoot = (directory: string) =>
  directory.startsWith("/repo") ? "/repo" : directory === join(homedir(), "notes") ? homedir() : undefined;

describe("collapseRepositoryProjects", () => {
  it("names unsent days after the checkout, so worktrees, sub-folders and the root are one project", () => {
    const calls = [
      call({}),
      call({ callId: "c-2", workingDirectory: "/repo/apps/web", project: "web" }),
      call({ callId: "c-3", workingDirectory: "/repo", project: "repo" })
    ];
    const collapsed = collapseRepositoryProjects(calls, {}, resolveRoot).calls;
    expect(collapsed.map(item => item.project)).toEqual(["repo", "repo", "repo"]);
    // Only the project changes; each folder keeps its own directory identity.
    expect(collapsed.map(item => item.workingDirectory)).toEqual(calls.map(item => item.workingDirectory));
    const facts = aggregateWorkspaceFacts(collapsed, {}, keyId).facts;
    expect(facts).toHaveLength(3);
    expect(new Set(facts.map(fact => fact.projectName))).toEqual(new Set(["repo"]));
  });

  it("a fact sent under its folder's name keeps it; a folder new to that day and a later day name the repository", () => {
    const sent = call({ timestamp: "2026-11-04T09:00:00.000Z" });
    const previous = ledger([sent]);
    const sameDay = call({ callId: "c-9", timestamp: "2026-11-04T18:00:00.000Z", workingDirectory: "/repo/apps/web", project: "web" });
    const nextDay = call({ callId: "c-10", timestamp: "2026-11-05T09:00:00.000Z" });

    const collapsed = collapseRepositoryProjects([sent, sameDay, nextDay], previous, resolveRoot).calls;

    expect(collapsed.map(item => item.project)).toEqual(["roi-verify", "repo", "repo"]);
  });

  it("a key the root folder shares under either name says nothing of a sub-folder sent under the repository's", () => {
    const root = call({ workingDirectory: "/repo", project: "repo" }), sub = call({ callId: "c-2", workingDirectory: "/repo/apps/web", project: "web" });
    const previous = ledger(collapseRepositoryProjects([root, sub], {}, resolveRoot).calls);
    expect(collapseRepositoryProjects([root, sub], previous, resolveRoot).calls.map(item => item.project)).toEqual(["repo", "repo"]);
  });

  it("keeps the folder name without a checkout, in the home directory, and without a usable folder or time", () => {
    const { workingDirectory: _absent, ...noDirectory } = call({ callId: "c-3", project: "unknown" });
    const calls = [
      call({ workingDirectory: "/elsewhere/scratch", project: "scratch" }),
      call({ callId: "c-2", workingDirectory: join(homedir(), "notes"), project: "notes" }),
      noDirectory,
      call({ callId: "c-4", timestamp: "not a time", project: "odd" })
    ];
    expect(collapseRepositoryProjects(calls, {}, resolveRoot).calls.map(item => item.project))
      .toEqual(["scratch", "notes", "unknown", "odd"]);
  });

  it("looks each folder up once", () => {
    const seen: string[] = [];
    const calls = [call({}), call({ callId: "c-2" }), call({ callId: "c-3", workingDirectory: "/repo/apps/web" })];
    collapseRepositoryProjects(calls, {}, directory => { seen.push(directory); return "/repo"; });
    expect(seen).toEqual(["/repo/.worktrees/roi-verify", "/repo/apps/web"]);
  });

  describe("a place the ledger already holds", () => {
    const gone = () => undefined;
    const web = call({ workingDirectory: "/x/gone-repo/apps/web", project: "web" });
    const sentAs = (name: string | null, of: LocalAgentCall = web): WorkspaceFactState => ledger([{ ...of, project: name ?? undefined }]);
    const refOf = (of: LocalAgentCall) => aggregateWorkspaceFacts([of], {}, keyId).facts[0]!.directoryRef;
    const nameOf = (previous: WorkspaceFactState, of: LocalAgentCall, root: (directory: string) => string | undefined = gone, kept: WorkspaceFactNames = {}, also: LocalAgentCall[] = []) =>
      collapseRepositoryProjects([of, ...also], previous, root, kept).calls[0]!.project;

    it("keeps its own name first, even with a repository to name", () => {
      expect(nameOf(sentAs("web"), web, () => "/x/repo")).toBe("web");
    });

    it("then a name this machine remembers for the folder, last used first", () => {
      const previous = { ...sentAs("first"), ...sentAs("second") };
      expect(nameOf(previous, web, gone, { [refOf(web)]: ["first", "second"] })).toBe("second");
      expect(nameOf(sentAs("first"), web, gone, { [refOf(web)]: ["first", "second"] })).toBe("first");
    });

    it("then its repository's", () => {
      expect(nameOf(sentAs("repo"), web, () => "/x/repo")).toBe("repo");
    });

    it("then a folder above it", () => {
      expect(nameOf(sentAs("gone-repo"), web)).toBe("gone-repo");
      expect(nameOf(sentAs("apps"), web, () => "/x/repo")).toBe("apps");
      expect(nameOf({ ...sentAs("apps"), ...sentAs("repo") }, web, () => "/x/repo")).toBe("repo");
      expect(nameOf({ ...sentAs("x"), ...sentAs("gone-repo") }, web)).toBe("gone-repo");
    });

    it("then a name another folder used on this machine, or remembers, or whose repository it names, whatever this folder's checkout says now", () => {
      const other = call({ callId: "c-2", workingDirectory: "/elsewhere/main", project: "main" });
      expect(nameOf(sentAs("main"), web, gone, {}, [other])).toBe("main");
      expect(nameOf(sentAs("main"), web, () => "/x/renamed", {}, [other])).toBe("main");
      expect(nameOf(sentAs("kept-elsewhere"), web, gone, { [`sha256_${"0".repeat(64)}`]: ["kept-elsewhere"] })).toBe("kept-elsewhere");
      const inRepo = call({ callId: "c-3", workingDirectory: "/repo/apps/web", project: "web" });
      expect(nameOf(sentAs("repo"), web, gone, {}, [inRepo])).toBe("web");
      expect(collapseRepositoryProjects([web, inRepo], sentAs("repo"), directory => directory.startsWith("/repo") ? "/repo" : undefined).calls[0]!.project).toBe("repo");
    });

    it("a name that went out as none is found too, and stays none", () => {
      const collapsed = collapseRepositoryProjects([web], sentAs(null), gone, { [refOf(web)]: [null] });
      expect(collapsed.calls[0]!.project).toBeUndefined();
      expect(aggregateWorkspaceFacts(collapsed.calls, {}, keyId).facts[0]!.projectName).toBeNull();
    });

    it("only an exact place counts: the same name on another day, model, agent or folder proves nothing", () => {
      for (const elsewhere of [{ timestamp: "2026-11-04T10:00:00.000Z" }, { model: "claude-sonnet-5-5" }, { workingDirectory: "/x/gone-repo/apps/api" }]) {
        const previous = ledger([{ ...web, ...elsewhere, project: "gone-repo" }]);
        expect(nameOf(previous, web)).toBe("web");
      }
    });

    it("each place answers for itself: a model or an agent new to a folder and day names the repository beside a fact sent under the folder's name", () => {
      const previous = sentAs("web");
      const newModel = call({ callId: "c-2", sessionId: "s-2", workingDirectory: web.workingDirectory, project: "web", model: "claude-sonnet-5-5" });
      const newAgent = call({ callId: "c-3", sessionId: "s-3", workingDirectory: web.workingDirectory, project: "web", agent: "codex", usageScope: "turn" });
      expect(collapseRepositoryProjects([web, newModel, newAgent], previous, () => "/x/repo").calls.map(item => item.project)).toEqual(["web", "repo", "repo"]);
    });

    it("two names in one place, both in the ledger, stay apart: their sessions were never one fact", () => {
      const other = call({ callId: "c-2", sessionId: "s-2", workingDirectory: web.workingDirectory, project: "other-name" });
      const previous = ledger([web, other]);
      const collapsed = collapseRepositoryProjects([web, other], previous, () => "/x/repo").calls;
      expect(collapsed.map(item => item.project)).toEqual(["web", "other-name"]);
    });

    it("says which names it proved: not one the folder's own name tells, and not one already kept", () => {
      const ref = refOf(web);
      expect(collapseRepositoryProjects([web], sentAs("web"), gone).names).toEqual({});
      expect(collapseRepositoryProjects([web], sentAs("gone-repo"), gone).names).toEqual({ [ref]: ["gone-repo"] });
      const kept = { [ref]: ["gone-repo"] };
      expect(collapseRepositoryProjects([web], sentAs("gone-repo"), gone, kept).names).toEqual(kept);
      expect(collapseRepositoryProjects([web], sentAs("found"), () => "/x/found", kept).names).toEqual({ [ref]: ["found", "gone-repo"] });
    });
  });

  describe("a place the ledger does not hold", () => {
    const worktree = call({ workingDirectory: "/elsewhere/feature-x", project: "feature-x" });
    const refOf = (of: LocalAgentCall) => aggregateWorkspaceFacts([of], {}, keyId).facts[0]!.directoryRef;

    it("names the repository over anything remembered: a new day reads the checkout as it is now", () => {
      expect(collapseRepositoryProjects([worktree], {}, () => "/x/repo", { [refOf(worktree)]: ["old"] }).calls[0]!.project).toBe("repo");
    });

    it("with no checkout to find, takes the name the folder last went out under, or else its own", () => {
      expect(collapseRepositoryProjects([worktree], {}, () => undefined, { [refOf(worktree)]: ["old", "main"] }).calls[0]!.project).toBe("main");
      const none = collapseRepositoryProjects([worktree], {}, () => undefined, { [refOf(worktree)]: ["main", null] }).calls[0]!;
      expect(none.project).toBeUndefined();
      expect(collapseRepositoryProjects([worktree], {}, () => undefined).calls[0]!.project).toBe("feature-x");
    });

    it("a repository in the home directory or at the root of the disk is no repository", () => {
      expect(collapseRepositoryProjects([worktree], {}, () => homedir()).calls[0]!.project).toBe("feature-x");
      expect(collapseRepositoryProjects([worktree], {}, () => "/").calls[0]!.project).toBe("feature-x");
    });

    it("an empty ledger asks nothing of it: a first push tries no names", () => {
      const seen: string[] = [];
      const calls = [worktree, call({ callId: "c-2", workingDirectory: "/x/y", project: "y" })];
      expect(collapseRepositoryProjects(calls, {}, directory => { seen.push(directory); return undefined; }).names).toEqual({});
      expect(seen).toEqual(["/elsewhere/feature-x", "/x/y"]);
    });
  });
});

describe("what a project name can be in a fact", () => {
  it("text that is not well formed goes as no name, as control characters do, and a pair of surrogates is an ordinary character", () => {
    const fact = (project: string) => aggregateWorkspaceFacts([call({ project })], {}, keyId).facts[0]!.projectName;
    expect(fact(`a${String.fromCharCode(0xd83d)}`)).toBeNull();
    expect(fact(`${String.fromCharCode(0xde00)}b`)).toBeNull();
    expect(fact("a\u0007b")).toBeNull();
    expect(fact("\u{1F600}proj")).toBe("\u{1F600}proj");
  });
});

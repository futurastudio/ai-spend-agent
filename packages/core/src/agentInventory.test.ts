import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MCP_SERVER_TOKEN_FLOOR,
  estimateTokensFromText,
  loadAgentInventory,
  parseFrontmatter,
  type InventoryItem
} from "./agentInventory.js";

let root: string;
let claudeHome: string;
let projectDir: string;
let configPath: string;

const SKILL_BODY = "x".repeat(5000); // long body that must NOT count toward tokens

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-inventory-"));
  claudeHome = join(root, ".claude");
  projectDir = join(root, "project");
  configPath = join(root, ".claude.json");

  // User skill (with body).
  await mkdir(join(claudeHome, "skills", "deep-research"), { recursive: true });
  await writeFile(
    join(claudeHome, "skills", "deep-research", "SKILL.md"),
    `---\nname: deep-research\ndescription: Fan-out web searches and synthesize a cited report.\n---\n\n# Deep Research\n\n${SKILL_BODY}\n`
  );

  // Plugin-nested user skill.
  await mkdir(join(claudeHome, "skills", "my-plugin", "verify"), { recursive: true });
  await writeFile(
    join(claudeHome, "skills", "my-plugin", "verify", "SKILL.md"),
    `---\nname: verify\ndescription: |\n  Verify a change does what it should by\n  running the app and observing behavior.\n---\n\nbody here ${SKILL_BODY}\n`
  );

  // Project skill.
  await mkdir(join(projectDir, ".claude", "skills", "local-skill"), { recursive: true });
  await writeFile(
    join(projectDir, ".claude", "skills", "local-skill", "SKILL.md"),
    `---\nname: local-skill\ndescription: A project-scoped skill.\n---\nbody\n`
  );

  // Subagent.
  await mkdir(join(claudeHome, "agents"), { recursive: true });
  await writeFile(
    join(claudeHome, "agents", "researcher.md"),
    `---\nname: researcher\ndescription: Researches things deeply.\n---\n\nYou are a researcher. ${SKILL_BODY}\n`
  );

  // Slash command (namespaced under a subdir).
  await mkdir(join(claudeHome, "commands", "git"), { recursive: true });
  await writeFile(
    join(claudeHome, "commands", "git", "commit.md"),
    `---\ndescription: Create a commit.\n---\nDo the commit. ${SKILL_BODY}\n`
  );

  // claude.json with both top-level and per-project mcpServers.
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        "global-server": { command: "npx", args: ["-y", "some-global-mcp"] }
      },
      projects: {
        [projectDir]: {
          mcpServers: {
            "context7": { type: "stdio", command: "npx", args: ["-y", "context7"] },
            "supabase": { command: "npx", args: ["-y", "@supabase/mcp-server-supabase"] }
          }
        },
        "/some/other/project": {
          mcpServers: {
            "framer": { command: "npx", args: ["-y", "framer-mcp"] }
          }
        }
      }
    })
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const byKind = (items: InventoryItem[], kind: InventoryItem["kind"]) =>
  items.filter((i) => i.kind === kind);

describe("estimateTokensFromText", () => {
  it("returns ceil(chars / 4)", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("a")).toBe(1);
    expect(estimateTokensFromText("abcd")).toBe(1);
    expect(estimateTokensFromText("abcde")).toBe(2);
    expect(estimateTokensFromText("x".repeat(40))).toBe(10);
  });
});

describe("parseFrontmatter", () => {
  it("reads quoted, plain, and block-scalar values", () => {
    expect(parseFrontmatter(`---\nname: foo\ndescription: bar\n---\n`)).toEqual({
      name: "foo",
      description: "bar"
    });
    expect(parseFrontmatter(`---\nname: "q"\n---\n`)).toEqual({ name: "q" });
    const block = parseFrontmatter(`---\nname: b\ndescription: |\n  line one\n  line two\n---\n`);
    expect(block.description).toBe("line one line two");
  });

  it("returns empty for content without frontmatter", () => {
    expect(parseFrontmatter("# just a heading\n")).toEqual({});
  });
});

describe("loadAgentInventory", () => {
  it("enumerates each kind from temp fixtures", async () => {
    const result = await loadAgentInventory({
      claudeHomeDir: claudeHome,
      claudeConfigPath: configPath,
      projectDir
    });

    expect(result.scanned.skills).toBe(3);
    expect(result.scanned.subagents).toBe(1);
    expect(result.scanned.commands).toBe(1);
    expect(result.scanned.mcpServers).toBe(3);

    const skills = byKind(result.items, "skill");
    const subagents = byKind(result.items, "subagent");
    const commands = byKind(result.items, "command");
    const servers = byKind(result.items, "mcp_server");

    expect(skills.map((s) => s.name).sort()).toEqual([
      "deep-research",
      "local-skill",
      "verify"
    ]);
    expect(subagents.map((s) => s.name)).toEqual(["researcher"]);
    expect(commands.map((c) => c.name)).toEqual(["git:commit"]);
    expect(servers.map((s) => s.name).sort()).toEqual([
      "context7",
      "global-server",
      "supabase"
    ]);
  });

  it("counts only frontmatter tokens for skills (body excluded)", async () => {
    const result = await loadAgentInventory({
      claudeHomeDir: claudeHome,
      claudeConfigPath: configPath,
      projectDir
    });
    const deep = byKind(result.items, "skill").find((s) => s.name === "deep-research")!;
    // Frontmatter is tiny; the 5000-char body would be ~1250 tokens if counted.
    expect(deep.alwaysLoadedTokens).toBeLessThan(50);
    expect(deep.alwaysLoadedTokens).toBeGreaterThan(0);
    expect(deep.weightConfidence).toBe("estimated");
  });

  it("scopes skills/servers as user vs project", async () => {
    const result = await loadAgentInventory({
      claudeHomeDir: claudeHome,
      claudeConfigPath: configPath,
      projectDir
    });
    const local = byKind(result.items, "skill").find((s) => s.name === "local-skill")!;
    expect(local.scope).toBe("project");
    const verify = byKind(result.items, "skill").find((s) => s.name === "verify")!;
    expect(verify.scope).toBe("user");
    expect(verify.group).toBe("my-plugin");

    const global = byKind(result.items, "mcp_server").find((s) => s.name === "global-server")!;
    expect(global.scope).toBe("user");
    const ctx = byKind(result.items, "mcp_server").find((s) => s.name === "context7")!;
    expect(ctx.scope).toBe("project");
  });

  it("collects MCP servers from EVERY project when includeAllProjectMcp is set", async () => {
    const scoped = await loadAgentInventory({ claudeHomeDir: claudeHome, claudeConfigPath: configPath, projectDir });
    // Project-scoped: global-server + this project's context7 + supabase = 3.
    expect(scoped.scanned.mcpServers).toBe(3);
    expect(byKind(scoped.items, "mcp_server").some((s) => s.name === "framer")).toBe(false);

    const global = await loadAgentInventory({
      claudeHomeDir: claudeHome,
      claudeConfigPath: configPath,
      projectDir,
      includeAllProjectMcp: true
    });
    // Global: + framer from the other project = 4.
    expect(global.scanned.mcpServers).toBe(4);
    expect(byKind(global.items, "mcp_server").some((s) => s.name === "framer")).toBe(true);
  });

  it("flags mcp servers as understated (no tool schemas in config)", async () => {
    const result = await loadAgentInventory({
      claudeHomeDir: claudeHome,
      claudeConfigPath: configPath,
      projectDir
    });
    for (const server of byKind(result.items, "mcp_server")) {
      expect(server.weightConfidence).toBe("estimated_understated");
      // Uses the conservative floor (not the bare id) so the cost chain isn't ~0.
      expect(server.alwaysLoadedTokens).toBe(MCP_SERVER_TOKEN_FLOOR);
    }
  });

  it("never includes built-in tools", async () => {
    const result = await loadAgentInventory({
      claudeHomeDir: claudeHome,
      claudeConfigPath: configPath,
      projectDir
    });
    const names = result.items.map((i) => i.name.toLowerCase());
    for (const builtin of ["read", "edit", "bash", "glob", "grep", "write"]) {
      expect(names).not.toContain(builtin);
    }
  });

  it("does not throw on missing dirs/config and returns empty", async () => {
    const missing = join(root, "does-not-exist");
    const result = await loadAgentInventory({
      claudeHomeDir: join(missing, ".claude"),
      claudeConfigPath: join(missing, ".claude.json"),
      projectDir: join(missing, "project")
    });
    expect(result.items).toEqual([]);
    expect(result.scanned).toEqual({
      skills: 0,
      subagents: 0,
      commands: 0,
      mcpServers: 0,
      mcpTools: 0
    });
  });
});

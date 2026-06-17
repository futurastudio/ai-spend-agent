import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

/**
 * Agent context inventory: enumerate the Claude Code "inventory" that gets
 * loaded into an agent's always-on context (skills, subagents, slash commands,
 * MCP servers + their tools) and estimate how many tokens each item adds.
 *
 * This feeds a later "dead-context cost" feature that prices loaded-but-never-
 * invoked tools. Every read here is read-only and missing dirs/files never throw.
 *
 * CRITICAL token-weight rules (these drive the honesty of the final $ number):
 *  - Skills use *progressive disclosure*: only the YAML frontmatter (`name` +
 *    `description`) is always loaded — the body loads only when invoked. So a
 *    skill's alwaysLoadedTokens reflects ONLY name + description, never the body.
 *  - MCP tools: the FULL tool definition (name + description + JSON input schema)
 *    is always loaded — the heavy weight. Config (~/.claude.json) almost never
 *    carries tool schemas, so MCP enumeration is usually limited to server names;
 *    those items are flagged "estimated_understated" because the real weight is
 *    larger than what we can see.
 *  - Subagents / slash commands: estimate from their description/frontmatter line
 *    only (what is surfaced in the always-loaded list), not the whole file body.
 *  - Built-in tools (Read/Edit/Bash/Glob/Grep/etc.) are EXCLUDED entirely: always
 *    loaded, not prunable, not "waste."
 */

export type InventoryKind = "skill" | "subagent" | "command" | "mcp_tool" | "mcp_server";

export type InventoryItem = {
  kind: InventoryKind;
  /**
   * Canonical matchable name. mcp tool: "mcp__<server>__<tool>"; mcp server:
   * the server id; skill/subagent/command: their declared name.
   */
  name: string;
  scope: "user" | "project";
  /** e.g. mcp server name for an mcp_tool, plugin name for a plugin skill. */
  group?: string;
  alwaysLoadedTokens: number;
  /** "estimated_understated" when an MCP tool schema is unavailable. */
  weightConfidence: "estimated" | "estimated_understated";
  path?: string;
};

export type AgentInventoryOptions = {
  /** Default: ~/.claude */
  claudeHomeDir?: string;
  /** Default: ~/.claude.json */
  claudeConfigPath?: string;
  /** Default: process.cwd(); scans <projectDir>/.claude/**. */
  projectDir?: string;
  /**
   * Include MCP servers from EVERY project in the config (not just projectDir).
   * Used for the global "across your whole setup" dead-context view so the
   * first run is populated from any directory. Default false (project-scoped).
   */
  includeAllProjectMcp?: boolean;
};

export type AgentInventoryResult = {
  items: InventoryItem[];
  scanned: {
    skills: number;
    subagents: number;
    commands: number;
    mcpServers: number;
    mcpTools: number;
  };
};

/** Token estimate: Math.ceil(chars / 4). Exported so the parent reuses it. */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Conservative floor for an MCP server's always-loaded token weight when its
 * tool schemas aren't readable from config. A single tool's
 * name+description+JSON-schema is commonly ~300–800 tokens and servers usually
 * expose several; 700 is a deliberately low estimate, always paired with
 * weightConfidence "estimated_understated" so we under-claim, never over-claim.
 */
export const MCP_SERVER_TOKEN_FLOOR = 700;

/** Scan this machine's (and the project's) agent inventory. Never throws. */
export async function loadAgentInventory(
  options: AgentInventoryOptions = {}
): Promise<AgentInventoryResult> {
  const home = homedir();
  const claudeHome = options.claudeHomeDir ?? join(home, ".claude");
  const configPath = options.claudeConfigPath ?? join(home, ".claude.json");
  const projectDir = options.projectDir ?? process.cwd();
  const projectClaude = join(projectDir, ".claude");

  const items: InventoryItem[] = [];
  const scanned = { skills: 0, subagents: 0, commands: 0, mcpServers: 0, mcpTools: 0 };

  // --- Skills (user + project) ---
  for (const { dir, scope } of [
    { dir: join(claudeHome, "skills"), scope: "user" as const },
    { dir: join(projectClaude, "skills"), scope: "project" as const }
  ]) {
    for (const file of await findFiles(dir, (name) => name === "SKILL.md")) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content) continue;
      scanned.skills += 1;
      const fm = parseFrontmatter(content);
      const name = fm.name ?? skillNameFromPath(file, dir);
      // Only frontmatter (name + description) is always loaded — progressive disclosure.
      const loadedText = [
        name ? `name: ${name}` : "",
        fm.description ? `description: ${fm.description}` : ""
      ]
        .filter(Boolean)
        .join("\n");
      items.push({
        kind: "skill",
        name,
        scope,
        group: pluginGroupFromPath(file, dir),
        alwaysLoadedTokens: estimateTokensFromText(loadedText),
        weightConfidence: "estimated",
        path: file
      });
    }
  }

  // --- Subagents (user + project) ---
  for (const { dir, scope } of [
    { dir: join(claudeHome, "agents"), scope: "user" as const },
    { dir: join(projectClaude, "agents"), scope: "project" as const }
  ]) {
    for (const file of await findFiles(dir, (name) => name.endsWith(".md"))) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content) continue;
      scanned.subagents += 1;
      const fm = parseFrontmatter(content);
      const name = fm.name ?? basename(file).replace(/\.md$/i, "");
      // Only the surfaced description line is always loaded, not the body.
      const loadedText = [
        `name: ${name}`,
        fm.description ? `description: ${fm.description}` : ""
      ]
        .filter(Boolean)
        .join("\n");
      items.push({
        kind: "subagent",
        name,
        scope,
        alwaysLoadedTokens: estimateTokensFromText(loadedText),
        weightConfidence: "estimated",
        path: file
      });
    }
  }

  // --- Slash commands (user + project) ---
  for (const { dir, scope } of [
    { dir: join(claudeHome, "commands"), scope: "user" as const },
    { dir: join(projectClaude, "commands"), scope: "project" as const }
  ]) {
    for (const file of await findFiles(dir, (name) => name.endsWith(".md"))) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (!content) continue;
      scanned.commands += 1;
      const fm = parseFrontmatter(content);
      const name = commandNameFromPath(file, dir);
      // Commands surface a name + (optional) description line in the always-loaded list.
      const loadedText = [
        `/${name}`,
        fm.description ?? firstNonFrontmatterLine(content) ?? ""
      ]
        .filter(Boolean)
        .join(" ");
      items.push({
        kind: "command",
        name,
        scope,
        alwaysLoadedTokens: estimateTokensFromText(loadedText),
        weightConfidence: "estimated",
        path: file
      });
    }
  }

  // --- MCP servers (from ~/.claude.json: top-level + per-project map) ---
  const config = await readJson(configPath);
  const serverScopes = collectMcpServers(config, projectDir, options.includeAllProjectMcp ?? false);
  for (const { id, scope } of serverScopes) {
    scanned.mcpServers += 1;
    // We almost never have tool schemas from config, so we can't measure the
    // real weight (full tool definitions). Use a conservative published-typical
    // FLOOR per server instead of the bare id — a single MCP tool's
    // name+description+JSON schema is commonly several hundred tokens, and
    // servers usually expose multiple tools. Flagged "estimated_understated":
    // the true weight is almost certainly higher, never lower.
    items.push({
      kind: "mcp_server",
      name: id,
      scope,
      group: id,
      alwaysLoadedTokens: MCP_SERVER_TOKEN_FLOOR,
      weightConfidence: "estimated_understated",
      path: configPath
    });
  }

  return { items, scanned };
}

// --------------------------------------------------------------------------
// MCP config extraction
// --------------------------------------------------------------------------

function collectMcpServers(
  config: unknown,
  projectDir: string,
  includeAllProjectMcp: boolean
): Array<{ id: string; scope: "user" | "project" }> {
  if (!isRecord(config)) return [];
  const out: Array<{ id: string; scope: "user" | "project" }> = [];
  const seen = new Set<string>();

  const add = (id: string, scope: "user" | "project") => {
    // Dedupe by id across all scopes so a server configured in several projects
    // is counted once in the global view.
    const key = includeAllProjectMcp ? id : `${scope}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, scope });
  };

  // Top-level mcpServers are user-scope (global).
  if (isRecord(config.mcpServers)) {
    for (const id of Object.keys(config.mcpServers)) add(id, "user");
  }

  // Per-project mcpServers live under projects[<absolute dir>].mcpServers.
  // Global view: collect every project's servers; otherwise just this project's.
  if (isRecord(config.projects)) {
    const entries = includeAllProjectMcp
      ? Object.values(config.projects)
      : [config.projects[projectDir]];
    for (const projectEntry of entries) {
      if (isRecord(projectEntry) && isRecord(projectEntry.mcpServers)) {
        for (const id of Object.keys(projectEntry.mcpServers)) add(id, "project");
      }
    }
  }

  return out;
}

// --------------------------------------------------------------------------
// Frontmatter parsing (lightweight, no YAML dependency)
// --------------------------------------------------------------------------

type Frontmatter = { name?: string; description?: string };

/**
 * Extract `name` and `description` from a leading `---` fenced YAML block.
 * Handles quoted values and folded/multi-line descriptions (continuation lines
 * are read until the next top-level `key:` or the closing fence).
 */
export function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};

  const fm: Frontmatter = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key !== "name" && key !== "description") continue;
    let value = match[2];
    // Block scalar (| or >): gather indented continuation lines.
    if (value.trim() === "|" || value.trim() === ">" || value.trim() === "") {
      const collected: string[] = [];
      for (let j = i + 1; j < end; j += 1) {
        if (/^([A-Za-z0-9_-]+):\s?/.test(lines[j]) && !/^\s/.test(lines[j])) break;
        collected.push(lines[j].trim());
        i = j;
      }
      value = collected.join(" ").trim();
    } else {
      // Plain/quoted scalar may wrap onto following indented (non-key) lines.
      for (let j = i + 1; j < end; j += 1) {
        if (/^([A-Za-z0-9_-]+):\s?/.test(lines[j]) && !/^\s/.test(lines[j])) break;
        if (lines[j].trim() === "") break;
        value += ` ${lines[j].trim()}`;
        i = j;
      }
    }
    fm[key] = unquote(value.trim());
  }
  return fm;
}

function firstNonFrontmatterLine(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        start = i + 1;
        break;
      }
    }
  }
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = lines[i].trim().replace(/^#+\s*/, "");
    if (trimmed) return trimmed;
  }
  return undefined;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// --------------------------------------------------------------------------
// Path / name helpers
// --------------------------------------------------------------------------

/** Skill name fallback: the directory that contains SKILL.md. */
function skillNameFromPath(file: string, root: string): string {
  const parent = basename(join(file, ".."));
  return parent && parent !== basename(root) ? parent : basename(file);
}

/** Plugin skills nest one level deeper (root/<plugin>/<skill>/SKILL.md). */
function pluginGroupFromPath(file: string, root: string): string | undefined {
  const rel = relativeSegments(file, root);
  // rel = [..., <plugin>, <skill>, "SKILL.md"] when nested under a plugin.
  if (rel.length >= 3) return rel[0];
  return undefined;
}

/** Slash command name: path under commands/ joined by ":" (namespacing). */
function commandNameFromPath(file: string, root: string): string {
  const rel = relativeSegments(file, root);
  const parts = rel.map((s) => s).filter(Boolean);
  const last = parts.pop() ?? basename(file);
  const name = last.replace(/\.md$/i, "");
  return parts.length > 0 ? `${parts.join(":")}:${name}` : name;
}

function relativeSegments(file: string, root: string): string[] {
  const normFile = file.replace(/\\/g, "/");
  const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const rest = normFile.startsWith(normRoot + "/")
    ? normFile.slice(normRoot.length + 1)
    : basename(file);
  return rest.split("/").filter(Boolean);
}

// --------------------------------------------------------------------------
// Filesystem + typed helpers (style mirrors localAgentLogs.ts)
// --------------------------------------------------------------------------

/** Recursively collect files under `root` whose basename matches `match`. */
async function findFiles(root: string, match: (name: string) => boolean): Promise<string[]> {
  const isDir = await stat(root).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) return [];
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && match(entry.name)) out.push(path);
    }
  }
  return out;
}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, "utf8").catch(() => "");
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

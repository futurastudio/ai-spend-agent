import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Agent context inventory: enumerate configured Claude Code and Codex skills,
 * subagents, slash commands, MCP servers, and installed lifecycle hooks.
 *
 * This feeds a later "dead-context cost" feature that prices loaded-but-never-
 * invoked tools. Every read here is read-only, hook commands are never run,
 * and missing dirs/files never throw.
 *
 * CRITICAL token-weight rules (these drive the honesty of the final $ number):
 *  - Skills use *progressive disclosure*: only the YAML frontmatter (`name` +
 *    `description`) is always loaded — the body loads only when invoked. So a
 *    skill's alwaysLoadedTokens reflects ONLY name + description, never the body.
 *  - MCP tools: the FULL tool definition (name + description + JSON input schema)
 *    is always loaded — the heavy weight. Local host config almost never carries
 *    tool schemas, so MCP enumeration is usually limited to server names;
 *    those items are flagged "estimated_understated" because the real weight is
 *    larger than what we can see.
 *  - Subagents / slash commands: estimate from their description/frontmatter line
 *    only (what is surfaced in the always-loaded list), not the whole file body.
 *  - Built-in tools (Read/Edit/Bash/Glob/Grep/etc.) are EXCLUDED entirely: always
 *    loaded, not prunable, not "waste."
 */

export type InventoryKind =
  | "skill"
  | "subagent"
  | "command"
  | "mcp_tool"
  | "mcp_server"
  | "hook";

export type InventoryActivation =
  | "discoverable"
  | "mcp_schema_loaded"
  | "hook_injected"
  | "lifecycle_hook";

export type InventoryHost = "claude-code" | "codex";

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
  /** How the host makes this item available to the model/runtime. */
  activation: InventoryActivation;
  /** Host that owns an installed lifecycle hook. */
  host?: InventoryHost;
  /** Lifecycle event for hook items, for example SessionStart. */
  event?: string;
  /** Whether local transcripts can prove this item was explicitly invoked. */
  invocationTracking: "observable" | "not_observable";
  alwaysLoadedTokens: number;
  /** "unmeasured" means config proves activation but not runtime payload size. */
  weightConfidence: "estimated" | "estimated_understated" | "unmeasured";
  path?: string;
  /** For project-scoped MCP servers: the project dirs that load this server. */
  ownerDirs?: string[];
};

export type AgentInventoryOptions = {
  /** Default: ~/.claude */
  claudeHomeDir?: string;
  /** Default: ~/.claude.json */
  claudeConfigPath?: string;
  /** Default: <claudeHomeDir>/settings.json */
  claudeSettingsPath?: string;
  /** Default: process.cwd(); scans <projectDir>/.claude/**. */
  projectDir?: string;
  /** Default: ~/.codex. Used to locate enabled Codex plugins. */
  codexHomeDir?: string;
  /**
   * Explicit installed plugin roots. Primarily useful for deterministic audits
   * and tests; default discovery reads Claude's installed_plugins.json and
   * Codex's enabled plugin list.
   */
  pluginRoots?: Array<{
    root: string;
    host: InventoryHost;
    scope?: "user" | "project";
  }>;
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
    hooks: number;
    hookManifests: number;
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
  const codexHome = options.codexHomeDir ?? join(home, ".codex");
  const configPath = options.claudeConfigPath ?? join(home, ".claude.json");
  const settingsPath = options.claudeSettingsPath ?? join(claudeHome, "settings.json");
  const projectDir = options.projectDir ?? process.cwd();
  const projectClaude = join(projectDir, ".claude");
  const projectClaudeRoots = resolve(projectClaude) === resolve(claudeHome)
    ? []
    : [{ dir: projectClaude, scope: "project" as const }];

  const items: InventoryItem[] = [];
  const pluginRoots = options.pluginRoots ?? await configuredPluginRoots(claudeHome, codexHome);
  const seenSkills = new Set<string>();
  const scanned = {
    skills: 0,
    subagents: 0,
    commands: 0,
    mcpServers: 0,
    mcpTools: 0,
    hooks: 0,
    hookManifests: 0
  };

  // --- Skills (user + project) ---
  for (const { dir, scope, host, invocationTracking } of [
    {
      dir: join(claudeHome, "skills"),
      scope: "user" as const,
      host: "claude-code" as const,
      invocationTracking: "observable" as const
    },
    {
      dir: join(codexHome, "skills"),
      scope: "user" as const,
      host: "codex" as const,
      invocationTracking: "not_observable" as const
    },
    ...projectClaudeRoots.map((entry) => ({
      dir: join(entry.dir, "skills"),
      scope: entry.scope,
      host: "claude-code" as const,
      invocationTracking: "observable" as const
    })),
    {
      dir: join(projectDir, ".agents", "skills"),
      scope: "project" as const,
      host: "codex" as const,
      invocationTracking: "not_observable" as const
    },
    {
      dir: join(projectDir, ".codex", "skills"),
      scope: "project" as const,
      host: "codex" as const,
      invocationTracking: "not_observable" as const
    }
  ]) {
    for (const file of await findFiles(dir, (name) => name === "SKILL.md")) {
      const skillKey = `${host}:${resolve(file)}`;
      if (seenSkills.has(skillKey)) continue;
      seenSkills.add(skillKey);
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
        activation: "discoverable",
        host,
        invocationTracking,
        alwaysLoadedTokens: estimateTokensFromText(loadedText),
        weightConfidence: "estimated",
        path: file
      });
    }
  }

  // --- Subagents (user + project) ---
  for (const { dir, scope } of [
    { dir: join(claudeHome, "agents"), scope: "user" as const },
    ...projectClaudeRoots.map((entry) => ({
      dir: join(entry.dir, "agents"),
      scope: entry.scope
    }))
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
        activation: "discoverable",
        host: "claude-code",
        invocationTracking: "observable",
        alwaysLoadedTokens: estimateTokensFromText(loadedText),
        weightConfidence: "estimated",
        path: file
      });
    }
  }

  // --- Slash commands (user + project) ---
  for (const { dir, scope } of [
    { dir: join(claudeHome, "commands"), scope: "user" as const },
    ...projectClaudeRoots.map((entry) => ({
      dir: join(entry.dir, "commands"),
      scope: entry.scope
    }))
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
        activation: "discoverable",
        host: "claude-code",
        invocationTracking: "observable",
        alwaysLoadedTokens: estimateTokensFromText(loadedText),
        weightConfidence: "estimated",
        path: file
      });
    }
  }

  // --- MCP servers (from ~/.claude.json: top-level + per-project map) ---
  const serverScopes = new Map<string, {
    id: string;
    scope: "user" | "project";
    ownerDirs: string[];
    path: string;
    host: InventoryHost;
  }>();
  for (const sourcePath of [...new Set([configPath, settingsPath])]) {
    const config = await readJson(sourcePath);
    for (const server of collectMcpServers(
      config,
      projectDir,
      options.includeAllProjectMcp ?? false
    )) {
      const key = `claude-code:${server.scope}:${server.id}`;
      const prior = serverScopes.get(key);
      if (prior) {
        for (const ownerDir of server.ownerDirs) {
          if (!prior.ownerDirs.includes(ownerDir)) prior.ownerDirs.push(ownerDir);
        }
      } else {
        serverScopes.set(key, { ...server, path: sourcePath, host: "claude-code" });
      }
    }
  }
  const codexConfigPath = join(codexHome, "config.toml");
  const codexConfigText = await readFile(codexConfigPath, "utf8").catch(() => "");
  for (const id of enabledCodexMcpServerNames(codexConfigText)) {
    const key = `codex:user:${id}`;
    if (!serverScopes.has(key)) {
      serverScopes.set(key, {
        id,
        scope: "user",
        ownerDirs: [],
        path: codexConfigPath,
        host: "codex"
      });
    }
  }
  for (const { id, scope, ownerDirs, path, host } of serverScopes.values()) {
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
      activation: "mcp_schema_loaded",
      host,
      invocationTracking: host === "claude-code" ? "observable" : "not_observable",
      alwaysLoadedTokens: MCP_SERVER_TOKEN_FLOOR,
      weightConfidence: "estimated_understated",
      path,
      ownerDirs
    });
  }

  // --- Installed lifecycle hooks (metadata only; commands are NEVER run) ---
  const seenHooks = new Set<string>();
  for (const pluginRoot of pluginRoots) {
    for (const manifestPath of await pluginManifestPaths(pluginRoot.root)) {
      const manifest = await readJson(manifestPath);
      if (!isRecord(manifest)) continue;
      const pluginName = stringValue(manifest.name) ?? basename(dirname(dirname(manifestPath)));
      const skillsPath = stringValue(manifest.skills)
        ? resolve(dirname(dirname(manifestPath)), stringValue(manifest.skills)!)
        : join(pluginRoot.root, "skills");
      if (isWithinRoot(skillsPath, pluginRoot.root)) {
        for (const file of await findFiles(skillsPath, (name) => name === "SKILL.md")) {
          const skillKey = `${pluginRoot.host}:${resolve(file)}`;
          if (seenSkills.has(skillKey)) continue;
          seenSkills.add(skillKey);
          const content = await readFile(file, "utf8").catch(() => "");
          if (!content) continue;
          const fm = parseFrontmatter(content);
          const name = fm.name ?? skillNameFromPath(file, skillsPath);
          const loadedText = [
            `name: ${name}`,
            fm.description ? `description: ${fm.description}` : ""
          ].filter(Boolean).join("\n");
          scanned.skills += 1;
          items.push({
            kind: "skill",
            name,
            scope: pluginRoot.scope ?? "user",
            group: pluginName,
            activation: "discoverable",
            host: pluginRoot.host,
            invocationTracking: pluginRoot.host === "claude-code"
              ? "observable"
              : "not_observable",
            alwaysLoadedTokens: estimateTokensFromText(loadedText),
            weightConfidence: "estimated",
            path: file
          });
        }
      }
      const configuredHookPath = stringValue(manifest.hooks);
      const hookPath = configuredHookPath
        ? resolve(dirname(dirname(manifestPath)), configuredHookPath)
        : join(dirname(dirname(manifestPath)), "hooks", "hooks.json");
      if (!isWithinRoot(hookPath, pluginRoot.root)) continue;
      const hookConfig = await readJson(hookPath);
      if (!isRecord(hookConfig) || !isRecord(hookConfig.hooks)) continue;
      scanned.hookManifests += 1;

      for (const [event, registrations] of Object.entries(hookConfig.hooks)) {
        if (!Array.isArray(registrations) || registrations.length === 0) continue;
        const activation: InventoryActivation = contextInjectingEvent(event)
          ? "hook_injected"
          : "lifecycle_hook";
        const key = `${pluginRoot.host}:${pluginName}:${event}:${hookPath}`;
        if (seenHooks.has(key)) continue;
        seenHooks.add(key);
        scanned.hooks += 1;
        items.push({
          kind: "hook",
          name: `${pluginName}:${event}`,
          scope: pluginRoot.scope ?? "user",
          group: pluginName,
          activation,
          host: pluginRoot.host,
          event,
          invocationTracking: "not_observable",
          // Hook config proves the event exists, not what its command emits at
          // runtime. Assigning tokens or dollars here would be fabricated.
          alwaysLoadedTokens: 0,
          weightConfidence: "unmeasured",
          path: hookPath
        });
      }
    }
  }

  return { items, scanned };
}

function enabledCodexMcpServerNames(configText: string): string[] {
  const servers = new Map<string, boolean>();
  let current: string | undefined;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/.exec(line);
    if (section) {
      current = section[1] ?? section[2];
      if (current) servers.set(current, true);
      continue;
    }
    if (/^\[/.test(line)) {
      current = undefined;
      continue;
    }
    if (current && /^enabled\s*=\s*false\s*(?:#.*)?$/.test(line)) {
      servers.set(current, false);
    }
  }
  return [...servers.entries()]
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .sort();
}

async function configuredPluginRoots(
  claudeHome: string,
  codexHome: string
): Promise<Array<{ root: string; host: InventoryHost; scope: "user" }>> {
  const roots: Array<{ root: string; host: InventoryHost; scope: "user" }> = [];

  // Claude records actual install paths. Marketplace checkouts alone are not
  // treated as active, avoiding a false positive for every available plugin.
  const installed = await readJson(join(claudeHome, "plugins", "installed_plugins.json"));
  for (const installPath of collectStringFields(installed, "installPath")) {
    roots.push({ root: installPath, host: "claude-code", scope: "user" });
  }

  // Codex records enabled plugin ids in config.toml. Match those ids to cached
  // manifests by declared plugin name; disabled/cache-only plugins stay out.
  const configText = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
  const enabledNames = enabledCodexPluginNames(configText);
  if (enabledNames.size > 0) {
    for (const manifestPath of await findFiles(
      join(codexHome, "plugins", "cache"),
      (name) => name === "plugin.json"
    )) {
      if (!/\/\.codex-plugin\/plugin\.json$/.test(manifestPath.replace(/\\/g, "/"))) continue;
      const manifest = await readJson(manifestPath);
      const name = isRecord(manifest) ? stringValue(manifest.name) : undefined;
      if (name && enabledNames.has(name)) {
        roots.push({
          root: dirname(dirname(manifestPath)),
          host: "codex",
          scope: "user"
        });
      }
    }
  }

  return dedupePluginRoots(roots);
}

function enabledCodexPluginNames(configText: string): Set<string> {
  const names = new Set<string>();
  let current: string | undefined;
  for (const line of configText.split(/\r?\n/)) {
    const section = /^\[plugins\."([^"]+)"\]\s*$/.exec(line.trim());
    if (section) {
      current = section[1]?.split("@")[0];
      continue;
    }
    if (/^\[/.test(line.trim())) {
      current = undefined;
      continue;
    }
    if (current && /^enabled\s*=\s*true\s*(?:#.*)?$/.test(line.trim())) {
      names.add(current);
    }
  }
  return names;
}

function collectStringFields(value: unknown, field: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringFields(entry, field));
  }
  if (!isRecord(value)) return [];
  const direct = stringValue(value[field]);
  return [
    ...(direct ? [direct] : []),
    ...Object.values(value).flatMap((entry) => collectStringFields(entry, field))
  ];
}

function dedupePluginRoots<T extends { root: string; host: InventoryHost }>(roots: T[]): T[] {
  const seen = new Set<string>();
  return roots.filter((entry) => {
    const key = `${entry.host}:${resolve(entry.root)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pluginManifestPaths(root: string): Promise<string[]> {
  const directCodex = join(root, ".codex-plugin", "plugin.json");
  const directClaude = join(root, ".claude-plugin", "plugin.json");
  const out: string[] = [];
  if (await stat(directCodex).then((value) => value.isFile()).catch(() => false)) {
    out.push(directCodex);
  }
  if (await stat(directClaude).then((value) => value.isFile()).catch(() => false)) {
    out.push(directClaude);
  }
  return out;
}

function contextInjectingEvent(event: string): boolean {
  return event === "SessionStart" ||
    event === "UserPromptSubmit" ||
    event === "SubagentStart";
}

function isWithinRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

// --------------------------------------------------------------------------
// MCP config extraction
// --------------------------------------------------------------------------

function collectMcpServers(
  config: unknown,
  projectDir: string,
  includeAllProjectMcp: boolean
): Array<{ id: string; scope: "user" | "project"; ownerDirs: string[] }> {
  if (!isRecord(config)) return [];
  const byKey = new Map<string, { id: string; scope: "user" | "project"; ownerDirs: string[] }>();

  const add = (id: string, scope: "user" | "project", ownerDir?: string) => {
    // Dedupe by id across all scopes so a server configured in several projects
    // is counted once in the global view — but keep EVERY owning project dir,
    // because that's where `claude mcp remove` has to run.
    const key = includeAllProjectMcp ? id : `${scope}:${id}`;
    const existing = byKey.get(key);
    if (existing) {
      if (ownerDir && !existing.ownerDirs.includes(ownerDir)) existing.ownerDirs.push(ownerDir);
      return;
    }
    byKey.set(key, { id, scope, ownerDirs: ownerDir ? [ownerDir] : [] });
  };

  // Top-level mcpServers are user-scope (global).
  if (isRecord(config.mcpServers)) {
    for (const id of Object.keys(config.mcpServers)) add(id, "user");
  }

  // Per-project mcpServers live under projects[<absolute dir>].mcpServers.
  // Global view: collect every project's servers; otherwise just this project's.
  if (isRecord(config.projects)) {
    const entries = includeAllProjectMcp
      ? Object.entries(config.projects)
      : ([[projectDir, config.projects[projectDir]]] as Array<[string, unknown]>);
    for (const [dir, projectEntry] of entries) {
      if (isRecord(projectEntry) && isRecord(projectEntry.mcpServers)) {
        for (const id of Object.keys(projectEntry.mcpServers)) add(id, "project", dir);
      }
    }
  }

  return [...byKey.values()];
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

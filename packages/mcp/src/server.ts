#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "@agent-finops/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getContextHealthTool,
  getUsageGlanceTool,
  getSpendReportTool,
  listSourcesTool,
  recommendCutsTool,
  scanAiSpendTool,
  syncLocalAgentSpendTool,
  syncProviderSpendTool
} from "./index.js";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version?: unknown };
const serverVersion = typeof packageMetadata.version === "string"
  ? packageMetadata.version
  : "unknown";
const absolutePath = z.string().refine(isAbsolute, "path must be absolute");
const envReference = z.string().regex(
  /^env:[A-Z_][A-Z0-9_]*$/,
  "Use an environment reference such as env:OPENAI_ADMIN_KEY; never pass a raw key."
);

function jsonContent(value: unknown) {
  const structuredContent = isRecord(value) ? value : { value };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent
  };
}

function errorContent(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactSecrets(rawMessage)
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED]");
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const
  };
}

async function executeTool(operation: () => Promise<unknown>) {
  try {
    return jsonContent(await operation());
  } catch (error) {
    return errorContent(error);
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "aibill",
    version: serverVersion
  });

  server.registerTool(
    "scan_ai_spend",
    {
      title: "Scan AI spend",
      description:
        "Discover AI-provider files and configuration signals in an approved local folder. This writes only local aibill state; it does not parse detected exports into verified spend or call provider APIs. Pass sample=true only for an explicitly labeled demo report.",
      inputSchema: {
        path: absolutePath.describe("Absolute path to the local folder to scan."),
        sample: z
          .boolean()
          .optional()
          .describe("When true, load bundled sample usage data into a spend report.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path, sample }) => executeTool(() => scanAiSpendTool({ path, sample }))
  );

  server.registerTool(
    "sync_local_agent_spend",
    {
      title: "Sync local Claude Code and Codex spend",
      description:
        "Read local Claude Code and Codex transcript metadata, estimate API-equivalent cost, and persist a local spend report. Transcript contents are not uploaded. Optionally filter the aggregate records to one project name.",
      inputSchema: {
        path: absolutePath.describe("Absolute project folder where .ai-spend-agent state may be written."),
        sinceDays: z.number().int().min(1).max(365).optional().describe("Lookback window in days; defaults to 30."),
        project: z.string().min(1).optional().describe("Optional exact project name filter, such as agent-finops.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path, sinceDays, project }) =>
      executeTool(() => syncLocalAgentSpendTool({ path, sinceDays, project }))
  );

  server.registerTool(
    "sync_provider_spend",
    {
      title: "Sync verified provider spend",
      description:
        "Read billing and usage from a supported provider API and persist a combined local report. Supports OpenAI, Anthropic, GitHub Copilot, and Cursor. Requires a reference to an inherited environment variable; raw keys are rejected and never persisted.",
      inputSchema: {
        path: absolutePath.describe("Absolute project folder where .ai-spend-agent state may be written."),
        provider: z.enum(["openai", "anthropic", "github-copilot", "cursor"]),
        authReference: envReference.describe("Environment reference, for example env:OPENAI_ADMIN_KEY."),
        startTime: z.number().int().nonnegative().describe("Start of the billing window as Unix seconds."),
        endTime: z.number().int().nonnegative().optional().describe("Optional end of the billing window as Unix seconds."),
        org: z.string().min(1).optional().describe("GitHub organization when syncing Copilot."),
        enterprise: z.string().min(1).optional().describe("GitHub enterprise when syncing Copilot."),
        accountId: z.string().min(1).optional().describe("Optional provider account or team identifier.")
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ path, provider, authReference, startTime, endTime, org, enterprise, accountId }) =>
      executeTool(() => syncProviderSpendTool({
        path,
        provider,
        authReference,
        startTime,
        endTime,
        org,
        enterprise,
        accountId
      }))
  );

  server.registerTool(
    "get_usage_glance",
    {
      title: "Get coding-agent usage Glance",
      description:
        "Build a read-only Glance snapshot from local Claude Code and Codex transcript metadata: current or latest session value, exact transcript-reported plan windows when available, a privacy-conscious summary of the main recent work focus, and at most one evidence-backed anomaly. Cursor and GitHub Copilot require provider connections; missing plan limits are never inferred.",
      inputSchema: {
        sinceDays: z.number().int().min(1).max(365).optional().describe("History used for baselines; defaults to 30 days."),
        project: z.string().min(1).optional().describe("Optional exact project filter for session, focus, and anomaly metrics. Account-level limit metadata remains visible."),
        path: absolutePath.optional().describe("Optional project root for project-scoped Context Health inventory.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ sinceDays, project, path }) =>
      executeTool(() => getUsageGlanceTool({ sinceDays, project, path }))
  );

  server.registerTool(
    "get_context_health",
    {
      title: "Get hook-aware Context Health",
      description:
        "Return the canonical read-only Context Health result shared by aibill CLI, MCP, and Glance. Distinguishes discoverable, explicitly invoked, MCP schema-loaded, hook-injected, and other lifecycle context. Hook commands are never run and runtime payload tokens are never inferred.",
      inputSchema: {
        path: absolutePath.describe("Absolute project root for project-scoped inventory."),
        sinceDays: z.number().int().min(1).max(365).optional().describe("Local transcript history window; defaults to 30 days."),
        project: z.string().min(1).optional().describe("Optional exact project filter for session metrics.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path, sinceDays, project }) =>
      executeTool(() => getContextHealthTool({ path, sinceDays, project }))
  );

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "List approved sources recorded by a previous discovery, local-log sync, or provider sync.",
      inputSchema: {
        path: absolutePath.describe("Absolute path with existing .ai-spend-agent state.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path }) => executeTool(() => listSourcesTool({ path }))
  );

  server.registerTool(
    "get_spend_report",
    {
      title: "Get spend report",
      description:
        "Return records, data mode, and analyzed summary from a prior local-log sync, provider sync, or explicit sample scan.",
      inputSchema: {
        path: absolutePath.describe("Absolute path with existing .ai-spend-agent spend state.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path }) => executeTool(() => getSpendReportTool({ path }))
  );

  server.registerTool(
    "recommend_cuts",
    {
      title: "Recommend cuts",
      description:
        "Return recommendations from the analyzed spend report when available, falling back to discovery-signal guidance.",
      inputSchema: {
        path: absolutePath.describe("Absolute path with existing .ai-spend-agent state.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path }) => executeTool(() => recommendCutsTool({ path }))
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInvokedAsMain(
  entrypoint: string | undefined,
  modulePath = fileURLToPath(import.meta.url)
): boolean {
  if (!entrypoint) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

const invokedAsMain = isInvokedAsMain(process.argv[1]);

if (invokedAsMain) {
  main().catch((error) => {
    console.error("aibill MCP server failed to start:", error);
    process.exit(1);
  });
}

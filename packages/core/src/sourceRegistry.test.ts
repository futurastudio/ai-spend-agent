import { describe, expect, it } from "vitest";
import {
  addApprovedSource,
  buildMissingSourcePrompts,
  confirmMapping,
  createLocalFolderSourceRegistry,
  createProviderConnectorStub,
  providerCatalog,
  providerConnectorCatalog
} from "./sourceRegistry.js";

describe("provider source normalization", () => {
  it("models the five ingestion lanes with verification metadata", () => {
    const registry = createLocalFolderSourceRegistry("/tmp/ai-spend");
    const sourceTypes = new Set(registry.supportedSourceTypes);

    expect(sourceTypes).toEqual(new Set([
      "local_folder",
      "provider_export",
      "provider_api",
      "browser_account",
      "local_tool_detection",
      "mcp_tool",
      "internal_system"
    ]));
    expect(registry.ingestionLanes.map((lane) => lane.id)).toEqual([
      "local_files_exports",
      "provider_apis",
      "browser_account_ui",
      "local_cli_tool_detection",
      "mcp_internal_systems"
    ]);
    expect(registry.approvedSources[0]).toMatchObject({
      type: "local_folder",
      accessMethod: "file",
      verification: "verified",
      lane: "local_files_exports"
    });
  });

  it("creates provider connector stubs without storing secret values", () => {
    const stub = createProviderConnectorStub("anthropic", "provider_api");

    expect(stub).toMatchObject({
      provider: "anthropic",
      type: "provider_api",
      accessMethod: "api",
      authMode: "oauth",
      authScopes: expect.arrayContaining(["organization:usage:read", "organization:costs:read"]),
      verification: "missing",
      readOnly: true
    });
    expect(stub.fieldsVerified).toContain("organization cost report");
    expect(stub.fieldsMissing).toContain("admin API token reference");
    expect(JSON.stringify(stub)).not.toContain("sk-ant");
    expect(JSON.stringify(stub)).not.toContain("password");
  });

  it("turns local detections without account sources into missing-source prompts", () => {
    const registry = createLocalFolderSourceRegistry("/tmp/ai-spend");
    const prompts = buildMissingSourcePrompts([
      { provider: "anthropic", kind: "dependency", filePath: "package.json", evidence: "@anthropic-ai/sdk", confidence: 0.9 },
      { provider: "openai", kind: "provider_export", filePath: "openai-usage.csv", evidence: "detected openai export", confidence: 0.88 },
      { provider: "github-copilot", kind: "config", filePath: ".github/copilot.yml", evidence: "copilot", confidence: 0.8 }
    ], registry);

    expect(prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", status: "detected_unverified", suggestedConnector: "connect anthropic --type provider_api" }),
      expect.objectContaining({ provider: "github-copilot", status: "detected_unverified", suggestedConnector: "connect github-copilot --type provider_api" })
    ]));
    expect(prompts.some((prompt) => prompt.provider === "openai")).toBe(false);
  });

  it("suppresses missing prompts when a verified provider source exists", () => {
    const registry = addApprovedSource(createLocalFolderSourceRegistry("/tmp/ai-spend"), {
      id: "anthropic-admin-api",
      type: "provider_api",
      label: "Anthropic Admin API",
      provider: "anthropic",
      accessMethod: "api",
      lane: "provider_apis",
      verification: "verified",
      fieldsVerified: ["organization cost report"],
      fieldsEstimated: [],
      fieldsMissing: []
    });

    const prompts = buildMissingSourcePrompts([
      { provider: "anthropic", kind: "dependency", filePath: "package.json", evidence: "@anthropic-ai/sdk", confidence: 0.9 }
    ], registry);

    expect(prompts).toHaveLength(0);
  });

  it("persists confirmed mappings with evidence and confidence", () => {
    const mapping = confirmMapping({
      provider: "anthropic",
      sourceId: "anthropic-admin-api",
      team: "Sales",
      workflow: "proposal drafting",
      project: "enterprise-sales",
      evidence: ["Claude account UI report", "sales workspace users"],
      confidence: 0.82
    });

    expect(mapping).toMatchObject({
      provider: "anthropic",
      team: "Sales",
      workflow: "proposal drafting",
      project: "enterprise-sales",
      status: "confirmed",
      confidence: 0.82
    });
    expect(mapping.confirmedAt).toMatch(/T/);
  });

  it("keeps a provider connector catalog with OAuth-first auth modes and safe fallbacks", () => {
    const openai = providerConnectorCatalog.find((connector) => connector.provider === "openai");
    const cursor = providerConnectorCatalog.find((connector) => connector.provider === "cursor");

    expect(openai).toMatchObject({
      provider: "openai",
      preferredAuthMode: "oauth",
      fallbackAuthModes: ["api_token_ref", "browser_session"],
      tokenStorage: "local_reference_only"
    });
    expect(openai?.scopes).toContain("organization:usage:read");
    expect(cursor).toMatchObject({
      provider: "cursor",
      preferredAuthMode: "api_token_ref",
      fallbackAuthModes: ["browser_session", "manual_export"],
      tokenStorage: "local_reference_only"
    });
    expect(cursor?.scopes).toContain("admin:*");
  });

  it("keeps a provider catalog for major enterprise AI tools", () => {
    expect(providerCatalog.map((provider) => provider.id)).toEqual(expect.arrayContaining([
      "openai",
      "anthropic",
      "github-copilot",
      "codex",
      "cursor",
      "gemini",
      "langfuse",
      "helicone",
      "litellm"
    ]));
  });
});

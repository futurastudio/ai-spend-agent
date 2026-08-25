import { describe, expect, it } from "vitest";
import {
  addApprovedSource,
  buildMissingSourcePrompts,
  confirmMapping,
  createLocalFolderSourceRegistry,
  createProviderConnectorStub,
  downgradeUntrustedSourceRegistryClaims,
  normalizeSourceRegistry,
  providerCatalog,
  providerConnectorCatalog
} from "./sourceRegistry.js";

describe("provider source normalization", () => {
  it("models the five ingestion lanes with separate source-truth axes", () => {
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
    expect(registry.ingestionLanes.find((lane) => lane.id === "browser_account_ui")).toMatchObject({
      label: expect.stringContaining("schema scaffold"),
      defaultFinancialEvidence: "missing"
    });
    expect(registry.approvedSources[0]).toMatchObject({
      type: "local_folder",
      accessMethod: "file",
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing",
      lane: "local_files_exports"
    });
    expect(registry.approvedSources[0]).not.toHaveProperty("verification");
  });

  it("creates provider connector stubs without storing secret values", () => {
    const stub = createProviderConnectorStub("anthropic", "provider_api");

    expect(stub).toMatchObject({
      provider: "anthropic",
      type: "provider_api",
      accessMethod: "api",
      authMode: "api_token_ref",
      authScopes: expect.arrayContaining(["Claude Console Admin cost report read", "Claude Code analytics read"]),
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing",
      readOnly: true
    });
    expect(stub.fieldsVerified).toContain("organization cost report");
    expect(stub.fieldsMissing).toContain("Anthropic Admin API key reference");
    expect(JSON.stringify(stub)).not.toContain("sk-ant");
    expect(JSON.stringify(stub)).not.toContain("password");
    expect(JSON.stringify(stub)).not.toContain('"verification"');
  });

  it("turns local detections without account sources into missing-source prompts", () => {
    const registry = createLocalFolderSourceRegistry("/tmp/ai-spend");
    const prompts = buildMissingSourcePrompts([
      { provider: "anthropic", kind: "dependency", filePath: "package.json", evidence: "@anthropic-ai/sdk", confidence: 0.9 },
      { provider: "openai", kind: "provider_export", filePath: "openai-usage.csv", evidence: "detected openai export", confidence: 0.88 },
      { provider: "github-copilot", kind: "config", filePath: ".github/copilot.yml", evidence: "copilot", confidence: 0.8 }
    ], registry);

    expect(prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "anthropic",
        status: "detected_unverified",
        suggestedConnector: "connect anthropic --type provider_api",
        suggestedSourceTypes: ["provider_api"]
      }),
      expect.objectContaining({
        provider: "github-copilot",
        status: "detected_unverified",
        suggestedConnector: "connect github-copilot --type provider_api",
        suggestedSourceTypes: ["provider_api"]
      })
    ]));
    expect(prompts[0]?.reason).toContain("current financial evidence");
    expect(prompts.map((prompt) => `${prompt.reason} ${prompt.suggestedSourceTypes.join(" ")}`).join(" ")).not.toContain("browser");
    expect(prompts.map((prompt) => prompt.reason).join(" ")).not.toContain("verified provider");
    expect(prompts.some((prompt) => prompt.provider === "openai")).toBe(false);
  });

  it("suppresses missing prompts when an approved source has current financial evidence", () => {
    const registry = addApprovedSource(createLocalFolderSourceRegistry("/tmp/ai-spend"), {
      id: "anthropic-admin-api",
      type: "provider_api",
      label: "Anthropic Admin API",
      provider: "anthropic",
      accessMethod: "api",
      lane: "provider_apis",
      boundaryApproval: "approved",
      validationCoverage: "live_verified",
      financialEvidence: "verified",
      fieldsVerified: ["organization cost report"],
      fieldsEstimated: [],
      fieldsMissing: []
    });

    const prompts = buildMissingSourcePrompts([
      { provider: "anthropic", kind: "dependency", filePath: "package.json", evidence: "@anthropic-ai/sdk", confidence: 0.9 }
    ], registry);

    expect(prompts).toHaveLength(0);
  });

  it("does not let a browser-account schema scaffold satisfy provider evidence", () => {
    const registry = addApprovedSource(createLocalFolderSourceRegistry("/tmp/ai-spend"), {
      id: "anthropic-browser-scaffold",
      type: "browser_account",
      label: "Anthropic browser scaffold",
      provider: "anthropic",
      boundaryApproval: "approved",
      validationCoverage: "live_verified",
      financialEvidence: "verified",
      fieldsVerified: ["forged browser total"],
      fieldsEstimated: [],
      fieldsMissing: []
    });

    const prompts = buildMissingSourcePrompts([
      { provider: "anthropic", kind: "dependency", filePath: "package.json", evidence: "@anthropic-ai/sdk", confidence: 0.9 }
    ], registry);

    const scaffold = registry.approvedSources.find((source) => source.id === "anthropic-browser-scaffold");
    expect(scaffold).toMatchObject({
      validationCoverage: "untested",
      financialEvidence: "missing",
      fieldsVerified: [],
      fieldsEstimated: []
    });
    expect(scaffold?.scope).toContain("not implemented");
    expect(scaffold?.fieldsMissing).toContain("browser-account ingestion is a schema scaffold and is not implemented");

    const forged = JSON.parse(JSON.stringify(registry)) as {
      approvedSources: Array<Record<string, unknown>>;
    };
    const forgedBrowser = forged.approvedSources.find((source) => source.id === "anthropic-browser-scaffold")!;
    forgedBrowser.validationCoverage = "live_verified";
    forgedBrowser.financialEvidence = "verified";
    forgedBrowser.fieldsVerified = ["forged browser total"];
    forgedBrowser.scope = "fully implemented browser billing";
    const normalizedBrowser = normalizeSourceRegistry(forged).approvedSources.find(
      (source) => source.id === "anthropic-browser-scaffold"
    );
    expect(normalizedBrowser).toMatchObject({
      validationCoverage: "untested",
      financialEvidence: "missing",
      fieldsVerified: []
    });
    expect(normalizedBrowser?.scope).toContain("not implemented");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      provider: "anthropic",
      suggestedSourceTypes: ["provider_api"]
    });
  });

  it("labels manually requested browser-account connectors as unavailable schema scaffolds", () => {
    const scaffold = createProviderConnectorStub("anthropic", "browser_account");

    expect(scaffold.financialEvidence).toBe("missing");
    expect(scaffold.validationCoverage).toBe("untested");
    expect(scaffold.fieldsVerified).toEqual([]);
    expect(scaffold.scope).toContain("not implemented");
    expect(scaffold.fieldsMissing).toContain("browser-account ingestion is a schema scaffold and is not implemented");
  });

  it("migrates legacy verification as financial evidence without treating folder approval as financial proof", () => {
    const canonical = createLocalFolderSourceRegistry("/tmp/ai-spend", new Date("2026-08-08T12:00:00.000Z"));
    const legacy = JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
    const lanes = legacy.ingestionLanes as Array<Record<string, unknown>>;
    for (const lane of lanes) {
      lane.defaultVerification = lane.defaultFinancialEvidence;
      delete lane.defaultFinancialEvidence;
    }
    const local = (legacy.approvedSources as Array<Record<string, unknown>>)[0]!;
    delete local.boundaryApproval;
    delete local.validationCoverage;
    delete local.financialEvidence;
    local.verification = "verified";
    (legacy.approvedSources as Array<Record<string, unknown>>).push({
      ...local,
      id: "anthropic-provider-api",
      type: "provider_api",
      label: "Anthropic Admin API",
      provider: "anthropic",
      lane: "provider_apis",
      accessMethod: "api",
      verification: "estimated"
    });

    const migrated = normalizeSourceRegistry(legacy);
    expect(migrated.approvedSources[0]).toMatchObject({
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing"
    });
    expect(migrated.approvedSources[1]).toMatchObject({
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "estimated"
    });
    expect(JSON.stringify(migrated)).not.toContain('"verification"');
    expect(JSON.stringify(migrated)).not.toContain('"defaultVerification"');
  });

  it("rejects invented truth-axis values instead of accepting ambiguous persisted status", () => {
    const hostile = JSON.parse(JSON.stringify(createLocalFolderSourceRegistry("/tmp/ai-spend"))) as {
      approvedSources: Array<Record<string, unknown>>;
    };
    hostile.approvedSources[0]!.validationCoverage = "verified";
    expect(() => normalizeSourceRegistry(hostile)).toThrow(/invalid validation coverage/);

    const hostileFinancial = JSON.parse(JSON.stringify(createLocalFolderSourceRegistry("/tmp/ai-spend"))) as {
      approvedSources: Array<Record<string, unknown>>;
    };
    hostileFinancial.approvedSources[0]!.financialEvidence = "live_verified";
    expect(() => normalizeSourceRegistry(hostileFinancial)).toThrow(/invalid financial evidence/);
  });

  it("downgrades repository-controlled provider claims until a machine receipt authenticates them", () => {
    const registry = addApprovedSource(createLocalFolderSourceRegistry("/tmp/ai-spend"), {
      id: "openai-provider-api",
      type: "provider_api",
      label: "OpenAI Admin API",
      provider: "openai",
      validationCoverage: "live_verified",
      financialEvidence: "verified",
      fieldsVerified: ["provider-reported billed cost"]
    });

    const downgraded = downgradeUntrustedSourceRegistryClaims(registry);
    expect(downgraded.approvedSources.find((source) => source.id === "openai-provider-api")).toMatchObject({
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing",
      fieldsVerified: []
    });
  });

  it("does not write a legacy verification property supplied by an untyped caller", () => {
    const registry = createLocalFolderSourceRegistry("/tmp/ai-spend");
    const next = addApprovedSource(registry, {
      id: "legacy-shaped-export",
      type: "provider_export",
      label: "Legacy shaped export",
      provider: "openai",
      verification: "verified"
    } as never);
    const added = next.approvedSources.find((source) => source.id === "legacy-shaped-export");
    expect(added).toMatchObject({
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing"
    });
    expect(added).not.toHaveProperty("verification");
  });

  it("never lets a legacy verification property override canonical financial evidence", () => {
    const dualAxis = JSON.parse(JSON.stringify(createProviderConnectorStub("openai"))) as Record<string, unknown>;
    dualAxis.financialEvidence = "missing";
    dualAxis.verification = "verified";
    const base = createLocalFolderSourceRegistry("/tmp/ai-spend");
    const migrated = normalizeSourceRegistry({
      ...base,
      approvedSources: [dualAxis]
    });
    expect(migrated.approvedSources[0]?.financialEvidence).toBe("missing");
    expect(migrated.approvedSources[0]).not.toHaveProperty("verification");
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

  it("keeps provider auth metadata aligned with the env-reference connectors that actually ship", () => {
    const openai = providerConnectorCatalog.find((connector) => connector.provider === "openai");
    const cursor = providerConnectorCatalog.find((connector) => connector.provider === "cursor");

    expect(openai).toMatchObject({
      provider: "openai",
      preferredAuthMode: "api_token_ref",
      fallbackAuthModes: [],
      tokenStorage: "local_reference_only"
    });
    expect(openai?.scopes).toContain("Organization Admin API usage read");
    expect(cursor).toMatchObject({
      provider: "cursor",
      preferredAuthMode: "api_token_ref",
      fallbackAuthModes: [],
      tokenStorage: "local_reference_only"
    });
    expect(cursor?.scopes).toContain("Cursor team Admin API spend read");
  });

  it("does not advertise unimplemented provider billing fields as verified", () => {
    const cursor = providerCatalog.find((provider) => provider.id === "cursor");
    const copilot = providerCatalog.find((provider) => provider.id === "github-copilot");
    const gemini = providerCatalog.find((provider) => provider.id === "gemini");

    expect(cursor?.verifiedFields).toEqual(["Cursor Admin API team-member spend aggregate"]);
    expect(cursor?.missingFields.join(" ")).toMatch(/filtered usage-event detail/);
    // The shipped AI-credit connector is stated as implemented (post-hoc QA
    // M1: the old copy claimed the launch feature did not exist), while
    // legacy premium-request billing must never be advertised.
    expect(copilot?.verifiedFields.join(" ")).not.toMatch(/premium request/i);
    expect(copilot?.verifiedFields.join(" ")).toMatch(/AI-credit gross, discount, and net billing/);
    expect(copilot?.missingFields.join(" ")).not.toMatch(/AI-credit/);
    expect(copilot?.missingFields.join(" ")).toMatch(/license invoice settlement/);
    expect(gemini?.verifiedFields).toEqual([]);
    expect(gemini?.missingFields.join(" ")).toMatch(/provider-reported billed money/);
    for (const provider of ["anthropic", "cursor", "github-copilot", "codex"]) {
      expect(providerCatalog.find((entry) => entry.id === provider)?.fallbackConnector, provider).toBeUndefined();
    }
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

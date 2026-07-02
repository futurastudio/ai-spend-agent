import { chmod, mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { redactSecrets, scanLocalUsageSignals } from "./discovery.js";

describe("local discovery scanner", () => {
  it("detects AI usage signals from dependencies and config files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-discovery-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({
      dependencies: {
        openai: "latest",
        "@anthropic-ai/sdk": "latest",
        ai: "latest",
        langfuse: "latest"
      }
    }));
    await writeFile(join(dir, "litellm.yaml"), "model_list:\n  - model_name: gpt-4.1\n");

    const result = await scanLocalUsageSignals(dir);

    expect(result.rootPath).toBe(dir);
    expect(result.signals.map((signal) => signal.provider)).toEqual([
      "anthropic",
      "langfuse",
      "litellm",
      "openai",
      "vercel-ai-sdk"
    ]);
    expect(result.scannedFiles).toBe(2);
  });

  it("redacts fake secrets and only reports key names from env files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-redaction-"));
    const openAiKeyName = "OPENAI" + "_API_KEY";
    const anthropicKeyName = "ANTHROPIC" + "_API_KEY";
    const heliconeKeyName = "HELICONE" + "_API_KEY";
    const fakeOpenAiKey = "sk-pro...7890";
    const fakeAnthropicKey = "sk-ant...7890";
    await writeFile(join(dir, ".env"), [
      `${openAiKeyName}=${fakeOpenAiKey}`,
      `${anthropicKeyName}=${fakeAnthropicKey}`,
      `${heliconeKeyName}=helicone_abcdefghijklmnopqrstuvwxyz`
    ].join("\n"));

    const result = await scanLocalUsageSignals(dir);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(fakeOpenAiKey);
    expect(serialized).not.toContain(fakeAnthropicKey);
    expect(serialized).toContain(`${openAiKeyName}=[REDACTED]`);
    expect(serialized).toContain(`${anthropicKeyName}=[REDACTED]`);
    expect(result.secretsDetected).toEqual([anthropicKeyName, heliconeKeyName, openAiKeyName]);
  });

  it("detects provider exports, invoices, and CSV usage files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-exports-"));
    await writeFile(join(dir, "openai-usage-may.csv"), "date,model,cost_usd\n2026-05-01,gpt-4.1,12.34\n");
    await writeFile(join(dir, "anthropic-usage.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", cost_usd: 8.5 }));
    await writeFile(join(dir, "cursor-invoice.md"), "# Cursor invoice\nTotal due: $29.00\n");

    const result = await scanLocalUsageSignals(dir);

    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", kind: "provider_export", filePath: "openai-usage-may.csv" }),
      expect.objectContaining({ provider: "anthropic", kind: "provider_export", filePath: "anthropic-usage.json" }),
      expect.objectContaining({ provider: "cursor", kind: "invoice", filePath: "cursor-invoice.md" })
    ]));
  });

  it("skips heavy and sensitive directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-skip-"));
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, ".ssh"));
    await writeFile(join(dir, "node_modules", "package.json"), JSON.stringify({ dependencies: { openai: "latest" }}));
    await writeFile(join(dir, ".ssh", "config"), "OPENAI_API_KEY=sk-pro...7890");

    const result = await scanLocalUsageSignals(dir);

    expect(result.signals).toHaveLength(0);
    expect(result.skippedDirectories).toContain("node_modules");
    expect(result.skippedDirectories).toContain(".ssh");
  });
});

describe("redactSecrets", () => {
  it("redacts assignment-style secrets and provider key patterns", () => {
    const openAiKeyName = "OPENAI" + "_API_KEY";
    const fakeOpenAiKey = "sk-" + "proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const fakeAnthropicKey = "sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz1234567890";
    const text = `${openAiKeyName}=${fakeOpenAiKey}\nplain ${fakeAnthropicKey}`;

    const redacted = redactSecrets(text);

    expect(redacted).toContain(`${openAiKeyName}=[REDACTED]`);
    expect(redacted).not.toContain(fakeOpenAiKey);
    expect(redacted).not.toContain(fakeAnthropicKey);
  });

  it("redacts non-sk secrets: GitHub tokens, JWTs, Google keys, Slack, AWS, admin-key env names", () => {
    const fakeGhp = "ghp_" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const fakeFineGrained = "github_pat_" + "11ABCDEFG0abcdefghijklmnopqrstuvwxyz";
    const fakeJwt = "eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const fakeGoogle = "AIza" + "SyA1234567890abcdefghijklmnopqrstuv";
    const fakeSlack = "xoxb-" + "123456789012-abcdefghijklmnop";
    const fakeAws = "AKIA" + "IOSFODNN7EXAMPLE";
    const adminKeyName = "OPENAI_ADMIN" + "_KEY";
    const text = [
      `token: ${fakeGhp}`,
      `pat: ${fakeFineGrained}`,
      `bearer ${fakeJwt}`,
      `maps: ${fakeGoogle}`,
      `slack: ${fakeSlack}`,
      `aws: ${fakeAws}`,
      `${adminKeyName}=super-secret-value`
    ].join("\n");

    const redacted = redactSecrets(text);

    for (const secret of [fakeGhp, fakeFineGrained, fakeJwt, fakeGoogle, fakeSlack, fakeAws, "super-secret-value"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain(`${adminKeyName}=[REDACTED]`);
  });
});

describe("hardened discovery walk", () => {
  it("completes the scan despite dangling symlinks and unreadable directories, reporting skips", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-hardened-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { openai: "latest" } }));
    await symlink(join(dir, "does-not-exist.txt"), join(dir, "dangling-link.md"));
    const lockedDir = join(dir, "locked");
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, "notes.md"), "openai spend notes");
    await chmod(lockedDir, 0o000);

    try {
      const result = await scanLocalUsageSignals(dir);

      // The scan must finish and still find the readable signal.
      expect(result.signals.map((signal) => signal.provider)).toContain("openai");
      expect(result.unreadablePaths).toContain("dangling-link.md");
      // chmod 000 has no effect when running as root (CI containers) — only
      // assert the locked dir shows up when the OS actually enforces it.
      if (typeof process.getuid === "function" && process.getuid() !== 0) {
        expect(result.unreadablePaths).toContain("locked");
      }
    } finally {
      await chmod(lockedDir, 0o755);
    }
  });
});

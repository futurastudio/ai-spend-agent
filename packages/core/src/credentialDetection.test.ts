import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLocalCredentials } from "./credentialDetection.js";

const FAKE_OPENAI = "sk-proj-" + "regularfakekey1234567890abcdef";
const FAKE_OPENAI_ADMIN = "sk-" + "adminfakekey1234567890abcdef";
const FAKE_ANTHROPIC = "sk-ant-" + "fakekey1234567890abcdefghijkl";

describe("detectLocalCredentials", () => {
  it("detects keys from process.env without exposing raw values", async () => {
    const result = await detectLocalCredentials({
      env: { OPENAI_API_KEY: FAKE_OPENAI, ANTHROPIC_API_KEY: FAKE_ANTHROPIC },
      cwd: await mkdtemp(join(tmpdir(), "cred-env-")),
      skipShellRc: true
    });

    const providers = result.credentials.map((credential) => credential.provider);
    expect(providers).toEqual(expect.arrayContaining(["openai", "anthropic"]));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_OPENAI);
    expect(serialized).not.toContain(FAKE_ANTHROPIC);
    // References use the env: pattern so they plug into sync-provider.
    const openai = result.credentials.find((credential) => credential.provider === "openai");
    expect(openai!.reference).toBe("env:OPENAI_API_KEY");
    expect(openai!.hint).toMatch(/^sk-\.\.\./);
  });

  it("marks admin-named env vars as likely admin keys", async () => {
    const result = await detectLocalCredentials({
      env: { OPENAI_ADMIN_KEY: FAKE_OPENAI_ADMIN },
      cwd: await mkdtemp(join(tmpdir(), "cred-admin-")),
      skipShellRc: true
    });
    const openai = result.credentials.find((credential) => credential.provider === "openai");
    expect(openai!.isLikelyAdminKey).toBe(true);
  });

  it("reads keys from a .env file in the working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cred-dotenv-"));
    await writeFile(join(dir, ".env"), `OPENAI_API_KEY="${FAKE_OPENAI}"\n# comment\nANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`);

    const result = await detectLocalCredentials({ env: {}, cwd: dir, skipShellRc: true });

    expect(result.credentials).toHaveLength(2);
    expect(result.scannedFiles.some((file) => file.endsWith(".env"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE_OPENAI);
  });

  it("ignores values that do not match a provider key pattern", async () => {
    const result = await detectLocalCredentials({
      env: { OPENAI_API_KEY: "not-a-key", ANTHROPIC_API_KEY: "" },
      cwd: await mkdtemp(join(tmpdir(), "cred-none-")),
      skipShellRc: true
    });
    expect(result.credentials).toHaveLength(0);
  });
});

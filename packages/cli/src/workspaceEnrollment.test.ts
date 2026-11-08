import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import { previewWorkspaceEnrollmentProject, validateWorkspaceEnrollmentProject } from "./workspaceEnrollmentProject.js";
import { beginWorkspaceEnrollment, encodeWorkspaceBundle, finishWorkspaceEnrollment, validateWorkspaceEnrollmentRequest,
  validateWorkspaceEnrollmentResponse, workspaceCanonicalJson, workspaceDomainHash, workspaceEnrollmentRequestHash,
  workspaceEnrollmentRequestProof, WORKSPACE_ORIGIN, type WorkspaceEnrollmentRequest, type WorkspaceEnrollmentRequestV2,
  type WorkspaceEnrollmentResponse } from "./workspaceConnect.js";

const roots: string[] = [];
const now = "2026-11-08T12:00:00.000Z";
const ref = (value: string) => `oref_${value.repeat(43)}`;
const digest = (value: string) => `sha256_${createHash("sha256").update(value).digest("hex")}`;
async function fixture(name = "actual-repository") {
  const root = await mkdtemp(join(tmpdir(), "aibill-enrollment-")); roots.push(root);
  const home = join(root, "home"), repository = join(root, name);
  await mkdir(home); await mkdir(repository);
  await promisify(execFile)("git", ["init", "--quiet", repository], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  return { root, home, repository };
}
async function prepare() {
  const fixtureValue = await fixture();
  const prepared = await beginWorkspaceEnrollment(fixtureValue.home, { projectDirectory: fixtureValue.repository, confirmProject: async () => true });
  expect(prepared.request.schemaVersion).toBe("2");
  return { ...fixtureValue, ...prepared, request: prepared.request as WorkspaceEnrollmentRequestV2 };
}
function responseFor(request: WorkspaceEnrollmentRequest): WorkspaceEnrollmentResponse {
  const intent = { publicKey: request.publicKey, keyId: request.keyId, requestId: request.requestId,
    localSourceInstanceRef: ref("s"), policyRevision: ref("p"), readerRevision: ref("r"), projectAdmissionRevision: ref("j"),
    collectionNotBefore: "2026-11-01T00:00:00.000Z", authorityStartsAt: "2026-11-01T00:00:00.000Z", grantExpiresAt: "2026-12-01T00:00:00.000Z" };
  const binding = { tenantId: "synthetic_tenant", policy: { active: true, consentRevisionRef: intent.policyRevision }, projectId: ref("k"), sourceProjectRef: ref("l") };
  const nonce = Buffer.alloc(32, 2).toString("base64url"), pairingCode = Buffer.alloc(16, 3).toString("base64url");
  const receipt = { state: "prepared" as const, challengeId: intent.requestId, grantId: ref("g"), deviceId: ref("d"), policy: binding.policy,
    projectId: binding.projectId, sourceProjectRef: binding.sourceProjectRef, projectRevision: intent.projectAdmissionRevision,
    collectionNotBefore: intent.collectionNotBefore, authorityStartsAt: intent.authorityStartsAt, grantExpiresAt: intent.grantExpiresAt, nonce, pairingCode,
    requestHash: workspaceDomainHash("tilden:device-enrollment-request:v1", { ...intent, challengeId: intent.requestId,
      grantId: ref("g"), deviceId: ref("d"), nonceHash: digest(nonce), pairingCodeHash: digest(pairingCode) }) };
  return { kind: "tilden_machine_enrollment_response", origin: WORKSPACE_ORIGIN, intent, binding, receipt,
    confirmation: { state: "confirmed", challengeId: intent.requestId },
    ...request.schemaVersion === "1" ? { schemaVersion: "1" } : { schemaVersion: "2", project: request.project, nativeRequestHash: workspaceEnrollmentRequestHash(request) } };
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("explicit native repository confirmation", () => {
  it("uses the real current checkout root from a subdirectory or symlink, never a remote or invented project", async () => {
    const f = await fixture("café-repository");
    const nested = join(f.repository, "packages", "cli"); await mkdir(nested, { recursive: true });
    const linked = join(f.root, "link"); await symlink(nested, linked);
    const expected = { localDirectory: await realpath(f.repository), displayName: "café-repository",
      directoryRef: digest(`project-working-directory\0${await realpath(f.repository)}`) };
    expect(await previewWorkspaceEnrollmentProject(nested)).toEqual(expected);
    expect(await previewWorkspaceEnrollmentProject(linked)).toEqual(expected);
  });

  it("keeps a linked worktree's actual directory identity", async () => {
    const f = await fixture();
    await promisify(execFile)("git", ["-C", f.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture"],
      { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    const linked = join(f.root, "actual-worktree");
    await promisify(execFile)("git", ["-C", f.repository, "worktree", "add", "--quiet", "--detach", linked],
      { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(await previewWorkspaceEnrollmentProject(linked)).toEqual({ localDirectory: await realpath(linked), displayName: "actual-worktree",
      directoryRef: digest(`project-working-directory\0${await realpath(linked)}`) });
  });

  it("ignores inherited Git directory/config overrides when identifying the actual checkout", async () => {
    const f = await fixture(), other = await fixture("other-repository");
    vi.stubEnv("GIT_DIR", join(other.repository, ".git")); vi.stubEnv("GIT_WORK_TREE", other.repository);
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree"); vi.stubEnv("GIT_CONFIG_VALUE_0", other.repository);
    expect((await previewWorkspaceEnrollmentProject(f.repository)).displayName).toBe("actual-repository");
  });

  it("refuses a non-repository, bare repository, missing directory, and unsafe name without creating custody", async () => {
    const f = await fixture("unsafe@name");
    const bare = join(f.root, "bare");
    await promisify(execFile)("git", ["init", "--bare", "--quiet", bare], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    const confirmProject = vi.fn(async () => true);
    for (const path of [f.home, bare, join(f.root, "missing"), f.repository]) {
      await expect(beginWorkspaceEnrollment(f.home, { projectDirectory: path, confirmProject })).rejects.toThrow("real Git checkout");
    }
    expect(confirmProject).not.toHaveBeenCalled();
    await expect(readFile(join(f.home, ".aibill", "workspace-enrollment.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("signs only confirmed public fields and matches the established directory hash domain", async () => {
    const f = await fixture(); const confirmProject = vi.fn(async () => true);
    const prepared = await beginWorkspaceEnrollment(f.home, { projectDirectory: f.repository, confirmProject });
    const request = prepared.request as WorkspaceEnrollmentRequestV2;
    expect(confirmProject).toHaveBeenCalledExactlyOnceWith(await previewWorkspaceEnrollmentProject(f.repository));
    expect(request.project).toEqual({ directoryRef: digest(`project-working-directory\0${await realpath(f.repository)}`), displayName: "actual-repository", confirmation: "CONFIRM_REPOSITORY" });
    const { signature, ...unsigned } = request;
    expect(verify(null, Buffer.from(workspaceEnrollmentRequestProof(unsigned)), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: request.publicKey }, format: "jwk" }), Buffer.from(signature.value, "base64url"))).toBe(true);
    expect(workspaceEnrollmentRequestHash(request)).toBe(digest(`tilden:machine-bootstrap-request:v2\0${workspaceCanonicalJson(request)}`));
    expect(Buffer.from(prepared.bundle, "base64url").toString()).toBe(workspaceCanonicalJson(request));
    expect(workspaceCanonicalJson(request)).not.toContain(f.root);
    expect(() => validateWorkspaceEnrollmentRequest(request)).not.toThrow();
  });

  it("declining or changing the repository during confirmation preserves the previous unused key", async () => {
    const f = await prepare();
    const path = join(f.home, ".aibill", "workspace-enrollment.json"), before = await readFile(path, "utf8");
    await expect(beginWorkspaceEnrollment(f.home, { restart: true, projectDirectory: f.repository, confirmProject: async () => false })).rejects.toThrow("declined");
    await expect(beginWorkspaceEnrollment(f.home, { restart: true, projectDirectory: f.repository, confirmProject: async () => {
      await rename(f.repository, join(f.root, "moved")); return true;
    } })).rejects.toThrow("No new request was created");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("reuses either retained version outside a repository without a second project confirmation", async () => {
    for (const version of ["1", "2"]) {
      const f = await fixture();
      const original = await beginWorkspaceEnrollment(f.home, version === "2" ? { projectDirectory: f.repository, confirmProject: async () => true } : {});
      const confirmProject = vi.fn(async () => { throw Error("must not ask again"); });
      const reused = await beginWorkspaceEnrollment(f.home, { projectDirectory: f.home, confirmProject });
      expect(reused).toEqual({ ...original, disposition: "reused" });
      expect(confirmProject).not.toHaveBeenCalled();
    }
  });

  it("rejects unsigned edits, malformed identity, extra keys, and noncanonical signature encodings", async () => {
    const { request } = await prepare();
    for (const value of [
      { ...request, schemaVersion: 2 }, { ...request, origin: "https://elsewhere.invalid" }, { ...request, extra: true },
      { ...request, requestId: ref("x") }, { ...request, project: { ...request.project, displayName: "different" } },
      { ...request, project: { ...request.project, directoryRef: `sha256_${"f".repeat(64)}` } },
      { ...request, signature: { ...request.signature, value: request.signature.value + "=" } },
      { ...request, signature: { ...request.signature, value: "A".repeat(86) } },
    ]) expect(() => validateWorkspaceEnrollmentRequest(value)).toThrow();
    for (const displayName of ["", ".", "..", "a/b", "a\\b", " a", "a ", "a@b", "a\n", "a\u0085", "a\u202e", "a\ud800", "a".repeat(121)])
      expect(() => validateWorkspaceEnrollmentProject({ ...request.project, displayName })).toThrow();
    expect(() => validateWorkspaceEnrollmentProject({ ...request.project, directoryRef: [request.project.directoryRef] })).toThrow();
  });

  it("requires matching v2 origin, project, full native commitment and version before any exchange", async () => {
    const f = await prepare(), response = responseFor(f.request);
    expect(() => validateWorkspaceEnrollmentResponse(f.request, response, now)).not.toThrow();
    const { project: ignored, nativeRequestHash: ignoredHash, ...oldResponse } = response as Extract<WorkspaceEnrollmentResponse, { schemaVersion: "2" }>;
    const transport = vi.fn(async () => { throw Error("must not exchange"); });
    const confirm = vi.fn(async () => true);
    for (const value of [{ ...oldResponse, schemaVersion: "1" }, { ...response, origin: "https://elsewhere.invalid" },
      { ...response, project: { ...f.request.project, displayName: "different" } }, { ...response, nativeRequestHash: `sha256_${"f".repeat(64)}` },
      { ...response, schemaVersion: 2 }, { ...response, extra: true }]) {
      const bundle = Buffer.from(workspaceCanonicalJson(value)).toString("base64url");
      await expect(finishWorkspaceEnrollment({ home: f.home, bundle, now, confirm, transport })).rejects.toThrow();
    }
    for (const text of [JSON.stringify(response, null, 2), workspaceCanonicalJson(response).replace('"schemaVersion":"2"', '"schemaVersion":"2","schemaVersion":"2"')]) {
      await expect(finishWorkspaceEnrollment({ home: f.home, bundle: Buffer.from(text).toString("base64url"), now, confirm, transport })).rejects.toThrow("canonical");
    }
    expect(confirm).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });

  it("retains v1 exchange compatibility, and v2 uses the unchanged device grant proof only after separate consent", async () => {
    for (const version of ["1", "2"]) {
      const f = await fixture();
      const prepared = await beginWorkspaceEnrollment(f.home, version === "1" ? {} : { projectDirectory: f.repository, confirmProject: async () => true });
      const response = responseFor(prepared.request), bundle = encodeWorkspaceBundle(response);
      const transport = vi.fn(async (body: string) => {
        const payload = JSON.parse(body);
        expect(verify(null, Buffer.from(validateWorkspaceEnrollmentResponse(prepared.request, response, now)),
          createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: prepared.request.publicKey }, format: "jwk" }), Buffer.from(payload.signature, "base64url"))).toBe(true);
        return { status: 200, body: { state: "enrolled", deviceGrantId: response.receipt.grantId, grantRevision: "1", deviceKeyId: prepared.request.keyId,
          connectionEpoch: "1", expiresAt: response.intent.grantExpiresAt, token: Buffer.alloc(32, 9).toString("base64url"), tokenHashKeyVersion: "synthetic_key" } };
      });
      expect(await finishWorkspaceEnrollment({ home: f.home, bundle, now, transport, confirm: async () => false })).toEqual({ state: "cancelled" });
      expect(transport).not.toHaveBeenCalled();
      expect(await finishWorkspaceEnrollment({ home: f.home, bundle, now, transport, confirm: async details => {
        expect(details.project).toEqual(prepared.request.schemaVersion === "2" ? prepared.request.project : undefined); return true;
      } })).toEqual({ state: "connected" });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it("separates CLI repository consent from key preparation and keeps --prepared explicit", async () => {
    const f = await fixture(), prompts: string[] = [];
    const runtime = { homeDirectory: f.home, workspaceDirectory: f.repository, interactive: true,
      consentRead: async (message: string) => { prompts.push(message); return prompts.length === 1 ? "y" : "n"; } };
    const declined = await runCli(["workspace", "connect"], runtime);
    expect(declined.exitCode).toBe(1); expect(declined.stderr).toContain("Repository confirmation declined");
    expect(prompts).toHaveLength(2); expect(prompts[1]).toContain("does not permit session uploads or sharing other repositories");
    await expect(readFile(join(f.home, ".aibill", "workspace-enrollment.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const legacy = await runCli(["workspace", "connect", "--prepared"], { ...runtime, workspaceDirectory: f.home, consentRead: async () => "y" });
    expect(legacy.exitCode).toBe(0); expect(legacy.stdout).toContain("administrator-prepared");
    expect(JSON.parse(await readFile(join(f.home, ".aibill", "workspace-enrollment.json"), "utf8")).request.schemaVersion).toBe("1");
    for (const args of [["workspace", "status", "--prepared"], ["workspace", "connect", "code", "--prepared"], ["workspace", "connect", "--prepared", "--prepared"]])
      expect((await runCli(args, runtime)).exitCode).toBe(1);
  });

  it("prepares a v2 request through the terminal flow without logs, transport, or upload consent", async () => {
    const f = await fixture(), prompts: string[] = [];
    const load = vi.fn(async () => { throw Error("must not scan logs"); }), transport = vi.fn(async () => { throw Error("must not send"); });
    const runtime = { homeDirectory: f.home, workspaceDirectory: f.repository, interactive: true, workspaceLoadCalls: load,
      workspaceTransport: transport, workspaceExchangeTransport: transport,
      consentRead: async (message: string) => { prompts.push(message); return "y"; } };
    const result = await runCli(["workspace", "connect"], runtime);
    expect(result.exitCode).toBe(0); expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(JSON.stringify(await realpath(f.repository)));
    expect(result.stdout).toContain("Reported repository: actual-repository");
    expect(result.stdout).not.toContain(f.root);
    const retained = JSON.parse(await readFile(join(f.home, ".aibill", "workspace-enrollment.json"), "utf8"));
    expect(retained.request.schemaVersion).toBe("2"); expect(() => validateWorkspaceEnrollmentRequest(retained.request)).not.toThrow();
    expect((await runCli(["workspace", "status"], runtime)).stdout).toContain("No native exchange was attempted");
    expect(load).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });

  it("retains v2 custody after uncertain exchange and refuses restart or implicit replay", async () => {
    const f = await prepare(), response = responseFor(f.request), bundle = encodeWorkspaceBundle(response);
    const transport = vi.fn(async () => { throw Error("synthetic lost response"); });
    expect(await finishWorkspaceEnrollment({ home: f.home, bundle, now, transport, confirm: async () => true })).toEqual({ state: "unconfirmed" });
    await expect(finishWorkspaceEnrollment({ home: f.home, bundle, now, transport, confirm: async () => true })).rejects.toThrow("Do not replay");
    await expect(beginWorkspaceEnrollment(f.home, { restart: true, projectDirectory: f.repository, confirmProject: async () => true })).rejects.toMatchObject({ reason: "exchange_uncertain" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(f.home, ".aibill", "workspace-enrollment.json"), "utf8")).request).toEqual(f.request);
  });
});

import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  invalidateConnectedSpendTrustReceipt,
  verifyConnectedSourceRegistryTrustReceipt,
  verifyConnectedSpendTrustReceipt,
  writeConnectedSpendTrustReceipt
} from "./stateTrust.js";

describe("connected provider state trust", () => {
  it("binds the exact spend bytes and canonical project root outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-root-"));
    const trustDir = await mkdtemp(join(tmpdir(), "aibill-trust-receipts-"));
    const spend = '{"mode":"connected_provider","records":[]}\n';

    await writeConnectedSpendTrustReceipt(root, spend, { trustDirectory: trustDir });

    await expect(verifyConnectedSpendTrustReceipt(root, spend, { trustDirectory: trustDir })).resolves.toMatchObject({
      trusted: true,
      spendSha256: createHash("sha256").update(spend).digest("hex")
    });
    const receiptFiles = await import("node:fs/promises").then(({ readdir }) => readdir(trustDir));
    expect(receiptFiles).toHaveLength(1);
    expect(await readFile(join(trustDir, receiptFiles[0]!), "utf8")).not.toContain(spend);
  });

  it("fails closed when a cloned connected spend has no machine receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-clone-"));
    const trustDir = await mkdtemp(join(tmpdir(), "aibill-trust-empty-"));

    const result = await verifyConnectedSpendTrustReceipt(
      root,
      '{"mode":"connected_provider","records":[{"amountUsd":999999}]}\n',
      { trustDirectory: trustDir }
    );

    expect(result).toMatchObject({ trusted: false, reason: "missing" });
    if (!result.trusted) {
      expect(result.message).toContain("Re-run the provider sync");
      expect(result.message).toContain("before using connected totals or Apply actions");
    }
  });

  it("fails closed after any spend content change", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-tamper-"));
    const trustDir = await mkdtemp(join(tmpdir(), "aibill-trust-receipts-"));
    const original = '{"mode":"connected_provider","records":[]}\n';
    await writeConnectedSpendTrustReceipt(root, original, { trustDirectory: trustDir });

    const result = await verifyConnectedSpendTrustReceipt(
      root,
      '{"mode":"connected_provider","records":[{"amountUsd":1}]}\n',
      { trustDirectory: trustDir }
    );

    expect(result).toMatchObject({ trusted: false, reason: "mismatch" });
  });

  it("binds source-status truth to the exact sources.json bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-sources-root-"));
    const trustDir = await mkdtemp(join(tmpdir(), "aibill-trust-sources-receipts-"));
    const spend = '{"mode":"connected_provider","records":[]}\n';
    const sources = '{"approvedSources":[{"id":"openai","financialEvidence":"verified"}]}\n';
    await writeConnectedSpendTrustReceipt(root, spend, {
      trustDirectory: trustDir,
      sourceRegistryContents: sources
    });

    await expect(verifyConnectedSourceRegistryTrustReceipt(
      root,
      spend,
      sources,
      { trustDirectory: trustDir }
    )).resolves.toMatchObject({ trusted: true });
    await expect(verifyConnectedSourceRegistryTrustReceipt(
      root,
      spend,
      sources.replace("verified", "missing"),
      { trustDirectory: trustDir }
    )).resolves.toMatchObject({ trusted: false, reason: "mismatch" });
  });

  it("does not trust source-status claims from a legacy spend-only receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-sources-legacy-root-"));
    const trustDir = await mkdtemp(join(tmpdir(), "aibill-trust-sources-legacy-receipts-"));
    const spend = '{"mode":"connected_provider","records":[]}\n';
    await writeConnectedSpendTrustReceipt(root, spend, { trustDirectory: trustDir });

    await expect(verifyConnectedSourceRegistryTrustReceipt(
      root,
      spend,
      '{"approvedSources":[]}\n',
      { trustDirectory: trustDir }
    )).resolves.toMatchObject({ trusted: false, reason: "missing" });
  });

  it("invalidates an old receipt and refuses to store receipts inside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-invalidate-"));
    const trustDir = await mkdtemp(join(tmpdir(), "aibill-trust-receipts-"));
    const spend = '{"mode":"connected_provider","records":[]}\n';
    await writeConnectedSpendTrustReceipt(root, spend, { trustDirectory: trustDir });
    await invalidateConnectedSpendTrustReceipt(root, { trustDirectory: trustDir });
    await expect(verifyConnectedSpendTrustReceipt(root, spend, { trustDirectory: trustDir })).resolves.toMatchObject({
      trusted: false,
      reason: "missing"
    });

    const repositoryTrustDir = join(root, ".ai-spend-agent", "receipts");
    await expect(writeConnectedSpendTrustReceipt(root, spend, { trustDirectory: repositoryTrustDir }))
      .rejects.toThrow(/outside the approved repository/);
  });

  it("refuses a symlinked external trust directory or receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-trust-links-root-"));
    const outside = await mkdtemp(join(tmpdir(), "aibill-trust-links-outside-"));
    const parent = await mkdtemp(join(tmpdir(), "aibill-trust-links-parent-"));
    const trustLink = join(parent, "receipts");
    await symlink(outside, trustLink);

    const result = await verifyConnectedSpendTrustReceipt(
      root,
      '{"mode":"connected_provider","records":[]}\n',
      { trustDirectory: trustLink }
    );
    expect(result).toMatchObject({ trusted: false, reason: "invalid" });
    if (result.trusted) throw new Error("Expected the symlinked trust directory to be rejected.");
    expect(result.message).not.toContain(trustLink);
    await expect(writeConnectedSpendTrustReceipt(root, "{}\n", { trustDirectory: trustLink }))
      .rejects.toThrow(/not a real directory/);

    await writeConnectedSpendTrustReceipt(root, "{}\n", { trustDirectory: outside });
    const [receiptName] = await import("node:fs/promises").then(({ readdir }) => readdir(outside));
    const target = join(parent, "attacker.json");
    await writeFile(target, "{}\n");
    await import("node:fs/promises").then(({ unlink }) => unlink(join(outside, receiptName!)));
    await symlink(target, join(outside, receiptName!));
    const symlinkedReceipt = await verifyConnectedSpendTrustReceipt(
      root,
      "{}\n",
      { trustDirectory: outside }
    );
    expect(symlinkedReceipt).toMatchObject({ trusted: false, reason: "invalid" });
    if (symlinkedReceipt.trusted) throw new Error("Expected the symlinked trust receipt to be rejected.");
    expect(symlinkedReceipt.message).not.toContain(outside);
    expect(symlinkedReceipt.message).not.toContain(receiptName!);
    expect(symlinkedReceipt.message).not.toContain(target);
  });
});

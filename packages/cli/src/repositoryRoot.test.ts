import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveRepositoryRoot } from "./repositoryRoot.js";

async function checkout(): Promise<{ root: string; main: string }> {
  const root = await mkdtemp(join(tmpdir(), "aibill-repo-root-"));
  const main = join(root, "agent-finops");
  await mkdir(join(main, ".git", "worktrees", "roi-verify"), { recursive: true });
  await mkdir(join(main, "apps", "workspace-web"), { recursive: true });
  return { root, main };
}

describe("resolveRepositoryRoot", () => {
  it("returns the checkout for its root and for a sub-folder", async () => {
    const { main } = await checkout();
    expect(resolveRepositoryRoot(main)).toBe(main);
    expect(resolveRepositoryRoot(join(main, "apps", "workspace-web"))).toBe(main);
  });

  it("returns the main checkout for a linked worktree, nested or elsewhere", async () => {
    const { root, main } = await checkout();
    const nested = join(main, ".worktrees", "roi-verify");
    await mkdir(join(nested, "packages"), { recursive: true });
    await writeFile(join(nested, ".git"), `gitdir: ${join(main, ".git", "worktrees", "roi-verify")}\n`);
    expect(resolveRepositoryRoot(nested)).toBe(main);
    expect(resolveRepositoryRoot(join(nested, "packages"))).toBe(main);
    const elsewhere = join(root, "elsewhere", "feature");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\r\n`);
    expect(resolveRepositoryRoot(elsewhere)).toBe(main);
  });

  it("keeps a submodule and an unreadable .git file as their own checkout", async () => {
    const { main } = await checkout();
    const submodule = join(main, "vendor", "lib");
    await mkdir(submodule, { recursive: true });
    await writeFile(join(submodule, ".git"), "gitdir: ../../.git/modules/vendor/lib\n");
    expect(resolveRepositoryRoot(submodule)).toBe(submodule);
    const odd = join(main, "vendor", "odd");
    await mkdir(odd, { recursive: true });
    await writeFile(join(odd, ".git"), "not a gitdir pointer");
    expect(resolveRepositoryRoot(odd)).toBe(odd);
  });

  it("is undefined outside any checkout, for a missing path, a relative path, or a .git symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "aibill-no-repo-"));
    const plain = join(root, "notes");
    await mkdir(plain);
    // Climbing stops at the filesystem root; the temp root has no .git above it.
    expect(resolveRepositoryRoot(plain)).toBe(resolveRepositoryRoot(root));
    expect(resolveRepositoryRoot(join(root, "does-not-exist"))).toBe(resolveRepositoryRoot(root));
    expect(resolveRepositoryRoot("relative/path")).toBeUndefined();
    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(join(root, "notes"), join(linked, ".git"));
    expect(resolveRepositoryRoot(linked)).toBe(resolveRepositoryRoot(root));
  });
});

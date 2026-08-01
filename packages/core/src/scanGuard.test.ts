import { lstat, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnsafeScanRootError,
  UnsafeStateDirectoryError,
  UnsafeStateFileError,
  assertSafeScanRoot,
  resolveSafeScanRoot,
  resolveSafeStateDirectory,
  readSafeStateText,
  writeSafeStateText,
  unsafeScanRootReason
} from "./scanGuard.js";

const fakeHome = "/Users/testuser";

describe("shared unsafe-scan-root guard (CLI + MCP)", () => {
  it("refuses the filesystem root", () => {
    expect(unsafeScanRootReason("/", fakeHome)).toMatch(/filesystem root/);
  });

  it("refuses the home directory", () => {
    expect(unsafeScanRootReason(fakeHome, fakeHome)).toMatch(/home directory/);
    expect(unsafeScanRootReason(`${fakeHome}/`, fakeHome)).toMatch(/home directory/);
  });

  it("refuses ancestors of the home directory such as /Users", () => {
    expect(unsafeScanRootReason("/Users", fakeHome)).toMatch(/contains your home directory/);
  });

  it("refuses system directories", () => {
    for (const path of ["/etc", "/usr", "/var", "/Library", "/System"]) {
      expect(unsafeScanRootReason(path, fakeHome), path).toBeDefined();
    }
  });

  it("allows a normal project directory inside home", () => {
    expect(unsafeScanRootReason(`${fakeHome}/projects/my-app`, fakeHome)).toBeUndefined();
  });

  it("assertSafeScanRoot throws a typed error for unsafe roots and passes safe ones", () => {
    expect(() => assertSafeScanRoot(fakeHome, fakeHome)).toThrow(UnsafeScanRootError);
    expect(() => assertSafeScanRoot(fakeHome, fakeHome)).toThrow(/too broad/);
    expect(() => assertSafeScanRoot(`${fakeHome}/projects/my-app`, fakeHome)).not.toThrow();
  });

  it("canonicalizes an approved symlink root and rejects one that resolves to home", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ai-spend-root-realpath-"));
    const actualHome = join(parent, "home");
    const project = join(actualHome, "projects", "app");
    const projectLink = join(parent, "project-link");
    const homeLink = join(parent, "home-link");
    await mkdir(project, { recursive: true });
    await symlink(project, projectLink);
    await symlink(actualHome, homeLink);

    await expect(resolveSafeScanRoot(projectLink, actualHome)).resolves.toBe(await realpath(project));
    await expect(resolveSafeScanRoot(homeLink, actualHome)).rejects.toThrow(UnsafeScanRootError);
    expect(unsafeScanRootReason(homeLink, actualHome)).toMatch(/home directory/);
  });

  it("refuses a symlinked .ai-spend-agent directory for reads and writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-spend-state-root-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-spend-state-outside-"));
    const stateLink = join(root, ".ai-spend-agent");
    await symlink(outside, stateLink);

    await expect(resolveSafeStateDirectory(root)).rejects.toThrow(UnsafeStateDirectoryError);
    await expect(resolveSafeStateDirectory(root, { create: true })).rejects.toThrow(/symbolic link/);
  });

  it("never follows symlinked state child files on reads or writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-spend-state-child-root-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-spend-state-child-outside-"));
    const stateDir = await resolveSafeStateDirectory(root, { create: true });
    const outsideFile = join(outside, "private.json");
    await writeFile(outsideFile, '{"private":"must remain outside"}\n');
    await symlink(outsideFile, join(stateDir, "spend.json"));

    await expect(readSafeStateText(stateDir, "spend.json")).rejects.toThrow(UnsafeStateFileError);
    await expect(writeSafeStateText(stateDir, "spend.json", '{"safe":true}\n')).rejects.toThrow(/symbolic link/);
    expect(await readFile(outsideFile, "utf8")).toContain("must remain outside");
  });

  it("writes regular state files atomically with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-spend-state-private-"));
    const stateDir = await resolveSafeStateDirectory(root, { create: true });

    await writeSafeStateText(stateDir, "spend.json", '{"safe":true}\n');

    expect(await readSafeStateText(stateDir, "spend.json")).toBe('{"safe":true}\n');
    const info = await lstat(join(stateDir, "spend.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });
});

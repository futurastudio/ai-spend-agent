import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * The checkout a directory belongs to, found without running git: the nearest
 * ancestor that holds a `.git` directory, or, for a linked worktree whose
 * `.git` file points at `<main>/.git/worktrees/<name>`, the main checkout. A
 * submodule or an unreadable `.git` file keeps its own directory. Undefined
 * outside any checkout, or when the path does not exist on this machine.
 */
export function resolveRepositoryRoot(directory: string): string | undefined {
  if (!isAbsolute(directory)) return undefined;
  let current = resolve(directory);
  for (;;) {
    const dotGit = resolve(current, ".git");
    let kind: "directory" | "file" | undefined;
    try {
      const stat = lstatSync(dotGit);
      kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
    } catch {
      kind = undefined;
    }
    if (kind === "directory") return current;
    if (kind === "file") {
      let text: string;
      try { text = readFileSync(dotGit, "utf8").slice(0, 4096); } catch { return current; }
      const match = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text);
      if (!match) return current;
      const gitdir = resolve(current, match[1]!);
      const linked = /^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir);
      return linked ? linked[1]! : current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The checkout a directory sits in, linked worktrees included: the nearest
 * ancestor holding a `.git` directory or file. This is the directory Claude
 * Code reads shared project settings from when a session starts there, so
 * `guard install` writes into it; `resolveRepositoryRoot` names the main
 * checkout that owns the policy. Undefined outside any checkout.
 */
export function resolveCheckoutRoot(directory: string): string | undefined {
  if (!isAbsolute(directory)) return undefined;
  let current = resolve(directory);
  for (;;) {
    try {
      const stat = lstatSync(resolve(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // Keep climbing.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

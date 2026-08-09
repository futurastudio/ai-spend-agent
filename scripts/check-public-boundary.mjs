#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findDeveloperPathLeaks,
  isForbiddenPublicPath
} from "./public-boundary-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
  cwd: root,
  encoding: "utf8"
  }
).split("\0").filter(Boolean);
const forbiddenFiles = tracked.filter((path) => (
  isForbiddenPublicPath(path) ||
  /(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example")
));
if (forbiddenFiles.length > 0) {
  throw new Error(`internal/private files are tracked: ${forbiddenFiles.join(", ")}`);
}

const localPathLeaks = [];
const symbolicLinks = [];
for (const path of tracked) {
  const info = await lstat(resolve(root, path)).catch(() => undefined);
  if (info?.isSymbolicLink()) {
    symbolicLinks.push(path);
    continue;
  }
  const content = await readFile(resolve(root, path), "utf8").catch(() => "");
  if (findDeveloperPathLeaks(content).length > 0) localPathLeaks.push(path);
}
if (symbolicLinks.length > 0) {
  throw new Error(`symbolic links require explicit public-boundary review and are refused: ${symbolicLinks.join(", ")}`);
}
if (localPathLeaks.length > 0) {
  throw new Error(`developer home path is tracked in: ${localPathLeaks.join(", ")}`);
}

console.log(JSON.stringify({
  status: "pass",
  trackedFilesChecked: tracked.length,
  internalPathsTracked: 0,
  developerHomeLeaks: 0,
  symbolicLinks: 0
}));

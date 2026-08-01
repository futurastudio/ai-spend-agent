#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
  cwd: root,
  encoding: "utf8"
  }
).split("\0").filter(Boolean);
const forbiddenPathPatterns = [
  /(^|\/)ARTIFACT_ROADMAP(?:\.[^/]*)?$/i,
  /(^|\/)AUDIT_PUBLIC_REPO(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:research|gtm|internal|private)(?:\/|$)/i,
  /(^|\/)\.(?:codex|claude)(?:\/|$)/i,
  /(^|\/)\.npmrc$/i
];
const forbiddenFiles = tracked.filter((path) => (
  forbiddenPathPatterns.some((pattern) => pattern.test(path)) ||
  /(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example")
));
if (forbiddenFiles.length > 0) {
  throw new Error(`internal/private files are tracked: ${forbiddenFiles.join(", ")}`);
}

const localHome = ["/Users", "joseartigas"].join("/");
const localPathLeaks = [];
for (const path of tracked) {
  const content = await readFile(resolve(root, path), "utf8").catch(() => "");
  if (content.includes(localHome)) localPathLeaks.push(path);
}
if (localPathLeaks.length > 0) {
  throw new Error(`developer home path is tracked in: ${localPathLeaks.join(", ")}`);
}

console.log(JSON.stringify({
  status: "pass",
  trackedFilesChecked: tracked.length,
  internalPathsTracked: 0,
  developerHomeLeaks: 0
}));

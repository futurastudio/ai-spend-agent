#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const expectedVersion = "0.5.9";
const packages = [
  { directory: "packages/core", name: "@agent-finops/core" },
  { directory: "packages/report", name: "@agent-finops/report" },
  { directory: "packages/mcp", name: "@agent-finops/mcp" },
  { directory: "packages/cli", name: "ai-spend-agent" },
  { directory: "packages/aibill", name: "aibill" }
];
const requiredReleaseDependencies = new Map([
  ["@agent-finops/report", { "@agent-finops/core": expectedVersion }],
  ["@agent-finops/mcp", { "@agent-finops/core": expectedVersion }],
  ["ai-spend-agent", {
    "@agent-finops/core": expectedVersion,
    "@agent-finops/report": expectedVersion
  }],
  ["aibill", { "ai-spend-agent": expectedVersion }]
]);
const coordinatedNames = new Set(packages.map((entry) => entry.name));
const forbiddenPathPatterns = [
  /(^|\/)(?:ARTIFACT_ROADMAP(?:\.[^/]*)?|AUDIT_PUBLIC_REPO(?:_[^/]*)?\.md)$/i,
  /(^|\/)(?:docs\/)?(?:research|gtm)(?:\/|$)/i,
  /(^|\/)(?:internal|private)(?:\/|$)/i,
  /(^|\/)\.(?:git|github|codex|claude|agents)(?:\/|$)/i,
  /(^|\/)\.npmrc$/i
];

const manifests = new Map();
for (const releasePackage of packages) {
  const packageRoot = resolve(root, releasePackage.directory);
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8")
  );
  assert(
    manifest.name === releasePackage.name,
    `${releasePackage.directory} is ${manifest.name}, expected ${releasePackage.name}`
  );
  assert(
    manifest.version === expectedVersion,
    `${manifest.name} is ${manifest.version}, expected ${expectedVersion}`
  );
  manifests.set(manifest.name, manifest);

  for (const dependencyGroup of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    for (const [name, range] of Object.entries(manifest[dependencyGroup] ?? {})) {
      if (!coordinatedNames.has(name)) continue;
      assert(
        range === expectedVersion,
        `${manifest.name} ${dependencyGroup}.${name} is ${range}, expected ${expectedVersion}`
      );
    }
  }
}

for (const [name, dependencies] of requiredReleaseDependencies) {
  const manifest = manifests.get(name);
  for (const [dependency, version] of Object.entries(dependencies)) {
    assert(
      manifest.dependencies?.[dependency] === version,
      `${name} must depend on ${dependency}@${version}`
    );
  }
}

const packed = [];
for (const releasePackage of packages) {
  const manifest = manifests.get(releasePackage.name);
  assert(manifest, `missing manifest for ${releasePackage.name}`);
  const output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json", "--silent"],
    {
      cwd: resolve(root, releasePackage.directory),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  const results = JSON.parse(output);
  assert(
    results.length === 1,
    `${releasePackage.name} returned ${results.length} pack results`
  );
  const result = results[0];
  assert(
    result.name === releasePackage.name,
    `${releasePackage.name} pack name drifted`
  );
  assert(
    result.version === expectedVersion,
    `${releasePackage.name} packed ${result.version}, expected ${expectedVersion}`
  );

  const filePaths = result.files.map((file) => normalizePath(file.path));
  const forbidden = filePaths.filter(isForbiddenPath);
  assert(
    forbidden.length === 0,
    `${releasePackage.name} would publish internal/private paths: ${forbidden.join(", ")}`
  );
  for (const requiredFile of ["package.json", "README.md", "LICENSE"]) {
    assert(
      filePaths.includes(requiredFile),
      `${releasePackage.name} pack is missing required ${requiredFile}`
    );
  }
  const declaredEntrypoints = [
    manifest.main,
    manifest.types,
    ...Object.values(manifest.bin ?? {}),
    ...exportTargets(manifest.exports)
  ].filter((entrypoint) => typeof entrypoint === "string")
    .map((entrypoint) => normalizePath(entrypoint));
  for (const entrypoint of declaredEntrypoints) {
    assert(
      filePaths.includes(entrypoint),
      `${releasePackage.name} pack is missing declared entrypoint ${entrypoint}`
    );
  }
  packed.push({
    package: `${result.name}@${result.version}`,
    files: filePaths.length,
    filename: result.filename
  });
}

console.log(JSON.stringify({
  status: "pass",
  expectedVersion,
  packages: packed,
  internalPrivatePaths: 0
}));

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isForbiddenPath(path) {
  if (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example")) return true;
  return forbiddenPathPatterns.some((pattern) => pattern.test(path));
}

function exportTargets(exportsField) {
  if (typeof exportsField === "string") return [exportsField];
  if (!exportsField || typeof exportsField !== "object") return [];
  return Object.values(exportsField).flatMap(exportTargets);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

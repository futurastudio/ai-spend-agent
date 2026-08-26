#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findDeveloperPathLeaks,
  isForbiddenPublicPath
} from "./public-boundary-rules.mjs";

const root = resolve(import.meta.dirname, "..");
const expectedVersion = JSON.parse(
  await readFile(resolve(root, "packages/core/package.json"), "utf8")
).version;
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
const packagingOnlyForbiddenPathPatterns = [
  /(^|\/)\.(?:git|github|codex|claude|agents)(?:\/|$)/i,
];
const forbiddenPackedContentPatterns = [
  /\bCODEX_(?:BUILD|CLOUD)_SPEC(?:_[A-Z0-9-]+)?\.md\b/i,
  /\bARTIFACT_ROADMAP(?:_[A-Z0-9-]+)?\.md\b/i,
  /(?:^|[\s`"'])docs\/(?:gtm|research|internal|private)\//im
];

/**
 * B2 (0.9.7): the shipped 0.9.6 tarball for `ai-spend-agent` carried
 * "No product telemetry is sent." in its README while its own
 * `dist/telemetry.js` held `telemetryUrl = "https://asktilden.com/api/telemetry"`
 * and stamped `enabled: true` on notice. The repo had already corrected that
 * exact sentence publicly — a dated blog correction, docs/TELEMETRY.md, the
 * homepage FAQ — and only the package README still said it, which is a
 * ready-made "which is it?" screenshot for anyone checking npmjs.com.
 *
 * Prose cannot be typechecked, so the invariant is enforced where it actually
 * matters: at the tarball boundary, over the exact bytes npm would publish.
 *
 * The packages that CAN send telemetry are the two that ship the CLI. A
 * package with no telemetry code may keep its scoped claim (the MCP server
 * genuinely sends none; importing @agent-finops/core genuinely sends none) —
 * so the ban is applied per package, from what that package actually does.
 */
const telemetryCapablePackages = new Set(["ai-spend-agent", "aibill"]);
const falseNoTelemetryClaimPatterns = [
  // "No product telemetry is sent", "sends no telemetry", "no telemetry is
  // sent". `\s` never matches the underscore in AI_SPEND_NO_TELEMETRY.
  /\b(?:no|zero)\s+(?:product\s+|aibill\s+)?telemetry\b/i,
  /\bsends?\s+(?:no|zero)\s+(?:product\s+|aibill\s+)?telemetry\b/i,
  /\btelemetry\s+is\s+(?:not\s+sent|never\s+sent)\b/i,
  /\bnever\s+sends?\s+(?:any\s+)?telemetry\b/i
];
/** The disclosure a telemetry-capable package must carry instead. */
const requiredTelemetryDisclosure = "aibill telemetry off";

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
  const contentLeaks = [];
  const symbolicLinks = [];
  const falseTelemetryClaims = [];
  const staleVersionClaims = [];
  const canSendTelemetry = telemetryCapablePackages.has(releasePackage.name);
  for (const filePath of filePaths) {
    const absolutePath = resolve(root, releasePackage.directory, filePath);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      symbolicLinks.push(filePath);
      continue;
    }
    const content = await readFile(absolutePath, "utf8")
      .catch(() => "");
    if (
      findDeveloperPathLeaks(content).length > 0 ||
      forbiddenPackedContentPatterns.some((pattern) => pattern.test(content))
    ) {
      contentLeaks.push(filePath);
    }
    // Only human-authored docs are swept. The RUNTIME may still say "no
    // aibill telemetry" — every such string is branched on the live
    // telemetry state (receipt-line truth, docs/TELEMETRY.md), so it is a
    // true statement about the run that printed it. A README cannot branch:
    // whatever it claims, it claims to everyone, forever.
    if (!/\.(?:md|markdown|txt)$/i.test(filePath)) continue;
    if (canSendTelemetry) {
      for (const pattern of falseNoTelemetryClaimPatterns) {
        const match = pattern.exec(content);
        if (match) falseTelemetryClaims.push(`${filePath}: "${match[0]}"`);
      }
    }
    // Prose that names a release version rots at the next release, and a
    // stale one is indistinguishable from a lie to a reader on npmjs.com:
    // 0.9.6's core and mcp READMEs both still described "v0.9.1".
    for (const claimed of content.match(/\bv?\d+\.\d+\.\d+\b/g) ?? []) {
      if (claimed.replace(/^v/, "") !== expectedVersion) {
        staleVersionClaims.push(`${filePath}: "${claimed}"`);
      }
    }
  }
  assert(
    falseTelemetryClaims.length === 0,
    `${releasePackage.name} ships the CLI, which sends disclosed anonymous command ` +
    `counts, yet would publish a no-telemetry claim in: ${falseTelemetryClaims.join(", ")}. ` +
    `Use the honest wording (anonymous command counts, disclosed at first run, ` +
    `"${requiredTelemetryDisclosure}" turns it off) — see docs/TELEMETRY.md.`
  );
  if (canSendTelemetry) {
    assert(
      filePaths.includes("README.md") &&
      (await readFile(resolve(root, releasePackage.directory, "README.md"), "utf8"))
        .includes(requiredTelemetryDisclosure),
      `${releasePackage.name} ships the CLI but its published README never tells a ` +
      `reader how to turn telemetry off ("${requiredTelemetryDisclosure}")`
    );
  }
  assert(
    staleVersionClaims.length === 0,
    `${releasePackage.name} would publish a version claim that is not ${expectedVersion}: ` +
    `${staleVersionClaims.join(", ")}. Prefer wording with no version in it.`
  );
  assert(
    contentLeaks.length === 0,
    `${releasePackage.name} would publish internal/private content in: ${contentLeaks.join(", ")}`
  );
  assert(
    symbolicLinks.length === 0,
    `${releasePackage.name} would publish symbolic links requiring explicit review: ${symbolicLinks.join(", ")}`
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
  internalPrivatePaths: 0,
  internalPrivateContentFiles: 0,
  falseTelemetryClaims: 0,
  staleVersionClaims: 0
}));

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isForbiddenPath(path) {
  if (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example")) return true;
  return isForbiddenPublicPath(path) || packagingOnlyForbiddenPathPatterns.some((pattern) => pattern.test(path));
}

function exportTargets(exportsField) {
  if (typeof exportsField === "string") return [exportsField];
  if (!exportsField || typeof exportsField !== "object") return [];
  return Object.values(exportsField).flatMap(exportTargets);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Telemetry kill-switch (0.9.4): this script spawns the REAL built/packed
// CLI. Without these, every local run emitted production telemetry from the
// developer's machine (phantom unpublished-version installs in the live
// counts). Set at script level so no human ever has to remember it; every
// child env below either inherits process.env or spreads it.
process.env.AI_SPEND_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";


const root = resolve(import.meta.dirname, "..");
const releasePackages = [
  { directory: "packages/core", name: "@agent-finops/core" },
  { directory: "packages/report", name: "@agent-finops/report" },
  { directory: "packages/mcp", name: "@agent-finops/mcp" },
  { directory: "packages/cli", name: "ai-spend-agent" },
  { directory: "packages/aibill", name: "aibill" }
];
const scratch = await mkdtemp(join(tmpdir(), "aibill-packed-install-"));
const tarballDir = join(scratch, "tarballs");
const installDir = join(scratch, "consumer");

try {
  await mkdir(tarballDir);
  await mkdir(installDir);
  const tarballs = [];
  let expectedVersion;

  for (const releasePackage of releasePackages) {
    const packageRoot = resolve(root, releasePackage.directory);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    expectedVersion ??= manifest.version;
    if (manifest.version !== expectedVersion) {
      throw new Error(`${manifest.name} is ${manifest.version}; expected coordinated ${expectedVersion}`);
    }
    const packed = JSON.parse(execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--silent", "--pack-destination", tarballDir],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    ));
    if (packed.length !== 1 || packed[0].name !== releasePackage.name) {
      throw new Error(`Unexpected pack result for ${releasePackage.name}`);
    }
    tarballs.push(join(tarballDir, packed[0].filename));
  }

  await writeFile(join(installDir, "package.json"), JSON.stringify({
    name: "aibill-clean-install-smoke",
    version: "1.0.0",
    private: true
  }, null, 2));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: installDir, stdio: ["ignore", "pipe", "inherit"] }
  );

  const installed = {};
  for (const releasePackage of releasePackages) {
    const manifestPath = join(
      installDir,
      "node_modules",
      ...releasePackage.name.split("/"),
      "package.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== expectedVersion) {
      throw new Error(`${manifest.name} installed at ${manifest.version}; expected ${expectedVersion}`);
    }
    installed[manifest.name] = manifest.version;
  }

  const cliPath = join(installDir, "node_modules", "ai-spend-agent", "dist", "index.js");
  const aliasPath = join(installDir, "node_modules", "aibill", "run.js");
  const mcpPath = join(installDir, "node_modules", "@agent-finops", "mcp", "dist", "server.js");
  const packedRuntimePath = join(
    installDir,
    "node_modules",
    "ai-spend-agent",
    "dist",
    "statuslineRuntime.js"
  );
  // Pin: the kill-switch must be armed before ANY real-CLI child runs — a
  // refactor that drops the top-of-script env would fail here, not in the
  // production telemetry counts.
  if (process.env.AI_SPEND_NO_TELEMETRY !== "1" || process.env.DO_NOT_TRACK !== "1") {
    throw new Error("smoke harness must set AI_SPEND_NO_TELEMETRY=1 and DO_NOT_TRACK=1 before spawning the CLI.");
  }
  const help = execFileSync(process.execPath, [cliPath, "--help"], {
    cwd: installDir,
    encoding: "utf8"
  });
  const sample = execFileSync(process.execPath, [aliasPath, "--sample", "--no-color"], {
    cwd: installDir,
    encoding: "utf8"
  });
  if (
    !help.includes("aibill") ||
    !sample.includes("aibill · DEMO SAMPLE") ||
    !sample.includes("Details") ||
    !sample.includes("npx aibill --sample --full") ||
    sample.includes("DATA MODE: demo sample")
  ) {
    throw new Error("Packed CLI or alias did not produce the expected clean-install output.");
  }
  const mcpHelp = execFileSync(process.execPath, [mcpPath, "--help"], {
    cwd: installDir,
    encoding: "utf8"
  });
  const mcpVersion = execFileSync(process.execPath, [mcpPath, "--version"], {
    cwd: installDir,
    encoding: "utf8"
  });
  if (
    !mcpHelp.includes("Start the local stdio MCP server") ||
    !mcpHelp.includes("invoking AI client") ||
    mcpVersion.trim() !== expectedVersion
  ) {
    throw new Error("Packed MCP help/version did not exit with the expected clean-install output.");
  }

  // Exercise the exact standalone runtime copied out of the installed npm
  // tarball. This catches missing dist assets and repository-path assumptions
  // that source-level installer tests cannot see.
  const statuslineHome = join(scratch, "statusline-home");
  await mkdir(statuslineHome);
  const statuslineEnvironment = {
    ...process.env,
    HOME: statuslineHome,
    USERPROFILE: statuslineHome,
    AIBILL_CACHE_DIR: join(statuslineHome, ".aibill", "cache"),
    COLUMNS: "100"
  };
  const statuslineInstall = execFileSync(
    process.execPath,
    [aliasPath, "statusline", "install", "--path", installDir],
    {
      cwd: installDir,
      encoding: "utf8",
      env: statuslineEnvironment
    }
  );
  if (!statuslineInstall.includes("installed in Claude user settings")) {
    throw new Error("Packed statusline installer did not report an explicit installation.");
  }
  const installedRuntimePath = join(statuslineHome, ".aibill", "bin", "statusline.mjs");
  const [packedRuntime, installedRuntime] = await Promise.all([
    readFile(packedRuntimePath),
    readFile(installedRuntimePath)
  ]);
  if (!packedRuntime.equals(installedRuntime)) {
    throw new Error("Packed statusline installer did not copy the published runtime verbatim.");
  }
  const statuslineRender = spawnSync(process.execPath, [installedRuntimePath], {
    cwd: installDir,
    encoding: "utf8",
    env: statuslineEnvironment,
    input: '{"model":{"display_name":"hostile session input"},"rate_limits":{"weekly":99}}'
  });
  if (
    statuslineRender.status !== 0 ||
    statuslineRender.stderr !== "" ||
    statuslineRender.stdout !== "aibill · run npx aibill init\n"
  ) {
    throw new Error(
      "Packed statusline runner did not fail closed with one clean cache-only line: " +
      JSON.stringify({
        status: statuslineRender.status,
        signal: statuslineRender.signal,
        stdout: statuslineRender.stdout,
        stderr: statuslineRender.stderr
      })
    );
  }
  const statuslineUninstall = execFileSync(
    process.execPath,
    [aliasPath, "statusline", "uninstall"],
    {
      cwd: installDir,
      encoding: "utf8",
      env: statuslineEnvironment
    }
  );
  if (!statuslineUninstall.includes("removed from Claude user settings")) {
    throw new Error("Packed statusline installer did not complete its reversible uninstall.");
  }
  for (const removedPath of [
    join(statuslineHome, ".claude", "settings.json"),
    installedRuntimePath,
    join(statuslineHome, ".aibill", "statusline-install-receipt.json")
  ]) {
    try {
      await readFile(removedPath);
      throw new Error(`Packed statusline uninstall left an owned file behind: ${removedPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Packed statusline uninstall")) throw error;
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  const backupEntries = await readdir(join(statuslineHome, ".aibill", "backups"));
  if (backupEntries.length !== 0) {
    throw new Error("Packed statusline uninstall left owned recovery backups behind.");
  }
  execFileSync(process.execPath, [resolve(root, "scripts/smoke-mcp.mjs"), mcpPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"]
  });

  console.log(JSON.stringify({
    status: "pass",
    install: "five local tarballs into an empty consumer project",
    expectedVersion,
    installed,
    cliHelp: "pass",
    aliasSample: "pass",
    mcpHelpVersion: "pass",
    statuslineInstallRenderUninstall: "pass",
    mcpProtocol: "pass"
  }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

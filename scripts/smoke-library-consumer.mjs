#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = [
  { directory: "packages/core", name: "@agent-finops/core" },
  { directory: "packages/report", name: "@agent-finops/report" }
];
const scratch = await mkdtemp(join(tmpdir(), "aibill-library-consumer-"));
const tarballDirectory = join(scratch, "tarballs");
const consumerDirectory = join(scratch, "consumer");

try {
  await mkdir(tarballDirectory);
  await mkdir(consumerDirectory);

  const tarballs = [];
  let expectedVersion;
  for (const packageEntry of packages) {
    const packageRoot = resolve(root, packageEntry.directory);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    expectedVersion ??= manifest.version;
    assert(manifest.version === expectedVersion, `${manifest.name} is not on the coordinated version.`);
    assertRootOnlyExportMap(manifest);

    const packed = JSON.parse(execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--silent", "--pack-destination", tarballDirectory],
      { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
    ));
    assert(packed.length === 1 && packed[0].name === packageEntry.name, `Unexpected pack result for ${packageEntry.name}.`);
    tarballs.push(join(tarballDirectory, packed[0].filename));
  }

  await writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({
    name: "aibill-library-contract-smoke",
    version: "1.0.0",
    private: true,
    type: "module"
  }, null, 2)}\n`);
  execFileSync(
    "npm",
    ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
    { cwd: consumerDirectory, stdio: ["ignore", "pipe", "inherit"] }
  );

  const exampleDirectory = resolve(root, "examples/library-preview");
  for (const filename of ["example.mjs", "example.ts", "tsconfig.json"]) {
    await copyFile(join(exampleDirectory, filename), join(consumerDirectory, filename));
  }

  const runtimeOutput = execFileSync(process.execPath, [join(consumerDirectory, "example.mjs")], {
    cwd: consumerDirectory,
    encoding: "utf8"
  });
  const runtimeResult = JSON.parse(runtimeOutput);
  assert(runtimeResult.receiptSchemaVersion === "0.1.0", "Packed runtime did not create Receipt v0.");
  assert(runtimeResult.focusRows > 0, "Packed runtime did not create a FOCUS projection.");
  assert(
    runtimeResult.focusApiEquivalentNotBilled === true,
    "Packed FOCUS projection upgraded API-equivalent value to BilledCost."
  );
  assert(
    runtimeResult.exampleAdapterValidationCoverage === "untested",
    "The caller-authored example adapter must not claim fixture or live verification."
  );
  assert(runtimeResult.openTelemetryRows > 0, "Packed runtime did not create an OpenTelemetry projection.");
  assert(runtimeResult.tokenomicsRows === 0, "Tokenomics must remain a not-published, zero-row projection.");
  assert(runtimeResult.terminalEvidenceLabels === true, "Packed renderer did not preserve local estimated-value labels.");
  assert(runtimeResult.renderedTerminalReceipt === true, "Packed report root export did not render.");

  const tscPath = resolve(root, "node_modules/typescript/bin/tsc");
  execFileSync(process.execPath, [tscPath, "--project", "tsconfig.json", "--noEmit"], {
    cwd: consumerDirectory,
    stdio: ["ignore", "pipe", "inherit"]
  });

  const forbiddenDeepImports = [
    "@agent-finops/core/dist/analyze.js",
    "@agent-finops/core/analyze",
    "@agent-finops/report/dist/terminal.js",
    "@agent-finops/report/terminal"
  ];
  for (const specifier of forbiddenDeepImports) {
    const attemptedImport = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(specifier)})`],
      { cwd: consumerDirectory, encoding: "utf8" }
    );
    assert(attemptedImport.status !== 0, `Unsupported deep import unexpectedly resolved: ${specifier}`);
    assert(
      attemptedImport.stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED"),
      `Unsupported deep import failed for the wrong reason: ${specifier}\n${attemptedImport.stderr}`
    );
  }

  await writeFile(
    join(consumerDirectory, "deep-import.ts"),
    [
      'import { analyzeSpend as distAnalyzeSpend } from "@agent-finops/core/dist/analyze.js";',
      'import { analyzeSpend as aliasAnalyzeSpend } from "@agent-finops/core/analyze";',
      'import { generatePlainEnglishSummary as distGenerateSummary } from "@agent-finops/report/dist/terminal.js";',
      'import { generatePlainEnglishSummary as aliasGenerateSummary } from "@agent-finops/report/terminal";',
      "void { distAnalyzeSpend, aliasAnalyzeSpend, distGenerateSummary, aliasGenerateSummary };",
      ""
    ].join("\n")
  );
  await writeFile(join(consumerDirectory, "tsconfig.deep-import.json"), `${JSON.stringify({
    extends: "./tsconfig.json",
    include: ["deep-import.ts"]
  }, null, 2)}\n`);
  const deepImportTypecheck = spawnSync(
    process.execPath,
    [tscPath, "--project", "tsconfig.deep-import.json", "--noEmit", "--pretty", "false"],
    { cwd: consumerDirectory, encoding: "utf8" }
  );
  const deepImportDiagnostics = `${deepImportTypecheck.stdout}${deepImportTypecheck.stderr}`;
  assert(deepImportTypecheck.status !== 0, "TypeScript unexpectedly resolved unsupported deep imports.");
  for (const specifier of [
    "@agent-finops/core/dist/analyze.js",
    "@agent-finops/core/analyze",
    "@agent-finops/report/dist/terminal.js",
    "@agent-finops/report/terminal"
  ]) {
    assert(
      deepImportDiagnostics.includes(specifier),
      `TypeScript did not report the unsupported deep import: ${specifier}`
    );
  }

  console.log(JSON.stringify({
    status: "pass",
    install: "packed @agent-finops/core + @agent-finops/report into an empty project",
    version: expectedVersion,
    javascriptRuntime: "pass",
    typescriptNoEmit: "pass",
    rootImports: "pass",
    rejectedRuntimeDeepImports: forbiddenDeepImports.length,
    rejectedTypeScriptDeepImports: 4
  }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function assertRootOnlyExportMap(manifest) {
  assert(manifest.exports && typeof manifest.exports === "object", `${manifest.name} has no export map.`);
  assert(
    JSON.stringify(Object.keys(manifest.exports)) === JSON.stringify(["."]),
    `${manifest.name} must expose only its root package entrypoint.`
  );
  assert(manifest.exports["."].types === manifest.types, `${manifest.name} root types drifted.`);
  assert(manifest.exports["."].import === manifest.main, `${manifest.name} root import drifted.`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

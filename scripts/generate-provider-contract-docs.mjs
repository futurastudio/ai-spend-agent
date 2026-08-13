#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import {
  generatedDocPath,
  generatedRuntimePath,
  readProviderContracts,
  renderProviderContractDoc,
  renderProviderContractRuntime,
  validateProviderContracts
} from "./provider-contract-lib.mjs";

const check = process.argv.includes("--check");
const contracts = await readProviderContracts();
const failures = validateProviderContracts(contracts);
if (failures.length > 0) throw new Error(`Invalid provider contracts:\n- ${failures.join("\n- ")}`);
const docOutput = renderProviderContractDoc(contracts);
const runtimeOutput = renderProviderContractRuntime(contracts);

if (check) {
  const currentDoc = await readFile(generatedDocPath, "utf8").catch(() => "");
  const currentRuntime = await readFile(generatedRuntimePath, "utf8").catch(() => "");
  if (currentDoc !== docOutput || currentRuntime !== runtimeOutput) {
    throw new Error("Generated provider contract outputs are stale; run npm run generate:provider-docs");
  }
  console.log("Provider contract documentation and runtime states are current.");
} else {
  await writeFile(generatedDocPath, docOutput, "utf8");
  await writeFile(generatedRuntimePath, runtimeOutput, "utf8");
  console.log("Generated provider contract documentation and runtime states.");
}

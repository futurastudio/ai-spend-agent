#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  inspectRemoteContracts,
  providerContractStateFailures,
  readProviderContracts,
  root,
  validateProviderContracts
} from "./provider-contract-lib.mjs";

const fetchRemote = process.argv.includes("--fetch");
const printHashes = process.argv.includes("--print-hashes");
const reportFlag = process.argv.indexOf("--report");
const reportPath = reportFlag >= 0 ? process.argv[reportFlag + 1] : undefined;
const contracts = await readProviderContracts();
const failures = [
  ...validateProviderContracts(contracts),
  ...providerContractStateFailures(contracts)
];

let observations = [];
if (fetchRemote) {
  observations = await inspectRemoteContracts(contracts);
  for (const observation of observations) {
    if (observation.state !== "current") {
      failures.push(`${observation.contractId} ${observation.kind}: ${observation.error ?? "semantic contract drift"}; missing markers: ${(observation.missingMarkers ?? []).join(", ") || "none"}`);
    }
  }
}

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  status: failures.length === 0 ? "current" : "stale_contract",
  contracts: contracts.contracts.map((contract) => ({
    id: contract.id,
    provider: contract.provider,
    declaredState: contract.state
  })),
  observations,
  failures
};

if (reportPath) {
  await writeFile(resolve(root, reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (printHashes) {
  console.log(JSON.stringify(observations.map(({ contractId, kind, url, semanticSha256, contentSha256, missingMarkers }) => ({
    contractId, kind, url, semanticSha256, contentSha256, missingMarkers
  })), null, 2));
} else {
  console.log(JSON.stringify(report, null, 2));
}
if (failures.length > 0) process.exitCode = 1;

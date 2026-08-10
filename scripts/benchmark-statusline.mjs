import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  readStatuslineCache,
  renderStatusline
} from "../packages/cli/dist/statuslineRuntime.js";

const cacheDirectory = await mkdtemp(join(tmpdir(), "aibill-statusline-benchmark-"));
await chmod(cacheDirectory, 0o700);
const now = new Date();
const timestamp = now.toISOString();
const snapshot = {
  kind: "aibill.activity_snapshot",
  schemaVersion: 1,
  currency: "USD",
  asOf: timestamp,
  generatedAt: timestamp,
  lastAttemptAt: timestamp,
  lastSuccessAt: timestamp,
  refresh: { status: "ok" },
  mode: "empty",
  subscription: null,
  metered: null,
  unresolved: null,
  overage: null,
  coverage: {
    agents: [],
    providers: [],
    recordsParsed: 0,
    recordsPriced: 0,
    recordsUnpriced: 0,
    validationStatus: "complete",
    pricingAsOf: timestamp.slice(0, 10),
    networkUploaded: false
  },
  networkUploaded: false
};
const cachePath = join(cacheDirectory, "statusline-v1.json");
await writeFile(cachePath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
await chmod(cachePath, 0o600);

const samples = [];
for (let index = 0; index < 250; index += 1) {
  const started = performance.now();
  const result = await readStatuslineCache({ cacheDirectory });
  const line = renderStatusline(result, { now, columns: 100, timeZone: "UTC" });
  const elapsed = performance.now() - started;
  if (line !== "aibill · no usage yet · updated 0s") {
    throw new Error(`Unexpected statusline benchmark output: ${line}`);
  }
  samples.push(elapsed);
}
samples.sort((left, right) => left - right);
const percentile = (fraction) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
const p95 = percentile(0.95);
const maximum = samples.at(-1);
if (maximum >= 250) {
  throw new Error(`Statusline cache render exceeded the 250ms hard limit (${maximum.toFixed(2)}ms).`);
}

const runnerPath = resolve("packages/cli/dist/statuslineRuntime.js");
const direct = spawnSync(process.execPath, [runnerPath], {
  encoding: "utf8",
  env: { ...process.env, AIBILL_CACHE_DIR: cacheDirectory, COLUMNS: "100", TZ: "UTC" },
  input: JSON.stringify({
    session_id: "must-not-echo",
    transcript_path: "/private/must-not-echo",
    rate_limits: { five_hour: { used_percentage: 99 } }
  }),
  timeout: 2_000
});
if (direct.status !== 0 || direct.stderr !== "" || direct.stdout.split("\n").filter(Boolean).length !== 1 ||
    direct.stdout.includes("must-not-echo") || direct.stdout.includes("99")) {
  throw new Error(`Compiled statusline runner smoke failed (status ${direct.status}): ${direct.stderr}`);
}

console.log(`statusline cache render: p95 ${p95.toFixed(2)}ms; max ${maximum.toFixed(2)}ms; target <150ms; hard <250ms`);
console.log("compiled statusline runner: one line, stderr empty, exit 0, hostile stdin ignored");

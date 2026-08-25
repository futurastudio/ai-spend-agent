import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 0.9.4 machine-wide mode, end-to-end on the real bin: report and
 * report-card RUN from a broad root (the receipt's own Next pointer led
 * from home into a friendly refusal that read as "the commands don't
 * work"). Pins per the design: exit 0, artifacts in the CURRENT directory,
 * machine-wide content, no scan of the cwd itself, and nothing written
 * outside cwd + ~/.aibill. Spawned with a sandbox HOME — never the
 * developer's real home.
 */

const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

type MachineWideRun = {
  home: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "machinewide-home-"));
  // Two projects of Claude Code evidence inside the sandbox home's default
  // transcript location — machine-wide scanning must find BOTH.
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  for (const [project, amount] of [["alpha-app", 3], ["beta-svc", 2]] as const) {
    const dir = join(home, ".claude", "projects", `-Users-testuser-${project}`);
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: amount }, (_, index) => JSON.stringify({
      type: "assistant",
      timestamp: day(2 + index),
      cwd: `/Users/testuser/${project}`,
      sessionId: `sess-${project}`,
      requestId: `req-${project}-${index}`,
      message: {
        id: `msg-${project}-${index}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: 40_000, output_tokens: 4_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 }
      }
    }));
    await writeFile(join(dir, `sess-${project}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }
  // A decoy file directly in the home directory: machine-wide mode reads
  // agent transcript dirs only — it must never scan the cwd itself.
  await writeFile(join(home, "private-notes.txt"), "decoy-marker-never-scanned\n", "utf8");
  return home;
}

async function runFromHome(home: string, argv: string[]): Promise<MachineWideRun> {
  expect(existsSync(cliEntry), `built CLI missing at ${cliEntry} — run npx tsc -b first`).toBe(true);
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    // Suppress ask/telemetry noise; machine-wide mode itself needs no TTY.
    CI: "1"
  };
  const child = spawn(process.execPath, [cliEntry, ...argv], {
    cwd: home,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  return { home, exitCode, stdout, stderr };
}

describe("report machine-wide mode (0.9.4)", () => {
  it(
    "report from home: exit 0, artifacts in cwd, machine-wide content, no cwd scan, no project state",
    { timeout: 120_000 },
    async () => {
      const home = await seedHome();
      const run = await runFromHome(home, ["report"]);
      expect(run.exitCode, run.stderr || run.stdout).toBe(0);
      expect(run.stdout).toContain("aibill report");
      // 0.9.5 aligned summary: the scope fact rides a "Scope" label row that
      // wraps at terminal width, so pin it whitespace-normalized.
      expect(run.stdout.replace(/\s+/gu, " ")).toContain("Scope machine-wide · all supported local agent evidence");
      expect(run.stdout).not.toContain("needs one exact project folder");
      expect(run.stdout).not.toContain("Refusing to scan");

      // Artifacts in the CURRENT directory, ai-spend-* family naming.
      const markdownPath = join(home, "ai-spend-report.md");
      const htmlPath = join(home, "ai-spend-report.html");
      expect(run.stdout).toContain(markdownPath);
      expect(run.stdout).toContain(htmlPath);
      const markdown = await readFile(markdownPath, "utf8");
      const html = await readFile(htmlPath, "utf8");
      // Machine-wide content: every project appears.
      for (const surface of [markdown, html]) {
        expect(surface).toContain("alpha-app");
        expect(surface).toContain("beta-svc");
        expect(surface).not.toContain("decoy-marker-never-scanned");
      }

      // No project state at the broad root; nothing outside cwd + ~/.aibill.
      expect(existsSync(join(home, ".ai-spend-agent"))).toBe(false);
      const entries = (await readdir(home)).sort();
      // ~/.aibill is aibill's own home state (index/cache) — the ONE
      // location besides the cwd artifacts the contract allows.
      expect(entries).toEqual([
        ".aibill",
        ".claude",
        "ai-spend-report.html",
        "ai-spend-report.md",
        "private-notes.txt"
      ]);
    }
  );

  it(
    "report-card from home: exit 0, SVG in cwd, machine-wide totals",
    { timeout: 120_000 },
    async () => {
      const home = await seedHome();
      const run = await runFromHome(home, ["report-card"]);
      expect(run.exitCode, run.stderr || run.stdout).toBe(0);
      expect(run.stdout).toContain("Your AI Receipt");
      expect(run.stdout).not.toContain("needs one exact project folder");
      expect(run.stdout).not.toContain("Couldn't write the report card");
      const svgPath = join(home, "ai-receipt.svg");
      expect(run.stdout).toContain(svgPath);
      const svg = await readFile(svgPath, "utf8");
      expect(svg).toContain("<svg");
      expect(svg).not.toContain("decoy-marker-never-scanned");
      expect(existsSync(join(home, ".ai-spend-agent"))).toBe(false);
    }
  );

  it(
    "report --sample from home: exit 0, labeled demo artifacts in cwd, no home state",
    { timeout: 120_000 },
    async () => {
      const home = await seedHome();
      const run = await runFromHome(home, ["report", "--sample"]);
      expect(run.exitCode, run.stderr || run.stdout).toBe(0);
      const markdown = await readFile(join(home, "ai-spend-report.md"), "utf8");
      expect(markdown).toContain("illustrative");
      expect(run.stdout).toContain("DEMO SAMPLE");
      expect(existsSync(join(home, ".ai-spend-agent"))).toBe(false);
    }
  );

  it(
    "a project folder keeps the exact pre-0.9.4 behavior (.ai-spend-agent/report.*)",
    { timeout: 120_000 },
    async () => {
      const home = await seedHome();
      const project = await mkdtemp(join(tmpdir(), "machinewide-project-"));
      const run = await runFromHome(home, ["report", "--path", project]);
      expect(run.exitCode).toBe(0);
      expect(run.stdout.replace(/\s+/gu, " ")).toContain(`Path ${project}`);
      expect(run.stdout).not.toContain("machine-wide");
      expect(existsSync(join(project, ".ai-spend-agent", "report.md"))).toBe(true);
      expect(existsSync(join(project, "ai-spend-report.md"))).toBe(false);
    }
  );
});

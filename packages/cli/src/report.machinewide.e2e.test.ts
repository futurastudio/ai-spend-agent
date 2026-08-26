import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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
  // realpath: macOS tmpdir lives behind the /var -> /private/var symlink and
  // the CLI prints resolved paths; label-glued pins need the exact prefix.
  const home = await realpath(await mkdtemp(join(tmpdir(), "machinewide-home-")));
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

/**
 * A richer machine-wide home: three projects with clearly different volumes,
 * so the ranked candidate set has a stable ORDER to compare, not just a
 * single entry.
 */
async function seedMultiProjectHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "machinewide-parity-home-")));
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  for (const [project, days] of [["gamma-lib", 4], ["alpha-app", 3], ["beta-svc", 2]] as const) {
    const dir = join(home, ".claude", "projects", `-Users-testuser-${project}`);
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: days }, (_, index) => JSON.stringify({
      type: "assistant",
      timestamp: day(2 + index),
      cwd: `/Users/testuser/${project}`,
      sessionId: `sess-${project}`,
      requestId: `req-${project}-${index}`,
      message: {
        id: `msg-${project}-${index}`,
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 40_000,
          output_tokens: 4_000,
          cache_read_input_tokens: 100_000,
          cache_creation_input_tokens: 10_000
        }
      }
    }));
    await writeFile(join(dir, `sess-${project}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }
  return home;
}

/** Ranked candidate titles as the `--full` terminal readout prints them. */
function terminalCandidateTitles(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^ {2}(\d+)\. (.+?) {2}\S/u.exec(line);
    return match ? [match[2]!.trim()] : [];
  });
}

/** Ranked candidate titles as the written Markdown report prints them. */
function reportCandidateTitles(markdown: string): string[] {
  return markdown.split("\n").flatMap((line) => {
    const match = /^- \*\*ACT-\d+\*\* (.+?) — /u.exec(line);
    return match ? [match[1]!.trim()] : [];
  });
}

/**
 * The internal-state vocabulary a degraded template used to fall back to.
 * None of it may reach a user on ANY machine-wide surface (0.9.6).
 */
const INTERNAL_JARGON = [
  "qualitative indexing is unknown",
  "qualitative indexing is partial",
  "qualitative indexing is",
  "Complete the bounded transcript index",
  "Complete the bounded index"
] as const;

/**
 * 0.9.6 founder-found regression, and the durable guard against its whole
 * class: `npx aibill --full` from HOME rendered real ranked recommendations
 * and real plan context, while `npx aibill report` from the SAME home wrote
 * an artifact whose ACT and VERIFY sections had degraded to "qualitative
 * indexing is unknown" with ZERO recommendations.
 *
 * Machine-wide mode is the DEFAULT path we advertise, so the two surfaces
 * disagreeing is a launch-blocking bug, not cosmetics. These tests pin the
 * property that makes it impossible to reship: for the same home, the
 * report's recommendation set EQUALS the readout's — same titles, same
 * order — and no machine-wide artifact speaks in internal jargon.
 */
describe("machine-wide report ⇄ --full parity (0.9.6)", () => {
  it(
    "report's ACT section carries the SAME ranked candidates, in the same order, as --full",
    { timeout: 180_000 },
    async () => {
      const home = await seedMultiProjectHome();
      const full = await runFromHome(home, ["--full"]);
      expect(full.exitCode, full.stderr || full.stdout).toBe(0);
      const report = await runFromHome(home, ["report"]);
      expect(report.exitCode, report.stderr || report.stdout).toBe(0);

      const markdown = await readFile(join(home, "ai-spend-report.md"), "utf8");
      const html = await readFile(join(home, "ai-spend-report.html"), "utf8");

      const terminalTitles = terminalCandidateTitles(full.stdout);
      const reportTitles = reportCandidateTitles(markdown);
      // The readout proves the analysis is computable from this evidence.
      expect(terminalTitles.length).toBeGreaterThan(0);
      // THE parity assertion: identical set, identical order.
      expect(reportTitles).toEqual(terminalTitles);
      // …and the HTML surface names the same top candidate.
      expect(html).toContain(terminalTitles[0]!);

      // The exact regression: a real recommendation, not a suppression note.
      expect(markdown).toContain("Investigate cumulative context in claude-code");
      expect(markdown).not.toContain("No action candidate is emitted");
      expect(markdown).not.toContain("No candidate is ranked yet");
    }
  );

  it(
    "no machine-wide artifact or stdout speaks in internal jargon",
    { timeout: 180_000 },
    async () => {
      const home = await seedMultiProjectHome();
      const surfaces: Array<[string, string]> = [];
      for (const argv of [["report"], ["report-card"], ["--full"], ["--group-by", "project"]]) {
        const run = await runFromHome(home, argv);
        expect(run.exitCode, run.stderr || run.stdout).toBe(0);
        surfaces.push([`${argv.join(" ")} stdout`, run.stdout], [`${argv.join(" ")} stderr`, run.stderr]);
      }
      for (const artifact of ["ai-spend-report.md", "ai-spend-report.html", "ai-receipt.svg", "ai-receipt.html"]) {
        surfaces.push([artifact, await readFile(join(home, artifact), "utf8")]);
      }
      for (const [label, text] of surfaces) {
        for (const phrase of INTERNAL_JARGON) {
          expect(text, `${label} must not contain "${phrase}"`).not.toContain(phrase);
        }
      }
    }
  );

  it(
    "the machine-wide VERIFY section names a real cohort and a real next step",
    { timeout: 180_000 },
    async () => {
      const home = await seedMultiProjectHome();
      const run = await runFromHome(home, ["report"]);
      expect(run.exitCode, run.stderr || run.stdout).toBe(0);
      const markdown = await readFile(join(home, "ai-spend-report.md"), "utf8");
      const verify = markdown.slice(
        markdown.indexOf("## Matched future verification"),
        markdown.indexOf("## Next")
      );
      expect(verify).toContain("Cohort for candidate ACT-001");
      expect(verify).toContain("Investigate cumulative context in claude-code");
      // A cohort is only real if it names the axes that make two sessions
      // comparable — and the project it starts from.
      expect(verify).toContain("the same agent, project, work type, source version, and quality bar");
      expect(verify).toMatch(/starting with (gamma-lib|alpha-app|beta-svc)/u);
      // Machine-wide legitimately cannot own a per-project approval lineage:
      // it must say so with a command, not with a suppression note.
      expect(verify).toContain("from one project folder");
      expect(verify).not.toContain("is not drafted");
    }
  );

  it(
    "the machine-wide receipt companion renders the card and leaks no project name",
    { timeout: 180_000 },
    async () => {
      const home = await seedMultiProjectHome();
      const run = await runFromHome(home, ["report-card"]);
      expect(run.exitCode, run.stderr || run.stdout).toBe(0);
      const svg = await readFile(join(home, "ai-receipt.svg"), "utf8");
      const companion = await readFile(join(home, "ai-receipt.html"), "utf8");
      // The companion IS the card plus its caption — nothing else.
      expect(companion).toContain(svg.trim());
      expect(companion).toContain("My AI receipt:");
      // Same redaction guarantee as the SVG it embeds: this home's real
      // project names appear in the report, and must never appear here.
      const report = await runFromHome(home, ["report"]);
      expect(report.exitCode).toBe(0);
      const reportMarkdown = await readFile(join(home, "ai-spend-report.md"), "utf8");
      for (const project of ["gamma-lib", "alpha-app", "beta-svc"]) {
        expect(reportMarkdown, `${project} should appear in the full report`).toContain(project);
        expect(companion, `${project} must never reach the shareable receipt`).not.toContain(project);
        expect(svg, `${project} must never reach the shareable receipt`).not.toContain(project);
      }
    }
  );

  it(
    "project mode keeps its canonical-candidate contract: no ranked ACT list, byte-identical output across runs",
    { timeout: 180_000 },
    async () => {
      // The ranked list is a MACHINE-WIDE affordance. A project report keeps
      // the pre-0.9.6 single-canonical-candidate contract exactly.
      const home = await seedMultiProjectHome();
      const project = await realpath(await mkdtemp(join(tmpdir(), "machinewide-project-pin-")));
      const first = await runFromHome(home, ["report", "--path", project]);
      expect(first.exitCode, first.stderr || first.stdout).toBe(0);
      const markdown = await readFile(join(project, ".ai-spend-agent", "report.md"), "utf8");
      expect(markdown).not.toMatch(/\*\*ACT-\d+\*\*/u);
      expect(markdown).not.toContain("Cohort for candidate ACT-001");
      expect(markdown).not.toContain("from one project folder");
      // The machine-wide artifacts never appear at a project root.
      expect(existsSync(join(project, "ai-spend-report.md"))).toBe(false);

      // Stable across runs apart from the generated-at stamp.
      const second = await runFromHome(home, ["report", "--path", project]);
      expect(second.exitCode).toBe(0);
      const again = await readFile(join(project, ".ai-spend-agent", "report.md"), "utf8");
      const stripStamp = (text: string) => text
        .replace(/^Generated: .*$/mu, "Generated: <stamp>")
        .replace(/^- Shared UTC window: .*$/gmu, "- Shared UTC window: <window>");
      expect(stripStamp(again)).toBe(stripStamp(markdown));
    }
  );
});

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
      // Label-glued (adversary finding): a bare path pin passes even when
      // the Markdown/HTML values are swapped.
      const flatStdout = run.stdout.replace(/\s+/gu, " ");
      expect(flatStdout).toContain(`Markdown ${markdownPath}`);
      expect(flatStdout).toContain(`HTML ${htmlPath}`);
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
      expect(run.stdout.replace(/\s+/gu, " ")).toContain(`Receipt ${svgPath}`);
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

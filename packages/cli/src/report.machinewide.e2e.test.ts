import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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
    // Pin the readout width (max clamp is 120). The per-project attribution
    // line wraps at the default width, and a guard that compares two surfaces
    // must not depend on how wide the runner's terminal happens to be.
    COLUMNS: "120",
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
async function seedMultiProjectHome(options: { unreadableTranscript?: boolean } = {}): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "machinewide-parity-home-")));
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  // Claude Code: four projects at clearly different volumes, so the grouped
  // candidate's per-project attribution has a stable ORDER to compare.
  for (const [project, days] of [
    ["gamma-lib", 5], ["alpha-app", 4], ["beta-svc", 3], ["delta-web", 2]
  ] as const) {
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
  // A SECOND agent. Ranked candidates collapse by kind+agent, so one agent can
  // only ever produce one grouped entry — which is why the ordering assertion
  // below used to compare a 1-element array against itself and a renderer that
  // mis-attributed dollars to the wrong project passed the whole suite.
  const codexDay = day(3);
  const codexDir = join(home, ".codex", "sessions", "2026", "08", "20");
  await mkdir(codexDir, { recursive: true });
  for (const [project, turns] of [["epsilon-api", 3], ["zeta-cli", 2]] as const) {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: `codex-${project}`, cwd: `/Users/testuser/${project}`, timestamp: codexDay }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      ...Array.from({ length: turns }, () => JSON.stringify({
        type: "event_msg",
        timestamp: codexDay,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 150_000, output_tokens: 12_000 },
            total_token_usage: { input_tokens: 150_000, output_tokens: 12_000 }
          }
        }
      }))
    ];
    await writeFile(join(codexDir, `rollout-${project}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }
  if (options.unreadableTranscript) {
    // THE degraded branch. Until 0.9.6 every fixture in this file yielded
    // COMPLETE coverage, so the partial-coverage rendering path — the one the
    // founder was actually looking at — never executed under test.
    await chmod(join(home, ".claude", "projects", "-Users-testuser-delta-web", "sess-delta-web.jsonl"), 0o000);
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
 * Per-project dollar attribution, in rendered order, from EITHER surface.
 *
 * Both print the same "across N projects — label ~$X · label ~$Y" line, so one
 * parser reads both. This is the property the parity test was named for and
 * never actually checked: a renderer mutation that attributed a project's
 * dollars to the WRONG project passed all 1,637 tests.
 */
function projectAttribution(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    // The readout writes "across 3 projects — a ~$2 · b ~$1"; the Markdown
    // artifact writes "Across 3 projects: a ~$2 · b ~$1."; the HTML wraps the
    // readout form in a <p>. Same facts, three renderings — normalize to the
    // payload so the comparison is about ATTRIBUTION, not punctuation.
    const match = /[Aa]cross \d+ projects(?:: | — )(.+?)(?:<\/p>|$)/u.exec(line);
    if (!match) return [];
    return [match[1]!.trim().replace(/\s+/gu, " ").replace(/\.$/u, "")];
  });
}

/**
 * The internal-state vocabulary a degraded template used to fall back to.
 * None of it may reach a user on ANY machine-wide surface (0.9.6).
 *
 * Matched CASE-INSENSITIVELY by {@link expectNoJargon}: the entries below are
 * lowercase, and the code emitted "Qualitative indexing is partial" with a
 * capital Q, so the previous case-sensitive sweep scored zero hits against a
 * genuinely degraded artifact.
 */
const INTERNAL_JARGON = [
  "qualitative index",
  "qualitative indexing is",
  "bounded transcript index",
  "bounded index",
  "non-executable."
] as const;

function expectNoJargon(label: string, text: string): void {
  const haystack = text.toLowerCase();
  for (const phrase of INTERNAL_JARGON) {
    expect(haystack, `${label} must not contain "${phrase}"`).not.toContain(phrase.toLowerCase());
  }
}

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
      // MORE THAN ONE, or "same order" is not a property at all: this
      // assertion compared a 1-element array against itself until 0.9.6.
      expect(terminalTitles.length).toBeGreaterThan(1);
      // THE parity assertion: identical set, identical order.
      expect(reportTitles).toEqual(terminalTitles);
      // …and the HTML surface names the same top candidate.
      expect(html).toContain(terminalTitles[0]!);

      // PER-PROJECT DOLLAR ATTRIBUTION, in rendered order, on both surfaces.
      // Titles alone cannot catch a renderer that pairs the right projects
      // with the wrong money.
      const terminalAttribution = projectAttribution(full.stdout);
      const reportAttribution = projectAttribution(markdown);
      expect(terminalAttribution.length).toBeGreaterThan(0);
      expect(reportAttribution).toEqual(terminalAttribution);
      // Largest observed share first — a real ordering over real amounts.
      const amounts = [...terminalAttribution[0]!.matchAll(/~\$([\d,]+)/gu)]
        .map((match) => Number(match[1]!.replaceAll(",", "")));
      expect(amounts.length).toBeGreaterThan(1);
      expect([...amounts].sort((left, right) => right - left)).toEqual(amounts);

      // The exact regression: a real recommendation, not a suppression note.
      expect(markdown).toContain("Investigate cumulative context in claude-code");
      expect(markdown).not.toContain("No action candidate is emitted");
      expect(markdown).not.toContain("No candidate is ranked yet");
    }
  );

  /**
   * BLOCKER ZERO (0.9.6). The founder's original screenshot, reproduced on the
   * advertised default path: same home, same minute, ONE unreadable transcript.
   *
   *   aibill --full  -> "1. Investigate cumulative context in claude-code"
   *   aibill report  -> "No candidate is ranked yet. 3 of 4 session transcripts…"
   *
   * The DATA was already unified; the decision to SHOW was still taken twice
   * and asymmetrically — the artifact gated ranked candidates on transcript
   * coverage, the readout rendered them with no gate. Those candidates come
   * from local FINANCIAL records, so transcript coverage was never the right
   * gate for them. It stays the right gate for the genuinely transcript-derived
   * sections, which is why this test also pins that BOTH surfaces disclose the
   * gap rather than one of them going quiet.
   */
  it(
    "one unreadable transcript changes NEITHER surface's candidate set, and both disclose the gap",
    { timeout: 180_000 },
    async () => {
      const home = await seedMultiProjectHome({ unreadableTranscript: true });
      const full = await runFromHome(home, ["--full"]);
      expect(full.exitCode, full.stderr || full.stdout).toBe(0);
      const report = await runFromHome(home, ["report"]);
      expect(report.exitCode, report.stderr || report.stdout).toBe(0);
      const markdown = await readFile(join(home, "ai-spend-report.md"), "utf8");

      // The fixture must genuinely trip the degraded branch, or this test is
      // just the happy path wearing a different name.
      expect(markdown).toContain("SESSION TRANSCRIPTS NOT FULLY READ");

      const terminalTitles = terminalCandidateTitles(full.stdout);
      const reportTitles = reportCandidateTitles(markdown);
      expect(terminalTitles.length).toBeGreaterThan(1);
      expect(reportTitles).toEqual(terminalTitles);
      expect(projectAttribution(markdown)).toEqual(projectAttribution(full.stdout));

      // Neither surface may go quiet about what it did not read.
      expect(full.stdout).toMatch(/\d+ of \d+ session transcripts read so far/u);
      expect(markdown).toMatch(/\d+ of \d+ session transcripts have been read so far/u);

      // And the artifact must not claim the candidates were withheld.
      expect(markdown).not.toContain("No candidate is ranked yet");
      expect(markdown).not.toContain("new action candidates are suppressed");
    }
  );

  it(
    "no machine-wide artifact or stdout speaks in internal jargon",
    { timeout: 180_000 },
    async () => {
      // BOTH coverage states. The degraded branch is the one that speaks in
      // internal state, and every fixture in this file used to yield COMPLETE
      // coverage — so this sweep could not reach the code it exists to guard.
      for (const unreadableTranscript of [false, true]) {
        const home = await seedMultiProjectHome({ unreadableTranscript });
        const state = unreadableTranscript ? "partial" : "complete";
        const surfaces: Array<[string, string]> = [];
        for (const argv of [["report"], ["report-card"], ["--full"], ["--group-by", "project"]]) {
          const run = await runFromHome(home, argv);
          expect(run.exitCode, run.stderr || run.stdout).toBe(0);
          surfaces.push(
            [`${state} · ${argv.join(" ")} stdout`, run.stdout],
            [`${state} · ${argv.join(" ")} stderr`, run.stderr]
          );
        }
        for (const artifact of [
          "ai-spend-report.md", "ai-spend-report.html", "ai-receipt.svg", "ai-receipt.html"
        ]) {
          surfaces.push([`${state} · ${artifact}`, await readFile(join(home, artifact), "utf8")]);
        }
        if (unreadableTranscript) {
          // Proof the degraded path actually ran on this pass.
          const markdown = surfaces.find(([label]) => label.endsWith("ai-spend-report.md"))![1];
          expect(markdown).toContain("SESSION TRANSCRIPTS NOT FULLY READ");
        }
        for (const [label, text] of surfaces) {
          expectNoJargon(label, text);
          // A markdown-voiced command must never reach an HTML surface with
          // its grave accents intact (B1).
          if (label.endsWith(".html")) {
            expect(text, `${label} renders a literal backtick`).not.toContain("`");
          }
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
      expect(verify).toMatch(/starting with (gamma-lib|alpha-app|beta-svc|delta-web)/u);
      // Machine-wide legitimately cannot own a per-project approval lineage:
      // it must say so with a command, not with a suppression note.
      // A machine-wide report legitimately cannot own a per-project approval
      // lineage. It must say so with a command that WORKS when pasted — the
      // placeholder is a path, because `<project>` is shell redirection.
      expect(verify).toContain("cd /path/to/project && npx aibill apply");
      expect(verify).not.toContain("cd <project>");
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

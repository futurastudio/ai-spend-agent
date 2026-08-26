import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE PRINTED-POINTER CLASS (0.9.6).
 *
 * The founder's most-repeated complaint, three times over: a surface running
 * machine-wide prints a bare project-scoped command, the user copies it, and it
 * friendly-refuses in the very directory that printed it. 0.9.4 fixed `report`.
 * 0.9.6 fixed `index`. Both were fixed one string at a time, so the class kept
 * coming back through whichever surface nobody had checked — `--sample` still
 * printed a bare `npx aibill init`, the report's own HTML footer still printed a
 * bare `npx aibill apply`, `index` still ended on a bare `npx aibill improve`,
 * and `statusline expand` pointed at a `statusline refresh` that answered with
 * the CRASH wrapper ("aibill hit an unexpected error… run diagnostics").
 *
 * This test does not pin those four strings. It HARVESTS every command the CLI
 * prints as a next step, from every surface, in a broad root and in a project
 * directory, and executes each one from the directory it was printed in. A new
 * surface that prints a new bad pointer fails here without anyone remembering
 * to add a case for it.
 *
 * The contract: every printed command either exits 0 as printed, or carries its
 * own `cd /path/to/project && …` (a PATH placeholder — `<project>` is shell
 * redirection and is separately forbidden below).
 */

const cliEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Structural positions in which this CLI prints a command. */
const NEXT_COMMAND_HEADER = /^NEXT COMMAND\s*·/u;
const CHEVRON_STEP = /^\s*›\s+(.+)$/u;
const NEXT_BLOCK_HEADER = /^Next$/u;
const INDENTED_COMMAND =/^\s{2,}((?:cd \S+ && )?npx (?:aibill|ai-spend-agent)\b.*)$/u;
const MARKDOWN_COMMAND = /`((?:cd [^`&]+ && )?npx (?:aibill|ai-spend-agent)[^`]*)`/gu;
const HTML_CODE_COMMAND = /<code>((?:cd [^<&]+ &amp;&amp; )?npx (?:aibill|ai-spend-agent)[^<]*)<\/code>/gu;
const HTML_FOOTER_COMMAND = /<span class="g-accent">\$<\/span>\s*([^<]*npx (?:aibill|ai-spend-agent)[^<]*)/gu;

/** Anything that is actually a runnable pointer rather than prose. */
const COMMAND_SHAPE = /^(?:cd \S[^&]*? && )?(?:npx (?:aibill|ai-spend-agent)\b|open |less )/u;

/**
 * Deliberately not executed. Each entry states WHY — an unexplained skip list
 * is how a class like this hides.
 */
function skipReason(command: string): string | undefined {
  if (/<[^>]+>|\[--/u.test(command)) return "documented template with placeholders, not a copy-and-run pointer";
  if (/\bsignup\b/u.test(command)) return "would contact the production waitlist endpoint";
  if (/\bwatch\b/u.test(command)) return "long-running interval loop by design";
  if (/\b(?:connect|sync-provider)\b/u.test(command)) return "requires an admin credential reference";
  return undefined;
}

type Harvested = { command: string; printedBy: string; position: string };

function harvest(text: string, printedBy: string): Harvested[] {
  const found = new Map<string, Harvested>();
  const add = (raw: string, position: string) => {
    const command = raw.trim().replace(/\s+/gu, " ").replace(/[.,;]$/u, "");
    if (command.length === 0 || !COMMAND_SHAPE.test(command)) return;
    if (!found.has(command)) found.set(command, { command, printedBy, position });
  };
  const lines = text.split("\n");
  // The bare-indented rule is scoped to a "Next" block on purpose. Applied to
  // the whole document it also swallowed (a) wrapped parenthetical PROSE —
  // "…(long form:⏎ npx aibill apply-artifact)" harvested as the command
  // `npx aibill apply-artifact)` — and (b) the `--help` catalogue, which
  // documents each subcommand beside its REQUIRED flags and is a reference,
  // not a next-step pointer. Neither is a command the user is being told to
  // run now, and counting them as failures would only have trained the next
  // reader to ignore this test.
  let inNextBlock = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\[[0-9;]*m/gu, "");
    if (NEXT_COMMAND_HEADER.test(line.trim())) {
      add((lines[index + 1] ?? "").replace(/\[[0-9;]*m/gu, ""), "NEXT COMMAND");
      continue;
    }
    if (NEXT_BLOCK_HEADER.test(line.trim())) { inNextBlock = true; continue; }
    // A blank line or a horizontal rule closes the block.
    if (line.trim().length === 0 || /^[\s─-]+$/u.test(line)) { inNextBlock = false; continue; }
    const chevron = CHEVRON_STEP.exec(line);
    if (chevron) { add(chevron[1]!.split(/\s{2,}/u)[0]!, "next-step ›"); continue; }
    if (!inNextBlock) continue;
    const indented = INDENTED_COMMAND.exec(line);
    if (indented) add(indented[1]!.split(/\s{2,}/u)[0]!, "Next block");
  }
  for (const match of text.matchAll(MARKDOWN_COMMAND)) add(match[1]!, "markdown");
  for (const match of text.matchAll(HTML_CODE_COMMAND)) add(match[1]!.replaceAll("&amp;", "&"), "html <code>");
  for (const match of text.matchAll(HTML_FOOTER_COMMAND)) add(match[1]!, "html footer");
  return [...found.values()];
}

async function seedHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "printed-pointers-")));
  const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString();
  for (const [project, days] of [["gamma-lib", 4], ["alpha-app", 3], ["beta-svc", 2]] as const) {
    const dir = join(home, ".claude", "projects", `-Users-testuser-${project}`);
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: days }, (_, index) => JSON.stringify({
      type: "assistant", timestamp: day(2 + index), cwd: `/Users/testuser/${project}`,
      sessionId: `sess-${project}`, requestId: `req-${project}-${index}`,
      message: { id: `msg-${project}-${index}`, model: "claude-opus-4-8", usage: {
        input_tokens: 40_000, output_tokens: 4_000,
        cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000
      } }
    }));
    await writeFile(join(dir, `sess-${project}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }
  return home;
}

async function runCli(
  commandString: string,
  cwd: string,
  home: string,
  timeoutMs = 90_000
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const args = commandString.replace(/^npx\s+(?:aibill|ai-spend-agent)\s*/u, "").trim();
  const argv = args.length > 0 ? args.split(/\s+/u) : [];
  const child = spawn(process.execPath, [cliEntry, ...argv], {
    cwd,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CI: "1",
      COLUMNS: "120", DO_NOT_TRACK: "1", AI_SPEND_NO_TELEMETRY: "1", AI_SPEND_NO_OPEN: "1"
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
  });
  return { exitCode, stdout, stderr };
}

async function artifactsIn(dir: string, depth = 0): Promise<string[]> {
  if (depth > 2 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isDirectory()) {
      if (name === ".ai-spend-agent") out.push(...await artifactsIn(path, depth + 1));
      continue;
    }
    if (/\.(?:md|html)$/u.test(name)) out.push(path);
  }
  return out;
}

/** Every surface that can print a next step. */
const SURFACES: string[][] = [
  [], ["--full"], ["--sample"], ["--group-by", "project"],
  ["report"], ["report-card"], ["apply"], ["apply-artifact"], ["index"],
  ["doctor"], ["doctor", "--sources"], ["glance"], ["context"], ["telemetry"],
  ["statusline"], ["statusline", "expand"], ["accountability"], ["improve"],
  ["scan"], ["init"], ["quickstart"], ["verify"], ["identify"], ["outcome"],
  ["reset"], ["nonsense-subcommand"]
];

describe("every printed command runs where it was printed (0.9.6)", () => {
  for (const scope of ["broad root (HOME)", "project directory"] as const) {
    it(`${scope}: no surface prints a pointer that refuses in its own directory`, { timeout: 600_000 }, async () => {
      const home = await seedHome();
      const cwd = scope === "broad root (HOME)" ? home : join(home, "work", "my-app");
      if (scope === "project directory") {
        await mkdir(cwd, { recursive: true });
        await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "my-app", version: "1.0.0" }), "utf8");
      }

      const pointers = new Map<string, Harvested>();
      for (const argv of SURFACES) {
        const label = `aibill ${argv.join(" ")}`.trim();
        const run = await runCli(`npx aibill ${argv.join(" ")}`, cwd, home);
        let text = `${run.stdout}\n${run.stderr}`;
        for (const path of await artifactsIn(cwd)) text += `\n${await readFile(path, "utf8")}`;
        for (const entry of harvest(text, label)) {
          if (!pointers.has(entry.command)) pointers.set(entry.command, entry);
        }
      }

      // The harvest itself must find something, or this test proves nothing —
      // the same "scanned an empty set" hole that kept the launch canary green.
      expect(pointers.size, "no printed pointers were harvested at all").toBeGreaterThan(5);

      const failures: string[] = [];
      for (const { command, printedBy, position } of pointers.values()) {
        // `<project>` is shell redirection: pasted verbatim it is a syntax
        // error, so no printed pointer may use it as a placeholder.
        if (command.includes("<project>")) {
          failures.push(`${command}  [${printedBy} · ${position}] uses <project>, which the shell reads as redirection`);
          continue;
        }
        if (skipReason(command) !== undefined) continue;

        const filePointer = /^(?:open|less) (?:'([^']*)'|"([^"]*)"|(\S+))$/u.exec(command);
        if (filePointer) {
          const path = filePointer[1] ?? filePointer[2] ?? filePointer[3]!;
          const resolved = path.startsWith("/") ? path : join(cwd, path);
          if (!existsSync(resolved)) {
            failures.push(`${command}  [${printedBy} · ${position}] names a file that does not exist`);
          }
          continue;
        }

        const selfCarrying = /^cd (\S[^&]*?) && (.+)$/u.exec(command);
        if (selfCarrying) {
          // Printed with its own cd: the tail must work in a real project.
          const project = join(home, "carry-target");
          await mkdir(project, { recursive: true });
          await writeFile(join(project, "package.json"), JSON.stringify({ name: "carry", version: "1.0.0" }), "utf8");
          const run = await runCli(selfCarrying[2]!, project, home);
          if (run.exitCode !== 0) {
            failures.push(`${command}  [${printedBy} · ${position}] self-carrying cd, but the tail exits ${run.exitCode} in a project dir`);
          }
          continue;
        }

        const run = await runCli(command, cwd, home);
        if (run.exitCode !== 0) {
          const first = (run.stderr || run.stdout).split("\n").filter(Boolean)[0] ?? "";
          failures.push(`${command}  [${printedBy} · ${position}] exits ${run.exitCode} from the directory that printed it :: ${first}`);
        }
      }

      expect(failures, `printed commands that do not work as printed:\n  ${failures.join("\n  ")}`).toEqual([]);
    });
  }

  /**
   * A deliberate safety refusal must sound like one. `statusline refresh` let
   * its scan-root check throw, and the crash wrapper rendered the tool's own
   * safety boundary as "aibill hit an unexpected error… run diagnostics before
   * retrying" — telling the user to debug a working guard.
   */
  it("a broad-root refusal never speaks in the crash-wrapper voice", { timeout: 300_000 }, async () => {
    const home = await seedHome();
    for (const argv of ["statusline refresh", "improve", "apply", "init"]) {
      const run = await runCli(`npx aibill ${argv}`, home, home);
      const text = `${run.stdout}\n${run.stderr}`;
      expect(text, `${argv} from a broad root`).not.toContain("unexpected error");
      expect(text, `${argv} from a broad root`).not.toContain("Refusing to scan");
      expect(text, `${argv} from a broad root`).not.toContain("open an issue");
      expect(text.toLowerCase(), `${argv} should explain the scope`).toContain("project");
    }
  });
});

/**
 * Adversary tests for the agent-native improve loop's CLI leg
 * (AGENT_NATIVE_LOOP_DESIGN.md §6): per-field provenance truth (QA 17/17b),
 * the canary claim guard (QA 18), binding and phase set-asides (QA 7-10, 22),
 * control/credential smuggling (QA 5-6), non-TTY read-only behavior (QA 13),
 * token non-persistence (QA 23), and the A1 userSafetyLine byte-identity
 * (QA 25, CLI leg).
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeAgentDraftTokenV1,
  IMPROVE_USER_SAFETY_LINE_V1
} from "@agent-finops/core";
import { runCli } from "./index.js";
import { projectAccountabilityStatePath } from "./projectAccountabilityState.js";

const sharedTestTrustDirectory = join(
  tmpdir(),
  `aibill-vitest-state-trust-${process.pid}`
);
process.env.AI_SPEND_STATE_TRUST_DIR = sharedTestTrustDirectory;

beforeEach(async () => {
  await mkdir(sharedTestTrustDirectory, { recursive: true });
  process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-draft-claude-"));
  process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-draft-codex-"));
  process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-draft-home-"));
  process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-draft-codex-home-"));
  process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
  process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
  process.env.AI_SPEND_GEMINI_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-draft-gemini-"));
  process.env.AIBILL_CACHE_DIR = await mkdtemp(join(tmpdir(), "aibill-draft-cache-"));
});

afterEach(() => {
  delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
  delete process.env.AI_SPEND_CODEX_LOGS_DIR;
  delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
  delete process.env.AI_SPEND_CODEX_HOME_DIR;
  delete process.env.AI_SPEND_CLAUDE_CONFIG;
  delete process.env.AI_SPEND_CODEX_AUTH;
  delete process.env.AI_SPEND_GEMINI_LOGS_DIR;
  delete process.env.AIBILL_CACHE_DIR;
});

async function writeClaudeActionSession(
  label: string,
  timestamp: Date,
  inputTokens: number,
  outputTokens: number,
  workingDirectory: string
): Promise<void> {
  const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
  const projectDir = join(logsDir, workingDirectory.replaceAll("/", "-"));
  await mkdir(projectDir, { recursive: true });
  const iso = timestamp.toISOString();
  await writeFile(join(projectDir, `${label}.jsonl`), [
    JSON.stringify({
      type: "user",
      timestamp: iso,
      cwd: workingDirectory,
      sessionId: label,
      version: "2.1.170",
      message: { content: "Build and test the token experiment feature" }
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: iso,
      cwd: workingDirectory,
      sessionId: label,
      version: "2.1.170",
      requestId: `request-${label}`,
      message: {
        id: `message-${label}`,
        model: "claude-opus-4-8",
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0
          }
        }
      }
    }),
    JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      timestamp: new Date(timestamp.getTime() + 1).toISOString(),
      sessionId: label,
      version: "2.1.170",
      durationMs: 1
    })
  ].join("\n"), "utf8");
}

async function seedWasteFinding(projectRoot: string): Promise<void> {
  const baselineTimes = [72, 48, 24].map((hours) =>
    new Date(Date.now() - hours * 60 * 60 * 1_000)
  );
  for (const [index, timestamp] of baselineTimes.entries()) {
    await writeClaudeActionSession(
      `draft-baseline-${index}`, timestamp, 100 + index * 10, 10, projectRoot
    );
  }
  await writeClaudeActionSession(
    "draft-high", new Date(Date.now() - 2 * 60 * 1_000), 500, 20, projectRoot
  );
}

type InteractiveRun = {
  result: { exitCode: number; stdout: string; stderr: string };
  questions: string[];
};

async function runImproveInteractive(
  argv: string[],
  responses: string[]
): Promise<InteractiveRun> {
  const questions: string[] = [];
  const script = [...responses];
  const result = await runCli(argv, {
    interactive: true,
    prompt: async (question: string) => {
      questions.push(question);
      return script.shift() ?? "cancel";
    }
  });
  return { result, questions };
}

async function readExperiment(dir: string): Promise<{ id: string; revisionId: string }> {
  const statePath = join(dir, ".ai-spend-agent", "token-reduction-experiments.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  return {
    id: state.experiments[0].id as string,
    revisionId: state.experiments[0].revisionId as string
  };
}

/** Every file under .ai-spend-agent, concatenated, for non-persistence scans. */
async function allStateText(dir: string): Promise<string> {
  const stateDir = join(dir, ".ai-spend-agent");
  let combined = "";
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else combined += `\n=== ${full} ===\n${await readFile(full, "utf8")}`;
    }
  };
  await walk(stateDir);
  return combined;
}

const hostileRollback = '"; rm -rf ~ #';
const agentChange =
  "Start the next task with only its required files and instructions.";
const agentCanary =
  "The project tests pass and the requested output is accepted.";

describe("improve --draft (agent-native loop, CLI leg)", () => {
  it("labels provenance per field, decays it on acceptance, guards the canary, and never persists the token (QA 17/17b/18/22/23/25)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-agent-draft-main-"));
    const projectRoot = await realpath(dir);
    await seedWasteFinding(projectRoot);

    // Freeze the baseline, then stop before the plan.
    const frozen = await runImproveInteractive(
      ["improve", "--path", dir], ["y", "y", "cancel"]
    );
    expect(frozen.result.exitCode).toBe(0);
    expect(frozen.result.stdout).toContain("plan not finished");
    const { id: experimentId, revisionId } = await readExperiment(dir);

    // Agent-drafted token: valid change + canary, hostile rollback.
    const encoded = encodeAgentDraftTokenV1({
      experimentId,
      revisionId,
      change: agentChange,
      rollback: hostileRollback,
      canary: agentCanary
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const token = encoded.token;

    // Mixed-provenance sitting: Enter-accept the agent change, go back
    // (Current answer), keep it, Enter-accept the aibill rollback fallback
    // and the agent canary, then cancel to inspect the draft file (17b).
    const mixed = await runImproveInteractive(
      ["improve", "--draft", token, "--path", dir],
      ["", "back", "", "", "", "cancel"]
    );
    expect(mixed.result.exitCode).toBe(0);
    const mixedScreens = mixed.questions.join("\n<<<SCREEN>>>\n");

    // A1 banner with the byte-identical userSafetyLine (QA 25, CLI leg).
    expect(mixedScreens).toContain("Your agent helped draft this plan.");
    expect(mixedScreens).toContain(IMPROVE_USER_SAFETY_LINE_V1);

    // A3 for the hostile rollback names the label switch; the hostile text
    // itself is screened by the shared classifier (shell reject).
    expect(mixedScreens).toContain("Your agent's rollback draft was set aside:");
    expect(mixedScreens).toContain(
      "aibill's own suggestion is shown for that step instead, labeled Suggested."
    );

    // Per-field labels (QA 17): agent label ONLY over agent words; the
    // rollback fallback renders aibill's own label over aibill's own words.
    expect(mixedScreens).toContain(`Drafted with your agent: "${agentChange}"`);
    expect(mixedScreens).toContain(
      'Suggested: "Restore the prior session workflow."'
    );
    expect(mixedScreens).not.toContain(
      'Drafted with your agent: "Restore the prior session workflow."'
    );
    expect(mixedScreens).toContain(`Drafted with your agent: "${agentCanary}"`);

    // 17b: after Enter-accepting, `back` shows the USER'S answer label.
    expect(mixedScreens).toContain(`Current answer: "${agentChange}"`);

    // 17b: the saved draft stores plain text, no provenance vocabulary.
    const draftFile = await readFile(
      join(dirname(await projectAccountabilityStatePath(dir)), "improve-draft.json"),
      "utf8"
    );
    expect(JSON.parse(draftFile).answers.change).toBe(agentChange);
    expect(draftFile).not.toContain("provenance");
    expect(draftFile).not.toContain("Drafted with your agent");
    expect(draftFile).not.toContain(token);
    expect(draftFile).not.toContain(hostileRollback);

    // Approve the full plan. Record flags in the plan phase get the A7
    // notice and are ignored (QA 22: exactly one flag family honored).
    const approved = await runImproveInteractive(
      ["improve", "--draft", token, "--record-canary", "passed", "--path", dir],
      ["n", "", "", "", "Jose Artigas", "Platform", "Founder", "", "", "APPROVE"]
    );
    expect(approved.result.exitCode).toBe(0);
    expect(approved.result.stdout).toContain("Approved · token test tre_v0_");
    expect(approved.questions.join("\n")).toContain(
      "No plan is approved yet, so --record-applied-at/--record-canary were not"
    );

    // QA 23: the raw token and the rejected hostile sentence appear in no
    // state file and in no stdout beyond the A3/A4 notices.
    const persisted = await allStateText(dir);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(hostileRollback);
    expect(persisted).not.toContain("rm -rf");
    expect(approved.result.stdout).not.toContain(token);

    // QA 11: a before-approval applied-at flag is set aside with the exact
    // time reason and the question shows NO prefill.
    const beforeApproval = await runImproveInteractive(
      ["improve", "--record-applied-at", "2020-01-01T00:00Z", "--path", dir],
      ["cancel"]
    );
    expect(beforeApproval.result.exitCode).toBe(0);
    const beforeScreens = beforeApproval.questions.join("\n");
    expect(beforeScreens).toContain("Your agent's applied-at time was set aside:");
    expect(beforeScreens).toContain("is not after the approval at");
    expect(beforeScreens).not.toContain("Drafted with your agent:");

    // Record leg (QA 18 + A5 + A6): --draft is set aside after approval;
    // the applied-at prefill Enter-accepts; the canary claim line renders
    // but Enter REPROMPTS and the typed f wins over the passed claim.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_100));
    const appliedAtFlag = new Date(Math.ceil(Date.now() / 1_000) * 1_000)
      .toISOString().replace(".000Z", "Z");
    const recorded = await runImproveInteractive(
      [
        "improve",
        "--draft", token,
        "--record-applied-at", appliedAtFlag,
        "--record-canary", "passed",
        "--path", dir
      ],
      ["", "", "f"]
    );
    expect(recorded.result.exitCode).toBe(0);
    const recordScreens = recorded.questions.join("\n<<<SCREEN>>>\n");
    expect(recordScreens).toContain(
      "A plan is already approved and waiting for its result, so the draft was"
    );
    expect(recordScreens).toContain(`Drafted with your agent: "${appliedAtFlag}"`);
    expect(recordScreens).toContain(
      "Your agent reports: canary passed — not yet recorded; your"
    );
    expect(recordScreens).toContain("answer below is what counts.");
    // The canary question itself carries no prefill label and no
    // Enter-accept: the empty answer reprompted before "f" was accepted.
    const canaryScreen = recorded.questions.find((question) =>
      question.includes("Did the approved canary pass?")
    );
    expect(canaryScreen).toBeDefined();
    expect(canaryScreen).not.toContain('Drafted with your agent: "passed"');
    expect(recorded.questions.length).toBeGreaterThan(2);
    expect(recorded.result.stdout).toContain("canary: failed (user-declared)");
    expect(recorded.result.stdout).not.toContain("canary: passed");

    // The recorded state carries the typed answer, never the claim.
    const finalState = JSON.parse(await readFile(
      join(dir, ".ai-spend-agent", "token-reduction-experiments.json"), "utf8"
    ));
    expect(finalState.experiments[0].intervention.canary.status).toBe("failed");
  });

  it("sets aside unbound, stale, smuggled, and credential drafts without ending the run (QA 5-8, 10, 13)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-agent-draft-edge-"));
    const projectRoot = await realpath(dir);
    await seedWasteFinding(projectRoot);

    const foreignToken = encodeAgentDraftTokenV1({
      experimentId: `tre_v0_${"c".repeat(64)}`,
      revisionId: "r1",
      change: agentChange,
      rollback: "Restore the prior session workflow.",
      canary: agentCanary
    });
    expect(foreignToken.ok).toBe(true);
    if (!foreignToken.ok) return;

    // QA 10: --draft in phase start — the draft cannot bind; after the
    // freeze the plan shows aibill's Suggested label, not the agent label.
    const started = await runImproveInteractive(
      ["improve", "--draft", foreignToken.token, "--path", dir],
      ["y", "y", "cancel"]
    );
    expect(started.result.exitCode).toBe(0);
    const startScreens = started.questions.join("\n");
    expect(startScreens).toContain(
      "There is no frozen baseline yet, so a drafted plan cannot attach to a test."
    );
    expect(startScreens).toContain("Suggested: \"");
    expect(startScreens).not.toContain("Drafted with your agent:");

    // QA 7: same foreign token now that a real test exists — the id simply
    // does not match this project's test.
    const foreign = await runImproveInteractive(
      ["improve", "--draft", foreignToken.token, "--path", dir],
      ["cancel"]
    );
    const foreignScreens = foreign.questions.join("\n");
    expect(foreignScreens).toContain(
      "Your agent's draft was made for a different test or an older revision of"
    );
    expect(foreignScreens).not.toContain("Drafted with your agent:");

    // QA 8: right experiment, stale revision.
    const { id: experimentId, revisionId } = await readExperiment(dir);
    const stale = encodeAgentDraftTokenV1({
      experimentId,
      revisionId: `${revisionId}-stale`,
      change: agentChange,
      rollback: "Restore the prior session workflow.",
      canary: agentCanary
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    const staleRun = await runImproveInteractive(
      ["improve", "--draft", stale.token, "--path", dir], ["cancel"]
    );
    expect(staleRun.questions.join("\n")).toContain(
      "Your agent's draft was made for a different test or an older revision of"
    );

    // QA 5: bidi/format smuggling in a decodable token → the shared
    // classifier's control reject sets the field aside; the review screen
    // never displays the spoofed text.
    const bidi = `Start the next task${String.fromCharCode(0x202e)} with fewer files.`;
    const bidiToken = encodeAgentDraftTokenV1({
      experimentId, revisionId,
      change: bidi,
      rollback: "Restore the prior session workflow.",
      canary: agentCanary
    });
    expect(bidiToken.ok).toBe(true);
    if (!bidiToken.ok) return;
    const bidiRun = await runImproveInteractive(
      ["improve", "--draft", bidiToken.token, "--path", dir], ["cancel"]
    );
    const bidiScreens = bidiRun.questions.join("\n");
    expect(bidiScreens).toContain("Your agent's change draft was set aside:");
    expect(bidiScreens).toContain("hidden control characters");
    expect(bidiScreens).not.toContain(bidi);

    // Raw C0 controls cannot even encode/decode: the codec refuses them.
    const rawControlToken = `ab1.${Buffer.from(JSON.stringify({
      v: 1, experimentId, revisionId,
      change: `line one${String.fromCharCode(0x1b)}[31m red`,
      rollback: "Restore the prior session workflow.",
      canary: agentCanary
    }), "utf8").toString("base64url")}`;
    const ansiRun = await runImproveInteractive(
      ["improve", "--draft", rawControlToken, "--path", dir], ["cancel"]
    );
    expect(ansiRun.questions.join("\n")).toContain(
      "Your agent's draft could not be read (not a valid ab1 draft token)."
    );

    // QA 6: a credential-shaped draft never reaches any output or file.
    const keyBlock = "-----BEGIN RSA PRIVATE KEY-----";
    const credentialToken = encodeAgentDraftTokenV1({
      experimentId, revisionId,
      change: agentChange,
      rollback: "Restore the prior session workflow.",
      canary: `${keyBlock} decides the canary`
    });
    expect(credentialToken.ok).toBe(true);
    if (!credentialToken.ok) return;
    const credentialRun = await runImproveInteractive(
      ["improve", "--draft", credentialToken.token, "--path", dir], ["cancel"]
    );
    const credentialScreens = credentialRun.questions.join("\n");
    expect(credentialScreens).toContain("Your agent's canary draft was set aside:");
    expect(credentialScreens).toContain("aibill never stores credentials");
    expect(credentialScreens).not.toContain(keyBlock);
    expect(credentialRun.result.stdout).not.toContain(keyBlock);
    expect(await allStateText(dir)).not.toContain(keyBlock);

    // QA 13: non-TTY with the flags — read-only render + A8; no approval
    // or record path exists outside an interactive terminal.
    const nonTty = await runCli([
      "improve", "--draft", foreignToken.token,
      "--record-canary", "passed", "--path", dir
    ]);
    expect(nonTty.exitCode).toBe(0);
    expect(nonTty.stdout).toContain(
      "Agent drafts and record values only pre-fill the interactive flow; nothing"
    );
    expect(nonTty.stdout).toContain("was recorded. Run this command in an interactive terminal.");

    // A10: the verify flags do not belong to improve.
    const confused = await runImproveInteractive(
      ["improve", "--applied-at", "2026-01-01T00:00:00Z", "--path", dir],
      ["cancel"]
    );
    expect(confused.questions.join("\n")).toContain(
      "Note: --applied-at/--canary belong to the advanced verify commands."
    );
  });

  it("practices screening in the demo without binding checks or writes (A9)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-agent-draft-demo-"));
    const demoToken = encodeAgentDraftTokenV1({
      experimentId: `tre_v0_${"d".repeat(64)}`,
      revisionId: "any",
      change: agentChange,
      rollback: hostileRollback,
      canary: agentCanary
    });
    expect(demoToken.ok).toBe(true);
    if (!demoToken.ok) return;
    const demo = await runImproveInteractive(
      ["improve", "--sample", "--draft", demoToken.token, "--path", dir],
      ["y", "y", "", "", "", "Demo Owner", "Demo Team", "Founder", "", "", "APPROVE"]
    );
    expect(demo.result.exitCode).toBe(0);
    const demoScreens = demo.questions.join("\n");
    expect(demoScreens).toContain(
      "DEMO: your agent's draft is used for practice only."
    );
    expect(demoScreens).toContain(`Drafted with your agent: "${agentChange}"`);
    expect(demoScreens).toContain("Your agent's rollback draft was set aside:");
    expect(demoScreens).toContain('Suggested: "Restore the prior session workflow."');
    expect(demo.result.stdout).toContain("DEMO COMPLETE · nothing was created or stored");
    // Fail-closed demo: nothing on disk.
    await expect(readdir(join(dir, ".ai-spend-agent"))).rejects.toThrow();
  });
});

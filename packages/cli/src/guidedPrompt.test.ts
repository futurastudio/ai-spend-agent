import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askGuidedQuestion,
  classifyGuidedAnswer,
  createInteractivePromptSource,
  createScriptedPromptSource,
  renderDrainNotice,
  renderGuidedQuestion,
  renderNextCommand,
  type ClassifyContext,
  type ClassifyResult,
  type GuidedFieldKind,
  type GuidedPromptSource
} from "./guidedPrompt.js";

const NOW = Date.parse("2026-08-17T22:00:00Z");
const APPROVED = "2026-08-17T21:00:00.000Z";

type Row = {
  name: string;
  kind: GuidedFieldKind;
  input: string;
  context?: ClassifyContext;
  expect:
    | { outcome: "accept"; value?: string }
    | { outcome: "navigate"; action: "back" | "cancel" }
    | { outcome: "skip" }
    | { outcome: "reject"; code: string };
};

const rows: Row[] = [
  // Navigation pre-pass on every field kind.
  { name: "back word", kind: "prose", input: "back", expect: { outcome: "navigate", action: "back" } },
  { name: "back shorthand", kind: "name", input: "B", expect: { outcome: "navigate", action: "back" } },
  { name: "cancel word", kind: "time", input: "cancel", expect: { outcome: "navigate", action: "cancel" } },
  { name: "quit", kind: "choice", input: "quit", context: { choiceTokens: ["p", "f", "n"] }, expect: { outcome: "navigate", action: "cancel" } },
  { name: "exit", kind: "approve", input: "exit", expect: { outcome: "navigate", action: "cancel" } },

  // Empty and optional.
  { name: "empty prose rejects", kind: "prose", input: "   ", expect: { outcome: "reject", code: "empty" } },
  { name: "empty optional skips", kind: "optional", input: "", expect: { outcome: "skip" } },
  { name: "skip word on optional", kind: "optional", input: "skip", expect: { outcome: "skip" } },
  { name: "empty approve declines", kind: "approve", input: "", expect: { outcome: "navigate", action: "cancel" } },

  // Control, format, surrogate garbage.
  { name: "ansi escape rejected", kind: "prose", input: "looks [31mred[0m to me", expect: { outcome: "reject", code: "control" } },
  { name: "bidi override rejected", kind: "name", input: "Jo‮se", expect: { outcome: "reject", code: "control" } },
  { name: "zero-width rejected", kind: "prose", input: "held​ the change", expect: { outcome: "reject", code: "control" } },
  { name: "unpaired surrogate rejected", kind: "name", input: "bad\ud800name", expect: { outcome: "reject", code: "control" } },

  // Credentials: rejected, never echoed (asserted separately below).
  { name: "openai-style key", kind: "prose", input: "the key sk-abc12345678901234567890 broke it", expect: { outcome: "reject", code: "credential" } },
  { name: "github token", kind: "optional", input: "ghp_abcdefgh1234", expect: { outcome: "reject", code: "credential" } },
  { name: "password assignment", kind: "prose", input: "password: hunter22222", expect: { outcome: "reject", code: "credential" } },
  // QA B1: the backstop predicate is the floor — these were accepted before.
  { name: "stripe live key", kind: "name", input: "sk_live_abcd1234efgh5678", expect: { outcome: "reject", code: "credential" } },
  { name: "github fine-grained pat", kind: "name", input: "github_pat_11ABCDEF0123456789", expect: { outcome: "reject", code: "credential" } },
  { name: "ghu token", kind: "name", input: "ghu_abcdefgh12345678", expect: { outcome: "reject", code: "credential" } },
  { name: "authorization bearer", kind: "prose", input: "Authorization: Bearer sekrit123abc", expect: { outcome: "reject", code: "credential" } },
  { name: "pem private key header", kind: "prose", input: "-----BEGIN OPENSSH PRIVATE KEY-----", expect: { outcome: "reject", code: "credential" } },

  // Shell tier 1: unambiguous binaries and syntax.
  { name: "git command", kind: "prose", input: "git status", expect: { outcome: "reject", code: "shell" } },
  { name: "npm script", kind: "prose", input: "npm run build", expect: { outcome: "reject", code: "shell" } },
  { name: "prompt prefix", kind: "prose", input: "$ ls -la", expect: { outcome: "reject", code: "shell" } },
  { name: "pipeline", kind: "prose", input: "history | tail -50", expect: { outcome: "reject", code: "shell" } },
  { name: "long flag", kind: "prose", input: "run it with --verbose enabled", expect: { outcome: "reject", code: "shell" } },
  { name: "sudo prefix", kind: "prose", input: "sudo rm -rf ./cache", expect: { outcome: "reject", code: "shell" } },
  { name: "env prefix", kind: "prose", input: "DEBUG=1 node server.js", expect: { outcome: "reject", code: "shell" } },
  { name: "our own cli", kind: "prose", input: "aibill improve", expect: { outcome: "reject", code: "shell" } },
  { name: "command as name", kind: "name", input: "git commit", expect: { outcome: "reject", code: "shell" } },

  // Shell tier 2: ambiguous verbs need corroboration — real sentences pass.
  { name: "make as verb passes", kind: "prose", input: "Make the retry loop stop after three attempts", expect: { outcome: "accept" } },
  { name: "open as verb passes", kind: "prose", input: "Open questions remain about the cache design", expect: { outcome: "accept" } },
  { name: "go sentence passes", kind: "prose", input: "Go over the plan with the team tomorrow", expect: { outcome: "accept" } },
  { name: "make with flag rejects", kind: "prose", input: "make -j8", expect: { outcome: "reject", code: "shell" } },
  { name: "cat with file rejects", kind: "prose", input: "cat notes.md", expect: { outcome: "reject", code: "shell" } },
  { name: "terse lowercase verb rejects", kind: "prose", input: "kill it", expect: { outcome: "reject", code: "shell" } },
  // QA M2/M10: redirects, heredocs, and PowerShell cmdlets.
  { name: "heredoc rejects", kind: "prose", input: "cat <<EOF", expect: { outcome: "reject", code: "shell" } },
  { name: "redirect rejects", kind: "prose", input: "echo hello > world.txt", expect: { outcome: "reject", code: "shell" } },
  { name: "powershell cmdlet rejects", kind: "prose", input: "Get-ChildItem -Recurse", expect: { outcome: "reject", code: "shell" } },
  { name: "three-word verb sentence passes", kind: "prose", input: "make it shorter", expect: { outcome: "accept" } },

  // Paths.
  { name: "absolute path", kind: "prose", input: "/opt/example/project/src", expect: { outcome: "reject", code: "path" } },
  { name: "relative path", kind: "prose", input: "./src/index.ts", expect: { outcome: "reject", code: "path" } },
  { name: "two slash tokens in prose", kind: "prose", input: "compare src/app.ts against lib/util.ts", expect: { outcome: "reject", code: "path" } },
  { name: "one slashed phrase in prose passes", kind: "prose", input: "The billing/usage split confused the reviewer", expect: { outcome: "accept" } },
  { name: "slashed token as name", kind: "name", input: "team/platform", expect: { outcome: "reject", code: "path" } },
  // QA M4: product-name teams are names, not paths; bare "." is a path.
  { name: "product-name team passes", kind: "team", input: "Node.js Guild", expect: { outcome: "accept", value: "Node.js Guild" } },
  { name: "bare extension token as name rejects", kind: "name", input: "app.ts", expect: { outcome: "reject", code: "path" } },
  { name: "bare dot as name rejects", kind: "name", input: ".", expect: { outcome: "reject", code: "path" } },

  // Reserved vocabulary and timestamp-shaped names.
  { name: "reserved verdict as role", kind: "role", input: "passed", expect: { outcome: "reject", code: "reserved" } },
  { name: "reserved approve as name", kind: "name", input: "approve", expect: { outcome: "reject", code: "reserved" } },
  { name: "yes as team", kind: "team", input: "yes", expect: { outcome: "reject", code: "reserved" } },
  { name: "timestamp as name", kind: "name", input: "2026-08-17T14:00:00Z", expect: { outcome: "reject", code: "timestamp_shaped" } },
  { name: "real name passes", kind: "name", input: "José Artigas", expect: { outcome: "accept", value: "José Artigas" } },
  { name: "real role passes", kind: "role", input: "staff engineer", expect: { outcome: "accept" } },
  // QA M5: ZWNJ (Persian orthography) and ZWJ (emoji families) are allowed.
  { name: "farsi name with zwnj passes", kind: "team", input: "نرم‌افزار", expect: { outcome: "accept" } },
  { name: "emoji family name passes", kind: "name", input: "Riya👨‍👩‍👧", expect: { outcome: "accept" } },
  { name: "keep reserved as a name", kind: "name", input: "keep", expect: { outcome: "reject", code: "reserved" } },

  // Length.
  { name: "very long name", kind: "name", input: "x".repeat(200), expect: { outcome: "reject", code: "length" } },
  { name: "very long prose", kind: "prose", input: "words and more ".repeat(80), expect: { outcome: "reject", code: "length" } },

  // Prose substance.
  { name: "single word prose", kind: "prose", input: "fixed", expect: { outcome: "reject", code: "substance" } },
  { name: "short sentence passes", kind: "prose", input: "Trimmed the system prompt to two paragraphs", expect: { outcome: "accept" } },
  // Non-answers pass the two-word bar but cannot be acted on later.
  { name: "i am not sure rejected", kind: "prose", input: "i am not sure", expect: { outcome: "reject", code: "substance" } },
  { name: "not sure with punctuation rejected", kind: "prose", input: "Not sure...", expect: { outcome: "reject", code: "substance" } },
  { name: "no idea rejected", kind: "prose", input: "no idea", expect: { outcome: "reject", code: "substance" } },
  { name: "spanish no se rejected", kind: "prose", input: "no sé", expect: { outcome: "reject", code: "substance" } },
  { name: "sentence containing not sure passes", kind: "prose", input: "Restore the old workflow even where not sure", expect: { outcome: "accept" } },

  // Time.
  { name: "now accepted", kind: "time", input: "now", context: { nowMs: NOW }, expect: { outcome: "accept", value: new Date(NOW).toISOString() } },
  { name: "valid iso accepted", kind: "time", input: "2026-08-17T21:30:00Z", context: { nowMs: NOW, approvedAtIso: APPROVED }, expect: { outcome: "accept", value: "2026-08-17T21:30:00.000Z" } },
  { name: "prose time rejected", kind: "time", input: "about an hour ago", context: { nowMs: NOW }, expect: { outcome: "reject", code: "time_invalid" } },
  { name: "date-only rejected", kind: "time", input: "2026-08-17", context: { nowMs: NOW }, expect: { outcome: "reject", code: "time_invalid" } },
  { name: "before approval rejected", kind: "time", input: "2026-08-17T20:59:00Z", context: { nowMs: NOW, approvedAtIso: APPROVED }, expect: { outcome: "reject", code: "time_before_approval" } },
  { name: "equal to approval rejected", kind: "time", input: APPROVED, context: { nowMs: NOW, approvedAtIso: APPROVED }, expect: { outcome: "reject", code: "time_before_approval" } },
  { name: "far future rejected", kind: "time", input: "2026-08-17T23:00:00Z", context: { nowMs: NOW }, expect: { outcome: "reject", code: "time_future" } },
  { name: "clock skew tolerated", kind: "time", input: "2026-08-17T22:01:00Z", context: { nowMs: NOW }, expect: { outcome: "accept" } },
  // QA minor 3: an unreadable approval time fails CLOSED, never open.
  { name: "malformed approvedAt fails closed", kind: "time", input: "2000-01-01T00:00:00Z", context: { nowMs: NOW, approvedAtIso: "garbage-not-a-time" }, expect: { outcome: "reject", code: "time_invalid" } },

  // Choice: exact tokens only.
  { name: "choice token accepted", kind: "choice", input: "p", context: { choiceTokens: ["p", "f", "n"] }, expect: { outcome: "accept", value: "p" } },
  { name: "choice uppercased accepted", kind: "choice", input: "F", context: { choiceTokens: ["p", "f", "n"] }, expect: { outcome: "accept", value: "f" } },
  { name: "exact full word maps to its letter", kind: "choice", input: "passed", context: { choiceTokens: ["p", "f", "n"] }, expect: { outcome: "accept", value: "p" } },
  { name: "held family word maps", kind: "choice", input: "held", context: { choiceTokens: ["h", "r", "m"] }, expect: { outcome: "accept", value: "h" } },
  { name: "no never maps at a p/f/n question", kind: "choice", input: "no", context: { choiceTokens: ["p", "f", "n"] }, expect: { outcome: "reject", code: "choice" } },
  { name: "passed never maps at a y/n question", kind: "choice", input: "passed", context: { choiceTokens: ["y", "n"] }, expect: { outcome: "reject", code: "choice" } },
  { name: "prefixy words never match", kind: "choice", input: "probably failed", context: { choiceTokens: ["p", "f", "n"] }, expect: { outcome: "reject", code: "choice" } },

  // Approve: exact capitals; anything else declines.
  { name: "APPROVE accepted", kind: "approve", input: "APPROVE", expect: { outcome: "accept", value: "APPROVE" } },
  { name: "lowercase approve nudged", kind: "approve", input: "approve", expect: { outcome: "reject", code: "approve_case" } },
  { name: "yes nudged", kind: "approve", input: "yes", expect: { outcome: "reject", code: "approve_case" } },
  { name: "anything else declines", kind: "approve", input: "not yet", expect: { outcome: "navigate", action: "cancel" } },
  // QA M3: clear approval intent always gets the nudge, never silent decline.
  { name: "APPROVED nudged", kind: "approve", input: "APPROVED", expect: { outcome: "reject", code: "approve_case" } },
  { name: "typo aprove nudged", kind: "approve", input: "APROVE", expect: { outcome: "reject", code: "approve_case" } },
  { name: "i approve nudged", kind: "approve", input: "i approve", expect: { outcome: "reject", code: "approve_case" } },
  { name: "full-width approve nudged", kind: "approve", input: "ＡＰＰＲＯＶＥ", expect: { outcome: "reject", code: "approve_case" } },

  // keep override: only for prose, only after 2 identical shell rejections.
  { name: "keep without streak is one word", kind: "prose", input: "keep", context: { priorShellRejections: 0 }, expect: { outcome: "reject", code: "substance" } },
  { name: "keep with streak accepted", kind: "prose", input: "keep", context: { priorShellRejections: 2 }, expect: { outcome: "accept", value: "keep" } }
];

describe("classifyGuidedAnswer table", () => {
  for (const row of rows) {
    it(row.name, () => {
      const verdict = classifyGuidedAnswer(row.kind, row.input, row.context);
      expect(verdict.outcome).toBe(row.expect.outcome);
      if (row.expect.outcome === "navigate" && verdict.outcome === "navigate") {
        expect(verdict.action).toBe(row.expect.action);
      }
      if (row.expect.outcome === "reject" && verdict.outcome === "reject") {
        expect(verdict.code).toBe(row.expect.code);
      }
      if (row.expect.outcome === "accept" && verdict.outcome === "accept" && row.expect.value !== undefined) {
        expect(verdict.value).toBe(row.expect.value);
      }
    });
  }

  it("never echoes credential input in the rejection message", () => {
    const secret = "sk-abc12345678901234567890";
    const verdict = classifyGuidedAnswer("prose", `it broke with ${secret}`);
    expect(verdict.outcome).toBe("reject");
    if (verdict.outcome === "reject") {
      expect(verdict.message).not.toContain(secret);
      expect(verdict.message).toContain("discarded");
    }
  });

  it("normalizes accepted names to NFC", () => {
    const decomposed = "José";
    const verdict = classifyGuidedAnswer("name", decomposed);
    expect(verdict).toEqual({ outcome: "accept", value: "José" });
  });
});

/* ------------------------------------------------------------------ */
/* Ask loop                                                            */
/* ------------------------------------------------------------------ */

function immediateSource(lines: string[], after: "hang" | "close" = "close"): GuidedPromptSource {
  const remaining = [...lines];
  return {
    next: async () => {
      const head = remaining.shift();
      if (head !== undefined) return { kind: "line", text: head, receivedAtMs: Date.now() };
      if (after === "close") return { kind: "closed" };
      return await new Promise(() => undefined);
    },
    drain: () => 0
  };
}

function collectingWriter() {
  const written: string[] = [];
  return { written, write: (text: string) => written.push(text) };
}

describe("askGuidedQuestion", () => {
  it("reprompts on rejection and accepts the corrected answer", async () => {
    const { written, write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => renderGuidedQuestion({ step: 1, totalSteps: 3, question: "What should improve?" }),
      sittingHint: "You can type cancel and come back later.",
      write,
      source: immediateSource(["git status", "Trim the system prompt to two paragraphs"])
    });
    expect(outcome).toEqual({ outcome: "answered", value: "Trim the system prompt to two paragraphs" });
    expect(written.join("\n")).toContain("shell command");
  });

  it("substitutes the last rejected text when keep is typed after an identical streak", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => "Q\n> ",
      sittingHint: "",
      write,
      source: immediateSource(["git stash pop", "git stash pop", "keep"])
    });
    expect(outcome).toEqual({ outcome: "answered", value: "git stash pop" });
  });

  it("keep works after varied (non-identical) shell rejections and records the last one", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => "Q\n> ",
      sittingHint: "",
      write,
      source: immediateSource(["git stash pop", "npm run lint", "keep"])
    });
    expect(outcome).toEqual({ outcome: "answered", value: "npm run lint" });
  });

  it("keep disarms when a non-shell rejection breaks the streak", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => "Q\n> ",
      sittingHint: "",
      write,
      source: immediateSource([
        "git stash pop", "git stash pop", "one", "keep", "A real sentence instead"
      ])
    });
    // "one" is a substance reject, so "keep" is unarmed and itself rejects.
    expect(outcome).toEqual({ outcome: "answered", value: "A real sentence instead" });
  });

  it("emptyKeepsValue keeps the previous answer on an empty line", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => "Q\n> ",
      sittingHint: "",
      write,
      source: immediateSource([""]),
      emptyKeepsValue: "Restore the prior session workflow."
    });
    expect(outcome).toEqual({
      outcome: "answered",
      value: "Restore the prior session workflow."
    });
  });

  it("optional skip wins over emptyKeepsValue", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "optional",
      render: () => "Q\n> ",
      sittingHint: "",
      write,
      source: immediateSource([""]),
      emptyKeepsValue: "Acme Corp"
    });
    expect(outcome).toEqual({ outcome: "skipped" });
  });

  it("offers the keep hint only after two identical shell rejections", async () => {
    const { written, write } = collectingWriter();
    await askGuidedQuestion({
      kind: "prose",
      render: () => "Q\n> ",
      sittingHint: "",
      write,
      source: immediateSource(["git stash pop", "git stash pop", "keep"])
    });
    const frames = written.filter((frame) => frame.includes("shell command"));
    expect(frames).toHaveLength(2);
    expect(frames[0]).not.toContain("Type keep");
    expect(frames[1]).toContain("Type keep");
  });

  it("maps back, close, and interrupt to their outcomes", async () => {
    const { write } = collectingWriter();
    const back = await askGuidedQuestion({
      kind: "prose", render: () => "Q", sittingHint: "", write,
      source: immediateSource(["back"])
    });
    expect(back).toEqual({ outcome: "back" });

    const closed = await askGuidedQuestion({
      kind: "prose", render: () => "Q", sittingHint: "", write,
      source: immediateSource([])
    });
    expect(closed).toEqual({ outcome: "cancelled" });

    const interrupting: GuidedPromptSource = {
      next: async () => ({ kind: "interrupted" }),
      drain: () => 0
    };
    const interrupted = await askGuidedQuestion({
      kind: "prose", render: () => "Q", sittingHint: "", write, source: interrupting
    });
    expect(interrupted).toEqual({ outcome: "cancelled" });
  });

  it("announces drained paste lines", async () => {
    const { written, write } = collectingWriter();
    let drained = false;
    const source: GuidedPromptSource = {
      next: async () => ({ kind: "line", text: "Use fewer tools in the loop", receivedAtMs: Date.now() }),
      drain: () => {
        if (drained) return 0;
        drained = true;
        return 3;
      }
    };
    const outcome = await askGuidedQuestion({
      kind: "prose", render: () => "Q", sittingHint: "", write, source
    });
    expect(outcome.outcome).toBe("answered");
    expect(written.join("\n")).toContain("( 3 more pasted line(s) were discarded )");
  });

  it("cancels via the circuit breaker on identical repeated rejections", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => "Q",
      sittingHint: "",
      write,
      source: immediateSource(["git status", "git status", "git status"], "hang"),
      maxIdenticalRejections: 3
    });
    expect(outcome).toEqual({ outcome: "cancelled" });
  });

  it("does not trip the breaker on varied rejections", async () => {
    const { write } = collectingWriter();
    const outcome = await askGuidedQuestion({
      kind: "prose",
      render: () => "Q",
      sittingHint: "",
      write,
      source: immediateSource(["git status", "npm test", "git diff", "Rewrote the flaky test"]),
      maxIdenticalRejections: 3
    });
    expect(outcome).toEqual({ outcome: "answered", value: "Rewrote the flaky test" });
  });

  it("shows the sitting hint from the second rejection", async () => {
    const { written, write } = collectingWriter();
    await askGuidedQuestion({
      kind: "prose",
      render: () => "Q",
      sittingHint: "You can type cancel and finish this later.",
      write,
      source: immediateSource(["one", "two words are fine"])
    });
    expect(written.join("\n")).not.toContain("finish this later");

    const second = collectingWriter();
    await askGuidedQuestion({
      kind: "prose",
      render: () => "Q",
      sittingHint: "You can type cancel and finish this later.",
      write: second.write,
      source: immediateSource(["one", "two", "Both attempts were single words"])
    });
    expect(second.written.join("\n")).toContain("finish this later");
  });
});

describe("prompt sources", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scripted source throws on exhaustion instead of hanging", async () => {
    const source = createScriptedPromptSource(["only answer"]);
    await source.next(0);
    await expect(source.next(0)).rejects.toThrow(/exhausted/);
  });

  it("interactive source discards lines pasted before the prompt rendered", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let emitLine: (line: string) => void = () => undefined;
    const source = createInteractivePromptSource({
      onLine: (listener) => { emitLine = listener; },
      onClose: () => undefined,
      onInterrupt: () => undefined
    });
    emitLine("pasted ahead of the prompt");
    const renderedAt = start + 15;
    vi.setSystemTime(start + 200);
    emitLine("typed after the prompt");
    const event = await source.next(renderedAt);
    expect(event).toMatchObject({ kind: "line", text: "typed after the prompt" });
    // The purged pasted-ahead line is counted into the drain notice.
    expect(source.drain()).toBe(1);
  });

  it("late paste chunks inherit the burst timestamp and cannot answer later questions", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let emitLine: (line: string) => void = () => undefined;
    const source = createInteractivePromptSource({
      onLine: (listener) => { emitLine = listener; },
      onClose: () => undefined,
      onInterrupt: () => undefined
    });
    // Chunk 1 of a paste lands before the prompt renders …
    emitLine("first paste line");
    const renderedAt = start + 10;
    // … and chunk 2 of the SAME paste lands a few ms after the render.
    vi.setSystemTime(start + 30);
    emitLine("APPROVE");
    // A real answer arrives well after the burst window closes.
    vi.setSystemTime(start + 300);
    emitLine("a real typed answer");
    const event = await source.next(renderedAt);
    expect(event).toMatchObject({ kind: "line", text: "a real typed answer" });
    expect(source.drain()).toBe(2);
  });

  it("interactive source drains buffered extra lines", async () => {
    let emitLine: (line: string) => void = () => undefined;
    const source = createInteractivePromptSource({
      onLine: (listener) => { emitLine = listener; },
      onClose: () => undefined,
      onInterrupt: () => undefined
    });
    emitLine("first");
    emitLine("second");
    emitLine("third");
    const event = await source.next(0);
    expect(event).toMatchObject({ kind: "line", text: "first" });
    expect(source.drain()).toBe(2);
  });

  it("interactive source maps close and interrupt", async () => {
    let close: () => void = () => undefined;
    const closing = createInteractivePromptSource({
      onLine: () => undefined,
      onClose: (listener) => { close = listener; },
      onInterrupt: () => undefined
    });
    close();
    expect(await closing.next(0)).toEqual({ kind: "closed" });

    let interrupt: () => void = () => undefined;
    const interrupting = createInteractivePromptSource({
      onLine: () => undefined,
      onClose: () => undefined,
      onInterrupt: (listener) => { interrupt = listener; }
    });
    interrupt();
    expect(await interrupting.next(0)).toEqual({ kind: "interrupted" });
  });
});

describe("render helpers", () => {
  it("renders the words-not-commands banner on marked questions", () => {
    const screen = renderGuidedQuestion({
      step: 2, totalSteps: 5,
      question: "In one sentence, what should the agent do differently?",
      wordsNotCommands: true,
      example: "Stop loading the browser tools for docs-only work"
    });
    expect(screen).toContain("answer in words — do not paste a shell command");
    expect(screen).toContain("e.g. Stop loading the browser tools");
  });

  it("keeps the advanced line out of the plain command lines", () => {
    const block = renderNextCommand({
      reason: "when the agent has applied the change",
      command: "aibill improve --verify",
      advancedLine: "aibill improve --verify cancel abandons the experiment"
    });
    const commandLines = block.split("\n").filter((line) => line.startsWith("  "));
    expect(commandLines).toHaveLength(1);
    expect(block).toContain("(Advanced: ");
  });

  it("renders no drain notice for zero discards", () => {
    expect(renderDrainNotice(0)).toBe("");
  });
});

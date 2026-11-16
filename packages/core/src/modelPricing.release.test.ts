import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PRICING_TABLE_AS_OF, canPriceTokenUsageAtScope, estimateTokenCostUsd, estimateTokenCostsUsd, findPricingRule, promptTierThreshold, type TokenUsage } from "./modelPricing.js";

const evidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-07.json", import.meta.url), "utf8"));
const sonnetEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-08.json", import.meta.url), "utf8"));
const reviewedEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-10-18.json", import.meta.url), "utf8"));
const geminiEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-11-04.json", import.meta.url), "utf8"));
const solEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-11-06.json", import.meta.url), "utf8"));
const standardTablesEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-11-07.json", import.meta.url), "utf8"));
const fableEvidence = JSON.parse(readFileSync(new URL("../../../provider-contracts/model-pricing-2026-11-13.json", import.meta.url), "utf8"));

describe("2026-11-13 reviewed Claude Fable 5.2 and Claude Mythos 5.2 prices", () => {
  type Row = { id: string; quote: string; input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
  const added = fableEvidence.models as Row[];
  const kept = fableEvidence.stillOnThisPage as Row[];
  // One million tokens of one component. No date: these rules carry no dated change.
  const price = (model: string, component: Partial<TokenUsage>) =>
    estimateTokenCostUsd(model, { inputTokens: 0, outputTokens: 0, ...component });
  const expectRow = (model: string, row: Row) => {
    expect(price(model, { inputTokens: 1_000_000 })).toBe(row.input);
    expect(price(model, { outputTokens: 1_000_000 })).toBe(row.output);
    expect(price(model, { cacheReadTokens: 1_000_000 })).toBe(row.cacheRead);
    expect(price(model, { cacheWrite5mTokens: 1_000_000 })).toBe(row.cacheWrite5m);
    expect(price(model, { cacheWrite1hTokens: 1_000_000 })).toBe(row.cacheWrite1h);
  };

  it("is the review date of the price table", () => {
    expect(PRICING_TABLE_AS_OF).toBe(fableEvidence.retrievedAt);
  });

  it("records the two IDs Anthropic released on 2026-11-09, each with the line that prices it", () => {
    expect(added.map((row) => row.id)).toEqual(["claude-fable-5-2", "claude-mythos-5-2"]);
    expect(fableEvidence.released).toBe("2026-11-09");
    for (const row of [...added, ...kept]) {
      for (const rate of [row.input, row.output]) expect(row.quote, row.id).toContain("$" + rate + " / MTok");
    }
    for (const url of fableEvidence.sources as string[]) {
      expect(fableEvidence.pageNormalizedSha256[url], url).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each(added.map((row): [string, Row] => [row.id, row]))("%s matches the retained rates, with no prompt tier and no dated change", (model, row) => {
    expect(promptTierThreshold(model)).toBeUndefined();
    expectRow(model, row);
    // Without a date a rule that carries a dated change is unpriced, so this also shows there is none.
    expect(estimateTokenCostUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(row.input + row.output);
    // The page prints cache hits at 0.025x input, and writes at the usual 1.25x and 2x.
    expect(row.cacheRead).toBe(row.input * 0.025);
    expect(row.cacheWrite5m).toBe(row.input * 1.25);
    expect(row.cacheWrite1h).toBe(row.input * 2);
  });

  it.each(["CLAUDE-FABLE-5-2", "claude-fable-5-2-20261109", "claude-mythos-5-2-20261109"])("%s prices as its exact ID does", (model) => {
    // The dated IDs are synthetic: they exercise snapshot matching, not availability.
    expectRow(model, added[0]);
  });

  it("no longer prices the new IDs at the Claude Fable 5 rates", () => {
    const fable5 = kept.find((row) => row.id === "claude-fable-5")!;
    for (const { id } of added) {
      expect(findPricingRule(id)).not.toBe(findPricingRule(fable5.id));
      expect(price(id, { inputTokens: 1_000_000 })).toBeLessThan(fable5.input);
      expect(price(id, { cacheReadTokens: 1_000_000 })).toBe(fable5.cacheRead / 5);
    }
  });

  it.each(kept.map((row): [string, Row] => [row.id, row]))("%s keeps the row the page still prints for it", (model, row) => {
    expectRow(model, row);
  });
});

describe("2026-11-07 reviewed OpenAI standard tables", () => {
  type Row = {
    id: string; input: number; output: number; cacheRead: number | null;
    abovePromptTokens?: number; aboveInput?: number; aboveOutput?: number; aboveCacheRead?: number | null;
  };
  const rows = standardTablesEvidence.models as Row[];
  // One million tokens of one component, with the request tier fixed by the given prompt.
  const price = (model: string, component: Partial<TokenUsage>, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens], standardTablesEvidence.retrievedAt);
  const expectCached = (model: string, tierPromptTokens: number, rate: number | null | undefined) => {
    const cached = price(model, { cacheReadTokens: 1_000_000 }, tierPromptTokens);
    if (rate === null) expect(cached, `${model} prints a dash for cached input`).toBeUndefined();
    else expect(cached).toBe(rate);
  };

  it("lists every row of the two tables once, except GPT-5.6 Sol, whose re-check stays on its own evidence", () => {
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(standardTablesEvidence.standardTableRows - 1);
    // The re-check test reads the newest evidence file that lists Sol. Listing it here would clear that test.
    expect(ids).not.toContain("gpt-5.6-sol");
  });

  it("agrees with the 2026-11-06 evidence on what the page prints for GPT-5.6 Sol today", () => {
    const sol = solEvidence.models.find((entry: { id: string }) => entry.id === "gpt-5.6-sol");
    const { solTodayOnThisPage } = standardTablesEvidence;
    expect(solTodayOnThisPage).toEqual({
      input: sol.input, output: sol.output, cacheRead: sol.cacheRead,
      abovePromptTokens: sol.abovePromptTokens, aboveInput: sol.aboveInput, aboveOutput: sol.aboveOutput, aboveCacheRead: sol.aboveCacheRead
    });
  });

  it.each(rows.map((row): [string, Row] => [row.id, row]))("%s matches the retained rates on both sides of any tier", (model, row) => {
    const threshold = row.abovePromptTokens;
    expect(promptTierThreshold(model)).toBe(threshold);
    const base = threshold ?? 1_000_000;
    expect(price(model, { inputTokens: 1_000_000 }, base)).toBe(row.input);
    expect(price(model, { outputTokens: 1_000_000 }, base)).toBe(row.output);
    expectCached(model, base, row.cacheRead);
    if (threshold === undefined) return;
    const above = threshold + 1;
    expect(price(model, { inputTokens: 1_000_000 }, above)).toBe(row.aboveInput);
    expect(price(model, { outputTokens: 1_000_000 }, above)).toBe(row.aboveOutput);
    expectCached(model, above, row.aboveCacheRead);
  });

  describe("every other ID the docs name", () => {
    type OtherRow = { id: string; input: number; output: number; cacheRead: number | null };
    type NotPriced = { id: string; why: string; archivedRates?: { input: number; output: number; cacheRead: null } };
    const others = standardTablesEvidence.modelPageRows as OtherRow[];
    const notPriced = standardTablesEvidence.notPricedOnPurpose as NotPriced[];

    it("lists an ID once, and never GPT-5.6 Sol or a row of the two tables", () => {
      const ids = others.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain("gpt-5.6-sol");
      expect(ids.filter((id) => rows.some((row) => row.id === id))).toEqual([]);
      expect(notPriced.map((row) => row.id).filter((id) => ids.includes(id))).toEqual([]);
    });

    it.each(others.map((row): [string, OtherRow] => [row.id, row]))("%s matches the page that prices it, with no prompt tier", (model, row) => {
      expect(promptTierThreshold(model)).toBeUndefined();
      expect(price(model, { inputTokens: 1_000_000 }, 1_000_000)).toBe(row.input);
      expect(price(model, { outputTokens: 1_000_000 }, 1_000_000)).toBe(row.output);
      expectCached(model, 1_000_000, row.cacheRead);
    });

    it.each(notPriced.map((row): [string, string] => [row.id, row.why]))("%s counts as missing: %s", (model) => {
      expect(findPricingRule(model)).toBeUndefined();
      expect(estimateTokenCostUsd(model, { inputTokens: 1_000, outputTokens: 1_000 })).toBeUndefined();
    });

    it("records why the older gpt-4o snapshot is not priced at gpt-4o's rates", () => {
      const archived = notPriced.find((row) => row.id === "gpt-4o-2024-05-13")?.archivedRates;
      expect(archived).toBeDefined();
      expect(archived!.input).not.toBe(estimateTokenCostUsd("gpt-4o", { inputTokens: 1_000_000, outputTokens: 0 }));
      expect(archived!.output).not.toBe(estimateTokenCostUsd("gpt-4o", { inputTokens: 0, outputTokens: 1_000_000 }));
    });

    it("hashes every page it cites", () => {
      const cited = [...others, ...notPriced].map((row) => (row as { source?: string }).source);
      for (const url of cited) expect(standardTablesEvidence.sources).toContain(url);
      for (const url of standardTablesEvidence.sources as string[]) {
        expect(standardTablesEvidence.pageContentSha256[url], url).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });
});

describe("2026-11-06 reviewed GPT-5.6 Sol prices", () => {
  type Rates = {
    from?: string; input: number; output: number; cacheRead: number;
    abovePromptTokens: number; aboveInput: number; aboveOutput: number; aboveCacheRead: number;
  };
  const model = solEvidence.models.find((entry: { id: string }) => entry.id === "gpt-5.6-sol");
  const [change] = model.scheduledRates as Rates[];
  const firstDay = `${change!.from}T00:00:00.000Z`;
  // The last UTC millisecond of the promotion.
  const lastBefore = new Date(Date.parse(firstDay) - 1).toISOString();
  // One million tokens of one component, with the request tier fixed by the given prompt.
  const price = (component: Partial<TokenUsage>, usageAt: string, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model.id, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens], usageAt);

  it.each([
    ["through", lastBefore, model as Rates],
    ["after", firstDay, change!]
  ])("matches the retained rates and long-context tier %s the promotion", (_side, usageAt, rates) => {
    expect(promptTierThreshold(model.id, usageAt)).toBe(rates.abovePromptTokens);
    const base = rates.abovePromptTokens;
    const above = rates.abovePromptTokens + 1;
    expect(price({ inputTokens: 1_000_000 }, usageAt, base)).toBe(rates.input);
    expect(price({ outputTokens: 1_000_000 }, usageAt, base)).toBe(rates.output);
    expect(price({ cacheReadTokens: 1_000_000 }, usageAt, base)).toBe(rates.cacheRead);
    expect(price({ inputTokens: 1_000_000 }, usageAt, above)).toBe(rates.aboveInput);
    expect(price({ outputTokens: 1_000_000 }, usageAt, above)).toBe(rates.aboveOutput);
    expect(price({ cacheReadTokens: 1_000_000 }, usageAt, above)).toBe(rates.aboveCacheRead);
  });

  it("carries exactly the retained schedule", () => {
    const rule = findPricingRule(model.id)!;
    expect(rule.scheduledRates?.map(({ from, inputPerM, outputPerM, cacheReadPerM, abovePromptTokens: tier }) => ({
      from, input: inputPerM, output: outputPerM, cacheRead: cacheReadPerM, abovePromptTokens: tier?.threshold,
      aboveInput: tier?.inputPerM, aboveOutput: tier?.outputPerM, aboveCacheRead: tier?.cacheReadPerM
    }))).toEqual(model.scheduledRates);
  });

  it("holds the published relations the inferred later rates rest on", () => {
    // "a 20% reduction in input pricing and a 33% reduction in output pricing".
    expect(1 - model.input / change!.input).toBeCloseTo(0.2, 5);
    expect(1 - model.output / change!.output).toBeCloseTo(0.33, 2);
    // ">272K input tokens are priced at 2x input and 1.5x output for the full request".
    for (const rates of [model as Rates, change!]) {
      expect(rates.aboveInput).toBe(rates.input * 2);
      expect(rates.aboveOutput).toBe(rates.output * 1.5);
      expect(rates.aboveCacheRead).toBe(rates.cacheRead * 2);
    }
    expect(solEvidence.basis).toContain("has NOT published the rate that follows the promotion");
  });

  it("cites the Codex pricing page, which still says at least through November 21", () => {
    expect(solEvidence.sources).toContain("https://learn.chatgpt.com/docs/pricing.md");
    expect(solEvidence.pageContentSha256["https://learn.chatgpt.com/docs/pricing.md"]).toMatch(/^[a-f0-9]{64}$/);
    expect(solEvidence.basis).toContain("at least through November 21, 2026, and lists 100, 10 and 500 credits");
  });

  // Dated on purpose. Reports print these rates under "published API rates", and OpenAI has not
  // published them, so a person has to look again by the date the evidence names. From the next
  // UTC day this fails in every run until the inference is replaced or a new date is recorded.
  // The newest evidence file that lists the model decides, so following the evidence's own action
  // turns this green without editing the test.
  type Recheck = { by: string; action: string };
  type EvidenceFile = { name: string; models?: { id: string }[]; laterRatesRecheck?: Recheck };
  const evidenceDirectory = new URL("../../../provider-contracts/", import.meta.url);
  const evidenceFiles = (): EvidenceFile[] => readdirSync(evidenceDirectory)
    .filter((name) => /^model-pricing-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .map((name) => ({ name, ...JSON.parse(readFileSync(new URL(name, evidenceDirectory), "utf8")) }));
  const recheckDue = (files: EvidenceFile[], today: string): Recheck | undefined => {
    const recheck = files.filter((file) => file.models?.some((entry) => entry.id === "gpt-5.6-sol")).at(-1)?.laterRatesRecheck;
    return recheck && today > recheck.by ? recheck : undefined;
  };

  it("has its inferred later rates re-checked by the date the newest evidence names", () => {
    const due = recheckDue(evidenceFiles(), new Date().toISOString().slice(0, 10));
    expect(due, due && `The re-check of gpt-5.6-sol was due by ${due.by}. ${due.action}`).toBeUndefined();
  });

  it("names December 1 for the re-check, and either outcome of it clears the test", () => {
    const today = [{ name: "model-pricing-2026-11-06.json", ...solEvidence }];
    expect(solEvidence.laterRatesRecheck.by).toBe("2026-12-01");
    expect(recheckDue(today, "2026-12-01")).toBeUndefined();
    expect(recheckDue(today, "2026-12-02")).toMatchObject({ by: "2026-12-01" });
    const solFile = (name: string, extra: object) => ({ name, models: [{ id: "gpt-5.6-sol" }], ...extra });
    // OpenAI still has not published: a new date.
    expect(recheckDue([...today, solFile("model-pricing-2026-12-01.json", { laterRatesRecheck: { by: "2027-01-15", action: "look again" } })], "2026-12-02")).toBeUndefined();
    // OpenAI published: the inference is replaced, and nothing is left to re-check.
    expect(recheckDue([...today, solFile("model-pricing-2026-12-01.json", {})], "2026-12-02")).toBeUndefined();
    // Evidence about another model settles nothing.
    expect(recheckDue([...today, { name: "model-pricing-2026-12-01.json", models: [{ id: "gpt-6-sol" }] }], "2026-12-02")).toMatchObject({ by: "2026-12-01" });
  });
});

describe("2026-11-04 reviewed Gemini 2.5 Pro prices", () => {
  type Rates = { from?: string; input: number; output: number; cacheRead: number };
  const model = geminiEvidence.models.find((entry: { id: string }) => entry.id === "gemini-2.5-pro");
  const changes = model.scheduledRates as Rates[];
  // The last UTC millisecond before a published change.
  const lastBefore = (from: string) => new Date(Date.parse(`${from}T00:00:00.000Z`) - 1).toISOString();
  // One million tokens of one component, with the request tier fixed by the given prompt.
  const price = (component: Partial<TokenUsage>, usageAt: string, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model.id, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens], usageAt);

  it("matches the retained official-price evidence before the first change", () => {
    const before = lastBefore(changes[0]!.from!);
    expect(promptTierThreshold(model.id, before)).toBe(model.abovePromptTokens);
    const base = model.abovePromptTokens;
    const above = model.abovePromptTokens + 1;
    expect(price({ inputTokens: 1_000_000 }, before, base)).toBe(model.input);
    expect(price({ outputTokens: 1_000_000 }, before, base)).toBe(model.output);
    expect(price({ cacheReadTokens: 1_000_000 }, before, base)).toBe(model.cacheRead);
    expect(price({ inputTokens: 1_000_000 }, before, above)).toBe(model.aboveInput);
    expect(price({ outputTokens: 1_000_000 }, before, above)).toBe(model.aboveOutput);
    expect(price({ cacheReadTokens: 1_000_000 }, before, above)).toBe(model.aboveCacheRead);
  });

  it.each(changes.map((change): [string, Rates] => [change.from!, change]))(
    "matches the retained flat rates in force from %s, whatever the prompt size",
    (from, change) => {
      const usageAt = `${from}T00:00:00.000Z`;
      expect(promptTierThreshold(model.id, usageAt)).toBeUndefined();
      expect(price({ inputTokens: 1_000_000 }, usageAt, 1_000_000)).toBe(change.input);
      expect(price({ outputTokens: 1_000_000 }, usageAt, 1_000_000)).toBe(change.output);
      expect(price({ cacheReadTokens: 1_000_000 }, usageAt, 1_000_000)).toBe(change.cacheRead);
    }
  );

  it("switches on each published date and not before", () => {
    expect(price({ inputTokens: 1_000_000 }, lastBefore(changes[1]!.from!), 1_000_000)).toBe(changes[0]!.input);
  });

  it("carries exactly the retained schedule, with no tier after the first change", () => {
    const rule = findPricingRule(model.id)!;
    expect(rule.scheduledRates?.map(({ from, inputPerM, outputPerM, cacheReadPerM, abovePromptTokens }) =>
      ({ from, input: inputPerM, output: outputPerM, cacheRead: cacheReadPerM, tiered: abovePromptTokens !== undefined })))
      .toEqual(changes.map((change) => ({ ...change, tiered: false })));
  });
});

describe("2026-10-18 reviewed Haiku 5.5 prices", () => {
  const model = reviewedEvidence.models.find((entry: { id: string }) => entry.id === "claude-haiku-5-5");
  // One million tokens of one component, with the request tier fixed by a
  // prompt exactly at, or one token over, the published threshold.
  const price = (component: Partial<TokenUsage>, tierPromptTokens: number) =>
    estimateTokenCostsUsd(model.id, [{ inputTokens: 0, outputTokens: 0, ...component }], [tierPromptTokens]);

  it("matches the retained official-price evidence", () => {
    expect(promptTierThreshold(model.id)).toBe(model.abovePromptTokens);
    const base = model.abovePromptTokens;
    const above = model.abovePromptTokens + 1;
    expect(price({ inputTokens: 1_000_000 }, base)).toBe(model.input);
    expect(price({ outputTokens: 1_000_000 }, base)).toBe(model.output);
    expect(price({ cacheReadTokens: 1_000_000 }, base)).toBe(model.cacheRead);
    expect(price({ cacheWrite5mTokens: 1_000_000 }, base)).toBe(model.cacheWrite5m);
    expect(price({ cacheWrite1hTokens: 1_000_000 }, base)).toBe(model.cacheWrite1h);
    expect(price({ inputTokens: 1_000_000 }, above)).toBe(model.aboveInput);
    expect(price({ outputTokens: 1_000_000 }, above)).toBe(model.aboveOutput);
    expect(price({ cacheReadTokens: 1_000_000 }, above)).toBe(model.aboveCacheRead);
    expect(price({ cacheWrite5mTokens: 1_000_000 }, above)).toBe(model.aboveCacheWrite5m);
    expect(price({ cacheWrite1hTokens: 1_000_000 }, above)).toBe(model.aboveCacheWrite1h);
  });
});

describe("2026-10-18 reviewed Gemini 4 Argon prices", () => {
  type Rates = { from?: string; input: number; output: number; cacheRead: number };
  const model = reviewedEvidence.models.find((entry: { id: string }) => entry.id === "gemini-4-argon");
  const [change] = model.scheduledRates as Rates[];
  // The last UTC millisecond before the published change.
  const lastBefore = new Date(Date.parse(`${change!.from}T00:00:00.000Z`) - 1).toISOString();

  it.each([
    ["before", lastBefore, model as Rates],
    ["from", `${change!.from}T00:00:00.000Z`, change!]
  ])("matches the retained official-price evidence %s its published change", (_side, usageAt, rates) => {
    expect(estimateTokenCostUsd(model.id, { inputTokens: 1_000_000, outputTokens: 0 }, usageAt)).toBe(rates.input);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 1_000_000 }, usageAt)).toBe(rates.output);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, usageAt)).toBe(rates.cacheRead);
  });

  it("carries exactly the retained schedule", () => {
    const rule = findPricingRule(model.id)!;
    expect(rule.scheduledRates?.map(({ from, inputPerM, outputPerM, cacheReadPerM }) =>
      ({ from, input: inputPerM, output: outputPerM, cacheRead: cacheReadPerM }))).toEqual(model.scheduledRates);
    expect(rule.abovePromptTokens).toBeUndefined();
  });
});

describe("0.9.13 reviewed Sonnet 5.5 prices", () => {
  it("matches the retained official-price evidence", () => {
    const model = sonnetEvidence.models[0];
    expect(estimateTokenCostUsd(model.id, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(model.input);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(model.output);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(model.cacheRead);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 1_000_000 })).toBe(model.cacheWrite5m);
    expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 1_000_000 })).toBe(model.cacheWrite1h);
  });
});

describe("0.9.12 reviewed standard-price fixtures", () => {
  for (const model of evidence.models) {
    it(`${model.id}: published prices and documented estimator fallbacks match dated evidence`, () => {
      const rule = findPricingRule(model.id)!;
      expect(rule.inputPerM).toBe(model.input);
      expect(rule.outputPerM).toBe(model.output);
      expect(rule.cacheReadPerM ?? rule.inputPerM * 0.1).toBe(model.cacheRead);
      // Each 100K component stays below the prompt tier, tested independently.
      expect(estimateTokenCostUsd(model.id, { inputTokens: 100_000, outputTokens: 0 })).toBeCloseTo(model.input / 10, 4);
      expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 100_000 })).toBeCloseTo(model.output / 10, 4);
      expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100_000 })).toBeCloseTo(model.cacheRead / 10, 4);
      expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 100_000 })).toBeCloseTo((model.cacheWrite ?? model.cacheWrite5m) / 10, 4);
      if (model.cacheWrite1h) expect(estimateTokenCostUsd(model.id, { inputTokens: 0, outputTokens: 0, cacheWrite1hTokens: 100_000 })).toBe(model.cacheWrite1h / 10);
    });
  }
  it.each([
    ["gpt-6-astra", 3.22, 6.19, 6, 7.5],
    ["gpt-6.1-sol", .644, 1.238, 1.2, 1.5],
    ["gpt-6-sol", .644, 1.238, 1.2, 1.5],
    ["gpt-6-luna", .0322, .0619, .06, .075]
  ])("%s: golden threshold and per-request totals", (model, threshold, above, requests, aggregate) => {
    expect(estimateTokenCostUsd(model, { inputTokens: 272_000, outputTokens: 10_000 })).toBe(threshold);
    expect(estimateTokenCostUsd(model, { inputTokens: 272_001, outputTokens: 10_000 })).toBe(above);
    const request = { inputTokens: 200_000, outputTokens: 20_000 };
    expect(estimateTokenCostsUsd(model, [request, request])).toBe(requests);
    // Aggregate cannot establish whether the two requests individually crossed the tier.
    expect(canPriceTokenUsageAtScope(model, { inputTokens: 400_000, outputTokens: 40_000 }, "aggregate")).toBe(false);
    expect(estimateTokenCostUsd(model, { inputTokens: 300_000, outputTokens: 20_000 })).toBe(aggregate);
  });
  it.each(["gpt-6-preview", "gpt-6-astra-future", "gpt-6.2-sol", "codex-auto-review"])("%s has no invented price", model => {
    expect(estimateTokenCostUsd(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeUndefined();
  });
});

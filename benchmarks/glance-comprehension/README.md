# Glance comprehension and retention study

This is the preregistered validation protocol for aibill Glance. It is a
product test, not evidence that the current interface has already passed.
Participant rows stay blank until real people complete the study.

## Research question

Can an active Claude Code or Codex user reveal Glance and correctly answer,
without coaching:

1. what they are working on;
2. whether each five-hour/weekly limit is reported, unavailable, or stale;
3. when the reported limit resets or may be exhausted;
4. whether session value is an API-rate estimate or an added subscription
   charge;
5. what single action aibill recommends and why?

The one-week follow-up asks whether Glance remained installed and whether it
changed one session, reset, or context decision.

## Sample

Recruit 8–12 people who used a coding agent on at least three days in the
prior week:

- 3–4 Claude Code-only users;
- 3–4 Codex-only users;
- 2–4 mixed-agent users;
- at least four monthly-subscription users.

Do not recruit repository contributors for the first pass. Use anonymous
participant IDs (`P01`–`P12`) and do not commit names, email addresses,
transcripts, screenshots containing private work, or credentials.

## Procedure

1. Install the same signed candidate build and record its commit/version.
2. Ask the participant to run the CLI baseline once, then open Glance by
   hovering without explaining the card.
3. Give them 60 seconds to answer the five research questions aloud.
4. Record answer correctness, reveal time, any misread source/estimate, and a
   1–5 confidence score.
5. Ask: “What would you do next?” before exposing any tooltip or MCP
   explanation.
6. Let them inspect source help and optionally invoke MCP explanation; record
   whether the three surfaces agree.
7. After seven days, record installed/removed, active-use days, one recalled
   decision, and the reason to keep or remove it.

## Pass thresholds

Broad distribution requires all of the following:

- at least 80% correctly distinguish API-rate value from a bill;
- at least 80% correctly interpret missing and stale limit states;
- at least 75% identify current work and the recommended action in 60 seconds;
- no CLI/MCP/Glance contract disagreement in the observed tasks;
- at least 50% still have Glance installed after seven days;
- every critical misunderstanding is either fixed or documented before launch.

With 8–12 participants, results are directional product evidence—not a
population estimate or a basis for a universal productivity/savings claim.

## Blank scorecard

| ID | Cohort | Subscription | Value meaning correct | Limits correct | Work/action correct ≤60s | Surface parity | Day-7 installed | Decision recalled | Notes |
|---|---|---|---:|---:|---:|---:|---:|---|---|
| P01 |  |  |  |  |  |  |  |  |  |
| P02 |  |  |  |  |  |  |  |  |  |
| P03 |  |  |  |  |  |  |  |  |  |
| P04 |  |  |  |  |  |  |  |  |  |
| P05 |  |  |  |  |  |  |  |  |  |
| P06 |  |  |  |  |  |  |  |  |  |
| P07 |  |  |  |  |  |  |  |  |  |
| P08 |  |  |  |  |  |  |  |  |  |
| P09 |  |  |  |  |  |  |  |  |  |
| P10 |  |  |  |  |  |  |  |  |  |
| P11 |  |  |  |  |  |  |  |  |  |
| P12 |  |  |  |  |  |  |  |  |  |

## Reporting rule

Publish the commit/build, cohort counts, aggregate result, failures, removals,
and interface changes. Never fill blank participants with simulated feedback.
Do not market the study as completed until the recorded sessions and day-seven
follow-up both exist.

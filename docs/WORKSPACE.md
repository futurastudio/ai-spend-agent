# Connect aibill to Tilden Workspace

**Keep working locally and bring supported activity into your spending
review.** aibill works both as a free standalone CLI and as a connected local
tool for the owner of an invited
[Tilden Workspace](https://asktilden.com/docs/workspace). The pilot has one owner seat.

For standalone use, run `npx aibill@latest init` and continue using the local
commands without an account. For connected use, pair your machine with your
active invited Workspace, confirm sharing consent, then preview and approve a
push. Both paths retain the same local analysis tools.

You use the browser to authorize enrollment and sharing in Settings → Machines.
**It does not need to stay open afterward.** The CLI sends later pushes directly
using its retained device credential, while the grant, membership and sharing
policy remain valid. Open Workspace whenever you want to review accepted data
or manage access; keeping its tab open does not trigger a push.

## Three separate connections

| Action | What it does | What it does not do |
| --- | --- | --- |
| `connect openai` / `connect anthropic`, then `sync-provider` | Reads supported provider records into local CLI state after explicit setup. | Does not enroll a machine in Workspace or upload the local provider ledger. |
| `workspace connect`, then `workspace push` | Pairs a machine, then shares eligible local session facts after separate scope consent and preview approval. | Does not connect provider billing, send dollars or upload all CLI data. |
| Workspace Connections | Sets up hosted provider ingestion with the required admin permissions. | Does not automatically gain access to local agent transcripts. |

## Pair, review and push

1. Use Node.js 22+ and open an interactive terminal. Start with:

   ```bash
   npx aibill@latest workspace connect
   ```

2. Confirm preparation of the local device key and public request. Open
   [Settings → Machines](https://app.asktilden.com/settings/machines) in your
   invited Workspace. Follow the browser enrollment instructions using that
   public request. Review the Workspace and policy, then run the response
   command supplied by the flow in your terminal:

   ```text
   npx aibill@latest workspace connect <response-bundle>
   ```

   Replace the placeholder with the exact response from Workspace. Confirm the
   displayed Workspace and enrollment policy. Treat that response bundle
   as sensitive; do not paste it into an issue or chat.
3. Finish the all-repository sharing consent in Settings → Machines. Pairing
   alone sends no local session facts. The current CLI flow does not offer a
   per-push repository picker; read the scope and preview before consenting.
4. Inspect local pairing state:

   ```bash
   npx aibill@latest workspace status
   ```

   This reads local state only. It does not contact the server or prove that
   the grant is still valid.
5. Preview the eligible facts and decide whether to send them:

   ```bash
   npx aibill@latest workspace push
   ```

   A new push reads a bounded 30-day window ending at today’s UTC midnight.
   Only closed days within the grant’s authorized collection period are
   eligible. Review the exact payload, exclusions and missing components.
   Confirming sends that batch. Connection, a normal receipt, statusline
   refresh and the local `watch` command do not schedule Workspace pushes.
   A batch contains at most 256 changed facts; a successful push is not a
   promise that all eligible history has been uploaded. Follow the next
   preview if more facts remain.

## What is shared

Facts include UTC day, agent/provider, model, session count, supported token
components, a project label where available, and hashed directory/session
identities used to distinguish records. Project labels can identify work;
this is not an anonymous activity feed. Unsupported token components remain
unknown rather than zero. Gemini activity is not part of this upload.

The push excludes raw prompts, transcript contents, file contents, full paths,
raw session IDs, dollar amounts, provider credentials, saved reports and local
experiment/approval records. The local provider ledger is not part of the
payload. Pairing uses separate device credentials kept in private local state.

Machine activity is context for the spending review. It is not provider-billed
cost, proof of a person’s spend, an accepted outcome, productivity or ROI.
Provider records have their own dates, coverage and labels.

### The subscription tier

So Workspace can cost Claude Code and Codex sessions at the plan that ran them,
a push can also send one subscription-tier fact per agent signed in on the
machine.

**What is sent.** Exactly seven fields: the kind (`agent_plan`), the agent
(`claude_code` or `codex`), a normalized tier id such as `claude_max_20x` or
`chatgpt_pro` (`unknown` when the CLI does not recognize the string), the raw
tier string exactly as the agent stored it, where it was read
(`~/.claude.json` → `oauthAccount.organizationRateLimitTier`, or the
`chatgpt_plan_type` claim of the id token in `~/.codex/auth.json`, decoded
locally without any network call), the instant it was read, and the UTC day the
subscription runs to when the agent recorded one. Nothing else from those files
is read into the fact: no token, email, name, account id, organization name or
uuid. A missing or unreadable file yields no fact and no error. A Claude Team or
Enterprise seat sends no Claude tier yet: its tier is read from
`oauthAccount.organizationType`, a source Workspace does not accept yet, so that
fact stays on the machine, and `workspace status` says so while no Claude tier has
been reported. Any other agent's tier on that machine is unaffected.

If Workspace already accepted a tier for that agent and the seat then moves to Team
or Enterprise, the agent signs out, or it moves to an API key, Workspace hears nothing
new. It keeps the last tier until that fact's retention ends and can cost sessions at
it until then; the owner can change the seat plan in Workspace. Each push that reads
the sign-in files prints one line naming the agent, that tier and when it was accepted.
`workspace status` reads no sign-in file, so it still shows that tier as last reported.

**When it is sent.** Only after this Workspace has announced, on an accepted push
(a response header, never the receipt body), that it accepts tier facts. Until
then no sign-in file is read. `workspace status` shows whether it has. After that:

- **The push that learns the announcement** offers the tier in the same command.
  Once that push's batch is accepted, a second preview shows the tier facts, and
  they go as their own batch if you confirm.
- **A push with changed session facts** carries the tier facts beside them, in the
  one preview and one batch.
- **A push with no changed session facts** previews and sends the tier facts alone
  only if this Workspace has never accepted them, they changed, or it last accepted
  them more than 14 days ago. That refresh runs inside the device policy's retention,
  so a machine that keeps pushing keeps its tier readable. Otherwise nothing is sent
  and the push says `No changed eligible local session facts to push.`

Declining a tier preview sends nothing and retains nothing; the next push offers
it again. A push that has nothing else to send and no announcement yet has nothing
to learn it from, so the tier waits for the next batch of session facts.

**What stays on the machine.** `~/.aibill/workspace-device.json` records, per
agent, the tier id, the raw tier string and when Workspace last accepted them. That
record changes only on an accepted push. `workspace status` shows the agent, the tier
id and the time. While a batch is pending, the same file retains the exact signed
envelope, tier facts (those seven fields) included, until it is resolved.

**If it does not arrive.** A batch of tier facts alone that Workspace refuses is
dropped, not retained: one line says the tier facts were not accepted, the CLI
sends none until a later accepted push announces them again, and session pushes
continue. If a reply is lost, the exact signed envelope is retained and the next push
asks about it. Yes resends it identically, because only the identical envelope can be
reconciled by the Workspace's replay receipt. No, or no answer, drops it. Session
facts wait only for that answer, because a batch of tier facts alone holds none to
reconcile. A batch that reached Workspace before its reply was lost stays there
whichever you answer, until a later tier replaces it.

**Leaving it out.** Set `AIBILL_NO_PLAN_TIER=1` to leave tiers out of every new
batch: no sign-in file is read, and neither the follow-up nor a tier-only batch is
offered. A retained batch of tier facts alone is dropped without asking, one line says
so, and the push goes on. A retained batch that also holds session facts is never
rebuilt and is resent exactly as signed, tier facts included, so the opt-out applies
from the next new batch and the preview says so. Workspace then costs those sessions
at a tier the owner types by hand.

## If setup or sharing does not complete

- **Unused request expired or cancelled:** `workspace connect --restart`
  explicitly replaces only an unused request. It cannot reset an uncertain
  exchange or a connected machine.
- **Enrollment outcome unknown:** inspect Settings → Machines. Follow the
  recovery instructions; do not replay the response bundle or create another
  enrollment to bypass uncertainty.
- **Local source reading incomplete:** no new facts are sent. Use the displayed
  diagnostic counts for support; do not delete logs or reconnect as a repair.
- **Push outcome unknown:** the exact signed batch is retained. `workspace push`
  asks you to review and explicitly retry that same batch. For a batch of
  subscription tier facts alone, answering no, or not answering, drops it and session
  pushes continue.
- **Batch refused:** resolve the refusal first. Reconnecting is not a substitute
  for resolving a refused batch. A batch of subscription tier facts alone is the
  exception: it is dropped, one line says so, and session pushes continue.

To stop future machine sharing:

```bash
npx aibill@latest workspace disconnect
```

The CLI asks for revocation and removes completed local pairing only after a
matching receipt. If the outcome is uncertain, uploads are blocked and local
keys remain. Follow the command’s guidance; `workspace disconnect --retry`
requires confirmation to repeat the identical retained request. Abandoning an
unused request removes its local key and does not claim remote revocation.
Disconnect does not promise deletion of previously accepted data; see the
[hosted privacy policy](https://asktilden.com/privacy).

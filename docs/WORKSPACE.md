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

Type every Workspace command as `npx aibill@latest workspace ...`; this page shortens
them in prose. A CLI refuses a pairing file that carries keys it does not know, so a
version older than the one that last wrote `~/.aibill/workspace-device.json`, such as
one left in an npx cache, stops and changes nothing. From this release on it says the
file was written by a newer aibill and names the command to run. Released versions
before it print `Workspace operation stopped safely. Local state was not reset; inspect
pairing status and permissions before continuing.` Nothing is wrong with the file:
run the same command with `npx aibill@latest`.

## Three separate connections

| Action | What it does | What it does not do |
| --- | --- | --- |
| `connect openai` / `connect anthropic`, then `sync-provider` | Reads supported provider records into local CLI state after explicit setup. | Does not enroll a machine in Workspace or upload the local provider ledger. |
| `workspace connect`, then `workspace push` | Pairs a machine, then shares eligible local session facts after separate scope consent and preview approval. | Does not connect provider billing, send dollars or upload all CLI data. |
| Workspace Connections | Sets up hosted provider ingestion with the required admin permissions. | Does not automatically gain access to local agent transcripts. |

## Pair, review and push

1. Use Node.js 22+ and open an interactive terminal inside the Git checkout you
   want to report as this machine's initial repository. Start with:

   ```bash
   npx aibill@latest workspace connect
   ```

2. Confirm preparation of the local device key, then separately confirm the
   reported repository. The terminal shows its actual checkout directory locally.
   The signed public request includes only its safe display name and directory
   hash, alongside the device's public pairing fields. No raw path, remote URL,
   file content, or session facts are included. A directory hash identifies a
   local checkout; it does not prove which remote repository owns it.

   Open
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

   Repository confirmation does not authorize uploads or all-repository sharing.
   Fresh requests use version 2 and need Workspace support for repository
   bootstrap. Release and Workspace activation must be coordinated; this local
   implementation is not evidence that hosted self-service enrollment is active.
   For an existing administrator-prepared project and reader setup, explicitly
   use `workspace connect --prepared`. This creates the original version 1
   request and does not require a local repository. Either version of an unfinished
   request is reused unchanged until an explicit `--restart`; version 2 responses
   cannot silently fall back to version 1.
3. Finish the all-repository sharing consent in Settings → Machines. After pairing,
   the terminal offers to preview your first push immediately. Say yes when the
   browser consent is complete, then review and approve the exact batch. Declining
   reads and sends no session facts; you can run `workspace push` later. The CLI
   does not offer a per-push repository picker.
4. Inspect local pairing state:

   ```bash
   npx aibill@latest workspace status
   ```

   This reads local state only. It does not contact the server or prove that
   the grant is still valid. It shows when this connection ends, and says so once it
   has.
5. Preview the eligible facts and decide whether to send them:

   ```bash
   npx aibill@latest workspace push
   ```

   A new push reads a bounded 30-day window ending at today’s UTC midnight.
   Only closed days within the grant’s authorized collection period are
   eligible. Review the exact payload, exclusions and missing components.
   Confirming sends that batch. Daily uploads require the separate opt-in below;
   a normal receipt, statusline refresh and local `watch` never enable them.
   A batch contains at most 256 changed facts and 262,144 bytes, so a successful
   push is not a promise that all eligible history has been uploaded. A batch carries
   whole days, oldest first, because Workspace reads what it holds of a day as that
   day, so the days that wait are absent from Workspace, not short. When a new batch
   holds only part of the changed facts, its preview says so and the accepted line
   says how many wait. A day with more changed facts than its batch can carry goes in
   part, and both lines name it. A retained batch is resent as it was signed and says
   nothing of what waits behind it. Run the push again and follow the next preview.

## Optional daily uploads

After pairing, run this in an interactive terminal:

```bash
npx aibill@latest workspace push --schedule daily
```

Review the scope and answer yes to authorize future batches without their individual
previews. This is separate from the Workspace's all-repository sharing consent, which
must also be complete. The command installs a user launchd agent on macOS or a cron
entry on other systems with `crontab`, scheduled for 09:17 local time. It does not
upload immediately; use `workspace push` for an immediate preview.

Each run reads the last 30 closed UTC days and sends one bounded batch, plus a
subscription-tier follow-up when Workspace first announces support. Large backlogs
may need additional manual pushes. A machine must be available to run: macOS may
run a missed job after wake, while cron does not catch up a missed time. No hourly
or always-on sharing is implied.

The setup retains a private copy of the exact installed CLI and its dependencies
under `~/.aibill/workspace-sync/`, so deleting an npx cache does not break the job.
The schedule uses the current absolute Node.js executable; **run the setup command
again after updating aibill or replacing Node.js**. It does not download new code
each day. No device token, private key, payload or project label appears in the
launchd/cron entry. Windows scheduling is not supported yet.

Standing consent is tied to this machine's current Workspace grant. Changing the
grant invalidates it; an expired or disconnected connection cannot upload. A retained
uncertain or refused batch stops unattended runs until you review `workspace push`
in a terminal. An incomplete local scan also stops the upload. `workspace status`
shows whether daily sync is authorized and when its last run completed or stopped.

Set `AIBILL_NO_PLAN_TIER=1` when enabling the schedule to exclude subscription-tier
facts from its new batches. Changing a shell variable later does not change an
already-installed job; remove or reconfigure the schedule to change that choice.

Remove the schedule and its standing consent anytime, without disconnecting:

```bash
npx aibill@latest workspace push --schedule none
```

Manual pushes continue to require an interactive terminal and approval of the exact
payload. There is no general noninteractive `--yes` upload flag.

## What is shared

Facts include UTC day, agent/provider, model, session count, supported token
components, a project label where available, and hashed directory/session
identities used to distinguish records. Project labels can identify work;
this is not an anonymous activity feed. Unsupported token components remain
unknown rather than zero. Gemini activity is not part of this upload.

The project label names the repository a session's folder belongs to: the checkout
that holds the folder, or the main checkout for a linked worktree, found from `.git`
without running git, so worktrees and sub-folders land in one project. A folder
outside any checkout keeps its own name. Workspace keys a fact on its label and keeps
what it accepts, so a fact that has gone out keeps the label it went out under,
whatever later happens to the folder. `~/.aibill/workspace-device.json` remembers
the labels each folder's facts went out under, keyed by the hashed folder, and that
stays on this machine. A folder with no checkout left to find keeps the label it last
went out under on its later days.

A session's folder is where each of its turns ran: the working directory on each Claude
Code log line, and for Codex the latest `turn_context` before each token count. Earlier
versions filed a Codex session wholly under the folder it started in. Where one of them
already sent a Codex day, model and folder under a name this version can find, every event
it would have filed there stays there; every other Codex event takes its own turn's folder, on a day already sent as on a
new one. Each Codex day is decided once, by the first push of this version that reads it,
against what earlier versions sent for it; `~/.aibill/workspace-device.json` keeps the first
and last day decided and hashes of the sent folders on them. A push also reads the sessions
Codex compressed into `.jsonl.zst` after 7 idle days, which needs Node.js 22.15 or later
(23.8 or later on Node.js 23).

A Claude Code response counts once, however many session files hold it. Forking or
handing off a conversation copies its earlier responses into a new session file,
sometimes in another folder, under a new session id with the same request id, usage
and timestamp. Within one read, such a response counts under the original session:
the copy outside a sub-agent transcript, else the earliest, else the one in the
transcript that started earlier (a fork's file opens at fork time, after every
response it copied), else the lower session id, so the choice is the same on every
run and in every reader. The fact it lands in keeps its day, model, project and
folder; only the copies' counts go. A copy whose usage differs is not the same
response and counts on its own; a copy with no usage at all beside one that has usage
is a copy and goes. Versions before this one removed copies
only within one session, so a machine whose earlier push counted a forked copy sends
the corrected, smaller fact on its next push as a revision of the same fact; days
outside the 30-day window are not read again, so facts sent for them do not change.

The push excludes raw prompts, transcript contents, file contents, full paths,
raw session IDs, dollar amounts, provider credentials, saved reports and local
experiment/approval records. The local provider ledger is not part of the
payload. Pairing uses separate device credentials kept in private local state.

Machine activity is context for the spending review. It is not provider-billed
cost, proof of a person’s spend, an accepted outcome, productivity or ROI.
Provider records have their own dates, coverage and labels.

### Retention

Accepted session and subscription-tier facts carry an expiry set by the machine's
sharing policy: acceptance time plus that policy's retention period. Check the
period displayed in Settings → Machines when reviewing sharing consent; there is
no universal period asserted by this CLI. An accepted revision or tier refresh
starts its retained fact's period again. Unchanged facts are not extended merely
by running another push.

Workspace stops reading expired facts. Disconnecting also removes that machine's
facts from project and receipt reads. Neither means the stored rows have been
physically deleted. An existing seat plan is separate: it stays until the owner
changes it, even when the tier fact that informed it expires.

Directory references are currently unkeyed hashes of absolute working-directory
paths. They are not raw paths, but someone who guesses a path can calculate its
hash; unlike session identities, they are not device-keyed. Changing that identity
scheme requires a coordinated CLI/Workspace migration and remains a product
decision. No change to existing references is made by daily sync.

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
or Enterprise, the agent signs out, or it moves to an API key or another kind of
organization, Workspace hears nothing new about the last tier it accepted.
Workspace reads it until that fact's retention ends or this machine disconnects; neither deletes the stored row or moves a seat plan set from it.
A seat plan can be set from it while Workspace reads it, and a seat plan set from it
stays until the owner changes it in Workspace: no later report moves it.
Each push that reads the sign-in files prints one line naming the agent, that tier and
when it was accepted. `workspace status` reads no sign-in file, so it still shows that
tier as last reported.

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
to learn it from. That push says so in one line, and reads no sign-in file to say it,
so it cannot know whether this machine has a tier to offer:

```text
Subscription tier: off until an accepted push announces it, so no sign-in file was read and none was sent. If this machine reports one Workspace accepts, it is offered right after that push, which needs session facts from a UTC day that has closed.
```

**What stays on the machine.** `~/.aibill/workspace-device.json` records, per
agent, the tier id, the raw tier string and when Workspace last accepted them. That
record changes only on an accepted push. `workspace status` shows the agent, the tier
id and the time. While a batch is pending, the same file retains the exact signed
envelope, tier facts (those seven fields) included, until it is resolved.

**If it does not arrive.** A batch of tier facts alone that Workspace refuses is
dropped, not retained: one line says the tier facts were not accepted, the CLI
sends none until a later accepted push announces them again, and session pushes
continue. A refusal as `expired` speaks of the batch's age or this machine's clock and
not of what Workspace accepts, so the next push offers them again. If a reply is lost, the exact signed envelope is retained and the next push
asks about it. Yes resends it identically, because only the identical envelope can be
reconciled by the Workspace's replay receipt. No, or no answer, drops it. Session
facts wait only for that answer, because a batch of tier facts alone holds none to
reconcile. A batch that reached Workspace before its reply was lost stays there
whichever you answer, until a later tier replaces it, and a seat plan already set from
it stays until the owner changes it.

**Leaving it out.** Set `AIBILL_NO_PLAN_TIER=1` to leave tiers out of every new
batch: no sign-in file is read, and neither the follow-up nor a tier-only batch is
offered. A retained batch of tier facts alone is dropped without asking, one line says
so, and the push goes on. A retained batch that also holds session facts is never
rebuilt and is resent exactly as signed, tier facts included, so the opt-out applies
from the next new batch and the preview says so. On a machine that never reported a
tier, Workspace then costs those sessions at a tier the owner types by hand. The
opt-out stops what this machine sends and withdraws nothing. For a tier Workspace
already accepted:
Workspace reads it until that fact's retention ends or this machine disconnects; neither deletes the stored row or moves a seat plan set from it.
That seat plan stays until the owner changes it.

## If setup or sharing does not complete

- **Unused request expired or cancelled:** `npx aibill@latest workspace connect --restart`
  explicitly replaces only an unused request. It cannot reset an uncertain
  exchange or a connected machine.
- **Enrollment outcome unknown:** inspect Settings → Machines. Follow the
  recovery instructions; do not replay the response bundle or create another
  enrollment to bypass uncertainty.
- **Local source reading incomplete:** no new facts are sent. Use the displayed
  diagnostic counts for support; do not delete logs or reconnect as a repair.
- **Push outcome unknown:** the exact signed batch is retained. `npx aibill@latest workspace push`
  asks you to review and explicitly retry that same batch. If it had reached
  Workspace, Workspace answers with the same receipt however late the retry, and no
  fact is counted twice. For a batch of subscription tier facts alone, answering no,
  or not answering, drops it and session pushes continue.
- **Batch too old:** a batch Workspace does not hold, resent more than 10 minutes after
  it was signed, is refused as `expired`. Workspace did not store it, so this machine
  drops it. The next `npx aibill@latest workspace push` rebuilds its session facts into
  a new batch, with a new preview and your yes, and sends nothing without it. What it
  held for days that have left that push's 30-day window is not rebuilt and stays out of
  Workspace, and the line says where the window starts. A machine an earlier CLI stopped
  on such a batch drops it on its next push, the same way.
- **This machine's clock is off:** a clock more than 2 minutes ahead of Workspace's, or
  more than 10 minutes behind it, gets the same refusal on a first send. The batch is
  dropped in the same way and the line says to check the clock. Nothing retries by
  itself: each new batch takes another push and another yes.
- **Batch refused as `invalid`, `conflict` or `stale`:** the batch stays retained and
  later pushes stop, so resolve the refusal first. Reconnecting is not a substitute
  for resolving a refused batch. A batch of subscription tier facts alone is the
  exception: it is dropped on any refusal, one line says so, and session pushes
  continue.
- **Another command holds the lock, or one was killed:** a Workspace command holds
  `~/.aibill/.workspace-device.lock` while it works with the pairing file, through the
  preview and the send. A command that is killed leaves the file behind, and a closed
  terminal or a dropped SSH session is enough. The next command removes the file
  when the process it names is gone, and goes on. When it cannot tell, because a version
  before this one wrote no process into the file, the process ran on another host, or its
  number is in use again, it stops with `Another aibill Workspace command holds
  ~/.aibill/.workspace-device.lock, or one was killed and left it. If none is running,
  delete that file and run this command again.` `workspace status` says so too. Versions
  already published print their general stop here. Nothing is lost: a batch on its way
  when the command died is retained as an unknown outcome, and the next push asks about it.
- **One fact over its session bound:** a fact carries at most 1,024 session identities for
  one day, one model and one folder, and it cannot be split. More than that stops the push
  before any batch exists. The line names the day and the count, and when that day leaves
  the 30-day window a push reads. No facts are replaced or sent until then, and days that
  leave the window meanwhile stay out of Workspace. Share the line for help; do not delete
  logs or reconnect as a repair.
- **Compressed Codex sessions on an older Node.js:** Codex compresses a session it has not
  written to for 7 days, and reading it needs Node.js 22.15 or later (23.8 or later on
  Node.js 23). On an older one, a push with such a session inside its 30-day window stops
  before any batch exists, with one line that names the Node.js it needs: a day built without
  that session would go out short. Update Node.js and push again.
- **Calls with no usable day or identity:** a daily fact built without such a call would
  undercount its day, so one call in the window stops the push before any batch exists,
  for example a log line with no working directory or session. The line counts them by
  reason, without paths or contents. No facts are replaced or sent until those calls leave
  the 30-day window, and days that leave it meanwhile stay out of Workspace. Share the
  counts for help; do not delete logs or reconnect as a repair.
- **Workspace answered 403:** it will not take a push from this machine right now, and the
  CLI cannot tell why, so the outcome stays unknown and the batch stays retained. One more
  line points at Settings → Machines. If it asks for this machine's sharing consent, finish
  that and push again. If it shows this machine disconnected or expired, run
  `npx aibill@latest workspace disconnect`, then `npx aibill@latest workspace connect`; that
  disconnect removes the retained batch.
- **Connection ended:** a connection has an end, and `workspace status` shows it. Past
  it, Workspace refuses every push, including a resend of a retained batch, before it
  can look for a replay. So `workspace push` stops with exit 1, reads no session facts
  and sends nothing, and says what to run. Nothing renews a connection. To connect
  again, run `npx aibill@latest workspace disconnect`, which still works past the end,
  then `npx aibill@latest workspace connect` and follow the steps above. `connect` on
  its own refuses while this machine holds a pairing, and Settings → Machines offers
  this source again only once the old connection is revoked; if it offers none after
  that, ask your Workspace administrator to admit this machine. The new connection
  starts no earlier than the UTC day after the disconnect and cannot reach back. Any
  day before that which has not reached Workspace stays out of it, and that includes a
  retained batch, which the disconnect removes. The disconnect has a second cost, and
  the stop, `workspace status` and the disconnect's own question say so: Workspace goes on
  reading a lapsed machine's accepted session facts, and stops reading a disconnected machine's. They leave Workspace's projects and receipts,
  and those days' seat and API-key shares move to unattributed cost. The stored rows stay.
  If the time shown has not passed, check this machine's clock first: a disconnect cannot
  be undone.

To stop future machine sharing:

```bash
npx aibill@latest workspace disconnect
```

The CLI asks for revocation and removes completed local pairing only after a
matching receipt. If the outcome is uncertain, uploads are blocked and local
keys remain. Follow the command’s guidance; `npx aibill@latest workspace disconnect --retry`
requires confirmation to repeat the identical retained request. Abandoning an
unused request removes its local key and does not claim remote revocation.
Workspace stops reading a disconnected machine's accepted session facts: they leave its
projects and receipts, and those days' seat and API-key shares move to unattributed cost.
Disconnect does not promise deletion of previously accepted data; see the
[hosted privacy policy](https://asktilden.com/privacy).

# Connect aibill to Tilden Workspace

**Keep working locally and bring supported activity into your team’s spending
review.** aibill works both as a free standalone CLI and as a connected local
tool for members of an invited
[Tilden Workspace](https://asktilden.com/docs/workspace).

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
  asks you to review and explicitly retry that same batch.
- **Batch refused:** resolve the refusal first. Reconnecting is not a substitute
  for resolving a refused batch.

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

## Ask about your hosted reports

[Workspace MCP](https://asktilden.com/docs/mcp) provides assisted read-only access
to hosted spend, projects, briefing and budget settings. The **Plugin / ChatGPT
Pilot** uses that hosted connection and requires confirmed private access. It is
not publicly listed. Neither is the [local npm MCP server](MCP.md) or the
[local Codex plugin](../plugins/aibill/README.md).

[Join the waitlist](https://asktilden.com/?ref=github-workspace-guide#beta) for
updates and access invitations. Joining does not create a Workspace or activate
a provider, machine or AI-client connection.

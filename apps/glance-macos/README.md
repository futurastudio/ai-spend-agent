# aibill Glance for macOS

This is the native hover prototype for the small panel below the
camera/notch. It stays fully hidden until the pointer reaches the top menu bar;
then a stationary liquid-glass `aibill` wordmark appears immediately left of
the camera and reveals the panel on hover. It is a rendering surface over the
same transcript-derived evidence contract used by the CLI and MCP server:
current work, cost meaning, reported runway, freshness, and one next action.
Company accountability and ROI remain Workspace milestones, not Glance claims.
Source/connector validation and a number's financial-evidence status are
separate axes; Glance never upgrades an estimate because its local reader has
been tested.

## Local prototype

Requirements:

- macOS 14 or newer
- Swift/Xcode command-line tools
- Node 22 and a built local checkout of this public repository
- Apple silicon for the current local build (the public artifact should be
  built as a universal app)

Clone the repository wherever you keep development projects, then build the
shared engine and app from the checkout root:

```bash
git clone https://github.com/futurastudio/ai-spend-agent.git
cd ai-spend-agent
npm run build --workspace ai-spend-agent
./apps/glance-macos/scripts/build-app.sh
```

The unsigned local app is written to:

```text
apps/glance-macos/dist/aibill Glance.app
```

It runs as a menu-bar accessory without a Dock icon. At rest, nothing is
visible. Move the pointer into the top menu-bar strip to reveal one tiny,
stationary `aibill` glass wordmark to the left of the camera/notch. Hover that
wordmark to slide the panel down; move away to hide both surfaces again. No
click is required. Right-click the visible wordmark to refresh data, enable or
disable launch at login, check for a signed update in release builds, or quit
the app.

For a source build, point Glance at the CLI in the current checkout and launch
the app binary from the same shell:

```bash
export AIBILL_GLANCE_COMMAND="$PWD/packages/cli/dist/index.js"
export AIBILL_NODE_PATH="$(command -v node)"
"$PWD/apps/glance-macos/dist/aibill Glance.app/Contents/MacOS/AibillGlance"
```

`AIBILL_GLANCE_COMMAND` must be a filesystem path, not a shell command or a
string containing arguments. It may point either to the built JavaScript entry
above or to an executable `ai-spend-agent` binary. When it points to
JavaScript, `AIBILL_NODE_PATH` can identify the Node executable; otherwise
Glance checks its supported standard Node locations.

The current source preview resolves data in this order:

1. the valid path in `AIBILL_GLANCE_COMMAND`;
2. `packages/cli/dist/index.js` beneath the current working directory when the
   app binary is launched from a built source checkout;
3. an executable `aibill` or `ai-spend-agent` at `~/.local/bin`,
   `~/.npm-global/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`.

It does not search an arbitrary shell `PATH`. For every executable candidate,
Glance appends `glance --since-days 30`; for a JavaScript candidate it runs
Node with the script path followed by those same arguments. It never invokes a
shell. Nothing is uploaded. Transcript-reported values remain reported,
API-equivalent session value and exhaustion remain labeled estimates, and
missing limits remain unavailable. When local account metadata identifies a
subscription, Glance shows the plan and makes clear that API-rate value is not
an added charge.
The Main focus row summarizes what occupied the user across observed prompts
and tool calls; its percentage is activity share, not elapsed time or spend.
Raw prompts never enter the Glance JSON contract.

The footer shows `Updated 12s ago` from the last successful local snapshot.
Refresh attempts start on a 30-second cadence; the next attempt subtracts the
time spent generating the prior snapshot instead of waiting another 30 seconds.
After 75 seconds it changes to an explicit stale state. A failed refresh keeps
the last good snapshot visible and labels its age; a first-run failure says
that no current data is available. Copy is disabled for stale or failed
evidence, and the local CLI subprocess fails visibly after 75 seconds instead
of blocking forever. Use the row's Refresh action or right-click the wordmark
to retry.

The final compact row renders one focus-aware next move derived from the
canonical hook-aware Context Health result, Main focus, and any
transcript-reported runway. It stays to two short lines plus a small Copy
affordance; the complete handoff prompt is never displayed in the hover card.
Clicking copies a project-aware **session handoff** for any coding agent. That
handoff includes its evidence window, current session value/meaning, focus,
Context Health confidence, the reported reset time, and a separately labeled
projected exhaustion time when available. It is deliberately not the fuller financial optimization plan from
`npx aibill apply`. Glance does not launch an
agent, execute the prompt, run a hook command, or invent a hook's runtime token
payload.

The visible card keeps provenance beside the metric: session value says local
tokens × API list rates; limit rows distinguish coding-agent-reported reset
data from the local exhaustion estimate; Main focus says local activity; and
the footer names the detected local agents, parsed-file count, and upload
status. Hovering a section provides a longer source explanation without
adding another crowded row.

The JSON snapshot also includes a `provenance` object for every renderer. It
identifies the user-specific agent sources, the published-price table date,
reported limit windows, local focus/anomaly derivations, and
`network.uploaded: false`. Its `sessionHealth` object is the full shared
contract; custom renderers should consume it rather than recomputing a
different recommendation.

## Customize or fork it

Glance is MIT-licensed. You can use the native panel as-is, restyle it, or
build another interface over the same JSON contract:

```bash
node packages/cli/dist/index.js glance --since-days 30
```

The main customization points are:

| File | What to change |
| --- | --- |
| `GlanceView.swift` | Compact/expanded content, colors, materials, typography, and animation |
| `GlancePanelController.swift` | Panel sizes, screen placement, window level, and space behavior |
| `GlanceStore.swift` | Refresh cadence and view state |
| `SnapshotLoader.swift` | How the app locates the shared local `aibill` engine |
| `Models.swift` | Typed JSON contract and display formatting |

Keep these trust invariants in customized versions:

- Read data through `aibill glance`; do not add a second transcript parser to
  the UI.
- Keep transcript-reported limits distinct from projected exhaustion.
- Keep API-equivalent value labeled as an estimate, never as a subscription
  charge.
- Keep Main focus activity-derived and keep raw prompt text out of the UI
  contract.
- Render `sessionHealth` from the shared contract; do not invent a second
  session threshold or hook-cost estimate in the UI.
- Render `primaryAction` from the shared contract. Keep its full `agentPrompt`
  out of the compact card and require a deliberate copy/paste before an agent
  can act. Treat `kind: session_handoff` separately from the CLI Apply plan.
- Do not allow stale or failed snapshots to be copied as current evidence.
- Render missing limits as unavailable instead of guessing.
- Do not upload transcripts or invoke the data command through a shell.

For a different UI stack, treat the output of `aibill glance` as the stable
integration boundary. A menu-bar app, Raycast extension, desktop widget, or
editor extension can all render that contract without duplicating spend logic.

## Public distribution

Users should not have to clone the repo or ask an AI to install Glance.

Glance is currently an unsigned, source-built preview—not a public Mac
download. If you actively use Claude Code or Codex and want to volunteer for
the 8–12-person comprehension study, [register your interest through the
design-partner form](https://ai-spend-agent.vercel.app/?ref=glance-study#beta).
The form records study interest; it does not promise immediate access to a
signed build.

1. Publish a Developer ID-signed and Apple-notarized `.dmg` in GitHub Releases.
2. Link the same download from the website.
3. Offer `npx aibill glance install` as an optional power-user installer that
   downloads and verifies that exact release artifact.
4. Keep the source-build path documented for contributors.

The release bundle must include a versioned Glance data helper so website
users do not need Node, npm, or a source checkout. The Mac app, helper, and
universal binary slices must be signed together, run with the hardened
runtime, notarized, and stapled before the `.dmg` is published.

The prototype is ad-hoc signed for local testing only. Do not distribute the
`dist` bundle publicly. Release builds use Sparkle 2.9.2 but the updater stays
dormant unless the build embeds both an HTTPS appcast URL and its matching
EdDSA public key.

### Maintainer release gate

Store the Developer ID certificate in the login keychain and a notarization
profile with `xcrun notarytool store-credentials`. Keep the Sparkle private key
outside the repository. Then provide these settings to
`scripts/release-app.sh`:

```text
AIBILL_GLANCE_SIGN_IDENTITY
AIBILL_GLANCE_VERSION
AIBILL_GLANCE_BUILD_NUMBER
AIBILL_NOTARY_KEYCHAIN_PROFILE
AIBILL_SPARKLE_FEED_URL
AIBILL_SPARKLE_PUBLIC_KEY
AIBILL_SPARKLE_PRIVATE_KEY_FILE
```

The script refuses missing credentials or a non-HTTPS feed, builds a universal
app, embeds the updater configuration, signs with the hardened runtime,
submits to Apple notarization, staples and validates the ticket, produces the
final update ZIP, and generates a signed appcast. A successful script run is a
release prerequisite; the presence of this source code alone is not evidence
that a public artifact is signed or notarized.

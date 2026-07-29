# aibill Glance for macOS

This is the native hover prototype for the small panel below the
camera/notch. It stays fully hidden until the pointer reaches the top menu bar;
then a stationary liquid-glass `aibill` wordmark appears immediately left of
the camera and reveals the panel on hover. It is a rendering surface over the
same transcript-derived Glance contract used by the CLI and MCP server.

## Local prototype

Requirements:

- macOS 14 or newer
- Swift/Xcode command-line tools
- Node 22 and a built local checkout of `agent-finops`
- Apple silicon for the current local build (the public artifact should be
  built as a universal app)

Build the shared engine and app:

```bash
cd ~/agent-finops
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
click is required. Right-click the visible wordmark to refresh data or quit
the app.

The app resolves data in this order:

1. `AIBILL_GLANCE_COMMAND`
2. `~/agent-finops/packages/cli/dist/index.js`
3. a locally installed `ai-spend-agent` executable

It executes `aibill glance --since-days 30` without a shell. Nothing is
uploaded. Transcript-reported values remain reported, API-equivalent session
value and exhaustion remain labeled estimates, and missing limits remain
unavailable. When local account metadata identifies a subscription, Glance
shows the plan and makes clear that API-rate value is not an added charge.
The Main focus row summarizes what occupied the user across observed prompts
and tool calls; its percentage is activity share, not elapsed time or spend.
Raw prompts never enter the Glance JSON contract.

The final compact row renders the canonical hook-aware Context Health result
used by `aibill context --json` and MCP `get_context_health`. A “start fresh”
decision comes from this user's same-agent transcript-token median. Installed
hook metadata can instead produce a review action, but Glance never executes a
hook command or invents the hook's runtime token payload.

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
- Render missing limits as unavailable instead of guessing.
- Do not upload transcripts or invoke the data command through a shell.

For a different UI stack, treat the output of `aibill glance` as the stable
integration boundary. A menu-bar app, Raycast extension, desktop widget, or
editor extension can all render that contract without duplicating spend logic.

## Public distribution

Users should not have to clone the repo or ask an AI to install Glance.

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
`dist` bundle publicly.

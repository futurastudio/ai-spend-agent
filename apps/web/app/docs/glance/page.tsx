import type { Metadata } from "next";
import { CodeBlock, DocsCallout, DocsPage, DocsSection, TextLink } from "@/components/DocsPage";

export const metadata: Metadata = {
  title: "aibill Glance macOS source preview",
  description: "Build the unsigned aibill Glance macOS hover preview from source and understand its data, freshness, and distribution boundaries.",
  alternates: { canonical: "/docs/glance" },
};

export default function GlanceDocsPage() {
  return (
    <DocsPage
      current="/docs/glance"
      title="A quiet monitor, not a second engine."
      intro="Glance is a native hover surface below the Mac camera area. It renders the shared aibill JSON contract and stays hidden until the pointer reaches the menu bar."
      repoPath="apps/web/app/docs/glance/page.tsx"
    >
      <DocsSection id="status" label="01 · Availability" title="Source preview only">
        <DocsCallout title="No public download yet" tone="preview">
          Glance is unsigned and built from source for testing. Do not redistribute the ad-hoc-signed app bundle. A public download requires a universal Developer ID-signed, Apple-notarized build with a stapled ticket and signed updates.
        </DocsCallout>
        <p>
          Current source-build requirements are macOS 14 or newer, Apple silicon, Swift/Xcode command-line tools, Node 22, and a built checkout of the public repository.
        </p>
      </DocsSection>

      <DocsSection id="build" label="02 · Build" title="Run the local prototype">
        <CodeBlock label="Terminal">{`git clone https://github.com/futurastudio/ai-spend-agent.git
cd ai-spend-agent
npm ci
npm run build --workspace ai-spend-agent
./apps/glance-macos/scripts/build-app.sh`}</CodeBlock>
        <p>The app is written to <code className="font-mono text-ink">apps/glance-macos/dist/aibill Glance.app</code>.</p>
        <CodeBlock label="Launch against this checkout">{`export AIBILL_GLANCE_COMMAND="$PWD/packages/cli/dist/index.js"
export AIBILL_NODE_PATH="$(command -v node)"
"$PWD/apps/glance-macos/dist/aibill Glance.app/Contents/MacOS/AibillGlance"`}</CodeBlock>
        <p>
          <code className="font-mono text-ink">AIBILL_GLANCE_COMMAND</code> must be a filesystem path, not a shell command or a string with arguments. Glance never invokes a shell.
        </p>
      </DocsSection>

      <DocsSection id="behavior" label="03 · Behavior" title="Hidden until it is useful">
        <ul className="list-disc space-y-3 pl-5 marker:text-faint">
          <li>At rest, no widget is visible. Moving into the top menu-bar strip reveals one stationary aibill wordmark to the left of the camera.</li>
          <li>Hovering the wordmark reveals the panel; moving away hides both surfaces. No click is required.</li>
          <li>Right-click offers refresh, launch-at-login, update check in release builds, and quit.</li>
          <li>The compact action remains two short lines. Copying it creates a session handoff; Glance never launches an agent or executes a change.</li>
        </ul>
      </DocsSection>

      <DocsSection id="data" label="04 · Data contract" title="Claude Code and Codex only">
        <p>
          Glance runs <code className="font-mono text-ink">aibill glance --since-days 30</code> and consumes the same typed contract as the CLI and MCP. It currently reads Claude Code and Codex data; Gemini is intentionally excluded from Glance.
        </p>
        <ul className="mt-5 list-disc space-y-3 pl-5 marker:text-faint">
          <li>Session value is local token evidence multiplied by published API list rates—an estimate, not a subscription charge.</li>
          <li>Limit windows appear only when a transcript reports remaining percentage and reset metadata. Projected exhaustion is separately labeled as a local pace estimate.</li>
          <li>Main focus is the share of observed prompt/tool activity in the focus window, not elapsed time or spend. Raw prompts do not enter the JSON contract.</li>
          <li>The next action uses canonical Context Health, focus, and reported runway. It is not the fuller <code className="font-mono text-ink">npx aibill apply</code> plan.</li>
        </ul>
      </DocsSection>

      <DocsSection id="freshness" label="05 · Freshness" title="Updated is not the same as rescanned">
        <p>
          Glance attempts a fresh local snapshot every 30 seconds. After 75 seconds without a successful snapshot, the data becomes explicitly stale. A failed refresh preserves the last good snapshot with its age, and copy is disabled for stale or failed evidence.
        </p>
        <p className="mt-4">
          This differs from the Claude Code statusline: the statusline re-renders its cache about every 30 seconds but needs an explicit refresh or init to rescan transcript evidence. See <TextLink href="/docs/cli#statusline">statusline freshness</TextLink>.
        </p>
      </DocsSection>

      <DocsSection id="customize" label="06 · Customize" title="Keep one source of truth">
        <p>
          The Swift view, panel controller, store, loader, and typed models are all public and MIT-licensed. Alternative menu-bar apps, Raycast extensions, widgets, or editor surfaces should consume <code className="font-mono text-ink">aibill glance</code> rather than adding a second transcript parser.
        </p>
        <p className="mt-4">
          Preserve the same invariants: reported limits versus projected exhaustion, estimates versus billed cost, stale-state protection, activity-derived focus, no raw prompt in the UI contract, and deliberate copy/paste before an agent can act.
        </p>
      </DocsSection>
    </DocsPage>
  );
}

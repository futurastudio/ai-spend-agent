import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "../../components/legal/LegalPage";

export const metadata: Metadata = {
  "title": "Privacy policy | Tilden",
  "description": "What stays on your computer, what Workspace receives, and the choices available to you.",
  "alternates": {
    "canonical": "/privacy"
  },
  "openGraph": {
    "title": "Privacy policy | Tilden",
    "description": "What stays on your computer, what Workspace receives, and the choices available to you.",
    "url": "/privacy"
  }
};

const sections: LegalSection[] = [
  {
    "id": "scope",
    "title": "Who we are and what this covers",
    "paragraphs": [
      "Tilden is operated by Futura Studio, LLC (\"Tilden\", \"we\", \"us\"). This policy covers asktilden.com, our public aibill CLI, and the hosted Tilden Workspace at app.asktilden.com. Workspace is currently invitation-only.",
      "The CLI and Workspace handle data differently. Local CLI analysis runs on your computer. Workspace is a hosted service that receives and stores account information, connected-provider data, and any machine summaries you choose to upload. Local-first CLI statements do not describe Workspace."
    ]
  },
  {
    "id": "website",
    "title": "Website, waitlist, and contact",
    "paragraphs": [
      "When you join the waitlist or opt in through the CLI, we receive your email address and may receive a referral or campaign identifier. We use these details to manage your request, invitations, and product communications. If you contact us, we receive the information you include in your message. You can ask us to stop sending product communications at contact@futurastudio.info.",
      "Our hosting and security infrastructure processes connection information such as IP addresses, request times, requested URLs, and browser or device information. The waitlist and telemetry endpoints also use IP addresses for temporary rate limiting. Avoid putting credentials or sensitive project information into URLs or support messages."
    ]
  },
  {
    "id": "cli",
    "title": "The public aibill CLI",
    "paragraphs": [
      "Local analysis reads supported coding-agent logs and produces reports on your computer. Local report generation does not send raw prompts, transcripts, source-file contents, or local report amounts to Tilden. Local state and reports remain under your control unless you explicitly connect, upload, export, or share them.",
      "Commands that fetch provider data send requests to the selected provider using credentials you supply. Local provider commands use the provider’s API; they do not route those credentials through Tilden’s marketing website. Optional Workspace connection is a separate hosted flow described below. Machine enrollment stores a device credential locally so that authorized uploads can be authenticated.",
      "If you expose aibill results to an MCP client, export a report, or share output, the receiving application or recipient can receive that information under its own practices. Installing or updating aibill also involves the package registry you use."
    ]
  },
  {
    "id": "cli-telemetry",
    "title": "CLI telemetry and your controls",
    "paragraphs": [
      "The CLI discloses usage telemetry on its first interactive run. That first notice does not send an event; subsequent runs may send limited usage events unless you turn telemetry off. Each event contains a random persistent installation identifier, an allowlisted command name, CLI version, operating system and architecture, a CI indicator, a duration range, success or failure, and a timestamp.",
      "The event schema excludes command arguments, flag values, paths, project names, prompts, transcripts, email addresses, provider credentials, and dollar amounts. The installation identifier makes these events pseudonymous, rather than completely anonymous. Transport and hosting infrastructure can still receive network metadata.",
      "Run \"aibill telemetry\" to inspect the status and last payload. Run \"aibill telemetry off\" to disable future events, or set DO_NOT_TRACK=1 or AI_SPEND_NO_TELEMETRY=1. CI also disables emission. Turning telemetry off does not delete previously received events. For a deletion request, contact us and include the installation identifier if available; do not send credentials."
    ]
  },
  {
    "id": "identity",
    "title": "Workspace accounts and sign-in",
    "paragraphs": [
      "Workspace uses Supabase Auth for Google sign-in, GitHub sign-in, and email sign-in. When you choose Google or GitHub, the authentication service receives the identity information supplied for that sign-in, such as your provider user identifier, email address and verification status, and basic profile information such as a name, username, or profile image when supplied.",
      "We use sign-in information to authenticate you, associate you with an invited Workspace, manage membership and permissions, and protect account access. The sign-in routes do not request additional permissions to read Gmail, Google Drive, or private GitHub repository contents. Connecting provider billing data or opting into machine uploads is separate from signing in.",
      "Supabase processes authentication credentials and session information, and Workspace uses authentication cookies to maintain your session. Google or GitHub may supply OAuth tokens as part of that flow, which are handled by the authentication and session infrastructure. You can revoke Tilden’s authorization in your Google or GitHub account settings. Revoking sign-in authorization does not itself erase Workspace records."
    ]
  },
  {
    "id": "provider-data",
    "title": "Provider credentials, costs, and usage",
    "paragraphs": [
      "When an authorized administrator connects a supported provider, Workspace receives the submitted provider key and stores it through Supabase Vault. Authorized server workers retrieve the credential to perform the supported provider operations. Workspace therefore has hosted credential storage, unlike local CLI-only analysis.",
      "Workspace retrieves and stores provider-reported costs and usage, dates and currencies, provider account and project or workspace identifiers, model information, and associated connection and synchronization records. Depending on the supported API and enabled feature, records can also include API-key identifiers and metadata, or user identifiers and email addresses returned by provider usage analytics. These are not the raw secret values of other keys in a provider account.",
      "We use this data to display costs and activity, organize projects, produce reports and recommendations, evaluate configured budgets or monitoring, and diagnose missing or failed reads. Data available to other Workspace members depends on their permissions. Connecting an account does not make its data public. The current Workspace Briefing uses calculations and templates; it does not send your report data to an LLM to generate that Briefing.",
      "Removing a key in Workspace withdraws Tilden’s authority to use that connection. It does not revoke the upstream provider key, delete historical reports, or guarantee immediate erasure of retained Vault records or backups. Revoke or rotate a key with its provider to invalidate it there. Contact us separately about deletion of retained data."
    ]
  },
  {
    "id": "machines",
    "title": "Optional machine uploads",
    "paragraphs": [
      "Machine connection and upload are optional. With an enrolled machine and the required Workspace consent, the CLI can push structured activity summaries to the hosted Workspace. These summaries include repository or directory basenames, hashed directory references, the agent, provider and model, dates, session and token counts, and opaque session references. Enrollment and upload also create device, consent, and delivery records.",
      "The upload contract excludes raw prompts, transcripts, source-file contents, and absolute directory paths. Repository or directory names can still reveal information about your work; review what you are sharing and obtain any required permission from your organization.",
      "Disconnecting a machine stops its authorized future uploads. It is not the same as deleting summaries already received. Workspace may retain those summaries as part of project history and audit records."
    ]
  },
  {
    "id": "workspace-telemetry",
    "title": "Workspace telemetry and security records",
    "paragraphs": [
      "Workspace records limited product, onboarding, security, and operational events to run the service and diagnose problems. Product events use predefined categories such as feature, step, outcome, route template, and time rather than report contents. A reduced subset uses a tenant pseudonym and is configured for 90-day retention in the hosted database. These events are pseudonymous, not fully anonymous.",
      "Runtime logs and other security, authentication, and audit records have separate lifecycles. The 90-day product-event period does not apply to provider costs, credentials, machine summaries, account records, or backups."
    ]
  },
  {
    "id": "services",
    "title": "Service providers and sharing",
    "paragraphs": [
      "Vercel hosts the application and processes requests and operational logs. Supabase provides authentication, database storage, and Vault credential storage. Google and GitHub process the sign-in flows you select. Connected AI providers receive the API requests needed to retrieve the data you authorize. These services process relevant data to deliver their functions and also have their own privacy policies.",
      "Authorized members of your Workspace can access information according to their roles. Information you deliberately export or send to an external application leaves that Workspace access boundary. We may also disclose information where required by law or needed to investigate abuse and protect the service or people.",
      "Provider-reported AI spending is different from payment information for a Tilden subscription. Workspace is invitation-only; these pages do not introduce a paid plan or authorize charges. The current Workspace does not provide a checkout or collect card details."
    ]
  },
  {
    "id": "retention",
    "title": "Retention, deletion, and choices",
    "paragraphs": [
      "Local CLI files are on your computer and can be managed or deleted there. For hosted data, retention depends on the record’s purpose, Workspace activity, operational and security needs, and any applicable legal requirements. There is no single automatic deletion period covering all Tilden data. Stopping telemetry, disconnecting a machine, removing a key, or signing out does not erase previously retained records.",
      "To request access, correction, export, or deletion of personal information, or to close an account, email contact@futurastudio.info. We may need to verify your identity and authority over a Workspace before acting. If you use an employer’s Workspace, its administrator may also need to participate. Some records may need to be retained for legal or security reasons, and backup copies may persist separately from active records. We do not promise immediate removal from every system.",
      "Depending on where you live, you may have additional rights to object to or restrict processing, withdraw consent where processing relies on it, or complain to your data-protection authority. Service providers may process information in countries other than your own."
    ]
  },
  {
    "id": "updates",
    "title": "Security and policy updates",
    "paragraphs": [
      "Workspace uses authenticated access, role-based authorization, and Vault-backed credential custody. These controls do not make any internet service risk-free. Do not send provider secrets to our contact email.",
      "We may update this policy as the service or its data practices change. The effective date at the top identifies this version. Contact Futura Studio, LLC at contact@futurastudio.info with privacy questions."
    ]
  }
];

export default function Page() { return <LegalPage title="Privacy policy" intro="What stays on your computer, what Workspace receives, and the choices available to you." sections={sections} />; }

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
    "title": "About this policy",
    "paragraphs": [
      "Tilden is operated by Futura Studio, LLC. This policy covers asktilden.com, the public aibill CLI, and the invitation-only Tilden Workspace at app.asktilden.com. Contact us at contact@futurastudio.info.",
      "Local CLI analysis runs on your computer. Workspace is a hosted service and receives and stores data you connect or upload. Local-first CLI statements do not apply to Workspace."
    ]
  },
  {
    "id": "information",
    "title": "Information we collect",
    "paragraphs": [],
    "bullets": [
      "Account information: When you sign in with Google, GitHub, or email, we receive identifiers, your email address, verification status, and basic profile information supplied by the sign-in service. We also process session information and Workspace membership. Sign-in does not grant access to Gmail, Google Drive, or private GitHub repository contents.",
      "Connected-provider information: Workspace stores credentials you submit and retrieves authorized billing, cost, and usage records. These can include account, project, model, API-key metadata, and user identifiers provided by the connected service.",
      "Optional machine uploads: If you connect a machine and authorize uploads, Workspace receives project or directory names and structured activity summaries, including dates, models, session counts, and token usage. These uploads exclude raw prompts, transcripts, source-file contents, and absolute directory paths.",
      "Contact information: We collect your email address, any referral identifier, and information you submit when joining the waitlist or contacting us.",
      "Technical information: Our services process IP addresses, request information, device or browser information, and limited usage and security events."
    ]
  },
  {
    "id": "use",
    "title": "How we use information",
    "paragraphs": [
      "We use this information to authenticate users, provide Workspace features, display costs and activity, manage invitations and permissions, respond to requests, communicate about the product, and maintain service reliability and security.",
      "Google and GitHub sign-in information is used for account access, membership, and security. Provider connections and machine uploads require separate authorization. Workspace members can access shared information according to their permissions."
    ]
  },
  {
    "id": "local-and-telemetry",
    "title": "Local processing, cookies, and telemetry",
    "paragraphs": [
      "Local CLI report generation does not send raw prompts, transcripts, source-file contents, or report amounts to Tilden. Optional provider requests, Workspace uploads, report sharing, and MCP-client use are separate. Information you send to an external service is also subject to that service’s policies.",
      "The CLI discloses limited usage telemetry on its first interactive run; later runs may send events unless disabled. Events include a random installation identifier, command name, software and system information, timing, and success status. They exclude report contents, credentials, paths, email addresses, and dollar amounts. Run “aibill telemetry” to inspect it and “aibill telemetry off” to disable future events. DO_NOT_TRACK=1 and AI_SPEND_NO_TELEMETRY=1 also disable it.",
      "Workspace uses cookies for authentication and session management. Limited product analytics help us understand feature use and onboarding. Installation and Workspace identifiers make these events pseudonymous, rather than fully anonymous."
    ]
  },
  {
    "id": "sharing",
    "title": "Service providers and disclosure",
    "paragraphs": [
      "We use Vercel for hosting and Supabase for authentication and data storage. Google and GitHub process sign-in when selected, and connected AI providers process the requests you authorize. Relevant information is processed by these services to deliver their functions. They have their own privacy policies.",
      "When email confirmation is enabled, Resend processes your email address and confirmation message to deliver it.",
      "We may disclose information to comply with applicable law, investigate abuse, or protect the service and people. Information you export or share goes to the recipients you choose. Service providers may process information outside your country."
    ]
  },
  {
    "id": "retention",
    "title": "Retention and your choices",
    "paragraphs": [
      "We retain hosted information according to its purpose, service needs, security needs, and applicable legal requirements. Retained Workspace product-analytics events are configured for 90 days; that period does not apply to account information, billing history, credentials, uploaded activity, logs, or backups.",
      "You can stop CLI telemetry, disconnect a machine, remove a provider connection, or revoke Google or GitHub access in your provider settings. These actions do not automatically delete previously stored information. Removing a provider connection does not revoke the key at its source; revoke or rotate it with the provider when needed.",
      "For access, correction, export, deletion, account closure, or an opt-out from product communications, email contact@futurastudio.info. We may verify your identity and Workspace authority. Some records may be retained for legal or security reasons, and backups may persist separately. You manage local CLI files on your own computer.",
      "Depending on your location, you may also have rights to object to or restrict processing, withdraw consent where applicable, or complain to a data-protection authority."
    ]
  },
  {
    "id": "updates",
    "title": "Security and changes",
    "paragraphs": [
      "We use access controls and other safeguards to protect hosted information, but no service can guarantee absolute security. Do not email us provider credentials.",
      "We may update this policy as our services or practices change. The effective date identifies the current version. For questions, contact Futura Studio, LLC at contact@futurastudio.info."
    ]
  }
];

export default function Page() { return <LegalPage title="Privacy policy" intro="What stays on your computer, what Workspace receives, and the choices available to you." sections={sections} effectiveDate="October 3, 2026" />; }

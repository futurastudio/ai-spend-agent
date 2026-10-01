import type { Metadata } from "next";
import { LegalPage, type LegalSection } from "../../components/legal/LegalPage";

export const metadata: Metadata = {
  "title": "Terms of service | Tilden",
  "description": "The terms for using Tilden’s website and invitation-only Workspace, with separate treatment for the open-source aibill CLI.",
  "alternates": {
    "canonical": "/terms"
  },
  "openGraph": {
    "title": "Terms of service | Tilden",
    "description": "The terms for using Tilden’s website and invitation-only Workspace, with separate treatment for the open-source aibill CLI.",
    "url": "/terms"
  }
};

const sections: LegalSection[] = [
  {
    "id": "scope",
    "title": "The service and these terms",
    "paragraphs": [
      "These terms cover the Tilden website and hosted Tilden Workspace, operated by Futura Studio, LLC (\"Tilden\", \"we\", \"us\"). Workspace is currently offered by invitation. By using the hosted service, you agree to these terms. If you use it for an organization, you must have authority to do so.",
      "The public aibill CLI is open-source software provided under its included MIT License. That license governs your use, copying, modification, and distribution of the CLI; these hosted-service terms do not replace or restrict those open-source rights. Separate third-party software and services remain subject to their own terms."
    ]
  },
  {
    "id": "access",
    "title": "Accounts and authorized access",
    "paragraphs": [
      "Use accurate account information, protect your account and device credentials, and only access Workspaces to which you have been invited or otherwise authorized. Workspace owners and administrators are responsible for assigning appropriate access to their team.",
      "Google and GitHub sign-in establish your identity. They do not by themselves authorize access to provider billing accounts, private repositories, or another organization’s data. Only submit provider credentials, connect accounts, or upload machine activity that you are authorized to share. You are responsible for obtaining any required permissions from your organization and affected users."
    ]
  },
  {
    "id": "data",
    "title": "Your data and connections",
    "paragraphs": [
      "You retain your rights in the information you provide. You authorize Tilden to process that information and use the connections you configure as necessary to provide the service, including retrieving provider data, storing hosted records, and producing reports. Our Privacy policy describes the distinction between local CLI analysis and hosted processing.",
      "You control whether to enable optional machine uploads. Those uploads can include project names and structured usage summaries. Review the relevant setup and consent information before enabling them. Your organization’s Workspace members may see information according to their assigned permissions.",
      "Removing a connection or disconnecting a machine limits future authorized access; it does not automatically delete historical information or revoke a provider key at its source. Contact contact@futurastudio.info for account closure or data-deletion requests."
    ]
  },
  {
    "id": "reports",
    "title": "What the reports mean",
    "paragraphs": [
      "Tilden helps you understand AI costs and activity. Provider-reported charges, local estimates, and machine-reported usage are different evidence sources. Coverage can be incomplete or delayed, and providers can revise their records. Review labels, date ranges, and source coverage before acting on a report.",
      "Reports and recommendations are informational. They are not an invoice, an audit, accounting or tax advice, investment advice, or a guarantee of savings or business results. Verify financial decisions against the relevant provider records and your own requirements.",
      "Marketing previews and sample dashboards are illustrations, not your live data. Roadmap descriptions are not commitments to deliver particular features or dates."
    ]
  },
  {
    "id": "use",
    "title": "Acceptable use",
    "paragraphs": [
      "Use Tilden lawfully and within the access you have been given. Do not:"
    ],
    "bullets": [
      "Access another person’s data or connect credentials without authorization.",
      "Attempt to bypass authentication, permissions, rate limits, or other service safeguards.",
      "Interfere with the service, introduce malicious code, or use it to facilitate fraud or unlawful activity.",
      "Upload information you have no right to provide or use the service in a way that violates another person’s rights."
    ]
  },
  {
    "id": "availability",
    "title": "Invitation access and service availability",
    "paragraphs": [
      "Invitation access is not a promise of permanent availability, a service-level agreement, or guaranteed data coverage. The hosted service is evolving, and features may change or be unavailable. Keep copies of information you need for accounting, compliance, or other critical purposes.",
      "We may restrict or suspend access to address unauthorized use, security issues, legal requirements, or discontinuation of an invitation or service. You may stop using the service at any time. Data-handling and deletion questions are covered by the Privacy policy and can be directed to our contact address."
    ]
  },
  {
    "id": "fees",
    "title": "Fees and third-party costs",
    "paragraphs": [
      "These terms do not enroll you in a paid plan, start a subscription, or authorize a charge. Any paid arrangement requires separately communicated and agreed pricing and payment terms. A separate written agreement for your Workspace controls if it conflicts with these general terms on the same subject.",
      "You remain responsible for charges imposed by AI providers and other services you use. Tilden’s display of a provider cost does not mean Tilden has collected, paid, or reconciled that invoice."
    ]
  },
  {
    "id": "limitations",
    "title": "Service limitations and other rights",
    "paragraphs": [
      "To the extent permitted by applicable law, the website and hosted service are provided on an “as is” and “as available” basis, without a warranty that they will be uninterrupted, error-free, or fit for a particular purpose. The CLI’s warranties and liability provisions are stated in its MIT License.",
      "Nothing in these terms excludes rights or remedies that cannot lawfully be excluded.",
      "Tilden’s name, branding, and hosted-service materials remain the property of their respective owners. Using the service does not transfer ownership of them or of another user’s information."
    ]
  },
  {
    "id": "changes",
    "title": "Changes and contact",
    "paragraphs": [
      "The effective date at the top identifies this version. We may update these terms as the service develops; any separately agreed written terms continue to apply according to their provisions. Review the current terms when using the service.",
      "For questions about these terms, invitation access, or your account, contact Futura Studio, LLC at contact@futurastudio.info."
    ]
  }
];

export default function Page() { return <LegalPage title="Terms of service" intro="The terms for using Tilden\u2019s website and invitation-only Workspace, with separate treatment for the open-source aibill CLI." sections={sections} />; }

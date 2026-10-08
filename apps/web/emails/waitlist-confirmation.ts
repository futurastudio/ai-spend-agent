// Static transactional copy: no recipient data, referral IDs, or tracking pixels.
export const waitlistConfirmation = {
  subject: "We’ve received your Tilden access request",
  text: `We’ve received your request for access to Tilden.

Our team will follow up to discuss your AI spending needs and partner onboarding.

Workspace access is invitation-only. Your request does not create an account or grant access.

Have a spending question already? Reply to this email and tell us what you’d like to understand. No credentials or billing files needed.

The Tilden onboarding team

Futura Studio, LLC
https://asktilden.com/privacy
https://asktilden.com/terms

If you didn’t request this or no longer want Tilden updates, reply to let us know.`,
  html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>We’ve received your Tilden access request</title></head>
<body style="margin:0;padding:0;background:#F5F6FC;color:#19213D;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Our team will follow up to discuss your AI spending needs and partner onboarding.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6FC;"><tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
      <tr><td style="padding:32px;background:#243CCB;color:#FFFFFF;">
        <a href="https://asktilden.com" style="color:#FFFFFF;text-decoration:none;font-size:24px;font-weight:700;letter-spacing:-1px;">Tilden</a>
        <h1 style="margin:32px 0 0;font-size:32px;line-height:1.15;letter-spacing:-1px;font-weight:500;">Request received.</h1>
      </td></tr>
      <tr><td style="padding:32px;background:#FFFFFF;font-size:16px;line-height:1.6;">
        <p style="margin:0 0 20px;">We’ve received your request for access to Tilden.</p>
        <p style="margin:0 0 20px;">Our team will follow up to discuss your AI spending needs and partner onboarding.</p>
        <p style="margin:0 0 24px;color:#5C6580;font-size:14px;">Workspace access is invitation-only. Your request does not create an account or grant access.</p>
        <p style="margin:0 0 24px;padding-top:24px;border-top:1px solid #E3E6EF;">Have a spending question already? Reply to this email and tell us what you’d like to understand. No credentials or billing files needed.</p>
        <p style="margin:0;font-size:14px;">The Tilden onboarding team</p>
      </td></tr>
      <tr><td style="padding:24px 8px;color:#5C6580;font-size:12px;line-height:1.6;">
        <p style="margin:0 0 12px;">Futura Studio, LLC · <a href="https://asktilden.com/privacy" style="color:#5C6580;">Privacy</a> · <a href="https://asktilden.com/terms" style="color:#5C6580;">Terms</a></p>
        <p style="margin:0;">If you didn’t request this or no longer want Tilden updates, reply to let us know.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`,
} as const;

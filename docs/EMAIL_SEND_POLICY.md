# Email send policy — waitlist audiences by `source_ref`

The `waitlist` table is segmented by `source_ref`. Every ref names the capture
surface the email came from, and each surface printed (or displayed) a specific
promise at the moment of capture. **An audience is emailed only what its
capture surface promised — nothing else, no cross-promotion without fresh,
explicit consent gathered from a send that was itself within policy.** Before
any send, filter by `source_ref` and check this table. Adding a new capture
surface requires adding its row here BEFORE the surface ships; a ref with no
row gets no email.

| `source_ref` | Capture surface | Promise made at capture | May be sent |
|---|---|---|---|
| `cli-receipt` | CLI during-scan ask (`npx aibill`, real receipt path) | "Get the launch email + what ships next" (launch week) / "Get product updates" (after) · scope line "used only for updates · never shared" | Product updates only (incl. the launch email) |
| `cli-signup` | `npx aibill signup <email>` | Same scope line as `cli-receipt` | Product updates only (incl. the launch email) |
| `cli-signup-<tag>` (e.g. `cli-signup-starfund`) | `npx aibill signup <email> --ref <tag>` | Same scope line as `cli-receipt` | Product updates only (incl. the launch email) |
| `starfund` | Star.fun launch page / posts → `asktilden.com/?ref=starfund` | Site waitlist form copy at capture time | Launch updates only |
| `github-readme` | README "Workspace design partner" CTA → `asktilden.com/?ref=github-readme#beta` | Design-partner application follow-up | Design-partner fit / onboarding follow-up |
| `github-glance-study` | Glance preview study volunteer form → `asktilden.com/?ref=github-glance-study#beta` | Study interest registration | Study timing / logistics emails |
| `direct` / absent | Site form with no attribution (or a ref the route rejected) | Site waitlist form copy at capture time | Launch updates only |

Notes:

- The CLI refs (`cli-*`) never promised weekly artifacts, beta access, or
  Workspace anything — the printed offer is the launch email plus product
  updates ("what ships next"), with the scope line "used only for updates ·
  never shared". Sending those audiences anything beyond product updates
  breaks a promise printed in a terminal, which is the product's brand
  surface.
- "Never shared" means the address is not given to any third party for its
  own use. Supabase (storage) and the mail tool used to send a within-policy
  email act as processors, not recipients.
- Unsubscribe: any reply, or mail to hello@asktilden.com, removes the address
  from all future sends. `npx aibill signup --forget` clears only the LOCAL
  signup state and says so.

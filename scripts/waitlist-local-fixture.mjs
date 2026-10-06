// Local browser-verification fixture only. Never deployed, never a Supabase acceptance result.
// Accepts only reserved example.test addresses and a fixed, non-secret fixture key.
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "tilden-signup-proof-"));
const file = join(directory, "signups.json");
await writeFile(file, "[]");
const server = createServer(async (request, response) => {
  const reply = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
  if (request.url !== "/rest/v1/waitlist" || request.method !== "POST") return reply(404, { error: "Fixture route only" });
  if (request.headers.apikey !== "tilden-local-fixture-only") return reply(401, { error: "Fixture key required" });
  try {
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 2048) return reply(413, {}); }
    const entry = JSON.parse(body);
    if (typeof entry.email !== "string" || !entry.email.endsWith("@example.test")) return reply(422, { error: "Reserved fixture addresses only" });
    if (entry.email === "fail@example.test") return reply(503, { error: "Intentional storage failure" });
    const records = JSON.parse(await readFile(file, "utf8"));
    if (records.some(row => row.email === entry.email)) return reply(409, { code: "23505" });
    records.push(entry);
    await writeFile(file, JSON.stringify(records, null, 2));
    return reply(201, {});
  } catch { return reply(400, { error: "Invalid fixture request" }); }
});
server.listen(3051, "127.0.0.1", () => console.log(`Local waitlist fixture on 127.0.0.1:3051. Evidence: ${file}`));

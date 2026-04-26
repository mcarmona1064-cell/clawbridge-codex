import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import Nango from "@nangohq/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

const secretKey = process.env.NANGO_SECRET_KEY;
const serverUrl = process.env.NANGO_SERVER_URL ?? "http://localhost:3003";
const port = parseInt(process.env.AUTH_PORTAL_PORT ?? "3010", 10);

if (!secretKey) {
  console.error("NANGO_SECRET_KEY env var is required");
  process.exit(1);
}

const nango = new Nango({ secretKey, host: serverUrl });
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// GET /api/connections?client_id=xxx
// ---------------------------------------------------------------------------
app.get("/api/connections", async (req, res) => {
  const clientId = req.query.client_id as string;
  if (!clientId) return res.status(400).json({ error: "client_id required" });
  try {
    const connections = await nango.listConnections(clientId);
    res.json(connections);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/connect { client_id, integration }
// ---------------------------------------------------------------------------
app.post("/api/connect", async (req, res) => {
  const { client_id, integration } = req.body as { client_id: string; integration: string };
  if (!client_id || !integration) {
    return res.status(400).json({ error: "client_id and integration required" });
  }
  try {
    const session = await nango.createConnectSession({
      end_user: { id: client_id },
      allowed_integrations: [integration],
    });
    const connectBase = serverUrl.replace(":3003", ":3009");
    const url = `${connectBase}/connect?session_token=${session.data.token}`;
    res.json({ url, session_token: session.data.token });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/providers
// ---------------------------------------------------------------------------
app.get("/api/providers", async (_req, res) => {
  try {
    // Nango exposes a public providers list
    const r = await fetch(`${serverUrl}/api/v1/meta/providers`);
    if (!r.ok) return res.status(r.status).json({ error: "Could not fetch providers" });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(port, () => {
  console.log(`Auth portal running at http://localhost:${port}`);
});

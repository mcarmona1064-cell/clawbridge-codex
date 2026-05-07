import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const integrationServerUrl = process.env.INTEGRATION_SERVER_URL ?? "http://localhost:3003";
const integrationSecretKey = process.env.INTEGRATION_SECRET_KEY ?? "";
const port = parseInt(process.env.AUTH_PORTAL_PORT ?? "3010", 10);
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
    const r = await fetch(`${integrationServerUrl}/connection?connection_id=${encodeURIComponent(clientId)}`, {
      headers: { Authorization: `Bearer ${integrationSecretKey}` },
    });
    const data = await r.json();
    res.status(r.status).json(data);
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
    const r = await fetch(`${integrationServerUrl}/api/connect`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${integrationSecretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id, integration }),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/providers
// ---------------------------------------------------------------------------
app.get("/api/providers", async (_req, res) => {
  try {
    const r = await fetch(`${integrationServerUrl}/api/v1/meta/providers`);
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

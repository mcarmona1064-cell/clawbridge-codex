import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import OpenAI from "openai";

const integrationServerUrl = process.env.INTEGRATION_SERVER_URL ?? "http://localhost:3003";
const integrationSecretKey = process.env.INTEGRATION_SECRET_KEY ?? "";

// ---------------------------------------------------------------------------
// Portal DB helper — fetch client OpenAI API key
// ---------------------------------------------------------------------------

async function getClientOpenAIKey(clientId: string): Promise<string> {
  const portalApiUrl = process.env.PORTAL_API_URL ?? "http://localhost:3010";
  const portalAdminToken = process.env.PORTAL_ADMIN_TOKEN ?? "";
  const res = await fetch(`${portalApiUrl}/api/clients/${clientId}/openai-key`, {
    headers: { Authorization: `Bearer ${portalAdminToken}` },
  });
  if (!res.ok) {
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) return envKey;
    throw new Error(`No OpenAI API key found for client "${clientId}". Store one via onboarding or set OPENAI_API_KEY.`);
  }
  const data = await res.json() as { api_key: string };
  return data.api_key;
}

const server = new Server(
  { name: "clawbridge-integrations", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function integrationGet<T = unknown>(
  integration: string,
  connectionId: string,
  endpoint: string,
  params?: Record<string, string>
): Promise<T> {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${integrationServerUrl}/proxy/${integration}${endpoint}${query}`, {
    headers: {
      Authorization: `Bearer ${integrationSecretKey}`,
      "Connection-Id": connectionId,
    },
  });
  if (!res.ok) throw new Error(`Integration GET failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function integrationPost<T = unknown>(
  integration: string,
  connectionId: string,
  endpoint: string,
  data: unknown
): Promise<T> {
  const res = await fetch(`${integrationServerUrl}/proxy/${integration}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${integrationSecretKey}`,
      "Connection-Id": connectionId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Integration POST failed: ${res.status}`);
  return res.json() as Promise<T>;
}

function connectionNotFound(integration: string, clientId: string): string {
  return (
    `No ${integration} connection found for client "${clientId}". ` +
    `Ask the client to connect their ${integration} account first via the auth portal.`
  );
}

function wrapError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // Connection management
  {
    name: "list_connections",
    description: "List all connected apps for a client",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "The client identifier" },
      },
      required: ["client_id"],
    },
  },
  {
    name: "get_integration_url",
    description: "Get the OAuth URL for a client to connect an app",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "The client identifier" },
        integration: {
          type: "string",
          description: "Integration key (e.g. google-calendar, gmail, hubspot)",
        },
      },
      required: ["client_id", "integration"],
    },
  },
  // Google Calendar
  {
    name: "get_calendar_events",
    description: "List upcoming Google Calendar events for a client",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        start_date: {
          type: "string",
          description: "ISO 8601 date-time (defaults to now)",
        },
        end_date: {
          type: "string",
          description: "ISO 8601 date-time (defaults to 7 days from now)",
        },
      },
      required: ["client_id"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a Google Calendar event",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 date-time" },
        end: { type: "string", description: "ISO 8601 date-time" },
        description: { type: "string" },
      },
      required: ["client_id", "title", "start", "end"],
    },
  },
  // Gmail
  {
    name: "send_email",
    description: "Send an email via Gmail",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["client_id", "to", "subject", "body"],
    },
  },
  {
    name: "read_inbox",
    description: "Read recent emails from Gmail inbox",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        limit: {
          type: "number",
          description: "Number of emails to return (default 10)",
        },
      },
      required: ["client_id"],
    },
  },
  // HubSpot
  {
    name: "get_hubspot_contacts",
    description: "List HubSpot contacts",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        limit: { type: "number", description: "Max contacts to return (default 20)" },
      },
      required: ["client_id"],
    },
  },
  {
    name: "create_hubspot_contact",
    description: "Create a new HubSpot contact",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        email: { type: "string" },
        firstname: { type: "string" },
        lastname: { type: "string" },
        phone: { type: "string" },
      },
      required: ["client_id", "email"],
    },
  },
  {
    name: "create_hubspot_deal",
    description: "Create a new HubSpot deal",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        dealname: { type: "string" },
        amount: { type: "string" },
        stage: {
          type: "string",
          description: "Deal stage (e.g. appointmentscheduled, qualifiedtobuy, closedwon)",
        },
      },
      required: ["client_id", "dealname"],
    },
  },
  // Slack
  {
    name: "send_slack_message",
    description: "Send a message to a Slack channel",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        channel: { type: "string", description: "Channel name or ID" },
        message: { type: "string" },
      },
      required: ["client_id", "channel", "message"],
    },
  },
  {
    name: "list_slack_channels",
    description: "List Slack channels",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
      },
      required: ["client_id"],
    },
  },
  // Notion
  {
    name: "search_notion",
    description: "Search Notion pages and databases",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        query: { type: "string" },
      },
      required: ["client_id", "query"],
    },
  },
  {
    name: "create_notion_page",
    description: "Create a new Notion page",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        parent_page_id: { type: "string" },
        title: { type: "string" },
        content: { type: "string", description: "Plain text content for the page" },
      },
      required: ["client_id", "parent_page_id", "title", "content"],
    },
  },
  // OpenAI vision
  {
    name: "analyze_image",
    description: "Analyze an image/photo using OpenAI vision and return a description",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        image_url: { type: "string", description: "Public URL of the image" },
        question: { type: "string", description: "Optional question about the image" },
      },
      required: ["client_id", "image_url"],
    },
  },
  {
    name: "extract_text_from_image",
    description: "OCR: extract all text from an image",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        image_url: { type: "string" },
      },
      required: ["client_id", "image_url"],
    },
  },
  {
    name: "analyze_document",
    description: "Analyze an invoice, contract, or form image and return structured data",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        image_url: { type: "string" },
        doc_type: { type: "string", description: "Document type hint e.g. invoice, contract, form" },
      },
      required: ["client_id", "image_url"],
    },
  },
  {
    name: "describe_chart",
    description: "Analyze a chart or graph image and return key insights",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        image_url: { type: "string" },
      },
      required: ["client_id", "image_url"],
    },
  },
];

// ---------------------------------------------------------------------------
// List tools handler
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ---------------------------------------------------------------------------
// Call tool handler
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ---- Connection management ----------------------------------------

      case "list_connections": {
        const { client_id } = args as { client_id: string };
        const res = await fetch(`${integrationServerUrl}/connection?connection_id=${encodeURIComponent(client_id)}`, {
          headers: { Authorization: `Bearer ${integrationSecretKey}` },
        });
        const connections = res.ok ? await res.json() : { error: `Status ${res.status}` };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(connections, null, 2),
            },
          ],
        };
      }

      case "get_integration_url": {
        const { client_id, integration } = args as {
          client_id: string;
          integration: string;
        };
        const res = await fetch(`${integrationServerUrl}/api/connect`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${integrationSecretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ client_id, integration }),
        });
        const data = res.ok ? await res.json() : { error: `Status ${res.status}` };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      }

      // ---- Google Calendar ----------------------------------------------

      case "get_calendar_events": {
        const { client_id, start_date, end_date } = args as {
          client_id: string;
          start_date?: string;
          end_date?: string;
        };
        const now = new Date();
        const timeMin = start_date ?? now.toISOString();
        const timeMax =
          end_date ??
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        try {
          const data = await integrationGet(
            "google-calendar",
            client_id,
            "/calendar/v3/calendars/primary/events",
            { timeMin, timeMax, singleEvents: "true", orderBy: "startTime" }
          );
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Google Calendar", client_id) }] };
        }
      }

      case "create_calendar_event": {
        const { client_id, title, start, end, description } = args as {
          client_id: string;
          title: string;
          start: string;
          end: string;
          description?: string;
        };
        const event = {
          summary: title,
          description,
          start: { dateTime: start },
          end: { dateTime: end },
        };
        try {
          const data = await integrationPost(
            "google-calendar",
            client_id,
            "/calendar/v3/calendars/primary/events",
            event
          );
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Google Calendar", client_id) }] };
        }
      }

      // ---- Gmail --------------------------------------------------------

      case "send_email": {
        const { client_id, to, subject, body } = args as {
          client_id: string;
          to: string;
          subject: string;
          body: string;
        };
        const raw = Buffer.from(
          `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
        )
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
        try {
          const data = await integrationPost("gmail", client_id, "/gmail/v1/users/me/messages/send", { raw });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Gmail", client_id) }] };
        }
      }

      case "read_inbox": {
        const { client_id, limit = 10 } = args as { client_id: string; limit?: number };
        try {
          const list = await integrationGet<{ messages?: { id: string }[] }>(
            "gmail",
            client_id,
            "/gmail/v1/users/me/messages",
            { maxResults: String(limit), labelIds: "INBOX" }
          );
          const ids = (list.messages ?? []).slice(0, limit);
          const messages = await Promise.all(
            ids.map(({ id }) =>
              integrationGet("gmail", client_id, `/gmail/v1/users/me/messages/${id}`, {
                format: "metadata",
                metadataHeaders: "Subject,From,Date",
              })
            )
          );
          return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Gmail", client_id) }] };
        }
      }

      // ---- HubSpot ------------------------------------------------------

      case "get_hubspot_contacts": {
        const { client_id, limit = 20 } = args as { client_id: string; limit?: number };
        try {
          const data = await integrationGet(
            "hubspot",
            client_id,
            "/crm/v3/objects/contacts",
            { limit: String(limit), properties: "firstname,lastname,email,phone" }
          );
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("HubSpot", client_id) }] };
        }
      }

      case "create_hubspot_contact": {
        const { client_id, email, firstname, lastname, phone } = args as {
          client_id: string;
          email: string;
          firstname?: string;
          lastname?: string;
          phone?: string;
        };
        try {
          const data = await integrationPost("hubspot", client_id, "/crm/v3/objects/contacts", {
            properties: { email, firstname, lastname, phone },
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("HubSpot", client_id) }] };
        }
      }

      case "create_hubspot_deal": {
        const { client_id, dealname, amount, stage = "appointmentscheduled" } = args as {
          client_id: string;
          dealname: string;
          amount?: string;
          stage?: string;
        };
        try {
          const data = await integrationPost("hubspot", client_id, "/crm/v3/objects/deals", {
            properties: { dealname, amount, dealstage: stage },
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("HubSpot", client_id) }] };
        }
      }

      // ---- Slack --------------------------------------------------------

      case "send_slack_message": {
        const { client_id, channel, message } = args as {
          client_id: string;
          channel: string;
          message: string;
        };
        try {
          const data = await integrationPost("slack", client_id, "/api/chat.postMessage", {
            channel,
            text: message,
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Slack", client_id) }] };
        }
      }

      case "list_slack_channels": {
        const { client_id } = args as { client_id: string };
        try {
          const data = await integrationGet("slack", client_id, "/api/conversations.list", {
            types: "public_channel,private_channel",
            limit: "200",
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Slack", client_id) }] };
        }
      }

      // ---- Notion -------------------------------------------------------

      case "search_notion": {
        const { client_id, query } = args as { client_id: string; query: string };
        try {
          const data = await integrationPost("notion", client_id, "/v1/search", { query });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Notion", client_id) }] };
        }
      }

      case "create_notion_page": {
        const { client_id, parent_page_id, title, content } = args as {
          client_id: string;
          parent_page_id: string;
          title: string;
          content: string;
        };
        try {
          const data = await integrationPost("notion", client_id, "/v1/pages", {
            parent: { type: "page_id", page_id: parent_page_id },
            properties: {
              title: {
                title: [{ type: "text", text: { content: title } }],
              },
            },
            children: [
              {
                object: "block",
                type: "paragraph",
                paragraph: {
                  rich_text: [{ type: "text", text: { content } }],
                },
              },
            ],
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Notion", client_id) }] };
        }
      }

      // ---- OpenAI Vision -----------------------------------------------

      case "analyze_image": {
        const { client_id, image_url, question } = args as {
          client_id: string;
          image_url: string;
          question?: string;
        };
        try {
          const apiKey = await getClientOpenAIKey(client_id);
          const openai = new OpenAI({ apiKey });
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 1024,
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: image_url } },
                { type: "text", text: question ?? "Describe this image in detail." },
              ],
            }],
          });
          const text = response.choices[0]?.message?.content;
          return { content: [{ type: "text", text: text ?? "No description returned." }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Error analyzing image: ${wrapError(e)}` }], isError: true };
        }
      }

      case "extract_text_from_image": {
        const { client_id, image_url } = args as { client_id: string; image_url: string };
        try {
          const apiKey = await getClientOpenAIKey(client_id);
          const openai = new OpenAI({ apiKey });
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 2048,
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: image_url } },
                { type: "text", text: "Extract all text visible in this image. Return only the extracted text, preserving layout where possible." },
              ],
            }],
          });
          const text = response.choices[0]?.message?.content;
          return { content: [{ type: "text", text: text ?? "No text found." }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Error extracting text: ${wrapError(e)}` }], isError: true };
        }
      }

      case "analyze_document": {
        const { client_id, image_url, doc_type } = args as {
          client_id: string;
          image_url: string;
          doc_type?: string;
        };
        try {
          const apiKey = await getClientOpenAIKey(client_id);
          const openai = new OpenAI({ apiKey });
          const docHint = doc_type ? ` This is a ${doc_type}.` : "";
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 2048,
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: image_url } },
                { type: "text", text: `Analyze this document image.${docHint} Extract all key fields and return a structured JSON object with the document type, key-value pairs for all important fields, line items if applicable, totals, dates, and parties involved. Return only valid JSON.` },
              ],
            }],
          });
          const text = response.choices[0]?.message?.content;
          return { content: [{ type: "text", text: text ?? "{}" }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Error analyzing document: ${wrapError(e)}` }], isError: true };
        }
      }

      case "describe_chart": {
        const { client_id, image_url } = args as { client_id: string; image_url: string };
        try {
          const apiKey = await getClientOpenAIKey(client_id);
          const openai = new OpenAI({ apiKey });
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 1024,
            messages: [{
              role: "user",
              content: [
                { type: "image_url", image_url: { url: image_url } },
                { type: "text", text: "Analyze this chart or graph. Describe: (1) the type of chart, (2) what data is being visualized, (3) the key trends or insights, (4) any notable data points or anomalies, and (5) the main takeaway." },
              ],
            }],
          });
          const text = response.choices[0]?.message?.content;
          return { content: [{ type: "text", text: text ?? "No insights returned." }] };
        } catch (e) {
          return { content: [{ type: "text", text: `Error describing chart: ${wrapError(e)}` }], isError: true };
        }
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (e) {
    return {
      content: [{ type: "text", text: `Error: ${wrapError(e)}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("ClawBridge Integrations MCP server running on stdio");

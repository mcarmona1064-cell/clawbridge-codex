import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Nango from "@nangohq/node";
import { z } from "zod";

const secretKey = process.env.NANGO_SECRET_KEY;
const serverUrl = process.env.NANGO_SERVER_URL ?? "http://localhost:3003";

if (!secretKey) {
  console.error("NANGO_SECRET_KEY env var is required");
  process.exit(1);
}

const nango = new Nango({ secretKey, host: serverUrl });

const server = new Server(
  { name: "clawbridge-integrations", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function nangoGet<T = unknown>(
  integration: string,
  connectionId: string,
  endpoint: string,
  params?: Record<string, string>
): Promise<T> {
  const res = await nango.get({
    providerConfigKey: integration,
    connectionId,
    endpoint,
    params,
  });
  return res.data as T;
}

async function nangoPost<T = unknown>(
  integration: string,
  connectionId: string,
  endpoint: string,
  data: unknown
): Promise<T> {
  const res = await nango.post({
    providerConfigKey: integration,
    connectionId,
    endpoint,
    data,
  });
  return res.data as T;
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
  // Stripe
  {
    name: "get_stripe_payments",
    description: "List recent Stripe payments",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        limit: { type: "number", description: "Number of payments (default 10)" },
      },
      required: ["client_id"],
    },
  },
  {
    name: "get_stripe_customers",
    description: "Look up Stripe customers, optionally by email",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        email: { type: "string", description: "Filter by email address" },
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
        const connections = await nango.listConnections(client_id);
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
        const session = await nango.createConnectSession({
          end_user: { id: client_id },
          allowed_integrations: [integration],
        });
        const connectUrl = `${serverUrl.replace("3003", "3009")}/connect?session_token=${session.data.token}`;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url: connectUrl, session_token: session.data.token }),
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
          const data = await nangoGet(
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
          const data = await nangoPost(
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
          const data = await nangoPost("gmail", client_id, "/gmail/v1/users/me/messages/send", { raw });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Gmail", client_id) }] };
        }
      }

      case "read_inbox": {
        const { client_id, limit = 10 } = args as { client_id: string; limit?: number };
        try {
          const list = await nangoGet<{ messages?: { id: string }[] }>(
            "gmail",
            client_id,
            "/gmail/v1/users/me/messages",
            { maxResults: String(limit), labelIds: "INBOX" }
          );
          const ids = (list.messages ?? []).slice(0, limit);
          const messages = await Promise.all(
            ids.map(({ id }) =>
              nangoGet("gmail", client_id, `/gmail/v1/users/me/messages/${id}`, {
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
          const data = await nangoGet(
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
          const data = await nangoPost("hubspot", client_id, "/crm/v3/objects/contacts", {
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
          const data = await nangoPost("hubspot", client_id, "/crm/v3/objects/deals", {
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
          const data = await nangoPost("slack", client_id, "/api/chat.postMessage", {
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
          const data = await nangoGet("slack", client_id, "/api/conversations.list", {
            types: "public_channel,private_channel",
            limit: "200",
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Slack", client_id) }] };
        }
      }

      // ---- Stripe -------------------------------------------------------

      case "get_stripe_payments": {
        const { client_id, limit = 10 } = args as { client_id: string; limit?: number };
        try {
          const data = await nangoGet("stripe", client_id, "/v1/payment_intents", {
            limit: String(limit),
          });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Stripe", client_id) }] };
        }
      }

      case "get_stripe_customers": {
        const { client_id, email } = args as { client_id: string; email?: string };
        try {
          const params: Record<string, string> = { limit: "20" };
          if (email) params.email = email;
          const data = await nangoGet("stripe", client_id, "/v1/customers", params);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch {
          return { content: [{ type: "text", text: connectionNotFound("Stripe", client_id) }] };
        }
      }

      // ---- Notion -------------------------------------------------------

      case "search_notion": {
        const { client_id, query } = args as { client_id: string; query: string };
        try {
          const data = await nangoPost("notion", client_id, "/v1/search", { query });
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
          const data = await nangoPost("notion", client_id, "/v1/pages", {
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

#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- Ensure .env exists ----
if [ ! -f .env ]; then
  echo "No .env found — copying from .env.example"
  cp .env.example .env
  echo ""
  echo "⚠️  Edit integrations/.env before continuing:"
  echo "   • Set INTEGRATION_SECRET_KEY"
  echo "   • Set INTEGRATION_SERVER_URL"
  echo ""
  read -rp "Press Enter to continue after editing .env..."
fi

# ---- Install MCP server deps if needed ----
if [ ! -d mcp-server/node_modules ]; then
  echo "Installing MCP server dependencies..."
  (cd mcp-server && npm install)
fi

# ---- Install auth portal deps if needed ----
if [ ! -d auth-portal/node_modules ]; then
  echo "Installing auth portal dependencies..."
  (cd auth-portal && npm install)
fi

# ---- Start auth portal in background ----
echo "Starting auth portal on http://localhost:3010..."
(cd auth-portal && npm run dev) &
AUTH_PID=$!
echo "Auth portal PID: $AUTH_PID"

echo ""
echo "✅ ClawBridge Integrations running!"
echo ""
echo "  Auth portal:      http://localhost:3010"
echo "  MCP server:       run 'cd integrations/mcp-server && npm run dev'"
echo ""
echo "Press Ctrl+C to stop the auth portal."

wait $AUTH_PID

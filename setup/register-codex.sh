#!/usr/bin/env bash
set -euo pipefail

# Run `codex login --device-auth` so Codex CLI saves a subscription OAuth
# token to ~/.codex/auth.json. The Codex agent-runner provider reads that
# file directly — no .env entry needed.

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI not found — installing it now…"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! bash "$SCRIPT_DIR/install-codex.sh"; then
    echo >&2
    echo "Couldn't install the Codex CLI automatically." >&2
    echo "Install it manually with:" >&2
    echo "  npm install -g @openai/codex" >&2
    echo "and re-run setup." >&2
    exit 1
  fi
  hash -r 2>/dev/null || true
fi

cat <<'INNER'
We'll open a Codex sign-in flow. Follow the device-auth URL in your browser,
sign in with your ChatGPT account, and approve the device. Codex will save
the token to ~/.codex/auth.json automatically.

Press Enter to continue.
INNER
read -r _

# Run interactively so the user can complete the OAuth flow.
codex login --device-auth

if [ ! -f "$HOME/.codex/auth.json" ]; then
  echo >&2
  echo "Codex login didn't write ~/.codex/auth.json." >&2
  echo "Re-run setup and try again." >&2
  exit 1
fi

echo "Codex authenticated. Token saved to ~/.codex/auth.json."

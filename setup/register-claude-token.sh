#!/usr/bin/env bash
set -euo pipefail

# Capture a Claude subscription OAuth token via `claude setup-token` and
# write it to .env as CLAUDE_CODE_OAUTH_TOKEN.
#
# Flow:
#   1. Run `claude setup-token` under a PTY (via script(1)) so the browser
#      OAuth dance works and its token is captured into a tempfile.
#   2. Regex the sk-ant-oat…AA token out of the ANSI-stripped capture.
#   3. Write it to .env using the set-env step.

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI not found — installing it now…"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! bash "$SCRIPT_DIR/install-claude.sh"; then
    echo >&2
    echo "Couldn't install the Claude Code CLI automatically." >&2
    echo "Install it manually with:" >&2
    echo "  curl -fsSL https://claude.ai/install.sh | bash" >&2
    echo "and re-run setup." >&2
    exit 1
  fi
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
fi

command -v script >/dev/null \
  || { echo "script(1) is required for PTY capture." >&2; exit 1; }

tmpfile=$(mktemp -t claude-setup-token.XXXXXX)
trap 'rm -f "$tmpfile"' EXIT

cat <<'EOF'
A browser window will open for you to sign in with your Claude account.
When you finish, we'll save the token to .env automatically.

Press Enter to continue, or edit the command first.

EOF

cmd="claude setup-token"
if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
  read -r -e -i "$cmd" -p "$ " cmd </dev/tty
else
  echo "$ $cmd"
  read -r -p "Press Enter to run, Ctrl-C to abort. " _ </dev/tty
fi

if script --version 2>/dev/null | grep -q util-linux; then
  script -q -c "$cmd" "$tmpfile"
else
  # shellcheck disable=SC2086
  script -q "$tmpfile" $cmd
fi

token=$(sed $'s/\x1b\\[[0-9;]*[a-zA-Z]//g' "$tmpfile" \
        | tr -d '\n\r' \
        | perl -ne 'print "$1\n" while /(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g' \
        | tail -1 || true)

if [ -z "$token" ]; then
  keep=$(mktemp -t claude-setup-token-log.XXXXXX)
  cp "$tmpfile" "$keep"
  echo >&2
  echo "No sk-ant-oat…AA token found. Raw log: $keep" >&2
  exit 1
fi

echo
echo "Got token: ${token:0:16}…${token: -4}"
echo "Saving to .env as CLAUDE_CODE_OAUTH_TOKEN…"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pnpm --silent exec tsx "$SCRIPT_DIR/index.ts" --step set-env -- \
  --key CLAUDE_CODE_OAUTH_TOKEN --value "$token"

echo "Done."

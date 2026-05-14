#!/usr/bin/env bash
# Install the OpenAI Codex CLI on the host via npm.
# Invoked from setup/register-codex.sh when the user picks the
# subscription auth path and `codex` is missing.

set -euo pipefail

echo "=== CLAWBRIDGE SETUP: INSTALL_CODEX ==="

if command -v codex >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "CODEX_VERSION: $(codex --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: npm not available. Install Node.js first."
  echo "=== END ==="
  exit 1
fi

echo "STEP: codex-npm-install"
npm install -g @openai/codex

hash -r 2>/dev/null || true

if ! command -v codex >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: codex not found on PATH after install."
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "CODEX_VERSION: $(codex --version 2>/dev/null || echo unknown)"
echo "=== END ==="

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export DOTENV_CONFIG_PATH="$PWD/.env.development"
export DOTENV_CONFIG_OVERRIDE=true

if command -v brew >/dev/null 2>&1; then
  brew services start postgresql@14 >/dev/null 2>&1 || true
  brew services start redis >/dev/null 2>&1 || true
fi

pnpm start


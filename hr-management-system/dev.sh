#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/server"

export DOTENV_CONFIG_PATH="$PWD/.env.development"
export DOTENV_CONFIG_OVERRIDE=true
export APP_ENV=development
export NODE_ENV=development

# dev 环境允许自动启动本机服务（不触碰 staging/prod）
if command -v pg_isready >/dev/null 2>&1; then
  pg_isready -h localhost -p 5432 >/dev/null 2>&1 || {
    if command -v brew >/dev/null 2>&1; then brew services start postgresql@14 >/dev/null 2>&1 || true; fi
  }
fi
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli ping >/dev/null 2>&1 || {
    if command -v brew >/dev/null 2>&1; then brew services start redis >/dev/null 2>&1 || true; fi
  }
fi

npm start


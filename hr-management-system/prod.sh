#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/server"

export DOTENV_CONFIG_PATH="$PWD/.env.production"
export DOTENV_CONFIG_OVERRIDE=true

# production 不允许自动操作数据库/Redis 服务
npm start


#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/server"

export DOTENV_CONFIG_PATH="$PWD/.env.staging"
export DOTENV_CONFIG_OVERRIDE=true

# staging 不允许自动操作数据库/Redis 服务
npm start


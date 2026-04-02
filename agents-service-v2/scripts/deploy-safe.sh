#!/usr/bin/env bash
# 标准安全部署入口（agents-service-v2 → 阿里云 ECS）
# 与仓库约定一致：修改本目录代码后 push main，由 .github/workflows/safe-deployment.yml 调用本脚本；
# 手动：cd agents-service-v2 && bash scripts/deploy-safe.sh
#
# 实际逻辑由 deploy-agents-ecs.sh 统一维护（verify → rsync → 远程 npm → apply-*.mjs → pm2 → health）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash "${ROOT}/scripts/deploy-agents-ecs.sh"

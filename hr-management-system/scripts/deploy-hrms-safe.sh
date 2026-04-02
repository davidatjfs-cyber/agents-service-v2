#!/usr/bin/env bash
# 标准安全部署入口（hr-management-system → 阿里云 ECS）
# 与仓库约定一致：修改本目录代码后 push main，由 .github/workflows/hrms-safe-deployment.yml 调用本脚本；
# 手动：cd hr-management-system && bash scripts/deploy-hrms-safe.sh
#
# 依赖 monorepo 根目录下的 scripts/（与 agents 同仓）。
set -euo pipefail
HRMS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${HRMS_DIR}/.." && pwd)"

if [[ ! -f "${REPO_ROOT}/scripts/deploy-hrms-server-ecs.sh" ]]; then
  echo "ERROR: 未找到 ${REPO_ROOT}/scripts/deploy-hrms-server-ecs.sh — 请在 HRMS monorepo 根目录克隆完整仓库后执行。" >&2
  exit 1
fi

echo ">>> deploy-hrms-safe: 服务端 (rsync + pm2 hrms-service)"
bash "${REPO_ROOT}/scripts/deploy-hrms-server-ecs.sh"

echo ">>> deploy-hrms-safe: 前端静态 (working-fixed / mobile-nav / sw.js + nginx)"
bash "${REPO_ROOT}/scripts/deploy-hrms-frontend.sh"

echo ">>> deploy-hrms-safe: 完成。"

#!/usr/bin/env bash
# 部署前本地验证：对 src 与 scripts 下全部 .js 做 node 语法检查；若有 Jest 配置则 npm test。
# 通过后再执行 deploy-agents-ecs.sh。紧急跳过验证：SKIP_VERIFY=1 bash deploy-agents-ecs.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo ">>> verify: node --check (src + scripts)"
# 不用 find -exec：macOS/BSD find 在子命令失败时未必让整条 verify 非 0
while IFS= read -r -d '' f; do node --check "$f"; done < <(find "${ROOT}/src" -name '*.js' -type f -print0)
while IFS= read -r -d '' f; do node --check "$f"; done < <(find "${ROOT}/scripts" -maxdepth 1 \( -name '*.js' -o -name '*.mjs' \) -type f -print0)

if [[ -x node_modules/.bin/jest ]] && { [[ -f jest.config.js ]] || [[ -f jest.config.cjs ]] || [[ -f jest.config.mjs ]]; }; then
  echo ">>> verify: npm test"
  npm test
else
  echo ">>> skip npm test (无 jest 配置文件；仅语法检查已执行)"
fi

echo ">>> verify OK"

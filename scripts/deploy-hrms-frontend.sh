#!/usr/bin/env bash
# deploy-hrms-frontend.sh
# 将 hr-management-system 前端静态文件部署到生产 ECS，并正确清除 SW 缓存。
#
# 用法：
#   ./scripts/deploy-hrms-frontend.sh
#
# 生产部署路径约定（必须与 nginx root 一致）：
#   nginx root    : /opt/hrms
#   真实入口 HTML : /opt/hrms/working-fixed.html
#                   /opt/hrms/mobile-nav-production.html
#   Service Worker: /opt/hrms/sw.js
#   nginx config  : /etc/nginx/sites-enabled/hrms  (root /opt/hrms;)
#
# ⚠️  注意：/opt/hrms/hr-management-system/ 只是文件夹，nginx 不从这里服务静态 HTML！
#           每次部署 HTML/sw.js 必须指向 /opt/hrms/，不要指向子目录。
set -euo pipefail

ECS_HOST="${ECS_HOST:-root@47.100.96.30}"
REMOTE_DIR="/opt/hrms"
LOCAL_SRC="$(cd "$(dirname "$0")/../hr-management-system" && pwd)"

echo ">>> [1/4] 验证本地源文件..."
for f in working-fixed.html mobile-nav-production.html sw.js forecast.html; do
  [[ -f "$LOCAL_SRC/$f" ]] || { echo "ERROR: 找不到 $LOCAL_SRC/$f"; exit 1; }
done
echo "    本地源: $LOCAL_SRC"

# 每次部署生成「唯一 CACHE_NAME」的 sw.js 再上传（不修改仓库内 sw.js，避免未提交的版本号漂移）。
# 否则仅改 HTML 时 sw 脚本字节不变 → 浏览器可能不 reinstall → activate 不删旧 Cache Storage；
# 与 deploy 日志里「SW 已升级」的表述也不一致。
HRMS_SW_TMP="$(mktemp)"
HRMS_SW_VER="hrms-pwa-$(date +%Y%m%d%H%M%S)"
sed -E "s/^const CACHE_NAME = '[^']+'/const CACHE_NAME = '${HRMS_SW_VER}'/" "$LOCAL_SRC/sw.js" > "$HRMS_SW_TMP"
trap 'rm -f "$HRMS_SW_TMP"' EXIT

echo ">>> [2/4] rsync 静态文件 -> $ECS_HOST:$REMOTE_DIR/（sw.js CACHE_NAME=$HRMS_SW_VER）"
rsync -avz --checksum -e ssh \
  "$LOCAL_SRC/working-fixed.html" \
  "$LOCAL_SRC/mobile-nav-production.html" \
  "$LOCAL_SRC/forecast.html" \
  "$ECS_HOST:$REMOTE_DIR/"
rsync -avz --checksum -e ssh "$HRMS_SW_TMP" "$ECS_HOST:$REMOTE_DIR/sw.js"

echo ">>> [3/4] 远端：确保 nginx 对 HTML 禁用 HTTP 缓存 + reload..."
ssh -o ConnectTimeout=30 "$ECS_HOST" bash -s <<'REMOTE'
set -euo pipefail
REMOTE_DIR="/opt/hrms"

# 与 deploy-hrms-server-ecs.sh 一致：nginx root=/opt/hrms 时 /uploads 必须指向 server/uploads
UP_REAL="/opt/hrms/server/uploads"
UP_WEB="/opt/hrms/uploads"
mkdir -p "$UP_REAL"
if [[ -L "$UP_WEB" ]]; then
  rm -f "$UP_WEB"
elif [[ -d "$UP_WEB" ]]; then
  if find "$UP_WEB" -mindepth 1 -print -quit | grep -q .; then
    mv "$UP_WEB" "${UP_WEB}.bak.$(date +%s)"
  else
    rmdir "$UP_WEB" 2>/dev/null || mv "$UP_WEB" "${UP_WEB}.bak.$(date +%s)"
  fi
fi
ln -sfn "$UP_REAL" "$UP_WEB"
echo "  OK: $UP_WEB -> $UP_REAL"

# Ensure nginx returns no-cache for HTML files (prevents HTTP cache layer from
# serving stale HTML, which would defeat the SW network-first strategy)
NGINX_CONF="/etc/nginx/sites-enabled/hrms"
if grep -q 'no-cache.*\.html' "$NGINX_CONF" 2>/dev/null; then
  echo "  OK: nginx HTML no-cache block already present"
else
  # Insert a location block for .html files before the final location / block
  python3 - "$NGINX_CONF" <<'PY'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
s = p.read_text()
block = '''
  # Always validate HTML with origin — prevents stale HTML being served from HTTP cache
  location ~* \\.html$ {
    add_header Cache-Control "no-cache, must-revalidate" always;
    add_header Pragma "no-cache" always;
    expires 0;
  }
'''
# Insert just before "location / {"
s2 = re.sub(r'(\s+location / \{)', block + r'\1', s, count=1)
if s2 == s:
    print("  WARN: could not find 'location / {' to insert block, skipping")
else:
    p.write_text(s2)
    print("  OK: nginx HTML no-cache block inserted")
PY
fi

echo "  检查文件是否包含新标记..."
python3 - <<'PY'
import pathlib, sys
p = pathlib.Path('/opt/hrms/working-fixed.html').read_text(errors='ignore')
need = ['pts-picker-', 'pts-rule-opt', 'pts-radio-dot', 'selectPointsRule', 'dr-holiday-switch']
bad = [n for n in need if n not in p]
if bad:
    print('FAIL: 以下标记缺失 =>', bad)
    sys.exit(1)
else:
    print('  OK: working-fixed.html 包含所有新标记（含营业日报节假日开关）')

sw = pathlib.Path('/opt/hrms/sw.js').read_text(errors='ignore')
import re
m = re.search(r"CACHE_NAME = '([^']+)'", sw)
print('  OK: sw.js CACHE_NAME =', m.group(1) if m else '?')
PY

systemctl reload nginx
echo "  OK: nginx reloaded"
REMOTE

echo ">>> [4/4] HTTP 抽检 (通过 localhost)..."
ssh -o ConnectTimeout=30 "$ECS_HOST" bash -s <<'REMOTE'
python3 - <<'PY'
import urllib.request, sys, time
url = 'http://127.0.0.1:3000/working-fixed.html'
for attempt in range(3):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            body = r.read().decode('utf-8', errors='ignore')
        if 'pts-picker-' in body:
            print('  OK: HTTP 服务确认包含新 UI 标记 (pts-picker-)')
            sys.exit(0)
        else:
            print(f'  WARN[attempt {attempt+1}]: HTTP body 不含 pts-picker-，可能仍由旧 Express 提供')
            time.sleep(1)
    except Exception as e:
        print(f'  WARN[attempt {attempt+1}]: HTTP 请求失败 => {e}')
        time.sleep(1)
print('  (Note: 若 Express 不服务 /working-fixed.html 直接路由，nginx 静态已更新即可)')
PY
REMOTE

echo ""
echo "✅  部署完成。"
echo ""
echo "  Service Worker：本次已上传独立 CACHE_NAME 的 sw.js，激活后会清理旧 Cache Storage。"
echo "  若仍看到旧页面：关闭该站点全部标签页再打开，或系统设置里清除站点数据。"

#!/usr/bin/env bash
# 每日自动：提交并推送 HRMS 单仓（含 agents-service-v2 + hr-management-system）到 GitHub。
#
# 一次性配置（本机或 ECS）：
#   cd /path/to/HRMS
#   git remote add origin https://github.com/OWNER/REPO.git
#   # 推荐 HTTPS + PAT（私人仓库需 repo 权限）：
#   git remote set-url origin https://x-access-token:${GITHUB_TOKEN}@github.com/OWNER/REPO.git
#
# 手动试跑：
#   HRMS_DIR=/path/to/HRMS bash scripts/daily-push-github.sh
#
# macOS 定时：见 scripts/com.hrms.daily-github-push.plist
# ECS 定时示例（每天 03:10）：
#   10 3 * * * HRMS_DIR=/opt/hrms-src GITHUB_TOKEN=... bash /opt/hrms-src/scripts/daily-push-github.sh
#
set -euo pipefail

REPO_ROOT="${HRMS_DIR:-${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}}"
REMOTE="${GIT_REMOTE:-origin}"
BRANCH="${GIT_BRANCH:-main}"
LOG_FILE="${GIT_AUTO_PUSH_LOG:-/tmp/hrms_daily_git_push.log}"
DO_PULL="${GIT_AUTO_PULL:-1}"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG_FILE"
}

cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "ERROR: not a git repository: $REPO_ROOT"
  exit 1
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  log "ERROR: git remote '$REMOTE' not configured. Add origin first."
  exit 1
fi

if [[ "$DO_PULL" == "1" || "$DO_PULL" == "true" || "$DO_PULL" == "yes" ]]; then
  git fetch "$REMOTE" "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || true
  if git show-ref --verify --quiet "refs/remotes/${REMOTE}/${BRANCH}"; then
    git pull --rebase "$REMOTE" "$BRANCH" 2>&1 | tee -a "$LOG_FILE" || {
      log "ERROR: git pull --rebase failed (resolve conflicts manually)"
      exit 1
    }
  fi
fi

if [[ -z "$(git status --porcelain)" ]]; then
  log "OK: working tree clean, nothing to push"
  exit 0
fi

git add -A
MSG="${AUTO_COMMIT_MESSAGE:-chore(sync): daily backup $(date '+%Y-%m-%d %H:%M')}"
git commit -m "$MSG" 2>&1 | tee -a "$LOG_FILE" || {
  log "ERROR: git commit failed"
  exit 1
}

git push "$REMOTE" "$BRANCH" 2>&1 | tee -a "$LOG_FILE"
log "OK: pushed to ${REMOTE}/${BRANCH}"

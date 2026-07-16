#!/usr/bin/env bash
# Deploy the committed (HEAD) state to a versioned release under
# ~/.local/lib/lark-daemon/releases and point pm2 at it.
# The working tree is never deployed — commit first, then run this.
# Config lives in one shared file (~/.local/lib/lark-daemon/env); every
# release symlinks its .env to it, so edits there survive deploys.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$HOME/.local/lib/lark-daemon"
ENV_FILE="$BASE/env"
DEPLOY_LOCK="$BASE/deploy.lock"

mkdir -p "$BASE/releases"
if ! mkdir "$DEPLOY_LOCK" 2>/dev/null; then
  echo "another lark-daemon deploy is already running: $DEPLOY_LOCK"
  exit 1
fi
trap 'rmdir "$DEPLOY_LOCK" 2>/dev/null || true' EXIT

cd "$REPO"
REF="${1:-HEAD}"
COMMIT=$(git rev-parse --short "$REF")
PREFIX=$(git rev-parse --show-prefix)
TOPLEVEL=$(git rev-parse --show-toplevel)

REL="$BASE/releases/pending-$$"
mkdir -p "$REL"
# <ref>:<path> must be resolved from the repo root; from a subdir it silently
# produces an empty archive.
if [ -n "$PREFIX" ]; then
  git -C "$TOPLEVEL" archive "$REF:${PREFIX%/}" | tar -x -C "$REL"
else
  git archive "$REF" | tar -x -C "$REL"
fi

VERSION=$(node -p "require('$REL/package.json').version")
FINAL="$BASE/releases/$VERSION-$(date +%Y%m%d-%H%M%S)-$COMMIT"
mv "$REL" "$FINAL"
REL="$FINAL"

[ -f "$ENV_FILE" ] || { cp "$REPO/.env" "$ENV_FILE"; echo "seeded $ENV_FILE from repo .env — review it"; }
ln -sf "$ENV_FILE" "$REL/.env"

echo "running tests in $REL ..."
(cd "$REL" && npm test >/dev/null && npm run check >/dev/null) || { echo "tests failed — aborting deploy"; exit 1; }

pm2 delete lark-daemon lark-web >/dev/null 2>&1 || true
pm2 start "$REL/ecosystem.config.cjs"
pm2 save >/dev/null

PORTS=3737
grep -q "lark-web" "$REL/ecosystem.config.cjs" && PORTS="3737 3738"

for _ in $(seq 30); do
  sleep 1
  ok=1
  for port in $PORTS; do
    curl -sf "http://127.0.0.1:$port/ready" >/dev/null 2>&1 || ok=0
  done
  if [ "$ok" = 1 ]; then
    echo "deployed $REL"
    ls -1dt "$BASE"/releases/* | tail -n +4 | xargs rm -rf
    exit 0
  fi
done
echo "daemon/web not ready after 30s — check: pm2 logs lark-daemon lark-web"
exit 1

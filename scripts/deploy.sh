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

cd "$REPO"
COMMIT=$(git rev-parse --short HEAD)
PREFIX=$(git rev-parse --show-prefix)
TOPLEVEL=$(git rev-parse --show-toplevel)

REL="$BASE/releases/pending-$$"
mkdir -p "$REL"
# HEAD:<path> must be resolved from the repo root; from a subdir it silently
# produces an empty archive.
if [ -n "$PREFIX" ]; then
  git -C "$TOPLEVEL" archive "HEAD:${PREFIX%/}" | tar -x -C "$REL"
else
  git archive HEAD | tar -x -C "$REL"
fi

VERSION=$(node -p "require('$REL/package.json').version")
FINAL="$BASE/releases/$VERSION-$(date +%Y%m%d-%H%M%S)-$COMMIT"
mv "$REL" "$FINAL"
REL="$FINAL"

# App root: monorepo (packages/daemon) or flat layout.
APP="$REL"
[ -d "$REL/packages/daemon" ] && APP="$REL/packages/daemon"

[ -f "$ENV_FILE" ] || { cp "$REPO/.env" "$ENV_FILE"; echo "seeded $ENV_FILE from repo .env — review it"; }
ln -sf "$ENV_FILE" "$APP/.env"

echo "running tests in $APP ..."
(cd "$APP" && npm test --if-present >/dev/null) || { echo "tests failed — aborting deploy"; exit 1; }

pm2 delete lark-daemon lark-web >/dev/null 2>&1 || true
pm2 start "$REL/ecosystem.config.cjs"
pm2 save >/dev/null

for _ in $(seq 30); do
  sleep 1
  for port in 3737 3738; do
    if curl -sf "http://127.0.0.1:$port/ready" >/dev/null 2>&1; then
      echo "deployed $REL"
      ls -1dt "$BASE"/releases/* | tail -n +4 | xargs rm -rf
      exit 0
    fi
  done
done
echo "daemon not ready after 30s — check: pm2 logs lark-daemon"
exit 1

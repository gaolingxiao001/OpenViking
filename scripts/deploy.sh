#!/usr/bin/env bash
# Bootstrap or repair the updater control plane by publishing a committed
# local ref as a versioned release under
# ~/.local/lib/lark-daemon/releases and move the current release pointer.
# The working tree is never deployed — commit first, then run this.
# Config lives in one shared file (~/.local/lib/lark-daemon/env); every
# release symlinks its .env to it, so edits there survive publishes.
#
# This script deliberately does not touch PM2. After the initial bootstrap,
# normal updates use only `lark-daemon upgrade zayn|sally|all`; the updater
# fetches trusted upstream main and publishes the release itself.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$HOME/.local/lib/lark-daemon"
ENV_FILE="$BASE/env"
DEPLOY_LOCK="$BASE/deploy.lock"
CLI_LINK="$HOME/.local/bin/lark-daemon"
CLI_TARGET="$BASE/current/packages/updater/bin/lark-daemon.mjs"

if [ -L "$CLI_LINK" ]; then
  EXISTING_TARGET="$(readlink "$CLI_LINK")"
  case "$EXISTING_TARGET" in
    "$BASE"/*) ;;
    *) echo "refusing to replace foreign CLI symlink: $CLI_LINK -> $EXISTING_TARGET"; exit 1 ;;
  esac
elif [ -e "$CLI_LINK" ]; then
  echo "refusing to replace existing CLI path: $CLI_LINK"
  exit 1
fi

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

# Keep the previously published release addressable. Runtime processes are not
# changed here, so publishing can be retried without interrupting either bot.
PREV="$(readlink "$BASE/current" 2>/dev/null || true)"
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  ln -sfn "$PREV" "$BASE/rollback"
fi
ln -sfn "$REL" "$BASE/current"
mkdir -p "$HOME/.local/bin"
ln -sfn "$CLI_TARGET" "$CLI_LINK"

# Running processes still execute files from their current release, so publish
# never prunes releases underneath PM2. Cleanup belongs after an observed
# successful `upgrade all`.
echo "published $REL"
echo "bootstrap/refresh the updater with: ./scripts/bootstrap-updater.sh"
echo "then roll out with: lark-daemon upgrade zayn|sally|all"

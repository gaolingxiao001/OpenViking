#!/usr/bin/env bash
# One-time control-plane bootstrap after publishing a release that changes the
# updater protocol. It reloads only lark-updater, verifies the exact exec path
# and private socket, and restores the prior updater release on failure.
set -euo pipefail

BASE="$HOME/.local/lib/lark-daemon"
CURRENT="$BASE/current"
CONFIG="$CURRENT/ecosystem.config.cjs"
SOCKET="$HOME/.local/share/lark-daemon/updater.sock"
NODE_BIN="/opt/homebrew/bin/node"

pm2_control() {
  env -i \
    HOME="$HOME" \
    USER="${USER:-}" \
    LOGNAME="${LOGNAME:-${USER:-}}" \
    PATH="$PATH" \
    PM2_HOME="${PM2_HOME:-$HOME/.pm2}" \
    LANG="${LANG:-C.UTF-8}" \
    pm2 "$@"
}

[ -f "$CONFIG" ] || { echo "published ecosystem config not found: $CONFIG"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "node not found: $NODE_BIN"; exit 1; }

PREVIOUS_EXEC="$({ pm2_control jlist || true; } | "$NODE_BIN" -e '
  const fs = require("node:fs");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    let rows = [];
    try { rows = JSON.parse(input || "[]"); } catch {}
    const row = rows.find((item) => item?.name === "lark-updater");
    if (row?.pm2_env?.pm_exec_path) {
      try { process.stdout.write(fs.realpathSync(row.pm2_env.pm_exec_path)); } catch {}
    }
  });
')"

rollback() {
  if [ -z "$PREVIOUS_EXEC" ]; then
    pm2_control delete lark-updater >/dev/null 2>&1 || true
    echo "updater bootstrap failed; no previous updater was available"
    return
  fi
  case "$PREVIOUS_EXEC" in
    "$BASE"/releases/*/packages/updater/src/main.mjs)
      PREVIOUS_RELEASE="${PREVIOUS_EXEC%/packages/updater/src/main.mjs}"
      echo "updater bootstrap failed; restoring $PREVIOUS_RELEASE"
      if pm2_control startOrReload "$PREVIOUS_RELEASE/ecosystem.config.cjs" \
        --only lark-updater --update-env >/dev/null 2>&1; then
        pm2_control save >/dev/null 2>&1 || true
      fi
      ;;
    *)
      echo "updater bootstrap failed; refusing to execute foreign previous path: $PREVIOUS_EXEC"
      ;;
  esac
}

trap rollback ERR
pm2_control startOrReload "$CONFIG" --only lark-updater --update-env >/dev/null

for _ in $(seq 20); do
  if curl -sf --unix-socket "$SOCKET" http://localhost/ready >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf --unix-socket "$SOCKET" http://localhost/ready >/dev/null

CURRENT_RELEASE="$($NODE_BIN -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "$CURRENT")"
pm2_control jlist | CURRENT_RELEASE="$CURRENT_RELEASE" "$NODE_BIN" -e '
  const path = require("node:path");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const rows = JSON.parse(input || "[]").filter((item) => item?.name === "lark-updater");
    if (rows.length !== 1 || rows[0]?.pm2_env?.status !== "online") process.exit(1);
    const execPath = rows[0]?.pm2_env?.pm_exec_path || "";
    const relative = path.relative(process.env.CURRENT_RELEASE, execPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) process.exit(1);
  });
'
pm2_control save >/dev/null
trap - ERR
echo "lark-updater is ready on $CURRENT_RELEASE"

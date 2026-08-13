#!/usr/bin/env bash
# One-time control-plane bootstrap after publishing a release that changes the
# updater protocol. It replaces only lark-updater, verifies the exact exec path
# and private socket, and restores the prior updater release on failure.
set -euo pipefail

BASE="$HOME/.local/lib/lark-daemon"
CURRENT="$BASE/current"
SOCKET="$HOME/.local/share/lark-daemon/updater.sock"
NODE_BIN="$(command -v node || true)"

pm2_control() {
  local clean_env=(
    "HOME=$HOME"
    "USER=${USER:-}"
    "LOGNAME=${LOGNAME:-${USER:-}}"
    "PATH=$PATH"
    "PM2_HOME=${PM2_HOME:-$HOME/.pm2}"
    "LANG=${LANG:-C.UTF-8}"
  )
  local key
  for key in \
    LARK_DAEMON_DEPLOYMENT_MANIFEST \
    TEAM_TASK_BOARD_URL LARK_CLI_BIN CODEX_BIN CLAUDE_BIN \
    LARK_DAEMON_LOG_LEVEL LARK_DAEMON_DRY_RUN LARK_DAEMON_IGNORED_SENDER_IDS \
    LARK_DAEMON_SEND_TIMEOUT_MS LARK_DAEMON_SHUTDOWN_TIMEOUT_MS \
    LARK_DAEMON_MAX_REPLY_CHARS LARK_DAEMON_MAX_EVENT_BYTES \
    LARK_DAEMON_MAX_EVENT_AGE_MS LARK_DAEMON_IDLE_REACTION_AFTER_MS \
    LARK_DAEMON_RETENTION_MS LARK_DAEMON_CODEX_EFFORT \
    LARK_DAEMON_CLAUDE_EFFORT LARK_DAEMON_CLAUDE_MODEL FALLBACK_MODEL \
    LARK_DAEMON_COGNITION_MAX_CHARS LARK_DAEMON_HISTORY_LIMIT
  do
    if declare -p "$key" >/dev/null 2>&1; then
      clean_env+=("$key=${!key}")
    fi
  done
  env -i \
    "${clean_env[@]}" \
    pm2 "$@"
}

[ -x "$NODE_BIN" ] || { echo "node not found: $NODE_BIN"; exit 1; }

CURRENT_RELEASE="$($NODE_BIN -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "$CURRENT")"
CONFIG="$CURRENT_RELEASE/ecosystem.config.cjs"
[ -f "$CONFIG" ] || { echo "published ecosystem config not found: $CONFIG"; exit 1; }

PREVIOUS_EXEC="$({ pm2_control jlist || true; } | BASE="$BASE" "$NODE_BIN" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    let rows = [];
    try { rows = JSON.parse(input || "[]"); } catch {}
    const row = rows.find((item) => item?.name === "lark-updater");
    if (row?.pm2_env?.pm_exec_path) {
      try {
        const raw = path.resolve(row.pm2_env.pm_exec_path);
        const current = path.join(process.env.BASE, "current");
        const release = raw.startsWith(`${current}${path.sep}`)
          ? fs.realpathSync(path.join(process.env.BASE, "rollback"))
          : path.dirname(path.dirname(path.dirname(path.dirname(fs.realpathSync(raw)))));
        process.stdout.write(path.join(release, "packages", "updater", "src", "main.mjs"));
      } catch {}
    }
  });
')"

rollback() {
  pm2_control delete lark-updater >/dev/null 2>&1 || true
  if [ -z "$PREVIOUS_EXEC" ]; then
    echo "updater bootstrap failed; no previous updater was available"
    return
  fi
  case "$PREVIOUS_EXEC" in
    "$BASE"/releases/*/packages/updater/src/main.mjs)
      PREVIOUS_RELEASE="${PREVIOUS_EXEC%/packages/updater/src/main.mjs}"
      echo "updater bootstrap failed; restoring $PREVIOUS_RELEASE"
      if pm2_control start "$PREVIOUS_RELEASE/ecosystem.config.cjs" \
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
if [ -n "$PREVIOUS_EXEC" ]; then
  pm2_control delete lark-updater >/dev/null
fi
pm2_control start "$CONFIG" --only lark-updater --update-env >/dev/null

pm2_control jlist | CURRENT_RELEASE="$CURRENT_RELEASE" "$NODE_BIN" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const rows = JSON.parse(input || "[]").filter((item) => item?.name === "lark-updater");
    if (rows.length !== 1 || rows[0]?.pm2_env?.status !== "online") process.exit(1);
    let execPath = rows[0]?.pm2_env?.pm_exec_path || "";
    try { execPath = fs.realpathSync(execPath); } catch { process.exit(1); }
    const relative = path.relative(process.env.CURRENT_RELEASE, execPath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) process.exit(1);
  });
'

for _ in $(seq 20); do
  if curl -sf --unix-socket "$SOCKET" http://localhost/ready >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf --unix-socket "$SOCKET" http://localhost/ready >/dev/null

pm2_control save >/dev/null
trap - ERR
echo "lark-updater is ready on $CURRENT_RELEASE"

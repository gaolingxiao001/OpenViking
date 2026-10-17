#!/bin/sh
# Vika installer.
#
#   curl -fsSL <download base>/install.sh | sh
#   sh scripts/install.sh --file dist/vika-<version>-<platform>.tar.gz   # a local build
#
# Installs the release for this machine under ~/.vika (releases/<version>,
# the `current` link, bin/vika) and then runs `vika setup`. Needs only sh,
# curl, tar and sha256sum or shasum: the release brings its own Node, pm2 and
# lark-cli, so nothing else on the machine is used or changed.
#
# Options: --version <v> (default: latest), --file <archive>, --no-setup.
# Environment: VIKA_DOWNLOAD_BASE overrides where releases are downloaded from.
set -eu
# Always ${NAME} before non-ASCII text: macOS /bin/sh (bash 3.2) counts
# UTF-8 lead bytes as name characters, so "$VERSION（" names another variable.

BASE="${VIKA_DOWNLOAD_BASE:-__VIKA_DOWNLOAD_BASE__}"
VIKA_HOME="$HOME/.vika"
VERSION="${VIKA_VERSION:-}"
FILE=""
RUN_SETUP=1

say() { printf '%s\n' "$*" >&2; }
die() { say "vika 安装失败：$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version 需要一个值"; VERSION="$2"; shift 2 ;;
    --file) [ $# -ge 2 ] || die "--file 需要一个文件"; FILE="$2"; shift 2 ;;
    --no-setup) RUN_SETUP=0; shift ;;
    *) die "不认识的参数 $1" ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "不支持 $(uname -s)；Windows 请在 WSL2 里安装" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "不支持 CPU 架构 $(uname -m)" ;;
esac
if [ "$os" = linux ]; then
  # The release's Node is linked against glibc; it does not start on musl (Alpine).
  if (ldd --version 2>&1 || true) | grep -qi musl; then die "不支持 musl（Alpine 等）系统"; fi
fi
PLATFORM="$os-$arch"

command -v tar >/dev/null 2>&1 || die "需要 tar"
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "需要 sha256sum 或 shasum"; fi
}
fetch() {
  # The test bucket is private; drop the access key once releases are public.
  if [ -n "${VIKA_TOS_ACCESS_KEY:-}" ]; then
    curl -fsSL --retry 3 -H "x-tos-access: $VIKA_TOS_ACCESS_KEY" -o "$2" "$1"
  else
    curl -fsSL --retry 3 -o "$2" "$1"
  fi
}

TMP=$(mktemp -d)
LOCK=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$LOCK" ] || rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "找不到 $FILE"
  ARCHIVE="$FILE"
  if [ -f "$FILE.sha256" ]; then EXPECTED=$(cut -d' ' -f1 < "$FILE.sha256"); else EXPECTED=""; fi
else
  command -v curl >/dev/null 2>&1 || die "需要 curl"
  case "$BASE" in http://*|https://*) ;; *) die "没有下载地址：设置 VIKA_DOWNLOAD_BASE" ;; esac
  if [ -z "$VERSION" ]; then
    fetch "$BASE/latest" "$TMP/latest" || die "读不到最新版本：$BASE/latest"
    VERSION=$(tr -d ' \r\n' < "$TMP/latest")
  fi
  case "$VERSION" in ''|*[!0-9A-Za-z._-]*) die "版本号无效：$VERSION" ;; esac
  NAME="vika-$VERSION-$PLATFORM.tar.gz"
  say "下载 Vika ${VERSION}（${PLATFORM}）..."
  fetch "$BASE/releases/$VERSION/$NAME.sha256" "$TMP/sha256" || die "这个版本没有 $PLATFORM 的安装包"
  EXPECTED=$(cut -d' ' -f1 < "$TMP/sha256")
  fetch "$BASE/releases/$VERSION/$NAME" "$TMP/$NAME" || die "下载失败：$NAME"
  ARCHIVE="$TMP/$NAME"
fi
if [ -n "$EXPECTED" ]; then
  [ "$(sha256 "$ARCHIVE")" = "$EXPECTED" ] || die "安装包校验失败（SHA-256 不一致）"
else
  say "注意：$FILE 旁边没有 .sha256，跳过校验"
fi

mkdir -p "$VIKA_HOME/releases"
# The updater takes the same lock while it upgrades.
mkdir "$VIKA_HOME/deploy.lock" 2>/dev/null || die "另一个安装或升级正在进行（$VIKA_HOME/deploy.lock）"
LOCK="$VIKA_HOME/deploy.lock"

PENDING="$VIKA_HOME/releases/.pending-$$"
rm -rf "$PENDING"
mkdir "$PENDING"
tar -xzf "$ARCHIVE" -C "$PENDING" || { rm -rf "$PENDING"; die "解压失败"; }
DIR=$(ls "$PENDING")
case "$DIR" in
  vika-*-"$PLATFORM") ;;
  *) rm -rf "$PENDING"; die "安装包不是给 $PLATFORM 的：$DIR" ;;
esac
VERSION=${DIR#vika-}
VERSION=${VERSION%-"$PLATFORM"}
# Run the new release's own Node before anything points at it: a glibc or
# CPU mismatch surfaces here and the existing install is left untouched.
if ! "$PENDING/$DIR/node/bin/node" "$PENDING/$DIR/packages/cli/bin/vika.mjs" --version >/dev/null 2>&1; then
  rm -rf "$PENDING"
  die "这台机器运行不了这个版本（系统库太旧或 CPU 不匹配）"
fi

# Physical paths: /home may be a symlink, and the updater links real paths.
physical() { (cd "$1" 2>/dev/null && pwd -P) || true; }
TARGET="$VIKA_HOME/releases/$VERSION"
PREVIOUS=$(physical "$VIKA_HOME/current")
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" = "$(physical "$TARGET")" ]; then
  rm -rf "$PENDING"
  say "已经是 Vika $VERSION"
else
  rm -rf "$TARGET"
  mv "$PENDING/$DIR" "$TARGET"
  rmdir "$PENDING"
  [ -z "$PREVIOUS" ] || ln -sfn "$PREVIOUS" "$VIKA_HOME/rollback"
  ln -sfn "$(physical "$TARGET")" "$VIKA_HOME/current"
  say "已安装 Vika $VERSION 到 $TARGET"
fi

mkdir -p "$VIKA_HOME/bin"
cat > "$VIKA_HOME/bin/vika" <<'LAUNCHER'
#!/bin/sh
# Always the installed release: `current` moves on upgrade, this file does not.
exec "$HOME/.vika/current/node/bin/node" "$HOME/.vika/current/packages/cli/bin/vika.mjs" "$@"
LAUNCHER
chmod 755 "$VIKA_HOME/bin/vika"

case ":$PATH:" in
  *":$VIKA_HOME/bin:"*) ;;
  *)
    case "$(basename "${SHELL:-sh}")" in
      zsh) RC="$HOME/.zshrc" ;;
      bash) if [ "$os" = darwin ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi ;;
      *) RC="$HOME/.profile" ;;
    esac
    if ! grep -q '/.vika/bin' "$RC" 2>/dev/null; then
      printf '\n# vika\nexport PATH="$HOME/.vika/bin:$PATH"\n' >> "$RC"
      say "已把 ~/.vika/bin 加进 ${RC}；新开的终端里可以直接用 vika"
    fi
    ;;
esac

rmdir "$LOCK" 2>/dev/null || true
LOCK=""
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$(physical "$TARGET")" ]; then
  say "运行中的实例还在旧版本上：执行 vika restart 换到 $VERSION"
elif [ -z "$PREVIOUS" ] && [ "$RUN_SETUP" = 1 ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
  say ""
  cleanup
  trap - EXIT INT TERM
  exec "$VIKA_HOME/bin/vika" setup </dev/tty
elif [ -z "$PREVIOUS" ]; then
  say "下一步：$VIKA_HOME/bin/vika setup"
fi

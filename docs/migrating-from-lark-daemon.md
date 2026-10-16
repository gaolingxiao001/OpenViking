# 从 lark-daemon 迁移到 Vika

项目改名为 Vika 时一次性换掉了所有名字，没有兼容层。已经在跑的实例按下面的步骤手工迁移一次；数据目录不用动。

| 旧 | 新 |
| --- | --- |
| `~/.lark-daemon/deployment.json` | `~/.vika/config.json` |
| `~/.lark-daemon/secrets.env` | `~/.vika/secrets.env` |
| `~/.local/lib/lark-daemon/`（releases、current、updater 的 git 镜像） | `~/.vika/` |
| `~/.local/share/lark-daemon/updater.sock` | `~/.vika/updater.sock` |
| `<dataDir>/lark-daemon.sqlite3` | `<dataDir>/vika.sqlite3` |
| 命令 `lark-daemon upgrade` | `vika upgrade` |
| pm2 进程 `lark-daemon-<id>`、`lark-web`、`lark-updater` | `vika-<id>`、`vika-web`、`vika-updater` |
| 环境变量 `LARK_DAEMON_*`、`LARK_WEB_*`、`LARK_UPDATER_*` | `VIKA_*`、`VIKA_WEB_*`、`VIKA_UPDATER_*` |
| `LARK_DAEMON_DEPLOYMENT_MANIFEST` | `VIKA_CONFIG` |
| `LARK_DAEMON_PROFILE` | `VIKA_LARK_PROFILE` |

`LARK_CLI_BIN` 和 lark-cli 自己的 `LARKSUITE_CLI_*` 不变。实例 id 不能再叫 `web` 或 `updater`。

## 步骤

1. 停掉旧进程。只删本部署的进程，逐个写全名：

   ```bash
   pm2 delete lark-daemon-<id> lark-web lark-updater
   pm2 save
   ```

2. 搬配置并改 env 的 key：

   ```bash
   mkdir -p ~/.vika
   cp ~/.lark-daemon/deployment.json ~/.vika/config.json
   sed -i.bak -e 's/"LARK_DAEMON_DEPLOYMENT_MANIFEST"/"VIKA_CONFIG"/' \
     -e 's/"LARK_DAEMON_PROFILE"/"VIKA_LARK_PROFILE"/' \
     -e 's/"LARK_DAEMON_/"VIKA_/' ~/.vika/config.json
   [ -f ~/.lark-daemon/secrets.env ] && cp ~/.lark-daemon/secrets.env ~/.vika/secrets.env
   ```

   macOS 的 `sed` 一样认 `-i.bak`。`emailConfig`、`ovConfig` 等写的是绝对路径，原文件留在 `~/.lark-daemon` 也能用。

3. 按新规则改 `~/.vika/config.json`：
   - 没有 `lark` Connector 的实例（例如纯微信）删掉 `profile`，否则启动会报 `profile is only used by the lark connector`。
   - `ovConfig` 现在可选；不用 OV 的实例可以删掉。

4. 每个实例的数据库改名，连同 SQLite 的 `-wal`、`-shm` 文件：

   ```bash
   for f in <dataDir>/lark-daemon.sqlite3*; do mv "$f" "${f/lark-daemon.sqlite3/vika.sqlite3}"; done
   ```

5. 自己 shell 里 export 过的 `LARK_DAEMON_*` 等变量，按上表改名。

6. 从源码目录发布并启动：

   ```bash
   ./scripts/deploy.sh <git-ref>
   ./scripts/bootstrap-updater.sh
   vika upgrade all
   ```

7. 确认 `pm2 status vika-<id> vika-web vika-updater` 都是 online，并在飞书里收发一条消息后，再删掉旧目录：`~/.local/lib/lark-daemon`、`~/.local/bin/lark-daemon`。`~/.lark-daemon` 里还有 `emailConfig` 等被引用的文件时先保留。

## 已知影响

- 迁移前发出、还没回答的单选卡片和邮件审批卡片点了不会生效：卡片按钮里的回调字段改名了。重新让 agent 发一次即可，这类卡片本来也只有 3 天有效期。
- 运行时的 prompt 变了，每个实例会开一次新的原生会话；配了 OV 的实例照常从 OV 接上下文。

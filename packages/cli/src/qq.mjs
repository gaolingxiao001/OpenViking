import { loginQQ } from '../../daemon/src/qq/auth.mjs';
import { QQError } from '../../daemon/src/qq/api.mjs';
import { QQState } from '../../daemon/src/qq/state.mjs';
import { GoBack, PromptAborted } from './prompt.mjs';

function explain(error) {
  if (/already in use/.test(error.message)) return '这个实例正在接收 QQ 消息，请先停止实例再重新授权。';
  if (/Invalid QQ AppID or AppSecret/.test(error.message)) return 'AppID 或 AppSecret 格式不正确，请完整复制。';
  if (error instanceof QQError) return `QQ 验证失败（HTTP ${error.status}，错误码 ${error.code ?? '未知'}），请检查密钥和机器人权限。`;
  if (/gateway/.test(error.message)) return 'QQ 长连接失败，请检查网络、机器人上线状态以及单聊消息权限。';
  if (error.name === 'TimeoutError') return '绑定超时，请重新输入密钥，并在 3 分钟内向机器人私聊发送新的验证码。';
  return 'QQ 连接失败，请检查网络和机器人配置后重试。';
}

export async function connectQQ({ plan, prompter, fetchImpl = globalThis.fetch, gatewayFactory, canGoBack = false }) {
  prompter.section('QQ');
  prompter.info('在腾讯官方 https://q.qq.com/qqbot/openclaw/ 创建机器人，复制 AppID 和 AppSecret，并用 QQ 添加这个机器人。');
  prompter.info('每个 Vika 实例使用一个独立机器人；启用单聊消息权限，接入后只接受完成验证码绑定的本人私聊。');
  if (canGoBack) prompter.info('输入密钥或等待绑定时，按 ← / Esc 可以返回。');
  const navigable = prompter.navigable;
  try {
    for (;;) {
      prompter.navigable = canGoBack;
      const appId = (await prompter.text('QQ AppID')).trim();
      const appSecret = await prompter.secret('QQ AppSecret');
      prompter.navigable = false;
      try {
        await verify({ plan, prompter, appId, appSecret, fetchImpl, gatewayFactory, canGoBack });
        prompter.success('QQ 已接好；实例启动后，在这个机器人的私聊中发任务即可。');
        return;
      } catch (error) {
        if (error instanceof GoBack || error instanceof PromptAborted) throw error;
        prompter.warn(explain(error));
        prompter.navigable = canGoBack;
        const next = await prompter.select('接下来怎么办', [
          { label: '重新输入 AppID / AppSecret 并绑定', value: 'retry' },
          { label: canGoBack ? '返回上一步' : '退出接入', value: 'leave' },
        ]);
        if (next === 'leave') throw canGoBack ? new GoBack() : new PromptAborted();
      }
    }
  } finally { prompter.navigable = navigable; }
}

async function verify({ plan, prompter, appId, appSecret, fetchImpl, gatewayFactory, canGoBack }) {
  const state = new QQState(plan.dataDir);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
  const keys = prompter.watchKey(null, { onBack: canGoBack ? () => controller.abort(new GoBack()) : null });
  try {
    await loginQQ({ state, appId, appSecret, fetchImpl, gatewayFactory, signal,
      onChallenge: ({ challenge }) => {
        prompter.info('请在 3 分钟内，用你自己的 QQ 向机器人私聊发送下面一整行（不要发到群里）：');
        prompter.write(`\n${challenge}\n\n`);
        prompter.info('等待 QQ 私聊验证…');
      },
    });
  } catch (error) { throw signal.aborted ? signal.reason : error; }
  finally { keys.stop(); state.close(); }
}

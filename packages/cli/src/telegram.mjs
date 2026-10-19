import { TelegramState } from '../../daemon/src/telegram/state.mjs';
import { TelegramError } from '../../daemon/src/telegram/api.mjs';
import { loginTelegram } from '../../daemon/src/telegram/auth.mjs';
import { GoBack, PromptAborted } from './prompt.mjs';
import { showScan } from './qr.mjs';

function explain(error) {
  if (error instanceof TelegramError) {
    if ([401, 404].includes(error.code)) return 'Bot token 无效或已撤销，请从官方 @BotFather 重新复制。';
    if (error.code === 409) return '这个 Bot 正被其他客户端接收，请停止那个客户端，或创建独立 Bot。';
    if (error.code === 429) return 'Telegram 请求过于频繁，请稍后再试。';
  }
  if (error.name === 'TimeoutError') return '绑定超时，请重新打开本次绑定链接并点击 Start。';
  if (/active webhook/.test(error.message)) return '这个 Bot 已配置 Webhook。请使用独立 Bot，或先在原服务中移除 Webhook。';
  if (/already in use/.test(error.message)) return '这个实例正在接收 Telegram 消息，请先停止实例再重新授权。';
  if (error.message === 'Invalid Telegram bot token') return 'Bot token 格式不正确，请完整复制，不要包含空格。';
  return 'Telegram 连接失败，请检查网络和 Bot token 后重试。';
}

export async function connectTelegram({ plan, prompter, fetchImpl = globalThis.fetch, canGoBack = false }) {
  prompter.section('Telegram');
  prompter.info('在官方 @BotFather 中发送 /newbot 创建独立 Bot，复制 Bot token。每个 Vika 实例使用一个 Bot。');
  prompter.info('接入后只接受你的私聊；普通 Bot 对话不是端到端加密对话。');
  if (canGoBack) prompter.info('输入 token 或等待绑定时，按 ← / Esc 可以返回。');
  const navigable = prompter.navigable;
  try {
    for (;;) {
      prompter.navigable = canGoBack;
      const token = await prompter.secret('Telegram Bot token');
      prompter.navigable = false;
      try {
        await verify({ plan, prompter, token, fetchImpl, canGoBack });
        prompter.success('Telegram 已接好；实例启动后，在这个 Bot 的私聊中发任务即可。');
        return;
      } catch (error) {
        if (error instanceof GoBack || error instanceof PromptAborted) throw error;
        prompter.warn(explain(error));
        prompter.navigable = canGoBack;
        const next = await prompter.select('接下来怎么办', [
          { label: '重新输入 Bot token 并绑定', value: 'retry' },
          { label: canGoBack ? '返回上一步' : '退出接入', value: 'leave' },
        ]);
        if (next === 'leave') throw canGoBack ? new GoBack() : new PromptAborted();
      }
    }
  } finally { prompter.navigable = navigable; }
}

async function verify({ plan, prompter, token, fetchImpl, canGoBack }) {
  const state = new TelegramState(plan.dataDir);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(180_000);
  const signal = AbortSignal.any([controller.signal, timeout]);
  let scan;
  let keys = prompter.watchKey(null, { onBack: canGoBack ? () => controller.abort(new GoBack()) : null });
  try {
    await loginTelegram({ state, token, fetchImpl, signal,
      onChallenge: ({ username, url }) => {
        keys.stop(); keys = null;
        prompter.info('打开本次绑定链接或扫描二维码，然后在 Bot 私聊中点击 Start。');
        scan = showScan(prompter, { url, where: 'Telegram', title: `绑定 @${username}`,
          label: '等待在 Bot 私聊中点击 Start（3 分钟内）',
          onBack: canGoBack ? () => controller.abort(new GoBack()) : null });
      },
    });
  } catch (error) { throw signal.aborted ? signal.reason : error; }
  finally { keys?.stop(); scan?.stop(); state.close(); }
}

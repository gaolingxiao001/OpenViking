import { createHash } from 'node:crypto';
import { sendItems, sendText } from './api.mjs';
import { readOutboundMedia, uploadOutboundMedia } from './media.mjs';

const WEIXIN_TEXT_LIMIT = 4_000;

// The Core outbox owns the idempotency key; deriving the provider client id
// from it keeps a retried attempt on the same Weixin message id.
function clientIdFor(idempotencyKey, peerId) {
  const digest = createHash('sha256').update(idempotencyKey).update('\0').update(peerId).digest('hex');
  return `vika-${digest.slice(0, 32)}`;
}

export async function sendWeixinMessage({ state, to, content, idempotencyKey }) {
  const account = state.account();
  if (!account?.token) throw new Error('Weixin is not logged in; run vika login weixin <instance> first');
  if (!state.knowsPeer(to)) throw new Error('Weixin recipient is not an authenticated inbound conversation');
  const clientId = clientIdFor(idempotencyKey, to);
  const common = { apiBaseUrl: account.baseUrl, token: account.token, to, contextToken: state.contextToken(to), clientId };
  let response;
  if (content.type === 'markdown') {
    if (content.text.length > WEIXIN_TEXT_LIMIT) {
      throw new Error(`Weixin text exceeds the ${WEIXIN_TEXT_LIMIT}-character limit`);
    }
    response = await sendText({ ...common, text: content.text });
  } else if (content.type === 'file') {
    const media = readOutboundMedia(content.path);
    const item = await uploadOutboundMedia({ account, to, media });
    response = await sendItems({ ...common, items: [item] });
  } else {
    throw new Error(`Weixin does not support ${content.type} messages`);
  }
  return { message_id: response.message_id ?? null, client_id: clientId };
}

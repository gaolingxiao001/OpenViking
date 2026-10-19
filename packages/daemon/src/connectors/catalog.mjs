import { WEIXIN_CHANNEL_VERSION } from '../weixin/api.mjs';
import { TELEGRAM_VERSION } from '../telegram/api.mjs';
import { connectorManifest } from './protocol.mjs';

const EMPTY_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false });

// `actions` are the external side effects the Core may route through its
// outbox. `content` lists the message bodies an action accepts; `idempotent`
// means the provider honours the idempotency key, so an UNCERTAIN attempt may
// be retried with the same key. `queries` are read-only operations.
const LARK_CONTENT = ['markdown', 'file', 'file_key', 'card'];
const WEIXIN_CONTENT = ['markdown', 'file'];

const MANIFESTS = Object.freeze({
  telegram: connectorManifest({
    name: 'telegram', version: TELEGRAM_VERSION, capabilities: ['events', 'actions'],
    actions: {
      'message.send': { content: ['markdown', 'file'] },
      'message.reply': { content: ['markdown', 'file'] },
    },
    queries: ['message.media'], auth_schema: EMPTY_SCHEMA, config_schema: EMPTY_SCHEMA,
  }),
  lark: connectorManifest({
    name: 'lark',
    version: 'lark-cli-v1',
    capabilities: ['events', 'actions', 'search'],
    actions: {
      'message.send': { content: LARK_CONTENT, mentions: true, idempotent: true },
      'message.reply': { content: LARK_CONTENT, mentions: true, thread: true, idempotent: true },
      'message.react': {},
      'message.retract': {},
    },
    queries: ['chat.list', 'chat.messages', 'message.search', 'thread.messages', 'message.media'],
    auth_schema: EMPTY_SCHEMA,
    config_schema: EMPTY_SCHEMA,
  }),
  weixin: connectorManifest({
    name: 'weixin',
    version: `openclaw-weixin-protocol/${WEIXIN_CHANNEL_VERSION}`,
    capabilities: ['events', 'actions'],
    actions: {
      'message.send': { content: WEIXIN_CONTENT },
      'message.reply': { content: WEIXIN_CONTENT },
    },
    queries: ['message.media'],
    auth_schema: EMPTY_SCHEMA,
    config_schema: EMPTY_SCHEMA,
  }),
  // A mailbox the owner reads over IMAP and answers over SMTP. A reply speaks
  // as the owner to whoever wrote, so the owner approves each one on a card
  // first (`approval`). SMTP has no idempotency key: an uncertain send is never
  // retried.
  email: connectorManifest({
    name: 'email',
    version: 'imap-smtp-v1',
    capabilities: ['events', 'actions'],
    actions: {
      'message.reply': { content: ['markdown'], approval: true },
    },
    queries: [],
    auth_schema: EMPTY_SCHEMA,
    config_schema: EMPTY_SCHEMA,
  }),
});

export function getConnectorManifest(id) {
  const manifest = MANIFESTS[id];
  if (!manifest) throw new Error(`unknown connector: ${id}`);
  return manifest;
}

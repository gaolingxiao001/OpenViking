import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { eventIdentity } from '../event.mjs';
import { registerCard } from '../card-messages.mjs';
import { meetingContextLines } from '../meeting/index.mjs';
import { OVSessionClient } from '../ov-session-context.mjs';
import { opaqueRef, safeError } from '../logger.mjs';
import { readMetadataTag } from '../runtime-input.mjs';
import { resolveContent } from './content.mjs';
import { TOOLS, publicTool, validateInput } from './tools.mjs';

const NO_ACTION = 'No action was taken.';

const HANDLERS = {
  send_message: 'sendMessage',
  reply_message: 'replyMessage',
  react_to_message: 'reactToMessage',
  retract_message: 'retractMessage',
  list_chats: 'listChats',
  list_chat_messages: 'listChatMessages',
  search_messages: 'searchMessages',
  list_thread_messages: 'listThreadMessages',
  get_message_media: 'getMessageMedia',
  read_openviking_session_context: 'readOVSession',
  read_meeting_inbox: 'readMeetingInbox',
};

// A refusal the model can act on; `code` is what logs and activities record.
function blocked(code, message) {
  return Object.assign(new Error(message), { code });
}

function actionKey(...parts) {
  return `ld_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
}

// An inbound event in an idempotency key: the same event whichever id named it,
// and distinct per instance.
function eventRef(row) {
  return [row.connector_instance, row.event_id];
}

function messageLines(messages, { withChat = false } = {}) {
  return messages.map((message) => {
    const sender = message.sender.name || message.sender.id || 'unknown';
    const chat = withChat && message.chat_id ? ` | chat_id=${message.chat_id}` : '';
    return `- ${message.message_id}${chat} | ${sender} | ${message.msg_type} | ${message.content}`;
  }).join('\n');
}

// The single outbound path. Agent tool calls (MCP adapter or CLI, both through
// the local socket) and daemon notices all end in deliver(): reserve in the
// outbox, invoke the Connector, settle. Authority, freshness, routing and
// content checks happen here once, whichever runtime asked.
export class ActionService {
  constructor({ config, store, connectors, roster = null, liveness = null, meetingEnabled = false, ovClient = null, logger }) {
    Object.assign(this, { config, store, connectors, roster, liveness, meetingEnabled, ovClient, logger });
    // One temporary working reaction per conversation, removed by the next
    // final delivery there.
    this.temporaryReactions = new Map();
  }

  manifest(connector) {
    return new Map(this.connectors.manifests()).get(connector) ?? null;
  }

  supporting(operation, kind) {
    return this.connectors.manifests()
      .filter(([, manifest]) => (kind === 'actions' ? Boolean(manifest.actions[operation]) : manifest.queries.includes(operation)))
      .map(([id]) => id);
  }

  offered(tool) {
    if (tool.action) return this.supporting(tool.action, 'actions').length > 0;
    if (tool.query) return this.supporting(tool.query, 'queries').length > 0;
    if (tool.meeting) return this.meetingEnabled;
    return true;
  }

  tools() {
    return TOOLS.filter((tool) => this.offered(tool)).map(publicTool);
  }

  // Agent entrypoint. Returns { text, data, media? }; throws a model-readable
  // error with a `code`. Each call logs one `agent_tool` line whose seqs and
  // outbox id line up with connector_events/outbox; a blocked delivery is also
  // kept as a delivery.blocked activity.
  async call(name, input = {}, { authority = null, via = null } = {}) {
    const startedAt = Date.now();
    const trace = { tool: name, via };
    const caller = { authority, trace };
    const tool = TOOLS.find((candidate) => candidate.name === name);
    try {
      if (!tool || !this.offered(tool)) throw blocked('unknown_tool', `unknown tool: ${name}`);
      try { validateInput(tool.inputSchema, input); } catch (error) { throw blocked('invalid_input', error.message); }
      this.assertAuthority(authority);
      trace.runtime = this.store.getCognitionState().runtime;
      const result = await this[HANDLERS[name]](input, caller);
      trace.outcome = result.data?.dry_run ? 'dry_run' : result.data?.duplicate ? 'duplicate' : 'ok';
      this.logger.info('agent_tool', { ...trace, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      trace.outcome = trace.invoked ? 'failed' : 'blocked';
      trace.code = error.code ?? (trace.invoked ? 'connector_failed' : 'error');
      this.logger.warn('agent_tool', { ...trace, durationMs: Date.now() - startedAt, error: safeError(error) });
      if (trace.outcome === 'blocked' && tool?.action) {
        this.store.recordActivity({
          eventKey: `tool:${randomUUID()}`, kind: 'delivery.blocked', status: 'BLOCKED',
          conversationKey: caller.convKey ?? null, inboundSeq: trace.decisionSeq ?? null, summary: safeError(error),
          metadata: { tool: name, code: trace.code, connector: trace.connector, via, runtime: trace.runtime,
            decisionSeq: trace.decisionSeq, newerSeq: trace.newerSeq },
        });
      }
      throw error;
    }
  }

  // Daemon-authored reply (slash command result, failure notice) on an event's
  // own reply route. Never carries model output; keyed once per event+purpose.
  async replyToEvent(event, text, purpose) {
    if (!event?.replyRoute) return { ok: false, stage: 'no-target' };
    const trace = { purpose, connector: event.connectorInstance, action: event.replyRoute.action, inboundSeq: event.seq };
    try {
      const result = await this.deliver({
        caller: { trace },
        connector: event.connectorInstance,
        action: event.replyRoute.action,
        input: { ...event.replyRoute.input, content: { type: 'markdown', text } },
        key: actionKey('daemon', purpose, eventIdentity(event)),
        summary: text,
        scope: { chatId: event.chatId, threadId: event.threadId, convKey: event.conversationKey },
        inboundSeq: event.seq ?? null,
        // Non-chat history is rendered from the event it answers.
        metadata: event.chatId ? {} : { event: event.envelope },
      });
      this.logger.info('daemon_reply', { ...trace, outcome: result.duplicate ? 'duplicate' : result.dry_run ? 'dry_run' : 'ok' });
      return { ok: true };
    } catch (error) {
      this.logger.warn('daemon_reply', { ...trace, outcome: 'failed', error: safeError(error) });
      return { ok: false, stage: 'send', error };
    }
  }

  async close() {
    const scopes = [...this.temporaryReactions.keys()];
    await Promise.allSettled(scopes.map((scope) => this.clearTemporaryReaction(scope, 'shutdown')));
  }

  assertAuthority(authority) {
    if (!authority || authority !== this.store.getCognitionState().authorityToken) {
      throw blocked('authority_revoked', `Blocked: this model runtime no longer owns tool authority. ${NO_ACTION}`);
    }
  }

  // Pick the Connector for a target: explicit source, else the connector that
  // owns a known message/chat id, else the only one that supports the operation.
  route(caller, operation, kind, source, { messageId = null, chatId = null } = {}) {
    caller.trace.action = operation;
    const candidates = this.supporting(operation, kind);
    const known = source
      ?? (messageId ? this.store.connectorForMessage(messageId) : null)
      ?? (chatId ? this.store.connectorForChat(chatId) : null);
    if (known) {
      if (!candidates.includes(known)) throw blocked('unsupported', `${known} does not support ${operation}. ${NO_ACTION}`);
      caller.trace.connector = known;
      return known;
    }
    if (candidates.length !== 1) {
      throw blocked('route_ambiguous', `Cannot tell which connector this target belongs to; pass source (one of: ${candidates.join(', ')}). ${NO_ACTION}`);
    }
    caller.trace.connector = candidates[0];
    return candidates[0];
  }

  // The accepted inbound events an input reference names: the event= value as
  // its tag showed it, on every instance unless one is given. Callers accept one
  // match and never pick among several.
  inputEvents(ref, instance = null) {
    let id;
    try { id = readMetadataTag(ref); } catch { return []; }
    return this.store.acceptedEvents(id, instance);
  }

  // Freshness fence: the decision must resolve to exactly one accepted inbound
  // event with nothing newer accepted in its scope (the chat/thread, or the
  // subject of a non-chat event).
  fence(input, caller) {
    const rows = this.inputEvents(input.decision_id, input.decision_instance ?? null);
    if (rows.length === 0) {
      throw blocked('unknown_decision', `Delivery blocked: decision_id is not the event= of an accepted daemon-authenticated input (msg= is not accepted). ${NO_ACTION}`);
    }
    if (rows.length > 1) {
      throw blocked('decision_ambiguous', `Delivery blocked: decision_id is an event on ${rows.length} instances. Pass that line's instance= (or source= when it has none) as decision_instance. ${NO_ACTION}`);
    }
    const [row] = rows;
    Object.assign(caller.trace, { decisionSeq: row.seq, conversationRef: opaqueRef(row.scope_key) });
    caller.convKey = row.conv_key;
    this.assertFresh(row, caller);
    return row;
  }

  // Checks the event the decision first resolved to, by its own scope and seq.
  // Looking the alias up again could land on a newer event under the same id
  // and let a stale decision through.
  assertFresh(decision, caller) {
    const newerSeq = this.store.newerAcceptedSeq(decision.scope_key, decision.seq);
    if (newerSeq !== null) {
      caller.trace.newerSeq = newerSeq;
      throw blocked('stale_decision', 'Delivery blocked: a newer authenticated input arrived in the same chat/thread, or about the same subject. Reconsider with the new input, then use its msg= or event= as decision_id if the action still fits.');
    }
  }

  // Attribution is separate from freshness: a response may fulfill an earlier
  // input in the decision's scope, never a newer one. response_to_id resolves on
  // the decision's instance; an implicit target (the message replied or reacted
  // to) counts only when exactly one such event carried it on that connector.
  attribution(caller, explicit, fence, implicit = null) {
    let responseTo = fence;
    const inScope = (row) => row.scope_key === fence.scope_key && row.seq <= fence.seq;
    if (explicit !== undefined) {
      const rows = this.inputEvents(explicit, fence.connector_instance);
      if (rows.length !== 1 || !inScope(rows[0])) {
        throw blocked('attribution_rejected', `Delivery blocked: response_to_id must name one accepted input from the same chat/thread or subject, no newer than decision_id. ${NO_ACTION}`);
      }
      [responseTo] = rows;
    } else if (implicit && implicit.connector === fence.connector_instance) {
      const rows = this.store.acceptedMessageEvents(implicit.messageId, fence.connector_instance);
      if (rows.length === 1 && inScope(rows[0])) [responseTo] = rows;
    }
    caller.trace.responseSeq = responseTo.seq;
    return responseTo;
  }

  async content(input, connector, action, { chatId, fence, caller }) {
    const spec = this.manifest(connector).actions[action];
    let content;
    try {
      content = resolveContent(input, {
        workspace: this.config.workspace,
        snapshotDir: path.join(this.config.tempDir, 'outbox'),
        maxTextChars: this.config.maxReplyChars,
      });
    } catch (error) {
      throw blocked('invalid_content', error.message);
    }
    caller.trace.contentType = content.type;
    try {
      if (!spec.content?.includes(content.type)) throw blocked('unsupported', `${connector} cannot send ${content.type} messages. ${NO_ACTION}`);
      const mentions = await this.mentions(input, spec, chatId);
      if (mentions.length > 0) {
        content.payload.mentions = mentions;
        content.canonical = [...content.canonical, mentions];
      }
      if (content.question) {
        content.question.answerer_id ||= fence.sender_id;
        if (!/^ou_[A-Za-z0-9_-]{8,}$/.test(content.question.answerer_id ?? '')) {
          throw blocked('invalid_content', 'choices requires a trusted user answerer_id');
        }
      }
      return content;
    } catch (error) {
      content.cleanup();
      throw error;
    }
  }

  async mentions(input, spec, chatId) {
    const ids = input.mention_user_ids ?? [];
    const names = input.mention_names ?? [];
    if (ids.length === 0 && names.length === 0) return [];
    if (!spec.mentions) throw blocked('unsupported', `mentions are not supported on this connector. ${NO_ACTION}`);
    const mentions = new Map(ids.map((id) => [id, { id }]));
    if (names.length > 0) {
      if (!chatId || !this.roster) {
        throw blocked('invalid_mentions', 'mention_names could not be resolved: the target chat is unknown; use mention_user_ids with full ou_ IDs from trusted metadata');
      }
      let pairs;
      try { pairs = await this.roster.resolveNames(chatId, names); } catch (error) { throw blocked('invalid_mentions', error.message); }
      for (const pair of pairs) mentions.set(pair.id, pair);
    }
    if (mentions.size > 10) throw blocked('invalid_mentions', 'mentions support at most 10 users in total');
    return [...mentions.values()];
  }

  async deliver({ caller, connector, action, input, key, summary, scope, fence = null, inboundSeq = null, metadata = {} }) {
    // Preparing the content may have awaited (a mention lookup), and a newer
    // message or a runtime switch could have landed meanwhile. Re-check right
    // before the reservation, with no await in between.
    if (caller.authority) {
      this.assertAuthority(caller.authority);
      if (fence) this.assertFresh(fence, caller);
    }
    if (this.config.dryRun) return { dry_run: true };
    // A Connector that is down and restarting gets no reservation: nothing was
    // sent, and the same call can go through once it is back.
    if (this.connectors.available?.(connector) === false) {
      throw blocked('connector_unavailable',
        `Delivery blocked: the ${connector} connector is temporarily unavailable and reconnects on its own. ${NO_ACTION}`);
    }
    const spec = this.manifest(connector)?.actions[action] ?? {};
    const reservation = this.store.reserveOutbox({
      connector, action, idempotencyKey: key, payload: input, summary,
      caller: caller.authority ? 'agent' : 'daemon', retryUncertain: Boolean(spec.idempotent),
      chatId: scope.chatId ?? null, threadId: scope.threadId ?? null, convKey: scope.convKey ?? null,
      inboundSeq, runtimeToken: caller.authority ?? null, metadata,
    });
    caller.trace.outboxId = reservation.id;
    if (!reservation.claimed) {
      if (reservation.status === 'SENT') return { ...reservation.result, duplicate: true };
      throw reservation.status === 'PENDING'
        ? blocked('in_progress', `Delivery blocked: this identical action is still in progress. ${NO_ACTION}`)
        : blocked('uncertain_not_retried', `Delivery blocked: this identical action was already attempted and its outcome is uncertain. ${NO_ACTION}`);
    }
    caller.trace.attempt = reservation.attempt;
    caller.trace.invoked = true;
    let result;
    try {
      result = await this.connectors.invoke(connector, action, { ...input, idempotency_key: key });
    } catch (error) {
      this.store.settleOutbox(reservation.id, 'UNCERTAIN', { error: safeError(error) });
      throw error;
    }
    this.store.settleOutbox(reservation.id, 'SENT', { result });
    this.liveness?.touch();
    return { ...result, outbox_id: reservation.id };
  }

  // Scope of a target message on its connector: an inbound this daemon
  // accepted, or one of its own deliveries.
  messageScope(connector, messageId) {
    return this.store.eventByMessageId(messageId, connector) ?? this.store.deliveredMessage(messageId, connector);
  }

  // Registers a delivered card against where it landed. `seen` are inbounds that
  // may sit in that chat (the replied-to message, the decision); one counts only
  // if it is in the destination chat on the delivering connector.
  rememberCard(content, result, { connector, chatId, seen, replyInThread = false, replyTarget = null }) {
    if (content.type !== 'card' || result.dry_run || result.duplicate) return null;
    const destination = result.chat_id || chatId;
    const inbound = seen.find((row) => row?.connector_instance === connector && row.chat_id === destination) ?? null;
    try {
      registerCard(this.store.db, {
        messageId: result.message_id, profile: this.config.profile, question: content.question ?? null,
        instance: connector, chatId: destination, inbound, chat: inbound ?? this.store.chatContext(connector, destination),
        replyInThread, replyTarget, data: result,
      });
      return null;
    } catch {
      return 'Card was sent, but callback registration failed. Do not resend; card interactions may be unavailable.';
    }
  }

  async sendMessage(input, caller) {
    const connector = this.route(caller, 'message.send', 'actions', input.source, { chatId: input.chat_id });
    const fence = this.fence(input, caller);
    const responseTo = this.attribution(caller, input.response_to_id, fence);
    const content = await this.content(input, connector, 'message.send', { chatId: input.chat_id, fence, caller });
    try {
      const result = await this.deliver({
        caller, connector, action: 'message.send',
        input: { chat_id: input.chat_id, content: content.payload },
        key: this.key(input.idempotency_key, 'send', connector, eventRef(fence), eventRef(responseTo), input.chat_id, content.canonical),
        summary: content.summary,
        scope: { chatId: input.chat_id, convKey: responseTo.conv_key },
        fence,
        inboundSeq: responseTo.seq,
      });
      const warning = this.rememberCard(content, result, { connector, chatId: input.chat_id, seen: [fence] });
      if (!result.dry_run) await this.clearTemporaryReaction(fence.conv_key);
      return this.deliveryResult(result, `message to chat_id=${input.chat_id}`, warning);
    } finally {
      content.cleanup();
    }
  }

  async replyMessage(input, caller) {
    const connector = this.route(caller, 'message.reply', 'actions', input.source, { messageId: input.message_id });
    const inThread = input.reply_in_thread === true;
    if (inThread && !this.manifest(connector).actions['message.reply'].thread) {
      throw blocked('unsupported', `${connector} does not support thread replies. ${NO_ACTION}`);
    }
    const fence = this.fence(input, caller);
    const target = this.messageScope(connector, input.message_id);
    const responseTo = this.attribution(caller, input.response_to_id, fence, { connector, messageId: input.message_id });
    const chatId = target?.chat_id ?? fence.chat_id;
    const content = await this.content(input, connector, 'message.reply', { chatId, fence, caller });
    try {
      const result = await this.deliver({
        caller, connector, action: 'message.reply',
        input: { message_id: input.message_id, content: content.payload, reply_in_thread: inThread },
        key: this.key(input.idempotency_key, 'reply', connector, eventRef(fence), eventRef(responseTo),
          input.message_id, inThread, content.canonical),
        summary: content.summary,
        scope: { chatId, threadId: target?.thread_id ?? null, convKey: responseTo.conv_key },
        fence,
        inboundSeq: responseTo.seq,
      });
      const warning = this.rememberCard(content, result, {
        connector, chatId, seen: [this.store.eventByMessageId(input.message_id, connector), fence],
        replyInThread: inThread, replyTarget: input.message_id,
      });
      if (!result.dry_run) await this.clearTemporaryReaction(fence.conv_key);
      return this.deliveryResult(result, `reply to message_id=${input.message_id}`, warning);
    } finally {
      content.cleanup();
    }
  }

  async reactToMessage(input, caller) {
    const connector = this.route(caller, 'message.react', 'actions', input.source, { messageId: input.message_id });
    const temporary = input.temporary === true;
    if (temporary && input.emoji_type !== 'OnIt') throw blocked('invalid_input', 'temporary reactions must use the OnIt emoji');
    const fence = this.fence(input, caller);
    if (temporary && !fence.conv_key) throw blocked('invalid_input', 'temporary reaction scope could not be verified');
    const target = this.messageScope(connector, input.message_id);
    const responseTo = this.attribution(caller, input.response_to_id, fence, { connector, messageId: input.message_id });
    const result = await this.deliver({
      caller, connector, action: 'message.react',
      input: { message_id: input.message_id, emoji_type: input.emoji_type },
      key: this.key(null, 'reaction', connector, eventRef(fence), eventRef(responseTo), input.message_id, input.emoji_type, temporary),
      summary: `[reaction ${input.emoji_type}]`,
      scope: { chatId: target?.chat_id ?? fence.chat_id, threadId: target?.thread_id ?? null, convKey: responseTo.conv_key },
      fence,
      inboundSeq: responseTo.seq,
    });
    if (!result.dry_run && !result.duplicate) {
      if (temporary && result.reaction_id) {
        await this.rememberTemporaryReaction(fence.conv_key, {
          connector, messageId: input.message_id, reactionId: result.reaction_id, outboxId: result.outbox_id,
        });
      } else if (!temporary) {
        await this.clearTemporaryReaction(fence.conv_key);
      }
    }
    return this.deliveryResult(result, `${input.emoji_type} reaction on message_id=${input.message_id}`);
  }

  async retractMessage(input, caller) {
    const connector = this.route(caller, 'message.retract', 'actions', input.source, { messageId: input.message_id });
    const target = this.store.deliveredMessage(input.message_id, connector);
    const result = await this.deliver({
      caller, connector, action: 'message.retract',
      input: { message_id: input.message_id },
      key: this.key(null, 'retract', connector, input.message_id),
      summary: '[message retracted]',
      scope: { chatId: target?.chat_id ?? null, convKey: target?.conv_key ?? null },
    });
    return this.deliveryResult(result, `retraction of message_id=${input.message_id}`);
  }

  key(requested, ...parts) {
    const canonical = actionKey(...parts);
    // A caller label is bound to the payload, so reusing one label for two
    // different messages cannot make the provider collapse the second.
    return requested ? actionKey('caller', requested, canonical) : canonical;
  }

  deliveryResult(result, what, warning = null) {
    if (result.dry_run) return { text: `Dry run only: no ${what} was delivered.`, data: result };
    const remote = result.message_id ? ` message_id=${result.message_id}` : '';
    const text = result.duplicate
      ? `Already delivered earlier: ${what}.${remote} No new message was sent.`
      : `Delivered ${what}.${remote}${warning ? ` Warning: ${warning}` : ''}`;
    return { text, data: { ...result, ...(warning ? { delivery_warning: warning } : {}) } };
  }

  async rememberTemporaryReaction(scope, token) {
    const previous = this.temporaryReactions.get(scope);
    this.temporaryReactions.set(scope, token);
    this.logger.info('temporary_reaction', { event: 'tracked', conversationRef: opaqueRef(scope), outboxId: token.outboxId });
    if (previous) await this.deleteTemporaryReaction(previous, scope, 'replaced');
  }

  async clearTemporaryReaction(scope, reason = 'final_delivery') {
    const token = scope ? this.temporaryReactions.get(scope) : null;
    if (!token) return;
    this.temporaryReactions.delete(scope);
    await this.deleteTemporaryReaction(token, scope, reason);
  }

  // Compensating cleanup of an outbox-recorded reaction. Best-effort: the final
  // delivery that triggered it already succeeded and must not be reported failed.
  async deleteTemporaryReaction(token, scope, reason) {
    const fields = { conversationRef: opaqueRef(scope), outboxId: token.outboxId, reason };
    try {
      await this.connectors.invoke(token.connector, 'message.reaction.delete', {
        message_id: token.messageId, reaction_id: token.reactionId,
      });
      this.store.cancelOutboxJournal(token.outboxId);
      this.logger.info('temporary_reaction', { event: 'cleared', ...fields });
    } catch (error) {
      this.logger.warn('temporary_reaction', { event: 'cleanup_failed', ...fields, error: safeError(error) });
    }
  }

  query(caller, operation, { source, ...input }, ids = {}) {
    const connector = this.route(caller, operation, 'queries', source, ids);
    caller.trace.invoked = true;
    return this.connectors.invoke(connector, operation, input);
  }

  async listChats(input, caller) {
    const data = await this.query(caller, 'chat.list', input);
    if (data.chats.length === 0) return { text: 'No joined group chats matched.', data };
    const lines = data.chats.map((chat) => `- ${chat.name || '(unnamed)'} | chat_id=${chat.chat_id} | ${chat.chat_status}`);
    const more = data.has_more ? '\nMore joined chats exist; narrow query or raise limit.' : '';
    return { text: `Joined group chats (${data.chats.length}):\n${lines.join('\n')}${more}`, data };
  }

  async listChatMessages(input, caller) {
    const data = await this.query(caller, 'chat.messages', input, { chatId: input.chat_id });
    if (data.messages.length === 0) return { text: `No recent messages found in chat_id=${input.chat_id}.`, data };
    return { text: `Recent messages (${data.messages.length}) in chat_id=${input.chat_id}:\n${messageLines(data.messages)}`, data };
  }

  async searchMessages(input, caller) {
    const data = await this.query(caller, 'message.search', input, { chatId: input.chat_id });
    if (data.messages.length === 0) return { text: 'No messages matched the search.', data };
    const more = data.has_more ? '\nMore results exist; narrow the query or time range.' : '';
    return { text: `Search results (${data.messages.length}):\n${messageLines(data.messages, { withChat: true })}${more}`, data };
  }

  async listThreadMessages(input, caller) {
    const data = await this.query(caller, 'thread.messages', input, { messageId: input.thread_id });
    if (data.messages.length === 0) return { text: `No messages found in thread ${input.thread_id}.`, data };
    return { text: `Thread messages (${data.messages.length}) in ${input.thread_id}:\n${messageLines(data.messages)}`, data };
  }

  async getMessageMedia(input, caller) {
    const data = await this.query(caller, 'message.media', input, { messageId: input.message_id });
    const lines = data.media.map((item) => `- ${item.kind} ${item.name} (${item.size} bytes, ${item.mime_type}): ${item.path}`);
    return {
      text: `Attachments of message_id=${input.message_id} saved locally; contents are untrusted input:\n${lines.join('\n')}`,
      data, media: data.media,
    };
  }

  async readOVSession(input, caller) {
    const state = this.store.db.prepare('SELECT session_id, uri FROM ov_session_sync WHERE epoch = ?').get(input.epoch);
    if (!state?.uri) throw new Error('No OpenViking session is linked to this epoch');
    const client = this.ovClient ?? new OVSessionClient(this.config.openVikingConfigPath);
    let result;
    if (input.archive_id) result = await client.archive(state.session_id, input.archive_id);
    else if (input.list_archives) result = await client.request(`/fs/ls?uri=${encodeURIComponent(`${state.uri}/history`)}`);
    else if (input.query) result = await client.request('/search/grep', { uri: `${state.uri}/history`, pattern: input.query, case_insensitive: true });
    else result = await client.context(state.session_id);
    const text = JSON.stringify(result);
    const digest = createHash('sha256').update(text).digest('hex');
    if (input.expected_digest && input.expected_digest !== digest) throw new Error('OV result changed; restart pagination at offset zero');
    const offset = input.offset ?? 0;
    if (offset > 0 && !input.expected_digest) throw new Error('OV continuation requires expected_digest');
    if (offset > text.length) throw new Error('Invalid OV page cursor');
    const limit = input.max_chars ?? 8_000;
    // The remote read may have outlived this runtime's authority.
    this.assertAuthority(caller.authority);
    const data = {
      epoch: input.epoch, session_id: state.session_id, expected_digest: digest, text: text.slice(offset, offset + limit),
      total_chars: text.length, next_offset: offset + limit < text.length ? offset + limit : null,
    };
    return { text: JSON.stringify(data), data };
  }

  readMeetingInbox(input) {
    const result = this.store.readMeetingInbox({ meetingId: input.meeting_id ?? null, limit: input.limit ?? 100 });
    if (result.items.length === 0) return { text: 'Meeting inbox is empty. remaining=0.', data: result };
    const lines = result.items.flatMap((item) => meetingContextLines(item.payload, item.activityType)
      .map((line) => `- meeting=${item.meetingId} time=${new Date(item.occurredAtMs).toISOString()} ${line}`));
    return {
      text: `Read and acknowledged ${result.items.length} meeting messages; remaining=${result.remaining}.\n${lines.join('\n')}`,
      data: result,
    };
  }
}

import { createHash } from 'node:crypto';
import { LARK_TOOLS, LarkToolService, createMcpHandler } from './lark-tools.mjs';
import { managedToolDefinitions } from './managed-tool-bridge.mjs';

const FRESHNESS_FENCED_TOOLS = new Set([
  'send_lark_message',
  'reply_lark_message',
  'react_to_lark_message',
  'retract_lark_message',
]);
const FINAL_DELIVERY_TOOLS = new Set([
  ...FRESHNESS_FENCED_TOOLS,
]);

function managedToolErrorResult(value) {
  const error = String(value ?? 'managed MCP tool call failed');
  if (/newer authenticated message/i.test(error)) {
    return { accepted: true, ok: false, terminal: true, suppressed: true, reason: 'newer_inbound' };
  }
  if (/runtime no longer owns Lark tool authority/i.test(error)) {
    return { accepted: true, ok: false, terminal: true, suppressed: true, reason: 'stale_authority' };
  }
  const replay = /identical (?:send|reply|reaction|retraction) was already attempted \((COMMITTED|UNCERTAIN)\)/i
    .exec(error);
  if (replay) {
    const status = replay[1].toUpperCase();
    return {
      accepted: true,
      ok: status === 'COMMITTED',
      terminal: true,
      suppressed: true,
      uncertain: status === 'UNCERTAIN',
      reason: status === 'COMMITTED' ? 'delivery_already_committed' : 'delivery_uncertain',
    };
  }
  return { accepted: true, ok: false, terminal: false, error };
}

// Host-owned output port for runtimes that cannot call the local Lark MCP
// service themselves. The port owns authority, freshness, idempotency and
// delivery semantics; managed-agent adapters only emit transport results.
export class ManagedAgentOutputPort {
  constructor({
    config,
    store,
    logger,
    roster = null,
    liveness = null,
    isStopping = () => false,
    serviceFactory = (options) => new LarkToolService(options),
  }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.roster = roster;
    this.liveness = liveness;
    this.isStopping = isStopping;
    this.serviceFactory = serviceFactory;
    this.toolDefinitions = managedToolDefinitions(LARK_TOOLS);
  }

  _ownsAuthority({ runtime, authorityToken, sessionId, cognitionEpoch }) {
    const cognition = this.store.getCognitionState();
    const session = this.store.getGlobalSession();
    return Boolean(runtime)
      && cognition.runtime === runtime
      && cognition.authorityToken === authorityToken
      && cognition.epoch === cognitionEpoch
      && session.runtime === runtime
      && session.sessionId === sessionId
      && session.epoch === cognitionEpoch;
  }

  _service(authorityToken) {
    return this.serviceFactory({
      larkCliBin: this.config.larkCliBin,
      profile: this.config.profile,
      projectDir: this.config.projectDir,
      databasePath: this.config.databasePath,
      runtimeToken: authorityToken,
      timeoutMs: this.config.sendTimeoutMs,
      maxTextChars: this.config.maxReplyChars ?? 30_000,
      dryRun: this.config.dryRun,
      tempDir: this.config.tempDir,
      roster: this.roster,
    });
  }

  async deliver({
    inboundSeqs,
    text,
    eventId = null,
    runtime,
    authorityToken,
    sessionId,
    cognitionEpoch,
  }) {
    if (this.isStopping()) return { accepted: true, delivered: false, suppressed: true };
    if (!text) return { accepted: false, delivered: false };

    if (!this._ownsAuthority({ runtime, authorityToken, sessionId, cognitionEpoch })) {
      this.logger.warn('managed_agent_output_stale_authority', {
        runtime: runtime ?? 'unknown',
        cognitionEpoch: cognitionEpoch ?? undefined,
      });
      return { accepted: true, delivered: false, suppressed: true, reason: 'stale_authority' };
    }

    const seqs = Array.isArray(inboundSeqs) ? inboundSeqs : [];
    const seq = seqs.at(-1) ?? null;
    const inbound = seq === null || seq === undefined ? null : this.store.inboundBySeq(seq);
    if (!inbound?.messageId) {
      this.logger.warn('managed_agent_output_has_no_lark_target', { inboundSeq: seq ?? undefined });
      return { accepted: false, delivered: false };
    }

    const limit = this.config.maxReplyChars ?? 30_000;
    const normalized = String(text).trim();
    const output = normalized.length <= limit
      ? normalized
      : `${normalized.slice(0, Math.max(1, limit - 18))}\n[回复已截断]`;
    const service = this._service(authorityToken);
    try {
      const result = await service.replyMessage({
        message_id: inbound.messageId,
        text: output,
        reply_in_thread: Boolean(inbound.threadId),
        decision_message_id: inbound.messageId,
        response_to_message_id: inbound.messageId,
        ...(eventId ? { idempotency_key: String(eventId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) } : {}),
      });
      if (result.sent) {
        this.liveness?.touch();
        await this.liveness?.onDeliverySucceeded?.({ inboundSeqs: seqs, mode: 'lark' });
      }
      return {
        accepted: Boolean(result.sent || result.dry_run),
        delivered: Boolean(result.sent),
        dryRun: Boolean(result.dry_run),
      };
    } catch (error) {
      // A later message in the same scope is already queued as a separate
      // managed turn. The newer turn owns the eventual reply.
      if (/newer authenticated message/i.test(error?.message ?? '')) {
        return { accepted: true, delivered: false, suppressed: true, reason: 'newer_inbound' };
      }
      const replay = /identical (?:send|reply) was already attempted \((COMMITTED|UNCERTAIN)\)/i
        .exec(error?.message ?? '');
      if (replay) {
        const status = replay[1].toUpperCase();
        return {
          accepted: true,
          delivered: false,
          suppressed: true,
          uncertain: status === 'UNCERTAIN',
          reason: status === 'COMMITTED' ? 'delivery_already_committed' : 'delivery_uncertain',
        };
      }
      throw error;
    } finally {
      await service.close();
    }
  }

  async callTool({
    inboundSeqs,
    callId,
    name,
    arguments: modelArguments,
    eventId = null,
    runtime,
    authorityToken,
    sessionId,
    cognitionEpoch,
  }) {
    if (this.isStopping()) {
      return { accepted: true, ok: false, terminal: true, suppressed: true, reason: 'stopping' };
    }
    if (!this._ownsAuthority({ runtime, authorityToken, sessionId, cognitionEpoch })) {
      this.logger.warn('managed_agent_tool_stale_authority', {
        runtime: runtime ?? 'unknown',
        cognitionEpoch: cognitionEpoch ?? undefined,
        toolName: name,
      });
      return { accepted: true, ok: false, terminal: true, suppressed: true, reason: 'stale_authority' };
    }
    if (!this.toolDefinitions.some((tool) => tool.name === name)) {
      return { accepted: true, ok: false, terminal: false, error: `managed tool is unavailable: ${name}` };
    }

    const seqs = Array.isArray(inboundSeqs) ? inboundSeqs : [];
    const seq = seqs.at(-1) ?? null;
    const inbound = seq === null || seq === undefined ? null : this.store.inboundBySeq(seq);
    if (!inbound?.messageId) {
      return { accepted: false, ok: false, terminal: true, error: 'managed tool call has no authenticated Lark decision target' };
    }

    const args = { ...(modelArguments && typeof modelArguments === 'object' ? modelArguments : {}) };
    delete args.decision_capability;
    delete args.decision_message_id;
    delete args.idempotency_key;
    delete args.response_to_message_id;
    if (FRESHNESS_FENCED_TOOLS.has(name)) {
      args.decision_message_id = inbound.messageId;
      args.response_to_message_id = inbound.messageId;
      if (name === 'send_lark_message' || name === 'reply_lark_message') {
        args.idempotency_key = `bridge_${createHash('sha256')
          .update(`${sessionId}:${eventId ?? ''}:${callId}:${name}`)
          .digest('hex').slice(0, 48)}`;
      }
    }

    const service = this._service(authorityToken);
    try {
      // Retract predates the MCP freshness fields, so fence it explicitly at
      // the host boundary before handing it to the shared MCP handler.
      if (name === 'retract_lark_message') service.assertFreshDecision(inbound.messageId);
      const handle = createMcpHandler(service);
      const response = await handle({
        jsonrpc: '2.0',
        id: callId,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const result = response?.result ?? null;
      const errorText = result?.isError
        ? result.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        : '';
      if (result?.isError) {
        return managedToolErrorResult(errorText);
      }

      const terminal = FINAL_DELIVERY_TOOLS.has(name);
      if (terminal) {
        const mode = name === 'react_to_lark_message' ? 'reaction' : 'lark';
        this.liveness?.touch();
        await this.liveness?.onDeliverySucceeded?.({ inboundSeqs: seqs, mode });
      }
      return { accepted: true, ok: true, terminal, result };
    } catch (error) {
      return managedToolErrorResult(error instanceof Error ? error.message : error);
    } finally {
      await service.close();
    }
  }
}

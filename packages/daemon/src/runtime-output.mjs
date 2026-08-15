import { LarkToolService } from './lark-tools.mjs';

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

    const cognition = this.store.getCognitionState();
    const session = this.store.getGlobalSession();
    const ownsAuthority = Boolean(runtime)
      && cognition.runtime === runtime
      && cognition.authorityToken === authorityToken
      && cognition.epoch === cognitionEpoch
      && session.runtime === runtime
      && session.sessionId === sessionId
      && session.epoch === cognitionEpoch;
    if (!ownsAuthority) {
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
    const service = this.serviceFactory({
      larkCliBin: this.config.larkCliBin,
      profile: this.config.profile,
      projectDir: this.config.projectDir,
      databasePath: this.config.databasePath,
      runtimeToken: authorityToken,
      timeoutMs: this.config.sendTimeoutMs,
      maxTextChars: limit,
      dryRun: this.config.dryRun,
      tempDir: this.config.tempDir,
      roster: this.roster,
    });
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
}

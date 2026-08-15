import { randomUUID } from 'node:crypto';
import { CodexAgent } from './codex.mjs';
import { ClaudeAgent, CLAUDE_EFFORTS, CLAUDE_MODELS } from './claude.mjs';
import { VolcAgent, VOLC_EFFORTS, VOLC_MODELS } from './volc.mjs';
import { cognitionHistoryPrefix } from './cognition.mjs';

const SWITCH_JOURNAL_HEADROOM = 4_096;

function parseTarget(value) {
  if (['volc', 'volcengine', 'ark'].includes(value)) {
    return { runtime: 'volc', model: 'ark', canonical: 'ark' };
  }
  if (/^(?:volc|volcengine|ark):/.test(value)) {
    const model = value.slice(value.indexOf(':') + 1) || 'ark';
    return { runtime: 'volc', model, canonical: model };
  }
  if (value.startsWith('claude:')) {
    const model = value.slice('claude:'.length);
    return { runtime: 'claude', model, canonical: model || 'claude' };
  }
  if (value.startsWith('codex:')) {
    return { runtime: 'codex', model: value.slice('codex:'.length), canonical: value.slice('codex:'.length) };
  }
  if (CLAUDE_MODELS.includes(value)) {
    return { runtime: 'claude', model: value, canonical: value };
  }
  return { runtime: 'codex', model: value, canonical: value };
}

export class AgentRuntime {
  constructor(config, store, logger, options = {}) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.onTurnFailed = options.onTurnFailed ?? null;
    this.onTurnSucceeded = options.onTurnSucceeded ?? null;
    this.onTurnOutput = options.onTurnOutput ?? null;
    this.onDeliverySucceeded = options.onDeliverySucceeded ?? null;
    this.onTurnAbandoned = options.onTurnAbandoned ?? null;
    this.onAvailable = options.onAvailable ?? null;
    this.factories = {
      codex: options.codexFactory ?? ((backendOptions) => new CodexAgent(
        config, store, logger.child({ component: 'codex' }), backendOptions,
      )),
      claude: options.claudeFactory ?? ((backendOptions) => new ClaudeAgent(
        config, store, logger.child({ component: 'claude' }), backendOptions,
      )),
      volc: options.volcFactory ?? ((backendOptions) => new VolcAgent(
        config, store, logger.child({ component: 'volc' }), backendOptions,
      )),
    };
    this.backend = null;
    this.stagedBackend = null;
    this.runtime = 'codex';
    this.switching = false;
    this.stopping = false;
  }

  get threadId() { return this.backend?.threadId ?? null; }
  get effort() { return this.backend?.effort ?? 'medium'; }
  get model() {
    const model = this.backend?.model ?? '';
    if (this.runtime === 'claude') return model || 'claude';
    return model;
  }
  get state() {
    const state = this.backend?.state ?? { connected: false, activeTurn: 0, queued: 0 };
    return { ...state, connected: state.connected && !this.switching };
  }
  get turnInProgress() { return this.switching || Boolean(this.backend?.turnInProgress); }
  get workStatus() {
    const working = this.switching || Boolean(this.backend?.modelWorking);
    return {
      working,
      // A turn may pause for tools and resume sampling several times. Keep the
      // user-facing clock anchored to the root turn instead of resetting it for
      // every reasoning/message item.
      startedAtMs: working ? (this.backend?.turnStartedAtMs ?? null) : null,
      connected: Boolean(this.state.connected),
      queued: this.state.queued ?? 0,
      switching: this.switching,
    };
  }

  _backendOptions(overrides = {}) {
    const cognition = this.store.getCognitionState();
    return {
      onTurnFailed: this.onTurnFailed,
      onTurnSucceeded: this.onTurnSucceeded,
      onTurnOutput: this.onTurnOutput,
      onDeliverySucceeded: this.onDeliverySucceeded,
      onTurnAbandoned: this.onTurnAbandoned,
      onAvailable: this.onAvailable,
      authorityToken: cognition.authorityToken,
      cognitionEpoch: cognition.epoch,
      ...overrides,
    };
  }

  async start() {
    this.stopping = false;
    let cognition = this.store.getCognitionState();
    const persistedRuntime = ['codex', 'claude', 'volc'].includes(cognition.runtime)
      ? cognition.runtime
      : 'codex';
    this.runtime = this.store.hasCognitionRuntime?.() === false
      ? parseTarget(this.config.initialModel || this.config.codexModel || '').runtime
      : persistedRuntime;
    // A daemon generation must never inherit the previous process's authority.
    // If that process crashed with a detached MCP sidecar still alive, rotating
    // the token here fences it before the replacement backend starts.
    cognition = this.store.initializeCognition(this.runtime, randomUUID());
    this.backend = this.factories[this.runtime](this._backendOptions());
    await this.backend.start();
  }

  deliver(text, seq = null, receiptId = null) {
    if (this.stopping) return false;
    if (!this.backend) return false;
    return receiptId === null || receiptId === undefined
      ? this.backend.deliver(text, seq)
      : this.backend.deliver(text, seq, receiptId);
  }
  deliverBatch(items) {
    if (this.stopping) return false;
    return this.backend?.deliverBatch(items) ?? false;
  }
  tryStartBatch(items) {
    if (this.switching || this.stopping) return false;
    return this.backend?.tryStartBatch(items) ?? false;
  }

  whenIdle() { return this.backend?.whenIdle?.() ?? Promise.resolve(); }
  interruptTurn() { return this.backend?.interruptTurn?.() ?? Promise.resolve(); }

  async listModels() {
    const current = await this.backend?.listModels?.() ?? [];
    const models = [
      ...current,
      ...CLAUDE_MODELS.map((id) => ({ id, efforts: CLAUDE_EFFORTS })),
      ...VOLC_MODELS.map((id) => ({ id, efforts: VOLC_EFFORTS })),
    ];
    const seen = new Set();
    return models.filter((model) => {
      if (!model?.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }

  async setModel(value) {
    if (this.stopping) throw new Error('agent runtime is stopping');
    const target = parseTarget(value);
    if (target.runtime === this.runtime) {
      // /m must not wait for a stuck turn, and every model change opens a
      // fresh session: interrupt the in-flight turn (its inbound rows stay in
      // the cognition journal, queued items survive), apply, then rotate.
      await this.backend.interruptTurn?.();
      await this.backend.setModel(target.model);
      this.store.appendCognitionJournal({
        kind: 'control',
        actor: 'daemon',
        text: `model changed within ${this.runtime} runtime to ${target.model || 'default'}; fresh native session opened`,
        dedupeKey: `control:model:${randomUUID()}`,
      });
      const threadId = await this.rotateSession({ resume: false });
      return { runtimeChanged: false, runtime: this.runtime, model: target.canonical, threadId };
    }
    return await this._hardSwitch(target);
  }

  async _hardSwitch(target) {
    if (this.stopping) throw new Error('agent runtime is stopping');
    if (this.switching) throw new Error('another runtime switch is already in progress');
    this.switching = true;
    const previous = this.backend;
    const previousRuntime = this.runtime;
    let staged = null;
    try {
      // Never wait for a stuck in-flight turn: interrupt/abandon it. Its
      // inbound rows are already in the cognition journal, which the target
      // replays as a catch-up prefix on its first real turn.
      await previous.interruptTurn?.();
      if (this.stopping) throw new Error('agent runtime stopped during runtime switch');
      const cognition = this.store.getCognitionState();
      const journalThrough = this.store.cognitionJournalHead(cognition.epoch);
      const authorityToken = randomUUID();
      staged = this.factories[target.runtime](this._backendOptions({
        authorityToken,
        cognitionEpoch: cognition.epoch,
        sessionPersistence: false,
        allowResume: false,
        // The journal is not acknowledged until the target's first real turn
        // completes. journalThrough is only the bounded staging snapshot.
        syncedThroughSeq: 0,
        model: target.model,
        onAvailable: null,
      }));
      this.stagedBackend = staged;
      await staged.start();
      if (this.stopping || this.stagedBackend !== staged) {
        throw new Error('agent runtime stopped during runtime switch');
      }
      if (!staged.state?.connected) throw new Error('target runtime exited before switch commit');
      if (staged.model !== target.model) throw new Error('target runtime did not apply the requested model');
      if (target.runtime === 'codex' && target.model) {
        const available = await staged.listModels();
        if (!available.some((model) => model.id === target.model)) {
          throw new Error(`Codex model is unavailable: ${target.model}`);
        }
      }
      const catchup = cognitionHistoryPrefix(
        this.store,
        cognition.epoch,
        journalThrough,
        Math.max(1, (this.config.cognitionMaxChars ?? 120_000) - SWITCH_JOURNAL_HEADROOM),
      );
      const session = staged.sessionDescriptor;
      if (!session.sessionId) throw new Error('target runtime produced no global session id');
      if (this.stopping || this.stagedBackend !== staged) {
        throw new Error('agent runtime stopped during runtime switch');
      }

      // Commit is the authority hand-off. The target sidecar was unable to send
      // during catch-up; after this transaction the old sidecar is unable to send.
      this.store.commitRuntimeSwitch({
        runtime: target.runtime,
        authorityToken,
        sessionId: session.sessionId,
        policyHash: session.policyHash,
        epoch: cognition.epoch,
        // Catch-up is attached to the first real inbound turn. Running the
        // untrusted journal as a standalone model turn would grant historical
        // prompt injection filesystem/shell authority before a user request.
        syncedThroughSeq: 0,
        sessionReady: session.sessionReady !== false,
        model: target.model,
      });
      staged.activateSession();
      this.backend = staged;
      this.runtime = target.runtime;
      this.stagedBackend = null;
      staged = null;
      try { await previous.stop(); } catch (error) {
        this.logger.warn('retired_runtime_stop_failed', { runtime: previousRuntime, error: error.message });
      }
      try {
        this.store.appendCognitionJournal({
          kind: 'control',
          actor: 'daemon',
          text: `global runtime switched ${previousRuntime} -> ${target.runtime}; target will catch up through journal seq ${catchup.throughSeq} on its first real turn; opaque ${previousRuntime} session retired`,
          dedupeKey: `control:runtime:${randomUUID()}`,
        });
      } catch (error) {
        // The switch is already committed. Never report it as failed and let a
        // caller retry a completed authority hand-off.
        this.logger.warn('runtime_switch_journal_write_failed', { error: error.message });
      }
      return {
        runtimeChanged: true,
        runtime: target.runtime,
        model: target.canonical,
        syncedThroughSeq: catchup.throughSeq,
        catchupPending: true,
      };
    } catch (error) {
      try { await staged?.stop(); } catch {}
      previous.cancelSessionRotation?.();
      throw error;
    } finally {
      if (this.stagedBackend === staged) this.stagedBackend = null;
      this.switching = false;
      this.onAvailable?.();
    }
  }

  setEffort(effort) { return this.backend.setEffort(effort); }

  async rotateSession({ resume = false } = {}) {
    if (resume) return this.backend.rotateSession({ resume: true });
    // Managed-agent session creation is an external side effect and may fail.
    // Prepare it before clearing the current local cognition epoch. Do not wait
    // on its queued next-turn input: /new has already interrupted the active
    // turn, and that queue must migrate to the new session rather than deadlock.
    let prepared = null;
    try {
      prepared = this.backend.prepareSessionRotation
        ? await this.backend.prepareSessionRotation()
        : null;
      if (prepared && !prepared.id) throw new Error('managed runtime prepared an invalid session');
    } catch (error) {
      this.backend.cancelSessionRotation?.();
      throw error;
    }
    if (!prepared) await this.backend.whenIdle();
    const current = this.store.getCognitionState();
    if (prepared && this.backend.commitSessionRotation
      && this.store.commitCognitionSessionRotation) {
      let cognition;
      try {
        cognition = this.store.commitCognitionSessionRotation({
          runtime: this.runtime,
          authorityToken: current.authorityToken,
          nextAuthorityToken: randomUUID(),
          sessionId: prepared.id,
          policyHash: this.backend.policyHash,
          expectedEpoch: current.epoch,
          syncedThroughSeq: 0,
          sessionReady: true,
        });
      } catch (error) {
        this.backend.cancelSessionRotation?.();
        throw error;
      }
      this.backend.cognitionEpoch = cognition.epoch;
      this.backend.authorityToken = cognition.authorityToken;
      this.backend.syncedThroughSeq = 0;
      return this.backend.commitSessionRotation(prepared, { persist: false });
    }
    const cognition = this.store.bumpCognitionEpoch(
      this.runtime,
      current.authorityToken,
    );
    this.backend.cognitionEpoch = cognition.epoch;
    this.backend.syncedThroughSeq = 0;
    if (prepared && this.backend.commitSessionRotation) {
      return this.backend.commitSessionRotation(prepared);
    }
    return await this.backend.rotateSession({ resume: false });
  }

  async stop() {
    this.stopping = true;
    const backends = [...new Set([this.backend, this.stagedBackend].filter(Boolean))];
    this.stagedBackend = null;
    const results = await Promise.allSettled(backends.map((backend) => backend.stop()));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('agent_runtime_stop_failed', { error: result.reason?.message ?? String(result.reason) });
      }
    }
  }
}

export { parseTarget as parseRuntimeModelTarget };

import { randomUUID } from 'node:crypto';
import { cognitionHistoryPrefix } from './cognition.mjs';
import { adaptRuntime } from './runtime-adapter.mjs';
import { createRuntimeFactories } from './runtime-factory.mjs';
import {
  DEFAULT_RUNTIME_ID,
  RUNTIME_IDS,
  getRuntimeDefinition,
  resolveRuntimeModelTarget,
  staticModelEntries,
} from './runtime-catalog.mjs';

const SWITCH_JOURNAL_HEADROOM = 4_096;

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
    this.onAuthorityChanged = options.onAuthorityChanged ?? null;
    this.factories = createRuntimeFactories(config, store, logger, options);
    this.backend = null;
    this.stagedBackend = null;
    this.runtime = DEFAULT_RUNTIME_ID;
    this.switching = false;
    this.transitioning = false;
    this.pendingTransitions = 0;
    this.transitionBarrier = Promise.resolve();
    this.stopping = false;
    this.revision = 0;
    this.cachedModels = [];
  }

  get threadId() { return this.backend?.threadId ?? null; }
  get effort() { return this.backend?.effort ?? 'medium'; }
  get model() {
    const model = this.backend?.model ?? '';
    return model || getRuntimeDefinition(this.runtime)?.canonicalDefault || '';
  }
  get state() {
    const state = this.backend?.state ?? { connected: false, activeTurn: 0, queued: 0 };
    return { ...state, connected: state.connected && this.pendingTransitions === 0 };
  }
  get turnInProgress() { return this.pendingTransitions > 0 || Boolean(this.backend?.turnInProgress); }
  get workStatus() {
    const working = this.pendingTransitions > 0 || Boolean(this.backend?.modelWorking);
    return {
      working,
      // A turn may pause for tools and resume sampling several times. Keep the
      // user-facing clock anchored to the root turn instead of resetting it for
      // every reasoning/message item.
      startedAtMs: working ? (this.backend?.turnStartedAtMs ?? null) : null,
      connected: Boolean(this.state.connected),
      queued: this.state.queued ?? 0,
      switching: this.pendingTransitions > 0,
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

  _instantiate(runtime, overrides = {}) {
    return adaptRuntime(runtime, this.factories[runtime](this._backendOptions(overrides)));
  }

  _authorityChanged(cognition) {
    this.revision += 1;
    try {
      this.onAuthorityChanged?.({
        runtime: cognition.runtime,
        epoch: cognition.epoch,
        authorityToken: cognition.authorityToken,
      });
    } catch (error) {
      // The Store commit is the linearization point. A notification consumer
      // cannot roll it back or make the caller retry an already-applied switch.
      this.logger.warn('runtime_authority_notification_failed', { error: error.message });
    }
  }

  async start() {
    this.stopping = false;
    let cognition = this.store.getCognitionState();
    const persistedRuntime = RUNTIME_IDS.includes(cognition.runtime)
      ? cognition.runtime
      : DEFAULT_RUNTIME_ID;
    this.runtime = this.store.hasCognitionRuntime?.() === false
      ? resolveRuntimeModelTarget(this.config.initialModel || this.config.codexModel || '').runtime
      : persistedRuntime;
    // A daemon generation must never inherit the previous process's authority.
    // If that process crashed with a detached MCP sidecar still alive, rotating
    // the token here fences it before the replacement backend starts.
    cognition = this.store.initializeCognition(this.runtime, randomUUID());
    this.backend = this._instantiate(this.runtime);
    await this.backend.start();
    this._authorityChanged(cognition);
  }

  submit(items, { admission = 'enqueue' } = {}) {
    if (this.stopping) return { accepted: false, reason: 'stopping' };
    if (this.pendingTransitions > 0) return { accepted: false, reason: 'switching' };
    if (!this.backend) return { accepted: false, reason: 'not-started' };
    if (!Array.isArray(items) || items.length === 0) {
      return { accepted: false, reason: 'empty-batch' };
    }
    const definition = getRuntimeDefinition(this.runtime);
    if (definition?.capabilities.scopePolicy === 'single-conversation') {
      const scopes = new Set(items.map((item) => item?.scope?.conversationKey ?? item?.conversationKey));
      if (scopes.has(undefined) || scopes.has(null) || scopes.has('') || scopes.size !== 1) {
        return { accepted: false, reason: 'invalid-scope' };
      }
    }
    return this.backend.submit(items, { admission });
  }

  _interrupt() { return this.backend?.interrupt() ?? Promise.resolve(); }

  async _listModels() {
    const current = await this.backend?.listModels() ?? [];
    const models = [
      ...current,
      ...staticModelEntries(),
    ];
    const seen = new Set();
    this.cachedModels = models.filter((model) => {
      if (!model?.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
    return this.cachedModels;
  }

  snapshot({ catalog = 'cached' } = {}) {
    if (!['cached', 'refresh'].includes(catalog)) {
      throw new TypeError(`unsupported catalog mode: ${catalog}`);
    }
    if (catalog === 'refresh') {
      return this._listModels().then((models) => this._snapshot(models));
    }
    return this._snapshot(this.cachedModels);
  }

  _snapshot(models) {
    const definition = getRuntimeDefinition(this.runtime);
    const state = this.state;
    const work = this.workStatus;
    const snapshot = {
      revision: this.revision,
      phase: this.stopping ? 'stopping' : this.pendingTransitions > 0 ? 'switching' : work.working ? 'working' : 'ready',
      runtime: this.runtime,
      session: Object.freeze({ id: this.threadId, connected: state.connected }),
      model: this.model,
      effort: this.effort,
      capabilities: definition?.capabilities ?? Object.freeze({}),
      queued: state.queued ?? 0,
      work: Object.freeze({
        ...work,
        turnInProgress: this.pendingTransitions > 0 || Boolean(this.backend?.turnInProgress),
      }),
      models: Object.freeze(models.map((entry) => Object.freeze({
        ...entry,
        efforts: Object.freeze([...(entry.efforts ?? [])]),
      }))),
    };
    return Object.freeze(snapshot);
  }

  transition(request) {
    this.pendingTransitions += 1;
    const run = this.transitionBarrier.then(() => this._runTransition(request));
    const settled = run.finally(() => {
      this.pendingTransitions -= 1;
      if (this.pendingTransitions === 0) {
        try { this.onAvailable?.(); } catch (error) {
          this.logger.warn('runtime_available_notification_failed', { error: error.message });
        }
      }
    });
    this.transitionBarrier = settled.catch(() => {});
    return settled;
  }

  async _runTransition(request) {
    if (!request || typeof request !== 'object') throw new TypeError('transition request is required');
    if (this.stopping) throw new Error('agent runtime is stopping');
    if (Number.isSafeInteger(request.expectedRevision) && request.expectedRevision !== this.revision) {
      return {
        ok: false,
        kind: request.kind,
        reason: 'stale-snapshot',
        runtime: this.runtime,
        revision: this.revision,
      };
    }
    if (request.expectedRuntime && request.expectedRuntime !== this.runtime) {
      return {
        ok: false,
        kind: request.kind,
        reason: 'runtime-changed',
        runtime: this.runtime,
        revision: this.revision,
      };
    }
    this.transitioning = true;
    this.revision += 1;
    this.cachedModels = [];
    try {
      if (request.kind === 'new-session') {
        await this._interrupt();
        if (this.stopping) throw new Error('agent runtime stopped during session transition');
        const threadId = await this._rotateSession({ resume: false });
        return { ok: true, kind: request.kind, runtime: this.runtime, threadId };
      }
      if (request.kind === 'select-model') {
        const result = await this._selectModel(request.selector);
        return { ok: true, kind: request.kind, ...result };
      }
      if (request.kind === 'select-effort') {
        const definition = getRuntimeDefinition(this.runtime);
        if (definition?.capabilities.effortControl !== 'selectable') {
          return { ok: false, kind: request.kind, reason: 'remote-managed' };
        }
        if (!definition.efforts.includes(request.effort)) {
          return { ok: false, kind: request.kind, reason: 'unsupported-effort' };
        }
        await this._interrupt();
        if (this.stopping) throw new Error('agent runtime stopped during effort transition');
        const previousEffort = this.backend.effort;
        this._selectEffort(request.effort, { persist: false });
        let threadId;
        try {
          threadId = await this._rotateSession({
            resume: false,
            settings: { [`${this.runtime}_effort`]: request.effort },
            rollback: { effort: previousEffort },
          });
        } catch (error) {
          this._selectEffort(previousEffort, { persist: false });
          throw error;
        }
        return { ok: true, kind: request.kind, runtime: this.runtime, effort: request.effort, threadId };
      }
      throw new TypeError(`unsupported transition: ${request.kind}`);
    } finally {
      this.transitioning = false;
      this.revision += 1;
    }
  }

  async _selectModel(value) {
    if (this.stopping) throw new Error('agent runtime is stopping');
    const target = resolveRuntimeModelTarget(value);
    if (target.runtime === this.runtime) {
      // /m must not wait for a stuck turn, and every model change opens a
      // fresh session: interrupt the in-flight turn (its inbound rows stay in
      // the cognition journal, queued items survive), apply, then rotate.
      await this.backend.interrupt();
      if (this.stopping) throw new Error('agent runtime stopped during model transition');
      const previousModel = this.backend.model;
      await this.backend.selectModel(target.model, { persist: false, reconfigure: false });
      if (this.stopping) throw new Error('agent runtime stopped during model transition');
      let threadId;
      try {
        threadId = await this._rotateSession({
          resume: false,
          settings: { [`${this.runtime}_model`]: target.model },
          rollback: { model: previousModel },
        });
      } catch (error) {
        await this.backend.selectModel(previousModel, { persist: false, reconfigure: false });
        throw error;
      }
      try {
        this.store.appendCognitionJournal({
          kind: 'control',
          actor: 'daemon',
          text: `model changed within ${this.runtime} runtime to ${target.model || 'default'}; fresh native session opened`,
          dedupeKey: `control:model:${randomUUID()}`,
        });
      } catch (error) {
        this.logger.warn('runtime_model_journal_write_failed', { error: error.message });
      }
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
      await previous.interrupt();
      if (this.stopping) throw new Error('agent runtime stopped during runtime switch');
      const cognition = this.store.getCognitionState();
      const journalThrough = this.store.cognitionJournalHead(cognition.epoch);
      const authorityToken = randomUUID();
      staged = this._instantiate(target.runtime, {
        authorityToken,
        cognitionEpoch: cognition.epoch,
        sessionPersistence: false,
        allowResume: false,
        // The journal is not acknowledged until the target's first real turn
        // completes. journalThrough is only the bounded staging snapshot.
        syncedThroughSeq: 0,
        model: target.model,
        onAvailable: null,
      });
      this.stagedBackend = staged;
      await staged.start();
      if (this.stopping || this.stagedBackend !== staged) {
        throw new Error('agent runtime stopped during runtime switch');
      }
      if (!staged.state?.connected) throw new Error('target runtime exited before switch commit');
      if (staged.model !== target.model) throw new Error('target runtime did not apply the requested model');
      if (getRuntimeDefinition(target.runtime)?.capabilities.modelCatalog === 'dynamic' && target.model) {
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
      staged.activate();
      this.backend = staged;
      this.runtime = target.runtime;
      this._authorityChanged({ runtime: target.runtime, epoch: cognition.epoch, authorityToken });
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
      previous.cancelSession?.();
      throw error;
    } finally {
      if (this.stagedBackend === staged) this.stagedBackend = null;
      this.switching = false;
    }
  }

  _selectEffort(effort, options) { return this.backend.selectEffort(effort, options); }

  async _rotateSession({ resume = false, settings = {}, rollback = {} } = {}) {
    if (resume) {
      const plan = await this.backend.prepareSession({ resume: true });
      return this.backend.commitSession(plan);
    }
    // Every transport prepares its replacement before the SQLite CAS. Prepare
    // may perform fallible RPC/process work, but cannot persist or drain input;
    // commit is a synchronous activation after the local authority hand-off.
    let plan = null;
    try {
      plan = await this.backend.prepareSession({ resume: false, rollback });
    } catch (error) {
      await this.backend.cancelSession();
      throw error;
    }
    if (this.stopping) {
      await this.backend.cancelSession();
      throw new Error('agent runtime stopped during session preparation');
    }
    const current = this.store.getCognitionState();
    let cognition;
    const nextAuthorityToken = getRuntimeDefinition(this.runtime)?.capabilities.sessionAuthority === 'rotate'
      ? randomUUID()
      : current.authorityToken;
    try {
      cognition = this.store.commitCognitionSessionRotation({
        runtime: this.runtime,
        authorityToken: current.authorityToken,
        nextAuthorityToken,
        sessionId: plan.prepared.id,
        policyHash: this.backend.policyHash,
        expectedEpoch: current.epoch,
        syncedThroughSeq: 0,
        sessionReady: plan.prepared.sessionReady !== false,
        settings,
      });
    } catch (error) {
      await this.backend.cancelSession();
      throw error;
    }
    this.backend.applyCognition({ ...cognition, syncedThroughSeq: 0 });
    this._authorityChanged(cognition);
    return this.backend.commitSession(plan, { persist: false });
  }

  async stop() {
    this.stopping = true;
    const transitionPending = this.pendingTransitions > 0;
    const stopBackends = async () => {
      const backends = [...new Set([this.backend, this.stagedBackend].filter(Boolean))];
      const results = await Promise.allSettled(backends.map((backend) => backend.stop()));
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.warn('agent_runtime_stop_failed', { error: result.reason?.message ?? String(result.reason) });
        }
      }
    };
    await stopBackends();
    if (transitionPending) {
      await this.transitionBarrier;
      // A provider operation already in flight may have installed a replacement
      // child before observing `stopping`; retire that final generation too.
      await stopBackends();
    }
    this.stagedBackend = null;
  }
}

export { resolveRuntimeModelTarget as parseRuntimeModelTarget } from './runtime-catalog.mjs';

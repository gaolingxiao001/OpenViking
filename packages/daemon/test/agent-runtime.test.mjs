import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentRuntime } from '../src/agent-runtime.mjs';
import { resolveRuntimeModelTarget as parseRuntimeModelTarget } from '../src/runtime-catalog.mjs';
import { adaptRuntime } from '../src/runtime-adapter.mjs';
import { LarkToolService } from '../src/lark-tools.mjs';
import { Store } from '../src/store.mjs';
import { runClaudeRuntimeSimulation } from '../simulator/claude-runtime-simulator.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function backend(runtime, options = {}) {
  return {
    runtime,
    model: options.model ?? '',
    effort: 'medium',
    threadId: `${runtime}-session`,
    state: { connected: false, activeTurn: 0, queued: 0 },
    turnInProgress: false,
    get sessionDescriptor() {
      return {
        runtime,
        sessionId: this.threadId,
        policyHash: `${runtime}-policy`,
        epoch: options.cognitionEpoch,
        syncedThroughSeq: 0,
        sessionReady: runtime === 'codex',
      };
    },
    async start() { this.state.connected = true; },
    async stop() { this.state.connected = false; },
    async whenIdle() {},
    activateSession() {},
    async listModels() { return [{ id: this.model || 'gpt-5.6-sol', efforts: ['medium'] }]; },
    async prepareSessionRotation() {
      this.preparedSession = { id: `${runtime}-fresh`, sessionReady: runtime !== 'claude' };
      return this.preparedSession;
    },
    commitSessionRotation(prepared) {
      this.threadId = prepared.id;
      this.preparedSession = null;
      return this.threadId;
    },
    cancelSessionRotation() { this.preparedSession = null; },
  };
}

describe('global Codex/Claude hard switch', () => {
  it('retires stale sessions, fences authority, and rolls back target-start failure', async () => {
    const result = await runClaudeRuntimeSimulation();
    assert.equal(result.ok, true);
    assert.deepEqual(result.switches, ['claude', 'codex']);
    assert.equal(result.oldAuthorityRevoked, true);
    assert.equal(result.staleCodexReused, false);
    assert.equal(result.failurePreservedOldRuntime, true);
  });

  it('infers direct model providers while retaining hidden qualified aliases', () => {
    assert.deepEqual(parseRuntimeModelTarget('sonnet'), {
      runtime: 'claude', model: 'sonnet', canonical: 'sonnet',
    });
    assert.deepEqual(parseRuntimeModelTarget('gpt-5.6-sol'), {
      runtime: 'codex', model: 'gpt-5.6-sol', canonical: 'gpt-5.6-sol',
    });
    assert.deepEqual(parseRuntimeModelTarget('claude'), {
      runtime: 'codex', model: 'claude', canonical: 'claude',
    });
    assert.deepEqual(parseRuntimeModelTarget('codex'), {
      runtime: 'codex', model: 'codex', canonical: 'codex',
    });
    assert.deepEqual(parseRuntimeModelTarget('claude:sonnet'), {
      runtime: 'claude', model: 'sonnet', canonical: 'sonnet',
    });
    assert.deepEqual(parseRuntimeModelTarget('codex:gpt-5.6-sol'), {
      runtime: 'codex', model: 'gpt-5.6-sol', canonical: 'gpt-5.6-sol',
    });
    assert.deepEqual(parseRuntimeModelTarget('ark'), {
      runtime: 'volc', model: 'ark', canonical: 'ark',
    });
    assert.deepEqual(parseRuntimeModelTarget('volcengine'), {
      runtime: 'volc', model: 'ark', canonical: 'ark',
    });
    assert.deepEqual(parseRuntimeModelTarget('pi'), {
      runtime: 'pi', model: '', canonical: 'pi',
    });
    assert.deepEqual(parseRuntimeModelTarget('pi:openai/gpt-4o'), {
      runtime: 'pi', model: 'openai/gpt-4o', canonical: 'openai/gpt-4o',
    });
  });

  it('starts Pi rather than Codex on a fresh database configured with model pi', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-fresh-pi-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    const selected = [];
    const runtime = new AgentRuntime({
      initialModel: 'pi',
      codexModel: '',
      cognitionMaxChars: 120_000,
    }, store, quietLogger, {
      codexFactory: () => {
        selected.push('codex');
        return backend('codex');
      },
      piFactory: (options) => {
        selected.push('pi');
        return backend('pi', options);
      },
    });
    try {
      assert.equal(store.hasCognitionRuntime(), false);
      await runtime.start();
      assert.deepEqual(selected, ['pi']);
      assert.equal(runtime.runtime, 'pi');
      assert.equal(store.getCognitionState().runtime, 'pi');
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts Ark rather than Codex on a fresh database configured with model ark', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-fresh-ark-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    const selected = [];
    const runtime = new AgentRuntime({
      initialModel: 'ark',
      codexModel: '',
      cognitionMaxChars: 120_000,
    }, store, quietLogger, {
      codexFactory: () => {
        selected.push('codex');
        return backend('codex');
      },
      volcFactory: (options) => {
        selected.push('volc');
        return backend('volc', options);
      },
    });
    try {
      assert.equal(store.hasCognitionRuntime(), false);
      await runtime.start();
      assert.deepEqual(selected, ['volc']);
      assert.equal(runtime.runtime, 'volc');
      assert.equal(store.getCognitionState().runtime, 'volc');
      assert.equal(store.hasCognitionRuntime(), true);
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports the root model idle while only an external tool or subagent is running', () => {
    const runtime = new AgentRuntime({}, {}, quietLogger);
    runtime.backend = backend('codex');
    runtime.backend.turnInProgress = true;
    runtime.backend.modelWorking = false;
    runtime.backend.modelStartedAtMs = null;
    assert.equal(runtime.workStatus.working, false);

    runtime.backend.modelWorking = true;
    runtime.backend.modelStartedAtMs = 5678;
    runtime.backend.turnStartedAtMs = 1234;
    assert.deepEqual(runtime.workStatus, {
      working: true,
      startedAtMs: 1234,
      connected: false,
      queued: 0,
      switching: false,
    });
  });

  it('forwards opaque delivery receipts without requiring an inbound sequence', () => {
    const runtime = new AgentRuntime({}, {}, quietLogger);
    const calls = [];
    runtime.backend = adaptRuntime('codex', {
      deliverBatch(items) { calls.push(['deliverBatch', items]); return true; },
    });

    assert.equal(runtime.submit([{ text: 'normal inbound', seq: 7 }]).accepted, true);
    assert.equal(runtime.submit([{
      text: 'meeting audio', seq: null, receiptId: 'receipt-1',
    }]).accepted, true);
    assert.equal(runtime.submit([
      { text: 'next segment', receiptId: 'receipt-2' },
    ]).accepted, true);
    assert.deepEqual(calls, [
      ['deliverBatch', [{ text: 'normal inbound', seq: 7 }]],
      ['deliverBatch', [{ text: 'meeting audio', seq: null, receiptId: 'receipt-1' }]],
      ['deliverBatch', [{ text: 'next segment', receiptId: 'receipt-2' }]],
    ]);
  });

  it('publishes an immutable normalized snapshot', async () => {
    const runtime = new AgentRuntime({}, {}, quietLogger);
    const implementation = backend('claude');
    implementation.model = 'sonnet';
    implementation.effort = 'high';
    implementation.state = { connected: true, activeTurn: 1, queued: 2 };
    implementation.turnInProgress = true;
    implementation.modelWorking = true;
    implementation.turnStartedAtMs = 1234;
    runtime.runtime = 'claude';
    runtime.backend = adaptRuntime('claude', implementation);

    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.runtime, 'claude');
    assert.equal(snapshot.phase, 'working');
    assert.equal(snapshot.session.id, 'claude-session');
    assert.equal(snapshot.capabilities.activeInput, 'steer');
    assert.equal(snapshot.queued, 2);
    assert.equal(snapshot.work.turnInProgress, true);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.session), true);
    assert.equal(Object.isFrozen(snapshot.work), true);
    await assert.rejects(async () => { snapshot.session.id = 'mutated'; }, /read only|Cannot assign/);
  });

  it('rejects targetless or mixed managed-agent scope before ownership transfers', async () => {
    const runtime = new AgentRuntime({}, {}, quietLogger);
    const calls = [];
    runtime.runtime = 'volc';
    runtime.backend = adaptRuntime('volc', {
      deliverBatch(items) { calls.push(items); return true; },
    });

    assert.deepEqual(runtime.submit([{ text: 'targetless', receiptId: 'meeting-1' }]), {
      accepted: false,
      reason: 'invalid-scope',
    });
    assert.equal(runtime.submit([
      { text: 'a', conversationKey: 'chat-a' },
      { text: 'b', conversationKey: 'chat-b' },
    ]).accepted, false);
    assert.equal(runtime.submit([
      { text: 'a', scope: { conversationKey: 'chat-a' } },
      { text: 'b', scope: { conversationKey: 'chat-a' } },
    ]).accepted, true);
    assert.equal(calls.length, 1);

    const effort = await runtime.transition({ kind: 'select-effort', effort: 'high' });
    assert.deepEqual(effort, {
      ok: false,
      kind: 'select-effort',
      reason: 'remote-managed',
    });
  });

  it('live-validates a direct Codex name before switching from Claude', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-direct-model-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    store.initializeCognition('claude', 'old-token');
    const stagedCodex = [];
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      claudeFactory: (options) => {
        const instance = backend('claude', options);
        instance.model = 'sonnet';
        return instance;
      },
      codexFactory: (options) => {
        const instance = backend('codex', options);
        instance.listModels = async () => [{ id: 'gpt-5.6-sol', efforts: ['medium'] }];
        stagedCodex.push(instance);
        return instance;
      },
    });

    try {
      await runtime.start();
      await assert.rejects(() => runtime.transition({
        kind: 'select-model', selector: 'gpt-missing',
      }), /unavailable/);
      assert.equal(runtime.runtime, 'claude');
      assert.equal(store.getCognitionState().runtime, 'claude');
      assert.equal(stagedCodex[0].state.connected, false);

      const result = await runtime.transition({ kind: 'select-model', selector: 'gpt-5.6-sol' });
      assert.equal(result.runtimeChanged, true);
      assert.equal(result.model, 'gpt-5.6-sol');
      assert.equal(runtime.runtime, 'codex');
      assert.equal(runtime.model, 'gpt-5.6-sol');
      assert.equal(store.getCognitionState().runtime, 'codex');
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('switches runtimes immediately by interrupting a stuck in-flight turn', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-stuck-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    let previous;
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      codexFactory: (options) => {
        previous = backend('codex', options);
        previous.calls = [];
        previous.turnInProgress = true;
        // A stuck turn: whenIdle would hang forever if the switch awaited it.
        previous.whenIdle = function whenIdle() {
          return this.turnInProgress ? new Promise(() => {}) : Promise.resolve();
        };
        previous.interruptTurn = async function interruptTurn() {
          this.calls.push('interrupt');
          this.turnInProgress = false;
        };
        return previous;
      },
      claudeFactory: (options) => {
        const instance = backend('claude', options);
        instance.model = options.model;
        return instance;
      },
    });

    try {
      await runtime.start();
      const result = await runtime.transition({ kind: 'select-model', selector: 'sonnet' });
      assert.equal(result.runtimeChanged, true);
      assert.equal(runtime.runtime, 'claude');
      assert.deepEqual(previous.calls, ['interrupt']);
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('interrupts and rotates to a fresh session on a same-runtime model change', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-samemodel-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    let instance;
    const authorities = [];
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      onAuthorityChanged: (authority) => authorities.push(authority),
      codexFactory: (options) => {
        instance = backend('codex', options);
        instance.calls = [];
        instance.turnInProgress = true;
        instance.whenIdle = function whenIdle() {
          return this.turnInProgress ? new Promise(() => {}) : Promise.resolve();
        };
        instance.interruptTurn = async function interruptTurn() {
          this.calls.push('interrupt');
          this.turnInProgress = false;
        };
        instance.setModel = async function setModel(model) {
          this.calls.push(`setModel:${model}`);
          this.model = model;
        };
        instance.prepareSessionRotation = async function prepareSessionRotation() {
          this.calls.push('prepare');
          return { id: 'codex-fresh', sessionReady: true };
        };
        instance.commitSessionRotation = function commitSessionRotation(prepared, options) {
          this.calls.push(`commit:${options.persist}`);
          this.threadId = prepared.id;
          return this.threadId;
        };
        return instance;
      },
    });

    try {
      await runtime.start();
      const before = store.getCognitionState();
      const result = await runtime.transition({ kind: 'select-model', selector: 'gpt-5.6-sol' });
      assert.deepEqual(instance.calls, [
        'interrupt',
        'setModel:gpt-5.6-sol',
        'prepare',
        'commit:false',
      ]);
      assert.equal(result.runtimeChanged, false);
      assert.equal(result.threadId, 'codex-fresh');
      // The fresh session starts a new cognition epoch, like /new.
      assert.equal(store.getCognitionState().epoch, before.epoch + 1);
      assert.equal(store.getSetting('codex_model'), 'gpt-5.6-sol');
      // Codex keeps one MCP child across native thread rotation, so its process
      // authority remains stable until that child is replaced.
      assert.equal(store.getCognitionState().authorityToken, before.authorityToken);
      assert.equal(authorities.length, 2);
      assert.equal(authorities.at(-1).authorityToken, store.getCognitionState().authorityToken);
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rotates a prepared Ark session without waiting on queued next-turn input', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-ark-new-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    store.initializeCognition('volc', 'old-token');
    let instance;
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      volcFactory: (options) => {
        instance = backend('volc', options);
        instance.threadId = 'sesn-old123456';
        instance.policyHash = 'volc-policy';
        instance.state.queued = 1;
        instance.whenIdle = () => new Promise(() => {});
        instance.prepareSessionRotation = async () => ({ id: 'sesn-new123456' });
        instance.commitSessionRotation = (prepared, commitOptions) => {
          instance.threadId = prepared.id;
          instance.commitOptions = commitOptions;
          return prepared.id;
        };
        return instance;
      },
    });

    try {
      await runtime.start();
      const before = store.getCognitionState();
      store.setGlobalSession(instance.threadId, instance.policyHash, {
        runtime: 'volc',
        epoch: before.epoch,
      });
      const { threadId: sessionId } = await runtime.transition({ kind: 'new-session' });
      assert.equal(sessionId, 'sesn-new123456');
      assert.deepEqual(instance.commitOptions, { persist: false });
      assert.equal(store.getCognitionState().epoch, before.epoch + 1);
      assert.notEqual(store.getCognitionState().authorityToken, before.authorityToken);
      assert.equal(instance.authorityToken, store.getCognitionState().authorityToken);
      assert.equal(store.getGlobalSession().sessionId, 'sesn-new123456');
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps cognition and the active session unchanged when the prepared-session CAS fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-cas-fail-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    let instance;
    let cancelled = 0;
    let committed = 0;
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      codexFactory: (options) => {
        instance = backend('codex', options);
        instance.prepareSessionRotation = async () => ({ id: 'codex-candidate', sessionReady: true });
        instance.commitSessionRotation = () => { committed += 1; return 'codex-candidate'; };
        instance.cancelSessionRotation = () => { cancelled += 1; };
        return instance;
      },
    });

    try {
      await runtime.start();
      const before = store.getCognitionState();
      store.setGlobalSession('codex-session', 'codex-policy', {
        runtime: 'codex',
        epoch: before.epoch,
        syncedThroughSeq: 7,
      });
      const globalBefore = store.getGlobalSession();
      store.commitCognitionSessionRotation = () => { throw new Error('sqlite CAS failed'); };

      await assert.rejects(
        () => runtime.transition({ kind: 'new-session' }),
        /sqlite CAS failed/,
      );
      assert.deepEqual(store.getCognitionState(), before);
      assert.deepEqual(store.getGlobalSession(), globalBefore);
      assert.equal(cancelled, 1);
      assert.equal(committed, 0);
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a stale effort intent before interrupting the current runtime', async () => {
    const runtime = new AgentRuntime({}, {}, quietLogger);
    const calls = [];
    const implementation = backend('codex');
    implementation.interruptTurn = async () => { calls.push('interrupt'); };
    implementation.setEffort = (effort) => { calls.push(`effort:${effort}`); };
    runtime.runtime = 'codex';
    runtime.backend = adaptRuntime('codex', implementation);
    runtime.revision = 4;

    const result = await runtime.transition({
      kind: 'select-effort',
      effort: 'high',
      expectedRuntime: 'claude',
      expectedRevision: 3,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale-snapshot');
    assert.deepEqual(calls, []);
  });

  it('releases an Ark rotation fence when remote session preparation fails', async () => {
    const runtime = new AgentRuntime({}, {
      getCognitionState: () => ({ runtime: 'volc', epoch: 1, authorityToken: 'token' }),
    }, quietLogger);
    let cancelled = 0;
    runtime.runtime = 'volc';
    runtime.backend = adaptRuntime('volc', {
      async prepareSessionRotation() { throw new Error('remote create failed'); },
      cancelSessionRotation() { cancelled += 1; },
    });
    await assert.rejects(() => runtime.transition({ kind: 'new-session' }), /remote create failed/);
    assert.equal(cancelled, 1);
  });

  it('rotates process authority on startup so a crash survivor loses read and write access', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-restart-'));
    const databasePath = path.join(directory, 'state.sqlite3');
    const store = new Store(databasePath, quietLogger);
    store.initializeCognition('codex', 'token-from-crashed-daemon');
    let cliCalls = 0;
    const staleService = new LarkToolService({
      larkCliBin: '/fake/lark-cli',
      profile: 'fixed-profile',
      projectDir: '/safe/project',
      databasePath,
      runtimeToken: 'token-from-crashed-daemon',
      timeoutMs: 1_000,
      maxTextChars: 1_000,
      dryRun: false,
    }, async () => {
      cliCalls += 1;
      return { code: 0, signal: null, stdout: '{"ok":true}', stderr: '', timedOut: false };
    });
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      codexFactory: (options) => backend('codex', options),
    });

    try {
      await runtime.start();
      assert.notEqual(store.getCognitionState().authorityToken, 'token-from-crashed-daemon');
      await assert.rejects(() => staleService.listChats(), /no longer owns/);
      await assert.rejects(() => staleService.sendMessage({
        chat_id: 'oc_restart123456',
        text: 'must stay fenced',
        decision_message_id: 'om_restart123456',
      }), /no longer owns/);
      assert.equal(cliCalls, 0);
    } finally {
      await runtime.stop();
      staleService.close();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels and retires a staged backend when shutdown races a hard switch', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-stop-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    let releaseStart;
    let markStarted;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    const stagedStarted = new Promise((resolve) => { markStarted = resolve; });
    let staged;
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      codexFactory: (options) => backend('codex', options),
      claudeFactory: (options) => {
        staged = backend('claude', options);
        staged.stopCount = 0;
        staged.start = async function start() {
          markStarted();
          await startGate;
          this.state.connected = true;
        };
        staged.stop = async function stop() {
          this.stopCount += 1;
          this.state.connected = false;
        };
        return staged;
      },
    });

    try {
      await runtime.start();
      const switchResult = runtime.transition({ kind: 'select-model', selector: 'claude:sonnet' });
      assert.deepEqual(runtime.submit([{ text: 'must remain caller-owned', seq: 9 }]), {
        accepted: false,
        reason: 'switching',
      });
      await stagedStarted;
      const stopped = runtime.stop();
      releaseStart();
      await stopped;
      await assert.rejects(() => switchResult, /stopped during runtime switch/);
      assert.equal(store.getCognitionState().runtime, 'codex');
      assert.equal(runtime.runtime, 'codex');
      assert.ok(staged.stopCount >= 1);
    } finally {
      releaseStart();
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('waits for and retires a same-runtime provider operation during stop', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-runtime-stop-transition-'));
    const store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    let releaseModel;
    let markModelStarted;
    const modelStarted = new Promise((resolve) => { markModelStarted = resolve; });
    const modelGate = new Promise((resolve) => { releaseModel = resolve; });
    let instance;
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
      codexFactory: (options) => {
        instance = backend('codex', options);
        instance.stopCount = 0;
        instance.interruptTurn = async () => {};
        instance.setModel = async function setModel(model) {
          markModelStarted();
          await modelGate;
          this.model = model;
        };
        instance.stop = async function stop() {
          this.stopCount += 1;
          this.state.connected = false;
        };
        return instance;
      },
    });

    try {
      await runtime.start();
      const epoch = store.getCognitionState().epoch;
      const changing = runtime.transition({ kind: 'select-model', selector: 'gpt-5.6-sol' });
      await modelStarted;
      const stopped = runtime.stop();
      releaseModel();
      await stopped;
      await assert.rejects(() => changing, /stopped during model transition/);
      assert.equal(store.getCognitionState().epoch, epoch);
      assert.ok(instance.stopCount >= 2);
    } finally {
      releaseModel();
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AgentRuntime, parseRuntimeModelTarget } from '../src/agent-runtime.mjs';
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
      await assert.rejects(() => runtime.setModel('gpt-missing'), /unavailable/);
      assert.equal(runtime.runtime, 'claude');
      assert.equal(store.getCognitionState().runtime, 'claude');
      assert.equal(stagedCodex[0].state.connected, false);

      const result = await runtime.setModel('gpt-5.6-sol');
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
      const result = await runtime.setModel('sonnet');
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
    const runtime = new AgentRuntime({ cognitionMaxChars: 120_000 }, store, quietLogger, {
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
        instance.rotateSession = async function rotateSession(options) {
          this.calls.push(`rotate:${options.resume}`);
          this.threadId = 'codex-fresh';
          return this.threadId;
        };
        return instance;
      },
    });

    try {
      await runtime.start();
      const epochBefore = store.getCognitionState().epoch;
      const result = await runtime.setModel('gpt-5.6-sol');
      assert.deepEqual(instance.calls, ['interrupt', 'setModel:gpt-5.6-sol', 'rotate:false']);
      assert.equal(result.runtimeChanged, false);
      assert.equal(result.threadId, 'codex-fresh');
      // The fresh session starts a new cognition epoch, like /new.
      assert.equal(store.getCognitionState().epoch, epochBefore + 1);
    } finally {
      await runtime.stop();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
      const switchResult = runtime.setModel('claude:sonnet');
      await stagedStarted;
      await runtime.stop();
      releaseStart();
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
});

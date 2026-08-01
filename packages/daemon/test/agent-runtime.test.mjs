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

  it('normalizes provider-qualified aliases without crossing opaque session ids', () => {
    assert.deepEqual(parseRuntimeModelTarget('claude:sonnet'), {
      runtime: 'claude', model: 'sonnet', canonical: 'claude:sonnet',
    });
    assert.deepEqual(parseRuntimeModelTarget('codex:gpt-5.6-sol'), {
      runtime: 'codex', model: 'gpt-5.6-sol', canonical: 'gpt-5.6-sol',
    });
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

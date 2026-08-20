import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  PI_EFFORTS,
  PiAgent,
  sanitizePiEnv,
} from '../src/pi.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const systemPromptPath = fileURLToPath(new URL('../agent/system-prompt.md', import.meta.url));

const baseConfig = {
  systemPromptPath,
  piBin: 'pi',
  piModel: 'openai/gpt-4o',
  piEffort: 'medium',
  workspace: '/tmp/lark-agent-workspace',
  projectDir: '/release',
  dataDir: '/tmp/lark-daemon-pi-data',
  databasePath: '/tmp/lark-daemon-test.sqlite3',
  profile: 'test-profile',
  larkCliBin: '/fake/lark-cli',
  sendTimeoutMs: 5_000,
  maxReplyChars: 1_000,
  cognitionMaxChars: 120_000,
  dryRun: true,
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 987_654_322;
    this.exitCode = null;
    this.writes = [];
    this.stdin = new EventEmitter();
    this.stdin.writable = true;
    this.stdin.write = (value) => { this.writes.push(value); return true; };
    this.stdin.end = () => {};
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};
  }

  feed(value) { this.stdout.emit('data', `${JSON.stringify(value)}\n`); }
  finish(code = 0, signal = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
  kill(signal = 'SIGTERM') { this.finish(signal === 'SIGKILL' ? 137 : 0, signal); }
}

const helpFlags = [
  '--mode', '--append-system-prompt', '--thinking', '--session-id', '--model', 'rpc',
].join('\n');

function parsedWrites(child) {
  return child.writes.map((line) => JSON.parse(line));
}

function makeStore({ globalOverride = {} } = {}) {
  let global = {
    sessionId: null,
    policyHash: null,
    runtime: null,
    epoch: 0,
    syncedThroughSeq: 0,
    sessionReady: false,
    ...globalOverride,
  };
  const activities = [];
  const rows = [
    {
      seq: 1, epoch: 1, kind: 'inbound', status: 'COMMITTED', atMs: 1,
      inboundSeq: 1, chatId: 'oc_old12345678', threadId: null,
      messageId: 'om_old12345678', actor: 'ou_old12345678', text: 'earlier question',
    },
    {
      seq: 2, epoch: 1, kind: 'outbound', status: 'COMMITTED', atMs: 2,
      inboundSeq: null, chatId: 'oc_old12345678', threadId: null,
      messageId: 'om_answer123456', actor: 'me', text: 'earlier answer',
    },
    {
      seq: 3, epoch: 1, kind: 'inbound', status: 'COMMITTED', atMs: 3,
      inboundSeq: 7, chatId: 'oc_now12345678', threadId: null,
      messageId: 'om_now12345678', actor: 'ou_now12345678', text: 'current request',
    },
    {
      seq: 4, epoch: 1, kind: 'inbound', status: 'COMMITTED', atMs: 4,
      inboundSeq: 8, chatId: 'oc_now12345678', threadId: null,
      messageId: 'om_fix12345678', actor: 'ou_now12345678', text: 'live correction',
    },
  ];
  return {
    activities,
    getCognitionState: () => ({ runtime: 'pi', epoch: 1, authorityToken: 'token-pi' }),
    getGlobalSession: () => global,
    setGlobalSession(sessionId, policyHash, fields) {
      global = { sessionId, policyHash, ...fields };
    },
    publishOwnedSession({ runtime, sessionId, policyHash, epoch, acceptedThroughSeq, sessionReady }) {
      global = {
        sessionId,
        policyHash,
        runtime,
        epoch,
        syncedThroughSeq: acceptedThroughSeq,
        sessionReady,
      };
      return true;
    },
    advanceOwnedSessionAcceptance({ sessionId, acceptedThroughSeq }) {
      if (global.sessionId !== sessionId) return false;
      global = {
        ...global,
        syncedThroughSeq: Math.max(global.syncedThroughSeq, acceptedThroughSeq),
      };
      return true;
    },
    markOwnedSessionUnresumable({ sessionId }) {
      if (global.sessionId !== sessionId) return false;
      global = { ...global, sessionReady: false };
      return true;
    },
    global: () => global,
    getSetting: () => null,
    setSetting() {},
    recordActivity(activity) { activities.push(activity); },
    cognitionJournal(_epoch, through, after = 0) {
      return rows.filter((row) => row.seq > after && row.seq <= through);
    },
    cognitionJournalBeforeInbound(inboundSeq) {
      const row = rows.find((item) => item.kind === 'inbound' && item.inboundSeq === inboundSeq);
      return row ? row.seq - 1 : rows.at(-1).seq;
    },
    cognitionJournalSeqForInbound(inboundSeq) {
      return rows.find((item) => item.kind === 'inbound' && item.inboundSeq === inboundSeq)?.seq ?? 0;
    },
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

function harness({ store = makeStore(), agentOptions = {} } = {}) {
  const calls = [];
  const persistent = [];
  const spawn = (_bin, args, options) => {
    const child = new FakeChild();
    calls.push({ args, child, options });
    queueMicrotask(() => {
      if (args.includes('--version')) {
        child.stdout.emit('data', '0.81.1\n');
        child.finish();
      } else if (args.includes('--help')) {
        child.stdout.emit('data', helpFlags);
        child.finish();
      } else {
        persistent.push(child);
        child.emit('spawn');
      }
    });
    return child;
  };
  const failures = [];
  const agent = new PiAgent(baseConfig, store, quietLogger, {
    spawn,
    startTimeoutMs: 100,
    startStabilityMs: 1,
    onTurnFailed: (failure) => failures.push(failure),
    ...agentOptions,
  });
  return { agent, calls, persistent, store, failures };
}

describe('PiAgent persistent rpc runtime', () => {
  it('preflights, starts pi --mode rpc, and prefixes the first real turn', async () => {
    const { agent, calls, persistent, store } = harness();
    await agent.start();

    const args = calls.at(-1).args;
    assert.equal(args[args.indexOf('--mode') + 1], 'rpc');
    assert.ok(args.includes('--mode'));
    assert.ok(args.includes('--append-system-prompt'));
    assert.equal(args[args.indexOf('--thinking') + 1], 'medium');
    assert.equal(args[args.indexOf('--model') + 1], 'openai/gpt-4o');
    assert.ok(args.includes('--session-id'));
    const env = calls.at(-1).options.env;
    assert.equal(env.LARKSUITE_CLI_PROFILE, 'test-profile');
    assert.equal(env.LARK_APP_SECRET, undefined);
    assert.equal(env.PI_LARK_TOOLS_CONFIG, undefined);
    const promptPath = args[args.indexOf('--append-system-prompt') + 1];
    const runtimePrompt = fs.readFileSync(promptPath, 'utf8');
    assert.match(runtimePrompt, /Pi delivery runtime/);
    assert.match(runtimePrompt, /\/fake\/lark-cli im \+messages-reply/);

    agent.deliver('[chat=oc_now12345678 msg=om_now12345678] current request', 7);
    const prompt = parsedWrites(persistent[0]).find((message) => message.type === 'prompt');
    assert.ok(prompt);
    assert.match(prompt.message, /daemon cognition journal/);
    assert.match(prompt.message, /earlier question/);
    assert.match(prompt.message, /earlier answer/);
    assert.match(prompt.message, /history above, new messages below/);
    assert.match(prompt.message, /current request$/);
    assert.equal(store.global().runtime, 'pi');
    await agent.stop();
  });

  it('writes steer for a second deliver during an active turn, not a second unadorned prompt', async () => {
    const { agent, persistent } = harness();
    await agent.start();
    const child = persistent[0];
    agent.deliver('first request', 7);
    agent.deliver('live correction', 8);

    const commands = parsedWrites(child).filter((message) => message.type === 'prompt' || message.type === 'steer');
    assert.equal(commands.length, 2);
    assert.equal(commands[0].type, 'prompt');
    assert.match(commands[0].message, /first request/);
    assert.equal(commands[1].type, 'steer');
    assert.equal(commands[1].message, 'live correction');
    assert.ok(!commands.some((message) => message.type === 'prompt' && message !== commands[0]));
    assert.equal(agent.turnInProgress, true);
    child.feed({ type: 'agent_settled' });
    assert.equal(agent.turnInProgress, false);
    await agent.stop();
  });

  it('demotes the stored session when stopped mid-turn, keeps it after a clean stop', async () => {
    const clean = harness();
    await clean.agent.start();
    clean.agent.deliver('quick request', 7);
    clean.persistent[0].feed({ type: 'agent_settled' });
    await clean.agent.stop();
    assert.equal(clean.store.global().sessionReady, true);

    const killed = harness();
    await killed.agent.start();
    killed.agent.deliver('long request', 7);
    await killed.agent.stop();
    assert.equal(killed.store.global().sessionReady, false);
  });

  it('keeps queued work across disconnect and writes it after respawn', async () => {
    const { agent, persistent, failures } = harness({
      agentOptions: { reconnectBaseMs: 1, reconnectCapMs: 2 },
    });
    await agent.start();
    persistent[0].finish(1);
    agent.deliver('queued after disconnect', 8);
    await waitFor(() => persistent.length === 2);
    await waitFor(() => parsedWrites(persistent[1]).some((message) => (
      message.type === 'prompt' && String(message.message).includes('queued after disconnect')
    )));
    assert.equal(failures.length, 0);
    await agent.stop();
  });

  it('interrupt emits turn-abandoned receipts and does not raise onTurnFailed', async () => {
    const abandoned = [];
    const { agent, persistent, failures } = harness({
      agentOptions: { onTurnAbandoned: (info) => abandoned.push(info) },
    });
    await agent.start();
    const child = persistent[0];
    agent.deliver('stuck request', 7);
    assert.equal(agent.turnInProgress, true);

    await agent.interruptTurn();
    assert.equal(agent.turnInProgress, false);
    assert.equal(failures.length, 0);
    assert.deepEqual(abandoned, [{ inboundSeqs: [7] }]);
    assert.ok(parsedWrites(child).some((message) => message.type === 'abort'));
    await agent.stop();
  });

  it('keeps a prepared process unpublished until session commit', async () => {
    const { agent, persistent, store } = harness();
    await agent.start();
    const previousSessionId = agent.sessionId;
    const previousGlobal = store.global();

    const prepared = await agent.prepareSessionRotation();
    assert.equal(persistent.length, 2);
    assert.notEqual(prepared.id, previousSessionId);
    assert.deepEqual(store.global(), previousGlobal);
    assert.equal(
      parsedWrites(persistent[1]).some((message) => message.type === 'prompt' || message.type === 'steer'),
      false,
    );

    assert.equal(agent.commitSessionRotation(prepared, { persist: false }), prepared.id);
    assert.deepEqual(store.global(), previousGlobal);
    await agent.stop();
  });

  it('restores model and effort before draining queued work after a cancelled prepare', async () => {
    const { agent, calls, persistent } = harness({
      agentOptions: { reconnectBaseMs: 1, reconnectCapMs: 2 },
    });
    await agent.start();
    agent.model = 'google/gemini-pro';
    agent.effort = 'max';
    agent.queue.push([{ text: 'queued during transition', seq: 7 }]);

    await agent.prepareSessionRotation({
      rollback: { model: 'openai/gpt-4o', effort: 'medium' },
    });
    assert.equal(
      parsedWrites(persistent[1]).some((message) => message.type === 'prompt'),
      false,
    );
    await agent.cancelSessionRotation();

    assert.equal(agent.model, 'openai/gpt-4o');
    assert.equal(agent.effort, 'medium');
    const persistentCalls = calls.filter(({ args }) => args.includes('--mode'));
    const restoredArgs = persistentCalls.at(-1).args;
    assert.equal(restoredArgs[restoredArgs.indexOf('--model') + 1], 'openai/gpt-4o');
    assert.equal(restoredArgs[restoredArgs.indexOf('--thinking') + 1], 'medium');
    await waitFor(() => parsedWrites(persistent[2]).some((message) => (
      message.type === 'prompt' && String(message.message).includes('queued during transition')
    )));
    persistent[2].feed({ type: 'agent_settled' });
    await agent.stop();
  });

  it('maps get_available_models onto provider/id catalog entries', async () => {
    const { agent, persistent } = harness();
    await agent.start();
    const pending = agent.listModels();
    await waitFor(() => parsedWrites(persistent[0]).some((message) => message.type === 'get_available_models'));
    const request = parsedWrites(persistent[0]).find((message) => message.type === 'get_available_models');
    persistent[0].feed({
      type: 'response',
      id: request.id,
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          { provider: 'openai', id: 'gpt-4o', reasoning: true },
          { provider: 'google', id: 'gemini-flash', reasoning: false },
        ],
      },
    });
    assert.deepEqual(await pending, [
      { id: 'openai/gpt-4o', efforts: [...PI_EFFORTS] },
      { id: 'google/gemini-flash', efforts: ['off'] },
    ]);
    await agent.stop();
  });

  it('strips Lark secrets but preserves the configured Pi model credential', () => {
    const environment = sanitizePiEnv({
      PATH: '/bin',
      OPENAI_API_KEY: 'keep-for-pi',
      LARK_APP_SECRET: 'remove',
      FEISHU_TOKEN: 'remove',
      LARKSUITE_CLI_PROFILE: 'wrong-profile',
      ARK_API_KEY: 'keep-for-pi',
      SESSION_ID: 'remove',
    }, 'fixed-profile');
    assert.equal(environment.OPENAI_API_KEY, 'keep-for-pi');
    assert.equal(environment.LARK_APP_SECRET, undefined);
    assert.equal(environment.FEISHU_TOKEN, undefined);
    assert.equal(environment.ARK_API_KEY, 'keep-for-pi');
    assert.equal(environment.SESSION_ID, undefined);
    assert.equal(environment.LARKSUITE_CLI_PROFILE, 'fixed-profile');
  });
});

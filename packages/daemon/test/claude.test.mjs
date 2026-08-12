import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ClaudeAgent, isLarkDeliveryToolName, sanitizeClaudeEnv } from '../src/claude.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const systemPromptPath = fileURLToPath(new URL('../agent/system-prompt.md', import.meta.url));

const baseConfig = {
  systemPromptPath,
  claudeBin: 'claude',
  claudeModel: 'sonnet',
  claudeEffort: 'medium',
  workspace: '/tmp/lark-agent-workspace',
  projectDir: '/release',
  databasePath: '/tmp/lark-daemon-test.sqlite3',
  profile: 'test-profile',
  larkCliBin: '/fake/lark-cli',
  larkToolServerPath: '/release/packages/daemon/src/lark-tools.mjs',
  sendTimeoutMs: 5_000,
  maxReplyChars: 1_000,
  cognitionMaxChars: 120_000,
  dryRun: true,
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 987_654_321;
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
  '--input-format', '--output-format', '--resume', '--session-id', '--mcp-config',
  '--dangerously-skip-permissions', '--disallowed-tools', '--effort',
  '--append-system-prompt', '--no-chrome', '--model', '--print',
].join('\n');

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
    getCognitionState: () => ({ runtime: 'claude', epoch: 1, authorityToken: 'token-claude' }),
    getGlobalSession: () => global,
    setGlobalSession(sessionId, policyHash, fields) {
      global = { sessionId, policyHash, ...fields };
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

function harness({ loggedIn = true, store = makeStore(), agentOptions = {} } = {}) {
  const calls = [];
  const persistent = [];
  const spawn = (_bin, args, options) => {
    const child = new FakeChild();
    calls.push({ args, child, options });
    queueMicrotask(() => {
      if (args.includes('--version')) {
        child.stdout.emit('data', '2.1.220 (Claude Code)\n');
        child.finish();
      } else if (args.includes('--help')) {
        child.stdout.emit('data', helpFlags);
        child.finish();
      } else if (args[0] === 'auth') {
        child.stdout.emit('data', JSON.stringify({ loggedIn }));
        child.finish();
      } else {
        persistent.push(child);
        child.emit('spawn');
      }
    });
    return child;
  };
  const failures = [];
  const agent = new ClaudeAgent(baseConfig, store, quietLogger, {
    spawn,
    startTimeoutMs: 100,
    startStabilityMs: 1,
    onTurnFailed: (failure) => failures.push(failure),
    ...agentOptions,
  });
  return { agent, calls, persistent, store, failures };
}

describe('ClaudeAgent persistent stream-json runtime', () => {
  it('recognises only delivery tools from the trusted Lark MCP server', () => {
    assert.equal(isLarkDeliveryToolName('mcp__lark_daemon_im__send_lark_message'), true);
    assert.equal(isLarkDeliveryToolName('lark_daemon_im__react_to_lark_message'), true);
    assert.equal(isLarkDeliveryToolName('mcp__other__send_lark_message'), false);
    assert.equal(isLarkDeliveryToolName('mcp__lark_daemon_im__view_lark_image'), false);
  });

  it('preflights, starts persistent stream-json, and prefixes the first real turn', async () => {
    const { agent, calls, persistent, store } = harness();
    await agent.start();

    assert.equal(calls.length, 4);
    const args = calls.at(-1).args;
    for (const value of ['--print', '--input-format', 'stream-json', '--output-format', '--mcp-config']) {
      assert.ok(args.includes(value));
    }
    // User-scope and plugin MCP servers must load alongside lark_daemon_im.
    assert.ok(!args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    assert.equal(args[args.indexOf('--effort') + 1], 'medium');
    assert.ok(args.includes('--session-id'));
    assert.ok(!args.includes('--resume'));
    assert.ok(calls.every((call) => call.options.env.LARKSUITE_CLI_PROFILE === 'test-profile'));

    agent.deliver('[chat=oc_now12345678 msg=om_now12345678] current request', 7);
    const first = JSON.parse(persistent[0].writes[0]);
    const body = first.message.content[0].text;
    assert.match(body, /daemon cognition journal/);
    assert.match(body, /earlier question/);
    assert.match(body, /earlier answer/);
    assert.match(body, /history above, new messages below/);
    assert.match(body, /current request$/);
    assert.doesNotMatch(body, /catch-up complete/);

    const sessionId = args[args.indexOf('--session-id') + 1];
    persistent[0].feed({ type: 'system', subtype: 'init', session_id: sessionId });
    assert.equal(store.global().sessionReady, true);
    assert.equal(store.global().syncedThroughSeq, 0);
    persistent[0].feed({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'telemetry, not a Lark delivery' }] },
    });
    persistent[0].feed({ type: 'result', subtype: 'success', result: 'telemetry only' });
    assert.equal(agent.turnInProgress, false);
    assert.equal(store.global().syncedThroughSeq, 3);
    assert.ok(store.activities.some((activity) => activity.metadata?.delivery === 'telemetry_only'));
    await agent.stop();
  });

  it('writes a live correction into the active Claude turn and commits one cursor', async () => {
    const { agent, persistent, store } = harness();
    await agent.start();
    const child = persistent[0];
    agent.deliver('first request', 7);
    child.feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });
    agent.deliver('live correction', 8);

    assert.equal(child.writes.length, 2);
    assert.equal(JSON.parse(child.writes[1]).message.content[0].text, 'live correction');
    assert.equal(agent.turnInProgress, true);
    child.feed({ type: 'result', subtype: 'success', result: 'corrected' });
    assert.equal(agent.turnInProgress, false);
    assert.equal(store.global().syncedThroughSeq, 4);
    await agent.stop();
  });

  it('returns active receipt-only items and preserves the legacy success shape otherwise', async () => {
    const successes = [];
    const { agent, persistent } = harness({
      agentOptions: { onTurnSucceeded: (info) => successes.push(info) },
    });
    await agent.start();
    const child = persistent[0];

    agent.deliver('first audio segment', null, 'receipt-1');
    agent.deliverBatch([{ text: 'second audio segment', receiptId: 'receipt-2' }]);
    child.feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });
    child.feed({ type: 'result', subtype: 'success', result: 'handled' });

    agent.deliver('normal inbound', 7);
    child.feed({ type: 'result', subtype: 'success', result: 'handled' });
    assert.deepEqual(successes, [
      { inboundSeqs: [], receiptIds: ['receipt-1', 'receipt-2'] },
      { inboundSeqs: [7] },
    ]);
    await agent.stop();
  });

  it('surfaces a receipt when prompt preparation fails before Claude owns the turn', async () => {
    const store = makeStore();
    store.cognitionJournalBeforeInbound = () => 1;
    store.cognitionJournal = () => [{
      seq: 1,
      epoch: 1,
      kind: 'control',
      status: 'COMMITTED',
      atMs: 1,
      text: 'x'.repeat(130_000),
    }];
    const { agent, persistent, failures } = harness({ store });
    await agent.start();

    agent.deliver('will not be written', null, 'receipt-terminal');
    assert.equal(persistent[0].writes.length, 0);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].inboundSeqs, []);
    assert.deepEqual(failures[0].receiptIds, ['receipt-terminal']);
    assert.match(failures[0].error, /above the 120000-char handoff limit/);
    await agent.stop();
  });

  it('reports an is_error result with subtype success as a turn failure', async () => {
    const { agent, persistent, failures } = harness();
    await agent.start();
    const child = persistent[0];
    agent.deliver('please answer', 7);
    child.feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });
    child.feed({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "You've hit your session limit · resets 5:30pm (UTC)",
    });
    assert.equal(agent.turnInProgress, false);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].inboundSeqs, [7]);
    assert.match(failures[0].error, /session limit/);
    await agent.stop();
  });

  it('still completes a turn when a tool result carried is_error but the run succeeded', async () => {
    const { agent, persistent, failures } = harness();
    await agent.start();
    const child = persistent[0];
    agent.deliver('please answer', 7);
    child.feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });
    child.feed({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    assert.equal(agent.turnInProgress, false);
    assert.equal(failures.length, 0);
    await agent.stop();
  });

  it('notifies the outer lifecycle when a Lark delivery tool succeeds', async () => {
    const deliveries = [];
    const { agent, persistent } = harness({
      agentOptions: { onDeliverySucceeded: (delivery) => deliveries.push(delivery) },
    });
    await agent.start();
    const child = persistent[0];
    agent.deliver('please react', 7);
    child.feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });
    child.feed({
      type: 'assistant',
      message: { content: [{
        type: 'tool_use',
        id: 'tool-delivery-1',
        name: 'mcp__lark_daemon_im__react_to_lark_message',
        input: {},
      }] },
    });
    child.feed({
      type: 'user',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'tool-delivery-1',
        is_error: false,
        content: 'ok',
      }] },
    });
    assert.deepEqual(deliveries, [{ inboundSeqs: [7], mode: 'lark' }]);
    child.feed({ type: 'result', subtype: 'success', result: 'done' });
    await agent.stop();
  });

  it('interruptTurn kills the in-flight turn and keeps queued messages for the next session', async () => {
    const abandoned = [];
    const successes = [];
    const { agent, persistent, failures } = harness({
      agentOptions: {
        onTurnAbandoned: (info) => abandoned.push(info),
        onTurnSucceeded: (info) => successes.push(info),
      },
    });
    await agent.start();
    const child = persistent[0];
    agent.deliver('stuck request', 7);
    child.feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });
    assert.equal(agent.turnInProgress, true);

    await agent.interruptTurn();
    assert.equal(agent.turnInProgress, false);
    assert.equal(failures.length, 0); // intentional abandonment is not a failure
    assert.deepEqual(abandoned, [{ inboundSeqs: [7] }]);

    agent.deliver('queued while switching', 8, 'receipt-queued'); // disconnected: queued, not lost
    const rotated = agent.rotateSession({ resume: false });
    await waitFor(() => persistent.length === 2);
    await rotated;
    await waitFor(() => persistent[1].writes.length > 0);
    const bodies = persistent[1].writes.map((line) => JSON.parse(line).message.content[0].text);
    assert.ok(bodies.some((text) => text.includes('queued while switching')));
    persistent[1].feed({ type: 'result', subtype: 'success', result: 'handled' });
    assert.deepEqual(successes, [{
      inboundSeqs: [8],
      receiptIds: ['receipt-queued'],
    }]);
    await agent.stop();
  });

  it('returns receipt-only active work through the interruption callback', async () => {
    const abandoned = [];
    const { agent, persistent } = harness({
      agentOptions: { onTurnAbandoned: (info) => abandoned.push(info) },
    });
    await agent.start();
    agent.deliver('stuck audio segment', null, 'receipt-abandoned');
    persistent[0].feed({ type: 'system', subtype: 'init', session_id: agent.sessionId });

    await agent.interruptTurn();
    assert.deepEqual(abandoned, [{
      inboundSeqs: [],
      receiptIds: ['receipt-abandoned'],
    }]);
    await agent.stop();
  });

  it('does not resume a preassigned session that never created a Claude transcript', async () => {
    const store = makeStore({
      globalOverride: {
        sessionId: '00000000-0000-4000-8000-000000000001',
        policyHash: 'stale-policy',
        runtime: 'claude',
        epoch: 1,
        syncedThroughSeq: 0,
        sessionReady: false,
      },
    });
    const { agent, calls } = harness({ store });
    store.global().policyHash = agent.policyHash;
    await agent.start();
    const args = calls.at(-1).args;
    assert.ok(args.includes('--session-id'));
    assert.ok(!args.includes('--resume'));
    assert.notEqual(agent.sessionId, '00000000-0000-4000-8000-000000000001');
    await agent.stop();
  });

  it('uses a fresh preassigned UUID after a pre-init process crash', async () => {
    const { agent, calls, persistent } = harness({
      agentOptions: { reconnectBaseMs: 1, reconnectCapMs: 2 },
    });
    await agent.start();
    const firstArgs = calls.at(-1).args;
    const firstSessionId = firstArgs[firstArgs.indexOf('--session-id') + 1];

    persistent[0].finish(1);
    await waitFor(() => persistent.length === 2);
    const reconnectArgs = calls.at(-1).args;
    const reconnectSessionId = reconnectArgs[reconnectArgs.indexOf('--session-id') + 1];
    assert.ok(reconnectArgs.includes('--session-id'));
    assert.ok(!reconnectArgs.includes('--resume'));
    assert.notEqual(reconnectSessionId, firstSessionId);
    await agent.stop();
  });

  it('fails closed when Claude auth is unavailable', async () => {
    const { agent, calls } = harness({ loggedIn: false });
    await assert.rejects(() => agent.start(), /not logged in/);
    assert.equal(calls.length, 3);
  });

  it('strips Lark secrets and the nested Claude marker from the child env', () => {
    const environment = sanitizeClaudeEnv({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'keep-for-claude',
      LARK_APP_SECRET: 'remove',
      FEISHU_TOKEN: 'remove',
      LARKSUITE_CLI_PROFILE: 'wrong-profile',
      CLAUDECODE: 'remove',
    }, 'fixed-profile');
    assert.equal(environment.ANTHROPIC_API_KEY, 'keep-for-claude');
    assert.equal(environment.LARK_APP_SECRET, undefined);
    assert.equal(environment.FEISHU_TOKEN, undefined);
    assert.equal(environment.CLAUDECODE, undefined);
    assert.equal(environment.LARKSUITE_CLI_PROFILE, 'fixed-profile');
  });
});

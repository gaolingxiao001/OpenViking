import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ActionService } from '../src/actions/service.mjs';
import { startActionApi, stopActionApi } from '../src/actions/api.mjs';
import { createMcpHandler } from '../src/actions/mcp.mjs';
import { Store } from '../src/store.mjs';
import { chatEvent } from './event-fixture.mjs';
import { fakeConnectors } from './action-fixture.mjs';

const TOKEN = 'runtime-token';
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const cliPath = fileURLToPath(new URL('../src/actions/cli.mjs', import.meta.url));

function setup(t, { ids = ['lark'], run = null, roster = null, liveness = null, meetingEnabled = false, ovClient = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'actions-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const store = new Store(path.join(directory, 'state.sqlite3'), logger);
  store.initializeCognition('codex', TOKEN);
  const connectors = fakeConnectors({ ids, run });
  const logs = [];
  const record = (level) => (message, fields = {}) => logs.push({ level, message, ...fields });
  const service = new ActionService({
    config: { workspace, tempDir: path.join(directory, 'tmp'), maxReplyChars: 1_000 },
    store, connectors, roster, liveness, meetingEnabled, ovClient,
    logger: { debug() {}, info: record('info'), warn: record('warn'), error: record('error'), child() { return this; } },
  });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (tool, input, authority = TOKEN) => service.call(tool, input, { authority });
  const inbound = (fields) => store.ingest(chatEvent({ chatType: 'group', ...fields })).inbound;
  return { directory, workspace, store, connectors, service, call, inbound, logs };
}

describe('agent tools', () => {
  it('offers only the tools some configured connector supports', (t) => {
    const names = (service) => service.tools().map((tool) => tool.name);
    const lark = setup(t, { meetingEnabled: true });
    assert.ok(names(lark.service).includes('react_to_message'));
    assert.ok(names(lark.service).includes('list_chats'));
    assert.ok(names(lark.service).includes('read_meeting_inbox'));
    const weixin = setup(t, { ids: ['weixin'] });
    assert.deepEqual(names(weixin.service), [
      'send_message', 'reply_message', 'get_message_media', 'read_openviking_session_context',
    ]);
  });

  it('validates input against the tool schema before any connector call', async (t) => {
    const { call, connectors, inbound } = setup(t);
    inbound({ messageId: 'om_a' });
    await assert.rejects(() => call('send_message', { chat_id: 'oc_chat12345678', text: 'legacy', decision_message_id: 'om_a' }), /unknown field: text/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_chat12345678', markdown: 'x' }), /decision_message_id is required/);
    await assert.rejects(() => call('react_to_message', { message_id: 'om_a', emoji_type: '1bad', decision_message_id: 'om_a' }), /emoji_type has an invalid format/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_chat12345678', decision_message_id: 'om_a' }), /message body is required/);
    await assert.rejects(() => call('no_such_tool', {}), /unknown tool/);
    assert.equal(connectors.calls.length, 0);
  });

  it('fences a retired runtime out of reads and writes', async (t) => {
    const { store, call, connectors, inbound } = setup(t);
    inbound({ messageId: 'om_decision123456' });
    store.initializeCognition('claude', 'new-owner');
    await assert.rejects(() => call('list_chats', {}), /no longer owns/);
    await assert.rejects(() => call('send_message', {
      chat_id: 'oc-chat', markdown: 'late', decision_message_id: 'om_decision123456',
    }), /no longer owns/);
    assert.equal(connectors.calls.length, 0);
  });

  it('separates response attribution from the latest freshness fence', async (t) => {
    const { store, call, connectors, inbound, logs } = setup(t);
    const older = inbound({ messageId: 'om_olderDecision1', chatId: 'oc_steer12345678' });
    const olderTwo = inbound({ messageId: 'om_otherOlder1234', chatId: 'oc_steer12345678' });
    const latest = inbound({ messageId: 'om_latestDecision', chatId: 'oc_steer12345678' });
    inbound({ messageId: 'om_otherScope1234', chatId: 'oc_other12345678' });

    await call('send_message', { chat_id: 'oc_steer12345678', markdown: 'fast answer B', decision_message_id: 'om_latestDecision' });
    await call('send_message', { chat_id: 'oc_steer12345678', markdown: 'finished answer A',
      decision_message_id: 'om_latestDecision', response_to_message_id: 'om_olderDecision1' });
    await call('reply_message', { message_id: 'om_otherOlder1234', markdown: 'answer A2', decision_message_id: 'om_latestDecision' });
    assert.deepEqual(
      store.db.prepare('SELECT inbound_seq FROM outbox ORDER BY id').all().map((row) => row.inbound_seq),
      [latest.seq, older.seq, olderTwo.seq],
    );

    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'cross scope',
      decision_message_id: 'om_latestDecision', response_to_message_id: 'om_otherScope1234' }), /same chat\/thread and no newer/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'future',
      decision_message_id: 'om_olderDecision1', response_to_message_id: 'om_latestDecision' }), /newer authenticated message/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'stale',
      decision_message_id: 'om_olderDecision1' }), /newer authenticated message/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_steer12345678', markdown: 'unknown',
      decision_message_id: 'om_neverReceived1' }), /not an accepted daemon-authenticated inbound/);
    assert.equal(connectors.calls.length, 3, 'invalid attribution and stale fences stop before the connector');

    // Each call leaves one agent_tool line; refusals carry the seqs that explain them.
    const lines = logs.filter((line) => line.message === 'agent_tool');
    assert.deepEqual(lines.slice(0, 3).map((line) => [line.outcome, line.decisionSeq, line.responseSeq]),
      [['ok', latest.seq, latest.seq], ['ok', latest.seq, older.seq], ['ok', latest.seq, olderTwo.seq]]);
    assert.ok(lines.slice(0, 3).every((line) => line.outboxId && line.attempt === 1 && line.connector === 'lark'));
    assert.deepEqual(lines.slice(3).map((line) => [line.outcome, line.code, line.decisionSeq ?? null, line.newerSeq ?? null]), [
      ['blocked', 'attribution_rejected', latest.seq, null],
      ['blocked', 'stale_decision', older.seq, latest.seq],
      ['blocked', 'stale_decision', older.seq, latest.seq],
      ['blocked', 'unknown_decision', null, null],
    ]);
    assert.doesNotMatch(JSON.stringify(logs), /oc_steer|om_latest|fast answer/);
    const blockedRows = store.db.prepare("SELECT inbound_seq, detail_json FROM activities WHERE kind = 'delivery.blocked' ORDER BY id").all();
    assert.equal(blockedRows.length, 4);
    assert.deepEqual(JSON.parse(blockedRows[1].detail_json), {
      tool: 'send_message', code: 'stale_decision', connector: 'lark', via: null, runtime: 'codex',
      decisionSeq: older.seq, newerSeq: latest.seq,
    });
  });

  it('reserves every delivery in the outbox and journal; a repeat returns the earlier result', async (t) => {
    const { store, call, connectors, inbound } = setup(t);
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const input = { chat_id: 'oc_chat12345678', markdown: 'hello', decision_message_id: 'om_decision123456' };
    const first = await call('send_message', input);
    assert.match(first.text, /^Delivered message to chat_id=oc_chat12345678\. message_id=om_delivered123456/);
    const [{ connector, action, input: sent }] = connectors.calls;
    assert.deepEqual([connector, action], ['lark', 'message.send']);
    assert.deepEqual(sent.content, { type: 'markdown', text: 'hello' });
    assert.match(sent.idempotency_key, /^ld_[a-f0-9]{40}$/);

    const row = store.db.prepare('SELECT * FROM outbox').get();
    assert.deepEqual([row.status, row.caller, row.remote_message_id], ['SENT', 'agent', 'om_delivered123456']);
    const journal = store.db.prepare("SELECT * FROM cognition_journal WHERE kind = 'outbound'").get();
    assert.deepEqual([journal.status, journal.message_id, journal.chat_id, journal.runtime_token, journal.text],
      ['COMMITTED', 'om_delivered123456', 'oc_chat12345678', TOKEN, 'hello']);
    assert.deepEqual(store.db.prepare("SELECT kind FROM activities WHERE outbox_id = ? ORDER BY id").all(row.id)
      .map((item) => item.kind), ['delivery.queued', 'delivery.sent']);

    const repeat = await call('send_message', input);
    assert.equal(repeat.data.duplicate, true);
    assert.match(repeat.text, /Already delivered/);
    assert.equal(connectors.calls.length, 1);

    await call('send_message', { ...input, idempotency_key: 'intentional-second' });
    assert.equal(connectors.calls.length, 2);
    assert.notEqual(connectors.calls[1].input.idempotency_key, sent.idempotency_key);
  });

  it('retries an uncertain action only where the provider honours the idempotency key', async (t) => {
    let fail = true;
    const run = (_connector, action) => {
      if (fail) throw new Error('timed out');
      return action === 'message.react' ? { reaction_id: 'r1' } : { message_id: 'om_delivered123456' };
    };
    const { store, call, connectors, inbound } = setup(t, { ids: ['lark', 'weixin'], run });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    inbound({ source: 'weixin', messageId: 'wx_peer_1', chatId: 'peer@im.wechat', chatType: 'p2p' });
    const send = { chat_id: 'oc_chat12345678', markdown: 'once', decision_message_id: 'om_decision123456' };
    const react = { message_id: 'om_decision123456', emoji_type: 'OK', decision_message_id: 'om_decision123456' };
    const weixin = { message_id: 'wx_peer_1', markdown: 'hi', decision_message_id: 'wx_peer_1' };
    for (const [tool, input] of [['send_message', send], ['react_to_message', react], ['reply_message', weixin]]) {
      await assert.rejects(() => call(tool, input), /timed out/);
    }
    assert.deepEqual(store.stats().outbox, { UNCERTAIN: 3 });
    assert.equal(store.cognitionJournal().filter((item) => item.status === 'UNCERTAIN').length, 3);

    fail = false;
    const retried = await call('send_message', send);
    assert.equal(retried.data.message_id, 'om_delivered123456');
    assert.equal(connectors.calls[3].input.idempotency_key, connectors.calls[0].input.idempotency_key);
    assert.equal(store.db.prepare("SELECT attempt_count FROM outbox WHERE action = 'message.send'").get().attempt_count, 2);
    await assert.rejects(() => call('react_to_message', react), /outcome is uncertain/);
    await assert.rejects(() => call('reply_message', weixin), /outcome is uncertain/);
    assert.equal(connectors.calls.length, 4);
  });

  it('routes by a known target id, an explicit source, or the only capable connector', async (t) => {
    const { call, connectors, inbound } = setup(t, { ids: ['lark', 'weixin'],
      run: (_connector, action) => (action === 'chat.list' ? { chats: [], has_more: false } : { message_id: 'om_delivered123456' }) });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    inbound({ source: 'weixin', messageId: 'wx_peer_1', chatId: 'peer@im.wechat', chatType: 'p2p' });

    await call('reply_message', { message_id: 'wx_peer_1', markdown: 'hi', decision_message_id: 'wx_peer_1' });
    await call('reply_message', { message_id: 'om_decision123456', markdown: 'hi', decision_message_id: 'om_decision123456' });
    await call('list_chats', {});
    assert.deepEqual(connectors.calls.map((item) => [item.connector, item.action]), [
      ['weixin', 'message.reply'], ['lark', 'message.reply'], ['lark', 'chat.list'],
    ]);

    await assert.rejects(() => call('react_to_message', { message_id: 'wx_peer_1', emoji_type: 'OK', decision_message_id: 'wx_peer_1' }),
      /weixin does not support message.react/);
    await assert.rejects(() => call('send_message', { chat_id: 'oc_neverSeen1234', markdown: 'x', decision_message_id: 'om_decision123456' }),
      /pass source \(one of: lark, weixin\)/);
    await call('send_message', { source: 'lark', chat_id: 'oc_neverSeen1234', markdown: 'x', decision_message_id: 'om_decision123456' });
    assert.equal(connectors.calls.at(-1).connector, 'lark');
  });

  it('checks message content against the connector manifest', async (t) => {
    const { call, connectors, inbound } = setup(t, { ids: ['weixin'] });
    inbound({ source: 'weixin', messageId: 'wx_peer_1', chatId: 'peer@im.wechat', chatType: 'p2p' });
    const base = { message_id: 'wx_peer_1', decision_message_id: 'wx_peer_1' };
    await assert.rejects(() => call('reply_message', { ...base, card: { elements: [] } }), /weixin cannot send card messages/);
    await assert.rejects(() => call('reply_message', { ...base, markdown: 'x', mention_user_ids: ['ou_someone12345'] }),
      /mentions are not supported/);
    await assert.rejects(() => call('reply_message', { ...base, markdown: 'x', reply_in_thread: true }), /does not support thread replies/);
    assert.equal(connectors.calls.length, 0);
  });

  it('freezes a workspace file for the upload and removes the snapshot afterwards', async (t) => {
    let seen;
    const { call, workspace, directory, inbound } = setup(t, { run: (_connector, _action, input) => {
      seen = { ...input.content, bytes: fs.readFileSync(input.content.path, 'utf8') };
      return { message_id: 'om_delivered123456' };
    } });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    fs.writeFileSync(path.join(workspace, 'chart.png'), 'png bytes');
    await call('send_message', { chat_id: 'oc_chat12345678', file_path: 'chart.png', decision_message_id: 'om_decision123456' });
    assert.equal(seen.type, 'file');
    assert.equal(seen.name, 'chart.png');
    assert.equal(seen.bytes, 'png bytes');
    assert.ok(seen.path.startsWith(path.join(directory, 'tmp', 'outbox')));
    assert.equal(fs.existsSync(seen.path), false);
  });

  it('resolves mention names through the roster of the target chat', async (t) => {
    const lookups = [];
    const roster = { async resolveNames(chatId, names) {
      lookups.push(chatId);
      return names.map((name) => ({ name, id: 'ou_alice12345678' }));
    } };
    const { call, connectors, inbound } = setup(t, { roster });
    inbound({ messageId: 'om_target12345678', chatId: 'oc_decision123456' });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_decision123456' });
    await call('reply_message', { message_id: 'om_target12345678', markdown: '@Alice please check',
      mention_names: ['Alice'], mention_user_ids: ['ou_bob1234567890'], decision_message_id: 'om_decision123456' });
    assert.deepEqual(lookups, ['oc_decision123456']);
    assert.deepEqual(connectors.calls[0].input.content.mentions, [
      { id: 'ou_bob1234567890' }, { name: 'Alice', id: 'ou_alice12345678' },
    ]);
  });

  it('re-checks freshness and authority after an awaited mention lookup', async (t) => {
    let finishLookup = null;
    const roster = { resolveNames: (_chatId, names) => new Promise((resolve) => {
      finishLookup = () => resolve(names.map((name) => ({ name, id: 'ou_alice12345678' })));
    }) };
    const { store, call, connectors, inbound } = setup(t, { roster });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });

    const stale = call('send_message', { chat_id: 'oc_chat12345678', markdown: '@Alice hi',
      mention_names: ['Alice'], decision_message_id: 'om_decision123456' });
    inbound({ messageId: 'om_newer123456789', chatId: 'oc_chat12345678' });
    finishLookup();
    await assert.rejects(stale, (error) => error.code === 'stale_decision');

    const revoked = call('reply_message', { message_id: 'om_newer123456789', markdown: '@Alice hi',
      mention_names: ['Alice'], decision_message_id: 'om_newer123456789' });
    store.initializeCognition('claude', 'new-owner');
    finishLookup();
    await assert.rejects(revoked, (error) => error.code === 'authority_revoked');

    assert.equal(connectors.calls.length, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  });

  it('keeps one temporary working reaction per conversation and clears it on the next final delivery there', async (t) => {
    let reactions = 0;
    const run = (_connector, action) => {
      if (action === 'message.react') return { reaction_id: `reaction_${reactions += 1}` };
      if (action === 'message.reaction.delete') return { deleted: true };
      return { message_id: 'om_delivered123456' };
    };
    const { store, service, call, connectors, inbound } = setup(t, { run });
    inbound({ messageId: 'om_scopeA12345678', chatId: 'oc_scopeA12345678' });
    inbound({ messageId: 'om_scopeB12345678', chatId: 'oc_scopeB12345678' });
    await call('react_to_message', { message_id: 'om_scopeA12345678', emoji_type: 'OnIt', temporary: true, decision_message_id: 'om_scopeA12345678' });
    assert.equal(service.temporaryReactions.size, 1);

    await call('send_message', { chat_id: 'oc_scopeB12345678', markdown: 'other scope', decision_message_id: 'om_scopeB12345678' });
    assert.equal(service.temporaryReactions.size, 1, 'a delivery elsewhere must not clear it');

    await call('react_to_message', { message_id: 'om_scopeA12345678', emoji_type: 'OK', decision_message_id: 'om_scopeA12345678' });
    assert.equal(service.temporaryReactions.size, 0);
    const deletion = connectors.calls.find((item) => item.action === 'message.reaction.delete');
    assert.deepEqual(deletion.input, { message_id: 'om_scopeA12345678', reaction_id: 'reaction_1' });
    assert.deepEqual(store.cognitionJournal().filter((item) => item.kind === 'outbound').map((item) => item.text),
      ['other scope', '[reaction OK]'], 'the cleared working reaction leaves the observable history');

    await assert.rejects(() => call('react_to_message', { message_id: 'om_scopeA12345678', emoji_type: 'OK', temporary: true,
      decision_message_id: 'om_scopeA12345678' }), /must use the OnIt emoji/);
  });

  it('never reports a final delivery as failed because working reaction cleanup failed', async (t) => {
    const run = (_connector, action) => {
      if (action === 'message.reaction.delete') throw new Error('cleanup failed');
      return action === 'message.react' ? { reaction_id: 'reaction_cleanup' } : { message_id: 'om_delivered123456' };
    };
    const { service, call, inbound } = setup(t, { run });
    inbound({ messageId: 'om_cleanup1234567', chatId: 'oc_cleanup1234567' });
    await call('react_to_message', { message_id: 'om_cleanup1234567', emoji_type: 'OnIt', temporary: true, decision_message_id: 'om_cleanup1234567' });
    const sent = await call('send_message', { chat_id: 'oc_cleanup1234567', markdown: 'finished', decision_message_id: 'om_cleanup1234567' });
    assert.equal(sent.data.message_id, 'om_delivered123456');
    assert.equal(service.temporaryReactions.size, 0);
  });

  it('touches idle liveness after every successful delivery, including daemon replies', async (t) => {
    let touches = 0;
    const { service, call, inbound } = setup(t, { liveness: { touch() { touches += 1; } } });
    const event = inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    await call('react_to_message', { message_id: 'om_decision123456', emoji_type: 'OK', decision_message_id: 'om_decision123456' });
    await service.replyToEvent(event, 'notice', 'failure-notice');
    assert.equal(touches, 2);
  });

  it('replies to an event on its own route once per purpose', async (t) => {
    const { store, service, connectors, inbound } = setup(t);
    const event = inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    assert.deepEqual(await service.replyToEvent(event, 'first notice', 'failure-notice'), { ok: true });
    assert.deepEqual(await service.replyToEvent(event, 'second notice', 'failure-notice'), { ok: true });
    await service.replyToEvent(event, 'command reply', 'command-reply');
    assert.equal(connectors.calls.length, 2);
    assert.deepEqual(connectors.calls[0].input.content, { type: 'markdown', text: 'first notice' });
    assert.equal(connectors.calls[0].input.message_id, 'om_decision123456');
    assert.deepEqual(store.db.prepare('SELECT DISTINCT caller FROM outbox').all().map((row) => row.caller), ['daemon']);
    assert.deepEqual(await service.replyToEvent(chatEvent({ replyRoute: null }), 'x', 'p'), { ok: false, stage: 'no-target' });
  });

  it('does not reserve or invoke anything in dry-run mode', async (t) => {
    const { store, service, call, connectors, inbound } = setup(t);
    service.config.dryRun = true;
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const result = await call('send_message', { chat_id: 'oc_chat12345678', markdown: 'x', decision_message_id: 'om_decision123456' });
    assert.match(result.text, /Dry run only/);
    assert.equal(connectors.calls.length, 0);
    assert.deepEqual(store.stats().outbox, {});
  });

  it('reads and acknowledges the durable meeting inbox', async (t) => {
    const { store, call } = setup(t, { meetingEnabled: true });
    store.ensureMeetingSession('734000000000000123');
    store.ingestMeetingEvent({
      eventKey: 'meeting:test-transcript', meetingId: '734000000000000123',
      eventType: 'vc.bot.meeting_activity_v1', activityType: 'transcript_received', occurredAtMs: 1_723_300_000_000,
      payload: { transcript_received_items: [{ speaker: { user_name: 'Alice' }, text: '请把结论发到群里', sentence_id: 's-1' }] },
    });
    store.commitMeetingInboxBatch('734000000000000123', store.pendingMeetingEvents('734000000000000123'), 1_723_300_000_001);
    const first = await call('read_meeting_inbox', { limit: 10 });
    assert.match(first.text, /Read and acknowledged 1 meeting messages; remaining=0/);
    assert.match(first.text, /请把结论发到群里/);
    assert.match((await call('read_meeting_inbox', {})).text, /Meeting inbox is empty/);
  });

  it('pages OV session context consistently and fences authority after the remote read', async (t) => {
    let value = 'abcdef';
    const ovClient = { async context() { return { overview: value }; } };
    const { store, call } = setup(t, { ovClient });
    const { epoch } = store.getCognitionState();
    store.db.exec('CREATE TABLE IF NOT EXISTS ov_session_sync(epoch INTEGER PRIMARY KEY, session_id TEXT, uri TEXT)');
    store.db.prepare('INSERT INTO ov_session_sync(epoch, session_id, uri) VALUES (?, ?, ?)').run(epoch, 'test-session', 'viking://session/test');
    const first = (await call('read_openviking_session_context', { epoch, max_chars: 4 })).data;
    const next = (await call('read_openviking_session_context', { epoch, offset: first.next_offset, expected_digest: first.expected_digest })).data;
    assert.equal(first.text + next.text, JSON.stringify({ overview: value }));
    await assert.rejects(() => call('read_openviking_session_context', { epoch, offset: 4 }), /requires expected_digest/);
    value = 'changed';
    await assert.rejects(() => call('read_openviking_session_context', { epoch, offset: 4, expected_digest: first.expected_digest }), /result changed/);
    ovClient.context = async () => {
      store.initializeCognition('claude', 'new-owner');
      return { overview: 'must not escape' };
    };
    await assert.rejects(() => call('read_openviking_session_context', { epoch }), /no longer owns/);
  });
});

describe('agent tool front-ends', () => {
  async function serve(t, options) {
    const state = setup(t, options);
    const socketPath = path.join(state.directory, 'actions.sock');
    const server = await startActionApi({ socketPath, service: state.service, logger });
    t.after(() => stopActionApi(server));
    assert.equal(fs.statSync(socketPath).mode & 0o077, 0);
    return { ...state, socketPath };
  }

  it('relays tools/list and tools/call from the MCP adapter, with images inline', async (t) => {
    const { directory, socketPath, inbound } = await serve(t, { run: (_connector, action) => {
      if (action !== 'message.media') return { message_id: 'om_delivered123456' };
      const file = path.join(directory, 'img.png');
      fs.writeFileSync(file, 'png');
      return { media: [{ path: file, name: 'img.png', kind: 'image', mime_type: 'image/png', size: 3 }] };
    } });
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const handle = createMcpHandler({ socketPath, authority: TOKEN, client: 'mcp' });

    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(listed.result.tools.some((tool) => tool.name === 'send_message' && tool.inputSchema.properties.chat_id));
    assert.ok(listed.result.tools.every((tool) => !('action' in tool)));

    const sent = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message',
      arguments: { chat_id: 'oc_chat12345678', markdown: 'hi', decision_message_id: 'om_decision123456' } } });
    assert.match(sent.result.content[0].text, /Delivered message/);
    assert.equal(sent.result.structuredContent.message_id, 'om_delivered123456');

    const media = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_message_media',
      arguments: { message_id: 'om_decision123456', key: 'img_abcdefgh1234' } } });
    assert.deepEqual(media.result.content[1], { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });

    const stale = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_message',
      arguments: { chat_id: 'oc_chat12345678', markdown: 'hi', decision_message_id: 'om_unknown123456' } } });
    assert.equal(stale.result.isError, true);
    assert.match(stale.result.content[0].text, /not an accepted daemon-authenticated inbound/);

    const retired = createMcpHandler({ socketPath, authority: 'retired', client: 'mcp' });
    const fenced = await retired({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_chats', arguments: {} } });
    assert.match(fenced.result.content[0].text, /no longer owns/);
  });

  it('serves the same tools to the CLI with the runtime environment', async (t) => {
    const { socketPath, inbound, connectors, logs } = await serve(t);
    inbound({ messageId: 'om_decision123456', chatId: 'oc_chat12345678' });
    const env = { ...process.env, PERSONAL_AGENT_SOCKET: socketPath, PERSONAL_AGENT_AUTHORITY: TOKEN };
    const run = (args, input) => new Promise((resolve) => {
      // spawnSync would block the event loop the in-process socket server needs.
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, [cliPath, ...args], { env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input ?? '');
      });
    });

    const sent = await run(['reply_message'], JSON.stringify({
      message_id: 'om_decision123456', markdown: 'it\'s "quoted"\nand multi-line', decision_message_id: 'om_decision123456',
    }));
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /^Delivered reply to message_id=om_decision123456/);
    assert.equal(connectors.calls[0].input.content.text, 'it\'s "quoted"\nand multi-line');
    assert.equal(logs.find((line) => line.message === 'agent_tool').via, 'cli');

    const failed = await run(['send_message', '{"chat_id":"oc_chat12345678","markdown":"x","decision_message_id":"om_missing12345"}']);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /not an accepted daemon-authenticated inbound/);

    const listed = await run(['--list']);
    assert.match(listed.stdout, /^send_message: /m);
  });

  it('refuses to run outside a daemon runtime', () => {
    const result = spawnSync(process.execPath, [cliPath, 'list_chats', '{}'], {
      env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PERSONAL_AGENT_SOCKET is not set/);
  });
});

it('finds decisions and reply targets by message id through an index', (t) => {
  const { store } = setup(t);
  const plans = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    if (/FROM connector_events WHERE message_id = \?/.test(sql)) plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join(' '));
    return prepare(sql);
  };
  // An id that is not an inbound (a reply to the bot's own message) used to
  // scan the whole event history before falling through to the outbox.
  store.eventByMessageId('om_unknown12345678');
  store.connectorForMessage('om_unknown12345678');
  assert.equal(plans.length, 2);
  for (const plan of plans) assert.match(plan, /USING INDEX connector_events_message_seq/);
});

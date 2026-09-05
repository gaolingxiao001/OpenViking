// Shared mock environment for harness e2e tests: a real LarkDaemon wired to a
// fake lark-cli (events fed dynamically through an NDJSON file) and a fake
// codex app-server (scriptable turn outcome, records everything it is told).
// OpenViking is quiet by default; pass { identity } to serve a fake identity
// through a PATH-shimmed `ov` binary. No process.env mutation otherwise: every
// path the fake binaries need is embedded into the generated scripts.
//
// Operations, not plumbing:
//   const env = await startMockEnv();
//   env.receive(textMessage({ messageId: 'om-1', text: 'hi' }));
//   await env.waitForCodexInput(/om-1/);
//   env.replies(); env.codexInput(); env.codexSpawnArgs();
//   await env.stop();

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, projectDir } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { LarkDaemon } from '../src/daemon.mjs';

// Raw Lark im.message.receive_v1 envelope with test defaults. Every field the
// normalizer reads can be overridden; `text` becomes the JSON content body.
export function textMessage({
  messageId,
  text,
  chatId = 'oc-e2e',
  chatType = 'p2p',
  senderId = 'ou-e2e',
  threadId = null,
  parentId = null,
  rootId = null,
  mentions = null,
  createTimeMs = Date.now(),
  eventId = `evt-${messageId}`,
}) {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'im.message.receive_v1',
      tenant_key: 'tenant-e2e',
      create_time: String(createTimeMs),
    },
    event: {
      sender: { sender_id: { open_id: senderId }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: chatType,
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: String(createTimeMs),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(parentId ? { parent_id: parentId } : {}),
        ...(rootId ? { root_id: rootId } : {}),
        ...(mentions ? { mentions } : {}),
      },
    },
  };
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
}

// Fake lark-cli: --version/--help/doctor answer preflight; `event +subscribe`
// tails EVENTS (NDJSON, appended by env.receive) until SIGTERM; +messages-reply
// and +messages-send append their argv to REPLIES. Everything else gets a
// generic ok JSON so best-effort lookups (roster, chat names) degrade quietly.
function fakeLarkSource(dir) {
  return `
    import fs from 'node:fs';
    const EVENTS = ${JSON.stringify(path.join(dir, 'events.ndjson'))};
    const REPLIES = ${JSON.stringify(path.join(dir, 'replies.ndjson'))};
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('lark-cli 1.0.56'); process.exit(0); }
    if (args.includes('--help')) {
      console.log('--event-types --quiet +messages-reply +messages-send +chat-list');
      process.exit(0);
    }
    if (args.includes('doctor')) { console.log(JSON.stringify({ ok: true })); process.exit(0); }
    if (args.includes('+messages-reply') || args.includes('+messages-send')) {
      fs.appendFileSync(REPLIES, JSON.stringify(args) + '\\n');
      console.log(JSON.stringify({ ok: true, data: { message_id: 'om-mock-out' } }));
      process.exit(0);
    }
    if (args.includes('+chat-members-list')) {
      console.log(JSON.stringify({ ok: true, data: { users: [], bots: [] } }));
      process.exit(0);
    }
    if (args.includes('event')) {
      // ponytail: 20ms file polling; appends are small enough to arrive whole.
      let offset = 0;
      const timer = setInterval(() => {
        let stat;
        try { stat = fs.statSync(EVENTS); } catch { return; }
        if (stat.size <= offset) return;
        const fd = fs.openSync(EVENTS, 'r');
        const buffer = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buffer, 0, buffer.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        process.stdout.write(buffer);
      }, 20);
      const bye = () => { clearInterval(timer); process.exit(0); };
      process.on('SIGTERM', bye);
      process.on('SIGINT', bye);
    } else {
      console.log(JSON.stringify({ ok: true, data: {} }));
    }
  `;
}

// Fake codex app-server: newline JSON-RPC over stdio. Appends every turn input
// to INPUT_LOG and its own argv to SPAWN_LOG; turn outcome is fixed per env:
// 'complete' | 'fail' (with FAIL_BLOB) | 'ack-only'.
function fakeCodexSource(dir, { behavior, failBlob }) {
  return `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const INPUT_LOG = ${JSON.stringify(path.join(dir, 'codex-input.log'))};
    const SPAWN_LOG = ${JSON.stringify(path.join(dir, 'codex-spawns.ndjson'))};
    const BEHAVIOR = ${JSON.stringify(behavior)};
    const FAIL_BLOB = ${JSON.stringify(failBlob)};
    fs.appendFileSync(SPAWN_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
    const rl = readline.createInterface({ input: process.stdin });
    let turnSeq = 0;
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); return; }
      if (msg.method === 'initialized') { return; }
      if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
        send({ id: msg.id, result: { thread: { id: 'thread-mock' } } });
        send({ method: 'thread/started', params: { thread: { id: 'thread-mock' } } });
        return;
      }
      if (msg.method === 'model/list') {
        send({ id: msg.id, result: { data: [
          { id: 'gpt-5.6-sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
        ] } });
        return;
      }
      if (msg.method === 'turn/start') {
        const text = msg.params.input.map((part) => part.text).join('');
        fs.appendFileSync(INPUT_LOG, JSON.stringify({ method: 'turn/start', text }) + '\\n');
        send({ id: msg.id, result: {} });
        const turnId = 'turn-' + (++turnSeq);
        send({ method: 'turn/started', params: { turn: { id: turnId } } });
        if (BEHAVIOR === 'complete') {
          send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
        } else if (BEHAVIOR === 'fail') {
          send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'failed', error: { message: FAIL_BLOB } } } });
        }
        return;
      }
      if (msg.method === 'turn/steer') {
        const text = msg.params.input.map((part) => part.text).join('');
        fs.appendFileSync(INPUT_LOG, JSON.stringify({ method: 'turn/steer', text }) + '\\n');
        send({ id: msg.id, result: {} });
        return;
      }
      if (msg.method === 'turn/interrupt') { send({ id: msg.id, result: {} }); return; }
    });
  `;
}

// PATH-shimmed `ov` for identity mode: `ov read viking://user/<id>/identity.md`
// prints the fixture identity; anything else fails like a missing resource.
function fakeOvSource(identity) {
  return `
    const [verb, uri] = process.argv.slice(2);
    if (verb === 'read' && /identity\\.md$/.test(String(uri))) {
      process.stdout.write(${JSON.stringify(identity)});
      process.exit(0);
    }
    process.exit(1);
  `;
}

function readLines(file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return content.split('\n').filter(Boolean);
}

export async function startMockEnv({
  codex = {},
  identity = null,
  config: configOverrides = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-mock-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const fakeLark = path.join(binDir, 'fake-lark-cli.mjs');
  const fakeCodex = path.join(binDir, 'fake-codex.mjs');
  writeExecutable(fakeLark, fakeLarkSource(dir));
  writeExecutable(fakeCodex, fakeCodexSource(dir, {
    behavior: codex.behavior ?? 'complete',
    failBlob: codex.failBlob ?? '',
  }));
  fs.writeFileSync(path.join(dir, 'events.ndjson'), '');

  // OpenViking: quiet by default — point the config at a file that does not
  // exist so no user id resolves and no `ov` subprocess is ever spawned. With
  // an identity fixture, write a real config and shim `ov` onto PATH (the one
  // process-global mutation, restored on stop).
  let openVikingConfigPath = path.join(dir, 'absent-ov-config.json');
  let previousPath = null;
  if (identity !== null) {
    openVikingConfigPath = path.join(dir, 'ov-config.json');
    fs.writeFileSync(openVikingConfigPath, JSON.stringify({ user: 'e2e-user' }));
    writeExecutable(path.join(binDir, 'ov'), fakeOvSource(identity));
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath}`;
  }

  const config = {
    ...getConfig(),
    projectDir,
    dataDir: path.join(dir, 'data'),
    databasePath: path.join(dir, 'data', 'state.sqlite3'),
    lockPath: path.join(dir, 'data', 'daemon.lock'),
    tempDir: path.join(dir, 'data', 'tmp'),
    workspace: path.join(dir, 'workspace'),
    larkCliBin: fakeLark,
    codexBin: fakeCodex,
    profile: 'test-profile',
    initialModel: '',
    codexModel: '',
    claudeModel: '',
    openVikingConfigPath,
    ignoredSenderIds: new Set(),
    port: 0,
    httpEnabled: false,
    dryRun: false,
    logLevel: 'error',
    // getConfig() freezes meetingAudio paths under the live dataDir. Overriding
    // dataDir does not rebuild that object, so a developer shell with
    // LARK_DAEMON_MEETING_AUDIO_ENABLED would bind the production socket.
    meetingAudio: null,
    ...configOverrides,
  };
  const daemon = new LarkDaemon(config, createLogger('error', { test: 'mock-env' }), {
    ovClient: {
      messages: new Map(),
      async create(sessionId) { return { session_id: sessionId, uri: `viking://session/${sessionId}` }; },
      async append(id, message) { const rows = this.messages.get(id) || []; rows.push({ ...message, parts: [{ type: 'text', text: message.content }] }); this.messages.set(id, rows); },
      async context(id) { return { latest_archive_overview: '', messages: this.messages.get(id) || [], stats: { totalArchives: 0 } }; },
      async request() { return { pending_tokens: 0 }; },
    },
  });

  const env = {
    dir,
    config,
    daemon,

    // Push one raw Lark event into the live subscription.
    receive(event) {
      fs.appendFileSync(path.join(dir, 'events.ndjson'), `${JSON.stringify(event)}\n`);
    },

    // Everything the fake codex was asked to think about: [{ method, text }].
    codexInput() {
      return readLines(path.join(dir, 'codex-input.log')).map((line) => JSON.parse(line));
    },

    // argv of every fake codex spawn (policy assertions live here:
    // developer_instructions is a `-c` config override).
    codexSpawnArgs() {
      return readLines(path.join(dir, 'codex-spawns.ndjson')).map((line) => JSON.parse(line));
    },

    // argv of every outbound lark-cli reply/send call.
    replies() {
      return readLines(path.join(dir, 'replies.ndjson')).map((line) => JSON.parse(line));
    },

    async waitFor(predicate, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('mock env timed out waiting for condition');
    },

    waitForCodexInput(pattern, timeoutMs) {
      return this.waitFor(
        () => this.codexInput().some((entry) => pattern.test(entry.text)),
        timeoutMs,
      );
    },

    waitForReply(pattern, timeoutMs) {
      return this.waitFor(
        () => this.replies().some((args) => args.some((argument) => pattern.test(argument))),
        timeoutMs,
      );
    },

    async stop() {
      try {
        await daemon.shutdown('mock-env-stop', 0);
      } finally {
        if (previousPath !== null) process.env.PATH = previousPath;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };

  try {
    await daemon.start();
  } catch (error) {
    await env.stop().catch(() => {});
    throw error;
  }
  return env;
}

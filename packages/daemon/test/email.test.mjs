import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { EmailClient } from '../src/email/client.mjs';
import { EmailState } from '../src/email/state.mjs';
import { fetchAttributes, parseResponse } from '../src/email/imap.mjs';
import { buildReply, htmlToText, isOwnMessageId, parseAddresses, parseMail, replyMessageId } from '../src/email/mime.mjs';
import { normalizeEvent } from '../src/event.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const ME = 'me@example.com';
const PASSWORD = 'app-password-123';

function mail({ from = 'Alice <alice@example.com>', to = ME, subject = 'Thursday?', id = 'a1@example.com', headers = [],
  body = 'Can we meet on Thursday?' } = {}) {
  return Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}>`,
    'Date: Tue, 13 Oct 2026 08:10:00 +0000', ...headers, 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n'));
}

// A scripted IMAP server: the commands it was sent, the mailbox, and IDLE
// sessions to wake with `deliver(raw)`.
async function fakeImap(t, { mails = [], uidValidity = 1, gmail = true } = {}) {
  const state = { mails: mails.map((raw, index) => ({ uid: index + 1, raw })), commands: [], idlers: new Set(), sockets: new Set() };
  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.on('close', () => { state.sockets.delete(socket); state.idlers.delete(socket); });
    socket.on('error', () => {});
    let buffer = '';
    let idleTag = null;
    socket.write('* OK [CAPABILITY IMAP4rev1 IDLE] ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (idleTag) {
          if (line === 'DONE') {
            state.idlers.delete(socket);
            socket.write(`${idleTag} OK IDLE terminated\r\n`);
            idleTag = null;
          }
          continue;
        }
        const space = line.indexOf(' ');
        const tag = line.slice(0, space);
        const command = line.slice(space + 1);
        state.commands.push(command.startsWith('LOGIN ') ? 'LOGIN' : command);
        const ok = (text = 'done') => socket.write(`${tag} OK ${text}\r\n`);
        const uidNext = (state.mails.at(-1)?.uid ?? 0) + 1;
        let match;
        if (command.startsWith('LOGIN ')) {
          if (command.includes(`"${PASSWORD}"`)) ok();
          else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (command === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1 IDLE${gmail ? ' X-GM-EXT-1' : ''}\r\n`);
          ok();
        } else if (command.startsWith('EXAMINE ')) {
          socket.write(`* ${state.mails.length} EXISTS\r\n* OK [UIDVALIDITY ${uidValidity}] ok\r\n* OK [UIDNEXT ${uidNext}] ok\r\n`);
          ok('[READ-ONLY] EXAMINE completed');
        } else if ((match = /^UID SEARCH UID (\d+):\*$/.exec(command))) {
          const from = Number(match[1]);
          const found = state.mails.filter((item) => item.uid >= from).map((item) => item.uid);
          // RFC 3501: `n:*` always includes the newest message.
          if (found.length === 0 && state.mails.length) found.push(state.mails.at(-1).uid);
          socket.write(`* SEARCH${found.map((uid) => ` ${uid}`).join('')}\r\n`);
          ok();
        } else if ((match = /^UID FETCH ([\d,]+) \((.*)\)$/.exec(command))) {
          for (const uid of match[1].split(',').map(Number)) {
            const index = state.mails.findIndex((item) => item.uid === uid);
            if (index < 0) continue;
            const { raw } = state.mails[index];
            const fields = [`UID ${uid}`, `RFC822.SIZE ${raw.length}`];
            if (match[2].includes('X-GM-THRID')) fields.push('X-GM-THRID 9001');
            if (match[2].includes('INTERNALDATE')) fields.push('INTERNALDATE "13-Oct-2026 08:10:00 +0000"');
            const body = match[2].includes('BODY.PEEK[]') ? raw : null;
            socket.write(`* ${index + 1} FETCH (${fields.join(' ')}${body ? ` BODY[] {${body.length}}\r\n` : ')\r\n'}`);
            if (body) {
              socket.write(body);
              socket.write(')\r\n');
            }
          }
          ok();
        } else if (command === 'IDLE') {
          idleTag = tag;
          state.idlers.add(socket);
          socket.write('+ idling\r\n');
        } else if (command === 'NOOP' || command.startsWith('ID ')) {
          ok();
        } else if (command === 'LOGOUT') {
          socket.write('* BYE logging out\r\n');
          ok();
          socket.end();
        } else {
          socket.write(`${tag} BAD unsupported\r\n`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of state.sockets) socket.destroy();
    server.close();
  });
  return {
    state,
    port: server.address().port,
    deliver(raw) {
      state.mails.push({ uid: (state.mails.at(-1)?.uid ?? 0) + 1, raw });
      for (const socket of state.idlers) socket.write(`* ${state.mails.length} EXISTS\r\n`);
    },
  };
}

// A scripted SMTP submission server; `messages` are what it accepted.
async function fakeSmtp(t) {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('220 fake ESMTP\r\n');
    let buffer = '';
    let data = null;
    let current = { to: [] };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            messages.push({ ...current, raw: data.join('\r\n') });
            current = { to: [] };
            data = null;
            socket.write('250 queued\r\n');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (line.startsWith('AUTH PLAIN ')) {
          const [, user, password] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          socket.write(user === ME && password === PASSWORD ? '235 ok\r\n' : '535 bad credentials\r\n');
        } else if (line.startsWith('MAIL FROM:')) { current.from = line.slice(10); socket.write('250 ok\r\n'); }
        else if (line.startsWith('RCPT TO:')) { current.to.push(line.slice(8)); socket.write('250 ok\r\n'); }
        else if (line === 'DATA') { data = []; socket.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('502 unsupported\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { messages, port: server.address().port };
}

// TLS is the transport's business; the fakes speak the protocols in the clear.
function plainTls(options) {
  const socket = net.connect(options.port, '127.0.0.1');
  socket.once('connect', () => socket.emit('secureConnect'));
  return socket;
}

async function setup(t, { mails = [], password = PASSWORD, gmail = true } = {}) {
  const imap = await fakeImap(t, { mails, gmail });
  const smtp = await fakeSmtp(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'account.json');
  fs.writeFileSync(configFile, JSON.stringify({ address: ME, password,
    imap: { host: '127.0.0.1', port: imap.port }, smtp: { host: '127.0.0.1', port: smtp.port, secure: true } }), { mode: 0o600 });
  const config = { emailConfigFile: configFile, dataDir: directory, retentionMs: 86_400_000 };
  const clients = [];
  const start = async () => {
    const client = new EmailClient(config, null, quiet, { connectTls: plainTls });
    clients.push(client);
    await client.preflight();
    const events = [];
    const exits = [];
    client.startSubscription((line) => events.push(normalizeEvent(JSON.parse(line))), (exit) => exits.push(exit));
    await until(() => imap.state.idlers.size === 1);
    return { client, events, exits };
  };
  t.after(async () => { for (const client of clients) await client.stop().catch(() => {}); });
  return { imap, smtp, start, config };
}

async function until(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('email connector', () => {
  it('reports mail that arrives after it starts, read-only, and skips its own replies and auto-replies', async (t) => {
    const { imap, start } = await setup(t, { mails: [mail({ id: 'old-1@example.com' }), mail({ id: 'old-2@example.com' })] });
    const { events, exits } = await start();

    imap.deliver(mail({ id: 'auto@example.com', headers: ['Auto-Submitted: auto-replied'] }));
    imap.deliver(mail({ from: ME, id: replyMessageId('ld_earlier', ME), subject: 'Re: Thursday?' }));
    imap.deliver(mail({ from: '"Alice, A." <Alice@Example.com>', headers: ['Cc: Carol <carol@example.com>'],
      subject: '=?UTF-8?B?5ZGo5Zub5byA5Lya77yf?=', body: 'Can we meet?\r\n\r\nThanks' }));
    imap.deliver(mail({ from: 'news@example.com', id: 'news@example.com', headers: ['List-Id: <news.example.com>'] }));
    await until(() => events.length === 2);

    const [event, news] = events;
    assert.deepEqual([event.eventId, event.kind, event.messageId, event.subject, event.senderId, event.title],
      ['imap:1:5', 'email.received', 'mail:1:5', { type: 'thread', id: 'gmail:9001' }, 'alice@example.com', '周四开会？']);
    assert.equal(event.content, 'From: Alice, A. <alice@example.com>\nTo: me@example.com\nCc: Carol <carol@example.com>\n\nCan we meet?\n\nThanks');
    assert.equal(event.createTimeMs, Date.parse('2026-10-13T08:10:00Z'));
    assert.equal(event.chatId, null);
    assert.equal(news.kind, 'email.list');
    // Nothing in the mailbox is ever changed: opened read-only, bodies peeked.
    assert.ok(imap.state.commands.includes('EXAMINE "INBOX"'));
    assert.ok(imap.state.commands.some((command) => command.includes('BODY.PEEK[]')));
    assert.doesNotMatch(imap.state.commands.join('\n'), /^(SELECT|STORE|UID STORE|EXPUNGE|COPY|MOVE|UID MOVE)\b/m);
    assert.deepEqual(exits, []);
  });

  it('replies over SMTP to Reply-To, threaded under the mail', async (t) => {
    const { imap, smtp, start } = await setup(t);
    const { client, events } = await start();
    imap.deliver(mail({ id: 'q1@example.com', headers: ['Reply-To: Bob <bob@example.com>', 'References: <root@example.com>'] }));
    await until(() => events.length === 1);
    // The event says where a reply would go, for the owner's approval card.
    assert.deepEqual(events[0].data.reply, { to: [{ name: 'Bob', address: 'bob@example.com' }], subject: 'Re: Thursday?' });

    // Only the recipients the owner approved, and all of them.
    const answer = (to) => client.replyMessage({ message_id: 'mail:1:1', content: { type: 'markdown', text: '周四可以\n三点见' },
      to, idempotency_key: 'ld_reply1' });
    for (const to of [undefined, [], ['bob@example.com', 'eve@example.com'], ['eve@example.com']]) {
      await assert.rejects(answer(to), /do not match the ones the owner approved/);
    }
    assert.deepEqual(await answer(['bob@example.com']), { sent: true });
    const [sent] = smtp.messages;
    assert.equal(sent.from, `<${ME}>`);
    assert.deepEqual(sent.to, ['<bob@example.com>']);
    const reply = parseMail(Buffer.from(sent.raw));
    assert.equal(reply.subject, 'Re: Thursday?');
    assert.equal(reply.inReplyTo, 'q1@example.com');
    assert.deepEqual(reply.references, ['root@example.com', 'q1@example.com']);
    assert.equal(reply.text, '周四可以\n三点见');
    assert.ok(isOwnMessageId(reply.messageId), 'its own reply is recognised when it comes back');

    await assert.rejects(client.replyMessage({ message_id: 'mail:1:99', content: { type: 'markdown', text: 'x' }, idempotency_key: 'k' }),
      /no longer available/);
    await assert.rejects(client.replyMessage({ message_id: 'mail:1:1', content: { type: 'file', path: '/x' }, idempotency_key: 'k' }),
      /plain text only/);
    assert.equal(smtp.messages.length, 1);
  });

  it('reports every reply recipient for the approval card, or only how many when they are too many to show', async (t) => {
    const { imap, start } = await setup(t);
    const { events } = await start();
    const replyTo = (count) => `Reply-To: ${Array.from({ length: count }, (_, index) => `r${index + 1}@example.com`).join(', ')}`;
    imap.deliver(mail({ id: 'twenty@example.com', headers: [replyTo(20)] }));
    imap.deliver(mail({ id: 'many@example.com', headers: [replyTo(21)] }));
    await until(() => events.length === 2);
    assert.equal(events[0].data.reply.to.length, 20);
    assert.deepEqual(events[1].data.reply, { subject: 'Re: Thursday?', recipients: 21 });
  });

  it('picks up after a restart where it stopped, without reporting a mail twice', async (t) => {
    const { imap, start } = await setup(t);
    const first = await start();
    imap.deliver(mail({ id: 'one@example.com' }));
    await until(() => first.events.length === 1);
    await first.client.stop();

    imap.deliver(mail({ id: 'two@example.com' }));
    imap.deliver(mail({ id: 'three@example.com' }));
    const second = await start();
    await until(() => second.events.length === 2);
    assert.deepEqual(second.events.map((event) => event.eventId), ['imap:1:2', 'imap:1:3']);
  });

  it('reports a mail whose ids, sender or subject are too long to use as is', async (t) => {
    const { imap, start, config } = await setup(t, { gmail: false });
    const { events, exits } = await start();
    const long = (length) => `${'r'.repeat(length)}@example.com`;
    // Without a Gmail thread id, the thread comes from References.
    imap.deliver(mail({ id: 'first@example.com', headers: [`References: <${long(1_100)}>`] }));
    imap.deliver(mail({ id: 'second@example.com', from: `Mallory <${long(1_100)}>` }));
    imap.deliver(mail({ id: 'third@example.com', subject: 's'.repeat(1_200_000) }));
    imap.deliver(mail({ id: 'fourth@example.com', headers: ['References: <root@example.com>'] }));
    await until(() => events.length === 4);

    assert.deepEqual(exits, []);
    // A thread is a fixed-size digest of its first Message-ID.
    assert.ok(events.every((event) => /^mid:[0-9a-f]{32}$/.test(event.subject.id)));
    assert.equal(new Set(events.map((event) => event.subject.id)).size, 4);
    // A sender address no SMTP path can hold is no sender.
    assert.equal(events[1].actor, null);
    assert.equal(events[2].title.length, 300);
    assert.ok(Math.max(...events.map((event) => JSON.stringify(event.envelope).length)) < 20_000);
    assert.deepEqual(new EmailState(config.dataDir).cursor('INBOX'), { uidValidity: 1, lastUid: 4 });
  });

  it('passes over a mail it cannot read, and the next one still arrives', async (t) => {
    const { imap, start, config } = await setup(t);
    const { client, events, exits } = await start();
    const report = client.report.bind(client);
    client.report = (item, ...rest) => {
      if (item.uid === 1) throw new Error('unreadable');
      return report(item, ...rest);
    };
    imap.deliver(mail({ id: 'broken@example.com' }));
    imap.deliver(mail({ id: 'fine@example.com' }));
    await until(() => events.length === 1);
    assert.deepEqual(exits, []);
    assert.equal(events[0].eventId, 'imap:1:2');
    // Not retried: the cursor is past it, and no reply headers were kept.
    assert.deepEqual(new EmailState(config.dataDir).cursor('INBOX'), { uidValidity: 1, lastUid: 2 });
    assert.equal(client.state.mail('mail:1:1'), null);
  });

  it('fails its check on a wrong password without echoing it', async (t) => {
    const { config } = await setup(t, { password: 'wrong-password' });
    const client = new EmailClient(config, null, quiet, { connectTls: plainTls });
    const error = await client.preflight().catch((caught) => caught);
    assert.match(error.message, /IMAP LOGIN failed: NO \[AUTHENTICATIONFAILED\]/);
    assert.doesNotMatch(error.message, /wrong-password/);
    client.state.close();
  });
});

describe('mail parsing', () => {
  it('decodes headers, charsets, nested parts and attachment names', () => {
    const gbk = (text) => Buffer.from([0xc4, 0xe3, 0xba, 0xc3]).toString('base64') + text;
    const raw = ['From: =?UTF-8?B?5byg5LiJ?= <zhang@x.com>', 'To: "Doe, John" <john@x.com>, undisclosed-recipients:;',
      'Subject: =?GBK?B?1tDOxA==?= =?GBK?B?1tDOxA==?= ok', 'Message-ID: <a1@x.com>',
      'Content-Type: multipart/mixed; boundary="OUT"', '', 'preamble', '--OUT',
      'Content-Type: multipart/alternative; boundary="IN"', '', '--IN', 'Content-Type: text/plain; charset=gbk',
      'Content-Transfer-Encoding: base64', '', gbk(''), '--IN', 'Content-Type: text/html', '', '<p>html</p>', '--IN--',
      '--OUT', 'Content-Type: application/pdf',
      "Content-Disposition: attachment; filename*0*=UTF-8''%E6%8A%A5; filename*1*=%E5%91%8A.pdf",
      'Content-Transfer-Encoding: base64', '', 'JVBERi0=', '--OUT--', 'epilogue', ''].join('\r\n');
    const parsed = parseMail(Buffer.from(raw, 'latin1'));
    assert.equal(parsed.subject, '中文中文 ok');
    assert.deepEqual(parsed.from, { name: '张三', address: 'zhang@x.com' });
    assert.deepEqual(parsed.to, [{ name: 'Doe, John', address: 'john@x.com' }]);
    assert.equal(parsed.text, '你好');
    assert.deepEqual(parsed.attachments, [{ name: '报告.pdf', type: 'application/pdf', size: 5 }]);
  });

  it('falls back to the HTML part as text, and bounds the text', () => {
    const html = ['Subject: hi', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
      '<style>p{}</style><p>Hello&nbsp;<b>there</b></p><ul><li>one</li><li>two</li></ul>=E4=BD=A0'].join('\r\n');
    assert.equal(parseMail(Buffer.from(html)).text, 'Hello there\n- one\n- two\n你');
    const long = parseMail(Buffer.from(`Subject: x\r\n\r\n${'a'.repeat(50)}`), { maxTextChars: 10 }).text;
    assert.equal(long, `${'a'.repeat(10)}\n[truncated]`);
  });

  it('turns hostile HTML into text in linear time', () => {
    for (const html of ['<script>x'.repeat(30_000), '<'.repeat(256 * 1024), '<li '.repeat(60_000)]) {
      const started = Date.now();
      parseMail(Buffer.from(`Subject: x\r\nContent-Type: text/html\r\n\r\n${html}`));
      assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
    }
    assert.equal(htmlToText('a<script>1<b>2</script >b<style>c'), 'ab');
  });

  it('builds a reply that keeps one Re: and the thread', () => {
    const original = { subject: 'RE: plan', messageId: 'm2@x.com', references: ['m1@x.com'] };
    const raw = buildReply({ from: { name: '我', address: ME }, to: parseAddresses('bob@x.com'), original, text: 'ok', messageId: 'r@x.com' });
    const parsed = parseMail(Buffer.from(raw));
    assert.equal(parsed.subject, 'RE: plan');
    assert.deepEqual(parsed.from, { name: '我', address: ME });
    assert.deepEqual(parsed.references, ['m1@x.com', 'm2@x.com']);
  });

  it('reads IMAP responses with literals and nested lists', () => {
    const parts = ['* 3 FETCH (UID 12 FLAGS (\\Seen) INTERNALDATE "13-Oct-2026 08:10:00 +0000" BODY[] {5}', Buffer.from('hello'), ')'];
    const [, , , attributes] = parseResponse(parts);
    assert.deepEqual(attributes.slice(0, 3), ['UID', '12', 'FLAGS']);
    const fetched = fetchAttributes(attributes);
    assert.equal(fetched.uid, 12);
    assert.equal(fetched.body.toString(), 'hello');
    assert.equal(fetched.internalDate, Date.parse('2026-10-13T08:10:00Z'));
  });
});

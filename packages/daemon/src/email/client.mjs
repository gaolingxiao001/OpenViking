import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { eventMessage } from '../connectors/protocol.mjs';
import { safeError } from '../logger.mjs';
import { ImapConnection } from './imap.mjs';
import { buildReply, isOwnMessageId, parseMail, replyMessageId } from './mime.mjs';
import { sendMail, verifySmtp } from './smtp.mjs';
import { EmailState } from './state.mjs';

const MAILBOX = 'INBOX';
// Servers may drop an IDLE after 29 minutes; renew it well before.
const IDLE_MS = 9 * 60_000;
const POLL_MS = 60_000;
// After a long stop only the newest mails are reported; older ones are skipped.
const MAX_CATCH_UP = 50;
const FETCH_BATCH = 10;
// A larger mail is reported from its headers alone.
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_LISTED = 10;
const MAX_ATTACHMENTS = 20;
// An approval card shows every reply recipient; a mail that would be answered
// to more addresses than fit there in full cannot be answered at all.
const MAX_REPLY_RECIPIENTS = 20;

// The account file: { address, password, imap: { host, port }, smtp: { host,
// port, secure? }, username?, name? }. The password is a client (app) password.
// SMTP uses implicit TLS on port 465 unless `secure` says otherwise, else STARTTLS.
export function loadAccount(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    throw new Error('email config file is unreadable or not JSON');
  }
  const address = String(value?.address ?? '').trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) throw new Error('email config needs an address');
  if (typeof value.password !== 'string' || !value.password) throw new Error('email config needs a password');
  const server = (key) => {
    const host = String(value[key]?.host ?? '').trim();
    const port = Number(value[key]?.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`email config needs ${key}.host and ${key}.port`);
    return { host, port, ...(typeof value[key].secure === 'boolean' ? { secure: value[key].secure } : {}) };
  };
  return Object.freeze({
    address,
    name: typeof value.name === 'string' ? value.name.trim() : '',
    user: typeof value.username === 'string' && value.username.trim() ? value.username.trim() : address,
    password: value.password,
    imap: server('imap'),
    smtp: server('smtp'),
  });
}

function people(list) {
  const shown = list.slice(0, MAX_LISTED).map(({ name, address }) => (name ? `${name} <${address}>` : address));
  if (list.length > MAX_LISTED) shown.push(`+${list.length - MAX_LISTED} more`);
  return shown.join(', ');
}

// What the model reads: who wrote to whom, then the body. Display names are
// untrusted labels, like the rest of the mail.
function mailText(mail) {
  return [
    ...(mail.from ? [`From: ${people([mail.from])}`] : []),
    ...(mail.to.length ? [`To: ${people(mail.to)}`] : []),
    ...(mail.cc.length ? [`Cc: ${people(mail.cc)}`] : []),
    '',
    mail.text,
  ].join('\n').trim();
}

// Who a reply goes to: Reply-To, else From. A mail the owner sent goes to its
// other recipients instead. The Core shows the same list on the approval card.
export function replyRecipients(mail, own) {
  let to = mail.replyTo.length ? mail.replyTo : mail.from ? [mail.from] : [];
  const others = mail.to.filter((recipient) => recipient.address !== own);
  if (to.every((recipient) => recipient.address === own) && others.length > 0) to = others;
  return to;
}

function sameAddresses(approved, recipients) {
  const sorted = (list) => [...list].sort().join('\n');
  return Array.isArray(approved) && approved.length === recipients.length
    && sorted(approved) === sorted(recipients.map((recipient) => recipient.address));
}

export function replySubject(subject) {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

// A thread as a subject id: Gmail's numeric thread id, or a digest of the
// thread's first Message-ID, which the sender controls and may make any length.
function threadId(item, mail, fallback) {
  if (/^\d{1,32}$/.test(item.thread ?? '')) return `gmail:${item.thread}`;
  const root = mail.references[0] ?? mail.inReplyTo ?? mail.messageId ?? fallback;
  return `mid:${createHash('sha256').update(root).digest('hex').slice(0, 32)}`;
}

function sleep(ms, stopped) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (stopped() || Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 1_000);
  });
}

// Watches one mailbox's INBOX read-only over IMAP and reports each new mail as
// an event; replies to a reported mail over SMTP. Never marks, moves or
// deletes mail.
export class EmailClient {
  constructor(config, _registry, logger, { connectTls } = {}) {
    this.config = config;
    this.logger = logger;
    this.connectTls = connectTls;
    this.state = new EmailState(config.dataDir);
    this.account = null;
    this.imap = null;
    this.loop = null;
    this.stopping = false;
  }

  imapConnection() {
    return new ImapConnection({ ...this.account.imap, ...(this.connectTls ? { connect: this.connectTls } : {}) });
  }

  smtpAccount() {
    return { ...this.account.smtp, user: this.account.user, password: this.account.password,
      ...(this.connectTls ? { connectTls: this.connectTls } : {}) };
  }

  async open() {
    const imap = this.imapConnection();
    try {
      await imap.connect();
      await imap.login(this.account.user, this.account.password);
      return imap;
    } catch (error) {
      imap.close();
      throw error;
    }
  }

  // Both credentials, before anything starts.
  async preflight() {
    this.account = loadAccount(this.config.emailConfigFile);
    const imap = await this.open();
    try { await imap.examine(MAILBOX); } finally { await imap.logout(); }
    await verifySmtp(this.smtpAccount());
    this.state.prune(Date.now() - this.config.retentionMs);
    // A mailbox is not an IM: notices to the owner never go here.
    return { version: 'imap-smtp-v1', owner: null };
  }

  startSubscription(onLine, onUnexpectedExit) {
    if (this.loop) throw new Error('Email watcher is already running');
    this.stopping = false;
    this.loop = this.watch(onLine).catch((error) => {
      if (!this.stopping) onUnexpectedExit({ code: null, signal: null, stderr: error.message });
    }).finally(() => { this.loop = null; });
  }

  async watch(onLine) {
    const imap = await this.open();
    this.imap = imap;
    try {
      const box = await imap.examine(MAILBOX);
      let cursor = this.state.cursor(MAILBOX);
      if (!cursor || cursor.uidValidity !== box.uidValidity) {
        // First start, or the server renumbered the mailbox: begin with what
        // arrives next instead of reporting the whole inbox.
        if (cursor) this.logger.warn('email_mailbox_renumbered');
        cursor = { uidValidity: box.uidValidity, lastUid: box.uidNext - 1 };
        this.state.saveCursor(MAILBOX, cursor);
      }
      while (!this.stopping) {
        await this.catchUp(imap, cursor, onLine);
        if (this.stopping) break;
        if (imap.capabilities.has('IDLE')) {
          await imap.idle(IDLE_MS, () => this.stopping);
        } else {
          await sleep(POLL_MS, () => this.stopping);
          if (!this.stopping) await imap.command('NOOP');
        }
      }
    } finally {
      this.imap = null;
      await imap.logout();
    }
  }

  async catchUp(imap, cursor, onLine) {
    let uids = await imap.searchUids(cursor.lastUid + 1);
    if (uids.length > MAX_CATCH_UP) {
      this.logger.warn('email_catch_up_skipped', { skipped: uids.length - MAX_CATCH_UP });
      uids = uids.slice(-MAX_CATCH_UP);
    }
    const thread = imap.capabilities.has('X-GM-EXT-1') ? ['X-GM-THRID'] : [];
    for (let index = 0; index < uids.length && !this.stopping; index += FETCH_BATCH) {
      const batch = uids.slice(index, index + FETCH_BATCH);
      const sizes = await imap.fetch(batch, ['UID', 'RFC822.SIZE']);
      const small = sizes.filter((item) => !(item.size > MAX_BODY_BYTES)).map((item) => item.uid);
      const large = sizes.filter((item) => item.size > MAX_BODY_BYTES).map((item) => item.uid);
      const fetched = [
        ...(small.length ? await imap.fetch(small, ['UID', 'INTERNALDATE', ...thread, 'BODY.PEEK[]']) : []),
        ...(large.length ? (await imap.fetch(large, ['UID', 'INTERNALDATE', 'RFC822.SIZE', ...thread, 'BODY.PEEK[HEADER]']))
          .map((item) => ({ ...item, truncated: true })) : []),
      ].sort((left, right) => left.uid - right.uid);
      for (const item of fetched) {
        // One mail that cannot be read is passed over, never retried: the
        // cursor moves on so the mail after it still arrives.
        try {
          this.report(item, cursor.uidValidity, onLine);
        } catch (error) {
          this.logger.warn('email_unreadable', { uid: item.uid, error: safeError(error) });
        }
        cursor.lastUid = Math.max(cursor.lastUid, item.uid);
        this.state.saveCursor(MAILBOX, cursor);
      }
      // A UID that vanished between SEARCH and FETCH (deleted) is passed over.
      cursor.lastUid = Math.max(cursor.lastUid, ...batch);
      this.state.saveCursor(MAILBOX, cursor);
    }
  }

  report(item, uidValidity, onLine) {
    if (!item.body) return;
    const mail = parseMail(item.body);
    if (mail.automatic || isOwnMessageId(mail.messageId)) {
      this.logger.info('email_skipped', { uid: item.uid, reason: mail.automatic ? 'automatic' : 'own_reply' });
      return;
    }
    if (item.truncated) mail.text = `[mail body not fetched: ${Math.round(item.size / 1_048_576)} MiB]`;
    const messageId = `mail:${uidValidity}:${item.uid}`;
    const recipients = replyRecipients(mail, this.account.address);
    const line = JSON.stringify(eventMessage('email', {
      id: `imap:${uidValidity}:${item.uid}`,
      kind: mail.bulk ? 'email.list' : 'email.received',
      occurred_at: item.internalDate ?? mail.date ?? Date.now(),
      subject: { type: 'thread', id: threadId(item, mail, messageId) },
      actor: mail.from ? { type: 'email', id: mail.from.address } : null,
      content: {
        title: mail.subject,
        text: mailText(mail),
        attachments: mail.attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => ({
          type: 'file', id: attachment.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) || 'attachment',
        })),
      },
      message: { id: messageId, type: 'email' },
      // Who a reply goes to, in full, for the owner to check on the approval
      // card; past the limit only how many.
      data: { reply: { subject: replySubject(mail.subject),
        ...(recipients.length <= MAX_REPLY_RECIPIENTS ? { to: recipients } : { recipients: recipients.length }) } },
    }));
    // The event is built and checked before the reply headers are kept, so a
    // mail that fails leaves nothing behind.
    this.state.remember(messageId, {
      messageId: mail.messageId, subject: mail.subject, references: mail.references,
      from: mail.from, replyTo: mail.replyTo, to: mail.to,
    });
    onLine(line);
    this.logger.info('email_reported', { uid: item.uid, bulk: mail.bulk });
  }

  // A plain-text reply to a mail this Connector reported, threaded under it.
  // `to` is the recipient list the owner approved on the card; it goes out only
  // if it is still exactly this mail's reply recipients.
  async replyMessage({ message_id: messageId, content, to: approved, idempotency_key: idempotencyKey }) {
    if (content?.type !== 'markdown') throw new Error('email replies are plain text only');
    const original = this.state.mail(messageId);
    if (!original) throw new Error('That mail is no longer available to reply to');
    const own = this.account.address;
    const to = replyRecipients(original, own);
    if (to.length === 0) throw new Error('That mail has no address to reply to');
    if (!sameAddresses(approved, to)) throw new Error('The reply recipients do not match the ones the owner approved');
    const raw = buildReply({
      from: { name: this.account.name, address: own }, to, original, text: content.text,
      messageId: replyMessageId(idempotencyKey, own),
    });
    await sendMail(this.smtpAccount(), { from: own, recipients: to.map((recipient) => recipient.address), raw });
    this.logger.info('email_replied', { recipients: to.length });
    return { sent: true };
  }

  async stopSubscription() {
    this.stopping = true;
    this.imap?.close();
    await this.loop;
  }

  async stop() {
    await this.stopSubscription();
    this.state.close();
  }
}

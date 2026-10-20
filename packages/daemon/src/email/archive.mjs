import path from 'node:path';
import { OVConnection, OVUnavailableError, readOVConfig } from '../ov-connection.mjs';

// Each mail the Connector reports is stored in the owner's private OpenViking
// area before its event goes out, so the runtime gets links instead of the
// whole mail and recall can find it later:
//
//   <root>/<account tag>-<uidvalidity>-<uid>/
//     body.md                          the whole mail
//     chunks/                          a long body, split for recall
//     attachments/<NN>-<name>/full/    the whole attachment as text
//     attachments/<NN>-<name>/chunks/  a long attachment, split for recall
//
// OV keeps one vector per file, from the first 4096 (estimated) tokens of it,
// and stores a split document only as its pieces. So the whole text is kept
// for reading, and a text too long for one vector is imported a second time,
// split by OV's own Markdown parser, for recall alone; read_email always
// reads the whole text. Text is in place when a call returns; OV only builds
// vectors afterwards (`vectors_only`), so storing a mail never asks an LLM for
// a summary. `viking://resources/...` is shared with the whole OV account; mail
// is not.

const VECTORS_ONLY = 'vectors_only';
const MAIL_ID = /^mail:([0-9a-f]{8}):(\d{1,10}):(\d{1,10})$/;
const FOLDER = /^[0-9a-f]{8}-\d{1,10}-\d{1,10}$/;
// OV's Markdown parser keeps a text whole up to these (parsers.markdown).
const SECTION_TOKENS = 2048;
const SECTION_CHARS = 6000;
const CJK = /[一-鿿぀-ヿ가-힯]/g;
const QUIET = { info() {}, warn() {} };
// What OV's resource parsers turn into Markdown, by extension.
const PARSED = new Set([
  'pdf', 'md', 'markdown', 'mdown', 'mkd', 'txt', 'text', 'html', 'htm',
  'doc', 'docx', 'docm', 'odt', 'rtf', 'epub',
  'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv',
  'pptx', 'ppt', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'odp',
]);
// The extension OV needs for a part that came without a file name.
const EXTENSION_FOR = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/rtf': 'rtf',
  'application/epub+zip': 'epub',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
};
const UPLOAD_TIMEOUT_MS = 120_000;

export function mailArchiveRoot(user) {
  return user ? `viking://user/${user}/resources/emails` : 'viking://~/resources/emails';
}

// mail:<tag>:<uidvalidity>:<uid> -> <root>/<tag>-<uidvalidity>-<uid>
export function mailFolder(root, messageId) {
  const match = MAIL_ID.exec(String(messageId));
  if (!match) throw new Error('not a mail id');
  return `${root}/${match[1]}-${match[2]}-${match[3]}`;
}

// Whether OV would split this text, by its own estimate (CJK ~0.7 token per
// character, anything else not blank ~0.3). Only then are chunks stored.
export function needsChunks(text) {
  if (text.length > SECTION_CHARS) return true;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk * 0.7 + (text.replace(/\s/g, '').length - cjk) * 0.3 > SECTION_TOKENS;
}

// What read_email reads for a uri in the archive: { target, anchor? }, the
// whole text of a mail or an attachment. A chunk leads to the whole text it
// was cut from, with itself as the anchor where reading starts. Null for any
// uri that is not part of a stored mail.
export function readTarget(root, uri) {
  if (!String(uri).startsWith(`${root}/`)) return null;
  const parts = uri.slice(root.length + 1).replace(/\/+$/, '').split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..') || !FOLDER.test(parts[0])) return null;
  const [folder, ...rest] = parts;
  const mail = `${root}/${folder}`;
  if (rest.length === 0 || (rest.length === 1 && rest[0] === 'body.md')) return { target: `${mail}/body.md` };
  if (rest[0] === 'chunks') return { target: `${mail}/body.md`, ...(rest.length > 1 ? { anchor: uri } : {}) };
  if (rest[0] !== 'attachments' || rest.length < 2) return null;
  const full = `${mail}/attachments/${rest[1]}/full`;
  if (rest.length === 2 || rest[2] === 'full') return { target: full };
  if (rest[2] === 'chunks') return { target: full, ...(rest.length > 3 ? { anchor: uri } : {}) };
  return null;
}

// Where a chunk's text starts in the whole text: the line holding the first
// of its lines found there, or 0. OV may change headings and spacing, so lines
// are matched by their start.
export function chunkOffset(text, chunk) {
  const lines = String(chunk).split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).filter((line) => line.length >= 8);
  for (const line of lines.slice(0, 8)) {
    const index = text.indexOf(line.slice(0, 80));
    if (index >= 0) return text.lastIndexOf('\n', index) + 1;
  }
  return 0;
}

// The text stored at a uri: a file as it is; a directory as its text files in
// name order, each under its own heading when there are several. `get(route)`
// answers an /api/v1 GET with its result.
export async function readStoredText(get, uri) {
  const stat = await get(`/fs/stat?uri=${encodeURIComponent(uri)}`);
  if (!stat?.isDir) return String(await get(`/content/read?uri=${encodeURIComponent(uri)}&offset=0&limit=-1&raw=true`) ?? '');
  // A tree stops three levels down unless told otherwise; split headings nest deeper.
  const files = (await get(`/fs/tree?uri=${encodeURIComponent(uri)}&level_limit=16&include_abstract=false`) ?? [])
    .filter((entry) => !entry.isDir && /\.(md|txt)$/i.test(entry.uri)
      && !String(entry.rel_path ?? '').split('/').some((part) => part.startsWith('.')))
    .sort((left, right) => String(left.rel_path).localeCompare(String(right.rel_path)));
  if (files.length === 0) throw new OVUnavailableError('nothing readable there yet', 404);
  const parts = [];
  for (const file of files) {
    const content = String(await get(`/content/read?uri=${encodeURIComponent(file.uri)}&offset=0&limit=-1&raw=true`) ?? '');
    parts.push(files.length > 1 ? `## ${file.rel_path}\n\n${content}` : content);
  }
  return parts.join('\n\n');
}

// A sender-chosen file name as one path segment: letters, digits, . _ -.
function safeName(value, max = 80) {
  const clean = String(value ?? '').normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!clean) return 'attachment';
  if (clean.length <= max) return clean;
  const extension = path.extname(clean).slice(0, 12);
  return `${clean.slice(0, max - extension.length)}${extension}`;
}

function extensionOf(filename) {
  return path.extname(String(filename ?? '')).slice(1).toLowerCase();
}

// Whether OV parses a file of this name and type.
export function parsesAttachment({ filename, type }) {
  return PARSED.has(extensionOf(filename)) || Boolean(EXTENSION_FOR[type]);
}

function uploadName({ filename, type }) {
  const name = safeName(filename);
  return PARSED.has(extensionOf(name)) ? name : `${path.basename(name, path.extname(name))}.${EXTENSION_FOR[type]}`;
}

// An OV that cannot be reached, is overloaded or failed: the mail is not
// stored at all. A refusal of one file only loses that file.
function outage(error) {
  return !(error instanceof OVUnavailableError) || error.httpStatus === undefined
    || error.httpStatus === 429 || error.httpStatus >= 500;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class MailArchive {
  static fromConfigFile(file, options) {
    return new MailArchive(new OVConnection(readOVConfig(file)), options);
  }

  constructor(connection, { pollMs = 500, logger = QUIET } = {}) {
    this.connection = connection;
    this.root = mailArchiveRoot(connection.user);
    this.pollMs = pollMs;
    this.logger = logger;
  }

  folder(messageId) {
    return mailFolder(this.root, messageId);
  }

  get(route) {
    return this.connection.json(`/api/v1${route}`).then((data) => data.result);
  }

  async write(uri, content) {
    await this.connection.json('/api/v1/content/write',
      { uri, content, mode: 'replace', wait: false, processing_mode: VECTORS_ONLY });
    return uri;
  }

  // Imports `data` as a file named `name` to exactly `to`; resolves with the task id.
  async importFile(to, { data, name, type }, args = {}) {
    const upload = await this.connection.upload('/api/v1/resources/temp_upload', { data, name, type },
      { timeoutMs: UPLOAD_TIMEOUT_MS });
    const added = await this.connection.json('/api/v1/resources', {
      temp_file_id: upload.result.temp_file_id, to, source_name: name, wait: false,
      processing_mode: VECTORS_ONLY, ...(Object.keys(args).length ? { args } : {}),
    }, { timeoutMs: UPLOAD_TIMEOUT_MS });
    return added.result?.task_id ?? null;
  }

  // A text too long for one vector, split by OV under `to` for recall alone.
  // Nobody waits for it, and its failure loses only recall: it is logged.
  async chunk(to, text, name) {
    if (!needsChunks(text)) return false;
    try {
      await this.importFile(to, { data: Buffer.from(text, 'utf8'), name, type: 'text/markdown' });
      return true;
    } catch (error) {
      this.logger.warn('email_chunks_failed', { error: error.message });
      return false;
    }
  }

  // files: [{ name, filename, type, size, data?, text? }] in mail order. `text`
  // is written as is (a forwarded mail, a text file OV does not parse); `data`
  // is parsed by OV when it can read the format. Either lands in the
  // attachment's full/. Waits until every parsed file has landed or `deadline`
  // passes, then queues chunks of the long ones. Resolves with one entry per
  // file: { id, name, type, size, uri?, status: stored|processing|failed|skipped, reason? }.
  async storeAttachments(folder, files, { deadline }) {
    const entries = [];
    const tasks = new Map();
    const texts = new Map();
    for (const [index, file] of files.entries()) {
      const id = String(index + 1).padStart(2, '0');
      const base = safeName(file.filename);
      const uri = `${folder}/attachments/${id}-${base}`;
      const entry = { id, name: file.name, type: file.type, size: file.size };
      entries.push(entry);
      try {
        if (typeof file.text === 'string') {
          const stored = file.type === 'message/rfc822' ? 'message.md' : `${path.basename(base, path.extname(base))}.txt`;
          await this.write(`${uri}/full/${stored}`, file.text);
          Object.assign(entry, { uri, status: 'stored' });
          texts.set(entry, file.text);
        } else if (file.data && parsesAttachment(file)) {
          const task = await this.importFile(`${uri}/full`, { data: file.data, name: uploadName(file), type: file.type },
            { parse_mode: 'no_split' });
          Object.assign(entry, { uri, status: task ? 'processing' : 'stored' });
          if (task) tasks.set(entry, task);
        } else {
          Object.assign(entry, { status: 'skipped', reason: 'OpenViking does not read this type' });
        }
      } catch (error) {
        if (outage(error)) throw error;
        Object.assign(entry, { status: 'failed', reason: 'OpenViking refused it' });
      }
    }
    await this.land(tasks, deadline);
    // An attachment still being read gets no chunks: its text is not there yet.
    for (const entry of entries.filter(({ status }) => status === 'stored')) {
      let text = texts.get(entry);
      if (text === undefined) {
        try {
          text = await readStoredText((route) => this.get(route), `${entry.uri}/full`);
        } catch (error) {
          this.logger.warn('email_chunks_failed', { error: error.message });
          continue;
        }
      }
      const base = entry.uri.slice(entry.uri.lastIndexOf('/') + 1).replace(/^\d{2}-/, '');
      await this.chunk(`${entry.uri}/chunks`, text, `${path.basename(base, path.extname(base))}.md`);
    }
    return entries;
  }

  // A parse task has put its file in place once it reaches the vector queue.
  async land(tasks, deadline) {
    while (tasks.size > 0 && Date.now() < deadline) {
      for (const [entry, taskId] of [...tasks]) {
        let task;
        try {
          task = (await this.connection.json(`/api/v1/tasks/${encodeURIComponent(taskId)}`)).result;
        } catch (error) {
          if (outage(error)) throw error;
          continue;
        }
        if (task?.status === 'failed') {
          Object.assign(entry, { status: 'failed', reason: 'OpenViking could not read it' });
          delete entry.uri;
        } else if (task?.status === 'completed' || task?.stage === 'processing_queue') {
          entry.status = 'stored';
        } else {
          continue;
        }
        tasks.delete(entry);
      }
      if (tasks.size > 0) await sleep(this.pollMs);
    }
  }
}

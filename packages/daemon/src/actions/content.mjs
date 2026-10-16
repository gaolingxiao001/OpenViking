import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CARD_BYTES = 30 * 1024;

export const CONTENT_PROPERTIES = {
  markdown: { type: 'string', minLength: 1, description: 'Message text (Markdown where the connector supports it). Mutually exclusive with file_path/file_key/card/choices.' },
  file_path: { type: 'string', minLength: 1, description: 'Local file relative to the agent workspace, at most 20 MiB; images are sent as images. No URLs, absolute paths, traversal, or symlinks escaping the workspace.' },
  file_key: { type: 'string', pattern: '^file_[A-Za-z0-9_-]{8,}$', description: 'Lark only: existing IM file key from trusted tool output, sent without uploading.' },
  card: { type: 'object', description: 'Lark only: inline interactive card JSON (Card 1.0 elements or Card 2.0 body.elements), at most 30 KiB. Callback controls arrive as user input, never executed by the daemon. For a single-choice question prefer choices.' },
  choices: { type: 'object', additionalProperties: false, required: ['prompt', 'options'], description: 'Lark only: a single-choice question card. The selected key later arrives as authenticated card input.', properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 2000 },
    options: { type: 'array', minItems: 2, maxItems: 10, items: {
      type: 'object', additionalProperties: false, required: ['key', 'label'], properties: {
        key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        label: { type: 'string', minLength: 1, maxLength: 100 },
      },
    } },
    answerer_id: { type: 'string', pattern: '^ou_[A-Za-z0-9_-]{8,}$', description: 'Optional user allowed to answer. Defaults to the author of decision_id.' },
    timeout_seconds: { type: 'integer', minimum: 30, maximum: 86400, default: 600 },
  } },
};

const BODY_FIELDS = ['markdown', 'file_path', 'file_key', 'card', 'choices'];

export function choiceCard(question, answer = null) {
  const elements = [{ tag: 'div', text: { tag: 'plain_text', content: question.prompt } }];
  if (answer) {
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: `已选择：${answer.label}` } });
  } else {
    for (let index = 0; index < question.options.length; index += 4) {
      elements.push({ tag: 'action', actions: question.options.slice(index, index + 4).map((option) => ({
        tag: 'button', text: { tag: 'plain_text', content: option.label }, type: 'default',
        value: { vika_choice: option.key },
      })) });
    }
  }
  return { config: { wide_screen_mode: true, update_multi: true }, elements };
}

function validateCard(card) {
  if (card.schema && card.schema !== '2.0'
    || !Array.isArray(card.schema === '2.0' ? card.body?.elements : card.elements)) {
    throw new Error('card must be an inline Card 1.0 or Card 2.0 object with elements');
  }
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json) > MAX_CARD_BYTES) throw new Error('card exceeds 30 KiB');
  // Raw card mentions would bypass the typed mention resolver and could @all.
  if (/<at\b/i.test(json) || /"tag"\s*:\s*"at"/i.test(json)) {
    throw new Error('raw card mention tags are unsupported; use a separate explicit message');
  }
  return json;
}

function readWorkspaceFile(relative, workspace) {
  if (path.isAbsolute(relative) || relative.includes('\0') || relative.includes('\\')
    || relative.split('/').includes('..') || /^[a-z]+:/i.test(relative)) {
    throw new Error('file_path must be relative to the workspace without traversal or URLs');
  }
  const root = fs.realpathSync(workspace);
  const filename = fs.realpathSync(path.resolve(root, relative));
  if (!filename.startsWith(root + path.sep)) throw new Error('file_path escapes the workspace');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
      throw new Error('file must be a nonempty regular file of at most 20 MiB');
    }
    // Bound the read even if another process grows the file after fstat.
    const bytes = Buffer.alloc(stat.size);
    const size = fs.readSync(fd, bytes, 0, stat.size, 0);
    if (size !== stat.size) throw new Error('file changed while it was being read');
    return { name: path.basename(filename), bytes };
  } finally { fs.closeSync(fd); }
}

// Resolves exactly one message body into the Connector payload, the canonical
// form hashed into the idempotency key, and a journal summary. A file is frozen
// into a private snapshot so the upload cannot change after validation; the
// caller must call cleanup() once the delivery attempt is over.
export function resolveContent(input, { workspace, snapshotDir, maxTextChars }) {
  const present = BODY_FIELDS.filter((key) => input[key] !== undefined);
  if (present.length !== 1) {
    throw new Error(present.length
      ? 'provide exactly one of markdown, file_path, file_key, card, or choices'
      : 'a message body is required: markdown, file_path, file_key, card, or choices');
  }
  const kind = present[0];
  const value = input[kind];
  const none = () => {};
  if (kind === 'markdown') {
    if (typeof value !== 'string' || !value.trim()) throw new Error('markdown must not be empty');
    if (value.length > maxTextChars) throw new Error(`text exceeds the ${maxTextChars}-character limit`);
    return { type: 'markdown', payload: { type: 'markdown', text: value }, canonical: ['markdown', value], summary: value, cleanup: none };
  }
  if (input.mention_names?.length || input.mention_user_ids?.length) {
    throw new Error('mentions are supported only with markdown bodies');
  }
  if (kind === 'file_key') {
    return { type: 'file_key', payload: { type: 'file_key', key: value }, canonical: ['file_key', value], summary: '[file attachment]', cleanup: none };
  }
  if (kind === 'file_path') {
    const { name, bytes } = readWorkspaceFile(value, workspace);
    const digest = createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(snapshotDir, 'upload-'));
    const snapshot = path.join(directory, name);
    fs.writeFileSync(snapshot, bytes, { mode: 0o600 });
    return {
      type: 'file', payload: { type: 'file', path: snapshot, name }, canonical: ['file', name, digest],
      summary: `[file ${name}]`, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
    };
  }
  if (kind === 'choices') {
    const keys = new Set(value.options.map((option) => option.key));
    if (keys.size !== value.options.length) throw new Error('choices options require unique keys');
    const question = {
      prompt: value.prompt, options: value.options.map(({ key, label }) => ({ key, label })),
      answerer_id: value.answerer_id, timeout_seconds: value.timeout_seconds ?? 600,
    };
    const card = choiceCard(question);
    return { type: 'card', payload: { type: 'card', card }, canonical: ['choices', question],
      summary: `[question] ${question.prompt}`, question, cleanup: none };
  }
  const json = validateCard(value);
  return { type: 'card', payload: { type: 'card', card: value }, canonical: ['card', json], summary: '[interactive card]', cleanup: none };
}

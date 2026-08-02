import { lookupMemberName } from './roster.mjs';

const HISTORY_SEPARATOR = '--- history above, new messages below ---';

export const COGNITION_CATCHUP_SENTINEL =
  '--- daemon cognition catch-up complete; absorb the journal, take no external action, and end this turn ---';

export class CognitionLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CognitionLimitError';
  }
}

function oneLine(value) {
  return String(value ?? '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' \u23CE ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function isoMinute(ms) {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

function chatTag(chatId, threadId) {
  if (!threadId) return chatId || 'unknown';
  const short = /^([a-z]{1,4}_)(.+)$/.exec(threadId);
  return `${chatId || 'unknown'} thread=${short ? short[1] + short[2].slice(0, 8) : threadId.slice(0, 11)}`;
}

function shortId(id) {
  if (!id) return 'unknown';
  const match = /^([a-z]{1,4}_)(.+)$/.exec(id);
  return match ? match[1] + match[2].slice(0, 8) : String(id).slice(0, 11);
}

export function formatCognitionJournalLine(item) {
  if (item.kind === 'inbound') {
    const from = lookupMemberName(item.chatId, item.actor) ?? shortId(item.actor);
    return `[chat=${chatTag(item.chatId, item.threadId)} msg=${item.messageId}`
      + ` time=${isoMinute(item.atMs)} from=${from}] ${oneLine(item.text)}`;
  }
  if (item.kind === 'outbound') {
    // PENDING means the external action may already have happened. Render it
    // conservatively until it settles or startup recovery marks it UNCERTAIN.
    const status = item.status === 'COMMITTED' ? '' : ' outcome=uncertain';
    return `[chat=${chatTag(item.chatId, item.threadId)} time=${isoMinute(item.atMs)} from=me${status}]`
      + ` ${oneLine(item.text)}`;
  }
  return `[daemon time=${isoMinute(item.atMs)} kind=${oneLine(item.kind)}] ${oneLine(item.text)}`;
}

// Runtime-native transcripts are intentionally not transferable. The journal is
// the canonical observable conversation: accepted inbound lines, successful or
// uncertain Lark actions, and daemon control changes. Hidden reasoning and
// non-Lark tool output are not invented during handoff.
function assertBounded(text, maxChars) {
  if (text.length > maxChars) {
    throw new CognitionLimitError(
      `cognition journal is ${text.length} chars, above the ${maxChars}-char handoff limit; run /new or compact the journal before switching runtime`,
    );
  }
  return text;
}

export function cognitionCatchupPrompt(
  store,
  epoch,
  throughSeq = store.cognitionJournalHead(epoch),
  maxChars = 120_000,
) {
  const journal = store.cognitionJournal(epoch, throughSeq).map(formatCognitionJournalLine);
  const preface = [
    `--- daemon cognition journal: epoch=${epoch} through=${throughSeq} ---`,
    'This ordered journal is the cross-runtime authority for observable conversation state.',
    'It does not contain hidden reasoning or opaque non-Lark tool output; inspect the shared workspace when work state matters.',
  ];
  return {
    throughSeq,
    text: assertBounded(
      [...preface, ...journal, HISTORY_SEPARATOR, COGNITION_CATCHUP_SENTINEL].join('\n'),
      maxChars,
    ),
  };
}

export function cognitionHistoryPrefix(
  store,
  epoch,
  throughSeq = store.cognitionJournalHead(epoch),
  maxChars = 120_000,
  afterSeq = 0,
) {
  const journal = store.cognitionJournal(epoch, throughSeq, afterSeq).map(formatCognitionJournalLine);
  return {
    throughSeq,
    text: assertBounded([
      `--- daemon cognition journal: epoch=${epoch} after=${afterSeq} through=${throughSeq} ---`,
      'This ordered journal is the cross-runtime authority for observable conversation state.',
      'It does not contain hidden reasoning or opaque non-Lark tool output; inspect the shared workspace when work state matters.',
      ...journal,
      HISTORY_SEPARATOR,
    ].join('\n'), maxChars),
  };
}

export { HISTORY_SEPARATOR };

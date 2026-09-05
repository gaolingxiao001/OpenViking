import { lookupMemberName } from './roster.mjs';
import { chatTag, isoMinute, oneLine, shortenId } from './runtime-input.mjs';

const HISTORY_SEPARATOR = '--- history above, new messages below ---';

export const COGNITION_CATCHUP_SENTINEL =
  '--- daemon cognition catch-up complete; absorb the journal, take no external action, and end this turn ---';

export class CognitionLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CognitionLimitError';
  }
}

export function formatCognitionJournalLine(item) {
  if (item.kind === 'inbound') {
    const from = lookupMemberName(item.chatId, item.actor) ?? shortenId(item.actor);
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
  { excludeCommittedOutboundFrom = null } = {},
) {
  const journal = store
    .cognitionJournal(epoch, throughSeq, afterSeq, { excludeCommittedOutboundFrom })
    .map(formatCognitionJournalLine);
  // A delta whose only rows were the runtime's own committed deliveries has
  // nothing to teach the model; advance the cursor without paying for a header.
  if (afterSeq > 0 && journal.length === 0) return { throughSeq, text: '' };
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

// A delivery that speaks for the owner (a mail reply) is never sent by the
// model. The Core puts the draft on a card in the owner's direct chat, and only
// the owner's press on that card sends it, with any edits made there. The card
// is registered as a question answered once by the owner; the draft rides in it.

// Lark inputs hold at most 1000 characters; a longer draft is shown read-only.
export const EDITABLE_CHARS = 1_000;
const APPROVAL_SECONDS = 3 * 24 * 60 * 60;
const BODY_FIELD = 'reply_body';

function text(content) {
  return { tag: 'plain_text', content };
}

// Lark refuses a bot message that contains an email address (code 230028), so
// a card shows every @ as a full-width ＠: exact, but not an address. The text
// the owner sends back is turned into plain @ again.
function shown(value) {
  return value.replace(/@/g, '＠');
}

function people(list) {
  return list.map(({ name, address }) => (name ? `${name} <${address}>` : address)).join(', ') || '（无收件人）';
}

function header(title, template) {
  return { title: text(title), template };
}

function button(label, choice, primary = false) {
  return {
    tag: 'button', name: choice, text: text(label), type: primary ? 'primary' : 'default',
    behaviors: [{ type: 'callback', value: { vika_choice: choice } }],
  };
}

// Everything from the mail is shown as plain text: a subject or a name cannot
// turn into a link or a mention.
function details(draft) {
  return { tag: 'div', text: text(shown(`收件人：${people(draft.to)}\n主题：${draft.subject}`)) };
}

export function approvalQuestion(draft, ownerId) {
  return {
    kind: 'approval',
    prompt: `Send this reply to ${draft.subject}`,
    options: [{ key: 'send', label: '发送' }, { key: 'cancel', label: '不发了' }],
    answerer_id: ownerId,
    timeout_seconds: APPROVAL_SECONDS,
    draft,
  };
}

// The card the owner answers: an editable draft, or a read-only one when too
// long to edit there.
export function approvalCard(draft) {
  const editable = draft.text.length <= EDITABLE_CHARS;
  const elements = [details(draft)];
  if (editable) {
    elements.push({
      tag: 'form', name: 'approval',
      elements: [
        { tag: 'input', name: BODY_FIELD, input_type: 'multiline_text', rows: 6, auto_resize: true, max_rows: 20,
          max_length: EDITABLE_CHARS, width: 'fill', default_value: shown(draft.text), label: text('回信内容（可以直接修改）') },
        { ...button('发送', 'send', true), form_action_type: 'submit' },
      ],
    });
  } else {
    elements.push({ tag: 'div', text: text(shown(draft.text)) });
    elements.push({ tag: 'div', text: text(`草稿超过 ${EDITABLE_CHARS} 字，不能在卡片上修改；要改的话直接告诉我。`) });
    elements.push(button('发送', 'send', true));
  }
  elements.push(button('不发了', 'cancel'));
  return {
    schema: '2.0', config: { update_multi: true },
    header: header('确认回复邮件', 'blue'),
    body: { elements },
  };
}

// The text the owner approved: what they left in the input, else the draft.
export function approvedText(draft, form) {
  const edited = typeof form?.[BODY_FIELD] === 'string' ? form[BODY_FIELD].trim().replace(/＠/g, '@') : '';
  return edited || draft.text;
}

const SETTLED = {
  sent: ['已发送', 'green'],
  cancelled: ['已取消，没有发送', 'grey'],
  failed: ['没有发出', 'red'],
  uncertain: ['发送结果不确定', 'orange'],
};

// What the card shows once answered. `note` explains a failure.
export function settledApprovalCard(draft, { state, text: sent = draft.text, note = null }) {
  const [title, template] = SETTLED[state];
  return {
    schema: '2.0', config: { update_multi: true },
    header: header(title, template),
    body: { elements: [
      details(draft),
      { tag: 'div', text: text(shown(sent)) },
      ...(note ? [{ tag: 'div', text: text(note) }] : []),
    ] },
  };
}

const NOTES = {
  sent: 'mail reply sent',
  cancelled: 'mail reply cancelled',
  failed: 'mail reply not sent',
  uncertain: 'mail reply outcome uncertain',
};

// What the model is told once the owner has answered: the text that actually
// went out (the owner may have edited it), or that nothing did and why.
export function approvalNote(draft, settled) {
  return `[${NOTES[settled.state]}] ${JSON.stringify({
    subject: draft.subject,
    to: draft.to.map(({ name, address }) => (name ? `${name} <${address}>` : address)),
    ...(settled.state === 'cancelled' ? {} : { text: settled.text ?? draft.text }),
    ...(settled.edited ? { edited_by_owner: true } : {}),
    ...(settled.note ? { note: settled.note } : {}),
  })}`;
}

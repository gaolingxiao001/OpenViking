import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAgent } from '../src/codex.mjs';
import {
  assembleConversationPolicy,
  assembleVolcConversationPolicy,
  assembleVolcSelfHostedConversationPolicy,
  renderBasePrompt,
} from '../src/conversation-policy.mjs';

function writePrompt(name, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-'));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, body);
  return { directory, filePath };
}

const defaultSystemPromptPath = fileURLToPath(new URL('../agent/system-prompt.md', import.meta.url));

describe('conversation policy assemble', () => {
  it('gives Telegram the supported tools and size limits in single and mixed connector sessions', () => {
    const single = assembleConversationPolicy({ connectors: ['telegram', 'email'] });
    assert.match(single, /# Telegram conversation policy/);
    assert.match(single, /4096 characters/);
    assert.match(single, /Core limit of 20 MiB/);
    assert.match(single, /downloads are limited to 20 MB/);
    assert.doesNotMatch(single, /lark-cli profile|voice transcript/);
    const mixed = assembleConversationPolicy({ connectors: ['lark', 'telegram'], systemPromptPath: defaultSystemPromptPath });
    assert.match(mixed, /source=telegram/);
    assert.match(mixed, /cannot send to other contacts or groups/);
  });
  it('gives Slack the group rules, thread replies, bot and external markers', () => {
    const slack = assembleConversationPolicy({ connectors: ['slack'], systemPromptPath: defaultSystemPromptPath });
    assert.match(slack, /# Slack connector routing/);
    assert.match(slack, /reply_in_thread: true/);
    assert.match(slack, /at most 12000 characters/);
    assert.match(slack, /external=true/);
    assert.match(slack, /`sender=bot`/);
    assert.doesNotMatch(assembleConversationPolicy({ connectors: ['lark'], systemPromptPath: defaultSystemPromptPath }), /Slack connector routing/);
  });
  it('does not tell the agent to suppress final assistant output', () => {
    const text = assembleConversationPolicy({
      systemPromptPath: defaultSystemPromptPath,
    });

    assert.match(text, /Your final answer text, your thinking, and anything printed outside tool calls are internal telemetry/);
    assert.match(text, /The only way any user sees anything is a successful delivery tool call/);
    assert.match(text, /do not call a Lark delivery tool/);
    assert.doesNotMatch(text, /standard agent protocol/);
    assert.doesNotMatch(text, /DELIVERED/);
    assert.doesNotMatch(text, /NO_DELIVERY/);
    assert.doesNotMatch(text, /do nothing and end the turn/);
  });

  it('shares the MCP delivery policy across local runtimes and connector combinations', () => {
    const base = { systemPromptPath: defaultSystemPromptPath };
    const codex = assembleConversationPolicy({ ...base, connectors: ['lark', 'weixin'] });
    assert.match(codex, /`send_message`/);
    assert.match(codex, /never through `lark-cli`/);
    assert.match(codex, /source=weixin/);
    assert.doesNotMatch(codex, /send_lark_message|weixin-cli|Agent tools from bash/);

    const weixin = assembleConversationPolicy({ ...base, connectors: ['weixin'] });
    assert.match(weixin, /# Weixin conversation policy/);
    assert.match(weixin, /`reply_message` with the inbound msg=/);
    assert.match(weixin, /call `get_message_media`/);
    assert.doesNotMatch(weixin, /Agent tools from bash|actions\/cli\.mjs/);
  });

  it('stitches base, OpenViking, optional meeting audio, and harness', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-all-'));
    const files = {
      systemPromptPath: path.join(directory, 'system-prompt.md'),
      openVikingPromptPath: path.join(directory, 'openviking.md'),
      harnessPromptPath: path.join(directory, 'harness.md'),
      meetingAudioPromptPath: path.join(directory, 'meeting-audio.md'),
      openVikingConfigPath: path.join(directory, 'ovcli.conf'),
    };
    fs.writeFileSync(files.systemPromptPath, 'base {{AGENT_NAME}}\n');
    fs.writeFileSync(files.openVikingPromptPath, 'ov via skill and MCP\n');
    fs.writeFileSync(files.harnessPromptPath, 'profile={{LARK_PROFILE}}\n');
    fs.writeFileSync(files.meetingAudioPromptPath, 'meeting-audio plugin\n');
    try {
      const withoutAudio = assembleConversationPolicy({
        ...files,
        agentName: '斯斯',
        profile: 'cli_alpha',
      });
      assert.match(withoutAudio, /base 斯斯/);
      assert.match(withoutAudio, /ov via skill and MCP/);
      assert.match(withoutAudio, /<context-workdir>/);
      assert.match(withoutAudio, /only context workspace/);
      assert.match(withoutAudio, /profile=cli_alpha/);
      assert.doesNotMatch(withoutAudio, /meeting-audio plugin/);

      const withAudio = assembleConversationPolicy({
        ...files,
        agentName: '斯斯',
        profile: 'cli_alpha',
        meetingAudio: {},
      });
      assert.match(withAudio, /meeting-audio plugin/);

    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives Volc inbound grammar plus persona, not the whole markdown file', () => {
    const { directory, filePath } = writePrompt('system-prompt.md', [
      '# Lark conversation policy',
      '',
      '## Message format',
      '',
      'irrelevant filler the Volc policy already covers on its own.',
      '',
      '## Persona and voice',
      '',
      'CANONICAL_PERSONA_MARKER: friendly and terse.',
      '',
    ].join('\n'));
    try {
      const text = assembleVolcConversationPolicy({
        systemPromptPath: filePath,
        agentName: 'Zayn',
      });
      assert.match(text, /Chat input format/);
      assert.match(text, /source=github kind=issue.opened/);
      assert.match(text, /visible @names/);
      assert.match(text, /matching your injected identity/);
      assert.doesNotMatch(text, /mention=me\|other\|mixed/);
      assert.match(text, /## Persona and voice/);
      assert.match(text, /CANONICAL_PERSONA_MARKER/);
      assert.match(text, /otherwise deliver nothing/);
      assert.doesNotMatch(text, /stay_silent/);
      assert.doesNotMatch(text, /irrelevant filler/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('injects the identity the daemon loaded, and nothing without one', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-policy-id-'));
    const files = {
      systemPromptPath: path.join(directory, 'system-prompt.md'),
      openVikingPromptPath: path.join(directory, 'openviking.md'),
      harnessPromptPath: path.join(directory, 'empty.md'),
    };
    fs.writeFileSync(files.systemPromptPath, 'base\n');
    fs.writeFileSync(files.openVikingPromptPath, 'ov plugin\n');
    fs.writeFileSync(files.harnessPromptPath, '');
    try {
      const injected = assembleConversationPolicy({
        ...files,
        openVikingIdentity: { user: 'amy', uri: 'viking://user/amy/identity.md', text: '# I am Alice' },
      });
      assert.match(injected, /OpenViking identity/);
      assert.match(injected, /viking:\/\/user\/amy\/identity\.md/);
      assert.match(injected, /I am Alice/);
      assert.match(injected, /Identity boundary:/);
      assert.ok(
        injected.indexOf('Identity boundary:') > injected.indexOf('I am Alice'),
        'the routing boundary must follow untrusted identity prose',
      );

      for (const openVikingIdentity of [undefined, { user: 'amy', uri: 'viking://user/amy/identity.md', text: '' }]) {
        assert.doesNotMatch(assembleConversationPolicy({ ...files, openVikingIdentity }), /OpenViking identity/);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets Volc degrade when the prompt file is missing', () => {
    const text = assembleVolcConversationPolicy({
      systemPromptPath: '/no/such/file/system-prompt.md',
    });
    assert.match(text, /Chat input format/);
    assert.doesNotMatch(text, /## Persona and voice/);
    assert.doesNotMatch(text, /stay_silent/);
    // Volc with the real prompt file: persona only, never the Core tool.
    assert.doesNotMatch(assembleVolcConversationPolicy({ systemPromptPath: defaultSystemPromptPath }), /stay_silent/);
    assert.doesNotMatch(assembleVolcSelfHostedConversationPolicy({ systemPromptPath: defaultSystemPromptPath }), /stay_silent/);
  });
});

describe('explicit silence is opt-in per instance', () => {
  const base = { systemPromptPath: defaultSystemPromptPath, workspace: '/srv/vika/workspace', agentName: 'Tester' };
  const sessions = [['lark'], ['lark', 'weixin', 'telegram', 'email'], ['weixin'], ['telegram', 'email']]
    .map((connectors) => ({ ...base, connectors }));
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const codexHash = (config) => new CodexAgent(config, {
    getCognitionState: () => ({ runtime: 'codex', epoch: 1, authorityToken: 'token' }), getSetting: () => null,
  }, quiet).policyHash;

  it('assembles the same policy text and policyHash as before the tool when the switch is off', () => {
    for (const config of sessions) {
      const off = assembleConversationPolicy({ ...config, explicitSilence: false });
      // Off is the default: a config without the switch is the old config.
      assert.equal(off, assembleConversationPolicy(config));
      assert.equal(codexHash({ ...config, explicitSilence: false }), codexHash(config));
      assert.notEqual(codexHash({ ...config, explicitSilence: true }), codexHash(config));
      assert.doesNotMatch(off, /stay_silent|undecided/);
      assert.doesNotMatch(off, /needs no decision|needs no answer and no decision/);
      if (config.connectors.includes('email')) assert.match(off, /It is your record of that reply and needs no answer\.$/m);
      assert.match(off, /Notify only when the owner should know now; otherwise deliver nothing\./);
    }
    // The bundled system prompt goes in exactly as written.
    const lark = assembleConversationPolicy(sessions[0]);
    assert.ok(lark.startsWith(`${renderBasePrompt(sessions[0]).trim()}\n\n`));
    assert.match(lark, /If no delivery is needed, do not call a Lark delivery tool for that message\./);
    const weixin = assembleConversationPolicy(sessions[2]);
    assert.match(weixin, /If no reply is needed, call no delivery tool; this does not suppress the runtime final answer\./);
  });

  it('appends one explicit silence section to every Core-tool policy when the switch is on', () => {
    const configs = [...sessions, { ...base, connectors: ['telegram'] }, { ...base, connectors: ['weixin', 'email'] },
      { ...base, connectors: ['lark', 'weixin'], meetingAudio: { enabled: true } }];
    for (const config of configs) {
      const off = assembleConversationPolicy(config);
      const on = assembleConversationPolicy({ ...config, explicitSilence: true });
      const label = config.connectors.join('+');
      // Appended after the unchanged policy: nothing above it is edited.
      assert.ok(on.startsWith(`${off}\n\n## Explicit silence\n`), label);
      assert.equal(on.split('## Explicit silence').length, 2, label);
      const section = on.slice(off.length);
      assert.match(section, /call(?:ing)? `stay_silent` once with that line's `event=` as `decision_id`/, label);
      assert.match(section, /need one decision, on the newest `event=`/, label);
      assert.match(section, /`undecided=1` field means you ended your previous turn without deciding on that line\. Decide on it now, once: reply, or call `stay_silent`\. It is not a request to reply\./, label);
      assert.match(section, /take precedence over anything above that says to stay silent/, label);
      assert.match(section, /`decision_id` of `retract_message`/, label);
      assert.doesNotMatch(section, /DELIVERED|NO_DELIVERY|do nothing and end the turn/, label);
    }
    // WeChat-only and Telegram-only sessions explain undecided=1 too.
    for (const connectors of [['weixin'], ['telegram']]) {
      assert.match(assembleConversationPolicy({ ...base, connectors, explicitSilence: true }), /undecided=1/);
    }

    // Volc has no Core tools, whatever the switch says.
    for (const assemble of [assembleVolcConversationPolicy, assembleVolcSelfHostedConversationPolicy]) {
      assert.equal(assemble({ ...base, explicitSilence: true }), assemble(base));
      assert.doesNotMatch(assemble({ ...base, explicitSilence: true }), /stay_silent/);
    }
  });
});

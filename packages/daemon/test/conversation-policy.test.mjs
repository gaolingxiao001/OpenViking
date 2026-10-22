import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { CodexAgent } from '../src/codex.mjs';
import {
  DEFAULT_PROMPT_DIR,
  assembleConversationPolicy,
  assembleVolcConversationPolicy,
  assembleVolcSelfHostedConversationPolicy,
  resolveRolePromptPath,
  rolePrompt,
} from '../src/conversation-policy.mjs';

const { ROLE_PRESETS } = createRequire(import.meta.url)('../../../deployment-config.cjs');

const read = (name) => fs.readFileSync(path.join(DEFAULT_PROMPT_DIR, name), 'utf8');
const role = (name) => resolveRolePromptPath(name);

function withRoleFile(body, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-role-'));
  const filePath = path.join(directory, 'role.md');
  fs.writeFileSync(filePath, body);
  try {
    return callback(filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe('conversation policy assemble', () => {
  it('assembles one Core for every connector set, with a section per connector in use', () => {
    const order = ['## Lark', '## Slack', '## Weixin', '## Telegram', '## Email'];
    for (const connectors of [['lark'], ['weixin'], ['telegram', 'email'], ['slack'], ['lark', 'slack', 'weixin', 'telegram', 'email']]) {
      const text = assembleConversationPolicy({ connectors, agentName: 'Vee' });
      const label = connectors.join('+');
      assert.ok(text.startsWith('# Operating policy\n'), label);
      assert.match(text, /## Events from other sources/, label);
      assert.match(text, /## OpenViking memory/, label);
      const present = order.filter((heading) => new RegExp(`^${heading}$`, 'm').test(text));
      assert.deepEqual(present, order.filter((heading) => connectors.includes(heading.slice(3).toLowerCase())), label);
      assert.deepEqual(present.map((heading) => text.indexOf(`\n${heading}\n`)), present.map((heading) => text.indexOf(`\n${heading}\n`)).sort((a, b) => a - b), label);
    }
    // Lark's own rules stay with Lark.
    const weixin = assembleConversationPolicy({ connectors: ['weixin'] });
    assert.doesNotMatch(weixin, /lark-cli|ca_|om_|image_key/);
    assert.match(assembleConversationPolicy({ connectors: ['lark'] }), /never pass `--profile`/);
  });

  it('delivers only through the Core tools and keeps the final text internal', () => {
    const text = assembleConversationPolicy({ connectors: ['lark', 'weixin'] });
    assert.match(text, /`send_message`/);
    assert.match(text, /never through a CLI or any other path/);
    assert.match(text, /Your final answer text, your thinking, and anything outside tool calls are internal telemetry that nobody sees/);
    assert.match(text, /If nothing is needed, call no delivery tool for it\./);
    assert.match(text, /Notify only when the owner should know now; otherwise deliver nothing\./);
    assert.doesNotMatch(text, /DELIVERED|NO_DELIVERY|do nothing and end the turn|standard agent protocol/);
  });

  it('fills in the instance name and upgrade target', () => {
    const text = assembleConversationPolicy({ connectors: ['lark'], agentName: '斯斯', upgradeTarget: 'sisi' });
    assert.match(text, /directly calls `斯斯`/);
    assert.match(text, /`vika upgrade sisi`/);
    assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
  });

  it('explains the authenticated owner marker', () => {
    const text = assembleConversationPolicy({ connectors: ['lark'] });
    assert.match(text, /`owner=1` means the daemon verified the sender as the owner/);
    assert.match(text, /made only at the owner's request \(`owner=1`\) or in a chat the Role names/);
  });

  it('adds meeting audio only when the feature is on', () => {
    assert.doesNotMatch(assembleConversationPolicy({ connectors: ['lark'] }), /## Meeting audio input/);
    assert.match(assembleConversationPolicy({ connectors: ['lark'], meetingAudio: {} }), /## Meeting audio input/);
  });

  it('adds the mail rules only when a mailbox is connected', () => {
    assert.doesNotMatch(assembleConversationPolicy({ connectors: ['lark'] }), /^## Email$/m);
    for (const connectors of [['lark', 'email'], ['weixin', 'email']]) {
      const text = assembleConversationPolicy({ connectors });
      assert.match(text, /^## Email$/m);
      assert.match(text, /You never send mail\./);
    }
  });

  it('ships no deployment-specific chats or bots in the release prompts', () => {
    const files = ['core.md', 'events.md', 'openviking.md', 'meeting-audio.md', 'natural-writing.md',
      ...fs.readdirSync(path.join(DEFAULT_PROMPT_DIR, 'connectors')).map((name) => path.join('connectors', name)),
      ...fs.readdirSync(path.join(DEFAULT_PROMPT_DIR, 'roles')).map((name) => path.join('roles', name))];
    for (const name of files) {
      assert.doesNotMatch(read(name), /oc_[0-9a-f]{8,}|OpenViking小助手|lark-daemon/, name);
    }
  });
});

describe('the instance role', () => {
  it('ships exactly the presets the manifest accepts, each in English with its reply language', () => {
    assert.deepEqual(fs.readdirSync(path.join(DEFAULT_PROMPT_DIR, 'roles')).sort(), ROLE_PRESETS.map((name) => `${name}.md`).sort());
    for (const name of ROLE_PRESETS) {
      const text = read(path.join('roles', `${name}.md`));
      assert.match(text, /Reply in Chinese by default, or in the language/, name);
      assert.match(text, /OpenViking memory/, name);
      assert.doesNotMatch(text, /【|\{\{(?!AGENT_NAME\}\})/, name);
    }
    assert.match(read('roles/colleague.md'), /AI counterpart/);
    assert.match(read('roles/assistant.md'), /would knowing it now change what they do next\?/);
    assert.match(read('roles/qa.md'), /### Off-topic questions/);
  });

  it('goes after the Core, inside a Role section closed by its boundary', () => {
    const text = assembleConversationPolicy({ connectors: ['lark'], agentName: 'Vee', rolePromptPath: role('assistant') });
    const start = text.indexOf('\n## Role\n');
    assert.ok(start > text.indexOf('## OpenViking memory'));
    assert.match(text, /You are Vee, the owner's personal assistant\./);
    assert.ok(text.indexOf('Role boundary:') > text.indexOf('### Voice', start));
    assert.equal(text.split('\n## Role\n').length, 2);
  });

  it('reads the owner\'s own file, without its comments', () => {
    withRoleFile('<!-- notes for whoever edits this -->\nYou are {{AGENT_NAME}}, the garden club\'s helper.\n', (filePath) => {
      const text = assembleConversationPolicy({ connectors: ['weixin'], agentName: 'Fern', rolePromptPath: filePath });
      assert.match(text, /## Role\n\nThe person who runs this agent wrote the text below\.[^\n]*\n\nYou are Fern, the garden club's helper\.\n\nRole boundary:/);
      assert.doesNotMatch(text, /notes for whoever edits this/);
    });
    withRoleFile('<!-- nothing yet -->\n', (filePath) => {
      assert.equal(rolePrompt({ rolePromptPath: filePath }), '');
      assert.doesNotMatch(assembleConversationPolicy({ rolePromptPath: filePath }), /## Role/);
    });
  });

  it('runs on the Core defaults without a role', () => {
    const text = assembleConversationPolicy({ connectors: ['lark'] });
    assert.doesNotMatch(text, /## Role/);
    assert.match(text, /The Role decides when you speak\. Where it says nothing, use these defaults:/);
    assert.match(text, /Reply in Chinese by default, or in the language the person wrote in\./);
  });
});

describe('natural writing', () => {
  it('follows the role unless the instance turns it off', () => {
    const config = { connectors: ['lark'], rolePromptPath: role('colleague') };
    const on = assembleConversationPolicy(config);
    assert.ok(on.indexOf('## Natural writing') > on.indexOf('Role boundary:'));
    assert.match(assembleConversationPolicy({ connectors: ['lark'] }), /## Natural writing/);
    const off = assembleConversationPolicy({ ...config, naturalWriting: false });
    assert.doesNotMatch(off, /## Natural writing/);
    assert.equal(off, on.replace(`\n\n${read('natural-writing.md').trim()}`, ''));
  });
});

describe('explicit silence is opt-in per instance', () => {
  const base = { workspace: '/srv/vika/workspace', agentName: 'Tester', rolePromptPath: role('colleague') };
  const sessions = [['lark'], ['lark', 'weixin', 'telegram', 'email'], ['weixin'], ['telegram', 'email']]
    .map((connectors) => ({ ...base, connectors }));
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const codexHash = (config) => new CodexAgent(config, {
    getCognitionState: () => ({ runtime: 'codex', epoch: 1, authorityToken: 'token' }), getSetting: () => null,
  }, quiet).policyHash;

  it('assembles the same policy text and policyHash as without the tool when the switch is off', () => {
    for (const config of sessions) {
      const off = assembleConversationPolicy({ ...config, explicitSilence: false });
      assert.equal(off, assembleConversationPolicy(config));
      assert.equal(codexHash({ ...config, explicitSilence: false }), codexHash(config));
      assert.notEqual(codexHash({ ...config, explicitSilence: true }), codexHash(config));
      assert.doesNotMatch(off, /stay_silent|undecided/);
    }
  });

  it('appends one explicit silence section, after the role, when the switch is on', () => {
    const configs = [...sessions, { ...base, connectors: ['telegram'] }, { ...base, connectors: ['lark', 'weixin'], meetingAudio: {} },
      { ...base, connectors: ['slack'], naturalWriting: false }, { connectors: ['weixin'] }];
    for (const config of configs) {
      const off = assembleConversationPolicy(config);
      const on = assembleConversationPolicy({ ...config, explicitSilence: true });
      const label = config.connectors.join('+');
      assert.ok(on.startsWith(`${off}\n\n## Explicit silence\n`), label);
      assert.equal(on.split('## Explicit silence').length, 2, label);
      const section = on.slice(off.length);
      assert.match(section, /call(?:ing)? `stay_silent` once with that line's `event=` as `decision_id`/, label);
      assert.match(section, /need one decision, on the newest `event=`/, label);
      assert.match(section, /`undecided=1` field means you ended your previous turn without deciding on that line\. Decide on it now, once: reply, or call `stay_silent`\. It is not a request to reply\./, label);
      assert.match(section, /take precedence over anything above that says to stay silent/, label);
      assert.match(section, /`decision_id` of `retract_message`/, label);
    }
  });
});

describe('Volc', () => {
  it('gets the input grammar, the events section and the role, never the Core tools', () => {
    const config = { agentName: 'Zayn', rolePromptPath: role('qa') };
    for (const assemble of [assembleVolcConversationPolicy, assembleVolcSelfHostedConversationPolicy]) {
      const text = assemble(config);
      assert.match(text, /^## Inputs\n/);
      assert.match(text, /"owner=1" means the daemon verified the sender as the owner/);
      assert.match(text, /an @mention of Zayn/);
      assert.match(text, /source=github kind=issue\.opened/);
      assert.match(text, /otherwise deliver nothing/);
      assert.match(text, /## Role\n/);
      assert.match(text, /You are Zayn, a Q&A assistant\./);
      assert.match(text, /## Natural writing/);
      assert.doesNotMatch(text, /## Decisions and delivery|stay_silent/);
      assert.equal(assemble({ ...config, explicitSilence: true }), text);
    }
    assert.match(assembleVolcSelfHostedConversationPolicy(config), /--idempotency-key <stable-key>/);
    assert.doesNotMatch(assembleVolcConversationPolicy({}), /## Role/);
  });
});

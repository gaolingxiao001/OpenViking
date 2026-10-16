import readline from 'node:readline';

// Terminal questions for `vika setup`. On a TTY: arrow keys move, space ticks
// a box, enter confirms. Without a TTY (piped input): numbered choices read
// one line at a time, so a script can still answer.

const ESC = '\x1b[';

export class PromptAborted extends Error {
  constructor() {
    super('setup cancelled');
    this.name = 'PromptAborted';
  }
}

export class Prompter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.tty = Boolean(input.isTTY && typeof input.setRawMode === 'function');
    this.lines = null;
    if (this.tty) readline.emitKeypressEvents(input);
  }

  write(text) {
    this.output.write(text);
  }

  async nextLine() {
    this.lines ??= readline.createInterface({ input: this.input, terminal: false })[Symbol.asyncIterator]();
    const { value, done } = await this.lines.next();
    if (done) throw new PromptAborted();
    return value.trim();
  }

  // Resolves with the result of onKey once it returns something other than
  // undefined; raw mode is held only for the duration of one question.
  keys(onKey) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        this.input.off('keypress', handler);
        this.input.setRawMode(false);
        this.input.pause();
        if (error) reject(error); else resolve(value);
      };
      const handler = (str, key = {}) => {
        if (key.ctrl && key.name === 'c') { finish(new PromptAborted()); return; }
        try {
          const value = onKey(str, key);
          if (value !== undefined) finish(null, value);
        } catch (error) {
          finish(error);
        }
      };
      this.input.setRawMode(true);
      this.input.resume();
      this.input.on('keypress', handler);
    });
  }

  async text(question, { initial = '', validate = () => null } = {}) {
    for (;;) {
      const hint = initial ? ` (${initial})` : '';
      this.write(`? ${question}${hint}: `);
      let answer;
      if (this.tty) {
        let buffer = '';
        answer = await this.keys((str, key) => {
          if (key.name === 'return' || key.name === 'enter') { this.write('\n'); return buffer; }
          if (key.name === 'backspace') {
            if (buffer) { buffer = buffer.slice(0, -1); this.write('\b \b'); }
            return undefined;
          }
          if (str && !key.ctrl && !key.meta && str >= ' ') { buffer += str; this.write(str); }
          return undefined;
        });
      } else {
        answer = await this.nextLine();
        this.write('\n');
      }
      const value = answer.trim() || initial;
      const problem = validate(value);
      if (!problem) return value;
      this.write(`  ${problem}\n`);
    }
  }

  async confirm(question, initial = true) {
    const answer = await this.text(`${question} ${initial ? '[Y/n]' : '[y/N]'}`, {
      validate: (value) => (value === '' || /^(y|yes|n|no)$/i.test(value) ? null : '请输入 y 或 n'),
    });
    return answer === '' ? initial : /^y/i.test(answer);
  }

  // choices: [{ label, value, hint?, disabled? }]
  async select(question, choices, { initial = 0 } = {}) {
    const [value] = await this.pick(question, choices, { multiple: false, initial: [initial] });
    return value;
  }

  async multiselect(question, choices, { initial = [], min = 1 } = {}) {
    return this.pick(question, choices, { multiple: true, initial, min });
  }

  async pick(question, choices, { multiple, initial = [], min = 1 }) {
    const enabled = choices.map((choice, index) => (choice.disabled ? -1 : index)).filter((index) => index >= 0);
    if (enabled.length === 0) throw new Error(`${question}: nothing to choose from`);
    const selected = new Set(initial.filter((index) => enabled.includes(index)));
    if (!this.tty) return this.pickByNumber(question, choices, { multiple, selected, min });

    let cursor = enabled.includes(initial[0]) ? initial[0] : enabled[0];
    const help = multiple ? '（↑↓ 移动，空格勾选，回车确认）' : '（↑↓ 移动，回车确认）';
    const lines = () => choices.map((choice, index) => {
      const pointer = index === cursor ? '❯' : ' ';
      const box = multiple ? (selected.has(index) ? '[x] ' : '[ ] ') : '';
      const hint = choice.hint ? `  ${choice.hint}` : '';
      return choice.disabled ? `  ${box}${choice.label}${hint}` : `${pointer} ${box}${choice.label}${hint}`;
    });
    this.write(`? ${question}${help}\n${ESC}?25l${lines().join('\n')}\n`);
    const redraw = (note = '') => {
      this.write(`${ESC}${choices.length + (redraw.noted ? 1 : 0)}A${ESC}0J${lines().join('\n')}\n${note ? `  ${note}\n` : ''}`);
      redraw.noted = Boolean(note);
    };
    const move = (step) => {
      const position = enabled.indexOf(cursor);
      cursor = enabled[(position + step + enabled.length) % enabled.length];
    };
    try {
      return await this.keys((str, key) => {
        if (key.name === 'up' || key.name === 'k') { move(-1); redraw(); return undefined; }
        if (key.name === 'down' || key.name === 'j') { move(1); redraw(); return undefined; }
        if (multiple && key.name === 'space') {
          if (selected.has(cursor)) selected.delete(cursor); else selected.add(cursor);
          redraw();
          return undefined;
        }
        if (key.name === 'return' || key.name === 'enter') {
          if (!multiple) return [choices[cursor].value];
          if (selected.size < min) { redraw(`至少选 ${min} 项`); return undefined; }
          return [...selected].sort((a, b) => a - b).map((index) => choices[index].value);
        }
        return undefined;
      });
    } finally {
      this.write(`${ESC}?25h`);
    }
  }

  async pickByNumber(question, choices, { multiple, selected, min }) {
    this.write(`? ${question}\n`);
    choices.forEach((choice, index) => {
      const hint = choice.hint ? `  ${choice.hint}` : '';
      this.write(`  ${index + 1}) ${choice.label}${hint}${choice.disabled ? '（不可选）' : ''}\n`);
    });
    const fallback = [...selected].map((index) => index + 1).join(',');
    const answer = await this.text(multiple ? '输入编号，多个用逗号分隔' : '输入编号', {
      initial: fallback,
      validate: (value) => {
        const numbers = value.split(/[\s,，]+/).filter(Boolean).map(Number);
        if (numbers.some((number) => !Number.isInteger(number) || !choices[number - 1] || choices[number - 1].disabled)) {
          return '编号无效';
        }
        if (!multiple && numbers.length !== 1) return '只能选一项';
        if (numbers.length < min) return `至少选 ${min} 项`;
        return null;
      },
    });
    return [...new Set(answer.split(/[\s,，]+/).filter(Boolean).map(Number))]
      .sort((a, b) => a - b).map((number) => choices[number - 1].value);
  }

  close() {
    this.lines?.return?.();
  }
}

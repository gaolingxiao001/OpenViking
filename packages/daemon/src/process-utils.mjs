import { spawn } from 'node:child_process';

export function sanitizeNonArkChildEnv(environment) {
  const safeEnv = { ...environment };
  for (const key of Object.keys(safeEnv)) {
    if (/^(?:ARK|VOLCENGINE)_/i.test(key)
      || /^LARK_DAEMON_VOLC_/i.test(key)
      || key === 'SESSION_ID') delete safeEnv[key];
  }
  return safeEnv;
}

export function sanitizeAgentChildEnv(environment, {
  profile = '',
  stripClaudeCode = false,
} = {}) {
  const safeEnv = {
    ...sanitizeNonArkChildEnv(environment),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  for (const key of Object.keys(safeEnv)) {
    if (/^(?:LARK|FEISHU|LARKSUITE)_/i.test(key)
      || (stripClaudeCode && key === 'CLAUDECODE')) delete safeEnv[key];
  }
  if (profile) safeEnv.LARKSUITE_CLI_PROFILE = profile;
  return safeEnv;
}

function appendTail(current, chunk, limit) {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

export function terminateProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

export class ProcessRegistry {
  constructor(logger) {
    this.logger = logger;
    this.children = new Set();
  }

  register(child) {
    this.children.add(child);
    const unregister = () => this.children.delete(child);
    child.once('exit', unregister);
    child.once('error', unregister);
    return child;
  }

  async run(command, args, options = {}) {
    const {
      cwd,
      env = sanitizeNonArkChildEnv(process.env),
      input,
      timeoutMs = 60_000,
      stdoutLimit = 200_000,
      stderrLimit = 200_000,
      onStdoutLine,
    } = options;

    return await new Promise((resolve, reject) => {
      const child = this.register(spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
      let stdout = '';
      let stderr = '';
      let lineBuffer = '';
      let timedOut = false;
      let settled = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child, 'SIGTERM');
        setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 2_000).unref();
      }, timeoutMs);
      timeout.unref();

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdin?.on('error', () => {});
      child.stdout?.on('data', (chunk) => {
        stdout = appendTail(stdout, chunk, stdoutLimit);
        if (!onStdoutLine) return;
        lineBuffer += chunk;
        while (true) {
          const index = lineBuffer.indexOf('\n');
          if (index < 0) break;
          const line = lineBuffer.slice(0, index);
          lineBuffer = lineBuffer.slice(index + 1);
          if (line) {
            try { onStdoutLine(line); } catch {}
          }
        }
        if (lineBuffer.length > stdoutLimit) {
          lineBuffer = lineBuffer.slice(-stdoutLimit);
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendTail(stderr, chunk, stderrLimit);
      });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (lineBuffer && onStdoutLine) {
          try { onStdoutLine(lineBuffer); } catch {}
        }
        resolve({ code, signal, stdout, stderr, timedOut });
      });

      if (input !== undefined) child.stdin?.end(input);
      else child.stdin?.end();
    });
  }

  async stopAll(graceMs = 5_000) {
    const children = [...this.children].filter((child) => child.exitCode === null);
    for (const child of children) terminateProcessTree(child, 'SIGTERM');
    if (children.length === 0) return;
    await Promise.race([
      Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve)))),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    for (const child of children) terminateProcessTree(child, 'SIGKILL');
  }
}

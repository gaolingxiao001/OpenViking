import fs from 'node:fs';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const MAX_LINE_BYTES = 8 * 1024;

function sameSecret(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function safeMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\b(?:mdc|cap|decision)_[A-Za-z0-9_-]+\b/g, '[CAPABILITY]').slice(0, 500);
}

function writeLine(socket, value) {
  socket.end(`${JSON.stringify(value)}\n`);
}

export class DecisionAuthorityServer {
  constructor({ socketPath, authority, getRuntimeToken, logger = null }) {
    if (!socketPath) throw new TypeError('decision authority socketPath is required');
    if (typeof authority?.claim !== 'function') throw new TypeError('decision authority claim is required');
    if (typeof getRuntimeToken !== 'function') throw new TypeError('getRuntimeToken is required');
    Object.assign(this, { socketPath, authority, getRuntimeToken, logger });
    this.server = null;
    this.sockets = new Set();
    this.closing = false;
  }

  async start() {
    if (this.server) return;
    this.closing = false;
    try {
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket()) throw new Error('decision authority path exists and is not a socket');
      fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const server = net.createServer((socket) => this._connection(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      const failed = (error) => {
        server.off('listening', listening);
        reject(error);
      };
      const listening = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen(this.socketPath);
    });
    try { fs.chmodSync(this.socketPath, 0o600); } catch {}
  }

  _connection(socket) {
    if (this.closing) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_LINE_BYTES) {
        handled = true;
        writeLine(socket, { ok: false, error: 'request_too_large' });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let request;
      try { request = JSON.parse(input.slice(0, newline)); } catch {
        writeLine(socket, { ok: false, error: 'invalid_json' });
        return;
      }
      void this._claim(request).then(
        (result) => writeLine(socket, { ok: true, result }),
        (error) => writeLine(socket, { ok: false, error: safeMessage(error) }),
      );
    });
    socket.on('error', () => {});
  }

  async _claim(request) {
    if (request?.v !== 1 || request?.op !== 'claim') throw new Error('unsupported_request');
    if (!sameSecret(request.runtimeToken, this.getRuntimeToken())) {
      throw new Error('runtime_authority_revoked');
    }
    return await this.authority.claim(request.capability, {
      runtimeToken: request.runtimeToken,
      action: request.action,
      target: request.target,
    });
  }

  async close() {
    this.closing = true;
    const server = this.server;
    this.server = null;
    if (server) {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    this.sockets.clear();
    try {
      if (fs.lstatSync(this.socketPath).isSocket()) fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('decision_socket_cleanup_failed');
    }
  }
}

export async function claimDecisionCapability({
  socketPath,
  runtimeToken,
  capability,
  action,
  target,
  timeoutMs = 1_000,
}) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('decision authority timed out')), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      const line = `${JSON.stringify({
        v: 1,
        op: 'claim',
        runtimeToken,
        capability,
        action,
        target,
      })}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        finish(new Error('decision authority request is too large'));
        return;
      }
      socket.write(line);
    });
    socket.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output, 'utf8') > MAX_LINE_BYTES) {
        finish(new Error('decision authority response is too large'));
        return;
      }
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(output.slice(0, newline)); } catch {
        finish(new Error('decision authority returned invalid JSON'));
        return;
      }
      if (!response?.ok) finish(new Error(`Delivery blocked: ${String(response?.error ?? 'capability rejected')}. No Lark action was taken.`));
      else finish(null, response.result);
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      if (!settled) finish(new Error('decision authority closed without a response'));
    });
  });
}

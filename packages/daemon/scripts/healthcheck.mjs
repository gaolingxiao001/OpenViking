const host = process.env.LARK_DAEMON_HOST || '127.0.0.1';
const port = process.env.LARK_DAEMON_PORT || '3738';

try {
  const response = await fetch(`http://${host}:${port}/ready`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.text();
  process.stdout.write(`${body}\n`);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

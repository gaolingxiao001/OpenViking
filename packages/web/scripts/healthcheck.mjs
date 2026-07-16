const host = process.env.LARK_WEB_HOST || '127.0.0.1';
const port = process.env.LARK_WEB_PORT || '3737';

try {
  const response = await fetch(`http://${host}:${port}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.text();
  process.stdout.write(`${body}\n`);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

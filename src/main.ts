import { serve } from '@hono/node-server';
import { createApplication } from './app.js';

const runtime = createApplication();
const server = serve({
  fetch: runtime.app.fetch,
  hostname: runtime.config.host,
  port: runtime.config.port,
});

runtime.logger.info('ToolHome is listening', {
  address: `${runtime.config.host}:${runtime.config.port}`,
  publicUrl: runtime.config.publicUrl.toString(),
});

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  runtime.logger.info('ToolHome is shutting down', { signal });
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  const results = await Promise.allSettled([runtime.close(), serverClosed]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
};

const requestShutdown = (signal: string): void => {
  void shutdown(signal).catch((error) => {
    runtime.logger.error('ToolHome shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
};

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

import { AppError } from '../domain/errors.js';
import { errorResponse } from '../control/control-api.js';
import type { Logger } from '../observability/logger.js';
import type { AuthService } from '../security/auth-service.js';
import type { CliService } from './cli-service.js';
import { cliNdjsonContentType, encodeFrame, type CliExecFrame } from './frames.js';

interface HonoLike {
  get(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
  post(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
}

interface HonoContext {
  req: {
    raw: Request;
    path: string;
    param(name: string): string;
    json(): Promise<unknown>;
  };
}

/**
 * Mount the CLI data-plane routes (docs/cli-hosting-research.md §2.2/§2.6):
 *
 *   POST /cli/{slug}/exec     NDJSON stream of stdout/stderr/exit frames
 *   GET  /cli/{slug}/status   { installed, version, loggedIn, lastCheckedAt }
 *
 * Both require an admin Control Key. All validation and the allow-list verdict
 * happen before the response stream starts, so 400/403/404 errors are returned
 * as JSON without spawning anything.
 */
export function mountCliExecRoutes(
  app: HonoLike,
  options: { service: CliService; auth: AuthService; logger: Logger },
): void {
  const requireAdmin = (context: HonoContext): void => {
    const principal = options.auth.authenticateBearer('control', context.req.raw);
    if (principal.scope !== 'admin') {
      throw new AppError('forbidden', 'This operation requires an admin control key', 403);
    }
  };

  app.post('/cli/:slug/exec', async (context) => {
    try {
      requireAdmin(context);
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        throw new AppError('validation_error', 'Request body must be JSON', 400);
      }
      const prepared = options.service.prepareExec(context.req.param('slug'), body);
      const abort = new AbortController();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            const emit = (frame: CliExecFrame): void => {
              try {
                controller.enqueue(new TextEncoder().encode(encodeFrame(frame)));
              } catch {
                // stream already closed by the client
              }
            };
            try {
              await options.service.runExec(prepared.record, prepared.input, emit, abort.signal);
            } catch (error) {
              emit({
                type: 'stderr',
                data: error instanceof Error ? error.message : String(error),
              });
              emit({ type: 'exit', code: null, durationMs: 0, result: 'error' });
            } finally {
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          })();
        },
        cancel() {
          abort.abort();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': cliNdjsonContentType,
          'cache-control': 'no-store',
        },
      });
    } catch (error) {
      return errorResponse(error, options.logger);
    }
  });

  app.get('/cli/:slug/status', async (context) => {
    try {
      requireAdmin(context);
      const status = await options.service.status(context.req.param('slug'));
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    } catch (error) {
      return errorResponse(error, options.logger);
    }
  });
}

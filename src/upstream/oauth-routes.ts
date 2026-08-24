import type { Logger } from '../observability/logger.js';
import type { UpstreamOAuthService } from './oauth-service.js';

interface HonoLike {
  get(path: string, handler: (context: HonoContext) => Response | Promise<Response>): void;
}

interface HonoContext {
  req: {
    param(name: string): string;
    query(name: string): string | undefined;
  };
}

export function mountUpstreamOAuthRoutes(
  app: HonoLike,
  options: { oauth: UpstreamOAuthService; logger: Logger },
): void {
  app.get('/oauth/upstream/client/:credentialId', (context) => {
    try {
      return new Response(
        JSON.stringify(options.oauth.metadata(context.req.param('credentialId'))),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=300',
          },
        },
      );
    } catch {
      return new Response(JSON.stringify({ error: 'client_metadata_not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  });

  app.get('/oauth/upstream/callback/:credentialId', async (context) => {
    const credentialId = context.req.param('credentialId');
    if (context.req.query('error')) {
      return htmlPage(
        'Authorization was not completed',
        'Return to ToolHome and start the authorization flow again.',
        400,
      );
    }
    const code = context.req.query('code');
    const state = context.req.query('state');
    if (!code || !state) {
      return htmlPage(
        'Invalid authorization callback',
        'The callback is missing required parameters. Return to ToolHome and try again.',
        400,
      );
    }
    try {
      const issuer = context.req.query('iss');
      const result = await options.oauth.callback(credentialId, {
        code,
        state,
        ...(issuer === undefined ? {} : { iss: issuer }),
      });
      return htmlPage(
        'Authorization complete',
        `${result.server.name} is connected. You can close this window.`,
        200,
      );
    } catch (error) {
      options.logger.warn('Upstream OAuth callback failed', {
        credentialId,
        error: error instanceof Error ? error.message : String(error),
      });
      return htmlPage(
        'Authorization failed',
        'The authorization response could not be verified. Return to ToolHome and try again.',
        400,
      );
    }
  });
}

function htmlPage(title: string, message: string, status: number): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · ToolHome</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f2; color: #171714; }
      main { width: min(520px, calc(100vw - 40px)); padding: 40px; border: 1px solid #d9d9d2; border-radius: 18px; background: #fff; }
      p:first-child { margin: 0 0 24px; color: #6e6e67; font: 600 12px/1 ui-monospace, SFMono-Regular, monospace; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: -.03em; }
      p:last-child { margin: 0; color: #62625c; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        body { background: #11110f; color: #f3f3ee; }
        main { background: #191917; border-color: #34342f; }
        p:first-child, p:last-child { color: #aaa99f; }
      }
    </style>
  </head>
  <body><main><p>ToolHome</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

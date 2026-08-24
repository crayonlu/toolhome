import type { AuthInfo } from '@modelcontextprotocol/server';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { AuthService } from './auth-service.js';

const authorizationSchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(8_192),
  redirect_uri: z.url().max(2_048),
  code_challenge: z
    .string()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(2_048).optional(),
  resource: z.url().max(2_048),
  scope: z.string().max(256).default('mcp:use'),
});

const allowedScopes = new Set(['mcp:use']);
const maxTransientEntries = 1_000;
const nonPublicIpv4Subnets: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const nonPublicIpv6Subnets: Array<[string, number]> = [
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];
const nonPublicAddresses = createNonPublicBlockList();

const clientMetadataSchema = z
  .object({
    client_name: z.string().max(120).default('MCP client'),
    redirect_uris: z.array(z.url().max(2_048)).min(1).max(16),
    token_endpoint_auth_method: z.literal('none').default('none'),
  })
  .passthrough()
  .superRefine((metadata, context) => {
    for (const [index, value] of metadata.redirect_uris.entries()) {
      if (!isSafeRedirectUri(value)) {
        context.addIssue({
          code: 'custom',
          path: ['redirect_uris', index],
          message: 'Redirect URI scheme is not allowed',
        });
      }
    }
  });

const registeredClientSchema = z.object({
  issuedAt: z.number().int().nonnegative(),
  metadata: clientMetadataSchema,
});

const accessClaimsSchema = z.object({
  sub: z.string(),
  clientId: z.string(),
  scope: z.string(),
  resource: z.string(),
  tokenKind: z.literal('access'),
});

const refreshClaimsSchema = accessClaimsSchema.extend({ tokenKind: z.literal('refresh') });
const registeredClientPrefix = 'mch_client_v1.';

interface PendingAuthorization extends z.infer<typeof authorizationSchema> {
  id: string;
  clientName: string;
  expiresAt: number;
}

interface AuthorizationCode extends z.infer<typeof authorizationSchema> {
  code: string;
  expiresAt: number;
}

export class OAuthServer {
  readonly #publicUrl: URL;
  readonly #controlAuth: AuthService;
  readonly #key: Uint8Array;
  readonly #registrationKey: Buffer;
  readonly #issuer: string;
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #codes = new Map<string, AuthorizationCode>();

  constructor(publicUrl: URL, masterKey: string, controlAuth: AuthService) {
    this.#publicUrl = publicUrl;
    this.#controlAuth = controlAuth;
    this.#key = createHash('sha256').update(`toolhome.oauth:${masterKey}`).digest();
    this.#registrationKey = createHash('sha256')
      .update(`toolhome.oauth.registration:${masterKey}`)
      .digest();
    this.#issuer = new URL('/', this.#publicUrl).toString().replace(/\/$/, '');
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.#issuer,
      authorization_endpoint: new URL('/oauth/authorize', this.#publicUrl).toString(),
      token_endpoint: new URL('/oauth/token', this.#publicUrl).toString(),
      registration_endpoint: new URL('/oauth/register', this.#publicUrl).toString(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:use'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    };
  }

  protectedResourceMetadata(resource: URL): Record<string, unknown> {
    return {
      resource: resource.toString(),
      authorization_servers: [this.#issuer],
      scopes_supported: ['mcp:use'],
      bearer_methods_supported: ['header'],
    };
  }

  mcpResource(slug: string | null): URL {
    const path = slug === null ? '/mcp' : `/mcp/${encodeURIComponent(slug)}`;
    const resource = new URL(path, this.#publicUrl);
    resource.search = '';
    resource.hash = '';
    return resource;
  }

  resourceMetadataUrl(resource: URL): string {
    const path = resource.pathname === '/' ? '' : resource.pathname;
    return new URL(`/.well-known/oauth-protected-resource${path}`, this.#publicUrl).toString();
  }

  async beginAuthorization(url: URL): Promise<Response> {
    this.#prune();
    const input = authorizationSchema.parse(Object.fromEntries(url.searchParams));
    const resource = this.#assertResource(input.resource);
    const scope = this.#assertScope(input.scope);
    const metadata = await this.#resolveClient(input.client_id);
    if (!metadata.redirect_uris.includes(input.redirect_uri)) {
      throw new AppError('invalid_redirect_uri', 'redirect_uri is not registered', 400);
    }
    const pending: PendingAuthorization = {
      ...input,
      resource,
      scope,
      id: randomBytes(24).toString('base64url'),
      clientName: metadata.client_name,
      expiresAt: Date.now() + 5 * 60_000,
    };
    if (this.#pending.size + this.#codes.size >= maxTransientEntries) {
      throw new AppError('temporarily_unavailable', 'Too many authorization requests', 503);
    }
    this.#pending.set(pending.id, pending);
    return new Response(this.#authorizationPage(pending), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      },
    });
  }

  approveAuthorization(form: FormData): Response {
    this.#prune();
    const requestId = z.string().parse(form.get('request_id'));
    const controlKey = z.string().min(1).parse(form.get('control_key'));
    const decision = z.enum(['approve', 'deny']).parse(form.get('decision'));
    this.#controlAuth.authenticate('control', controlKey);
    const pending = this.#pending.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new AppError('authorization_expired', 'Authorization request expired', 400);
    }
    this.#pending.delete(requestId);
    const redirect = new URL(pending.redirect_uri);
    if (decision === 'deny') {
      redirect.searchParams.set('error', 'access_denied');
    } else {
      const code = randomBytes(32).toString('base64url');
      this.#codes.set(code, { ...pending, code, expiresAt: Date.now() + 5 * 60_000 });
      redirect.searchParams.set('code', code);
    }
    redirect.searchParams.set('iss', this.#issuer);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    return Response.redirect(redirect, 302);
  }

  async token(form: FormData): Promise<Response> {
    this.#prune();
    const grantType = z.string().parse(form.get('grant_type'));
    if (grantType === 'authorization_code') return this.#authorizationCodeToken(form);
    if (grantType === 'refresh_token') return this.#refreshToken(form);
    return oauthError('unsupported_grant_type', 'Unsupported grant_type', 400);
  }

  register(value: unknown): Record<string, unknown> {
    const parsed = clientMetadataSchema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('invalid_client_metadata', 'OAuth client metadata is invalid', 400);
    }
    const metadata = parsed.data;
    const issuedAt = Math.floor(Date.now() / 1_000);
    const body = Buffer.from(
      JSON.stringify(registeredClientSchema.parse({ issuedAt, metadata })),
      'utf8',
    ).toString('base64url');
    const clientId = `${registeredClientPrefix}${body}.${this.#registrationMac(body)}`;
    if (clientId.length > 8_192) {
      throw new AppError('invalid_client_metadata', 'OAuth client metadata is too large', 400);
    }
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      token_endpoint_auth_method: 'none',
    };
  }

  async verifyAccessToken(token: string, expectedResource: URL): Promise<AuthInfo> {
    try {
      const verified = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: this.#issuer,
        audience: expectedResource.toString(),
      });
      const claims = accessClaimsSchema.parse(verified.payload);
      if (claims.resource !== expectedResource.toString()) throw new Error('resource mismatch');
      const scopes = claims.scope.split(/\s+/).filter(Boolean);
      if (!scopes.includes('mcp:use')) throw new Error('required scope missing');
      return {
        token,
        clientId: claims.clientId,
        scopes,
        ...(verified.payload.exp === undefined ? {} : { expiresAt: verified.payload.exp }),
        resource: expectedResource,
        extra: { credentialKind: 'oauth' },
      };
    } catch {
      throw new AppError('invalid_token', 'OAuth access token is invalid or expired', 401);
    }
  }

  async #authorizationCodeToken(form: FormData): Promise<Response> {
    const code = z.string().parse(form.get('code'));
    const clientId = z.string().parse(form.get('client_id'));
    const redirectUri = z.url().parse(form.get('redirect_uri'));
    const verifier = z.string().min(43).max(128).parse(form.get('code_verifier'));
    const entry = this.#codes.get(code);
    this.#codes.delete(code);
    if (!entry || entry.expiresAt <= Date.now())
      return oauthError('invalid_grant', 'Code expired', 400);
    if (entry.client_id !== clientId || entry.redirect_uri !== redirectUri) {
      return oauthError('invalid_grant', 'Client or redirect mismatch', 400);
    }
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (challenge !== entry.code_challenge) return oauthError('invalid_grant', 'PKCE failed', 400);
    return this.#tokenResponse(entry.client_id, entry.scope, entry.resource);
  }

  async #refreshToken(form: FormData): Promise<Response> {
    const token = z.string().parse(form.get('refresh_token'));
    const clientId = z.string().parse(form.get('client_id'));
    try {
      const verified = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: this.#issuer,
        audience: 'toolhome-oauth-refresh',
      });
      const claims = refreshClaimsSchema.parse(verified.payload);
      if (claims.clientId !== clientId) return oauthError('invalid_grant', 'Client mismatch', 400);
      return this.#tokenResponse(claims.clientId, claims.scope, claims.resource);
    } catch {
      return oauthError('invalid_grant', 'Refresh token invalid', 400);
    }
  }

  async #tokenResponse(clientId: string, scope: string, resource: string): Promise<Response> {
    const subject = createHash('sha256').update(clientId).digest('hex');
    const accessToken = await new SignJWT({
      clientId,
      scope,
      resource,
      tokenKind: 'access',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setSubject(subject)
      .setIssuer(this.#issuer)
      .setAudience(resource)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.#key);
    const refreshToken = await new SignJWT({
      clientId,
      scope,
      resource,
      tokenKind: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject)
      .setIssuer(this.#issuer)
      .setAudience('toolhome-oauth-refresh')
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(this.#key);
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }

  async #resolveClient(clientId: string): Promise<z.infer<typeof clientMetadataSchema>> {
    const registered = this.#registeredClient(clientId);
    if (registered) return registered;
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new AppError('invalid_client', 'Unknown OAuth client', 400);
    }
    if (
      url.protocol !== 'https:' ||
      url.pathname === '/' ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    ) {
      throw new AppError(
        'invalid_client',
        'Client metadata URL must use HTTPS and a non-root path',
        400,
      );
    }
    const addresses = await resolveSafeMetadataAddresses(url.hostname);
    let text: string;
    try {
      text = await requestClientMetadata(url, addresses, 64 * 1024);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('invalid_client', 'Client metadata unavailable', 400);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError('invalid_client', 'Client metadata is not valid JSON', 400);
    }
    const metadata = clientMetadataSchema.safeParse(value);
    if (!metadata.success) {
      throw new AppError('invalid_client', 'Client metadata is invalid', 400);
    }
    return metadata.data;
  }

  #registeredClient(clientId: string): z.infer<typeof clientMetadataSchema> | null {
    if (!clientId.startsWith(registeredClientPrefix)) return null;
    const value = clientId.slice(registeredClientPrefix.length);
    const [body, mac, extra] = value.split('.');
    if (!body || !mac || extra !== undefined) {
      throw new AppError('invalid_client', 'Registered OAuth client is invalid', 400);
    }
    const actual = Buffer.from(this.#registrationMac(body), 'base64url');
    const expected = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AppError('invalid_client', 'Registered OAuth client is invalid', 400);
    }
    try {
      return registeredClientSchema.parse(
        JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      ).metadata;
    } catch {
      throw new AppError('invalid_client', 'Registered OAuth client is invalid', 400);
    }
  }

  #registrationMac(body: string): string {
    return createHmac('sha256', this.#registrationKey).update(body).digest('base64url');
  }

  #assertResource(resource: string): string {
    const value = new URL(resource);
    const isMcpPath =
      value.pathname === '/mcp' || /^\/mcp\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.pathname);
    if (
      value.origin !== this.#publicUrl.origin ||
      !isMcpPath ||
      value.search !== '' ||
      value.hash !== ''
    ) {
      throw new AppError('invalid_target', 'OAuth resource must be a ToolHome endpoint', 400);
    }
    return value.toString();
  }

  #assertScope(scope: string): string {
    const requested = scope.split(/\s+/).filter(Boolean);
    if (requested.length === 0 || requested.some((value) => !allowedScopes.has(value))) {
      throw new AppError('invalid_scope', 'Only the mcp:use scope is supported', 400);
    }
    return [...new Set(requested)].join(' ');
  }

  #prune(): void {
    const timestamp = Date.now();
    for (const [id, pending] of this.#pending)
      if (pending.expiresAt <= timestamp) this.#pending.delete(id);
    for (const [code, entry] of this.#codes)
      if (entry.expiresAt <= timestamp) this.#codes.delete(code);
  }

  #authorizationPage(request: PendingAuthorization): string {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize ToolHome</title><style>body{font:16px system-ui;background:#f4f5f2;color:#18211c;display:grid;place-items:center;min-height:100vh;margin:0}.card{width:min(430px,calc(100% - 40px));background:#fff;border:1px solid #d8ddd8;border-radius:16px;padding:30px}h1{margin-top:0;font-size:24px}p{color:#59635d;line-height:1.6}dl{background:#f6f7f5;border:1px solid #e3e6e3;padding:16px;border-radius:10px}dt{font-size:12px;color:#707a74}dd{margin:3px 0 12px;word-break:break-all}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cbd2cc;border-radius:8px;margin:7px 0 16px}.actions{display:flex;gap:10px}.actions button{flex:1;padding:11px;border:1px solid #1f6845;border-radius:8px;background:#1f6845;color:white;font-weight:700}.actions .deny{border-color:#d7dcd8;background:#fff;color:#465149}</style><div class="card"><h1>授权 MCP Client</h1><p><strong>${escapeHtml(request.clientName)}</strong> 请求访问你的 ToolHome。</p><dl><dt>Resource</dt><dd>${escapeHtml(request.resource)}</dd><dt>Scope</dt><dd>${escapeHtml(request.scope)}</dd><dt>Redirect</dt><dd>${escapeHtml(request.redirect_uri)}</dd></dl><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(request.id)}"><label>Control API Key<input type="password" name="control_key" autocomplete="off" required></label><div class="actions"><button class="deny" name="decision" value="deny">拒绝</button><button name="decision" value="approve">允许</button></div></form></div></html>`;
  }
}

function oauthError(error: string, description: string, status: number): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isLoopback(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isSafeRedirectUri(value: string): boolean {
  const url = new URL(value);
  if (url.hash !== '' || url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopback(url.hostname);
  const privateScheme = url.protocol.slice(0, -1);
  return privateScheme.includes('.') && /^[a-z][a-z0-9+.-]*$/.test(privateScheme);
}

interface ResolvedAddress {
  address: string;
  family: number;
}

async function resolveSafeMetadataAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const normalized = normalizeHostname(hostname);
  let addresses: ResolvedAddress[];
  try {
    addresses =
      isIP(normalized) === 0
        ? await lookup(normalized, { all: true, verbatim: true })
        : [{ address: normalized, family: isIP(normalized) }];
  } catch {
    throw new AppError('invalid_client', 'Client metadata host cannot be resolved', 400);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new AppError('invalid_client', 'Client metadata host is not publicly routable', 400);
  }
  return addresses;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return nonPublicAddresses.check(address, 'ipv4');
  if (family === 6) return nonPublicAddresses.check(address, 'ipv6');
  return true;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function createNonPublicBlockList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of nonPublicIpv4Subnets) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  list.addAddress('::', 'ipv6');
  list.addAddress('::1', 'ipv6');
  for (const [network, prefix] of nonPublicIpv6Subnets) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

async function requestClientMetadata(
  url: URL,
  addresses: ResolvedAddress[],
  limit: number,
): Promise<string> {
  const deadline = Date.now() + 5_000;
  let lastError: Error | null = null;
  for (const address of addresses) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await requestClientMetadataAddress(url, address, limit, remaining);
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('Client metadata unavailable');
}

function requestClientMetadataAddress(
  url: URL,
  address: ResolvedAddress,
  limit: number,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hostname = normalizeHostname(url.hostname);
    const request = httpsRequest(
      {
        hostname: address.address,
        family: address.family,
        port: url.port === '' ? 443 : Number(url.port),
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'application/json', host: url.host },
        timeout: timeoutMs,
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new Error(`Client metadata returned HTTP ${response.statusCode ?? 0}`));
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
          response.destroy();
          reject(new AppError('invalid_client', 'Client metadata too large', 400));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > limit) {
            response.destroy();
            reject(new AppError('invalid_client', 'Client metadata too large', 400));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('Client metadata timed out')));
    request.on('error', reject);
    request.end();
  });
}

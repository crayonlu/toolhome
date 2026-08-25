import { AppError } from '../domain/errors.js';
import type { CredentialPayload } from '../domain/models.js';

export interface MaterializedCredential {
  headers: Record<string, string>;
  env: Record<string, string>;
  bearerToken?: string;
}

/**
 * Converts one stored credential into the common material used by MCP and CLI
 * consumers. OAuth remains backed by StoredOAuthProvider for MCP; its access
 * token can be projected to a CLI environment when a binding requests it.
 */
export function materializeCredentialPayload(payload: CredentialPayload): MaterializedCredential {
  switch (payload.type) {
    case 'bearer':
      return { headers: {}, env: {}, bearerToken: payload.token };
    case 'api-key':
      return { headers: { [payload.headerName]: payload.value }, env: {} };
    case 'headers':
      return { headers: payload.headers, env: {} };
    case 'env':
      return { headers: {}, env: payload.variables };
    case 'oauth':
      return {
        headers: {},
        env: {},
        ...(payload.accessToken === undefined ? {} : { bearerToken: payload.accessToken }),
      };
  }
}

/**
 * Maps a stored credential payload to the environment variables a platform CLI
 * expects. Binding values support `env:<name>`, `token`, `value`,
 * `header:<name>`, and `accessToken`.
 */
export function validateCliCredentialBindings(
  payload: CredentialPayload,
  bindings: Record<string, string>,
): void {
  if (payload.type === 'env' && Object.keys(bindings).length === 0) return;
  if (Object.keys(bindings).length === 0) {
    throw new AppError(
      'credential_binding_invalid',
      'CLI credentials require at least one environment binding',
      400,
    );
  }
  for (const source of Object.values(bindings)) {
    assertBindingSource(payload, source, true);
  }
}

export function materializeCliCredential(
  payload: CredentialPayload,
  bindings: Record<string, string>,
): Record<string, string> {
  validateCliCredentialBindings(payload, bindings);
  if (payload.type === 'env' && Object.keys(bindings).length === 0) return payload.variables;

  return Object.fromEntries(
    Object.entries(bindings).map(([name, source]) => [name, resolveBinding(payload, source)]),
  );
}

function resolveBinding(payload: CredentialPayload, source: string): string {
  assertBindingSource(payload, source, false);
  if (payload.type === 'env' && source.startsWith('env:')) {
    return payload.variables[source.slice('env:'.length)]!;
  }
  if (payload.type === 'bearer' && source === 'token') return payload.token;
  if (payload.type === 'api-key' && source === 'value') return payload.value;
  if (payload.type === 'headers' && source.startsWith('header:')) {
    return payload.headers[source.slice('header:'.length)]!;
  }
  if (payload.type === 'oauth' && source === 'accessToken') return payload.accessToken!;
  throw new AppError(
    'credential_binding_invalid',
    `Credential binding source "${source}" is not available`,
    400,
  );
}

function assertBindingSource(
  payload: CredentialPayload,
  source: string,
  allowPendingOAuth: boolean,
): void {
  if (payload.type === 'env' && source.startsWith('env:')) {
    if (payload.variables[source.slice('env:'.length)] !== undefined) return;
  }
  if (payload.type === 'bearer' && source === 'token') return;
  if (payload.type === 'api-key' && source === 'value') return;
  if (payload.type === 'headers' && source.startsWith('header:')) {
    if (payload.headers[source.slice('header:'.length)] !== undefined) return;
  }
  if (payload.type === 'oauth' && source === 'accessToken') {
    if (payload.accessToken || allowPendingOAuth) return;
    throw new AppError(
      'credential_authorization_required',
      'OAuth credential requires authorization before CLI execution',
      400,
    );
  }
  throw new AppError(
    'credential_binding_invalid',
    `Credential binding source "${source}" is not available`,
    400,
  );
}

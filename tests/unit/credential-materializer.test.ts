import { describe, expect, it } from 'vitest';
import {
  materializeCliCredential,
  materializeCredentialPayload,
} from '../../src/security/credential-materializer.js';

describe('credential materializer', () => {
  it('materializes static MCP-compatible credentials into headers and environment', () => {
    expect(materializeCredentialPayload({ type: 'bearer', token: 'token-1' })).toEqual({
      headers: {},
      env: {},
      bearerToken: 'token-1',
    });
    expect(
      materializeCredentialPayload({
        type: 'api-key',
        headerName: 'X-Api-Key',
        value: 'api-key-1',
      }),
    ).toEqual({ headers: { 'X-Api-Key': 'api-key-1' }, env: {} });
    expect(
      materializeCredentialPayload({
        type: 'headers',
        headers: { Authorization: 'Bearer secret', 'X-Region': 'east' },
      }),
    ).toEqual({
      headers: { Authorization: 'Bearer secret', 'X-Region': 'east' },
      env: {},
    });
  });

  it('passes every variable through for an Env Credential without bindings', () => {
    expect(
      materializeCliCredential(
        { type: 'env', variables: { GH_TOKEN: 'token-1', GH_HOST: 'github.example' } },
        {},
      ),
    ).toEqual({ GH_TOKEN: 'token-1', GH_HOST: 'github.example' });
  });

  it('selects named Env Credential variables through bindings', () => {
    expect(
      materializeCliCredential(
        { type: 'env', variables: { CLIENT_ID: 'client-1', UNUSED: 'do-not-forward' } },
        { AZURE_CLIENT_ID: 'env:CLIENT_ID' },
      ),
    ).toEqual({ AZURE_CLIENT_ID: 'client-1' });
  });

  it('maps a bearer credential into the CLI environment', () => {
    expect(
      materializeCliCredential({ type: 'bearer', token: 'token-1' }, { GH_TOKEN: 'token' }),
    ).toEqual({ GH_TOKEN: 'token-1' });
  });

  it('maps API keys and selected headers without exposing unrelated values', () => {
    expect(
      materializeCliCredential(
        { type: 'api-key', headerName: 'X-Api-Key', value: 'api-key-1' },
        { TS_API_KEY: 'value' },
      ),
    ).toEqual({ TS_API_KEY: 'api-key-1' });
    expect(
      materializeCliCredential(
        { type: 'headers', headers: { Authorization: 'Bearer secret', 'X-Region': 'east' } },
        { AUTH_HEADER: 'header:Authorization' },
      ),
    ).toEqual({ AUTH_HEADER: 'Bearer secret' });
  });

  it('reuses stored OAuth access tokens for CLIs and reports pending authorization', () => {
    expect(
      materializeCliCredential(
        {
          type: 'oauth',
          accessToken: 'oauth-access-token',
          tokenType: 'Bearer',
        },
        { GH_TOKEN: 'accessToken' },
      ),
    ).toEqual({ GH_TOKEN: 'oauth-access-token' });

    expect(() =>
      materializeCliCredential({ type: 'oauth', tokenType: 'Bearer' }, { GH_TOKEN: 'accessToken' }),
    ).toThrowError(expect.objectContaining({ code: 'credential_authorization_required' }));
  });

  it('rejects a missing or unsupported binding source', () => {
    expect(() =>
      materializeCliCredential({ type: 'bearer', token: 'token-1' }, { GH_TOKEN: 'value' }),
    ).toThrowError(expect.objectContaining({ code: 'credential_binding_invalid' }));
    expect(() =>
      materializeCliCredential(
        { type: 'headers', headers: { Authorization: 'Bearer secret' } },
        { GH_TOKEN: 'header:X-Missing' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'credential_binding_invalid' }));
    expect(() =>
      materializeCliCredential(
        { type: 'env', variables: { TOKEN: 'secret' } },
        { GH_TOKEN: 'env:MISSING' },
      ),
    ).toThrowError(expect.objectContaining({ code: 'credential_binding_invalid' }));
  });
});

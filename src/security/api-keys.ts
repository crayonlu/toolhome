import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyKind } from '../domain/models.js';

const keyPrefixes = {
  control: 'tch_ctl_',
  access: 'tch_mcp_',
} satisfies Record<ApiKeyKind, string>;

export interface GeneratedApiKey {
  secret: string;
  prefix: string;
  digest: string;
}

export class ApiKeyHasher {
  readonly #pepper: string;

  constructor(pepper: string) {
    this.#pepper = pepper;
  }

  generate(kind: ApiKeyKind): GeneratedApiKey {
    const secret = `${keyPrefixes[kind]}${randomBytes(32).toString('base64url')}`;
    return {
      secret,
      prefix: secret.slice(0, keyPrefixes[kind].length + 8),
      digest: this.digest(secret),
    };
  }

  digest(secret: string): string {
    return createHmac('sha256', this.#pepper).update(secret, 'utf8').digest('hex');
  }

  verify(secret: string, expectedHex: string): boolean {
    const actual = Buffer.from(this.digest(secret), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  kindFor(secret: string): ApiKeyKind | null {
    if (secret.startsWith(keyPrefixes.control)) return 'control';
    if (secret.startsWith(keyPrefixes.access)) return 'access';
    return null;
  }
}

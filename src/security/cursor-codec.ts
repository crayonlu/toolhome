import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';

const cursorPayloadSchema = z.object({
  key: z.string(),
  offset: z.number().int().nonnegative(),
});

export class CursorCodec {
  readonly #key: string;

  constructor(key: string) {
    this.#key = key;
  }

  encode(payload: z.infer<typeof cursorPayloadSchema>): string {
    const body = Buffer.from(JSON.stringify(cursorPayloadSchema.parse(payload))).toString(
      'base64url',
    );
    const mac = this.#mac(body);
    return `v1.${body}.${mac}`;
  }

  decode(value: string, expectedKey: string): z.infer<typeof cursorPayloadSchema> {
    const [version, body, mac, extra] = value.split('.');
    if (version !== 'v1' || !body || !mac || extra !== undefined) return this.#invalid();
    const actual = Buffer.from(this.#mac(body), 'base64url');
    const expected = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return this.#invalid();
    try {
      const payload = cursorPayloadSchema.parse(
        JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      );
      if (payload.key !== expectedKey) return this.#invalid();
      return payload;
    } catch {
      return this.#invalid();
    }
  }

  #mac(body: string): string {
    return createHmac('sha256', this.#key).update(`toolhome.cursor:${body}`).digest('base64url');
  }

  #invalid(): never {
    throw new AppError('invalid_cursor', 'Cursor is invalid or stale', 400);
  }
}

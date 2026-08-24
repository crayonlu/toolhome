import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import type { AuthPrincipal } from './auth-service.js';

const claimsSchema = z.object({
  sub: z.string(),
  name: z.string(),
  kind: z.literal('control'),
});

export class ControlSessionService {
  readonly #key: Uint8Array;

  constructor(masterKey: string) {
    this.#key = createHash('sha256').update(`toolhome.session:${masterKey}`).digest();
  }

  async issue(principal: AuthPrincipal): Promise<string> {
    return new SignJWT({ name: principal.name, kind: 'control' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(principal.id)
      .setIssuer('toolhome')
      .setAudience('toolhome-control')
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(this.#key);
  }

  async verify(token: string): Promise<AuthPrincipal> {
    try {
      const result = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: 'toolhome',
        audience: 'toolhome-control',
      });
      const claims = claimsSchema.parse(result.payload);
      return { id: claims.sub, name: claims.name, kind: 'control', scope: null };
    } catch {
      throw new AppError('unauthorized', 'Control session is invalid or expired', 401);
    }
  }
}

export function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

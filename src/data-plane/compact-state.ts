import { randomUUID } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/server';
import { fingerprint } from '../upstream/stable-json.js';

interface Observation {
  tool: Tool;
  revision: string;
  expiresAt: number;
  bytes: number;
  serverId: string;
}

export interface CompactInvocation {
  id: string;
  key: string;
  serverId: string;
  exposedTool: string;
  tool: Tool;
  arguments: Record<string, unknown>;
  definition: string;
  revision: string;
  upstreamRequestState?: string;
  expiresAt: number;
  bytes: number;
  busy: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const observationTtl = 15 * 60_000;
const maxBytes = 8 * 1024 * 1024;
const maxContractBytes = 256 * 1024;

/** Process-local contracts and pending invocations never enter the global snapshot. */
export class CompactState {
  readonly #observations = new Map<string, Observation>();
  readonly #invocations = new Map<string, CompactInvocation>();

  observe(key: string, serverId: string, revision: string, tool: Tool): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(tool));
    if (bytes > maxContractBytes) return false;
    this.#observations.delete(key);
    for (const [id, value] of this.#observations) {
      if (value.expiresAt <= Date.now()) this.#observations.delete(id);
    }
    const serverEntries = [...this.#observations].filter(
      ([, value]) => value.serverId === serverId,
    );
    while (serverEntries.length >= 32) this.#observations.delete(serverEntries.shift()![0]);
    while (this.#observationBytes() + bytes > maxBytes) {
      const first = this.#observations.keys().next().value;
      if (first === undefined) break;
      this.#observations.delete(first);
    }
    this.#observations.set(key, {
      tool: structuredClone(tool),
      revision,
      bytes,
      serverId,
      expiresAt: Date.now() + observationTtl,
    });
    return true;
  }

  observed(key: string, revision: string): Tool | undefined {
    const value = this.#observations.get(key);
    if (!value) return undefined;
    if (value.expiresAt <= Date.now() || value.revision !== revision) {
      this.#observations.delete(key);
      return undefined;
    }
    this.#observations.delete(key);
    this.#observations.set(key, value);
    return structuredClone(value.tool);
  }

  retain(
    input: Omit<CompactInvocation, 'id' | 'expiresAt' | 'bytes' | 'busy' | 'timer'>,
    timeoutMs: number,
    terminate: (invocation: CompactInvocation) => Promise<void>,
  ): CompactInvocation | null {
    const bytes = Buffer.byteLength(JSON.stringify(input));
    if (
      bytes > maxContractBytes ||
      this.#invocations.size >= 256 ||
      [...this.#invocations.values()].reduce((total, item) => total + item.bytes, 0) + bytes >
        maxBytes
    ) {
      return null;
    }
    const id = randomUUID();
    const invocation: CompactInvocation = {
      ...structuredClone(input),
      id,
      bytes,
      busy: false,
      expiresAt: Date.now() + timeoutMs,
      timer: setTimeout(() => {
        this.release(id);
        void terminate(invocation).catch(() => undefined);
      }, timeoutMs),
    };
    invocation.timer.unref();
    this.#invocations.set(id, invocation);
    return invocation;
  }

  invocation(id: string): CompactInvocation | undefined {
    return this.#invocations.get(id);
  }

  release(id: string): void {
    const value = this.#invocations.get(id);
    if (value) clearTimeout(value.timer);
    this.#invocations.delete(id);
  }

  async revoke(
    keep: (invocation: CompactInvocation) => boolean,
    terminate: (invocation: CompactInvocation) => Promise<void>,
  ): Promise<void> {
    for (const value of [...this.#invocations.values()]) {
      if (keep(value)) continue;
      this.release(value.id);
      await terminate(value);
    }
  }

  #observationBytes(): number {
    return [...this.#observations.values()].reduce((total, value) => total + value.bytes, 0);
  }
}

export function compactContractFingerprint(tool: Tool, instructions?: string): string {
  return fingerprint({ tool, instructions: instructions ?? '' });
}

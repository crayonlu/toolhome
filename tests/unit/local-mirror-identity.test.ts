import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ControlClient } from '../../src/control/client.js';
import { prepareLocalGateway } from '../../src/node/local-gateway.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const distCli = fileURLToPath(new URL('../../dist/server/cli/main.js', import.meta.url));

function temporaryDirectory(): { directory: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'toolhome-mirror-identity-'));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('local node mirror identity', () => {
  it('keeps the stored node label when logging in again', () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const configPath = join(directory, 'config.json');
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            url: 'https://old.example.test',
            controlKey: 'old-control-key',
            nodeId: 'crayons-air',
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );

      const result = spawnSync(
        process.execPath,
        [
          distCli,
          'auth',
          'login',
          '--url',
          'https://new.example.test',
          '--control-key',
          'new-control-key',
        ],
        { env: { ...process.env, TOOLHOME_CONFIG: configPath }, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);

      const saved = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(saved).toMatchObject({
        url: 'https://new.example.test',
        controlKey: 'new-control-key',
        nodeId: 'crayons-air',
      });
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      cleanup();
    }
  });

  it('reports which node label a mirror belongs to when the label changes', async () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const storePath = join(directory, 'node.sqlite');
      // A mirror created by the real node label.
      const created = new SqliteStore(storePath, new SecretBox('toolhome-local-node:crayons-air'));
      created.close();

      const client = {
        request: () => Promise.reject(new Error('control plane unreachable')),
      } as unknown as ControlClient;

      await expect(
        prepareLocalGateway({ client, nodeId: 'Mac', storePath, toolMode: 'full' }),
      ).rejects.toThrow(/belongs to a different node label than "Mac".*--node/s);

      // The matching label still opens the same mirror.
      await expect(
        prepareLocalGateway({ client, nodeId: 'crayons-air', storePath, toolMode: 'full' }),
      ).rejects.toThrow('control plane unreachable');
    } finally {
      cleanup();
    }
  });
});

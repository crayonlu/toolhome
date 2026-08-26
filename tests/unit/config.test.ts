import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('runtime configuration', () => {
  it('requires a canonical public origin and distinct root secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-config-'));
    try {
      const base = {
        MCP_HOME_DATA_DIR: directory,
        MCP_HOME_MASTER_KEY: 'config-master-key-0000000000000000000000001',
        MCP_HOME_BOOTSTRAP_CONTROL_KEY: 'tch_ctl_config-control-key-000000000000000000000001',
      };
      expect(() =>
        loadConfig({ ...base, MCP_HOME_PUBLIC_URL: 'https://mcp.example.test/base' }),
      ).toThrow();
      expect(() =>
        loadConfig({
          ...base,
          MCP_HOME_BOOTSTRAP_CONTROL_KEY: base.MCP_HOME_MASTER_KEY,
        }),
      ).toThrow();
      const config = loadConfig({
        ...base,
        MCP_HOME_ALLOWED_HOSTS: '',
        MCP_HOME_PUBLIC_URL: 'https://mcp.example.test',
      });
      expect(config.allowedHosts).toEqual(['mcp.example.test']);
      expect(config.publicUrl.toString()).toBe('https://mcp.example.test/');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('runtime configuration', () => {
  it('loads the TOOLHOME namespace and rejects the legacy MCP_HOME namespace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-config-'));
    try {
      const base = {
        TOOLHOME_DATA_DIR: directory,
        TOOLHOME_MASTER_KEY: 'config-master-key-0000000000000000000000001',
        TOOLHOME_BOOTSTRAP_CONTROL_KEY: 'tch_ctl_config-control-key-000000000000000000000001',
      };
      expect(() =>
        loadConfig({ ...base, TOOLHOME_PUBLIC_URL: 'https://mcp.example.test/base' }),
      ).toThrow();
      expect(() =>
        loadConfig({
          ...base,
          TOOLHOME_BOOTSTRAP_CONTROL_KEY: base.TOOLHOME_MASTER_KEY,
        }),
      ).toThrow();
      const config = loadConfig({
        ...base,
        TOOLHOME_ALLOWED_HOSTS: '',
        TOOLHOME_PUBLIC_URL: 'https://mcp.example.test',
      });
      expect(config.allowedHosts).toEqual(['mcp.example.test']);
      expect(config.publicUrl.toString()).toBe('https://mcp.example.test/');
      expect(() =>
        loadConfig({
          MCP_HOME_DATA_DIR: directory,
          MCP_HOME_MASTER_KEY: base.TOOLHOME_MASTER_KEY,
          MCP_HOME_BOOTSTRAP_CONTROL_KEY: base.TOOLHOME_BOOTSTRAP_CONTROL_KEY,
          MCP_HOME_PUBLIC_URL: 'https://mcp.example.test',
        }),
      ).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

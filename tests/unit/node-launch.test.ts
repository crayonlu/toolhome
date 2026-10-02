import { describe, expect, it } from 'vitest';
import { launchEnvironment } from '../../src/node/launch.js';

describe('local server launch environment', () => {
  it('prefers configured and credential values over the ambient environment', () => {
    const env = launchEnvironment(
      { SHARED: 'configured' },
      { SECRET: 'from-credential' },
      {
        SHARED: 'ambient',
        PATH: '/usr/bin',
      },
    );
    expect(env.SHARED).toBe('configured');
    expect(env.SECRET).toBe('from-credential');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('lets the credential win over a configured variable of the same name', () => {
    const env = launchEnvironment({ TOKEN: 'placeholder' }, { TOKEN: 'real' }, {});
    expect(env.TOKEN).toBe('real');
  });

  it('withholds ToolHome secrets from the spawned server', () => {
    const env = launchEnvironment(
      {},
      {},
      {
        TOOLHOME_CONTROL_KEY: 'tch_ctl_secret',
        TOOLHOME_MASTER_KEY: 'master-secret',
        TOOLHOME_URL: 'https://tool.cyncyn.xyz',
        KEEP_ME: 'ok',
      },
    );
    expect(env.TOOLHOME_CONTROL_KEY).toBeUndefined();
    expect(env.TOOLHOME_MASTER_KEY).toBeUndefined();
    expect(env.TOOLHOME_URL).toBeUndefined();
    expect(env.KEEP_ME).toBe('ok');
    expect(JSON.stringify(env)).not.toContain('tch_ctl_secret');
    expect(JSON.stringify(env)).not.toContain('master-secret');
  });

  it('keeps a usable PATH even when the ambient environment has none', () => {
    const env = launchEnvironment({}, {}, {});
    expect(typeof env.PATH).toBe('string');
    expect(env.PATH).not.toBe('');
  });
});

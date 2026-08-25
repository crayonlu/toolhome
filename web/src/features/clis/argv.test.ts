import { describe, expect, it } from 'vitest';
import { parseArgvText } from './argv';

describe('parseArgvText', () => {
  it('preserves spaces inside one argv argument', () => {
    expect(parseArgvText('-c\necho ToolHome CLI\n')).toEqual(['-c', 'echo ToolHome CLI']);
  });

  it('ignores blank lines around argv arguments', () => {
    expect(parseArgvText('\nstatus\n\n--output\n')).toEqual(['status', '--output']);
  });
});

import * as os from 'os';
import * as path from 'path';
import { expandTilde } from '../../src/utils/expand-tilde';

describe('utils/expand-tilde', () => {
  test('expands a bare tilde to the home directory', () => {
    expect(expandTilde('~')).toBe(os.homedir());
  });

  test('expands a tilde-prefixed path to the home directory', () => {
    expect(expandTilde('~/.openchrome')).toBe(path.join(os.homedir(), '.openchrome'));
  });

  test('leaves absolute paths unchanged', () => {
    expect(expandTilde('/tmp/openchrome')).toBe('/tmp/openchrome');
  });

  test('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/profile')).toBe('relative/profile');
  });

  test('does not expand a tilde followed by a username', () => {
    expect(expandTilde('~other')).toBe('~other');
  });
});

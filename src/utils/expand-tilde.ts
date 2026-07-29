import * as os from 'os';
import * as path from 'path';

export function expandTilde(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

/// <reference types="jest" />

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';
import { ExtensionBridgeServer } from '../../src/extension-bridge/server';

const PORT = 39333;

function tryConnect(origin?: string, token?: string): Promise<'accepted' | 'rejected'> {
  const url = `ws://127.0.0.1:${PORT}${token ? `?token=${token}` : ''}`;
  const ws = new WebSocket(url, origin ? { origin } : {});

  return new Promise((resolve) => {
    ws.on('open', () => {
      ws.close();
      resolve('accepted');
    });
    ws.on('error', () => resolve('rejected'));
  });
}

describe('ExtensionBridgeServer upgrade auth', () => {
  let tmpDir: string;
  let server: ExtensionBridgeServer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-'));
    process.env.OPENCHROME_EXTENSION_ORIGIN_PATH = path.join(tmpDir, 'extension-origin');
    jest.spyOn(console, 'error').mockImplementation(() => {});

    server = new ExtensionBridgeServer(PORT);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    jest.restoreAllMocks();
    delete process.env.OPENCHROME_EXTENSION_ORIGIN_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects connections without an extension origin', async () => {
    expect(await tryConnect()).toBe('rejected');
    expect(await tryConnect('http://evil.example')).toBe('rejected');
  });

  it('pins the first extension and rejects any other', async () => {
    expect(await tryConnect('chrome-extension://aaaa')).toBe('accepted');
    expect(fs.readFileSync(process.env.OPENCHROME_EXTENSION_ORIGIN_PATH!, 'utf8')).toBe(
      'chrome-extension://aaaa'
    );

    expect(await tryConnect('chrome-extension://bbbb')).toBe('rejected');
    expect(await tryConnect('chrome-extension://aaaa')).toBe('accepted');
  });

  it('requires the token when one is configured', async () => {
    await server.stop();
    server = new ExtensionBridgeServer(PORT, 'secret');
    await server.start();

    expect(await tryConnect('chrome-extension://aaaa')).toBe('rejected');
    expect(await tryConnect('chrome-extension://aaaa', 'secret')).toBe('accepted');
  });
});

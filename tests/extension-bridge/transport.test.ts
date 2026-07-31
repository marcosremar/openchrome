/// <reference types="jest" />

import { ExtensionBridgeTransport } from '../../src/extension-bridge/transport';

function collect(transport: ExtensionBridgeTransport): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  transport.onmessage = (raw) => messages.push(JSON.parse(raw));
  return messages;
}

describe('ExtensionBridgeTransport', () => {
  it('answers Browser.getVersion without calling the extension', () => {
    const sendCommand = jest.fn();
    const transport = new ExtensionBridgeTransport(7, sendCommand);
    const messages = collect(transport);

    transport.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));

    expect(sendCommand).not.toHaveBeenCalled();
    expect(messages[0]).toMatchObject({ id: 1, result: { protocolVersion: '1.3' } });
  });

  it('synthesises the tab and page targets on discovery', () => {
    const transport = new ExtensionBridgeTransport(7, jest.fn());
    const messages = collect(transport);

    transport.send(JSON.stringify({ id: 2, method: 'Target.setDiscoverTargets' }));

    expect(messages.map((m) => m.params?.targetInfo?.type)).toEqual(['tab', 'page', undefined]);
    expect(messages[2]).toMatchObject({ id: 2, result: {} });
  });

  it('forwards other commands and drops the synthetic page session id', async () => {
    const sendCommand = jest.fn().mockResolvedValue({ frameId: 'f1' });
    const transport = new ExtensionBridgeTransport(7, sendCommand);
    const messages = collect(transport);

    transport.send(
      JSON.stringify({
        id: 3,
        sessionId: 'pageTargetSessionId',
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      })
    );
    await Promise.resolve();

    expect(sendCommand).toHaveBeenCalledWith({
      tabId: 7,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
    expect(messages[0]).toMatchObject({ id: 3, sessionId: 'pageTargetSessionId', result: { frameId: 'f1' } });
  });

  it('reports command failures as CDP errors', async () => {
    const sendCommand = jest.fn().mockRejectedValue(new Error('detached'));
    const transport = new ExtensionBridgeTransport(7, sendCommand);
    const messages = collect(transport);

    transport.send(JSON.stringify({ id: 4, method: 'Runtime.evaluate' }));
    await new Promise((resolve) => setImmediate(resolve));

    expect(messages[0]).toMatchObject({ id: 4, error: { message: 'detached' } });
  });

  it('relays debugger events under the page session', () => {
    const transport = new ExtensionBridgeTransport(7, jest.fn());
    const messages = collect(transport);

    transport.emitEvent('Page.loadEventFired', { timestamp: 1 });

    expect(messages[0]).toEqual({
      sessionId: 'pageTargetSessionId',
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    });
  });
});

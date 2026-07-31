import type { ConnectionTransport } from 'puppeteer-core';

export type DebuggerCommandSender = (command: {
  tabId: number;
  sessionId?: string;
  method: string;
  params?: unknown;
}) => Promise<unknown>;

/** One transport per tab, so synthetic ids must be unique or the target index collides. */
export function bridgeTargetId(tabId: number): string {
  return `extensionTab-${tabId}`;
}

function targetInfos(tabId: number) {
  return {
    tab: {
      targetId: `extensionTabTarget-${tabId}`,
      type: 'tab',
      title: 'tab',
      url: 'about:blank',
      attached: false,
      canAccessOpener: false,
    },
    page: {
      targetId: bridgeTargetId(tabId),
      type: 'page',
      title: 'page',
      url: 'about:blank',
      attached: false,
      canAccessOpener: false,
    },
  };
}

interface CDPMessage {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; data?: unknown; message: string };
}

/**
 * Puppeteer transport backed by chrome.debugger running inside an extension.
 * Port of puppeteer-core's ExtensionTransport with chrome.debugger.sendCommand
 * replaced by an RPC to the extension over the bridge WebSocket.
 *
 * chrome.debugger exposes no Browser domain and no target discovery, so those
 * commands are answered here with a synthetic tab/page target pair.
 */
export class ExtensionBridgeTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;

  private readonly targets: ReturnType<typeof targetInfos>;
  private readonly tabSessionId: string;
  private readonly pageSessionId: string;

  constructor(
    private readonly tabId: number,
    private readonly sendCommand: DebuggerCommandSender,
    private readonly onClosed?: () => void
  ) {
    this.targets = targetInfos(tabId);
    this.tabSessionId = `extensionTabSession-${tabId}`;
    this.pageSessionId = `extensionPageSession-${tabId}`;
  }

  send(message: string): void {
    const parsed = JSON.parse(message) as CDPMessage;

    switch (parsed.method) {
      case 'Browser.getVersion':
        this.dispatch({
          id: parsed.id,
          sessionId: parsed.sessionId,
          method: parsed.method,
          result: {
            protocolVersion: '1.3',
            product: 'chrome',
            revision: 'unknown',
            userAgent: 'chrome',
            jsVersion: 'unknown',
          },
        });
        return;

      case 'Target.getBrowserContexts':
        this.dispatch({
          id: parsed.id,
          sessionId: parsed.sessionId,
          method: parsed.method,
          result: { browserContextIds: [] },
        });
        return;

      case 'Target.setDiscoverTargets':
        this.dispatch({ method: 'Target.targetCreated', params: { targetInfo: this.targets.tab } });
        this.dispatch({ method: 'Target.targetCreated', params: { targetInfo: this.targets.page } });
        this.dispatch({
          id: parsed.id,
          sessionId: parsed.sessionId,
          method: parsed.method,
          result: {},
        });
        return;

      case 'Target.attachToTarget':
      case 'Target.createTarget':
      case 'Target.closeTarget':
        this.dispatch({
          id: parsed.id,
          sessionId: parsed.sessionId,
          method: parsed.method,
          error: {
            message: `${parsed.method} is unavailable over chrome.debugger — one tab per connection, use the extension tabs RPC`,
          },
        });
        return;

      case 'Target.setAutoAttach':
        if (parsed.sessionId === this.tabSessionId) {
          this.dispatch({
            method: 'Target.attachedToTarget',
            params: { targetInfo: this.targets.page, sessionId: this.pageSessionId },
          });
          this.dispatch({
            id: parsed.id,
            sessionId: parsed.sessionId,
            method: parsed.method,
            result: {},
          });
          return;
        }
        if (!parsed.sessionId) {
          this.dispatch({
            method: 'Target.attachedToTarget',
            params: { targetInfo: this.targets.tab, sessionId: this.tabSessionId },
          });
          this.dispatch({
            id: parsed.id,
            sessionId: parsed.sessionId,
            method: parsed.method,
            result: {},
          });
          return;
        }
        break;
    }

    const sessionId = parsed.sessionId === this.pageSessionId ? undefined : parsed.sessionId;

    this.sendCommand({
      tabId: this.tabId,
      ...(sessionId && { sessionId }),
      method: parsed.method!,
      params: parsed.params,
    })
      .then((result) => {
        this.dispatch({
          id: parsed.id,
          sessionId: parsed.sessionId ?? this.pageSessionId,
          method: parsed.method,
          result,
        });
      })
      .catch((err: Error) => {
        this.dispatch({
          id: parsed.id,
          sessionId: parsed.sessionId ?? this.pageSessionId,
          method: parsed.method,
          error: { message: err?.message ?? 'CDP error had no message' },
        });
      });
  }

  /** Feed a chrome.debugger.onEvent frame relayed by the extension. */
  emitEvent(method: string, params: unknown, sessionId?: string): void {
    this.dispatch({ sessionId: sessionId ?? this.pageSessionId, method, params });
  }

  close(): void {
    this.onClosed?.();
    this.onclose?.();
  }

  private dispatch(message: CDPMessage): void {
    this.onmessage?.(JSON.stringify(message));
  }
}

import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import puppeteer, { Browser } from 'puppeteer-core';
import { ExtensionBridgeTransport } from './transport';

export interface ExtensionTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  windowId: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 30000;

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Bridge between the MCP server and a Chrome extension holding chrome.debugger.
 * Loopback-only WebSocket, token-authenticated; the extension is the only way to
 * reach the user's real profile since Chrome 136+ refuses CDP on the default
 * user data dir.
 */
export class ExtensionBridgeServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private nextCallId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly transports = new Map<number, ExtensionBridgeTransport>();
  private connectionWaiters: Array<() => void> = [];

  constructor(
    private readonly port: number,
    readonly token: string = crypto.randomBytes(24).toString('hex')
  ) {}

  async start(): Promise<void> {
    this.server = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end('WebSocket only');
    });

    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (req, socket, head) => {
      const token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? '';
      if (!tokensMatch(token, this.token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.adoptSocket(ws));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', resolve);
    });

    console.error(`[ExtensionBridge] Listening on ws://127.0.0.1:${this.port}?token=${this.token}`);
  }

  private adoptSocket(ws: WebSocket): void {
    this.socket?.close();
    this.socket = ws;
    console.error('[ExtensionBridge] Extension connected');

    ws.on('message', (raw) => this.handleMessage(raw.toString()));
    ws.on('close', () => {
      if (this.socket === ws) this.socket = null;
      for (const { reject } of this.pending.values()) {
        reject(new Error('Extension disconnected'));
      }
      this.pending.clear();
      for (const transport of this.transports.values()) transport.close();
      this.transports.clear();
      console.error('[ExtensionBridge] Extension disconnected');
    });

    const waiters = this.connectionWaiters;
    this.connectionWaiters = [];
    for (const notify of waiters) notify();
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      error?: string;
      event?: string;
      tabId?: number;
      sessionId?: string;
      method?: string;
      params?: unknown;
    };

    if (message.event === 'debugger.event' && message.tabId !== undefined) {
      this.transports
        .get(message.tabId)
        ?.emitEvent(message.method!, message.params, message.sessionId);
      return;
    }

    if (message.event === 'debugger.detached' && message.tabId !== undefined) {
      this.transports.get(message.tabId)?.close();
      this.transports.delete(message.tabId);
      return;
    }

    if (message.id === undefined) return;

    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);

    if (message.error) {
      call.reject(new Error(message.error));
      return;
    }
    call.resolve(message.result);
  }

  private call(method: string, params?: unknown): Promise<unknown> {
    if (!this.socket) return Promise.reject(new Error('No extension connected'));

    const id = this.nextCallId++;
    this.socket.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension call timed out: ${method}`));
      }, DEFAULT_CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  async waitForExtension(timeoutMs: number): Promise<void> {
    if (this.socket) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No extension connected after ${timeoutMs}ms`)),
        timeoutMs
      );
      this.connectionWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async listTabs(): Promise<ExtensionTab[]> {
    return (await this.call('tabs.query')) as ExtensionTab[];
  }

  async createTab(url: string): Promise<ExtensionTab> {
    return (await this.call('tabs.create', { url })) as ExtensionTab;
  }

  /**
   * Attach chrome.debugger to a tab and wrap it in a Puppeteer Browser whose
   * single page is that tab. chrome.debugger attaches per tab, so each tab needs
   * its own transport.
   */
  async attachTab(tabId: number): Promise<Browser> {
    await this.call('debugger.attach', { tabId });

    const transport = new ExtensionBridgeTransport(
      tabId,
      (command) => this.call('debugger.sendCommand', command),
      () => {
        this.transports.delete(tabId);
        void this.call('debugger.detach', { tabId }).catch(() => {});
      }
    );
    this.transports.set(tabId, transport);

    return puppeteer.connect({ transport, defaultViewport: null });
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
    this.socket?.close();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }
}

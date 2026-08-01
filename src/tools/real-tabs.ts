/**
 * Real Tabs Tool - drive the signed-in Chrome profile through the extension bridge.
 *
 * Chrome 136+ refuses CDP on the default user data dir, so tabs the user is
 * signed into are only reachable via chrome.debugger inside an extension.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { getExtensionBridge, bridgeTargetId, ExtensionBridgeServer } from '../extension-bridge';
import { safeTitle } from '../utils/safe-title';
import { getChromeLauncher } from '../chrome/launcher';

const REAL_WORKER_ID = 'extension';
const EXTENSION_WAIT_MS = Number(process.env.OPENCHROME_BRIDGE_WAIT_MS ?? 20000);
const BRIDGE_RECONNECT_WAIT_MS = Number(process.env.OPENCHROME_BRIDGE_RECONNECT_WAIT_MS ?? 5000);
const BRIDGE_CALL_ATTEMPTS = 3;

async function withReconnect<T>(
  bridge: ExtensionBridgeServer,
  fn: () => Promise<T>,
  log?: (msg: string) => void
): Promise<T> {
  for (let attempt = 1; attempt <= BRIDGE_CALL_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    try {
      const result = await fn();
      log?.(`attempt-${attempt}:ok:${Date.now() - t0}ms`);
      return result;
    } catch (err) {
      const dt = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      const retriable = message.includes('Extension disconnected') || message.includes('No extension connected');
      log?.(`attempt-${attempt}:${retriable ? 'retry' : 'fail'}:${dt}ms:${message}`);
      if (!retriable || attempt === BRIDGE_CALL_ATTEMPTS) throw err;
      const waitStart = Date.now();
      await bridge.waitForExtension(BRIDGE_RECONNECT_WAIT_MS);
      log?.(`waited:${Date.now() - waitStart}ms`);
    }
  }
  throw new Error('unreachable');
}

const DEFAULT_MAX_TABS = 10;

const definition: MCPToolDefinition = {
  name: 'real_tabs',
  description:
    'List tabs from the signed-in Chrome profile via the OpenChrome Bridge extension, or attach one so every other tool can drive it. Omit tabId to list.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'number',
        description: 'Chrome tab id to attach. Omit to list available tabs.',
      },
      url: {
        type: 'string',
        description: 'Open this URL in a new tab of the real profile and attach it.',
      },
      compact: {
        type: 'boolean',
        description: 'Return a compact tab list without windowId/active and in one-line JSON. Default: true.',
      },
      maxTabs: {
        type: 'number',
        description: `Maximum tabs to return when listing. Default: ${DEFAULT_MAX_TABS}.`,
      },
    },
    required: [],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const requestedTabId = args.tabId as number | undefined;
  const url = args.url as string | undefined;
  const compact = args.compact !== false;
  const maxTabs = Math.max(1, Math.min(args.maxTabs as number | undefined ?? DEFAULT_MAX_TABS, 100));
  const start = Date.now();
  const marks: string[] = ['start'];

  const mark = (label: string): void => {
    marks.push(`${label}:${Date.now() - start}ms`);
  };

  try {
    const bridge = await getExtensionBridge();
    mark('bridge');
    const launcher = getChromeLauncher();
    mark('launcher');
    if (!launcher.isChromeRunning()) {
      return {
        content: [
          {
            type: 'text',
            text: 'Chrome is not running. Start Chrome with the OpenChrome Bridge extension loaded to use real_tabs.',
          },
        ],
        isError: true,
      };
    }
    await bridge.waitForExtension(EXTENSION_WAIT_MS);
    mark('waited');

    if (requestedTabId === undefined && !url) {
      const tabs = (await withReconnect(bridge, () => bridge.listTabs(), (m) => console.error(`[real_tabs] listTabs ${m}`))).slice(0, maxTabs);
      mark('listed');
      const output = compact
        ? {
            action: 'real_tabs',
            tabCount: tabs.length,
            tabs: tabs.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })),
            timing: marks.join(' '),
          }
        : { action: 'real_tabs', tabCount: tabs.length, tabs, timing: marks.join(' ') };
      console.error(`[real_tabs] total:${Date.now() - start}ms ${marks.join(' ')}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, compact ? undefined : 2),
          },
        ],
      };
    }

    const chromeTabId = url
      ? (await withReconnect(bridge, () => bridge.createTab(url), (m) => console.error(`[real_tabs] createTab ${m}`))).id
      : requestedTabId!;
    mark('created');
    const browser = await withReconnect(bridge, () => bridge.attachTab(chromeTabId), (m) => console.error(`[real_tabs] attachTab ${m}`));
    mark('attached');
    const page = (await browser.pages())[0];

    const sessionManager = getSessionManager();
    await sessionManager.getOrCreateWorker(sessionId, REAL_WORKER_ID, { shareCookies: false });

    const targetId = bridgeTargetId(chromeTabId);
    sessionManager.registerHeadedPage(targetId, sessionId, REAL_WORKER_ID, page);

    const title = await safeTitle(page);
    mark('title');
    console.error(`[real_tabs] total:${Date.now() - start}ms ${marks.join(' ')}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'real_tabs',
            attached: true,
            tabId: targetId,
            workerId: REAL_WORKER_ID,
            chromeTabId,
            url: page.url(),
            title,
            timing: marks.join(' '),
          }),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: message.includes('No extension')
            ? `${message}. Load extension/bridge as an unpacked extension in chrome://extensions — it connects on its own.`
            : `Real tabs error: ${message}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerRealTabsTool(server: MCPServer): void {
  server.registerTool('real_tabs', handler, definition);
}

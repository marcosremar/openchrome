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
const BRIDGE_CALL_ATTEMPTS = 3;

async function withReconnect<T>(
  bridge: ExtensionBridgeServer,
  fn: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; attempt <= BRIDGE_CALL_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retriable = message.includes('Extension disconnected') || message.includes('No extension connected');
      if (!retriable || attempt === BRIDGE_CALL_ATTEMPTS) throw err;
      await bridge.waitForExtension(EXTENSION_WAIT_MS);
    }
  }
  throw new Error('unreachable');
}

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

  try {
    const bridge = await getExtensionBridge();
    const launcher = getChromeLauncher();
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

    if (requestedTabId === undefined && !url) {
      const tabs = await withReconnect(bridge, () => bridge.listTabs());
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ action: 'real_tabs', tabCount: tabs.length, tabs }, null, 2),
          },
        ],
      };
    }

    const chromeTabId = url
      ? (await withReconnect(bridge, () => bridge.createTab(url))).id
      : requestedTabId!;
    const browser = await withReconnect(bridge, () => bridge.attachTab(chromeTabId));
    const page = (await browser.pages())[0];

    const sessionManager = getSessionManager();
    await sessionManager.getOrCreateWorker(sessionId, REAL_WORKER_ID, { shareCookies: false });

    const targetId = bridgeTargetId(chromeTabId);
    sessionManager.registerHeadedPage(targetId, sessionId, REAL_WORKER_ID, page);

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
            title: await safeTitle(page),
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

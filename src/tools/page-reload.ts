/**
 * Page Reload Tool - Reload current page
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../utils/safe-title';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../config/defaults';

const definition: MCPToolDefinition = {
  name: 'page_reload',
  description: 'Reload the current page.',
  inputSchema: {
    type: 'object',
    properties: {
      tabId: {
        type: 'string',
        description: 'Tab ID to reload',
      },
      ignoreCache: {
        type: 'boolean',
        description: 'Bypass cache (hard refresh). Default: false',
      },
    },
    required: ['tabId'],
  },
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const tabId = args.tabId as string;
  const ignoreCache = (args.ignoreCache as boolean) ?? false;

  const sessionManager = getSessionManager();

  if (!tabId) {
    return {
      content: [{ type: 'text', text: 'Error: tabId is required' }],
      isError: true,
    };
  }

  try {
    const page = await sessionManager.getPage(sessionId, tabId, undefined, 'page_reload');
    if (!page) {
      return {
        content: [{ type: 'text', text: `Error: Tab ${tabId} not found` }],
        isError: true,
      };
    }

    const urlBefore = page.url();

    // Reload the page
    if (ignoreCache) {
      await page.setCacheEnabled(false);
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
      } finally {
        await page.setCacheEnabled(true).catch(() => {});
      }
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: DEFAULT_NAVIGATION_TIMEOUT_MS });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            action: 'reload',
            url: page.url(),
            title: await safeTitle(page),
            ignoreCache,
            message: ignoreCache ? 'Page reloaded (cache bypassed)' : 'Page reloaded',
          }),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Reload error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerPageReloadTool(server: MCPServer): void {
  server.registerTool('page_reload', handler, definition);
}

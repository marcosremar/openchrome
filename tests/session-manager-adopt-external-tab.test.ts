/// <reference types="jest" />

const pagesByTargetId = new Map<string, any>();

const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  addConnectionListener: jest.fn(),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn(),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
  getBrowser: jest.fn().mockReturnValue({ targets: jest.fn().mockReturnValue([]) }),
  getPageByTargetId: jest.fn(async (targetId: string) => pagesByTargetId.get(targetId) ?? null),
  getPages: jest.fn(async () => Array.from(pagesByTargetId.values())),
};

jest.mock('../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
  getCDPClientFactory: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(mockCdpClientInstance),
    getOrCreate: jest.fn().mockReturnValue(mockCdpClientInstance),
    getAll: jest.fn().mockReturnValue([mockCdpClientInstance]),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn(),
  getCDPConnectionPool: jest.fn().mockReturnValue({}),
}));

jest.mock('../src/utils/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_: unknown, fn: () => unknown) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

import { SessionManager } from '../src/session-manager';

function addPage(targetId: string, url: string, title = 'Page') {
  const page = {
    isClosed: () => false,
    url: () => url,
    title: async () => title,
    target: () => ({ _targetId: targetId }),
  };
  pagesByTargetId.set(targetId, page);
  return page;
}

function newSessionManager() {
  return new SessionManager(undefined, {
    autoCleanup: false,
    useConnectionPool: false,
    useDefaultContext: true,
  });
}

describe('SessionManager external tab adoption', () => {
  beforeEach(() => {
    pagesByTargetId.clear();
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('adopts an untracked tab into a session with no tabs', async () => {
    const sm = newSessionManager();
    await sm.createSession({ id: 's1' });
    addPage('external-1', 'https://example.com/');

    const page = await sm.getPage('s1', 'external-1');

    expect(page).not.toBeNull();
    expect(sm.getTargetOwner('external-1')).toEqual({ sessionId: 's1', workerId: 'default' });
  });

  test('refuses a tab owned by another session', async () => {
    const sm = newSessionManager();
    await sm.createSession({ id: 's1' });
    await sm.createSession({ id: 's2' });
    addPage('owned-1', 'https://example.com/');
    sm.registerExternalTarget('owned-1', 's1', 'default');

    await expect(sm.getPage('s2', 'owned-1')).rejects.toThrow('not found in session s2');
    expect(sm.getTargetOwner('owned-1')).toEqual({ sessionId: 's1', workerId: 'default' });
  });

  test('refuses internal chrome pages', async () => {
    const sm = newSessionManager();
    await sm.createSession({ id: 's1' });
    addPage('internal-1', 'chrome://settings');

    await expect(sm.getPage('s1', 'internal-1')).rejects.toThrow('not found in session s1');
  });

  test('listUntrackedTabs returns only unowned, non-internal tabs', async () => {
    const sm = newSessionManager();
    await sm.createSession({ id: 's1' });
    addPage('owned-1', 'https://owned.example/', 'Owned');
    addPage('external-1', 'https://external.example/', 'External');
    addPage('internal-1', 'chrome://settings', 'Settings');
    sm.registerExternalTarget('owned-1', 's1', 'default');

    const untracked = await sm.listUntrackedTabs('s1');

    expect(untracked).toEqual([
      { tabId: 'external-1', url: 'https://external.example/', title: 'External' },
    ]);
  });
});

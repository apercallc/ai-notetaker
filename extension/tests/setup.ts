import { vi } from "vitest";

/**
 * Minimal fake of the chrome.* APIs this extension uses, enough to unit test
 * storage.ts and nativeMessaging.ts logic without a real browser. Each test
 * file resets/reconfigures this as needed via chromeMock.reset().
 */
function createStorageArea() {
  let store: Record<string, unknown> = {};
  // Real Chrome storage areas support BOTH the callback form and the promise
  // form (callback omitted). The mock implements both so promise-based code
  // (meet/pendingStart.ts) and callback-based code (popup desktop-intent)
  // exercise against the same store.
  const get = vi.fn((keys: string | string[] | null, callback?: (items: Record<string, unknown>) => void) => {
    const result: Record<string, unknown> = {};
    if (keys === null) Object.assign(result, store);
    else {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) if (key in store) result[key] = store[key];
    }
    callback?.(result);
    return Promise.resolve(result);
  });
  const set = vi.fn((items: Record<string, unknown>, callback?: () => void) => {
    store = { ...store, ...items };
    callback?.();
    return Promise.resolve();
  });
  const remove = vi.fn((keys: string | string[], callback?: () => void) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) delete store[key];
    callback?.();
    return Promise.resolve();
  });
  return {
    get,
    set,
    remove,
    _dump: () => store,
    _reset: () => {
      store = {};
    },
  };
}

const storageLocal = createStorageArea();
const storageSync = createStorageArea();
const storageSession = createStorageArea();

export const chromeMock = {
  storage: {
    local: storageLocal,
    sync: storageSync,
    session: storageSession,
  },
  runtime: {
    id: "fake-extension-id",
    getURL: (path: string) => `chrome-extension://fake-extension-id/${path}`,
    connectNative: vi.fn(),
    sendMessage: vi.fn(),
    openOptionsPage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    lastError: undefined as { message: string } | undefined,
  },
  identity: {
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: vi.fn(() => "https://fake-extension-id.chromiumapp.org/"),
  },
  tabs: {
    get: vi.fn(async () => ({ id: 1, url: "https://meet.google.com/test" })),
    query: vi.fn(async (): Promise<Array<{ id?: number; url?: string; title?: string }>> => []),
    create: vi.fn(async () => ({ id: 2 })),
    update: vi.fn(async () => ({ id: 2 })),
  },
  offscreen: {
    Reason: { USER_MEDIA: "USER_MEDIA" },
    hasDocument: vi.fn(async () => false),
    createDocument: vi.fn(async () => undefined),
    closeDocument: vi.fn(async () => undefined),
  },
  reset() {
    storageLocal._reset();
    storageSync._reset();
    storageSession._reset();
    this.runtime.connectNative.mockReset();
    this.runtime.sendMessage.mockReset();
    this.runtime.openOptionsPage.mockReset();
    this.runtime.onMessage.addListener?.mockReset();
    this.runtime.onMessage.removeListener?.mockReset();
    this.runtime.lastError = undefined;
    this.identity.launchWebAuthFlow.mockReset();
    this.identity.getRedirectURL.mockReset();
    this.identity.getRedirectURL.mockReturnValue("https://fake-extension-id.chromiumapp.org/");
    this.tabs.get.mockReset();
    this.tabs.get.mockResolvedValue({ id: 1, url: "https://meet.google.com/test" });
    this.tabs.query?.mockReset();
    this.tabs.query?.mockResolvedValue([]);
    this.tabs.create?.mockReset();
    this.tabs.create?.mockResolvedValue({ id: 2 });
    this.tabs.update?.mockReset();
    this.tabs.update?.mockResolvedValue({ id: 2 });
    this.offscreen.hasDocument.mockReset();
    this.offscreen.hasDocument.mockResolvedValue(false);
    this.offscreen.createDocument.mockReset();
    this.offscreen.closeDocument.mockReset();
  },
};

// @ts-expect-error -- test-only global fake of the chrome extension API
globalThis.chrome = chromeMock;

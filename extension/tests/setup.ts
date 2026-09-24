import { vi } from "vitest";

/**
 * Minimal fake of the chrome.* APIs this extension uses, enough to unit test
 * storage.ts and nativeMessaging.ts logic without a real browser. Each test
 * file resets/reconfigures this as needed via chromeMock.reset().
 */
function createStorageArea() {
  let store: Record<string, unknown> = {};
  return {
    get: vi.fn((keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => {
      if (keys === null) {
        callback({ ...store });
        return;
      }
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (key in store) result[key] = store[key];
      }
      callback(result);
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      store = { ...store, ...items };
      callback?.();
    }),
    remove: vi.fn((keys: string | string[], callback?: () => void) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) delete store[key];
      callback?.();
    }),
    _dump: () => store,
    _reset: () => {
      store = {};
    },
  };
}

const storageLocal = createStorageArea();
const storageSync = createStorageArea();

export const chromeMock = {
  storage: {
    local: storageLocal,
    sync: storageSync,
  },
  runtime: {
    id: "fake-extension-id",
    getURL: (path: string) => `chrome-extension://fake-extension-id/${path}`,
    connectNative: vi.fn(),
    sendMessage: vi.fn(),
    lastError: undefined as { message: string } | undefined,
  },
  identity: {
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: vi.fn(() => "https://fake-extension-id.chromiumapp.org/"),
  },
  tabs: {
    get: vi.fn(async () => ({ id: 1, url: "https://meet.google.com/test" })),
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
    this.runtime.connectNative.mockReset();
    this.runtime.sendMessage.mockReset();
    this.runtime.lastError = undefined;
    this.identity.launchWebAuthFlow.mockReset();
    this.identity.getRedirectURL.mockReset();
    this.identity.getRedirectURL.mockReturnValue("https://fake-extension-id.chromiumapp.org/");
    this.tabs.get.mockReset();
    this.tabs.get.mockResolvedValue({ id: 1, url: "https://meet.google.com/test" });
    this.offscreen.hasDocument.mockReset();
    this.offscreen.hasDocument.mockResolvedValue(false);
    this.offscreen.createDocument.mockReset();
    this.offscreen.closeDocument.mockReset();
  },
};

// @ts-expect-error -- test-only global fake of the chrome extension API
globalThis.chrome = chromeMock;

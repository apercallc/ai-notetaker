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
    connectNative: vi.fn(),
    lastError: undefined as { message: string } | undefined,
  },
  reset() {
    storageLocal._reset();
    storageSync._reset();
    this.runtime.connectNative.mockReset();
    this.runtime.lastError = undefined;
  },
};

// @ts-expect-error -- test-only global fake of the chrome extension API
globalThis.chrome = chromeMock;

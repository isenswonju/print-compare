// IndexedDB를 메모리 구현으로 제공(cache.ts 테스트용).
import "fake-indexeddb/auto";

// vitest의 jsdom(29)은 localStorage를 노출하지 않는다 — 피드백 보류 큐 테스트를
// 위해 최소 인메모리 Storage를 폴리필한다(실제 앱은 브라우저 localStorage 사용).
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(globalThis, "localStorage", { value: mem, configurable: true });
}

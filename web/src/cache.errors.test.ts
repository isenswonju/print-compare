// IndexedDB 실패 시 cache 계층이 어떤 경우에도 throw하지 않고 폴백값을 주는지
// 검증한다(캐시는 부가 기능 — 실패해도 분석/보관을 막으면 안 된다). fake-indexeddb는
// 정상 동작만 흉내내므로, 실패 경로는 인위적으로 실패하는 IDB를 주입해 확인한다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// 열기 자체가 실패하는 IDB (open 요청이 onerror 발화).
function brokenOpenIDB(): Any {
  return {
    open() {
      const req: Any = { error: new Error("db blocked"),
        onerror: null, onsuccess: null, onupgradeneeded: null };
      queueMicrotask(() => req.onerror && req.onerror());
      return req;
    },
  };
}

// 열기는 성공하지만 모든 트랜잭션/커서 요청이 실패하는 IDB.
function opFailIDB(): Any {
  const failReq = () => {
    const r: Any = { onsuccess: null, onerror: null, error: new Error("op fail"),
      result: undefined };
    queueMicrotask(() => r.onerror && r.onerror());
    return r;
  };
  const store: Any = {
    get: failReq, put: failReq, delete: failReq, openCursor: failReq,
  };
  const db: Any = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const t: Any = { objectStore: () => store, oncomplete: null, onerror: null };
      queueMicrotask(() => t.onerror && t.onerror());
      return t;
    },
  };
  return {
    open() {
      const req: Any = { result: db, onsuccess: null, onerror: null,
        onupgradeneeded: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
}

// 목록 조회(커서)는 되지만 쓰기 트랜잭션이 실패하는 IDB — moveSection이
// 순환 검사를 통과한 뒤 put에서 깨지는 경로(마지막 방어)를 확인하려고 쓴다.
function writeFailIDB(sections: Any[]): Any {
  const store: Any = {
    put: () => ({ onsuccess: null, onerror: null }),
    openCursor() {
      const r: Any = { onsuccess: null, onerror: null, result: null };
      let i = 0;
      const step = () => {
        r.result = i < sections.length
          ? { key: sections[i].id, value: sections[i],
              continue: () => { i++; queueMicrotask(step); } }
          : null;
        r.onsuccess && r.onsuccess();
      };
      queueMicrotask(step);
      return r;
    },
  };
  const db: Any = {
    objectStoreNames: { contains: () => true },
    transaction(_name: string, mode?: string) {
      const t: Any = { objectStore: () => store, oncomplete: null,
                       onerror: null, error: new Error("write fail") };
      // 읽기는 커서 콜백으로 끝나고, 쓰기만 트랜잭션 실패로 떨어뜨린다.
      if (mode === "readwrite") queueMicrotask(() => t.onerror && t.onerror());
      return t;
    },
  };
  return {
    open() {
      const req: Any = { result: db, onsuccess: null, onerror: null,
        onupgradeneeded: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
}

const file = (n: string) => new File(["x"], n, { type: "image/png" });

// 두 실패 IDB 모두에서 "throw 없이 폴백"을 확인하는 공통 검증.
async function expectAllFallbacks() {
  const m = await import("./cache.ts");
  expect(await m.listArtworks()).toEqual([]);        // catch → []
  expect(await m.listSections()).toEqual([]);        // catch → []
  expect(await m.getRefWords("h")).toBeUndefined();  // .catch → undefined
  expect(await m.getArtworkFile("h")).toBeNull();    // catch → null
  expect(await m.createSection("x")).toBeNull();     // catch → null
  expect(await m.loadSession()).toBeNull();          // catch → null
  // 값을 반환하지 않는 쓰기/삭제도 throw하지 않아야 한다.
  await m.saveArtwork("h", file("a.png"));
  await m.deleteArtwork("h");
  await m.setArtworkSection("h", "s");
  await m.renameSection("id", "n");
  await m.deleteSection("id");
  await m.putRefWords("h", []);
  await m.saveSession([{ name: "x" }]);
  await m.clearSession();
  // 동기화 계층도 안전하게 폴백
  expect(await m.moveSection("a", "b")).toBe(false);   // catch/목록 없음 → false
  expect(await m.listArtworkHashes()).toEqual(new Set()); // catch → 빈 집합
  expect(await m.getArtworkBlob("h")).toBeNull();      // catch → null
  await m.putSections([{ id: "s", name: "n", createdAt: 1 }]);
  const manifest = await m.exportManifest();
  expect(manifest.artworks).toEqual([]);
  const r = await m.importLibrary({ version: 1, exportedAt: 1, sections: [],
    artworks: [{ hash: "z", name: "z.png", size: 1, type: "image/png",
      dataB64: btoa("z") }] });
  expect(r.artworks).toBe(0); // 개별 put 실패 → 건너뜀
}

describe("cache — IndexedDB 실패 방어", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it("openDB 실패: 모든 조회/쓰기가 폴백(throw 없음)", async () => {
    vi.stubGlobal("indexedDB", brokenOpenIDB());
    await expectAllFallbacks();
  });

  it("트랜잭션/커서 실패: onerror 경로로도 폴백(throw 없음)", async () => {
    vi.stubGlobal("indexedDB", opFailIDB());
    await expectAllFallbacks();
  });

  it("listArtworkHashes: 키 조회가 값을 안 주면 빈 집합", async () => {
    // tx()는 요청 result가 undefined면 undefined를 돌려준다 — 그 폴백 경로.
    const db: Any = {
      objectStoreNames: { contains: () => true },
      transaction() {
        const store: Any = { getAllKeys: () =>
          ({ onsuccess: null, onerror: null, result: undefined }) };
        const t: Any = { objectStore: () => store, oncomplete: null, onerror: null };
        queueMicrotask(() => t.oncomplete && t.oncomplete());
        return t;
      },
    };
    vi.stubGlobal("indexedDB", {
      open() {
        const req: Any = { result: db, onsuccess: null, onerror: null,
          onupgradeneeded: null };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    });
    const m = await import("./cache.ts");
    expect(await m.listArtworkHashes()).toEqual(new Set());
  });

  it("moveSection: 순환 검사를 통과해도 쓰기가 깨지면 false", async () => {
    vi.stubGlobal("indexedDB", writeFailIDB([
      { id: "a", name: "A", createdAt: 1 },
      { id: "b", name: "B", createdAt: 2 }]));
    const m = await import("./cache.ts");
    expect(await m.moveSection("b", "a")).toBe(false);
  });

  it("getArtworkFile: 배경 lastUsed 갱신이 실패해도 파일은 반환(catch 무시)", async () => {
    // readonly get은 성공(rec 반환), readwrite put은 실패 → 배경 갱신 .catch 경로.
    const rec = { name: "a.png", type: "image/png",
      blob: new Blob(["x"], { type: "image/png" }), lastUsed: 0, size: 1 };
    const okReq = (result: unknown) => {
      const r: Any = { onsuccess: null, onerror: null, result };
      queueMicrotask(() => r.onsuccess && r.onsuccess());
      return r;
    };
    const failReq = () => {
      const r: Any = { onsuccess: null, onerror: null, error: new Error("write fail") };
      queueMicrotask(() => r.onerror && r.onerror());
      return r;
    };
    const db: Any = {
      objectStoreNames: { contains: () => true },
      transaction(_s: string, mode: string) {
        const store = mode === "readonly"
          ? { get: () => okReq(rec) }
          : { put: failReq };
        const t: Any = { objectStore: () => store, oncomplete: null, onerror: null };
        queueMicrotask(() =>
          mode === "readonly" ? t.oncomplete && t.oncomplete()
            : t.onerror && t.onerror());
        return t;
      },
    };
    const idb: Any = {
      open() {
        const req: Any = { result: db, onsuccess: null, onerror: null,
          onupgradeneeded: null };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    };
    vi.stubGlobal("indexedDB", idb);
    const m = await import("./cache.ts");
    const f = await m.getArtworkFile("h");
    expect(f).toBeInstanceOf(File); // 조회 성공 → File 반환(배경 put 실패는 삼킴)
  });

  it("onupgradeneeded: 이미 있는 스토어는 다시 만들지 않는다(멱등)", async () => {
    // 스토어가 모두 존재하는 DB로 업그레이드 → 모든 !contains 분기의 '건너뜀' 쪽.
    const existing = new Set(["refWords", "artworks", "session", "sections"]);
    const created: string[] = [];
    const db: Any = {
      objectStoreNames: { contains: (n: string) => existing.has(n) },
      createObjectStore: (n: string) => { created.push(n); },
      transaction: () => ({
        objectStore: () => ({
          openCursor: () => {
            const r: Any = { onsuccess: null, onerror: null, result: null };
            queueMicrotask(() => r.onsuccess && r.onsuccess());
            return r;
          },
        }),
        oncomplete: null, onerror: null,
      }),
    };
    const idb: Any = {
      open() {
        const req: Any = { result: db, onerror: null, onsuccess: null,
          onupgradeneeded: null };
        queueMicrotask(() => {
          req.onupgradeneeded && req.onupgradeneeded();
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
    };
    vi.stubGlobal("indexedDB", idb);
    const m = await import("./cache.ts");
    expect(await m.listArtworks()).toEqual([]); // 열림 성공
    expect(created).toEqual([]);                // 이미 있으므로 생성 0
  });

  // v3→v4 업그레이드에서 실제로 겪은 사고: 다른 탭이 옛 버전으로 DB를 붙들고
  // 있으면 open이 성공도 실패도 하지 않고 영원히 매달려 보관함이 통째로 멈췄다.
  it("onblocked: 무한 대기 대신 즉시 폴백하고, 다음 호출은 다시 시도한다", async () => {
    let opens = 0;
    let blockNext = true;
    const store: Any = {
      openCursor: () => {
        const r: Any = { onsuccess: null, onerror: null, result: null };
        queueMicrotask(() => r.onsuccess && r.onsuccess());
        return r;
      },
    };
    const db: Any = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({ objectStore: () => store, oncomplete: null,
                            onerror: null }),
    };
    const idb: Any = {
      open() {
        opens++;
        const req: Any = { result: db, onerror: null, onsuccess: null,
          onblocked: null, onupgradeneeded: null };
        queueMicrotask(() => {
          // 첫 시도는 다른 탭에 막히고, 그 탭이 닫힌 뒤의 재시도는 성공한다.
          if (blockNext) { blockNext = false; req.onblocked && req.onblocked(); }
          else req.onsuccess && req.onsuccess();
        });
        return req;
      },
    };
    vi.stubGlobal("indexedDB", idb);
    const m = await import("./cache.ts");
    // 매달리지 않고 폴백값이 나온다(테스트가 타임아웃되면 회귀).
    expect(await m.listArtworks()).toEqual([]);
    expect(opens).toBe(1);
    // 실패한 연결을 캐시해두면 새로고침 전까지 영구 실패한다 — 재시도돼야 한다.
    expect(await m.listArtworks()).toEqual([]);
    expect(opens).toBe(2);
  });

  it("onversionchange: 다른 탭의 업그레이드를 막지 않도록 연결을 놓아준다", async () => {
    let closed = false;
    const store: Any = {
      openCursor: () => {
        const r: Any = { onsuccess: null, onerror: null, result: null };
        queueMicrotask(() => r.onsuccess && r.onsuccess());
        return r;
      },
    };
    const db: Any = {
      objectStoreNames: { contains: () => true },
      onversionchange: null,
      close: () => { closed = true; },
      transaction: () => ({ objectStore: () => store, oncomplete: null,
                            onerror: null }),
    };
    const idb: Any = {
      open() {
        const req: Any = { result: db, onerror: null, onsuccess: null,
          onblocked: null, onupgradeneeded: null };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    };
    vi.stubGlobal("indexedDB", idb);
    const m = await import("./cache.ts");
    await m.listArtworks();
    expect(typeof db.onversionchange).toBe("function"); // 핸들러가 걸려 있어야
    db.onversionchange();
    expect(closed).toBe(true);
  });
});

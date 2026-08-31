// 공용 보관함 동기화의 안전장치 — 서버 목록을 잃지 않는지가 핵심이다.
// 2026-08-31 실제로 서버 매니페스트가 빈 것으로 덮여 이름·폴더가 날아갔다:
// 로컬 IndexedDB가 멈춰 exportManifest()가 빈 값을 주는 상태에서, 원격
// 매니페스트를 못 읽자(null) 그 빈 값을 그대로 올려버린 것이다.
// 파일 blob은 내용 주소라 남았지만 목록은 최근 5개 이력까지 함께 덮여
// 되돌릴 수 없었다. 그래서 아래 두 가지를 계약으로 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./branding.ts", () => ({
  branding: { libraryUrl: "https://example.test/api/library" },
}));
vi.mock("@vercel/blob/client", () => ({ upload: vi.fn(async () => ({})) }));

const cacheState = {
  manifest: { version: 3, exportedAt: 1, sections: [], artworks: [],
              deleted: { artworks: {}, sections: {} } },
};
vi.mock("./cache.ts", () => ({
  exportManifest: async () => cacheState.manifest,
  getArtworkBlob: async () => null,
  importLibrary: async () => ({ artworks: 0, sections: 0 }),
  mergeManifests: (a: never) => a,
  applyManifestToLocal: async () => {},
  replaceTombstones: async () => {},
  pruneBlobCache: async () => 0,
}));

const listResponse = (files: unknown[], manifestUrl: string | null) =>
  ({ ok: true, status: 200, json: async () => ({ files, manifestUrl }) });

describe("동기화 안전장치 — 서버 목록을 덮어쓰지 않는다", () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); });

  it("매니페스트를 못 읽으면 멈춘다(빈 목록으로 덮어쓰지 않음)", async () => {
    // listfiles는 성공하지만 매니페스트 blob 요청이 실패하는 상황.
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/library")
        ? listResponse([{ hash: "a1", url: "u1", size: 1 }], "https://blob/m.json")
        : Promise.reject(new Error("network"))));
    const { syncLibraryWithServer } = await import("./server-library.ts");
    await expect(syncLibraryWithServer()).rejects.toThrow(/서버 목록을 읽지 못해/);
  });

  it("삭제 기록 없이 서버 항목이 사라지면 멈춘다", async () => {
    const remote = { version: 3, exportedAt: 1, sections: [],
      artworks: [{ hash: "srv1", name: "남의것.png", size: 1, type: "image/png" }],
      deleted: { artworks: {}, sections: {} } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/library")
        ? listResponse([{ hash: "srv1", url: "u1", size: 1 }], "https://blob/m.json")
        : ({ ok: true, status: 200, json: async () => remote })));
    // mergeManifests가 (잘못) 내 것만 돌려주는 상황을 흉내낸다 — 그래도
    // 서버 항목이 조용히 사라지면 안 된다.
    const { syncLibraryWithServer } = await import("./server-library.ts");
    await expect(syncLibraryWithServer()).rejects.toThrow(/사라질 뻔/);
  });

  it("서버에 아직 아무것도 없으면 정상 진행한다(첫 동기화)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => listResponse([], null)));
    const { syncLibraryWithServer } = await import("./server-library.ts");
    const r = await syncLibraryWithServer();
    expect(r.artworks).toBe(0);
  });
});

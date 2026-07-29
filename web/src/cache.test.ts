import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_MANIFEST_VERSION, clearSession, createSection, deleteArtwork,
  deleteSection, exportManifest, getArtworkBlob, getArtworkFile, getRefWords,
  hashFile, importLibrary, listArtworkHashes, listArtworks, listSections,
  loadSession, mergeManifests, moveSection, putRefWords, putSections,
  renameSection, requestPersistentStorage, saveArtwork, saveArtworkBlob,
  saveSession, setArtworkSection, storageEstimate,
  type LibraryManifest, type StoredSet,
} from "./cache.ts";
import type { Word } from "./types.ts";

const file = (name: string, bytes = "abc") =>
  new File([bytes], name, { type: "image/png" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("세션 결과 영속화 (resume한 기능)", () => {
  it("저장→복원 왕복 (구조 데이터 보존)", async () => {
    // 이미지 Blob 바이너리의 왕복은 실브라우저/E2E가 담당한다(jsdom+fake-indexeddb는
    // Blob을 structuredClone하지 못함). 여기서는 세션 계층이 결함 결과·피드백 등
    // 구조 데이터를 온전히 저장·복원하는지 검증한다 — resume한 영속화의 핵심.
    const sets: StoredSet[] = [
      { name: "세트1",
        result: { findings: [], timings: [], totalMs: 12 },
        fb: { defects: { 1: { fp: true, cause: "먼지", comment: "노이즈",
                              ktype: "가독성", bbox: [1, 2, 3, 4] } }, missed: [] } },
      { name: "세트2", error: "실패" },
    ];
    await saveSession(sets, 1_700_000_000_000);
    const loaded = await loadSession();
    expect(loaded!.sets).toHaveLength(2);
    expect(loaded!.sets[0].name).toBe("세트1");
    expect(loaded!.sets[0].result).toEqual({ findings: [], timings: [], totalMs: 12 });
    expect(loaded!.sets[0].fb!.defects[1].comment).toBe("노이즈");
    expect(loaded!.sets[1].error).toBe("실패");
    // 분석 시각도 함께 보존된다
    expect(loaded!.analyzedAt).toBe(1_700_000_000_000);
  });

  it("clearSession 후에는 null", async () => {
    await saveSession([{ name: "x" }]);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it("7일 TTL이 지나면 만료되어 null", async () => {
    const base = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    await saveSession([{ name: "오래됨" }]);
    now.mockReturnValue(base + 8 * 24 * 60 * 60 * 1000); // 8일 후
    expect(await loadSession()).toBeNull();
  });

  it("TTL 이내면 유지", async () => {
    const base = 1_700_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(base);
    await saveSession([{ name: "최근" }]);
    now.mockReturnValue(base + 6 * 24 * 60 * 60 * 1000); // 6일 후
    const loaded = await loadSession();
    expect(loaded).not.toBeNull();
    expect(loaded!.sets[0].name).toBe("최근");
  });
});

describe("REF OCR 단어 캐시", () => {
  it("put→get 왕복", async () => {
    const words: Word[] = [{ text: "hi", conf: 90, bbox: [0, 0, 1, 1], line: [0, 0, 0] }];
    await putRefWords("hashA", words);
    const hit = await getRefWords("hashA");
    expect(hit?.words).toEqual(words);
  });
  it("없는 해시는 undefined", async () => {
    expect(await getRefWords("nope")).toBeUndefined();
  });
});

describe("아트웍 보관함 — 영구 보관·삭제·정렬", () => {
  it("60개를 넣어도 자동 삭제되지 않는다(영구 보관)", async () => {
    for (let i = 0; i < 60; i++)
      await saveArtwork(`perm${i}`, file(`p${String(i).padStart(2, "0")}.png`));
    const all = await listArtworks();
    expect(all.filter((a) => a.hash.startsWith("perm"))).toHaveLength(60);
  });

  it("이름(가나다·ABC) 오름차순으로 정렬된다", async () => {
    await saveArtwork("sortC", file("나.png"));
    await saveArtwork("sortA", file("가.png"));
    await saveArtwork("sortB", file("다.png"));
    const names = (await listArtworks())
      .filter((a) => a.hash.startsWith("sort")).map((a) => a.name);
    expect(names).toEqual(["가.png", "나.png", "다.png"]);
  });

  it("deleteArtwork로 명시적 삭제", async () => {
    await saveArtwork("del1", file("d.png"));
    expect(await getArtworkFile("del1")).toBeInstanceOf(File);
    await deleteArtwork("del1");
    expect(await getArtworkFile("del1")).toBeNull();
  });

  it("getArtworkFile은 File로 복원한다", async () => {
    await saveArtwork("g1", file("art.png"));
    const f = await getArtworkFile("g1");
    expect(f).toBeInstanceOf(File);
    expect(f!.name).toBe("art.png");
  });
});

describe("섹션(폴더) CRUD + 아트웍 배정", () => {
  it("섹션 생성·목록·이름변경", async () => {
    const sec = await createSection("케어센스");
    expect(sec).not.toBeNull();
    let list = await listSections();
    expect(list.some((s) => s.id === sec!.id && s.name === "케어센스")).toBe(true);
    await renameSection(sec!.id, "케어센스 에어");
    list = await listSections();
    expect(list.find((s) => s.id === sec!.id)!.name).toBe("케어센스 에어");
  });

  it("아트웍을 섹션에 배정하고 재저장해도 섹션이 유지된다", async () => {
    const sec = await createSection("바로잰");
    await saveArtwork("sa1", file("art.png"));
    await setArtworkSection("sa1", sec!.id);
    let a = (await listArtworks()).find((x) => x.hash === "sa1")!;
    expect(a.section).toBe(sec!.id);
    // 같은 아트웍 재저장(재업로드) — 섹션 유지
    await saveArtwork("sa1", file("art.png"));
    a = (await listArtworks()).find((x) => x.hash === "sa1")!;
    expect(a.section).toBe(sec!.id);
  });

  it("섹션 삭제 시 소속 아트웍은 미분류로 되돌아간다(아트웍은 보존)", async () => {
    const sec = await createSection("임시섹션");
    await saveArtwork("sb1", file("b.png"));
    await setArtworkSection("sb1", sec!.id);
    await deleteSection(sec!.id);
    expect((await listSections()).some((s) => s.id === sec!.id)).toBe(false);
    const a = (await listArtworks()).find((x) => x.hash === "sb1")!;
    expect(a).toBeTruthy();          // 아트웍 자체는 남음
    expect(a.section).toBeUndefined(); // 미분류로
  });

  it("중첩 섹션 — parentId로 하위 섹션을 만든다", async () => {
    const parent = await createSection("브랜드");
    const child = await createSection("제품", parent!.id);
    const list = await listSections();
    expect(list.find((s) => s.id === child!.id)!.parentId).toBe(parent!.id);
    // 최상위(부모)는 parentId 없음
    expect(list.find((s) => s.id === parent!.id)!.parentId).toBeUndefined();
  });

  it("상위 섹션 삭제 시 하위 섹션은 조부모(없으면 최상위)로 끌어올려진다", async () => {
    const gp = await createSection("조부모");
    const parent = await createSection("부모", gp!.id);
    const child = await createSection("자식", parent!.id);
    await deleteSection(parent!.id);
    const list = await listSections();
    expect(list.some((s) => s.id === parent!.id)).toBe(false); // 부모 삭제됨
    // 자식은 조부모로 재배정
    expect(list.find((s) => s.id === child!.id)!.parentId).toBe(gp!.id);
  });

  it("최상위 섹션 삭제 시 하위 섹션은 최상위로 승격된다", async () => {
    const top = await createSection("최상위");
    const sub = await createSection("하위", top!.id);
    await deleteSection(top!.id);
    const list = await listSections();
    expect(list.find((s) => s.id === sub!.id)!.parentId).toBeUndefined();
  });
});

describe("폴더 이동(moveSection)", () => {
  it("폴더를 다른 폴더 하위로 옮긴다", async () => {
    const a = await createSection("이동A");
    const b = await createSection("이동B");
    expect(await moveSection(b!.id, a!.id)).toBe(true);
    const list = await listSections();
    expect(list.find((s) => s.id === b!.id)!.parentId).toBe(a!.id);
  });

  it("최상위로 되돌린다(parentId 없이 호출)", async () => {
    const p = await createSection("루트복귀부모");
    const c = await createSection("루트복귀자식", p!.id);
    expect(await moveSection(c!.id, undefined)).toBe(true);
    const list = await listSections();
    expect(list.find((s) => s.id === c!.id)!.parentId).toBeUndefined();
  });

  it("자기 자신·자기 하위·없는 폴더로는 못 옮긴다(트리가 끊기지 않게)", async () => {
    const p = await createSection("순환부모");
    const c = await createSection("순환자식", p!.id);
    const g = await createSection("순환손자", c!.id);
    expect(await moveSection(p!.id, p!.id)).toBe(false);      // 자기 자신
    expect(await moveSection(p!.id, c!.id)).toBe(false);      // 직계 하위
    expect(await moveSection(p!.id, g!.id)).toBe(false);      // 더 깊은 하위
    expect(await moveSection(p!.id, "없는폴더")).toBe(false); // 대상 없음
    expect(await moveSection("없는폴더", p!.id)).toBe(false); // 자신이 없음
    expect(await moveSection(c!.id, p!.id)).toBe(false);      // 이미 제자리
    // 원래 구조 유지
    const list = await listSections();
    expect(list.find((s) => s.id === c!.id)!.parentId).toBe(p!.id);
    expect(list.find((s) => s.id === g!.id)!.parentId).toBe(c!.id);
  });
});

describe("서버 동기화용 매니페스트(v2)", () => {
  it("exportManifest는 메타데이터만 담는다(파일 본체 없음)", async () => {
    const sec = await createSection("매니페스트폴더");
    await saveArtwork("mf1", file("라벨.png", "PNGDATA1"));
    await setArtworkSection("mf1", sec!.id);
    const m = await exportManifest();
    expect(m.version).toBe(LIBRARY_MANIFEST_VERSION);
    const e = m.artworks.find((a) => a.hash === "mf1")!;
    expect(e.name).toBe("라벨.png");
    expect(e.section).toBe(sec!.id);
    // 본체(blob/base64)는 매니페스트에 들어가지 않는다 — 이게 v1과의 차이
    expect(Object.keys(e).sort())
      .toEqual(["hash", "name", "section", "size", "type"]);
    expect(m.sections.some((s) => s.id === sec!.id)).toBe(true);
  });

  it("saveArtwork(section)은 신규 저장일 때만 폴더를 지정한다", async () => {
    const sec = await createSection("드롭폴더");
    const other = await createSection("다른폴더");
    await saveArtwork("drop1", file("새파일.png", "X"), sec!.id);
    expect((await listArtworks()).find((a) => a.hash === "drop1")!.section)
      .toBe(sec!.id);
    // 이미 있는 파일은 기존 배정을 지킨다(재업로드로 정리가 흐트러지지 않게)
    await saveArtwork("drop1", file("새파일.png", "X"), other!.id);
    expect((await listArtworks()).find((a) => a.hash === "drop1")!.section)
      .toBe(sec!.id);
  });

  it("listArtworkHashes / getArtworkBlob / saveArtworkBlob 왕복", async () => {
    await saveArtwork("hs1", file("h.png", "H"));
    expect((await listArtworkHashes()).has("hs1")).toBe(true);
    expect(await getArtworkBlob("hs1")).toBeTruthy();
    expect(await getArtworkBlob("없는해시")).toBeNull();
    // 서버에서 받은 파일 넣기
    await saveArtworkBlob({ hash: "hs2", name: "받은.png", size: 3,
                            type: "image/png", section: undefined },
                          new Blob(["ABC"]));
    expect((await listArtworks()).find((a) => a.hash === "hs2")!.name)
      .toBe("받은.png");
  });

  it("putSections는 id·parentId를 그대로 반영한다(폴더 트리 복원)", async () => {
    await putSections([
      { id: "srv-p", name: "서버상위", createdAt: 1 },
      { id: "srv-c", name: "서버하위", createdAt: 2, parentId: "srv-p" },
    ]);
    const list = await listSections();
    expect(list.find((s) => s.id === "srv-c")!.parentId).toBe("srv-p");
  });

  it("mergeManifests는 합집합 — 올리는 쪽이 우선, 남의 항목은 지우지 않는다", () => {
    const mine: LibraryManifest = {
      version: 2, exportedAt: 10,
      sections: [{ id: "s1", name: "내폴더", createdAt: 1 }],
      artworks: [{ hash: "a1", name: "내파일.png", size: 1, type: "image/png" }],
    };
    const theirs: LibraryManifest = {
      version: 2, exportedAt: 5,
      sections: [{ id: "s1", name: "옛이름", createdAt: 1 },
                 { id: "s2", name: "남의폴더", createdAt: 2 }],
      artworks: [{ hash: "a1", name: "옛파일.png", size: 1, type: "image/png" },
                 { hash: "a2", name: "남의파일.png", size: 2, type: "image/png" }],
    };
    const m = mergeManifests(mine, theirs);
    expect(m.sections.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(m.sections.find((s) => s.id === "s1")!.name).toBe("내폴더"); // 내 것이 이김
    expect(m.artworks.map((a) => a.hash).sort()).toEqual(["a1", "a2"]);
    expect(m.artworks.find((a) => a.hash === "a1")!.name).toBe("내파일.png");
    expect(mergeManifests(mine, null)).toBe(mine); // 서버가 비어 있으면 그대로
    // 서버 매니페스트에 필드가 빠져 있어도(옛 형식) 내 것만으로 성립해야 한다
    const partial = mergeManifests(mine, { version: 2, exportedAt: 1 } as
      unknown as LibraryManifest);
    expect(partial.sections.map((s) => s.id)).toEqual(["s1"]);
    expect(partial.artworks.map((a) => a.hash)).toEqual(["a1"]);
  });
});

describe("구버전(v1) 백업 복원", () => {
  // 바이너리 내용 왕복은 실브라우저 테스트가 보증한다(jsdom+fake-indexeddb는
  // Blob을 structuredClone하지 못해 IDB 왕복에서 바이트가 유실됨).
  it("v1 백업 파일을 되살린다 — 아트웍 메타·폴더·소속 보존", async () => {
    const backup = {
      version: 1, exportedAt: Date.now(),
      sections: [{ id: "v1-sec", name: "옛폴더", createdAt: 1 },
                 { id: "v1-sub", name: "옛하위", createdAt: 2, parentId: "v1-sec" }],
      artworks: [
        { hash: "v1a", name: "라벨.png", size: 8, type: "image/png",
          section: "v1-sec", dataB64: btoa("PNGDATA1") },
        { hash: "v1b", name: "표지.png", size: 8, type: "image/png",
          dataB64: btoa("PNGDATA2") },
      ],
    };
    const r = await importLibrary(backup);
    expect(r.artworks).toBe(2);
    expect(r.sections).toBe(2);
    const arts = await listArtworks();
    expect(arts.find((a) => a.hash === "v1a")!.section).toBe("v1-sec");
    expect(arts.some((a) => a.hash === "v1b")).toBe(true);
    // 중첩 구조(parentId)도 그대로
    expect((await listSections()).find((s) => s.id === "v1-sub")!.parentId)
      .toBe("v1-sec");
  });

  it("형식이 잘못된 백업은 에러", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(importLibrary({ bogus: true } as any)).rejects.toThrow();
  });
});

describe("hashFile", () => {
  it("crypto.subtle이 있으면 64자리 SHA-256 hex, 같은 파일은 같은 해시", async () => {
    const h1 = await hashFile(file("a.png", "same"));
    const h2 = await hashFile(file("b.png", "same")); // 이름 무관, 내용 동일
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });
  it("crypto.subtle이 없으면 FNV 폴백(fnv- 접두)", async () => {
    vi.stubGlobal("crypto", {}); // subtle 없음 → http 사내망 폴백 경로
    const h = await hashFile(file("a.png", "data"));
    expect(h.startsWith("fnv-")).toBe(true);
  });
});

// 세션 스토어에 원시 레코드를 직접 넣는 헬퍼(레거시 포맷 재현용).
function rawPutSession(value: unknown): Promise<void> {
  return new Promise((res, rej) => {
    const req = indexedDB.open("artwork-compare-cache", 3);
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction("session", "readwrite");
      t.objectStore("session").put(value, "last");
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
    req.onerror = () => rej(req.error);
  });
}

describe("cache — 경계·방어 분기", () => {
  it("setArtworkSection: 없는 해시는 조용히 무시(rec 없음)", async () => {
    await setArtworkSection("no-such-hash", "sec-x");
    expect((await listArtworks()).some((a) => a.hash === "no-such-hash")).toBe(false);
  });

  it("renameSection: 없는 id는 조용히 무시(rec 없음)", async () => {
    await renameSection("no-such-id", "새이름");
    expect((await listSections()).some((s) => s.id === "no-such-id")).toBe(false);
  });

  it("loadSession: 구버전 레코드(analyzedAt 없음)는 savedAt으로 대체", async () => {
    const savedAt = Date.now();
    await rawPutSession({ sets: [{ name: "레거시" }], savedAt }); // analyzedAt 없음
    const loaded = await loadSession();
    expect(loaded!.sets[0].name).toBe("레거시");
    expect(loaded!.analyzedAt).toBe(savedAt); // analyzedAt ?? savedAt
  });

  it("requestPersistentStorage: Storage API 없으면 false", async () => {
    // jsdom navigator에는 storage가 없다
    expect(await requestPersistentStorage()).toBe(false);
  });
  it("requestPersistentStorage: 이미 persisted면 즉시 true", async () => {
    vi.stubGlobal("navigator", { storage: {
      persist: async () => false, persisted: async () => true } });
    expect(await requestPersistentStorage()).toBe(true);
  });
  it("requestPersistentStorage: 승격 요청 결과를 반환", async () => {
    vi.stubGlobal("navigator", { storage: {
      persist: async () => true, persisted: async () => false } });
    expect(await requestPersistentStorage()).toBe(true);
  });
  it("requestPersistentStorage: 예외는 false로 삼킨다", async () => {
    vi.stubGlobal("navigator", { storage: {
      persist: () => { throw new Error("boom"); }, persisted: async () => false } });
    expect(await requestPersistentStorage()).toBe(false);
  });

  it("storageEstimate: estimate API 없으면 null", async () => {
    expect(await storageEstimate()).toBeNull();
  });
  it("storageEstimate: usage/quota/persisted를 반환", async () => {
    vi.stubGlobal("navigator", { storage: {
      estimate: async () => ({ usage: 100, quota: 1000 }),
      persisted: async () => true } });
    expect(await storageEstimate()).toEqual({ usage: 100, quota: 1000, persisted: true });
  });
  it("storageEstimate: usage/quota 생략·persisted 없으면 0·false 기본", async () => {
    vi.stubGlobal("navigator", { storage: { estimate: async () => ({}) } });
    expect(await storageEstimate()).toEqual({ usage: 0, quota: 0, persisted: false });
  });
  it("storageEstimate: 예외는 null로 삼킨다", async () => {
    vi.stubGlobal("navigator", { storage: {
      estimate: () => { throw new Error("boom"); } } });
    expect(await storageEstimate()).toBeNull();
  });

  it("importLibrary: sections 없는 백업도 안전(?? [] 분기)", async () => {
    const backup = { version: 1, exportedAt: 1, artworks: [
      { hash: "noSecArt", name: "a.png", size: 1, type: "image/png",
        dataB64: btoa("Y") }] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await importLibrary(backup as any);
    expect(r.sections).toBe(0);
    expect((await listArtworks()).some((a) => a.hash === "noSecArt")).toBe(true);
  });
});

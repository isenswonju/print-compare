import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSession, createSection, deleteArtwork, deleteSection, getArtworkFile,
  getRefWords, hashFile, listArtworks, listSections, loadSession, putRefWords,
  renameSection, saveArtwork, saveSession, setArtworkSection, type StoredSet,
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

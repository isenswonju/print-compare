// 실 브라우저(진짜 IndexedDB + 진짜 Blob) 왕복. jsdom+fake-indexeddb는 Blob을
// structuredClone하지 못해 바이트 보존을 여기서 검증한다 — 서버 동기화가
// 파일 본체를 주고받는 경로(getArtworkBlob / saveArtworkBlob)와 v1 백업 복원.
import { describe, expect, it } from "vitest";
import { createSection, deleteArtwork, deleteSection, exportManifest,
         getArtworkBlob, importLibrary, listArtworks, saveArtwork,
         saveArtworkBlob, setArtworkSection } from "./cache.ts";

const file = (n: string, content: string) =>
  new File([content], n, { type: "image/png" });

describe("보관함 — 실 브라우저 바이너리 왕복", () => {
  it("getArtworkBlob은 저장한 바이트를 그대로 돌려준다(업로드 경로)", async () => {
    await saveArtwork("browserBk1", file("라벨.png", "REALPNGBYTES"));
    const blob = await getArtworkBlob("browserBk1");
    expect(blob).toBeTruthy();
    expect(await blob!.text()).toBe("REALPNGBYTES");
    // 매니페스트에는 메타만 들어간다
    const m = await exportManifest();
    expect(m.artworks.find((a) => a.hash === "browserBk1")!.name).toBe("라벨.png");
    await deleteArtwork("browserBk1");
  });

  it("saveArtworkBlob→listArtworks 왕복이 바이너리·소속을 보존한다(내려받기 경로)", async () => {
    const sec = await createSection("브라우저폴더");
    await saveArtworkBlob({ hash: "browserBk2", name: "표지.png", size: 6,
                            type: "image/png", section: sec!.id },
                          new Blob(["ABCDEF"], { type: "image/png" }));
    const restored = (await listArtworks()).find((a) => a.hash === "browserBk2")!;
    expect(restored).toBeTruthy();
    expect(await restored.blob.text()).toBe("ABCDEF"); // 실 IndexedDB Blob 왕복
    expect(restored.section).toBe(sec!.id);

    await deleteArtwork("browserBk2");
    await deleteSection(sec!.id);
  });

  it("v1 백업 복원도 실 바이트를 되살린다(구버전 이행 경로)", async () => {
    const sec = await createSection("v1폴더");
    await saveArtwork("browserV1", file("옛.png", "OLDBYTES"));
    await setArtworkSection("browserV1", sec!.id);
    await deleteArtwork("browserV1");

    await importLibrary({
      version: 1, exportedAt: Date.now(),
      sections: [{ id: sec!.id, name: "v1폴더", createdAt: 1 }],
      artworks: [{ hash: "browserV1", name: "옛.png", size: 8,
                   type: "image/png", section: sec!.id,
                   dataB64: btoa("OLDBYTES") }],
    });
    const restored = (await listArtworks()).find((a) => a.hash === "browserV1")!;
    expect(await restored.blob.text()).toBe("OLDBYTES");
    expect(restored.section).toBe(sec!.id);

    await deleteArtwork("browserV1");
    await deleteSection(sec!.id);
  });
});

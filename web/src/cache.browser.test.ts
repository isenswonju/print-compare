// 실 브라우저(진짜 IndexedDB + 진짜 Blob) 백업/복원 왕복. jsdom+fake-indexeddb는
// Blob 바이너리를 structuredClone하지 못해 여기서 검증한다 — readBytes의 Blob.
// arrayBuffer() 경로(브라우저 정상 경로)와 실제 바이트 보존을 함께 본다.
import { describe, expect, it } from "vitest";
import { createSection, deleteArtwork, deleteSection, exportLibrary,
         importLibrary, listArtworks, saveArtwork,
         setArtworkSection } from "./cache.ts";

const file = (n: string, content: string) =>
  new File([content], n, { type: "image/png" });

describe("보관함 백업/복원 — 실 브라우저 바이너리 왕복", () => {
  it("exportLibrary는 실 Blob을 arrayBuffer로 읽어 base64로 담는다", async () => {
    await saveArtwork("browserBk1", file("라벨.png", "REALPNGBYTES"));
    const backup = await exportLibrary();
    const entry = backup.artworks.find((a) => a.hash === "browserBk1");
    expect(entry).toBeTruthy();
    // readBytes의 arrayBuffer() 경로 → base64 디코드가 원본 바이트와 일치
    expect(atob(entry!.dataB64)).toBe("REALPNGBYTES");
    await deleteArtwork("browserBk1");
  });

  it("내보내기→삭제→가져오기 왕복이 바이너리·소속을 보존한다", async () => {
    const sec = await createSection("브라우저섹션");
    await saveArtwork("browserBk2", file("표지.png", "ABCDEF"));
    await setArtworkSection("browserBk2", sec!.id);
    const backup = await exportLibrary();
    await deleteArtwork("browserBk2");

    await importLibrary(backup);
    const restored = (await listArtworks()).find((a) => a.hash === "browserBk2")!;
    expect(restored).toBeTruthy();
    expect(await restored.blob.text()).toBe("ABCDEF"); // 실 IndexedDB Blob 왕복
    expect(restored.section).toBe(sec!.id);

    await deleteArtwork("browserBk2");
    await deleteSection(sec!.id);
  });
});

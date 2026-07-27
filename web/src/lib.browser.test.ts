import { describe, expect, it } from "vitest";
import { buildFeedbackPayload, restoreResults, serializeResults } from "./lib.ts";
import type { ResultItem } from "./types.ts";

// 결과 영속화(resume한 기능)의 진짜 왕복 — 실 canvas를 Blob으로 직렬화하고
// 다시 canvas로 복원한다. jsdom에선 불가(createImageBitmap/toBlob 없음).
function paintedCanvas(w: number, h: number, fill: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return c;
}

async function canvasToFile(c: HTMLCanvasElement, name: string): Promise<File> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return new File([blob!], name, { type: "image/png" });
}

async function sampleItem(): Promise<ResultItem> {
  const refCanvas = paintedCanvas(100, 80, "#ffffff");
  const alignedCanvas = paintedCanvas(100, 80, "#eeeeee");
  const refFile = await canvasToFile(refCanvas, "ref.png");
  const testFile = await canvasToFile(alignedCanvas, "test.png");
  return {
    name: "세트A", setId: 1, page: 1, pageCount: 1,
    result: {
      findings: [{ id: 1, type: "extra", severity: "major",
                   bbox_ref: [10, 10, 20, 20], area_px: 100, near_text: "", note: "" }],
      timings: [], totalMs: 5,
    },
    fb: { defects: {}, missed: [] },
    refCanvas, alignedCanvas, refFile, testFile,
  };
}

describe("serializeResults ↔ restoreResults (실 브라우저)", () => {
  it("결과를 Blob으로 직렬화하고 canvas로 복원한다", async () => {
    const item = await sampleItem();
    const sets = await serializeResults([item]);
    expect(sets[0].alignedImage).toBeInstanceOf(Blob);
    expect(sets[0].refFile?.name).toBe("ref.png");
    expect(sets[0].result?.findings).toHaveLength(1);

    const restored = await restoreResults(sets);
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe("세트A");
    // 캔버스가 원래 치수로 복원됨
    expect(restored[0].refCanvas!.width).toBe(100);
    expect(restored[0].refCanvas!.height).toBe(80);
    expect(restored[0].alignedCanvas!.width).toBe(100);
    // 표시 결함이 복원 시 재계산됨 (extra major → 가독성 critical)
    expect(restored[0].defects).toHaveLength(1);
    expect(restored[0].defects![0].disp.ktype).toBe("가독성");
    // 오버레이 캔버스도 재생성됨(0.45배)
    expect(restored[0].annotated!.width).toBe(Math.round(100 * 0.45));
    // 원본 파일도 복원
    expect(restored[0].refFile).toBeInstanceOf(File);
    expect(restored[0].testFile!.name).toBe("test.png");
  });

  it("에러 세트는 에러로 직렬화·복원된다", async () => {
    const sets = await serializeResults([
      { name: "실패셋", setId: 2, page: 1, pageCount: 1, error: "정합 실패" }]);
    expect(sets[0]).toMatchObject({ name: "실패셋", error: "정합 실패" });
    const restored = await restoreResults(sets);
    expect(restored[0].error).toBeTruthy();
  });
});

describe("buildFeedbackPayload — 서버 전송 페이로드 (실 브라우저)", () => {
  it("피드백·크롭·원본 이미지를 담아 전송 페이로드를 만든다", async () => {
    const item = await sampleItem();
    item.fb = {
      defects: { 1: { fp: true, cause: "스캔 노이즈", comment: "먼지임",
                      ktype: "가독성", bbox: [10, 10, 20, 20] } },
      missed: [{ x: 40, y: 40, cause: "누락", comment: "여기 못잡음" }],
    };
    const payload = await buildFeedbackPayload([item]);
    expect(payload.app).toBe("artwork-compare-web");
    expect(payload.items).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const it0 = payload.items[0] as any;
    expect(it0.set).toBe("세트A");
    expect(it0.feedback.defects[0].comment).toBe("먼지임");
    expect(it0.feedback.defects[0].refCrop).toMatch(/^data:image\//); // 결함 크롭
    expect(it0.feedback.missed[0].comment).toBe("여기 못잡음");
    expect(it0.refImage).toMatch(/^data:image\//);  // 원본 파일 전체
    expect(it0.testImage).toMatch(/^data:image\//); // 인쇄물 파일 전체
  });

  it("피드백이 없는 세트는 페이로드에서 제외", async () => {
    const item = await sampleItem(); // fb.defects/missed 비어있음
    const payload = await buildFeedbackPayload([item]);
    expect(payload.items).toHaveLength(0);
  });
});

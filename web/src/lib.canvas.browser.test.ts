// canvas/OCR가 필요한 lib.ts 함수의 실 브라우저 검증 — jsdom에는 canvas 2D·
// createImageBitmap·tesseract 런타임이 없어 여기서 다룬다.
import { describe, expect, it, vi } from "vitest";
import {
  buildDisplayArtifacts, buildFeedbackPayload, drawLensInto, fileToImageData,
  imageDataToCanvas, lensDataURL, ocrCanvas, restoreResults, serializeResults,
} from "./lib.ts";
import type { DispFinding, Finding, ResultItem } from "./types.ts";

function paint(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  draw(ctx);
  return c;
}
const toFile = async (c: HTMLCanvasElement, name: string) => {
  const b = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  return new File([b!], name, { type: "image/png" });
};
const finding = (p: Partial<Finding> & { id: number; type: string }): Finding => ({
  severity: "major", bbox_ref: [10, 10, 20, 20], area_px: 100,
  near_text: "", note: "", ...p,
});

describe("이미지 유틸(실 브라우저)", () => {
  it("fileToImageData → imageDataToCanvas 왕복이 치수를 보존한다", async () => {
    const file = await toFile(paint(64, 48, () => {}), "x.png");
    const imgData = await fileToImageData(file);
    expect(imgData.width).toBe(64);
    expect(imgData.height).toBe(48);
    const canvas = imageDataToCanvas(imgData);
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(48);
  });
});

describe("buildDisplayArtifacts(실 브라우저) — 빨강/회색 박스", () => {
  it("결함은 빨강, 비결함(showthrough)은 회색으로 그린다", () => {
    const aligned = paint(200, 160, () => {});
    const ref = paint(200, 160, () => {});
    const findings: Finding[] = [
      finding({ id: 1, type: "missing", severity: "critical" }), // 결함 → 빨강+번호
      finding({ id: 2, type: "showthrough", bbox_ref: [80, 80, 10, 10] }), // 비결함 → 회색
    ];
    const art = buildDisplayArtifacts(findings, ref, aligned);
    expect(art.defects.map((d) => d.id)).toEqual([1]);  // showthrough는 제외
    expect(art.annotated.width).toBe(Math.round(200 * 0.45)); // 오버레이 생성됨
  });
});

describe("drawLensInto / lensDataURL(실 브라우저)", () => {
  it("box·mark를 함께 그려도 예외 없이 확대경을 채운다", () => {
    const src = paint(600, 400, (ctx) => { ctx.fillStyle = "#000"; ctx.fillRect(50, 50, 40, 40); });
    const lens = document.createElement("canvas");
    lens.width = 460; lens.height = 240;
    expect(() => drawLensInto(src, lens, 70, 70,
      [55, 55, 30, 30], { x: 70, y: 70 })).not.toThrow();
  });
  it("lensDataURL은 JPEG data URL을 만든다", () => {
    const src = paint(600, 400, () => {});
    expect(lensDataURL(src, 100, 100)).toMatch(/^data:image\/jpeg/);
  });
});

describe("serialize/restore·payload — 파일 없는 경로(실 브라우저)", () => {
  it("원본 파일이 없는 결과도 직렬화되고, 복원 시엔 에러 항목이 된다", async () => {
    const aligned = paint(80, 60, () => {});
    const item: ResultItem = {
      name: "파일없음", setId: 1, page: 1, pageCount: 1,
      result: { findings: [], timings: [], totalMs: 3 },
      alignedCanvas: aligned, refCanvas: aligned, // refFile/testFile 없음
    };
    const sets = await serializeResults([item]);
    expect(sets[0].refFile).toBeUndefined();   // packFile(undefined)
    expect(sets[0].alignedImage).toBeInstanceOf(Blob);
    // refFile이 없어 복원은 불가 → 에러 항목
    const restored = await restoreResults(sets);
    expect(restored[0].error).toBeTruthy();
  });

  it("복원 중 이미지 디코딩 실패는 에러 항목으로 처리(catch)", async () => {
    const restored = await restoreResults([{
      name: "깨진", setId: 1, page: 1, pageCount: 1,
      result: { findings: [], timings: [], totalMs: 1 },
      alignedImage: new Blob(["not-an-image"], { type: "image/png" }),
      refFile: { blob: new Blob(["nope"], { type: "image/png" }),
                 name: "r.png", type: "image/png" },
    }]);
    expect(restored[0].error).toBe("결과 복원에 실패했습니다.");
  });

  it("buildFeedbackPayload: 원본 파일이 없으면 refImage/testImage는 null", async () => {
    const canvas = paint(60, 40, () => {});
    const item: ResultItem = {
      name: "크롭만", setId: 1, page: 1, pageCount: 1,
      result: { findings: [], timings: [], totalMs: 2 },
      refCanvas: canvas, alignedCanvas: canvas, // refFile/testFile 없음
      defects: [],
      fb: { defects: {}, missed: [{ x: 10, y: 10, comment: "여기" }] },
    };
    const payload = await buildFeedbackPayload([item]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const it0 = payload.items[0] as any;
    expect(it0.refImage).toBeNull();
    expect(it0.testImage).toBeNull();
    expect(it0.feedback.missed[0].refCrop).toMatch(/^data:image\//);
  });
});

describe("ocrCanvas(실 브라우저, 실 tesseract)", () => {
  it("텍스트 캔버스를 인식해 단어 목록을 반환한다", async () => {
    const canvas = paint(360, 120, (ctx) => {
      ctx.fillStyle = "#000";
      ctx.font = "48px sans-serif";
      ctx.fillText("STORAGE", 20, 80);
    });
    const logs: string[] = [];
    const words = await ocrCanvas(canvas, (m) => logs.push(m));
    expect(Array.isArray(words)).toBe(true); // 인식 결과는 환경 변동 → 형태만 검증
    expect(logs.some((l) => l.startsWith("[OCR]"))).toBe(true);
  }, 60000); // OCR은 수 초 소요
});

describe("잔여 분기(실 브라우저)", () => {
  it("buildFeedbackPayload: it.defects에서 결함 메타를 찾아 붙인다(find 콜백)", async () => {
    const canvas = paint(80, 60, () => {});
    const disp: DispFinding = {
      ...finding({ id: 7, type: "extra", severity: "major" }),
      disp: { ktype: "가독성", severity: "critical", note: "n" },
    };
    const item: ResultItem = {
      name: "메타", setId: 1, page: 1, pageCount: 1,
      result: { findings: [disp], timings: [], totalMs: 1 },
      refCanvas: canvas, alignedCanvas: canvas,
      defects: [disp], // it.defects 존재 → find 콜백 실행
      fb: { defects: { 7: { fp: false, cause: "", comment: "의견", ktype: "가독성",
                            bbox: [10, 10, 20, 20] } }, missed: [] },
    };
    const payload = await buildFeedbackPayload([item]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d0 = (payload.items[0] as any).feedback.defects[0];
    expect(d0.type).toBe("extra");        // find로 찾은 원본 finding.type
    expect(d0.id).toBe(7);
  });

  it("restoreResults: testFile이 없어도 복원 성공(unpackFile undefined 분기)", async () => {
    const c = paint(60, 40, () => {});
    const refFile = await toFile(c, "ref.png");
    const item: ResultItem = {
      name: "인쇄물없음", setId: 1, page: 1, pageCount: 1,
      result: { findings: [], timings: [], totalMs: 1 },
      refCanvas: c, alignedCanvas: c, refFile, // testFile 없음
    };
    const sets = await serializeResults([item]);
    expect(sets[0].testFile).toBeUndefined(); // packFile(undefined)
    const restored = await restoreResults(sets);
    expect(restored[0].error).toBeFalsy();       // 복원 성공
    expect(restored[0].refFile).toBeInstanceOf(File);
    expect(restored[0].testFile).toBeUndefined(); // unpackFile(undefined)
  });

  it("serializeResults: canvasToBlob가 null이면 alignedImage는 undefined", async () => {
    const c = paint(40, 30, () => {});
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation(function (cb: BlobCallback) { cb(null); });
    const item: ResultItem = {
      name: "blob실패", setId: 1, page: 1, pageCount: 1,
      result: { findings: [], timings: [], totalMs: 1 },
      refCanvas: c, alignedCanvas: c,
    };
    const sets = await serializeResults([item]);
    expect(sets[0].alignedImage).toBeUndefined(); // null ?? undefined
    spy.mockRestore();
  });
});

import { describe, expect, it } from "vitest";
import { ensureRaster, ensureRasterPages, pdfPageCount, rasterizePdf,
         rasterizePdfPages } from "./pdf.ts";
import { SAMPLE_PDF_2PAGE_BASE64, SAMPLE_PDF_BASE64 } from "./__fixtures__.ts";

// 실제 Chrome에서 pdf.js 워커 + canvas로 PDF를 진짜 렌더해 검증한다.
function pdfFrom(b64: string, name: string): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "application/pdf" });
}
const samplePdf = () => pdfFrom(SAMPLE_PDF_BASE64, "sample.pdf");
const twoPagePdf = () => pdfFrom(SAMPLE_PDF_2PAGE_BASE64, "doc.pdf");

async function pixels(png: File) {
  const bmp = await createImageBitmap(png);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height,
           at: (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data };
}

describe("rasterizePdf (실 브라우저)", () => {
  it("PDF 첫 페이지를 PNG File로 변환한다", async () => {
    const png = await rasterizePdf(samplePdf());
    expect(png).toBeInstanceOf(File);
    expect(png.type).toBe("image/png");
    expect(png.name).toBe("sample.png");
  });

  it("600dpi로 렌더한다 (120x160pt → ~1000x1333px)", async () => {
    const png = await rasterizePdf(samplePdf());
    const { w, h } = await pixels(png);
    expect(w).toBeGreaterThanOrEqual(980);
    expect(w).toBeLessThanOrEqual(1020);
    expect(h).toBeGreaterThanOrEqual(1310);
    expect(h).toBeLessThanOrEqual(1360);
  });

  it("흰 배경 + 검은 도형이 올바른 위치에 렌더된다", async () => {
    const png = await rasterizePdf(samplePdf());
    const { w, h, at } = await pixels(png);
    const corner = at(5, 5);
    expect(corner[0]).toBeGreaterThan(240); // 배경 흰색
    expect(corner[3]).toBe(255);            // 불투명(투명→흰 합성)
    // 사각형 중심 (60,80)/(120,160) → 스케일 후
    const cx = Math.round((60 / 120) * w), cy = Math.round((80 / 160) * h);
    const center = at(cx, cy);
    expect(center[0]).toBeLessThan(40);     // 검은 도형
  });

  it("낮은 dpi 인자를 존중한다", async () => {
    const png = await rasterizePdf(samplePdf(), 150);
    const { w } = await pixels(png);
    // 120pt * 150/72 = 250px
    expect(w).toBeGreaterThanOrEqual(240);
    expect(w).toBeLessThanOrEqual(260);
  });

  it("ensureRaster는 PDF는 변환, 이미지 File은 그대로 통과", async () => {
    const pdf = samplePdf();
    const rastered = await ensureRaster(pdf);
    expect(rastered.type).toBe("image/png");

    const img = new File(["x"], "a.png", { type: "image/png" });
    expect(await ensureRaster(img)).toBe(img); // 동일 참조
  });
});

describe("다중 페이지 PDF (실 브라우저)", () => {
  it("pdfPageCount는 페이지 수를 센다", async () => {
    expect(await pdfPageCount(samplePdf())).toBe(1);
    expect(await pdfPageCount(twoPagePdf())).toBe(2);
  });

  it("rasterizePdfPages는 페이지마다 PNG File을 만든다(이름에 -p1/-p2)", async () => {
    const pages = await rasterizePdfPages(twoPagePdf());
    expect(pages).toHaveLength(2);
    expect(pages[0].name).toBe("doc-p1.png");
    expect(pages[1].name).toBe("doc-p2.png");
    expect(pages.every((p) => p.type === "image/png")).toBe(true);
    // 페이지 내용이 다르다(p1 좌상단, p2 우하단 사각형)
    const at = async (f: File, x: number, y: number) => {
      const bmp = await createImageBitmap(f);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const fx = Math.round((x / 120) * bmp.width);
      const fy = Math.round((y / 160) * bmp.height);
      return ctx.getImageData(fx, fy, 1, 1).data[0];
    };
    expect(await at(pages[0], 30, 30)).toBeLessThan(40);   // p1 좌상단 검정
    expect(await at(pages[1], 90, 130)).toBeLessThan(40);  // p2 우하단 검정
  });

  it("1페이지 PDF는 -p 접미사 없이 base.png", async () => {
    const pages = await rasterizePdfPages(samplePdf());
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe("sample.png");
  });

  it("ensureRasterPages: PDF는 페이지 배열, 이미지는 자기 자신 1장", async () => {
    expect(await ensureRasterPages(twoPagePdf())).toHaveLength(2);
    const img = new File(["x"], "a.png", { type: "image/png" });
    const pages = await ensureRasterPages(img);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toBe(img);
  });
});

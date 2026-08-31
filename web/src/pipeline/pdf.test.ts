import { describe, expect, it } from "vitest";
import { DEFAULT_DPI, classifyLayerName, isPdf } from "./pdf.ts";

const f = (name: string, type = "") => new File(["x"], name, { type });

describe("isPdf", () => {
  it("application/pdf MIME이면 PDF", () => {
    expect(isPdf(f("a", "application/pdf"))).toBe(true);
  });
  it(".pdf 확장자(대소문자 무관)면 PDF", () => {
    expect(isPdf(f("a.pdf"))).toBe(true);
    expect(isPdf(f("A.PDF"))).toBe(true);
  });
  it("이미지 파일은 PDF 아님", () => {
    expect(isPdf(f("a.png", "image/png"))).toBe(false);
    expect(isPdf(f("scan.jpg", "image/jpeg"))).toBe(false);
  });
});

describe("기본 해상도", () => {
  it("브라우저·Python 계약과 동일하게 600dpi", () => {
    expect(DEFAULT_DPI).toBe(600);
  });
});

// 원판 아트웍의 레이어 이름으로 "설명 요소"를 짐작한다. 아래 이름들은 실물
// 아트웍(i-SENS 라벨 원판)에서 pdf.js가 실제로 읽어낸 값이다.
describe("classifyLayerName — 설명 요소 레이어 판정", () => {
  it("실측된 주석 레이어 이름을 잡아낸다", () => {
    for (const n of ["Dieline", "No varnish area", "Printing/Labeling area",
                     "die line", "CUT LINE", "재단선", "규격 가이드"])
      expect(classifyLayerName(n)).toBe(true);
  });
  it("본 도안 레이어는 건드리지 않는다", () => {
    for (const n of ["General", "Layer 1", "아트웍", "Artwork", "Text"])
      expect(classifyLayerName(n)).toBe(false);
  });
});

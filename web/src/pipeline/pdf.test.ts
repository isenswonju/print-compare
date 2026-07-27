import { describe, expect, it } from "vitest";
import { DEFAULT_DPI, isPdf } from "./pdf.ts";

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

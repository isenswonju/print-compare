import { describe, expect, it } from "vitest";
import { branding } from "./branding.ts";

// 브랜딩 설정 레이어 계약 — upstream(중립)·downstream(i-SENS)이 이 파일 하나만
// 다르게 갖는다. 헤더 워드마크·서비스명이 여기서 온다.
describe("branding 설정", () => {
  it("서비스 이름이 있다", () => {
    expect(typeof branding.name).toBe("string");
    expect(branding.name.length).toBeGreaterThan(0);
  });

  it("헤더 워드마크는 text+color 조각들로 구성된다", () => {
    expect(Array.isArray(branding.wordmark)).toBe(true);
    expect(branding.wordmark.length).toBeGreaterThan(0);
    for (const part of branding.wordmark) {
      expect(part.text.length).toBeGreaterThan(0);
      expect(part.color).toMatch(/^#[0-9a-fA-F]{3,8}$/);
    }
  });
});

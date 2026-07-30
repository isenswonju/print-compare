import { describe, expect, it } from "vitest";
import { REF_BASE_WIDTH, defaultConfig } from "./config.ts";

// config.ts는 compare_artwork.py Config 포트 — 값이 Python 원본과 동일해야 한다.
// 상수 드리프트를 잡는 가드(값을 바꾸면 Node 하니스와 함께 이 테스트도 갱신).
describe("pipeline config 상수", () => {
  it("REF_BASE_WIDTH는 Python과 동일", () => {
    expect(REF_BASE_WIDTH).toBe(5564);
  });

  it("핵심 파라미터가 Python 원본과 일치", () => {
    expect(defaultConfig.tol).toBe(5);
    expect(defaultConfig.tolFallback).toBe(13);
    expect(defaultConfig.minArea).toBe(40);   // 60→40 (미검출 가혹 테스트 근거)
    expect(defaultConfig.orbFeatures).toBe(20000);
    expect(defaultConfig.loweRatio).toBeCloseTo(0.75);
    expect(defaultConfig.scaleRange).toEqual([0.9, 1.1]);
    expect(defaultConfig.ocrMinConf).toBe(40);
  });

  it("불리언 기본값(OCR·타일 정합 사용)", () => {
    expect(defaultConfig.useOcr).toBe(true);
    expect(defaultConfig.useTileRefine).toBe(true);
  });

  it("이진화·군집·뒷비침 그룹의 대표값", () => {
    expect(defaultConfig.threshBlock).toBe(41);
    expect(defaultConfig.mergeKernel).toBe(31);
    expect(defaultConfig.ghostMinArea).toBe(800);
  });

  it("인쇄 농도 검사(3.4b) 파라미터가 Python과 일치", () => {
    expect(defaultConfig.coverMinArea).toBe(120);
    expect(defaultConfig.coverMerge).toBe(3);
    expect(defaultConfig.coverPad).toBe(3);
    expect(defaultConfig.fadeRel).toBeCloseTo(0.70);
    expect(defaultConfig.fadeAbs).toBeCloseTo(0.80);
  });
});

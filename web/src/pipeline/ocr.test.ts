import { describe, expect, it } from "vitest";
import { wordsFromTesseract } from "./ocr.ts";

const bbox = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

describe("wordsFromTesseract", () => {
  it("blocks 구조에서 단어를 [x,y,w,h] bbox·line 번호로 변환", () => {
    const data = {
      blocks: [{
        paragraphs: [{
          lines: [{
            words: [
              { text: "STORAGE", confidence: 95, bbox: bbox(10, 20, 60, 40) },
              { text: "expiration", confidence: 88, bbox: bbox(70, 20, 170, 40) },
            ],
          }],
        }],
      }],
    };
    const words = wordsFromTesseract(data, 40);
    expect(words).toHaveLength(2);
    expect(words[0]).toEqual({
      text: "STORAGE", conf: 95, bbox: [10, 20, 50, 20], line: [1, 1, 1],
    });
    expect(words[1].bbox).toEqual([70, 20, 100, 20]);
  });

  it("minConf 미만·빈 텍스트는 제외", () => {
    const data = {
      blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: "ok", confidence: 90, bbox: bbox(0, 0, 10, 10) },
        { text: "lowconf", confidence: 20, bbox: bbox(0, 0, 10, 10) },
        { text: "   ", confidence: 99, bbox: bbox(0, 0, 10, 10) },
      ] }] }] }],
    };
    expect(wordsFromTesseract(data, 40).map((w) => w.text)).toEqual(["ok"]);
  });

  it("구버전 flat words 폴백 — line 객체 identity로 라인 번호", () => {
    const lineA = {}, lineB = {};
    const data = {
      words: [
        { text: "a", confidence: 90, bbox: bbox(0, 0, 5, 5), line: lineA },
        { text: "b", confidence: 90, bbox: bbox(6, 0, 11, 5), line: lineA },
        { text: "c", confidence: 90, bbox: bbox(0, 6, 5, 11), line: lineB },
      ],
    };
    const words = wordsFromTesseract(data, 40);
    expect(words.map((w) => w.line[2])).toEqual([1, 1, 2]);
  });

  it("text 누락(undefined)·confidence 누락은 제외(빈문자·conf<minConf)", () => {
    const data = {
      blocks: [{ paragraphs: [{ lines: [{ words: [
        { bbox: bbox(0, 0, 10, 10) },                     // text undefined → "" → 제외
        { text: "noconf", bbox: bbox(0, 0, 10, 10) },     // confidence undefined → -1 → 제외
        { text: "keep", confidence: 80, bbox: bbox(0, 0, 10, 10) },
      ] }] }] }],
    };
    expect(wordsFromTesseract(data, 40).map((w) => w.text)).toEqual(["keep"]);
  });

  it("빈 blocks/paragraphs/lines 구조도 안전(|| [] 분기)", () => {
    const data = {
      blocks: [
        {},                                    // paragraphs 없음
        { paragraphs: [{}] },                  // lines 없음
        { paragraphs: [{ lines: [{}] }] },     // words 없음
      ],
    };
    expect(wordsFromTesseract(data, 40)).toEqual([]);
  });

  it("blocks·words 둘 다 없으면 빈 배열", () => {
    expect(wordsFromTesseract({}, 40)).toEqual([]);
  });

  it("빈 blocks 배열이면 flat words 폴백 경로로", () => {
    const data = { blocks: [], words: [
      { text: "flat", confidence: 90, bbox: bbox(0, 0, 5, 5), line: {} },
    ] };
    expect(wordsFromTesseract(data, 40).map((w) => w.text)).toEqual(["flat"]);
  });
});

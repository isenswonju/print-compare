import { describe, expect, it } from "vitest";
import { normWord, textMismatches, trivialDiff } from "./textcheck.ts";
import type { Word } from "../types.ts";

const w = (text: string, bbox: [number, number, number, number]): Word =>
  ({ text, conf: 90, bbox, line: [0, 0, 0] });

describe("normWord", () => {
  it("스마트 따옴표·대시를 표준 문자로 정규화", () => {
    expect(normWord("‘a’")).toBe("'a'");
    expect(normWord("“b”")).toBe('"b"');
    expect(normWord("c–d")).toBe("c-d");
    expect(normWord("e—f")).toBe("e-f");
    expect(normWord("  g ")).toBe("g");
  });
});

describe("trivialDiff", () => {
  it("양쪽 모두 비영숫자면 trivial", () => {
    expect(trivialDiff("replace", ["!"], ["?"])).toBe(true);
  });
  it("동일 문자열이면 trivial", () => {
    expect(trivialDiff("replace", ["abc"], ["abc"])).toBe(true);
  });
  it("혼동 문자 치환(O↔0)은 trivial", () => {
    expect(trivialDiff("replace", ["2025-O4"], ["2025-04"])).toBe(true);
  });
  it("짧은(4자 미만) 삽입/삭제는 trivial", () => {
    expect(trivialDiff("insert", [], ["ab"])).toBe(true);
    expect(trivialDiff("delete", ["xy"], [])).toBe(true);
  });
  it("실제 단어 교체는 trivial 아님", () => {
    expect(trivialDiff("replace", ["hello"], ["world"])).toBe(false);
  });
  it("긴 삽입은 trivial 아님", () => {
    expect(trivialDiff("insert", [], ["humidity"])).toBe(false);
  });
});

describe("textMismatches", () => {
  it("혼동 문자만 다른 경우는 보고하지 않는다", () => {
    const ref = [w("STORAGE", [0, 0, 10, 10]), w("expiration", [20, 0, 30, 10])];
    const test = [w("STORAGE", [0, 0, 10, 10]), w("explratlon", [20, 0, 30, 10])];
    expect(textMismatches(ref, test)).toEqual([]);
  });

  it("진짜 불일치는 TEST 단어 bbox로 보고", () => {
    const ref = [w("STORAGE", [0, 0, 10, 10]), w("expiration", [20, 0, 30, 10])];
    const test = [w("STORAGE", [0, 0, 10, 10]), w("expiratXon", [100, 200, 50, 20])];
    const out = textMismatches(ref, test);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("replace");
    expect(out[0].refText).toBe("expiration");
    expect(out[0].testText).toBe("expiratXon");
    expect(out[0].bbox).toEqual([100, 200, 50, 20]);
  });

  it("삭제된 단어는 REF bbox로 보고(TEST 박스 없음)", () => {
    const ref = [w("keep", [0, 0, 10, 10]), w("REMOVEDWORD", [40, 0, 60, 10])];
    const test = [w("keep", [0, 0, 10, 10])];
    const out = textMismatches(ref, test);
    expect(out).toHaveLength(1);
    expect(out[0].tag).toBe("delete");
    expect(out[0].bbox).toEqual([40, 0, 60, 10]);
  });
});

describe("trivialDiff — 대소문자 접기", () => {
  it("대소문자만 다르면 OCR 노이즈로 무시한다", () => {
    expect(trivialDiff("replace", ["for"], ["For"])).toBe(true);
    expect(trivialDiff("replace", ["AST"], ["ast"])).toBe(true);
    // 혼동문자와 함께 걸려도 무시('1-SENS' vs 'i-sens')
    expect(trivialDiff("replace", ["1-SENS"], ["i-sens"])).toBe(true);
  });
  it("구두점 차이는 계속 보고한다(빠진 마침표는 실제 결함일 수 있음)", () => {
    expect(trivialDiff("replace", ["blood"], ["blood:"])).toBe(false);
    expect(trivialDiff("replace", ["mg/dL"], ["mg/dL."])).toBe(false);
  });
  it("내용이 실제로 다르면 대소문자 접기로도 통과하지 않는다", () => {
    expect(trivialDiff("replace", ["Results"], ["Resultss"])).toBe(false);
  });
});

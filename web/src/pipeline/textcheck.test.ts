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
  it("단어 조각 오독(부분 문자열 1~2자)은 trivial", () => {
    // 실측: 뒷비침이 겹친 줄에서 tesseract.js가 "Owner's"를 "s"로만 읽었다
    expect(trivialDiff("replace", ["Owner's"], ["s"])).toBe(true);
    expect(trivialDiff("replace", ["le"], ["Sample"])).toBe(true);
  });
  it("조각이라도 상대 단어에 없는 글자면 trivial 아님", () => {
    expect(trivialDiff("replace", ["Owner's"], ["x"])).toBe(false);
  });
  it("3자 이상 조각은 trivial 아님(단어가 지워졌을 수 있다)", () => {
    expect(trivialDiff("replace", ["Sample"], ["Sam"])).toBe(false);
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
    // 3자 이상 차이는 통과하지 않는다(1~2자 접미 차이는 아래 계약 참조)
    expect(trivialDiff("replace", ["Results"], ["Resultsabc"])).toBe(false);
  });
});

describe("trivialDiff — 2026-08-03 실측 판정 기반 규칙 (back-pair)", () => {
  it("영숫자 1~2자 접미/포함 차이는 줄 경계 오독으로 무시한다", () => {
    // 실측 오탐: 'Strips'→'Strip', 'respective'→'respectiv:'
    expect(trivialDiff("replace", ["Strips"], ["Strip"])).toBe(true);
    expect(trivialDiff("replace", ["respective"], ["respectiv:"])).toBe(true);
    // 글자가 정말 추가/삭제됐다면 잉크 diff 경로가 글리프 면적으로 잡는다
    expect(trivialDiff("replace", ["Results"], ["Resultss"])).toBe(true);
  });
  it("rn→m 접합 오독은 무시한다", () => {
    expect(trivialDiff("replace", ["return"], ["retum"])).toBe(true);
  });
  it("여러 단어(3+)가 반토막 이하로 붕괴하면 판독 실패로 무시한다", () => {
    expect(trivialDiff("replace",
      ["Keep", "test", "strips", "away", "from", "children"],
      ["Mab", "Tet"])).toBe(true);
    // 2단어 이하이거나 절반 이상 읽혔으면 계속 보고
    expect(trivialDiff("replace", ["not", "have"], ["riot"])).toBe(false);
  });
});

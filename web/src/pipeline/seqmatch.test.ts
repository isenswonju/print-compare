import { describe, expect, it } from "vitest";
import { SequenceMatcher } from "./seqmatch.ts";

// Python difflib.SequenceMatcher(autojunk=False).get_opcodes() 동치 검증.
describe("SequenceMatcher.getOpcodes", () => {
  it("동일 시퀀스는 하나의 equal", () => {
    const sm = new SequenceMatcher(["a", "b", "c"], ["a", "b", "c"]);
    expect(sm.getOpcodes()).toEqual([["equal", 0, 3, 0, 3]]);
  });

  it("가운데 단어 교체 → replace", () => {
    const sm = new SequenceMatcher(["the", "cat", "sat"], ["the", "dog", "sat"]);
    expect(sm.getOpcodes()).toEqual([
      ["equal", 0, 1, 0, 1],
      ["replace", 1, 2, 1, 2],
      ["equal", 2, 3, 2, 3],
    ]);
  });

  it("단어 삽입 → insert", () => {
    const sm = new SequenceMatcher(["x", "y"], ["x", "z", "y"]);
    expect(sm.getOpcodes()).toEqual([
      ["equal", 0, 1, 0, 1],
      ["insert", 1, 1, 1, 2],
      ["equal", 1, 2, 2, 3],
    ]);
  });

  it("단어 삭제 → delete", () => {
    const sm = new SequenceMatcher(["x", "z", "y"], ["x", "y"]);
    expect(sm.getOpcodes()).toEqual([
      ["equal", 0, 1, 0, 1],
      ["delete", 1, 2, 1, 1],
      ["equal", 2, 3, 1, 2],
    ]);
  });

  it("완전 불일치 → 단일 replace", () => {
    const sm = new SequenceMatcher(["a", "b"], ["c", "d"]);
    expect(sm.getOpcodes()).toEqual([["replace", 0, 2, 0, 2]]);
  });

  it("findLongestMatch는 가장 긴 연속 일치를 찾는다", () => {
    const sm = new SequenceMatcher(
      ["q", "a", "b", "x", "c", "d"],
      ["a", "b", "y", "c", "d", "z"]);
    // 'a b'(길이2)와 'c d'(길이2) 중 앞쪽 'a b'가 먼저(besti 작음)
    expect(sm.findLongestMatch(0, 6, 0, 6)).toEqual([1, 0, 2]);
  });

  it("getMatchingBlocks는 마지막에 (la,lb,0) 센티넬을 붙인다", () => {
    const sm = new SequenceMatcher(["a"], ["a"]);
    const blocks = sm.getMatchingBlocks();
    expect(blocks[blocks.length - 1]).toEqual([1, 1, 0]);
  });
});

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

  it("b의 중복 원소는 같은 키에 인덱스를 누적한다(b2j)", () => {
    // b에 'a'가 두 번 → b2j['a']=[0,3]; 둘 다 매칭 후보로 쓰인다.
    const sm = new SequenceMatcher(["a"], ["a", "x", "y", "a"]);
    // 창을 좁혀 두 인덱스가 각각 blo 미만/ bhi 이상이 되게 함(아래 테스트에서 검증)
    expect(sm.getMatchingBlocks()[0]).toEqual([0, 0, 1]); // 첫 'a'에 매칭
  });

  it("findLongestMatch: 창 밖 인덱스는 건너뛰고(continue) 상한 이상은 중단(break)", () => {
    // b2j['a']=[0,5]. 창 [blo=2,bhi=4) → j=0은 continue, j=5는 break.
    const sm = new SequenceMatcher(["a"], ["a", "q", "q", "q", "q", "a"]);
    expect(sm.findLongestMatch(0, 1, 2, 4)).toEqual([0, 2, 0]); // 창 안 매칭 없음
  });

  it("중복 토큰이 창을 넘나드는 재귀에서도 opcode 재구성이 정확", () => {
    // 여러 'a'가 서로 다른 창에 걸치며 재귀 분할을 유발한다.
    const a = ["a", "1", "a", "2"], b = ["a", "3", "a", "4"];
    const sm = new SequenceMatcher(a, b);
    // 오라클: opcode를 적용하면 a가 b로 변환되어야 한다.
    const rebuilt: string[] = [];
    for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
      if (tag === "equal" || tag === "replace" || tag === "insert")
        rebuilt.push(...b.slice(j1, j2));
      else if (tag === "delete") { /* a[i1..i2) 제거 */ void i1; void i2; }
    }
    expect(rebuilt).toEqual(b);
  });

  it("getMatchingBlocks 결과는 메모이즈된다(두 번째 호출은 같은 참조)", () => {
    const sm = new SequenceMatcher(["a", "b"], ["a", "c"]);
    const first = sm.getMatchingBlocks();
    expect(sm.getMatchingBlocks()).toBe(first); // 캐시 반환(this.matchingBlocks)
  });

  it("첫 일치가 원점(0,0)이 아니면 초기 빈 누적은 push하지 않는다", () => {
    // 접두가 불일치 → 첫 매칭 블록이 (1,1,2). 병합 루프 첫 반복에서 k1=0이라
    // else의 if(k1) 거짓 분기(push 생략)를 탄다.
    const sm = new SequenceMatcher(["z", "a", "b"], ["w", "a", "b"]);
    expect(sm.getMatchingBlocks()).toEqual([[1, 1, 2], [3, 3, 0]]);
    expect(sm.getOpcodes()).toEqual([
      ["replace", 0, 1, 0, 1],
      ["equal", 1, 3, 1, 3],
    ]);
  });
});

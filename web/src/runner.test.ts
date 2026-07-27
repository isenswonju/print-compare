import { describe, expect, it } from "vitest";
import { computeConcurrency, expandSets, type RunSet } from "./runner.ts";

const f = (n: string) => new File(["x"], n, { type: "image/png" });

// 병렬 폭은 메모리·코어가 모두 넉넉할 때만 2, 그 외 1(직렬).
describe("computeConcurrency", () => {
  it("메모리·코어 모두 충분하면 2세트 병렬", () => {
    expect(computeConcurrency(8, 8)).toBe(2);
    expect(computeConcurrency(16, 16)).toBe(2);
  });
  it("메모리 부족이면 직렬", () => {
    expect(computeConcurrency(4, 8)).toBe(1);
  });
  it("코어 부족이면 직렬", () => {
    expect(computeConcurrency(8, 4)).toBe(1);
  });
  it("경계값(8/8 미만)은 직렬", () => {
    expect(computeConcurrency(6, 16)).toBe(1);
    expect(computeConcurrency(16, 6)).toBe(1);
  });
});

describe("expandSets — 세트를 페이지쌍으로 펼침", () => {
  it("단일 페이지 세트는 1개 작업", () => {
    const sets: RunSet[] = [
      { setId: 1, name: "A", refPages: [f("a.png")], testPages: [f("a2.png")] }];
    const jobs = expandSets(sets);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ setId: 1, name: "A", page: 1, pageCount: 1 });
  });

  it("2페이지 세트는 페이지 번호를 매겨 2개 작업", () => {
    const sets: RunSet[] = [{
      setId: 7, name: "품목", refPages: [f("r1.png"), f("r2.png")],
      testPages: [f("t1.png"), f("t2.png")],
    }];
    const jobs = expandSets(sets);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.page)).toEqual([1, 2]);
    expect(jobs.every((j) => j.pageCount === 2 && j.setId === 7)).toBe(true);
    // 페이지 i는 원본/인쇄물의 i번째 파일과 짝
    expect(jobs[0].ref.name).toBe("r1.png");
    expect(jobs[1].test.name).toBe("t2.png");
  });

  it("여러 세트를 순서대로 이어붙인다", () => {
    const sets: RunSet[] = [
      { setId: 1, name: "A", refPages: [f("a.png")], testPages: [f("a.png")] },
      { setId: 2, name: "B", refPages: [f("b1.png"), f("b2.png")],
        testPages: [f("b1.png"), f("b2.png")] },
    ];
    const jobs = expandSets(sets);
    expect(jobs.map((j) => `${j.setId}:${j.page}`)).toEqual(["1:1", "2:1", "2:2"]);
  });

  it("페이지 수가 다르면 적은 쪽만큼만(방어적)", () => {
    const sets: RunSet[] = [{
      setId: 1, name: "A", refPages: [f("a.png")],
      testPages: [f("t1.png"), f("t2.png")],
    }];
    expect(expandSets(sets)).toHaveLength(1);
  });
});

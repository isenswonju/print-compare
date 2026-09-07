// 리플로우 템플릿 매칭의 메모리 가드 계약.
//
// 2026-09-07 사고: 사용자 PC에서 5세트 전건이 "[단계: 리플로우 검사] Failed to
// allocate 429922944 bytes" 로 실패했다. 정합이 어긋나 페이지 전체가 하나의 diff
// 덩어리로 잡히면, 그 덩어리를 리플로우 후보로 보고 matchTemplate 을 부른다.
// TM_CCOEFF_NORMED 는 검색창의 적분영상을 CV_64F(픽셀당 8바이트)로 잡으므로
// 11308x4751 창 하나가 410MB — opencv.js 의 1GB wasm 힙이 그대로 터진다.
// 그래서 창이 상한을 넘으면 매칭을 아예 하지 않는다(= 리플로우 아님).
import { describe, expect, it } from "vitest";
import { REFLOW_MAX_WIN_PX, findShiftedMatch } from "./engine.ts";
import type { CV, Mat } from "../types.ts";

// matchTemplate 호출 여부만 보면 되는 최소 가짜 cv.
function fakeCv() {
  const calls: { w: number; h: number }[] = [];
  const mat = (cols: number, rows: number): Mat => ({
    cols, rows,
    roi: (r: { width: number; height: number }) => mat(r.width, r.height),
    delete: () => {},
  } as unknown as Mat);
  const cv = {
    Rect: function (this: Record<string, number>, x: number, y: number,
                    width: number, height: number) {
      this.x = x; this.y = y; this.width = width; this.height = height;
    },
    Mat: function (this: Record<string, unknown>) {
      this.rows = 1; this.cols = 1;
      this.data32F = new Float32Array(1);
      this.delete = () => {};
    },
    TM_CCOEFF_NORMED: 5,
    matchTemplate: (win: Mat, _tmpl: Mat, _res: Mat) => {
      calls.push({ w: win.cols, h: win.rows });
    },
    minMaxLoc: () => ({ maxVal: 0.99, maxLoc: { x: 0, y: 0 } }),
  } as unknown as CV;
  return { cv, calls, mat };
}

describe("findShiftedMatch 검색창 상한", () => {
  it("보통 크기의 덩어리는 그대로 매칭한다", () => {
    const { cv, calls, mat } = fakeCv();
    const page = mat(5564, 7000);
    const [corr] = findShiftedMatch(cv, page, page, [1000, 1000, 300, 60],
                                    48, 60, 200, 12);
    expect(calls.length).toBe(1);
    expect(calls[0].w * calls[0].h).toBeLessThanOrEqual(REFLOW_MAX_WIN_PX);
    expect(corr).toBeCloseTo(0.99);
  });

  it("페이지만 한 덩어리는 matchTemplate을 부르지 않고 '아님'을 돌려준다", () => {
    const { cv, calls, mat } = fakeCv();
    // 사고 재현 크기 — 11308x4751 창을 만드는 페이지 전체 덩어리
    const page = mat(11308, 4751);
    const res = findShiftedMatch(cv, page, page, [0, 0, 11308, 4751],
                                 48, 60, 200, 12);
    expect(calls.length).toBe(0);
    expect(res).toEqual([-1.0, 0, 0]);
  });
});

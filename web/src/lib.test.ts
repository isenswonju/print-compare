import { describe, expect, it } from "vitest";
import {
  boxesIntersect, computeDefects, computeFeedbackEndpoints, csvEsc,
  displayCsv, feedbackCsv, fmtDateTime, fmtMB, mapDisplay, sevCounts,
  slimPayload, type FeedbackPayload,
} from "./lib.ts";
import type { DispFinding, Finding, ResultItem } from "./types.ts";

const finding = (p: Partial<Finding> & { id: number; type: string }): Finding => ({
  severity: "major", bbox_ref: [0, 0, 10, 10], area_px: 100,
  near_text: "", note: "", ...p,
});

describe("fmtMB", () => {
  it("바이트를 MB로", () => {
    expect(fmtMB(1024 * 1024)).toBe("1.0MB");
    expect(fmtMB(1.5 * 1024 * 1024)).toBe("1.5MB");
  });
});

describe("fmtDateTime", () => {
  it("YYYY-MM-DD HH:MM 로컬 시각으로 표기(0 패딩)", () => {
    // 로컬 타임존 기준으로 구성해 환경 독립적으로 검증
    const d = new Date(2026, 6, 3, 9, 5); // 2026-07-03 09:05 local
    expect(fmtDateTime(d.getTime())).toBe("2026-07-03 09:05");
  });
});

describe("mapDisplay", () => {
  it("extra minor → 인쇄/오염(major)", () => {
    expect(mapDisplay(finding({ id: 1, type: "extra", severity: "minor" })))
      .toEqual({ ktype: "인쇄/오염", severity: "major", note: "여백 인쇄/오염 불량" });
  });
  it("extra major → 가독성(critical)", () => {
    expect(mapDisplay(finding({ id: 1, type: "extra", severity: "major" })))
      .toMatchObject({ ktype: "가독성", severity: "critical" });
  });
  it("missing → 인쇄 누락(critical)", () => {
    expect(mapDisplay(finding({ id: 1, type: "missing" })))
      .toMatchObject({ ktype: "인쇄 누락", severity: "critical" });
  });
  it("text_mismatch는 note의 상세를 괄호로 병기", () => {
    const d = mapDisplay(finding({ id: 1, type: "text_mismatch",
      note: "OCR 불일치: A→B" }));
    expect(d).toMatchObject({ ktype: "인쇄 오류", severity: "critical" });
    expect(d!.note).toContain("(A→B)");
  });
  it("showthrough·trim_mark는 표시 제외(null)", () => {
    expect(mapDisplay(finding({ id: 1, type: "showthrough" }))).toBeNull();
    expect(mapDisplay(finding({ id: 1, type: "trim_mark_expected" }))).toBeNull();
  });
});

describe("boxesIntersect", () => {
  it("겹치면 true", () => {
    expect(boxesIntersect([0, 0, 10, 10], [5, 5, 10, 10])).toBe(true);
  });
  it("떨어져 있으면 false", () => {
    expect(boxesIntersect([0, 0, 10, 10], [20, 20, 5, 5])).toBe(false);
  });
});

describe("computeDefects", () => {
  const findings: Finding[] = [
    finding({ id: 1, type: "missing", severity: "major", bbox_ref: [0, 0, 10, 10] }),
    finding({ id: 2, type: "extra", severity: "minor", bbox_ref: [100, 100, 10, 10] }),
    finding({ id: 3, type: "extra", severity: "major", bbox_ref: [200, 0, 10, 10] }),
    finding({ id: 4, type: "showthrough", severity: "major", bbox_ref: [300, 0, 10, 10] }),
    finding({ id: 5, type: "text_mismatch", severity: "critical",
              bbox_ref: [100, 100, 20, 20], note: "OCR 불일치: a→b" }),
    finding({ id: 6, type: "missing", severity: "expected", bbox_ref: [400, 0, 10, 10] }),
  ];
  const defects = computeDefects(findings);

  it("잉크 diff가 text_mismatch와 겹치면 하나(인쇄 오류)만 남긴다", () => {
    // id2(extra)가 id5(text_mismatch)와 겹쳐 억제됨
    expect(defects.map((d) => d.id)).not.toContain(2);
  });
  it("표시 불가(showthrough)·expected는 제외", () => {
    expect(defects.map((d) => d.id)).not.toContain(4);
    expect(defects.map((d) => d.id)).not.toContain(6);
  });
  it("남는 결함은 id 1,3,5 (심각도→id 순)", () => {
    expect(defects.map((d) => d.id)).toEqual([1, 3, 5]);
  });
  it("각 결함에 표시 매핑(disp)이 붙는다", () => {
    expect(defects.find((d) => d.id === 5)!.disp.ktype).toBe("인쇄 오류");
  });
});

describe("sevCounts", () => {
  it("표시 심각도별 집계", () => {
    const defects = computeDefects([
      finding({ id: 1, type: "missing", severity: "major" }),          // critical
      finding({ id: 2, type: "extra", severity: "minor",
                bbox_ref: [50, 50, 5, 5] }),                           // major
    ]);
    expect(sevCounts(defects)).toEqual({ critical: 1, major: 1, minor: 0 });
  });
});

describe("computeFeedbackEndpoints", () => {
  it("hf.space 호스트는 수집 서버 없음", () => {
    expect(computeFeedbackEndpoints("i-sens-artwork-compare.static.hf.space"))
      .toEqual([]);
  });
  it("사내망 호스트는 /feedback", () => {
    expect(computeFeedbackEndpoints("192.168.24.23")).toEqual(["/feedback"]);
    expect(computeFeedbackEndpoints("localhost")).toEqual(["/feedback"]);
  });
});

describe("CSV", () => {
  const defects: DispFinding[] = [
    { ...finding({ id: 1, type: "missing" }),
      disp: { ktype: "인쇄 누락", severity: "critical", note: "미 인쇄" } },
  ];

  it("csvEsc는 따옴표를 이스케이프하고 감싼다", () => {
    expect(csvEsc('a"b')).toBe('"a""b"');
  });

  it("displayCsv는 BOM+헤더+행", () => {
    const csv = displayCsv(defects,
      { defects: { 1: { fp: true, comment: "먼지" } } });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("번호,유형,심각도,비고,피드백");
    expect(csv).toContain("인쇄 누락");
    expect(csv).toContain("오탐: 먼지");
  });

  it("feedbackCsv는 오탐·미검출 행을 낸다", () => {
    const items: ResultItem[] = [{
      name: "세트1", setId: 1, page: 1, pageCount: 1,
      fb: {
        defects: { 1: { fp: true, cause: "먼지", comment: "노이즈",
                        ktype: "가독성", bbox: [1, 2, 3, 4] } },
        missed: [{ x: 5, y: 6, cause: "누락", comment: "못잡음" }],
      },
    }];
    const csv = feedbackCsv(items);
    expect(csv).toContain("세트,구분,번호,유형,원인,x,y,w,h,코멘트");
    expect(csv).toContain("오탐");
    expect(csv).toContain("미검출");
    expect(csv).toContain("M1");
  });
});

describe("slimPayload", () => {
  it("원본 이미지를 제거하고 imagesDropped 표시", () => {
    const payload: FeedbackPayload = {
      app: "x", version: "v", sentAt: "t", origin: "o",
      items: [{ set: "s", refImage: "data:...", testImage: "data:...", keep: 1 }],
    };
    const slim = slimPayload(payload);
    expect(slim.items[0]).not.toHaveProperty("refImage");
    expect(slim.items[0]).not.toHaveProperty("testImage");
    expect(slim.items[0]).toMatchObject({ keep: 1, imagesDropped: true });
  });
});

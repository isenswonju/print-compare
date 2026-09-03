import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySetName, boxesIntersect, buildFeedbackPayload, computeDefects,
  computeFeedbackEndpoints, copyToClipboard, csvEsc, displayCsv, download,
  drawLensInto, entryDay, feedbackCsv, feedbackTargets, flushFbQueue,
  fmtDateTime, fmtMB, loadFbQueue, mapDisplay, restoreResults, saveFbQueue,
  serializeResults, sevCounts, slimPayload, summarizeFeedbackForChat, buildErrorReport,
  trySendFeedback, type AdminEntry, type FeedbackPayload,
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

describe("applySetName — 세트 이름 변경(그 세트의 모든 페이지에 적용)", () => {
  const mk = (setId: number, page: number, name: string) =>
    ({ name, setId, page, pageCount: 2 }) as ResultItem;
  const results: ResultItem[] = [
    mk(1, 1, "세트 1"), mk(1, 2, "세트 1"), mk(2, 1, "세트 2"),
  ];

  it("같은 setId의 모든 페이지 이름을 바꾼다", () => {
    const out = applySetName(results, 1, "케어센스 라벨");
    expect(out.filter((r) => r.setId === 1).map((r) => r.name))
      .toEqual(["케어센스 라벨", "케어센스 라벨"]);
  });
  it("다른 세트는 건드리지 않는다", () => {
    const out = applySetName(results, 1, "케어센스 라벨");
    expect(out.find((r) => r.setId === 2)!.name).toBe("세트 2");
  });
  it("원본 배열을 변형하지 않는다(불변)", () => {
    applySetName(results, 1, "X");
    expect(results[0].name).toBe("세트 1");
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
  // 글자 접촉 실측(touch_text_px)이 있으면 severity 근사보다 우선한다 —
  // 실측 경계(back-pair TEST-1, 2026-08-03 사용자 판정 8건): 오염 ≤6, 침범 ≥33.
  it("extra major라도 글자 접촉 0이면 여백 오염 → 인쇄/오염", () => {
    expect(mapDisplay(finding({ id: 1, type: "extra", severity: "major",
        metrics: { touch_text_px: 6 } })))
      .toMatchObject({ ktype: "인쇄/오염", severity: "major" });
  });
  it("extra minor라도 글자 접촉이 크면 침범 → 가독성", () => {
    expect(mapDisplay(finding({ id: 1, type: "extra", severity: "minor",
        metrics: { touch_text_px: 33 } })))
      .toMatchObject({ ktype: "가독성", severity: "critical" });
  });
  it("text_mismatch 증거가 추가 잉크뿐이고 글자 접촉 없으면 → 인쇄/오염", () => {
    // 'blood' → 'blood.' — 여백의 오염 점이 읽힘만 바꾼 경우(내용 불일치 아님)
    expect(mapDisplay(finding({ id: 1, type: "text_mismatch",
        note: "OCR 불일치: 'blood' → 'blood.'",
        metrics: { evidence: "added", touch_text_px: 6 } })))
      .toMatchObject({ ktype: "인쇄/오염", severity: "major" });
  });
  it("text_mismatch 증거가 추가 잉크 + 글자 접촉이면 → 가독성", () => {
    // '°C).' → '°Q).' — 오염이 글자를 메워 가독성을 해친 경우
    expect(mapDisplay(finding({ id: 1, type: "text_mismatch",
        note: "OCR 불일치: '°C).' → '°Q).'",
        metrics: { evidence: "added", touch_text_px: 35 } })))
      .toMatchObject({ ktype: "가독성", severity: "critical" });
  });
  it("text_mismatch 증거가 잉크 누락(lost)이면 종전대로 인쇄 오류", () => {
    expect(mapDisplay(finding({ id: 1, type: "text_mismatch",
        note: "OCR 불일치: 'Strips' → 'Strip'",
        metrics: { evidence: "lost" } })))
      .toMatchObject({ ktype: "인쇄 오류", severity: "critical" });
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
  it("text_mismatch에 상세(OCR 불일치:)가 없으면 괄호 없이", () => {
    const d = mapDisplay(finding({ id: 1, type: "text_mismatch", note: "노트만" }));
    expect(d!.note).toBe("인쇄 내용 불일치"); // detail 없음 → 괄호 미표기
  });
  it("faded는 '가독성'(major)으로 — '인쇄 농도' 유형은 고객 분류에 없다(8/5)", () => {
    const d = mapDisplay(finding({ id: 1, type: "faded",
      note: "인쇄 농도 부족 — 잉크 진하기가 이 페이지 평균의 55% 수준(옅게 인쇄됨)" }));
    expect(d).toMatchObject({ ktype: "가독성", severity: "major" });
    expect(d!.note).toContain("55%");
  });
  it("faded에 문구가 없으면 기본 설명", () => {
    const d = mapDisplay(finding({ id: 1, type: "faded", note: "" }));
    expect(d!.note).toBe("인쇄 농도 부족(옅게 인쇄됨)");
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
    expect(computeFeedbackEndpoints("i-sens-print-compare.static.hf.space"))
      .toEqual([]);
  });
  it("사내망 호스트는 /feedback", () => {
    expect(computeFeedbackEndpoints("192.168.24.23")).toEqual(["/feedback"]);
    expect(computeFeedbackEndpoints("localhost")).toEqual(["/feedback"]);
  });
});

describe("feedbackTargets", () => {
  it("수집기 URL이 있으면 호스트와 무관하게 그리로만 보낸다", () => {
    const url = "https://print-compare-feedback.vercel.app/api/feedback";
    expect(feedbackTargets(url, "i-sens-print-compare.static.hf.space"))
      .toEqual([url]);
    expect(feedbackTargets(url, "192.168.24.23")).toEqual([url]);
  });
  it("수집기 URL이 없으면 same-origin 폴백으로 되돌아간다", () => {
    expect(feedbackTargets(undefined, "localhost")).toEqual(["/feedback"]);
    expect(feedbackTargets(undefined, "x.hf.space")).toEqual([]);
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

  it("displayCsv는 BOM+헤더+행(피드백 있음)", () => {
    const csv = displayCsv(defects,
      { defects: { 1: { fp: true, comment: "먼지" } } });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("번호,유형,심각도,비고,피드백");
    expect(csv).toContain("인쇄 누락");
    expect(csv).toContain("오탐: 먼지");
  });

  it("displayCsv는 피드백 인자가 없어도 동작(피드백 열 비움)", () => {
    const csv = displayCsv(defects); // fb 없음 → 피드백 텍스트 ""
    expect(csv).toContain("인쇄 누락");
    expect(csv.trim().split("\r\n")).toHaveLength(2); // 헤더 + 1행
  });

  it("displayCsv: 의견(fp=false)·코멘트 없음도 처리(빈 코멘트 분기)", () => {
    const csv = displayCsv(defects, { defects: { 1: { fp: false, comment: "" } } });
    expect(csv).toContain("의견"); // fp false 분기 + comment "" 분기
  });

  it("feedbackCsv: fb 없는 세트는 건너뛰고, 오탐/의견/미검출을 모두 낸다", () => {
    const items: ResultItem[] = [
      { name: "fb없음", setId: 9, page: 1, pageCount: 1 }, // fb 없음 → continue
      {
        name: "세트1", setId: 1, page: 1, pageCount: 1,
        fb: {
          defects: {
            1: { fp: true, cause: "먼지", comment: "노이즈", ktype: "가독성",
                 bbox: [1, 2, 3, 4] },
            2: { fp: false, cause: "", comment: "의견", ktype: "인쇄",
                 bbox: [5, 6, 7, 8] }, // 의견 + 원인 없음(||"")
          },
          missed: [{ x: 5, y: 6, comment: "못잡음" }], // cause 없음(||"")
        },
      },
    ];
    const csv = feedbackCsv(items);
    expect(csv).toContain("오탐");
    expect(csv).toContain("의견");
    expect(csv).toContain("미검출");
    expect(csv).toContain("M1");
  });

  it("feedbackCsv: 아무 피드백도 없으면 헤더만", () => {
    expect(feedbackCsv([]).trim().split("\r\n")).toHaveLength(1);
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

// ------------------------------------------------- 피드백 큐·전송·결과 보존(unit)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("피드백 보류 큐", () => {
  it("saveFbQueue: 비었으면 removeItem, 있으면 setItem, 실패는 false", () => {
    expect(saveFbQueue([])).toBe(true);
    expect(localStorage.getItem("artwork-fb-queue")).toBeNull();
    const q = [{ app: "x", version: "1", sentAt: "", origin: "", items: [] }];
    expect(saveFbQueue(q)).toBe(true);
    expect(loadFbQueue()).toHaveLength(1);
    // setItem이 예외(용량 초과 등) → false
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota"); });
    expect(saveFbQueue(q)).toBe(false);
  });

  it("loadFbQueue: 깨진 JSON은 빈 배열로", () => {
    localStorage.setItem("artwork-fb-queue", "{not json");
    expect(loadFbQueue()).toEqual([]);
  });

  it("flushFbQueue: 빈 큐는 0", async () => {
    expect(await flushFbQueue()).toBe(0);
  });

  it("flushFbQueue: 성공분은 보내고 실패분은 남긴다", async () => {
    const p = (n: number): FeedbackPayload =>
      ({ app: "x", version: "1", sentAt: "", origin: "", items: [{ n }] });
    saveFbQueue([p(1), p(2)]);
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      return { ok: call === 1 } as Response; // 첫 건만 성공
    }));
    const sent = await flushFbQueue();
    expect(sent).toBe(1);
    expect(loadFbQueue()).toHaveLength(1); // 실패분 1건 남음
  });
});

describe("trySendFeedback", () => {
  const payload: FeedbackPayload = { app: "x", version: "1", sentAt: "", origin: "", items: [] };
  it("ok면 성공한 URL 반환", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true } as Response)));
    expect(await trySendFeedback(payload, ["/a", "/b"])).toBe("/a");
  });
  it("실패면 다음 후보로, 다 실패면 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false } as Response)));
    expect(await trySendFeedback(payload, ["/a", "/b"])).toBeNull();
  });
  it("예외는 삼키고 다음 후보(모두 예외면 null)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await trySendFeedback(payload, ["/a"])).toBeNull();
  });
  it("대상이 없으면 null", async () => {
    expect(await trySendFeedback(payload, [])).toBeNull();
  });
});

describe("serializeResults / restoreResults — 캔버스 없는 경로", () => {
  it("serializeResults: falsy 항목은 건너뛰고 error 항목은 그대로 저장", async () => {
    const results = [
      null as unknown as ResultItem,
      { name: "실패", setId: 1, page: 1, pageCount: 1, error: "분석 실패" },
    ];
    const out = await serializeResults(results);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "실패", error: "분석 실패" });
  });

  it("restoreResults: 복원 불가 레코드는 error 항목(+태그 기본값 보정)", async () => {
    const restored = await restoreResults([
      { name: "구버전" },                       // setId/page/pageCount 없음 → 기본값
      { name: "명시실패", error: "원래 실패" },  // s.error 우선
    ]);
    expect(restored[0]).toMatchObject({
      name: "구버전", setId: 0, page: 1, pageCount: 1,
      error: "복원할 수 없는 결과입니다.",
    });
    expect(restored[1].error).toBe("원래 실패");
  });
});

describe("drawLensInto — 방어", () => {
  it("src나 canvas가 없으면 아무 것도 하지 않는다", () => {
    expect(() => drawLensInto(null, null, 0, 0)).not.toThrow();
    const c = { getContext: () => { throw new Error("불려선 안 됨"); } } as unknown as HTMLCanvasElement;
    expect(() => drawLensInto(null, c, 0, 0)).not.toThrow(); // src 없음 → 조기 반환
  });
});

describe("download (unit)", () => {
  it("앵커를 만들어 click하고 잠시 뒤 objectURL을 정리한다", () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    download("결과.json", new Blob(["x"], { type: "application/json" }));
    expect(click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000); // setTimeout 콜백 → revokeObjectURL
    expect(revoke).toHaveBeenCalledWith("blob:x");
    vi.useRealTimers();
  });
});

describe("buildFeedbackPayload — 건너뛰기(캔버스 불필요)", () => {
  it("error·fb없음·캔버스없음 항목은 items에서 제외", async () => {
    const payload = await buildFeedbackPayload([
      { name: "err", setId: 1, page: 1, pageCount: 1, error: "실패" },
      { name: "nofb", setId: 1, page: 1, pageCount: 1 },
      { name: "nocanvas", setId: 1, page: 1, pageCount: 1,
        fb: { defects: {}, missed: [] } },
    ]);
    expect(payload.items).toEqual([]);
    expect(payload.app).toBe("print-compare");
    expect(typeof payload.sentAt).toBe("string");
  });
});

describe("수집 피드백 요약/복사 (관리자 화면 보조)", () => {
  const entry = (over: Partial<AdminEntry> = {}): AdminEntry => ({
    id: "abc123", received: "2026-07-29T08:27:52.000Z",
    origin: "https://example.test",
    data: { version: 3, items: [{
      set: "aa",
      feedback: {
        defects: [{ fp: true, ktype: "인쇄 오류", cause: "스캔 노이즈/먼지",
                    comment: "테스트용\n  피드백2", bbox: [10, 20, 30, 40] }],
        missed: [{ x: 1234.4, y: 567.6, cause: "잉여 잉크/오염",
                   comment: "테스트용 피드백." }],
      },
    }] },
    ...over,
  });

  it("entryDay: received → uploadedAt 순으로 날짜를 뽑는다", () => {
    expect(entryDay(entry())).toBe("2026-07-29");
    expect(entryDay({ id: "x", uploadedAt: "2026-01-02T00:00:00.000Z" }))
      .toBe("2026-01-02");
    expect(entryDay({ id: "x" })).toBe("날짜 미상");
    expect(entryDay({ id: "x", received: "이상한값" })).toBe("날짜 미상");
  });

  it("요약에 id·세트·판정·원인·좌표·의견이 담긴다", () => {
    const text = summarizeFeedbackForChat([entry()]);
    expect(text).toContain("[abc123]");
    expect(text).toContain('세트 "aa"');
    expect(text).toContain("오탐 | 인쇄 오류 | 원인: 스캔 노이즈/먼지");
    expect(text).toContain("bbox_ref=[10,20,30,40]");
    expect(text).toContain('"테스트용 피드백2"');   // 줄바꿈·중복 공백은 정리
    expect(text).toContain("미검출 | 원인: 잉여 잉크/오염 | 위치=(1234,568)");
  });

  it("정탐·본문 없음·읽기 실패 항목도 형태를 유지한다", () => {
    expect(summarizeFeedbackForChat([])).toBe("");
    const tp = summarizeFeedbackForChat([entry({
      data: { items: [{ feedback: { defects: [{ fp: false }] } }] } })]);
    expect(tp).toContain("- 정탐 | 결함");
    expect(tp).toContain('세트 "이름 없음"');
    const empty = summarizeFeedbackForChat([entry({ data: { items: [{ set: "s" }] } })]);
    expect(empty).toContain("(내용 없음)");
    const broken = summarizeFeedbackForChat([{ id: "e1", error: "read failed" }]);
    expect(broken).toContain("본문을 읽지 못함: read failed");
    // data 자체가 없어도 헤더만 남고 깨지지 않는다
    expect(summarizeFeedbackForChat([{ id: "e2" }])).toContain("[e2]");
  });

  it("요약에 type 폴백·시간 미상 표기가 적용된다", () => {
    const text = summarizeFeedbackForChat([{
      id: "e3",
      data: { items: [{ set: "s", feedback: { defects: [{ type: "extra" }] } }] },
    }]);
    expect(text).toContain("시간 미상");
    expect(text).toContain("정탐 | extra");
  });

  it("미검출 항목의 원인·좌표·의견이 없어도 한 줄로 나온다", () => {
    const text = summarizeFeedbackForChat([{
      id: "e4",
      data: { items: [{ set: "s", feedback: { missed: [{}] } }] },
    }]);
    expect(text).toContain("- 미검출");
    expect(text).not.toContain("위치=");
  });

  it("copyToClipboard: clipboard API를 쓰고, 없거나 실패하면 폴백", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyToClipboard("hi")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hi");

    // clipboard가 거부 → execCommand 폴백
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    expect(await copyToClipboard("hi")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");

    // clipboard 자체가 없어도 폴백이 동작
    vi.stubGlobal("navigator", {});
    expect(await copyToClipboard("hi")).toBe(true);

    // 폴백까지 깨지면 false
    (document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error("nope");
    };
    expect(await copyToClipboard("hi")).toBe(false);
  });
});

describe("분석 실패 오류 보고", () => {
  const failed: ResultItem = {
    name: "세트1", setId: 1, page: 2, pageCount: 3,
    error: "OpenCV 내부 오류(코드 120) — 단계: 전역 정합 (ORB)",
    refFile: new File(["r"], "ref.pdf", { type: "application/pdf" }),
    testFile: new File(["t"], "scan.png", { type: "image/png" }),
  };

  it("오류 문구·파일 메타·로그를 담고 이미지는 담지 않는다", () => {
    const logs = Array.from({ length: 80 }, (_, i) => `line${i}`);
    const p = buildErrorReport([failed], logs, "PDF 두 장 올리다 실패");
    expect(p.kind).toBe("error");
    const item = p.items[0] as Record<string, any>;
    expect(item.error).toContain("코드 120");
    expect(item.page).toBe(2);
    expect(item.note).toBe("PDF 두 장 올리다 실패");
    expect(item.refFile).toEqual({ name: "ref.pdf", size: 1, type: "application/pdf" });
    expect(item.testFile.name).toBe("scan.png");
    expect(item.logs).toHaveLength(60);        // 마지막 60줄만
    expect(item.logs[0]).toBe("line20");
    expect(typeof item.ua).toBe("string");
    // 라벨 이미지는 어떤 형태로도 실리지 않는다
    expect(JSON.stringify(p)).not.toContain("data:image");
  });

  it("메모·파일이 없어도 형태를 유지한다", () => {
    const p = buildErrorReport([{ name: "s", setId: 1, page: 1, pageCount: 1,
                                  error: "실패" }], []);
    const item = p.items[0] as Record<string, any>;
    expect(item.note).toBeUndefined();
    expect(item.refFile).toBeUndefined();
    expect(item.testFile).toBeUndefined();
    expect(item.logs).toEqual([]);
  });

  it("요약 복사에도 실패 보고가 사람이 읽을 형태로 들어간다", () => {
    const text = summarizeFeedbackForChat([{
      id: "err1", received: "2026-07-29T08:00:00.000Z",
      data: { kind: "error", items: [{
        set: "세트1", page: 2, error: "코드 120 — 단계: 전역 정합",
        note: "  두 번  시도함 ", refFile: { name: "ref.pdf", size: 1048576 },
        testFile: { name: "scan.png", size: 2097152 },
        logs: ["a", "b"] }] },
    }]);
    expect(text).toContain("분석 실패 보고");
    expect(text).toContain("· 페이지 2");
    expect(text).toContain("- 오류: 코드 120 — 단계: 전역 정합");
    expect(text).toContain('사용자 메모: "두 번 시도함"');
    expect(text).toContain("원본: ref.pdf (1.0MB)");
    expect(text).toContain("인쇄물: scan.png (2.0MB)");
    expect(text).toContain("마지막 로그:");
  });

  it("오류 항목에 문구·메모·파일·로그가 없어도 한 줄은 남는다", () => {
    const text = summarizeFeedbackForChat([{
      id: "err2", data: { kind: "error", items: [{ set: "s" }] } }]);
    expect(text).toContain("- 오류: 문구 없음");
  });
});

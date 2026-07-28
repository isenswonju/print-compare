// runAll/runOne 오케스트레이션을 결정론적으로 검증한다. 실제 cv.worker(opencv wasm)·
// canvas·tesseract는 브라우저/Node 하니스가 담당하므로, 여기서는 Worker와 lib.ts를
// 가짜로 갈아끼워 메시지 프로토콜·캐시 재사용·실패 처리 등 제어 흐름만 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 팩토리에서 참조할 제어 상태(호이스팅).
const ctl = vi.hoisted(() => ({
  hashFile: async (_f: File): Promise<string> => "hashA",
  getRefWords: async (_h: string): Promise<{ words: unknown[]; ts: number } | undefined> =>
    undefined,
  ocrCanvas: async (_c: unknown, _log?: (m: string) => void): Promise<unknown[]> => [],
  putRefWords: vi.fn(async (_h: string, _w: unknown) => {}),
  worker: "ok" as "ok" | "error" | "onerror" | "onerror-empty" | "error-nomsg",
}));

vi.mock("./cache.ts", () => ({
  hashFile: (f: File) => ctl.hashFile(f),
  getRefWords: (h: string) => ctl.getRefWords(h),
  putRefWords: (h: string, w: unknown) => ctl.putRefWords(h, w),
}));

vi.mock("./lib.ts", () => ({
  fileToImageData: async () => ({
    data: new Uint8ClampedArray([0, 0, 0, 0]), width: 1, height: 1,
  }),
  imageDataToCanvas: () => ({ __canvas: true }),
  ocrCanvas: (c: unknown, log?: (m: string) => void) => ctl.ocrCanvas(c, log),
  buildDisplayArtifacts: () => ({
    defects: [], annotated: {}, refCanvas: {}, alignedCanvas: {},
  }),
}));

// 가짜 Worker — run→(log·progress·aligned), ocr→(done|error). worker 모드로 실패 주입.
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage(msg: { type: string }) {
    if (ctl.worker === "onerror") {
      queueMicrotask(() => this.onerror?.({ message: "worker crashed" }));
      return;
    }
    if (ctl.worker === "onerror-empty") {
      // e.message가 빈 문자열 → "worker 오류" 폴백 분기
      queueMicrotask(() => this.onerror?.({ message: "" }));
      return;
    }
    if (msg.type === "run") {
      queueMicrotask(() => {
        this.onmessage?.({ data: { type: "log", msg: "worker log" } });
        this.onmessage?.({ data: { type: "progress", stage: "정합" } });
        // 알 수 없는 타입 — 어떤 분기도 타지 않는 암묵적 else 경로를 커버
        this.onmessage?.({ data: { type: "heartbeat" } });
        this.onmessage?.({
          data: { type: "aligned",
                  buf: new Uint8ClampedArray([0, 0, 0, 0]).buffer, w: 1, h: 1 },
        });
      });
    } else if (msg.type === "ocr") {
      queueMicrotask(() => {
        if (ctl.worker === "error")
          this.onmessage?.({ data: { type: "error", msg: "분석 실패" } });
        else if (ctl.worker === "error-nomsg")
          // msg 없음 → new Error(undefined).message "" → catch에서 `|| err` 분기
          this.onmessage?.({ data: { type: "error" } });
        else
          this.onmessage?.({
            data: { type: "done",
                    result: { findings: [], timings: [], totalMs: 10 } },
          });
      });
    }
  }
  terminate() {}
}

class FakeImageData {
  data: Uint8ClampedArray; width: number; height: number;
  constructor(data: Uint8ClampedArray, w: number, h: number) {
    this.data = data; this.width = w; this.height = h;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runAll: any, computeConcurrency: any, RunSetT: any;

beforeEach(async () => {
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  vi.stubGlobal("ImageData", FakeImageData as unknown as typeof ImageData);
  // 매 테스트 기본 동작으로 리셋
  ctl.hashFile = async () => "hashA";
  ctl.getRefWords = async () => undefined;
  // 진행 로그 콜백(REF [REF]·TEST [TEST])을 실제로 호출해 해당 람다까지 커버.
  ctl.ocrCanvas = async (_c, log) => {
    log?.("[진행] 인식 중");
    return [{ text: "w", conf: 90, bbox: [0, 0, 1, 1], line: [0, 0, 0] }];
  };
  ctl.putRefWords.mockClear();
  ctl.worker = "ok";
  ({ runAll, computeConcurrency } = await import("./runner.ts"));
  void RunSetT;
});
afterEach(() => vi.unstubAllGlobals());

const f = (n: string) => new File(["x"], n, { type: "image/png" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collector() {
  const logs: string[] = [];
  const results: any[] = [];
  const stages: [number, string | null][] = [];
  return {
    logs, results, stages,
    cb: {
      log: (m: string) => logs.push(m),
      stage: (slot: number, s: string | null) => stages.push([slot, s]),
      onResult: (_i: number, item: any) => results.push(item),
    },
  };
}

describe("runAll — 오케스트레이션", () => {
  it("단일 세트·OCR off — 성공 결과를 낸다", async () => {
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, false, c.cb);
    expect(c.results).toHaveLength(1);
    expect(c.results[0]).toMatchObject({ setId: 1, name: "A", page: 1 });
    expect(c.results[0].result.totalMs).toBe(10);
    expect(typeof c.results[0].result.wallMs).toBe("number");
    // 단일 페이지·단일 세트면 "[실행]" 요약 로그를 남기지 않는다
    expect(c.logs.some((l) => l.startsWith("[실행]"))).toBe(false);
    // 마지막에 slot 정리(stage null)
    expect(c.stages.some(([, s]) => s === null)).toBe(true);
  });

  it("여러 세트면 실행 요약 로그를 남긴다", async () => {
    const c = collector();
    const sets = [
      { setId: 1, name: "A", refPages: [f("r1.png")], testPages: [f("t1.png")] },
      { setId: 2, name: "B", refPages: [f("r2.png")], testPages: [f("t2.png")] },
    ];
    await runAll(sets, false, c.cb);
    expect(c.results).toHaveLength(2);
    expect(c.logs.some((l) => l.startsWith("[실행]"))).toBe(true);
  });

  it("OCR on·캐시 미스 — REF OCR 수행 후 캐시에 저장", async () => {
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, true, c.cb);
    expect(ctl.putRefWords).toHaveBeenCalledTimes(1); // 새로 계산 → 저장
    expect(c.results[0].result).toBeTruthy();
  });

  it("REF OCR가 단어를 못 내면(null) OCR words 없이 진행", async () => {
    // ocrCanvas가 null 반환 → refWords 거짓 → words 미구성(if(refWords) else 분기)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctl.ocrCanvas = async () => null as any;
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, true, c.cb);
    expect(c.results[0].result).toBeTruthy(); // OCR 없어도 결과는 나온다
  });

  it("OCR on·캐시 히트 — 이전 검수 OCR 재사용(재계산 안 함)", async () => {
    ctl.getRefWords = async () => ({ words: [], ts: 1 });
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, true, c.cb);
    expect(ctl.putRefWords).not.toHaveBeenCalled(); // 캐시 히트라 저장 안 함
    expect(c.logs.some((l) => l.includes("이전 검수의 OCR"))).toBe(true);
  });

  it("OCR on·같은 원본 두 페이지 — REF OCR 메모이즈(1회만)", async () => {
    const ocrSpy = vi.fn(async () => []);
    ctl.ocrCanvas = ocrSpy;
    const same = f("same.png");
    const c = collector();
    // 원본 두 페이지가 동일 파일 → 같은 해시 → REF OCR 1회 재사용
    const sets = [{ setId: 1, name: "A", refPages: [same, same],
                    testPages: [f("t1.png"), f("t2.png")] }];
    await runAll(sets, true, c.cb);
    expect(c.results).toHaveLength(2);
    expect(c.logs.some((l) => l.includes("같은 원본"))).toBe(true);
    // REF OCR 1회 + TEST OCR 2회 = 3회 (REF 재계산 없음)
    expect(ocrSpy).toHaveBeenCalledTimes(3);
  });

  it("hashFile 실패해도 분석은 진행(캐시만 생략)", async () => {
    ctl.hashFile = async () => { throw new Error("no crypto"); };
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, true, c.cb);
    expect(c.results[0].result).toBeTruthy();
    expect(ctl.putRefWords).not.toHaveBeenCalled(); // refHash 없음 → 저장 생략
  });

  it("TEST OCR 실패 시 OCR 경로만 생략하고 분석은 계속", async () => {
    // REF OCR(첫 호출)은 성공, TEST OCR(둘째 호출)만 실패시켜 runOne의 OCR
    // catch 경로를 탄다(REF 프라미스는 이미 resolve되어 미처리 거부 없음).
    let n = 0;
    ctl.ocrCanvas = async () => { if (++n >= 2) throw new Error("ocr boom"); return []; };
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, true, c.cb);
    expect(c.results[0].result).toBeTruthy(); // 결과는 나온다
    expect(c.logs.some((l) => l.includes("OCR") && l.includes("생략"))).toBe(true);
  });

  it("워커 error 메시지 → 해당 페이지 실패로 기록", async () => {
    ctl.worker = "error";
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, false, c.cb);
    expect(c.results[0].error).toContain("분석 실패");
    expect(c.results[0].result).toBeUndefined();
  });

  it("워커 onerror → 실패로 기록", async () => {
    ctl.worker = "onerror";
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, false, c.cb);
    expect(c.results[0].error).toContain("worker crashed");
  });

  it("워커 onerror에 메시지가 없으면 기본 문구로 실패", async () => {
    ctl.worker = "onerror-empty";
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, false, c.cb);
    expect(c.results[0].error).toBe("worker 오류");
  });

  it("워커 error 메시지가 없어도 실패로 기록(err 폴백)", async () => {
    ctl.worker = "error-nomsg";
    const c = collector();
    const sets = [{ setId: 1, name: "A", refPages: [f("r.png")], testPages: [f("t.png")] }];
    await runAll(sets, false, c.cb);
    expect(c.results[0].error).toBe("Error"); // message "" → String(err)
  });
});

describe("computeConcurrency — navigator 기본값 분기", () => {
  it("navigator 값이 없으면 4로 폴백 → 직렬(1)", () => {
    vi.stubGlobal("navigator", {}); // deviceMemory·hardwareConcurrency 모두 없음
    expect(computeConcurrency()).toBe(1);
  });
  it("navigator 값이 충분하면 병렬(2)", () => {
    vi.stubGlobal("navigator", { deviceMemory: 8, hardwareConcurrency: 8 });
    expect(computeConcurrency()).toBe(2);
  });
});

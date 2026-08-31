// CV 파이프라인 전용 Web Worker (클래식) — OpenCV(wasm) 계산이 UI를 멈추지 않게 분리.
// opencv.js는 공식 빌드를 importScripts로 로드한다. npm(@techstark) 패키지는
// 번들러 경유(module.exports 분기) 시 초기화가 무한 루프에 빠져 브라우저에서
// 사용 불가 — Node 하니스에서만 쓴다.
// OCR(tesseract.js)은 메인 스레드가 자체 워커로 병렬 실행 후 'ocr' 메시지로 회신.
import { runPipeline } from "./engine.ts";
import { detectInstances } from "./multisample.ts";
import type { CV, OcrWords } from "../types.ts";

declare function importScripts(...urls: string[]): void;
const ctx = self as unknown as Worker & { cv?: CV };

ctx.postMessage({ type: "log", msg: "[워커] 부팅 (opencv 로드 중)" });

// 워커 스크립트(assets/) 기준 상대 경로 — base(/app/ 등)와 무관하게 동작
importScripts("../opencv/opencv.js");

ctx.postMessage({
  type: "log",
  msg: `[워커] importScripts 완료 — typeof cv=${typeof ctx.cv}` +
       `, Mat=${!!(ctx.cv && ctx.cv.Mat)}`,
});

// 주의: emscripten Module에는 가짜 .then이 있어 Promise가 cv를 그대로
// resolve하면 thenable 동화(assimilation)로 무한 재귀에 빠진다 — 래퍼로 감싼다.
const cvReady = new Promise<{ cv: CV }>((res) => {
  const iv = setInterval(() => {
    if (ctx.cv && ctx.cv.Mat) { clearInterval(iv); res({ cv: ctx.cv }); }
  }, 50);
});
cvReady.then(() =>
  ctx.postMessage({ type: "log", msg: "[워커] OpenCV 초기화 완료" }));

let pendingOcr: ((words: OcrWords | null) => void) | null = null;
// 마지막으로 지나간 단계 — OpenCV(wasm) 예외는 메시지 없이 숫자 포인터로만
// 튀어나오는 경우가 있어("120" 같은 값), 어디서 터졌는지를 함께 알려준다.
let lastStage = "시작";

// wasm 힙 사용량(MB) — opencv.js는 자기 힙 안에서만 Mat을 잡으므로, 이 값이
// 한계에 닿으면 bad_alloc이 숫자 예외로 튀어나온다.
function heapMB(): string {
  const buf = (ctx.cv as unknown as { HEAPU8?: Uint8Array })?.HEAPU8?.buffer;
  return buf ? `${(buf.byteLength / 1024 / 1024).toFixed(0)}MB` : "?";
}

// wasm에서 올라온 예외를 사람이 읽을 수 있는 문장으로.
function describeError(err: unknown): string {
  const cv = ctx.cv as unknown as
    { exceptionFromPtr?: (p: number) => { msg?: string; err?: string } };
  // 1) 예외 포인터(숫자) — 빌드가 지원하면 실제 메시지를 꺼낸다.
  if (typeof err === "number") {
    try {
      const ex = cv?.exceptionFromPtr?.(err);
      const detail = ex?.msg || ex?.err;
      if (detail) return `OpenCV 오류(${err}) — ${detail} [단계: ${lastStage}]`;
    } catch { /* 아래 일반 문구로 */ }
    return `OpenCV 내부 오류(코드 ${err}) — 단계: ${lastStage}. ` +
           `이미지가 너무 크거나 손상됐을 때 주로 발생합니다.`;
  }
  // 2) 메모리 부족(대형 라벨에서 흔함)은 따로 짚어준다.
  const msg = String((err as Error)?.message || err);
  if (/out of memory|Cannot enlarge|allocat/i.test(msg))
    return `메모리 부족으로 분석을 마치지 못했습니다 [단계: ${lastStage}] — ${msg}`;
  return `${msg} [단계: ${lastStage}]`;
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "run") {
    lastStage = "OpenCV 초기화";
    try {
      const { cv } = await cvReady;
      const result = await runPipeline(
        cv,
        { data: new Uint8ClampedArray(msg.ref.buf), width: msg.ref.w, height: msg.ref.h },
        { data: new Uint8ClampedArray(msg.test.buf), width: msg.test.w, height: msg.test.h },
        msg.cfg,
        {
          log: (m) => ctx.postMessage({ type: "log", msg: m }),
          progress: (s) => {
            lastStage = s;
            // 단계마다 wasm 힙 사용량을 로그에 남긴다 — 대형 라벨에서 메모리
            // 부족으로 죽을 때 어디서 한계에 닿았는지 사후 추적할 수 있게.
            ctx.postMessage({ type: "log", msg: `[heap] ${s}: ${heapMB()}` });
            ctx.postMessage({ type: "progress", stage: s });
          },
          onAligned: (rgba, w, h) =>
            new Promise((resolve) => {
              pendingOcr = resolve;
              (ctx.postMessage as (m: unknown, t: Transferable[]) => void)(
                { type: "aligned", buf: rgba.buffer, w, h }, [rgba.buffer]);
            }),
        },
      );
      ctx.postMessage({ type: "done", result });
    } catch (err) {
      ctx.postMessage({ type: "error", msg: describeError(err),
                        stage: lastStage });
    }
  } else if (msg.type === "detect") {
    // 다중 샘플 검출 — TEST 스캔 한 장에서 REF가 나타나는 위치들을 찾는다.
    lastStage = "다중 샘플 검출";
    try {
      const { cv } = await cvReady;
      const rects = detectInstances(
        cv,
        { data: new Uint8ClampedArray(msg.ref.buf), width: msg.ref.w, height: msg.ref.h },
        { data: new Uint8ClampedArray(msg.test.buf), width: msg.test.w, height: msg.test.h },
        (m) => ctx.postMessage({ type: "log", msg: m }),
      );
      ctx.postMessage({ type: "detected", rects });
    } catch (err) {
      ctx.postMessage({ type: "error", msg: describeError(err),
                        stage: lastStage });
    }
  } else if (msg.type === "ocr") {
    // msg.words: {refWords, testWords} | null (OCR 끔/실패)
    pendingOcr?.(msg.words);
    pendingOcr = null;
  }
};

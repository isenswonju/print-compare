// CV 파이프라인 전용 Web Worker (클래식) — OpenCV(wasm) 계산이 UI를 멈추지 않게 분리.
// opencv.js는 공식 빌드를 importScripts로 로드한다. npm(@techstark) 패키지는
// 번들러 경유(module.exports 분기) 시 초기화가 무한 루프에 빠져 브라우저에서
// 사용 불가 — Node 하니스에서만 쓴다.
// OCR(tesseract.js)은 메인 스레드가 자체 워커로 병렬 실행 후 'ocr' 메시지로 회신.
import { runPipeline } from "./engine.ts";
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

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "run") {
    try {
      const { cv } = await cvReady;
      const result = await runPipeline(
        cv,
        { data: new Uint8ClampedArray(msg.ref.buf), width: msg.ref.w, height: msg.ref.h },
        { data: new Uint8ClampedArray(msg.test.buf), width: msg.test.w, height: msg.test.h },
        msg.cfg,
        {
          log: (m) => ctx.postMessage({ type: "log", msg: m }),
          progress: (s) => ctx.postMessage({ type: "progress", stage: s }),
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
      ctx.postMessage({ type: "error",
                        msg: String((err as Error)?.message || err) });
    }
  } else if (msg.type === "ocr") {
    // msg.words: {refWords, testWords} | null (OCR 끔/실패)
    pendingOcr?.(msg.words);
    pendingOcr = null;
  }
};

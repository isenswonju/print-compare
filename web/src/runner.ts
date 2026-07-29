// 검수 실행 오케스트레이션 — 세트 병렬 처리(워커 풀).
// 병렬 폭은 CPU가 아니라 메모리가 제약한다(세트당 풀해상도 이미지 수 장,
// wasm 힙 포함 ~1GB+). deviceMemory가 넉넉한 PC만 동시 2세트, 그 외 직렬.
import { hashFile, getRefWords, putRefWords } from "./cache.ts";
import { buildDisplayArtifacts, fileToImageData, imageDataToCanvas,
         ocrCanvas } from "./lib.ts";
import type { OcrWords, PipelineResult, ResultItem, Word } from "./types.ts";

// 한 세트(품목) = 원본 페이지들 ↔ 인쇄물 페이지들(같은 장수). 세트는 페이지
// 수만큼의 페이지쌍 분석으로 펼쳐진다.
export interface RunSet {
  setId: number;
  name: string;
  refPages: File[];
  testPages: File[];
}

interface RunCallbacks {
  log: (m: string) => void;
  stage: (slot: number, s: string | null) => void;
  onResult: (index: number, item: ResultItem) => void;
}

export function computeConcurrency(
  mem: number = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory ?? 4,
  cores: number = navigator.hardwareConcurrency ?? 4,
): number {
  return mem >= 8 && cores >= 8 ? 2 : 1;
}

interface WorkerMsg {
  type: string;
  msg?: string;
  stage?: string;
  result?: PipelineResult;
  buf?: ArrayBuffer;
  w?: number;
  h?: number;
}

function runOne(
  worker: Worker,
  refImg: ImageData,
  testImg: ImageData,
  useOcr: boolean,
  refWordsPromise: Promise<Word[] | null>,
  hooks: { log: (m: string) => void; stage: (s: string) => void },
): Promise<{ result: PipelineResult; alignedCanvas: HTMLCanvasElement }> {
  return new Promise((resolve, reject) => {
    let alignedCanvas: HTMLCanvasElement | null = null;
    worker.onmessage = async (e: MessageEvent<WorkerMsg>) => {
      const msg = e.data;
      if (msg.type === "log") hooks.log(msg.msg!);
      else if (msg.type === "progress") hooks.stage(msg.stage!);
      else if (msg.type === "error") reject(new Error(msg.msg));
      else if (msg.type === "done")
        resolve({ result: msg.result!, alignedCanvas: alignedCanvas! });
      else if (msg.type === "aligned") {
        const imgData = new ImageData(
          new Uint8ClampedArray(msg.buf!), msg.w!, msg.h!);
        alignedCanvas = imageDataToCanvas(imgData);
        let words: OcrWords | null = null;
        if (useOcr) {
          try {
            hooks.stage("OCR (분석과 병렬 진행)");
            const testWords = await ocrCanvas(alignedCanvas,
              (m) => hooks.log("[TEST]" + m));
            const refWords = await refWordsPromise;
            if (refWords) words = { refWords, testWords };
          } catch (err) {
            hooks.log("[OCR] 실패 — OCR 경로 생략: " + (err as Error).message);
          }
        }
        worker.postMessage({ type: "ocr", words });
      }
    };
    worker.onerror = (e) => reject(new Error(e.message || "worker 오류"));
    const refBuf = refImg.data.buffer.slice(0);
    const testBuf = testImg.data.buffer;
    worker.postMessage(
      {
        type: "run",
        ref: { buf: refBuf, w: refImg.width, h: refImg.height },
        test: { buf: testBuf, w: testImg.width, h: testImg.height },
        cfg: { useOcr },
      },
      [refBuf, testBuf],
    );
  });
}

export interface PageJob {
  setId: number;
  name: string;
  page: number;
  pageCount: number;
  ref: File;
  test: File;
}

// 세트들을 페이지쌍 단위 작업으로 펼친다(원본 페이지 i ↔ 인쇄물 페이지 i).
// 양쪽 페이지 수가 다르면 더 적은 쪽 수만큼만(호출부에서 이미 매칭 검증).
export function expandSets(sets: RunSet[]): PageJob[] {
  const jobs: PageJob[] = [];
  for (const s of sets) {
    const n = Math.min(s.refPages.length, s.testPages.length);
    for (let i = 0; i < n; i++)
      jobs.push({ setId: s.setId, name: s.name, page: i + 1, pageCount: n,
                  ref: s.refPages[i], test: s.testPages[i] });
  }
  return jobs;
}

export async function runAll(
  sets: RunSet[],
  useOcr: boolean,
  cb: RunCallbacks,
): Promise<void> {
  const jobs = expandSets(sets);
  const conc = Math.min(computeConcurrency(), jobs.length);
  const totalPages = jobs.length;
  if (sets.length > 1 || totalPages > 1)
    cb.log(`[실행] ${sets.length}세트 · 총 ${totalPages}페이지, 동시 ${conc} 병렬`);
  // 같은 실행에서 동일 원본 페이지가 여러 번 쓰이면 REF OCR을 1회만 수행
  const refWordsMemo = new Map<string, Promise<Word[] | null>>();
  let next = 0;

  const slotLoop = async (slot: number) => {
    const worker = new Worker(
      new URL("./pipeline/cv.worker.ts", import.meta.url));
    try {
      while (next < jobs.length) {
        const index = next++;
        const { setId, name, page, pageCount, ref, test } = jobs[index];
        const pageTag = pageCount > 1 ? ` (${page}/${pageCount}p)` : "";
        const prefix = `[${name}${pageTag}] `;
        const tOne = performance.now();
        try {
          cb.stage(slot, prefix + "원본 읽는 중");
          // 캐시는 부가 기능 — 어떤 실패(http 환경의 crypto 부재, IndexedDB
          // 차단 등)도 분석 자체를 막으면 안 된다.
          let refHash: string | null = null;
          try {
            refHash = await hashFile(ref);
          } catch { /* 캐시 없이 진행 */ }
          const refImg = await fileToImageData(ref);
          const refCanvas = imageDataToCanvas(refImg);
          // REF OCR: ① 같은 실행 내 재사용 ② 지난 검수 캐시(IndexedDB)
          // ③ 새로 수행 후 캐시 저장 — 같은 원본 재검수 시 ~90초 절약
          let refWordsPromise: Promise<Word[] | null> = Promise.resolve(null);
          if (useOcr) {
            const memo = refHash ? refWordsMemo.get(refHash) : undefined;
            if (memo) {
              cb.log(prefix + "[REF][캐시] 같은 원본 — OCR 재사용");
              refWordsPromise = memo;
            } else {
              refWordsPromise = (async () => {
                if (refHash) {
                  const hit = await getRefWords(refHash);
                  if (hit) {
                    cb.log(prefix + "[REF][캐시] 이전 검수의 OCR 결과 재사용");
                    return hit.words;
                  }
                }
                const words = await ocrCanvas(refCanvas,
                  (m) => cb.log(`${prefix}[REF]` + m));
                if (refHash) putRefWords(refHash, words);
                return words;
              })();
              if (refHash) refWordsMemo.set(refHash, refWordsPromise);
            }
          }
          cb.stage(slot, prefix + "인쇄물 읽는 중");
          const testImg = await fileToImageData(test);
          const { result, alignedCanvas } = await runOne(
            worker, refImg, testImg, useOcr, refWordsPromise,
            {
              log: (m) => cb.log(prefix + m),
              stage: (s) => cb.stage(slot, prefix + s),
            });
          result.wallMs = Math.round(performance.now() - tOne);
          const art = buildDisplayArtifacts(result.findings, refCanvas, alignedCanvas);
          // refCanvas/alignedCanvas는 확대경·피드백 팝업의 원본 소스로 유지
          cb.onResult(index, { name, setId, page, pageCount, result, ...art,
                               refCanvas, alignedCanvas,
                               refFile: ref, testFile: test });
        } catch (err) {
          // 실패해도 입력 파일 정보는 남긴다 — 오류 보고에 어떤 파일이었는지
          // 담고, 사용자가 그대로 다시 시도할 수 있게 한다.
          cb.onResult(index, { name, setId, page, pageCount,
                               error: String((err as Error).message || err),
                               refFile: ref, testFile: test });
        }
      }
    } finally {
      cb.stage(slot, null);
      worker.terminate();
    }
  };

  await Promise.all(Array.from({ length: conc }, (_, s) => slotLoop(s)));
}

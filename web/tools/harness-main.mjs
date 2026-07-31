// Node 검증 하니스 — 브라우저와 동일한 엔진 코드를 Node에서 실행해
// Python 기준 결과(findings.json)와 대조한다.
// 사용: node tools/harness.cjs <REF.png> <TEST.png>
//         [--no-ocr] [--no-tile] [--baseline <json>] [--json <out.json>]
// --json 은 정확도 안전망(`python -m bench.run --engine web`)이 결과를 받는 통로다.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { runPipeline } from "../src/pipeline/engine.ts";
import { wordsFromTesseract } from "../src/pipeline/ocr.ts";
import { defaultConfig } from "../src/pipeline/config.ts";

const args = process.argv.slice(2);
// 값을 받는 옵션(--baseline/--json)의 값이 입력 파일로 오인되지 않게 걸러낸다.
const VALUED = new Set(["--baseline", "--json"]);
const files = args.filter((a, i) =>
  !a.startsWith("--") && !VALUED.has(args[i - 1]));
const useOcr = !args.includes("--no-ocr");
const useTile = !args.includes("--no-tile");
const baselineIdx = args.indexOf("--baseline");
const baselinePath = baselineIdx >= 0 ? args[baselineIdx + 1] : null;
const jsonIdx = args.indexOf("--json");
const jsonPath = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

function loadPNG(path) {
  const png = PNG.sync.read(readFileSync(path));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

function rgbaToPngBuffer(rgba, width, height) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png);
}

export async function main(cv) {
  const [refPath, testPath] = files;
  console.log(`REF=${refPath} TEST=${testPath} ocr=${useOcr} tile=${useTile}`);

  const ref = loadPNG(refPath);
  const test = loadPNG(testPath);

  let ocrHook = null;
  let refWordsPromise = null;
  let Tesseract = null;
  if (useOcr) {
    Tesseract = (await import("tesseract.js")).default;
    const mkWorker = async () => {
      const opts = process.env.OCR_LANG_PATH
        ? { langPath: process.env.OCR_LANG_PATH, cacheMethod: "none" }
        : {};
      const w = await Tesseract.createWorker("eng", 1, opts);
      await w.setParameters({ tessedit_pageseg_mode: "3" });
      return w;
    };
    // REF OCR은 정합과 무관하므로 즉시 시작
    refWordsPromise = (async () => {
      const w = await mkWorker();
      const t = Date.now();
      const { data } = await w.recognize(rgbaToPngBuffer(ref.data, ref.width, ref.height),
                                        {}, { blocks: true });
      console.log(`[OCR REF] ${Date.now() - t}ms`);
      await w.terminate();
      return wordsFromTesseract(data, defaultConfig.ocrMinConf);
    })();
    ocrHook = async (alignedRGBA, w, h) => {
      if (process.env.DUMP_ALIGNED)
        (await import("node:fs")).writeFileSync(
          process.env.DUMP_ALIGNED, rgbaToPngBuffer(alignedRGBA, w, h));
      const wk = await mkWorker();
      const t = Date.now();
      const { data } = await wk.recognize(rgbaToPngBuffer(alignedRGBA, w, h),
                                         {}, { blocks: true });
      console.log(`[OCR TEST] ${Date.now() - t}ms`);
      await wk.terminate();
      const testWords = wordsFromTesseract(data, defaultConfig.ocrMinConf);
      const refWords = await refWordsPromise;
      // OCR 오탐 추적용 — Python(pytesseract) 단어 목록과 대조할 때 쓴다.
      if (process.env.DUMP_WORDS)
        writeFileSync(process.env.DUMP_WORDS,
                      JSON.stringify({ refWords, testWords }, null, 1));
      return { refWords, testWords };
    };
  }

  const result = await runPipeline(cv, ref, test,
    { useOcr, useTileRefine: useTile },
    {
      log: (m) => console.log(m),
      progress: (s) => console.log(`  … ${s}`),
      onAligned: ocrHook,
    });

  console.log("\n타이밍:", result.timings.map(([l, t]) => `${l}=${t}ms`).join(" "));
  console.log(`총 ${(result.totalMs / 1000).toFixed(1)}s\n`);
  const fmt = (f) =>
    `${String(f.id).padStart(3)} ${f.type.padEnd(18)} ${f.severity.padEnd(9)} ` +
    `[${f.bbox_ref.join(", ")}] ${f.note.slice(0, 50)}`;
  result.findings.forEach((f) => console.log(fmt(f)));

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({
      ref: refPath, test: testPath, ocr: useOcr, tile: useTile,
      findings: result.findings, totalMs: result.totalMs,
      timings: result.timings,
    }, null, 1));
    console.log(`[json] ${jsonPath}`);
  }

  if (baselinePath) {
    const base = JSON.parse(readFileSync(baselinePath, "utf-8"));
    console.log(`\n=== 기준(${base.length}건) vs 브라우저판(${result.findings.length}건) ===`);
    const iou = (a, b) => {
      const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
      const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
      const inter = ix * iy;
      return inter / (a[2] * a[3] + b[2] * b[3] - inter);
    };
    const used = new Set();
    let matched = 0;
    for (const b of base) {
      let best = null, bestIou = 0;
      for (const f of result.findings) {
        if (used.has(f.id)) continue;
        const v = iou(b.bbox_ref, f.bbox_ref);
        if (v > bestIou) { bestIou = v; best = f; }
      }
      if (best && bestIou > 0.3) {
        used.add(best.id);
        matched++;
        const sevOk = b.severity === best.severity && b.type === best.type;
        console.log(`  ${sevOk ? "일치" : "부분"} #${b.id} ${b.type}/${b.severity}` +
          (sevOk ? "" : ` → ${best.type}/${best.severity}`) +
          ` IoU=${bestIou.toFixed(2)}`);
      } else {
        console.log(`  누락 #${b.id} ${b.type}/${b.severity} [${b.bbox_ref.join(",")}] ${b.note.slice(0, 40)}`);
      }
    }
    const extras = result.findings.filter((f) => !used.has(f.id));
    for (const f of extras)
      console.log(`  초과 #${f.id} ${f.type}/${f.severity} [${f.bbox_ref.join(",")}] ${f.note.slice(0, 40)}`);
    console.log(`매칭 ${matched}/${base.length}, 초과 검출 ${extras.length}`);
  }
  process.exit(0);
}

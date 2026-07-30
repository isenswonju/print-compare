// compare_artwork.py 파이프라인의 OpenCV.js 포트.
// 단계 번호(3.1~3.9)는 Python 원본과 대응한다. 환경 독립(브라우저 워커/Node 공용):
// cv 객체와 hooks({log, progress, onAligned})를 주입받는다.
//
// Python과 의도적으로 다른 부분(성능상 근사 — 결과 영향 최소화):
//  * flattenBackground: close(81) 대신 1/2 축소 후 close(41) 후 확대 (저주파 배경 추정)
//  * 군집 병합 dilate: ellipse(31)/ellipse(61) 대신 rect 커널(분리 가능해 수십 배 빠름)
//  * phaseCorrelate: opencv.js에 없으므로 DFT로 직접 구현
//
// 타입 주의: opencv.js는 타입 정의가 없어 CV/Mat은 any다. 이 파일의 정확성은
// 타입이 아니라 Node 하니스(tools/harness.cjs, Python 결과와 수치 대조)가 보증한다.
import { REF_BASE_WIDTH, defaultConfig, type PipelineConfig } from "./config.ts";
import { textMismatches } from "./textcheck.ts";
import type { BBox, CV, Mat, ImageDataLike, Finding, PipelineResult,
              RunHooks, Word } from "../types.ts";

const now = () => (globalThis.performance ? performance.now() : Date.now());

// wasm에서 올라온 예외는 메시지 없이 숫자(예외 포인터)로만 튀어나올 수 있다
// — 그대로 두면 "120" 같은 값만 보인다. 대부분 힙 부족(bad_alloc)이다.
function describeCvError(err: unknown): string {
  if (typeof err === "number")
    return `OpenCV 내부 오류(코드 ${err}) — 메모리 부족일 가능성이 큽니다`;
  return String((err as Error)?.message || err);
}

interface Comp { bbox: BBox; area: number; }

interface WorkFinding {
  id?: number;
  type: string;
  severity?: string;
  bbox: BBox;
  area: number;
  note: string;
  nearText?: string;
}

export async function runPipeline(
  cv: CV,
  refImg: ImageDataLike,
  testImg: ImageDataLike,
  cfgIn: Partial<PipelineConfig>,
  hooks: Partial<RunHooks>,
): Promise<PipelineResult> {
  const cfg: PipelineConfig = { ...defaultConfig, ...cfgIn };
  const log = hooks.log || (() => {});
  const progress = hooks.progress || (() => {});
  const timings: [string, number][] = [];
  const t0 = now();
  const mark = (label: string, t: number) =>
    timings.push([label, Math.round(now() - t)]);

  const ellipse = (k: number): Mat =>
    cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
  const rectK = (kw: number, kh: number): Mat =>
    cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kw, kh));

  // RGBA {data,width,height} → GRAY Mat
  function toGray(img: ImageDataLike): Mat {
    const rgba = new cv.Mat(img.height, img.width, cv.CV_8UC4);
    rgba.data.set(img.data);
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();
    return gray;
  }

  let ts = now();
  progress("이미지 변환");
  const ref = toGray(refImg);
  const test = toGray(testImg);
  log(`[입력] REF ${ref.cols}x${ref.rows}, TEST ${test.cols}x${test.rows}`);
  mark("변환", ts);

  // ---------------------------------------------------------------- 3.1 전역 정합
  ts = now();
  progress("전역 정합 (ORB)");
  let aligned = globalAlign(cv, ref, test, cfg, log);
  test.delete();
  mark("전역 정합", ts);

  // ---------------------------------------------------------------- 3.2 타일 정밀 정합
  let tol: number;
  if (cfg.useTileRefine) {
    ts = now();
    progress("타일 정밀 정합");
    aligned = tileRefine(cv, ref, aligned, cfg, log);
    tol = cfg.tol;
    mark("타일 정합", ts);
  } else {
    tol = cfg.tolFallback;
    log(`[타일 정합] 생략(폴백 모드) — tol=${tol}`);
  }

  // 정합 결과를 호스트에 전달(OCR + 표시용). RGBA로 변환해 넘긴다.
  const alignedRGBA = new Uint8ClampedArray(aligned.cols * aligned.rows * 4);
  {
    const g = aligned.data;
    for (let i = 0, n = g.length; i < n; i++) {
      const j = i * 4, v = g[i];
      alignedRGBA[j] = v; alignedRGBA[j + 1] = v; alignedRGBA[j + 2] = v;
      alignedRGBA[j + 3] = 255;
    }
  }
  // OCR은 호스트(메인 스레드/Node)에서 병렬로 돌고, 결과는 마지막에 회수한다.
  const ocrPromise = hooks.onAligned
    ? hooks.onAligned(alignedRGBA, aligned.cols, aligned.rows)
    : Promise.resolve(null);

  // ---------------------------------------------------------------- 3.3 이진화
  ts = now();
  progress("잉크 이진화");
  const normTest = flattenBackground(cv, aligned, cfg, ellipse);
  // aligned는 여기까지만 쓴다(RGBA 전달·배경 평탄화 완료) — 즉시 해제한다.
  // opencv.js의 wasm 힙은 1GB가 상한이고 대형 라벨(7000×6600 = 46MB/장)에서는
  // 죽은 Mat 하나가 뒤 단계의 할당 실패로 직결된다.
  aligned.delete();
  const refInk = inkMask(cv, ref, cfg);
  const testInk = inkMask(cv, normTest, cfg);
  mark("이진화", ts);

  // ---------------------------------------------------------------- 3.4 구조 diff
  ts = now();
  progress("구조 diff");
  const k = ellipse(tol);
  const open3 = ellipse(3);
  const rawExtra = andNotDilated(cv, testInk, refInk, k);
  const rawMissing = andNotDilated(cv, refInk, testInk, k);
  const extra = new cv.Mat(), missing = new cv.Mat();
  cv.morphologyEx(rawExtra, extra, cv.MORPH_OPEN, open3);
  cv.morphologyEx(rawMissing, missing, cv.MORPH_OPEN, open3);
  k.delete(); open3.delete();
  mark("diff", ts);

  // ---------------------------------------------------------------- 3.5 군집화
  ts = now();
  progress("군집화");
  const cbox = contentBBoxOf(cv, refInk);
  let extraComps = clusterComponents(cv, extra, rawExtra, normTest,
                                     cfg.extraMaxNorm, cfg, ref, cbox, rectK);
  let missingComps = clusterComponents(cv, missing, rawMissing, ref,
                                       cfg.missingMaxRef, cfg, ref, cbox, rectK);
  // open()한 마스크는 군집화까지만 쓴다 — 여기서 놓아준다(각 46MB).
  // 원시 마스크(rawExtra/rawMissing)는 바로 아래 리플로우 검사가 아직 쓴다.
  extra.delete(); missing.delete();
  mark("군집화", ts);

  // ---------------------------------------------------------------- 3.5b 리플로우 억제
  ts = now();
  progress("리플로우 검사");
  const rfScale = ref.cols / REF_BASE_WIDTH;
  const rfPad = Math.max(Math.round(cfg.reflowPad * rfScale), 16);
  const rfSx = Math.max(Math.round(cfg.reflowSearchX * rfScale), 20);
  const rfSy = Math.max(Math.round(cfg.reflowSearchY * rfScale), 40);
  const rfEx = Math.max(Math.round(cfg.reflowExclude * rfScale), 6);

  const e5 = ellipse(5);
  const refInkDil = new cv.Mat(), testInkDil = new cv.Mat();
  cv.dilate(refInk, refInkDil, e5);
  cv.dilate(testInk, testInkDil, e5);
  e5.delete();

  const isReflow = (src: Mat, dst: Mat, bbox: BBox,
                    diffMask: Mat, dstInkDil: Mat): boolean => {
    const [corr, dx, dy] = findShiftedMatch(cv, src, dst, bbox, rfPad,
                                            rfSx, rfSy, rfEx);
    if (corr < cfg.reflowMinCorr) return false;
    const [x, y, w, h] = bbox;
    const sub = matRect(cv, diffMask, x, y, w, h);
    const pts: [number, number][] = [];
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++)
        if (sub[yy * w + xx]) pts.push([xx, yy]);
    if (!pts.length) return true;
    const hh = dstInkDil.rows, ww = dstInkDil.cols;
    const d = dstInkDil.data;
    let covered = 0;
    for (const [xx, yy] of pts) {
      const cyy = Math.min(Math.max(yy + y + dy, 0), hh - 1);
      const cxx = Math.min(Math.max(xx + x + dx, 0), ww - 1);
      if (d[cyy * ww + cxx] > 0) covered++;
    }
    return covered / pts.length >= cfg.reflowMinCover;
  };

  const reflowBoxes: BBox[] = [];
  const splitReflow = (comps: Comp[], src: Mat, dst: Mat,
                       diffMask: Mat, dstInkDil: Mat): Comp[] => {
    const kept: Comp[] = [];
    for (const c of comps) {
      if (isReflow(src, dst, c.bbox, diffMask, dstInkDil)) reflowBoxes.push(c.bbox);
      else kept.push(c);
    }
    return kept;
  };

  const nExtraAll = extraComps.length, nMissingAll = missingComps.length;
  extraComps = splitReflow(extraComps, normTest, ref, rawExtra, refInkDil);
  missingComps = splitReflow(missingComps, ref, normTest, rawMissing, testInkDil);
  // 원시 diff 마스크는 여기까지 — 뒷비침 단계가 큰 버퍼를 잡기 전에 비워준다.
  rawExtra.delete(); rawMissing.delete();
  mark("리플로우", ts);

  const findings: WorkFinding[] = [];
  for (const c of extraComps)
    findings.push({ type: "extra", bbox: c.bbox, area: c.area, note: "" });
  for (const c of missingComps) {
    if (inMargin(c.bbox, ref, cfg.marginRatio))
      findings.push({ type: "trim_mark_expected", bbox: c.bbox, area: c.area,
                      severity: undefined,
                      note: "재단선/레지스터 마크 (TEST 재단 완료) — 정상" });
    else
      findings.push({ type: "missing", bbox: c.bbox, area: c.area, note: "" });
  }

  // ---------------------------------------------------------------- 3.6 뒷비침
  ts = now();
  progress("뒷비침 검출");
  const inkReflowBoxes = [...reflowBoxes];
  const overlapsReflow = ([x, y, w, h]: BBox): boolean => {
    for (const [rx, ry, rw, rh] of inkReflowBoxes) {
      const ix = Math.max(0, Math.min(x + w, rx + rw) - Math.max(x, rx));
      const iy = Math.max(0, Math.min(y + h, ry + rh) - Math.max(y, ry));
      if (ix * iy > 0.1 * w * h) return true;
    }
    return false;
  };
  // 이 단계는 결함을 새로 보고하지 않는다(뒷비침은 표시 대상이 아니고 리플로우
  // 주석에만 쓰인다). 그래서 메모리 부족 같은 이유로 실패하면 페이지 전체를
  // 실패시키지 말고 이 단계만 건너뛴다 — 결함 목록은 그대로 쓸 수 있다.
  let stComps: Comp[] = [];
  try {
    stComps = detectShowthrough(cv, normTest, ref, cfg, cbox, ellipse, rectK);
    stComps = splitReflow(stComps, normTest, ref, testInk, refInkDil);
    const stKept: Comp[] = [];
    for (const c of stComps) {
      if (overlapsReflow(c.bbox)) reflowBoxes.push(c.bbox);
      else stKept.push(c);
    }
    stComps = stKept;
    for (const c of stComps)
      findings.push({ type: "showthrough", bbox: c.bbox, area: c.area,
                      note: "뒷면 인쇄 비침(show-through) — 옅은 회색 고스트" });
  } catch (err) {
    stComps = [];
    log("[뒷비침] 건너뜀 — " + describeCvError(err) +
        " (결함 검출 결과에는 영향 없음)");
  }
  log(`[diff] extra ${extraComps.length}/${nExtraAll}, ` +
      `missing ${missingComps.length}/${nMissingAll}, ` +
      `showthrough ${stComps.length}, 리플로우 억제 ${reflowBoxes.length}건`);
  mark("뒷비침", ts);

  if (reflowBoxes.length) {
    const xs0 = Math.min(...reflowBoxes.map((b) => b[0]));
    const ys0 = Math.min(...reflowBoxes.map((b) => b[1]));
    const xs1 = Math.max(...reflowBoxes.map((b) => b[0] + b[2]));
    const ys1 = Math.max(...reflowBoxes.map((b) => b[1] + b[3]));
    findings.push({
      type: "layout_reflow", severity: "expected",
      bbox: [xs0, ys0, xs1 - xs0, ys1 - ys0],
      area: reflowBoxes.reduce((s, b) => s + b[2] * b[3], 0),
      note: `개정 줄 밀림(reflow) 영역 ${reflowBoxes.length}건 — 동일 내용이 ` +
            "국소 이동만 된 것으로 결함 아님. 문구 변경 자체는 " +
            "text_mismatch로 별도 보고됨",
    });
  }

  // ---------------------------------------------------------------- 3.7 OCR
  ts = now();
  progress("OCR 결과 대기");
  let refWords: Word[] = [];
  let revLines: BBox[] = [];
  const ocr = await ocrPromise; // {refWords, testWords} | null
  if (ocr) {
    refWords = ocr.refWords;
    log(`[OCR] REF ${ocr.refWords.length}단어, TEST ${ocr.testWords.length}단어`);
    revLines = lineBoxesWith(refWords, "REV");
    for (const mm of textMismatches(ocr.refWords, ocr.testWords)) {
      if (!pixelCorroborated(cv, mm, refInk, testInk, ellipse)) continue;
      const rfArgs: [Mat, Mat, Mat, Mat] = mm.tag === "delete"
        ? [ref, normTest, refInk, testInkDil]
        : [normTest, ref, testInk, refInkDil];
      if (isReflow(rfArgs[0], rfArgs[1], mm.bbox, rfArgs[2], rfArgs[3])) continue;
      findings.push({
        type: "text_mismatch", bbox: mm.bbox,
        area: mm.bbox[2] * mm.bbox[3],
        note: `OCR 불일치: '${mm.refText}' → '${mm.testText}'`,
      });
    }
  }
  mark("OCR 대조", ts);

  // ---------------------------------------------------------------- 3.8 심각도
  ts = now();
  progress("심각도 분류");
  const boxMask = ruledBoxMask(cv, refInk, rectK, ellipse);
  for (const f of findings) {
    f.severity = classifySeverity(f, refWords, revLines, boxMask);
    f.nearText = nearestText(f.bbox, refWords);
    if (!f.note) {
      if (f.type === "extra") {
        f.note = "TEST에만 존재하는 잉여 잉크";
        if (f.severity === "critical") f.note += " — 문서번호/개정(REV) 행 침범";
        else if (f.severity === "major") f.note += " — 글자/괘선 영역 침범";
      } else if (f.type === "missing") {
        f.note = "REF 대비 잉크 누락";
      }
    }
  }
  // 화면에 표시되는 결함(억제·뒷비침·expected 제외)이 1..N 연속 번호가 되도록
  // 표시 대상을 먼저 배치한 뒤 번호를 부여한다.
  {
    const textBoxes2 = findings
      .filter((f) => f.type === "text_mismatch").map((f) => f.bbox);
    const isDup = (f: WorkFinding) =>
      (f.type === "extra" || f.type === "missing") &&
      textBoxes2.some((t) => boxesIntersect(f.bbox, t));
    const byPos = (a: WorkFinding, b: WorkFinding) =>
      a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
    const shown = findings
      .filter((f) => f.severity !== "expected" && f.type !== "showthrough" && !isDup(f))
      .sort(byPos);
    const shownSet = new Set(shown);
    const rest = findings.filter((f) => !shownSet.has(f)).sort(byPos);
    findings.length = 0;
    findings.push(...shown, ...rest);
  }
  findings.forEach((f, i) => (f.id = i + 1));
  boxMask.delete();
  mark("심각도", ts);

  // aligned·diff 마스크는 위에서 이미 해제했다(대형 라벨 메모리 대책).
  [ref, normTest, refInk, testInk, refInkDil, testInkDil]
    .forEach((m) => m.delete());

  const total = Math.round(now() - t0);
  log(`[완료] ${(total / 1000).toFixed(1)}s`);
  return {
    findings: findings.map((f): Finding => ({
      id: f.id!, type: f.type, severity: f.severity!,
      bbox_ref: f.bbox.map((v) => Math.trunc(v)),
      area_px: Math.trunc(f.area), near_text: f.nearText || "", note: f.note,
    })),
    timings, totalMs: total,
  };
}

// --------------------------------------------------------------------------
// 3.1 전역 정합
// --------------------------------------------------------------------------
function globalAlign(cv: CV, ref: Mat, test: Mat, cfg: PipelineConfig,
                     log: (m: string) => void): Mat {
  const down = (img: Mat): [Mat, number, boolean] => {
    const s = cfg.downscaleLong / Math.max(img.rows, img.cols);
    if (s >= 1.0) return [img, 1.0, false];
    const small = new cv.Mat();
    cv.resize(img, small, new cv.Size(0, 0), s, s, cv.INTER_AREA);
    return [small, s, true];
  };
  const [refS, sRef, refOwned] = down(ref);
  const [testS, sTest, testOwned] = down(test);

  const orb = new cv.ORB(cfg.orbFeatures);
  const noMask = new cv.Mat();
  const kpR = new cv.KeyPointVector(), desR = new cv.Mat();
  const kpT = new cv.KeyPointVector(), desT = new cv.Mat();
  orb.detectAndCompute(refS, noMask, kpR, desR);
  orb.detectAndCompute(testS, noMask, kpT, desT);
  if (!desR.rows || !desT.rows)
    throw new Error("[에러] ORB 특징점 추출 실패 — 이미지 내용을 확인하세요.");

  const matcher = new cv.BFMatcher(cv.NORM_HAMMING);
  const knn = new cv.DMatchVectorVector();
  matcher.knnMatch(desT, desR, knn, 2);
  const good: Array<{ queryIdx: number; trainIdx: number; distance: number }> = [];
  for (let i = 0; i < knn.size(); i++) {
    const pair = knn.get(i);
    if (pair.size() === 2) {
      const m = pair.get(0), n = pair.get(1);
      if (m.distance < cfg.loweRatio * n.distance) good.push(m);
    }
  }
  if (good.length < 4)
    throw new Error(`[에러] 매칭 부족(good=${good.length}) — 정합 불가.`);

  const src = new cv.Mat(good.length, 1, cv.CV_32FC2);
  const dst = new cv.Mat(good.length, 1, cv.CV_32FC2);
  good.forEach((m, i) => {
    const pt = kpT.get(m.queryIdx).pt, pr = kpR.get(m.trainIdx).pt;
    src.data32F[i * 2] = pt.x / sTest;
    src.data32F[i * 2 + 1] = pt.y / sTest;
    dst.data32F[i * 2] = pr.x / sRef;
    dst.data32F[i * 2 + 1] = pr.y / sRef;
  });

  const inlierMask = new cv.Mat();
  const H = cv.findHomography(src, dst, cv.RANSAC, cfg.ransacThresh, inlierMask);
  if (H.empty()) throw new Error("[에러] homography 추정 실패.");
  let inliers = 0;
  for (let i = 0; i < inlierMask.rows; i++) if (inlierMask.data[i]) inliers++;

  const Hd = H.data64F;
  const h22 = Hd[8];
  const sx = Math.hypot(Hd[0] / h22, Hd[3] / h22);
  const sy = Math.hypot(Hd[1] / h22, Hd[4] / h22);
  const [lo, hi] = cfg.scaleRange;
  if (inliers < cfg.minInliers)
    throw new Error(`[에러] 전역 정합 검증 실패: inlier=${inliers} ` +
                    `(< ${cfg.minInliers}). 입력 이미지 쌍이 동일 아트웍인지 확인하세요.`);
  if (!(lo <= sx && sx <= hi && lo <= sy && sy <= hi))
    throw new Error(`[에러] 전역 정합 검증 실패: 스케일 성분 sx=${sx.toFixed(3)}, ` +
                    `sy=${sy.toFixed(3)} (허용 ${lo}~${hi}).`);
  log(`[정합] good match ${good.length}, inlier ${inliers}, ` +
      `scale (${sx.toFixed(3)}, ${sy.toFixed(3)})`);

  const aligned = new cv.Mat();
  cv.warpPerspective(test, aligned, H, new cv.Size(ref.cols, ref.rows),
                     cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255));

  [noMask, kpR, desR, kpT, desT, knn, src, dst, inlierMask, H].forEach((m) => m.delete());
  orb.delete(); matcher.delete();
  if (refOwned) refS.delete();
  if (testOwned) testS.delete();
  return aligned;
}

// --------------------------------------------------------------------------
// 3.2 타일 정밀 정합 — phaseCorrelate를 DFT로 직접 구현
// --------------------------------------------------------------------------
function phaseCorrelateDFT(cv: CV, aArr: Float32Array, bArr: Float32Array,
                           n: number): [number, number, number] {
  // aArr/bArr: n×n Float32(윈도 적용 완료). 반환 [dx, dy, response].
  const A = new cv.Mat(n, n, cv.CV_32FC2);
  const B = new cv.Mat(n, n, cv.CV_32FC2);
  const ad = A.data32F, bd = B.data32F;
  for (let i = 0; i < n * n; i++) {
    ad[i * 2] = aArr[i]; ad[i * 2 + 1] = 0;
    bd[i * 2] = bArr[i]; bd[i * 2 + 1] = 0;
  }
  cv.dft(A, A, 0, 0);
  cv.dft(B, B, 0, 0);
  // C = A·conj(B) / |A·conj(B)|
  for (let i = 0; i < n * n; i++) {
    const ar = ad[i * 2], ai = ad[i * 2 + 1];
    const br = bd[i * 2], bi = bd[i * 2 + 1];
    const re = ar * br + ai * bi;
    const im = ai * br - ar * bi;
    const mag = Math.hypot(re, im) + 1e-12;
    ad[i * 2] = re / mag; ad[i * 2 + 1] = im / mag;
  }
  cv.dft(A, A, cv.DFT_INVERSE | cv.DFT_SCALE, 0);
  // 실수부 피크 탐색
  let peak = -Infinity, pi = 0, pj = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = ad[(y * n + x) * 2];
      if (v > peak) { peak = v; pi = y; pj = x; }
    }
  // 3×3 가중 중심(모듈러)으로 서브픽셀 보정
  let sw = 0, sx = 0, sy = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const yy = (pi + dy + n) % n, xx = (pj + dx + n) % n;
      const v = Math.max(ad[(yy * n + xx) * 2], 0);
      sw += v; sx += v * dx; sy += v * dy;
    }
  const px = pj + (sw ? sx / sw : 0);
  const py = pi + (sw ? sy / sw : 0);
  // 랩어라운드: 피크 위치 p는 -shift mod n
  const wrap = (v: number) => (v > n / 2 ? v - n : v);
  A.delete(); B.delete();
  return [-wrap(px), -wrap(py), peak];
}

function tileRefine(cv: CV, ref: Mat, aligned: Mat, cfg: PipelineConfig,
                    log: (m: string) => void): Mat {
  const h = ref.rows, w = ref.cols;
  const tile = cfg.tile, stride = tile - cfg.overlap;
  const xs: number[] = [], ys: number[] = [];
  for (let x = 0; x <= Math.max(w - tile, 0); x += stride) xs.push(x);
  if (xs[xs.length - 1] !== w - tile) xs.push(w - tile);
  for (let y = 0; y <= Math.max(h - tile, 0); y += stride) ys.push(y);
  if (ys[ys.length - 1] !== h - tile) ys.push(h - tile);

  // Hanning 윈도 (numpy.hanning과 동일: cos 기반, 끝점 0)
  const hann = new Float32Array(tile);
  for (let i = 0; i < tile; i++)
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (tile - 1));

  const ny = ys.length, nx = xs.length;
  const dxg = new Float64Array(ny * nx);
  const dyg = new Float64Array(ny * nx);
  const valid = new Uint8Array(ny * nx);
  const refData = ref.data, alData = aligned.data;
  const aArr = new Float32Array(tile * tile);
  const bArr = new Float32Array(tile * tile);

  const shifts: number[] = [];
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const y0 = ys[i], x0 = xs[j];
      for (let ty = 0; ty < tile; ty++) {
        const ro = (y0 + ty) * w + x0, wy = hann[ty];
        for (let tx = 0; tx < tile; tx++) {
          const win = wy * hann[tx];
          aArr[ty * tile + tx] = refData[ro + tx] * win;
          bArr[ty * tile + tx] = alData[ro + tx] * win;
        }
      }
      const [dx, dy, resp] = phaseCorrelateDFT(cv, aArr, bArr, tile);
      if (resp >= cfg.minResponse && Math.hypot(dx, dy) <= cfg.maxShift) {
        dxg[i * nx + j] = dx; dyg[i * nx + j] = dy;
        valid[i * nx + j] = 1;
        shifts.push(Math.hypot(dx, dy));
      }
    }
  }
  const nValid = shifts.length;
  if (!nValid) {
    log("[타일 정합] 유효 타일 없음 — 정밀 정합 생략");
    return aligned;
  }
  shifts.sort((a, b) => a - b);
  log(`[타일 정합] ${ny * nx}개 타일 중 유효 ${nValid}개, ` +
      `|shift| 중앙값 ${shifts[Math.floor(nValid / 2)].toFixed(2)}px`);

  fillInvalid(dxg, valid.slice(), ny, nx);
  fillInvalid(dyg, valid, ny, nx);

  const cxs = xs.map((x) => x + tile / 2);
  const cys = ys.map((y) => y + tile / 2);
  // 격자 행별 x방향 보간 테이블 (ny×w)
  const rowsDx: Float32Array[] = [], rowsDy: Float32Array[] = [];
  for (let i = 0; i < ny; i++) {
    rowsDx.push(interpRow(dxg.subarray(i * nx, (i + 1) * nx), cxs, w));
    rowsDy.push(interpRow(dyg.subarray(i * nx, (i + 1) * nx), cxs, w));
  }

  // 스트립 단위 remap (map 전체를 한 번에 만들면 float 316MB — 메모리 절약)
  const refined = new cv.Mat(h, w, cv.CV_8UC1);
  const stripH = 1024;
  for (let y0 = 0; y0 < h; y0 += stripH) {
    const sh = Math.min(stripH, h - y0);
    const mapX = new cv.Mat(sh, w, cv.CV_32FC1);
    const mapY = new cv.Mat(sh, w, cv.CV_32FC1);
    const mx = mapX.data32F, my = mapY.data32F;
    for (let y = 0; y < sh; y++) {
      const gy = y0 + y;
      let r0 = 0, r1 = 0, wgt = 0;
      if (ny > 1) {
        let i1 = searchSorted(cys, gy);
        i1 = Math.min(Math.max(i1, 1), ny - 1);
        r0 = i1 - 1; r1 = i1;
        wgt = Math.min(Math.max((gy - cys[r0]) / (cys[r1] - cys[r0]), 0), 1);
      }
      const rowDx0 = rowsDx[r0], rowDx1 = rowsDx[r1];
      const rowDy0 = rowsDy[r0], rowDy1 = rowsDy[r1];
      const o = y * w;
      for (let x = 0; x < w; x++) {
        mx[o + x] = x + rowDx0[x] * (1 - wgt) + rowDx1[x] * wgt;
        my[o + x] = gy + rowDy0[x] * (1 - wgt) + rowDy1[x] * wgt;
      }
    }
    const dstRoi = refined.roi(new cv.Rect(0, y0, w, sh));
    cv.remap(aligned, dstRoi, mapX, mapY, cv.INTER_LINEAR,
             cv.BORDER_CONSTANT, new cv.Scalar(255));
    dstRoi.delete(); mapX.delete(); mapY.delete();
  }
  aligned.delete();
  return refined;
}

function fillInvalid(grid: Float64Array, valid: Uint8Array,
                     ny: number, nx: number): void {
  for (let iter = 0; iter < Math.max(ny, nx); iter++) {
    let allValid = true;
    for (let i = 0; i < ny * nx; i++) if (!valid[i]) { allValid = false; break; }
    if (allValid) break;
    const newGrid = grid.slice(), newValid = valid.slice();
    for (let i = 0; i < ny; i++)
      for (let j = 0; j < nx; j++) {
        if (valid[i * nx + j]) continue;
        const neigh: number[] = [];
        for (let di = -1; di <= 1; di++)
          for (let dj = -1; dj <= 1; dj++) {
            const ii = i + di, jj = j + dj;
            if (ii >= 0 && ii < ny && jj >= 0 && jj < nx && valid[ii * nx + jj])
              neigh.push(grid[ii * nx + jj]);
          }
        if (neigh.length) {
          neigh.sort((a, b) => a - b);
          const m = neigh.length % 2
            ? neigh[(neigh.length - 1) / 2]
            : (neigh[neigh.length / 2 - 1] + neigh[neigh.length / 2]) / 2;
          newGrid[i * nx + j] = m;
          newValid[i * nx + j] = 1;
        }
      }
    grid.set(newGrid); valid.set(newValid);
  }
  for (let i = 0; i < ny * nx; i++) if (!valid[i]) grid[i] = 0;
}

function interpRow(vals: Float64Array, cxs: number[], w: number): Float32Array {
  const out = new Float32Array(w);
  const n = cxs.length;
  let j = 0;
  for (let x = 0; x < w; x++) {
    if (x <= cxs[0]) { out[x] = vals[0]; continue; }
    if (x >= cxs[n - 1]) { out[x] = vals[n - 1]; continue; }
    while (j < n - 2 && cxs[j + 1] < x) j++;
    const t = (x - cxs[j]) / (cxs[j + 1] - cxs[j]);
    out[x] = vals[j] * (1 - t) + vals[j + 1] * t;
  }
  return out;
}

function searchSorted(arr: number[], v: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// --------------------------------------------------------------------------
// 3.3 이진화
// --------------------------------------------------------------------------
function flattenBackground(cv: CV, img: Mat, cfg: PipelineConfig,
                           ellipse: (k: number) => Mat): Mat {
  // close(81)의 저주파 근사: 1/2 축소 → close(41) → 확대. 풀해상도 close(81)는
  // wasm 단일 스레드에서 66초가 걸려 불가(1/2 축소는 4초대, 결과 근사 우수).
  const small = new cv.Mat();
  cv.resize(img, small, new cv.Size(0, 0), 0.5, 0.5, cv.INTER_AREA);
  const kSmall = ellipse(Math.max(3, Math.round(cfg.bgKernel / 2)) | 1);
  const bgSmall = new cv.Mat();
  cv.morphologyEx(small, bgSmall, cv.MORPH_CLOSE, kSmall);
  const bg = new cv.Mat();
  cv.resize(bgSmall, bg, new cv.Size(img.cols, img.rows), 0, 0, cv.INTER_LINEAR);
  const out = new cv.Mat();
  cv.divide(img, bg, out, 255, -1);
  small.delete(); kSmall.delete(); bgSmall.delete(); bg.delete();
  return out;
}

function inkMask(cv: CV, gray: Mat, cfg: PipelineConfig): Mat {
  const out = new cv.Mat();
  cv.adaptiveThreshold(gray, out, 255, cv.ADAPTIVE_THRESH_MEAN_C,
                       cv.THRESH_BINARY_INV, cfg.threshBlock, cfg.threshC);
  return out;
}

// --------------------------------------------------------------------------
// 3.4 구조 diff
// --------------------------------------------------------------------------
function andNotDilated(cv: CV, a: Mat, b: Mat, kernel: Mat): Mat {
  // a AND NOT dilate(b)
  const dil = new cv.Mat(), inv = new cv.Mat(), out = new cv.Mat();
  cv.dilate(b, dil, kernel);
  cv.bitwise_not(dil, inv);
  cv.bitwise_and(a, inv, out);
  dil.delete(); inv.delete();
  return out;
}

// --------------------------------------------------------------------------
// 3.5 군집화 / 필터링
// --------------------------------------------------------------------------
function matRect(cv: CV, mat: Mat, x: number, y: number,
                 w: number, h: number): Uint8Array {
  // 사각 영역을 연속 버퍼로 복사해 반환
  const roi = mat.roi(new cv.Rect(x, y, w, h));
  const c = roi.clone();
  const data = new Uint8Array(c.data);
  roi.delete(); c.delete();
  return data;
}

function contentBBoxOf(cv: CV, refInk: Mat): [number, number, number, number] {
  const colMax = new cv.Mat(), rowMax = new cv.Mat();
  cv.reduce(refInk, colMax, 0, cv.REDUCE_MAX, -1);
  cv.reduce(refInk, rowMax, 1, cv.REDUCE_MAX, -1);
  const cm = colMax.data, rm = rowMax.data;
  let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
  for (let x = 0; x < cm.length; x++) if (cm[x]) { if (x0 < 0) x0 = x; x1 = x; }
  for (let y = 0; y < rm.length; y++) if (rm[y]) { if (y0 < 0) y0 = y; y1 = y; }
  colMax.delete(); rowMax.delete();
  if (x0 < 0) return [0, 0, refInk.cols, refInk.rows];
  return [x0, y0, x1 + 1, y1 + 1];
}

function clusterComponents(cv: CV, diff: Mat, rawDiff: Mat, graySrc: Mat,
                           maxGray: number, cfg: PipelineConfig, ref: Mat,
                           cbox: [number, number, number, number],
                           rectK: (kw: number, kh: number) => Mat): Comp[] {
  const w = ref.cols;
  const minArea = cfg.minArea * (w / REF_BASE_WIDTH) ** 2;
  // 병합 dilate: rect 커널 근사(분리 가능). bbox는 실제 diff 픽셀로 재계산되므로
  // 병합 반경의 모서리 차이는 결과에 거의 영향 없음.
  const kMerge = rectK(cfg.mergeKernel, cfg.mergeKernel);
  const merged = new cv.Mat();
  cv.dilate(diff, merged, kMerge);
  kMerge.delete();
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(merged, labels, stats, cents, 8, cv.CV_32S);
  merged.delete(); labels.delete(); cents.delete();
  const [cx0, cy0, cx1, cy1] = cbox;
  const grayData = graySrc.data, rawData = rawDiff.data, diffData = diff.data;
  const out: Comp[] = [];
  for (let i = 1; i < n; i++) {
    const x = stats.data32S[i * 5], y = stats.data32S[i * 5 + 1];
    const bw = stats.data32S[i * 5 + 2], bh = stats.data32S[i * 5 + 3];
    // 원시 diff 픽셀 수 (병합 팽창분 제외)
    let area = 0;
    for (let yy = y; yy < y + bh; yy++) {
      const o = yy * w;
      for (let xx = x; xx < x + bw; xx++) if (rawData[o + xx]) area++;
    }
    if (area < minArea) continue;
    if (x + bw < cx0 || x > cx1 || y + bh < cy0 || y > cy1) continue;
    // diff(open 후) 마스크 픽셀 위치와 평균 밝기, 타이트 bbox
    let sum = 0, cnt = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let yy = y; yy < y + bh; yy++) {
      const o = yy * w;
      for (let xx = x; xx < x + bw; xx++) {
        if (diffData[o + xx]) {
          sum += grayData[o + xx]; cnt++;
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
    if (!cnt) continue;
    if (sum / cnt > maxGray) continue;
    out.push({ bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1], area });
  }
  stats.delete();
  return out;
}

function inMargin([x, y, bw, bh]: BBox, ref: Mat, ratio: number): boolean {
  const h = ref.rows, w = ref.cols;
  const mx = w * ratio, my = h * ratio;
  return x + bw <= mx || x >= w - mx || y + bh <= my || y >= h - my;
}

// --------------------------------------------------------------------------
// 3.5b 리플로우 — 문맥 포함 템플릿 매칭
// --------------------------------------------------------------------------
function findShiftedMatch(cv: CV, src: Mat, dst: Mat, bbox: BBox, pad: number,
                          searchX: number, searchY: number,
                          excludeR: number): [number, number, number] {
  const [x, y, w, h] = bbox;
  const hh = src.rows, ww = src.cols;
  const tx0 = Math.max(x - pad, 0), ty0 = Math.max(y - pad, 0);
  const tx1 = Math.min(x + w + pad, ww), ty1 = Math.min(y + h + pad, hh);
  if (Math.min(tx1 - tx0, ty1 - ty0) < 8) return [-1.0, 0, 0];
  const wx0 = Math.max(tx0 - searchX, 0), wy0 = Math.max(ty0 - searchY, 0);
  const wx1 = Math.min(tx1 + searchX, ww), wy1 = Math.min(ty1 + searchY, hh);
  if (wy1 - wy0 < ty1 - ty0 || wx1 - wx0 < tx1 - tx0) return [-1.0, 0, 0];

  const tmpl = src.roi(new cv.Rect(tx0, ty0, tx1 - tx0, ty1 - ty0));
  const win = dst.roi(new cv.Rect(wx0, wy0, wx1 - wx0, wy1 - wy0));
  const res = new cv.Mat();
  cv.matchTemplate(win, tmpl, res, cv.TM_CCOEFF_NORMED);
  tmpl.delete(); win.delete();

  const zj = tx0 - wx0, zi = ty0 - wy0;
  if (excludeR > 0) {
    const i0 = Math.max(zi - excludeR, 0), i1 = Math.min(zi + excludeR + 1, res.rows);
    const j0 = Math.max(zj - excludeR, 0), j1 = Math.min(zj + excludeR + 1, res.cols);
    for (let i = i0; i < i1; i++)
      for (let j = j0; j < j1; j++) res.data32F[i * res.cols + j] = -1.0;
  }
  const mm = cv.minMaxLoc(res);
  res.delete();
  return [mm.maxVal, mm.maxLoc.x - zj, mm.maxLoc.y - zi];
}

// --------------------------------------------------------------------------
// 3.6 뒷비침
// --------------------------------------------------------------------------
function detectShowthrough(cv: CV, normTest: Mat, ref: Mat, cfg: PipelineConfig,
                           cbox: [number, number, number, number],
                           ellipse: (k: number) => Mat,
                           rectK: (kw: number, kh: number) => Mat): Comp[] {
  // 전 과정을 전체 크기 버퍼 3장(band·below·refWhite)으로 끝낸다. 대형 라벨은
  // 한 장이 46MB라, 예전처럼 6장을 동시에 들면 1GB wasm 힙에서 뒤 단계의
  // connectedComponents(CV_32S 라벨 = 4바이트/px)가 할당에 실패한다.
  const band = new cv.Mat(), below = new cv.Mat();
  cv.medianBlur(normTest, band, cfg.ghostBlur);
  // inRange(lo+1, bandHi) = (>lo) AND (<=bandHi)
  cv.threshold(band, below, cfg.ghostBandHi, 255, cv.THRESH_BINARY_INV);
  cv.threshold(band, band, cfg.ghostLo, 255, cv.THRESH_BINARY); // 제자리
  cv.bitwise_and(band, below, band);
  below.delete();

  const refWhite = new cv.Mat();
  const eK = ellipse(cfg.ghostRefErode);
  cv.erode(ref, refWhite, eK);
  cv.threshold(refWhite, refWhite, cfg.ghostRefWhite, 255, cv.THRESH_BINARY);
  eK.delete();

  const ghost = band; // band를 그대로 결과 버퍼로 재사용
  cv.bitwise_and(band, refWhite, ghost);
  refWhite.delete();
  const o3 = ellipse(3);
  cv.morphologyEx(ghost, ghost, cv.MORPH_OPEN, o3);
  o3.delete();

  const kMerge = rectK(cfg.ghostMerge, cfg.ghostMerge);
  const merged = new cv.Mat();
  cv.dilate(ghost, merged, kMerge);
  kMerge.delete();
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(merged, labels, stats, cents, 8, cv.CV_32S);
  merged.delete(); labels.delete(); cents.delete();

  const [cx0, cy0, cx1, cy1] = cbox;
  const w = ghost.cols;
  const gd = ghost.data;
  const out: Comp[] = [];
  for (let i = 1; i < n; i++) {
    const x = stats.data32S[i * 5], y = stats.data32S[i * 5 + 1];
    const bw = stats.data32S[i * 5 + 2], bh = stats.data32S[i * 5 + 3];
    let area = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let yy = y; yy < y + bh; yy++) {
      const o = yy * w;
      for (let xx = x; xx < x + bw; xx++)
        if (gd[o + xx]) {
          area++;
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
    }
    if (area <= cfg.ghostMinArea) continue;
    if (x + bw < cx0 || x > cx1 || y + bh < cy0 || y > cy1) continue;
    out.push({ bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1], area });
  }
  stats.delete(); ghost.delete();
  return out;
}

// --------------------------------------------------------------------------
// 3.7 OCR 픽셀 대조
// --------------------------------------------------------------------------
function pixelCorroborated(cv: CV, mm: { bbox: BBox; tag: string },
                           refInk: Mat, testInk: Mat,
                           ellipse: (k: number) => Mat, pad = 10): boolean {
  const [x, y, w, h] = mm.bbox;
  const hh = refInk.rows, ww = refInk.cols;
  const x0 = Math.max(x - pad, 0), y0 = Math.max(y - pad, 0);
  const x1 = Math.min(x + w + pad, ww), y1 = Math.min(y + h + pad, hh);
  if (x1 <= x0 || y1 <= y0) return false;
  const rect = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
  const rRoi = refInk.roi(rect), tRoi = testInk.roi(rect);
  const r = rRoi.clone(), t = tRoi.clone();
  rRoi.delete(); tRoi.delete();
  const rn = cv.countNonZero(r), tn = cv.countNonZero(t);
  let result: boolean;
  if (mm.tag === "delete") result = tn < 0.5 * rn;
  else if (mm.tag === "insert") result = rn < 0.5 * tn;
  else {
    const k3 = ellipse(3);
    const a = andNotDilated(cv, t, r, k3);
    const b = andNotDilated(cv, r, t, k3);
    const ev = cv.countNonZero(a) + cv.countNonZero(b);
    a.delete(); b.delete(); k3.delete();
    result = ev >= 0.05 * Math.max(rn, 1);
  }
  r.delete(); t.delete();
  return result;
}

// --------------------------------------------------------------------------
// 3.8 심각도
// --------------------------------------------------------------------------
function lineBoxesWith(refWords: Word[], token: string): BBox[] {
  const lines = new Map<string, BBox[]>();
  const hits = new Set<string>();
  const tok = token.toLowerCase();
  for (const w of refWords) {
    const key = w.line.join(",");
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key)!.push(w.bbox);
    if (w.text.toLowerCase().includes(tok)) hits.add(key);
  }
  const out: BBox[] = [];
  for (const key of hits) {
    const boxes = lines.get(key)!;
    const xs = boxes.map((b) => b[0]), ys = boxes.map((b) => b[1]);
    const x2 = boxes.map((b) => b[0] + b[2]), y2 = boxes.map((b) => b[1] + b[3]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    out.push([minX, minY, Math.max(...x2) - minX, Math.max(...y2) - minY]);
  }
  return out;
}

function boxesIntersect([ax, ay, aw, ah]: BBox, [bx, by, bw, bh]: BBox): boolean {
  return !(ax + aw < bx || bx + bw < ax || ay + ah < by || by + bh < ay);
}

function ruledBoxMask(cv: CV, refInk: Mat,
                      rectK: (kw: number, kh: number) => Mat,
                      ellipse: (k: number) => Mat): Mat {
  const kh = rectK(101, 1), kv = rectK(1, 101);
  const horiz = new cv.Mat(), vert = new cv.Mat(), lines = new cv.Mat();
  cv.morphologyEx(refInk, horiz, cv.MORPH_OPEN, kh);
  cv.morphologyEx(refInk, vert, cv.MORPH_OPEN, kv);
  cv.bitwise_or(horiz, vert, lines);
  const e5 = ellipse(5);
  cv.dilate(lines, lines, e5);
  kh.delete(); kv.delete(); horiz.delete(); vert.delete(); e5.delete();

  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(lines, labels, stats, cents, 8, cv.CV_32S);
  lines.delete(); labels.delete(); cents.delete();
  const mask = cv.Mat.zeros(refInk.rows, refInk.cols, cv.CV_8UC1);
  for (let i = 1; i < n; i++) {
    const x = stats.data32S[i * 5], y = stats.data32S[i * 5 + 1];
    const w = stats.data32S[i * 5 + 2], h = stats.data32S[i * 5 + 3];
    if (w > 300 && h > 300) {
      const roi = mask.roi(new cv.Rect(x, y, w, h));
      roi.setTo(new cv.Scalar(255));
      roi.delete();
    }
  }
  stats.delete();
  return mask;
}

function classifySeverity(f: WorkFinding, refWords: Word[],
                          revLines: BBox[], boxMask: Mat): string {
  if (f.type === "trim_mark_expected" || f.type === "layout_reflow")
    return "expected";
  if (f.type === "text_mismatch") return "critical";
  for (const lb of revLines) if (boxesIntersect(f.bbox, lb)) return "critical";
  for (const w of refWords) if (boxesIntersect(f.bbox, w.bbox)) return "major";
  if (f.type === "showthrough") return "major";
  const [x, y, bw, bh] = f.bbox;
  const cx = Math.min(Math.max(x + (bw >> 1), 0), boxMask.cols - 1);
  const cy = Math.min(Math.max(y + (bh >> 1), 0), boxMask.rows - 1);
  if (boxMask.data[cy * boxMask.cols + cx]) return "major";
  return "minor";
}

function nearestText(bbox: BBox, refWords: Word[], k = 3): string {
  if (!refWords.length) return "";
  const [x, y, w, h] = bbox;
  const cx = x + w / 2, cy = y + h / 2;
  const scored = refWords
    .map((wd) => ({
      wd,
      d: (wd.bbox[0] + wd.bbox[2] / 2 - cx) ** 2 +
         (wd.bbox[1] + wd.bbox[3] / 2 - cy) ** 2,
    }))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, k).map((s) => s.wd.text).join(" ");
}

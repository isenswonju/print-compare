// 다중 샘플 검출 — 인쇄물 스캔 한 장에 같은 라벨 샘플이 여러 개 붙어 있을 때,
// 원본(REF)이 나타나는 위치들을 찾아 각 샘플의 크롭 영역을 돌려준다.
// 각 크롭은 기존 파이프라인(runPipeline)에 "1:1 페이지쌍"으로 들어가므로
// 이 모듈은 패리티(Python 대조) 대상이 아니다 — 웹 전용 전처리다.
//
// 방식: 축소본에서 템플릿 매칭(TM_CCOEFF_NORMED). 같은 샘플이 여러 개면
// 특징점 매칭(ORB)은 서로 같은 후보들 사이에서 비율 검정이 무너지므로
// 템플릿 매칭이 이 용도엔 더 강건하고 결정론적이다.
//  · REF/TEST는 600dpi 동급 스케일 전제(엔진의 scaleRange 0.9~1.1과 동일 계약)
//  · 스캐너에 뒤집거나 돌려 놓은 샘플(90/180/270°)도 잡는다 — 크롭은 돌리지
//    않고 그대로 넘긴다(엔진의 전역 정합이 회전을 흡수한다)
import type { CV, ImageDataLike, Mat } from "../types.ts";

export interface InstanceRect {
  x: number; y: number; w: number; h: number;
  score: number;          // 매칭 점수(0~1)
  rot: 0 | 90 | 180 | 270; // 매칭된 방향(정보용)
}

// 축소본에서 REF 최장변을 이 크기로 맞춘다 — 속도/정밀도 절충.
const TMPL_MAX_DIM = 320;
// 이 점수 미만의 피크는 샘플로 보지 않는다(배경·부분 겹침 배제).
const MIN_SCORE = 0.55;
// 안전 상한 — 스캔 한 장에 이보다 많은 샘플은 비현실적(오탐 폭주 방지).
const MAX_INSTANCES = 16;
// 크롭 여유 — 정합이 흡수할 수 있게 검출 박스를 사방으로 조금 넓힌다.
const CROP_MARGIN = 0.04;

function toGraySmall(cv: CV, img: ImageDataLike, scale: number): Mat {
  const rgba = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  rgba.data.set(img.data);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  if (scale >= 1) return gray;
  const small = new cv.Mat();
  cv.resize(gray, small, new cv.Size(
    Math.max(1, Math.round(img.width * scale)),
    Math.max(1, Math.round(img.height * scale))), 0, 0, cv.INTER_AREA);
  gray.delete();
  return small;
}

function rotate(cv: CV, m: Mat, rot: 90 | 180 | 270): Mat {
  const out = new cv.Mat();
  const code = rot === 90 ? cv.ROTATE_90_CLOCKWISE
    : rot === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
  cv.rotate(m, out, code);
  return out;
}

interface Peak { x: number; y: number; w: number; h: number;
                 score: number; rot: 0 | 90 | 180 | 270 }

// 한 방향의 매칭 결과에서 피크들을 뽑는다 — 최고점을 취하고 그 주변(템플릿
// 절반 크기)을 지운 뒤 반복. 결정론적(minMaxLoc은 항상 같은 위치를 준다).
function peaksOf(cv: CV, test: Mat, tmpl: Mat,
                 rot: 0 | 90 | 180 | 270): Peak[] {
  if (tmpl.cols > test.cols || tmpl.rows > test.rows) return [];
  const res = new cv.Mat();
  cv.matchTemplate(test, tmpl, res, cv.TM_CCOEFF_NORMED);
  const out: Peak[] = [];
  const supW = Math.max(1, Math.round(tmpl.cols / 2));
  const supH = Math.max(1, Math.round(tmpl.rows / 2));
  for (let i = 0; i < MAX_INSTANCES; i++) {
    const { maxVal, maxLoc } = cv.minMaxLoc(res);
    if (maxVal < MIN_SCORE) break;
    out.push({ x: maxLoc.x, y: maxLoc.y, w: tmpl.cols, h: tmpl.rows,
               score: maxVal, rot });
    // 피크 주변 억제 — 같은 샘플이 두 번 잡히지 않게 한다.
    const x0 = Math.max(0, maxLoc.x - supW), y0 = Math.max(0, maxLoc.y - supH);
    const x1 = Math.min(res.cols, maxLoc.x + supW);
    const y1 = Math.min(res.rows, maxLoc.y + supH);
    const roi = res.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    roi.setTo(new cv.Scalar(-1));
    roi.delete();
  }
  res.delete();
  return out;
}

const iou = (a: Peak, b: Peak): number => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

// REF가 TEST 안에 나타나는 위치들(원본 해상도 좌표). 점수 내림차순.
export function detectInstances(
  cv: CV, refImg: ImageDataLike, testImg: ImageDataLike,
  log: (m: string) => void = () => {}): InstanceRect[] {
  const scale = Math.min(
    1, TMPL_MAX_DIM / Math.max(refImg.width, refImg.height));
  const test = toGraySmall(cv, testImg, scale);
  const tmpl0 = toGraySmall(cv, refImg, scale);

  // 4방향 피크 수집 → 방향 간 겹침은 점수 높은 쪽만 남긴다(NMS).
  const all: Peak[] = peaksOf(cv, test, tmpl0, 0);
  for (const rot of [90, 180, 270] as const) {
    const t = rotate(cv, tmpl0, rot);
    all.push(...peaksOf(cv, test, t, rot));
    t.delete();
  }
  tmpl0.delete();
  test.delete();

  all.sort((a, b) => b.score - a.score);
  const kept: Peak[] = [];
  for (const p of all) {
    if (kept.length >= MAX_INSTANCES) break;
    if (kept.every((k) => iou(k, p) < 0.3)) kept.push(p);
  }

  // 축소 좌표 → 원본 좌표(+여유), TEST 경계로 클램프.
  const rects = kept.map((p) => {
    const mx = p.w * CROP_MARGIN, my = p.h * CROP_MARGIN;
    const x = Math.max(0, Math.round((p.x - mx) / scale));
    const y = Math.max(0, Math.round((p.y - my) / scale));
    const x1 = Math.min(testImg.width, Math.round((p.x + p.w + mx) / scale));
    const y1 = Math.min(testImg.height, Math.round((p.y + p.h + my) / scale));
    return { x, y, w: x1 - x, h: y1 - y,
             score: Math.round(p.score * 1000) / 1000, rot: p.rot };
  });
  // 읽는 순서(위→아래, 왼→오른쪽)로 정렬해 "샘플 N" 번호가 눈에 보이는
  // 배치 순서와 일치하게 한다. 같은 줄 판정은 세로 절반 겹침 기준.
  rects.sort((a, b) =>
    Math.abs(a.y - b.y) < Math.min(a.h, b.h) / 2 ? a.x - b.x : a.y - b.y);
  log(`[다중 샘플] ${rects.length}개 검출` + (rects.length
    ? ` — 점수 ${rects.map((r) => r.score.toFixed(2)).join(", ")}` : ""));
  return rects;
}

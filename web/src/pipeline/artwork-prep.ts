// 원본 아트웍 전처리 — 인쇄물에는 없고 아트웍에만 있는 "설명 요소"를 걷어내
// 실물과 비교 가능한 REF를 만든다. 패리티(Python 대조) 대상 밖의 전처리다.
//
// 실물 아트웍 4종(i-SENS 라벨 원판, 2026-08-31 실측)에서 확인한 구조:
//  · 라벨 바깥 — PANTONE 색상 견본과 그 이름, 범례("Printing/Labeling area",
//    "Dieline", "No varnish area"), 치수 문구("size: 94 x 36 mm", "62 X 27 mm",
//    "8 mm"), 치수 보조선. 라벨을 잘라내면 통째로 사라진다.
//  · 라벨 안 — 가변 데이터(LOT NO·유효기한·제조일) 자리를 표시하는 상자와 그
//    안의 치수 숫자("10X6", "32X14", "37X15 mm"). 마젠타 선/글자로 그린 것과
//    연회색으로 채운 것 두 가지를 쓴다.
//  · 한 파일에 라벨이 2벌인 경우가 있다 — 규격을 적어 넣은 판과 깨끗한 판.
//    깨끗한 판이 실물과 대응하므로 그쪽을 고른다.
//
// 그래서 순서는 ① 라벨 후보 찾기 → ② 가장 깨끗한 후보 고르기 → ③ 남은 주석
// 지우기다. 지운 자리는 excluded로 함께 돌려준다 — 조용히 없애면 그 자리의
// 실결함까지 덮어버리므로, 화면·리포트에 "제외 영역"으로 드러내기 위한 것이다.
import type { CV, ImageDataLike, Mat } from "../types.ts";

export interface Rect { x: number; y: number; w: number; h: number }

export interface ArtworkPrep {
  /** 고른 라벨 영역(입력 이미지 좌표). 후보가 없으면 이미지 전체. */
  label: Rect;
  /** 라벨 후보 전부(위→아래). 2벌이면 2개 — 사용자가 바꿔 고를 수 있게 준다. */
  candidates: Rect[];
  /** 라벨 안에서 지운 주석 영역(label 기준 좌표). */
  excluded: Rect[];
  /** 라벨 바깥에서 걷어낸 설명 요소가 있었는지(견본·범례·치수 문구 등). */
  trimmedOutside: boolean;
}

// 잉크로 볼 밝기 상한(흰 배경 위 인쇄물 기준, 엔진의 이진화와 무관한 전처리용).
const INK_MAX = 235;
// 후보를 가르는 여백 — 이보다 넓게 비면 다른 블록으로 본다(입력 폭 대비).
const GAP_RATIO = 0.02;
// 라벨로 볼 최소 크기(입력 대비). 견본·범례 같은 작은 조각을 걸러낸다.
const MIN_W = 0.25, MIN_H = 0.08;
// 주석으로 볼 최소 덩어리 넓이(px). 반점·안티에일리어싱 부스러기 제외.
const MIN_ANNOT_AREA = 200;

const isInk = (r: number, g: number, b: number) =>
  r < INK_MAX || g < INK_MAX || b < INK_MAX;

// 마젠타/핑크 — 가변 데이터 자리와 치수 보조선에 쓰는 교정용 별색.
// R과 B가 모두 G보다 뚜렷이 높다. 빨강 경고문(B가 낮다)은 걸리지 않는다.
const isMagenta = (r: number, g: number, b: number) =>
  r > g + 45 && b > g + 30 && r > 120 && b > 90;

// 연회색 채움 — 가변 데이터 자리를 색 대신 회색 박스로 표시한 판에서 쓴다.
const isGreyFill = (r: number, g: number, b: number) =>
  Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r > 170 && r < 225;

/** 행/열 투영에서 "빈 구간"으로 끊어 연속 구간을 뽑는다. */
function segments(counts: Int32Array, minGap: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1, gap = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0 && ++gap >= minGap) {
      out.push([start, i - gap + 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, counts.length]);
  return out;
}

/** 라벨 후보 — 여백으로 끊은 가로 밴드 × 그 안의 세로 블록. */
function labelCandidates(img: ImageDataLike): Rect[] {
  const { width: W, height: H, data } = img;
  const rows = new Int32Array(H), colsAll = new Int32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (isInk(data[i], data[i + 1], data[i + 2])) { rows[y]++; colsAll[x]++; }
    }
  }
  const minGap = Math.max(4, Math.round(W * GAP_RATIO));
  const out: Rect[] = [];
  for (const [y0, y1] of segments(rows, minGap)) {
    if (y1 - y0 < H * MIN_H) continue;
    const cols = new Int32Array(W);
    for (let y = y0; y < y1; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (isInk(data[i], data[i + 1], data[i + 2])) cols[x]++;
      }
    for (const [x0, x1] of segments(cols, minGap)) {
      if (x1 - x0 < W * MIN_W) continue;
      // 블록 안의 실제 잉크 경계로 다시 조인다(밴드 높이는 이웃 때문에 넓을 수 있다).
      let top = y1, bot = y0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          if (isInk(data[i], data[i + 1], data[i + 2])) {
            if (y < top) top = y;
            if (y > bot) bot = y;
            break;
          }
        }
      if (bot >= top) out.push({ x: x0, y: top, w: x1 - x0, h: bot - top + 1 });
    }
  }
  return out;
}

/**
 * 주석 픽셀 마스크(마젠타 + 연회색 채움)를 라벨 영역 안에서 만든다.
 *
 * 회색은 그대로 쓰면 안 된다 — 검은 글자를 안티에일리어싱한 가장자리가 죄다
 * 중간 회색이라 라벨 본문 글자가 통째로 주석으로 잡힌다(실측: 44곳 오검출).
 * 실제 플레이스홀더는 "넓은 단색 면"이므로 열림(erode→dilate)으로 얇은
 * 글자 테두리만 지워 남는 것을 쓴다. 마젠타는 가는 보조선도 진짜 주석이라
 * 열림을 걸지 않는다.
 */
const GREY_OPEN = 7; // 이보다 얇은 회색 획은 글자 테두리로 본다

function annotationMask(cv: CV, img: ImageDataLike, r: Rect): Mat {
  const mag = new cv.Mat(r.h, r.w, cv.CV_8UC1, new cv.Scalar(0));
  const grey = new cv.Mat(r.h, r.w, cv.CV_8UC1, new cv.Scalar(0));
  const md = mag.data, gd = grey.data;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const i = ((y + r.y) * img.width + (x + r.x)) * 4;
      const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
      const at = y * r.w + x;
      if (isMagenta(R, G, B)) md[at] = 255;
      else if (isGreyFill(R, G, B)) gd[at] = 255;
    }
  const k = cv.getStructuringElement(
    cv.MORPH_RECT, new cv.Size(GREY_OPEN, GREY_OPEN));
  cv.morphologyEx(grey, grey, cv.MORPH_OPEN, k);
  k.delete();
  cv.bitwise_or(mag, grey, mag);
  grey.delete();
  return mag;
}

/**
 * 아트웍을 분석해 라벨 영역과 지울 주석 영역을 정한다.
 * 후보가 여럿이면 주석이 가장 적은(=깨끗한) 판을 고른다.
 */
export function analyzeArtwork(cv: CV, img: ImageDataLike): ArtworkPrep {
  const cands = labelCandidates(img);
  const whole: Rect = { x: 0, y: 0, w: img.width, h: img.height };
  if (cands.length === 0)
    return { label: whole, candidates: [], excluded: [], trimmedOutside: false };

  // 후보별 주석량을 재서 가장 깨끗한 판을 고른다. 크기가 확연히 작은 후보
  // (견본·범례 조각)는 이미 MIN_W/MIN_H에서 걸러졌다.
  // 주석량이 같으면 더 작은 쪽이 깨끗한 판이다 — 규격을 적어 넣은 판은 그
  // 문구까지 블록에 딸려 들어와 상자가 커진다(실측: Con-Sol 726x469 vs 718x366).
  let best = cands[0], bestScore = Infinity, bestArea = Infinity;
  const maxArea = Math.max(...cands.map((c) => c.w * c.h));
  for (const c of cands) {
    const area = c.w * c.h;
    if (area < maxArea * 0.6) continue; // 라벨 한 벌보다 작으면 후보 아님
    const m = annotationMask(cv, img, c);
    const score = cv.countNonZero(m);
    m.delete();
    if (score < bestScore || (score === bestScore && area < bestArea)) {
      bestScore = score; bestArea = area; best = c;
    }
  }

  // 고른 판에 남은 주석을 덩어리 단위로 모아 사각형으로 돌려준다.
  const mask = annotationMask(cv, img, best);
  // 상자 테두리와 그 안의 숫자를 한 덩어리로 묶는다(따로 두면 숫자가 남는다).
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
  k.delete();
  const labels = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
  const n = cv.connectedComponentsWithStats(mask, labels, stats, cent);
  const excluded: Rect[] = [];
  for (let i = 1; i < n; i++) {
    const area = stats.intAt(i, 4);
    if (area < MIN_ANNOT_AREA) continue;
    excluded.push({ x: stats.intAt(i, 0), y: stats.intAt(i, 1),
                    w: stats.intAt(i, 2), h: stats.intAt(i, 3) });
  }
  mask.delete(); labels.delete(); stats.delete(); cent.delete();

  const trimmedOutside =
    best.w < img.width - 2 || best.h < img.height - 2 || cands.length > 1;
  return { label: best, candidates: cands, excluded, trimmedOutside };
}

/**
 * 분석 결과대로 잘라내고 주석을 지운 이미지를 만든다.
 * 지운 자리는 흰색으로 둔다 — 가변 데이터(LOT·유효기한) 자리라 실물에서도
 * 비어 있고, 인쇄된 내용이 있으면 그건 비교 대상이 아니라 제외 영역이다.
 */
export function applyPrep(img: ImageDataLike, prep: ArtworkPrep): ImageDataLike {
  const { label: r } = prep;
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const s = ((y + r.y) * img.width + (x + r.x)) * 4, d = (y * r.w + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  for (const e of prep.excluded)
    for (let y = e.y; y < e.y + e.h && y < r.h; y++)
      for (let x = e.x; x < e.x + e.w && x < r.w; x++) {
        const d = (y * r.w + x) * 4;
        out[d] = 255; out[d + 1] = 255; out[d + 2] = 255; out[d + 3] = 255;
      }
  return { data: out, width: r.w, height: r.h };
}

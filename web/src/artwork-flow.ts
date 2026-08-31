// 아트웍 전처리 흐름 — "원판에서 라벨만 남기기"를 화면과 이어 붙인다.
//
// 원판(아트웍)에는 실물 인쇄에 없는 설명 요소가 들어 있다. 실물 4종을 뜯어보니
// 두 갈래였다.
//  ① PDF 레이어로 분리된 것 — 'Dieline', 'No varnish area',
//     'Printing/Labeling area'. 레이어를 끄고 래스터화하면 벡터 단계에서
//     정확히 빠진다. 가장 믿을 만한 길이다.
//  ② 평탄화돼 레이어가 없는 것 — 색(마젠타 별색·연회색 채움)과 여백으로
//     라벨 블록을 찾는 픽셀 경로로 간다.
// 어느 쪽도 범례를 읽지 않는다(범례가 있는 원판이 절반뿐이다).
//
// 판정은 **제안까지만** 하고 확정은 사람이 한다. 원판이 100종 규모라 새 레이어
// 이름·새 배치가 언제든 나오는데, 조용히 틀리면 라벨 일부가 통째로 검수에서
// 빠진다. 대신 확정값은 아트웍 해시에 붙어 공용 보관함으로 팀에 퍼지므로
// **원판당 한 번만** 확인하면 된다.
import { getArtworkPrep, hashFile, setArtworkPrep,
         type ArtworkPrepSetting, type FracRect } from "./cache.ts";
import { fileToImageData, imageDataToCanvas } from "./lib.ts";
import { DEFAULT_DPI, ensureRasterPages, isPdf, listPdfLayers,
         rasterizePdfPages, type PdfLayer } from "./pipeline/pdf.ts";
import { prepareArtwork } from "./runner.ts";
import type { Rect } from "./pipeline/artwork-prep.ts";

export interface PrepProposal {
  hash: string;
  file: File;
  /** PDF 레이어 목록(없으면 빈 배열 — 픽셀 경로). */
  layers: PdfLayer[];
  /** 레이어를 끈 뒤 래스터화한 1페이지(제안 미리보기의 바탕). */
  page: File;
  pageW: number;
  pageH: number;
  /** 픽셀 경로가 찾은 라벨 후보(page 좌표). 레이어로 충분하면 비어 있을 수 있다. */
  candidates: Rect[];
  /** 추천 후보 index(-1이면 자르지 않음). */
  suggested: number;
  /** 추천 후보 안에서 지울 설명 요소(후보 좌표). */
  excluded: Rect[];
}

// 제안 미리보기는 화면에 띄우는 용도라 원본 dpi가 필요 없다 — 가볍게 만든다.
const PREVIEW_DPI = 150;

const toFrac = (r: Rect, w: number, h: number): FracRect =>
  ({ x: r.x / w, y: r.y / h, w: r.w / w, h: r.h / h });
const fromFrac = (f: FracRect, w: number, h: number): Rect =>
  ({ x: Math.round(f.x * w), y: Math.round(f.y * h),
     w: Math.round(f.w * w), h: Math.round(f.h * h) });

/** 이 아트웍에 이미 확정된 전처리가 있는지. */
export const savedPrep = (hash: string) => getArtworkPrep(hash);

/**
 * 원판을 분석해 제안을 만든다. 레이어가 있으면 설명 요소로 읽히는 것을 미리
 * 꺼 둔 상태로 미리보기를 만들고, 그 위에서 라벨 후보를 찾는다.
 */
export async function proposePrep(
  file: File, onLog?: (m: string) => void): Promise<PrepProposal> {
  const hash = await hashFile(file).catch(() => "");
  const layers = await listPdfLayers(file);
  const hidden = layers.filter((l) => l.annotationLike).map((l) => l.id);
  const pages = isPdf(file)
    ? await rasterizePdfPages(file, PREVIEW_DPI, onLog, hidden)
    : [file];
  const page = pages[0];
  const [{ prep }, img] = await Promise.all(
    [prepareArtwork(page, onLog), fileToImageData(page)]);
  // 라벨이 페이지를 거의 다 차지하면 자를 게 없다(이미 라벨만 있는 원판).
  // 여기서 비교 대상은 **페이지 크기**다 — prepareArtwork가 돌려주는 width/
  // height는 이미 잘라낸 정리본 크기라 자기 자신과 비교하는 꼴이 된다.
  const full = prep.label.w >= img.width * 0.97 &&
               prep.label.h >= img.height * 0.97;
  const suggested = prep.candidates.length === 0 || full
    ? -1 : prep.candidates.findIndex(
        (c) => c.x === prep.label.x && c.y === prep.label.y &&
               c.w === prep.label.w && c.h === prep.label.h);
  return { hash, file, layers, page, pageW: img.width, pageH: img.height,
           candidates: prep.candidates, suggested,
           excluded: prep.excluded };
}

/** 화면에서 고른 내용을 확정값으로 만든다(비율 좌표로 저장). */
export function toSetting(p: PrepProposal, hiddenLayers: string[],
                          candidateIdx: number): ArtworkPrepSetting {
  const label = candidateIdx >= 0 ? p.candidates[candidateIdx] : undefined;
  return {
    hiddenLayers,
    label: label ? toFrac(label, p.pageW, p.pageH) : undefined,
    // 지울 영역은 추천 후보 기준으로 찾은 것이라, 다른 후보를 고르면 버린다.
    excluded: label && candidateIdx === p.suggested
      ? p.excluded.map((e) => toFrac(e, label.w, label.h)) : [],
    at: Date.now(),
  };
}

export async function saveSetting(
  hash: string, s: ArtworkPrepSetting): Promise<void> {
  if (hash) await setArtworkPrep(hash, s);
}

/** 잘라내고 지운 이미지를 만든다(확정값 적용). */
async function applyToPage(page: File, s: ArtworkPrepSetting): Promise<File> {
  if (!s.label) return page;
  const img = await fileToImageData(page);
  const r = fromFrac(s.label, img.width, img.height);
  const c = document.createElement("canvas");
  c.width = Math.max(1, r.w);
  c.height = Math.max(1, r.h);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(imageDataToCanvas(img), r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  // 설명 요소 자리는 흰색으로 — 가변 데이터(LOT·유효기한) 칸이라 실물에서도
  // 비어 있다. 여기 인쇄된 내용이 있으면 그건 비교 대상이 아니라 제외 영역이다.
  ctx.fillStyle = "#fff";
  for (const e of s.excluded ?? []) {
    const q = fromFrac(e, r.w, r.h);
    ctx.fillRect(q.x, q.y, q.w, q.h);
  }
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (!blob) throw new Error("아트웍 정리본을 만들지 못했습니다.");
  return new File([blob], page.name.replace(/\.[^.]+$/, "") + "-정리본.png",
                  { type: "image/png" });
}

/**
 * 확정값을 적용해 페이지 PNG 배열을 만든다. 확정값이 없으면 평소대로 래스터화한다.
 * (검수 실행 경로가 쓰는 유일한 진입점 — 화면은 여기로만 들어온다)
 */
export async function rasterWithPrep(
  file: File, setting: ArtworkPrepSetting | undefined,
  dpi: number = DEFAULT_DPI, onLog?: (m: string) => void): Promise<File[]> {
  if (!setting) return ensureRasterPages(file, dpi, onLog);
  const pages = isPdf(file)
    ? await rasterizePdfPages(file, dpi, onLog, setting.hiddenLayers)
    : [file];
  return Promise.all(pages.map((p) => applyToPage(p, setting)));
}

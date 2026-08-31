// PDF 입력 지원 — 원본/인쇄물이 PDF로 오면 각 페이지를 600dpi PNG로 래스터화해
// 이후 파이프라인이 이미지처럼 다룬다. 다중 페이지 PDF는 페이지 수만큼 PNG로
// 펼친다(원본 2장 PDF ↔ 인쇄물 2장 PDF 매칭 등). pdf.js(wasm 아님, JS)를
// 셀프호스트 워커로 구동 — CDN 없이 정적 호스팅(HF)·사내망 http 양쪽에서 동작.
// Vite가 워커를 dist/assets로 복사하고 해시 URL을 준다(base "./"라 /app/·HF루트 공통).
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdfjs 본체(~190KB gzip)는 PDF를 실제로 올릴 때만 지연 로드한다 — 이미지만
// 쓰는 대다수 경로의 초기 로딩을 무겁게 하지 않기 위해.
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    });
  }
  return pdfjsPromise;
}

// PDF 좌표는 1/72 inch. 600dpi = scale 8.33…
const PDF_DPI = 72;
export const DEFAULT_DPI = 600;
// 브라우저 캔버스 한 변 상한(과대 PDF의 캔버스 할당 실패 방지). 600dpi A4는
// ~4960×7016로 여유롭지만, 대형 라벨 PDF가 이를 넘으면 유효 dpi를 낮춘다.
const MAX_DIM = 12000;

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

// PDF 페이지 수만 빠르게 조회(렌더 없이). "몇 장짜리인지" 표시용.
export async function pdfPageCount(file: File): Promise<number> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  try {
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } finally {
    loadingTask.destroy();
  }
}

// ---------------------------------------------------------------- 레이어(OCG)
// 원판 아트웍은 재단선·가변 데이터 자리 표시 같은 설명 요소를 **별도 레이어**에
// 두는 경우가 많다(실측: i-SENS 라벨 4종 중 2종이 'Dieline',
// 'No varnish area', 'Printing/Labeling area' 레이어를 갖고 있었다).
// 레이어를 끄고 래스터화하면 벡터 단계에서 정확히 빠진다 — 픽셀 휴리스틱보다
// 훨씬 믿을 만하다. 레이어가 없는(평탄화된) 파일은 artwork-prep.ts의
// 색·여백 기반 경로로 넘어간다.
export interface PdfLayer {
  id: string;
  name: string;
  /** 이름이 설명 요소로 읽히는가 — 화면에서 기본 체크 상태로 쓴다. */
  annotationLike: boolean;
}

// 이름으로 설명 요소를 짐작한다. 아트웍이 100종 규모라 이름은 언제든 새로
// 나올 수 있으므로 **자동 확정이 아니라 기본 체크**로만 쓰고, 최종 판단은
// 사용자가 한다(고른 결과는 아트웍 해시에 붙어 팀 전체에 공유된다).
const ANNOT_LAYER = /die\s*-?line|cut\s*line|varnish|printing\s*\/?\s*labeling|labeling\s*area|printing\s*area|guide|dimension|bleed|trim|safety|재단|도무송|규격|가이드|치수/i;

export const classifyLayerName = (name: string): boolean =>
  ANNOT_LAYER.test(name);

export async function listPdfLayers(file: File): Promise<PdfLayer[]> {
  if (!isPdf(file)) return [];
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  try {
    const pdf = await loadingTask.promise;
    const cfg = await pdf.getOptionalContentConfig();
    // v6의 OptionalContentConfig는 [id, group] 쌍을 순회한다(getGroups()는 없다 —
    // 있는 줄 알고 옵셔널 호출로 뒀다가 레이어를 통째로 놓쳤었다).
    const rows: [string, { name?: string }][] = cfg ? [...cfg] : [];
    return rows.map(([id, g]) => {
      const name = String(g?.name ?? id);
      return { id, name, annotationLike: classifyLayerName(name) };
    });
  } catch { return []; }
  finally { loadingTask.destroy(); }
}

// 로드된 PDF 페이지 하나를 지정 dpi(캔버스 한계 내)로 렌더해 PNG Blob으로.
// hidden: 끌 레이어 id 목록(선택) — 그 레이어의 그림은 렌더되지 않는다.
async function renderPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any, dpi: number, onLog?: (m: string) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ocConfig?: any,
): Promise<Blob> {
  let scale = dpi / PDF_DPI;
  const base = page.getViewport({ scale: 1 });
  const longest = Math.max(base.width, base.height) * scale;
  if (longest > MAX_DIM) {
    const capped = scale * (MAX_DIM / longest);
    onLog?.(`[PDF] 페이지가 커서 ${dpi}dpi → ` +
      `${Math.round(capped * PDF_DPI)}dpi로 렌더합니다.`);
    scale = capped;
  }
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  // 스캔지는 흰 바탕 — PDF의 투명 배경을 흰색으로 채워 정합/이진화와 정합성 유지
  await page.render({ canvas, viewport, background: "#ffffff",
                      optionalContentConfigPromise: ocConfig
                        ? Promise.resolve(ocConfig) : undefined }).promise;
  const blob = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("PDF 렌더 결과를 이미지로 만들지 못했습니다.");
  return blob;
}

// PDF 래스터화 직렬화 — 600dpi 페이지 렌더는 캔버스 메모리가 커서, 여러 파일을
// 동시에 올리면(원본·인쇄물 동시 드롭 등) 동시 렌더가 메모리를 몰아 멈출 수 있다.
// 한 번에 하나씩 처리하도록 큐로 직렬화한다(체감 속도 차이는 미미).
let rasterQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = rasterQueue.then(fn, fn);
  rasterQueue = run.then(() => undefined, () => undefined);
  return run;
}

// PDF의 모든 페이지를 600dpi PNG File 배열로. 페이지가 여러 장이면 파일명에
// 페이지 번호를 붙인다(base-p1.png, base-p2.png). 1장이면 base.png.
export function rasterizePdfPages(
  file: File,
  dpi: number = DEFAULT_DPI,
  onLog?: (m: string) => void,
  hiddenLayers?: string[],
): Promise<File[]> {
  return serialize(() =>
    rasterizePdfPagesInner(file, dpi, onLog, hiddenLayers));
}

async function rasterizePdfPagesInner(
  file: File,
  dpi: number,
  onLog?: (m: string) => void,
  hiddenLayers?: string[],
): Promise<File[]> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data });
  try {
    const pdf = await loadingTask.promise;
    let ocConfig;
    if (hiddenLayers?.length) {
      ocConfig = await pdf.getOptionalContentConfig();
      for (const id of hiddenLayers) ocConfig?.setVisibility(id, false);
      onLog?.(`[PDF] 레이어 ${hiddenLayers.length}개를 끄고 렌더합니다.`);
    }
    const n = pdf.numPages;
    const base = file.name.replace(/\.pdf$/i, "");
    const out: File[] = [];
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      const blob = await renderPage(page, dpi, onLog, ocConfig);
      const name = n > 1 ? `${base}-p${i}.png` : `${base}.png`;
      out.push(new File([blob], name, { type: "image/png" }));
    }
    onLog?.(`[PDF] ${file.name} → ${n}페이지 PNG 변환 완료`);
    return out;
  } finally {
    loadingTask.destroy();
  }
}

// PDF 첫 페이지만 PNG File로(단일 페이지 용도·기존 호출 호환).
export async function rasterizePdf(
  file: File,
  dpi: number = DEFAULT_DPI,
  onLog?: (m: string) => void,
): Promise<File> {
  const pages = await rasterizePdfPages(file, dpi, onLog);
  return pages[0];
}

// 한 파일을 페이지 PNG 배열로 펼친다: PDF면 전 페이지, 이미지면 그 자체 1장.
export async function ensureRasterPages(
  file: File,
  dpi: number = DEFAULT_DPI,
  onLog?: (m: string) => void,
): Promise<File[]> {
  return isPdf(file) ? rasterizePdfPages(file, dpi, onLog) : [file];
}

// PDF면 첫 페이지 래스터화, 아니면 그대로(단일 파일 호환 경로).
export async function ensureRaster(
  file: File,
  dpi: number = DEFAULT_DPI,
  onLog?: (m: string) => void,
): Promise<File> {
  return isPdf(file) ? rasterizePdf(file, dpi, onLog) : file;
}

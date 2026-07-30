// 화면·데이터 헬퍼: 이미지 변환, 표시 매핑, CSV, 확대경, 피드백 전송/보관 큐.
import type { StoredSet } from "./cache.ts";
import { branding } from "./branding.ts";
import { defaultConfig } from "./pipeline/config.ts";
import { wordsFromTesseract } from "./pipeline/ocr.ts";
import type { BBox, Disp, DispFinding, Finding, ImageDataLike, ResultItem,
              Severity, Word } from "./types.ts";

export const SEV_ORDER: Record<string, number> =
  { critical: 0, major: 1, minor: 2, expected: 3 };

export const fmtMB = (b: number) => (b / 1024 / 1024).toFixed(1) + "MB";

// 분석 일시 표기 (예: 2026-07-27 10:36). 결과가 7일 보존되므로 언제 분석한
// 결과인지 화면에 남긴다.
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- 이미지
export async function fileToImageData(file: File): Promise<ImageData> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, c.width, c.height);
}

export function imageDataToCanvas(imgData: ImageData): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = imgData.width;
  c.height = imgData.height;
  c.getContext("2d")!.putImageData(imgData, 0, 0);
  return c;
}

export function download(name: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export const fileToDataURL = (file: File): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

// ---------------------------------------------------------------- OCR (메인 스레드)
// OCR 리소스는 전부 자체 포함(public/tesseract/) — CDN 의존 없음.
// 언어 데이터는 tessdata_best (fast는 0↔8, 대소문자 오독이 많음).
const tessUrl = (p: string) =>
  new URL(import.meta.env.BASE_URL + "tesseract/" + p, location.href).href;

export async function ocrCanvas(canvas: HTMLCanvasElement,
                                onLog?: (m: string) => void): Promise<Word[]> {
  // Vite가 동적 import에 주입하는 ESM interop 가드(default 유무 분기)는 도달
  // 불가한 툴링 분기라 커버리지에서 제외한다.
  /* v8 ignore start */
  const Tesseract = await import("tesseract.js");
  /* v8 ignore stop */
  const worker = await Tesseract.createWorker("eng", 1, {
    workerPath: tessUrl("worker.min.js"),
    corePath: tessUrl("core"),
    langPath: tessUrl("lang"),
  });
  await worker.setParameters({ tessedit_pageseg_mode: "3" as never });
  const t = performance.now();
  const { data } = await worker.recognize(canvas, {},
    { blocks: true } as never);
  onLog?.(`[OCR] ${Math.round(performance.now() - t) / 1000}s`);
  await worker.terminate();
  return wordsFromTesseract(data as never, defaultConfig.ocrMinConf);
}

// ---------------------------------------------------------------- 표시 매핑
// 고객 요청(2026-07) 결과 표시 매핑 — 원본 findings 데이터는 그대로 두고
// 화면 표시만 변환. showthrough(뒷비침)는 불량 미처리로 결과에서 제외.
export function mapDisplay(f: Finding): Disp | null {
  switch (f.type) {
    case "extra":
      return f.severity === "minor"
        ? { ktype: "인쇄/오염", severity: "major", note: "여백 인쇄/오염 불량" }
        : { ktype: "가독성", severity: "critical", note: "인쇄 영역 침범/가독성 저하" };
    case "text_mismatch": {
      const detail = f.note.split("OCR 불일치: ")[1];
      return { ktype: "인쇄 오류", severity: "critical",
               note: "인쇄 내용 불일치" + (detail ? ` (${detail})` : "") };
    }
    case "missing":
      return { ktype: "인쇄 누락", severity: "critical", note: "미 인쇄(인쇄 누락)" };
    case "faded":
      // 미인쇄와는 구분한다 — 사용자도 "흐리긴 하지만 미 인쇄는 아니다"라고
      // 따로 판정한다. 문구에 실측 농도비(엔진 note)를 그대로 붙인다.
      return { ktype: "인쇄 농도", severity: "major",
               note: f.note || "인쇄 농도 부족(옅게 인쇄됨)" };
    default:
      return null;
  }
}

// 세트 이름 변경 — 같은 setId의 모든 페이지 결과에 새 이름 적용(불변).
export function applySetName(
  results: ResultItem[], setId: number, name: string): ResultItem[] {
  return results.map((r) => (r.setId === setId ? { ...r, name } : r));
}

export function boxesIntersect(a: number[], b: number[]): boolean {
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  return !(ax + aw < bx || bx + bw < ax || ay + ah < by || by + bh < ay);
}

export interface DisplayArtifacts {
  defects: DispFinding[];
  annotated: HTMLCanvasElement;
}

// 화면에 표시할 결함 목록 — 같은 결함이 잉크 diff(extra/missing)와
// OCR(text_mismatch) 양쪽에서 잡히면 '인쇄 오류' 하나만 남긴다.
export function computeDefects(findings: Finding[]): DispFinding[] {
  const textBoxes = findings
    .filter((f) => f.type === "text_mismatch")
    .map((f) => f.bbox_ref);
  const dupOfText = (f: Finding) =>
    (f.type === "extra" || f.type === "missing") &&
    textBoxes.some((t) => boxesIntersect(f.bbox_ref, t));

  return findings
    .filter((f) => f.severity !== "expected" && !dupOfText(f))
    .map((f) => ({ ...f, disp: mapDisplay(f)! }))
    .filter((f) => f.disp)
    .sort((a, b) =>
      SEV_ORDER[a.disp.severity] - SEV_ORDER[b.disp.severity] || a.id - b.id);
}

export function buildDisplayArtifacts(
  findings: Finding[],
  _refCanvas: HTMLCanvasElement,
  alignedCanvas: HTMLCanvasElement,
): DisplayArtifacts {
  const defects = computeDefects(findings);
  const redIds = new Set(defects.map((f) => f.id));

  const scale = 0.45;
  const annotated = document.createElement("canvas");
  annotated.width = Math.round(alignedCanvas.width * scale);
  annotated.height = Math.round(alignedCanvas.height * scale);
  const ctx = annotated.getContext("2d")!;
  ctx.drawImage(alignedCanvas, 0, 0, annotated.width, annotated.height);
  ctx.textBaseline = "bottom";
  ctx.font = "bold 29px sans-serif";
  for (const f of findings) {
    const [x, y, w, h] = f.bbox_ref.map((v) => v * scale);
    if (!redIds.has(f.id)) {
      ctx.strokeStyle = "rgb(160,160,160)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
    } else {
      ctx.strokeStyle = "red";
      ctx.lineWidth = 4;
      ctx.strokeRect(x, y, w, h);
      // 번호는 영역(빨강)과 구분되는 파란색 + 흰 테두리 — 혼동 방지
      const tx = x, ty = Math.max(y - 9, 27);
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#fff";
      ctx.strokeText(String(f.id), tx, ty);
      ctx.fillStyle = "#1565c0";
      ctx.fillText(String(f.id), tx, ty);
    }
  }
  return { defects, annotated };
}

export function sevCounts(defects: DispFinding[]): Record<Severity, number> {
  const n: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
  for (const f of defects) n[f.disp.severity]++;
  return n;
}

// ---------------------------------------------------------------- 확대경
export const LENS_W = 460, LENS_H = 240;
export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(v, hi));

// box: 검출 영역(bbox_ref)을 가는 점선으로 표시 — 내용을 가리지 않게 채움 없음.
// mark: 미검출 클릭 지점을 작은 점선 원으로 표시.
export function drawLensInto(src: HTMLCanvasElement | null,
                             canvasEl: HTMLCanvasElement | null,
                             cx: number, cy: number,
                             box?: number[] | null,
                             mark?: { x: number; y: number } | null): void {
  if (!src || !canvasEl) return;
  const sx = clamp(cx - LENS_W / 2, 0, Math.max(0, src.width - LENS_W));
  const sy = clamp(cy - LENS_H / 2, 0, Math.max(0, src.height - LENS_H));
  const ctx = canvasEl.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, LENS_W, LENS_H);
  ctx.drawImage(src, sx, sy, LENS_W, LENS_H, 0, 0, LENS_W, LENS_H);
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "rgba(192, 57, 43, 0.85)";
  ctx.lineWidth = 1.5;
  if (box) {
    const [bx, by, bw, bh] = box;
    // 살짝 여유를 둬서 점선이 결함 자체를 덮지 않게 한다
    ctx.strokeRect(bx - sx - 3, by - sy - 3, bw + 6, bh + 6);
  }
  if (mark) {
    ctx.beginPath();
    ctx.arc(mark.x - sx, mark.y - sy, 12, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function lensDataURL(src: HTMLCanvasElement, cx: number, cy: number): string {
  const c = document.createElement("canvas");
  c.width = LENS_W;
  c.height = LENS_H;
  drawLensInto(src, c, cx, cy);
  return c.toDataURL("image/jpeg", 0.85);
}

// ---------------------------------------------------------------- CSV
export const csvEsc = (s: unknown) => `"${String(s).replace(/"/g, '""')}"`;

// 결과 화면의 표와 동일한 형태의 CSV — 검수자가 보는 그대로 내보낸다.
// (엔진 원본 데이터는 피드백 전송 페이로드에 포함되므로 별도 노출 불필요)
export function displayCsv(defects: DispFinding[],
                           fb?: { defects: Record<string, { fp: boolean; comment: string }> }): string {
  const rows: unknown[][] = [["번호", "유형", "심각도", "비고", "피드백"]];
  for (const f of defects) {
    const v = fb?.defects?.[f.id];
    const fbText = v ? `${v.fp ? "오탐" : "의견"}${v.comment ? ": " + v.comment : ""}` : "";
    rows.push([f.id, f.disp.ktype, f.disp.severity.toUpperCase(),
               csvEsc(f.disp.note), csvEsc(fbText)]);
  }
  return "﻿" + rows.map((r) => r.join(",")).join("\r\n");
}

export function feedbackCsv(results: ResultItem[]): string {
  const rows: unknown[][] =
    [["세트", "구분", "번호", "유형", "원인", "x", "y", "w", "h", "코멘트"]];
  for (const it of results) {
    if (!it.fb) continue;
    for (const [id, v] of Object.entries(it.fb.defects))
      rows.push([csvEsc(it.name), v.fp ? "오탐" : "의견", id, v.ktype,
                 csvEsc(v.cause || ""), ...v.bbox, csvEsc(v.comment)]);
    it.fb.missed.forEach((m, i) =>
      rows.push([csvEsc(it.name), "미검출", "M" + (i + 1), "",
                 csvEsc(m.cause || ""), m.x, m.y, "", "", csvEsc(m.comment)]));
  }
  return "﻿" + rows.map((r) => r.join(",")).join("\r\n");
}

// ---------------------------------------------------------------- 피드백 전송
// 피드백은 맥미니 서버(feedback/feedback.jsonl)에 축적되어 오탐 튜닝의 입력이
// 된다. 문제 부위 크롭 + 엔진 분석 데이터 + 원본 이미지(사용자 승인)를 보낸다.
export const APP_VERSION = "2026-07-24.3";
// same-origin 폴백: /app/이면 같은 서버 /feedback, hf.space 정적이면 없음.
export function computeFeedbackEndpoints(hostname: string): string[] {
  return hostname.endsWith("hf.space") ? [] : ["/feedback"];
}

// 전송 대상: 외부 수집기(collectUrl)가 있으면 어디서든 그리로, 없으면 폴백.
export function feedbackTargets(
  collectUrl: string | undefined, hostname: string): string[] {
  if (collectUrl) return [collectUrl];
  return computeFeedbackEndpoints(hostname);
}

const FEEDBACK_ENDPOINTS = feedbackTargets(
  branding.feedback?.collectUrl, location.hostname);

export const hasFeedbackEndpoint = FEEDBACK_ENDPOINTS.length > 0;

export interface FeedbackPayload {
  app: string;
  version: string;
  sentAt: string;
  origin: string;
  kind?: "error";  // 분석 실패 보고(일반 피드백은 없음)
  items: Record<string, unknown>[];
}

export async function buildFeedbackPayload(
  results: ResultItem[]): Promise<FeedbackPayload> {
  const items: Record<string, unknown>[] = [];
  for (const it of results) {
    if (it.error || !it.fb || !it.refCanvas || !it.alignedCanvas) continue;
    const defects = Object.entries(it.fb.defects).map(([id, v]) => {
      const f = it.defects?.find((d) => d.id === +id);
      const [x, y, w, h] = v.bbox;
      const cx = x + w / 2, cy = y + h / 2;
      return { id: +id, ...v,
               type: f?.type, engine_note: f?.note,
               refCrop: lensDataURL(it.refCanvas!, cx, cy),
               testCrop: lensDataURL(it.alignedCanvas!, cx, cy) };
    });
    const missed = it.fb.missed.map((m) => ({
      ...m,
      refCrop: lensDataURL(it.refCanvas!, m.x, m.y),
      testCrop: lensDataURL(it.alignedCanvas!, m.x, m.y),
    }));
    if (!defects.length && !missed.length) continue;
    // 원본 이미지 전체 포함 — 서버(맥미니)에서 동일 세트를 재현·재분석해
    // 오탐 튜닝에 쓴다 (2026-07-24 사용자 승인)
    const [refImage, testImage] = await Promise.all([
      it.refFile ? fileToDataURL(it.refFile) : null,
      it.testFile ? fileToDataURL(it.testFile) : null,
    ]);
    items.push({
      set: it.name,
      dims: { w: it.refCanvas.width, h: it.refCanvas.height },
      totalMs: it.result?.totalMs,
      findings: it.result?.findings,
      feedback: { defects, missed },
      refImage, testImage,
    });
  }
  return { app: "artwork-compare-web", version: APP_VERSION,
           sentAt: new Date().toISOString(), origin: location.origin, items };
}

export async function trySendFeedback(
  payload: FeedbackPayload,
  targets: string[] = FEEDBACK_ENDPOINTS): Promise<string | null> {
  const body = JSON.stringify(payload);
  for (const url of targets) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (r.ok) return url;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// 수집 서버(맥미니)가 꺼져 있을 때를 대비한 보류 큐 — 브라우저에 보관했다가
// 다음 방문 시 자동 재전송한다. localStorage 용량 초과 시엔 파일 폴백.
const FB_QUEUE_KEY = "artwork-fb-queue";

export function loadFbQueue(): FeedbackPayload[] {
  try { return JSON.parse(localStorage.getItem(FB_QUEUE_KEY) || "[]"); }
  catch { return []; }
}

export function saveFbQueue(q: FeedbackPayload[]): boolean {
  try {
    if (!q.length) localStorage.removeItem(FB_QUEUE_KEY);
    else localStorage.setItem(FB_QUEUE_KEY, JSON.stringify(q));
    return true;
  } catch { return false; }
}

export function slimPayload(payload: FeedbackPayload): FeedbackPayload {
  return {
    ...payload,
    items: payload.items.map(({ refImage, testImage, ...rest }) =>
      ({ ...rest, imagesDropped: true })),
  };
}

// ---------------------------------------------------------- 오류 보고
// 분석이 실패하면(정합 불가·wasm 예외·메모리 부족 등) 결함 크롭이 없어 일반
// 피드백을 만들 수 없다. 대신 원인 추적에 필요한 것 — 오류 문구(어느 단계에서
// 터졌는지 포함), 입력 파일의 이름·크기, 실행 로그 — 만 모아 보낸다.
// 라벨 이미지 자체는 보내지 않는다(일반 피드백과 동일한 정책).
export function buildErrorReport(
  items: ResultItem[], logs: string[], note?: string): FeedbackPayload {
  const meta = (f?: File) =>
    f ? { name: f.name, size: f.size, type: f.type } : undefined;
  return {
    app: "artwork-compare-web",
    version: APP_VERSION,
    sentAt: new Date().toISOString(),
    origin: location.origin,
    kind: "error",
    items: items.map((it) => ({
      set: it.name,
      page: it.page,
      pageCount: it.pageCount,
      error: it.error,
      note: note || undefined,
      refFile: meta(it.refFile),
      testFile: meta(it.testFile),
      // 마지막 로그만 — 전체는 너무 길고 앞부분은 매번 같은 부팅 로그다.
      logs: logs.slice(-60),
      ua: navigator.userAgent,
    })),
  };
}

// ------------------------------------------------ 수집된 피드백(관리자 화면)
// 수집기가 돌려주는 1건(= 한 번의 전송)의 모양. 서버가 만든 JSON이라 값이
// 빠져 있을 수 있어 전부 선택 항목으로 둔다.
export interface AdminDefectFb {
  fp?: boolean; ktype?: string; type?: string; cause?: string;
  comment?: string; bbox?: number[]; refCrop?: string; testCrop?: string;
}
export interface AdminMissedFb {
  x?: number; y?: number; cause?: string; comment?: string;
  refCrop?: string; testCrop?: string;
}
export interface AdminFileMeta { name: string; size: number; type?: string }
export interface AdminSet {
  set?: string;
  feedback?: { defects?: AdminDefectFb[]; missed?: AdminMissedFb[] };
  // 아래는 분석 실패 보고(kind: "error")에만 있는 항목
  page?: number;
  error?: string;
  note?: string;
  refFile?: AdminFileMeta;
  testFile?: AdminFileMeta;
  logs?: string[];
  ua?: string;
}
export interface AdminEntry {
  id: string;
  uploadedAt?: string;
  received?: string;
  origin?: string;
  size?: number;
  error?: string;  // 수집기가 본문을 읽지 못한 경우
  data?: { version?: string | number; kind?: string; items?: AdminSet[] };
}

// 피드백 1건의 날짜 키(YYYY-MM-DD) — 관리자 화면에서 날짜별로 묶는 데 쓴다.
export function entryDay(e: AdminEntry): string {
  const t = e.received || e.uploadedAt;
  const d = t ? new Date(t) : null;
  if (!d || Number.isNaN(d.getTime())) return "날짜 미상";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const entryTime = (e: AdminEntry) => {
  const t = e.received || e.uploadedAt;
  const d = t ? new Date(t) : null;
  return d && !Number.isNaN(d.getTime()) ? fmtDateTime(d.getTime()) : "시간 미상";
};

// 피드백을 대화창에 붙여넣기 좋은 텍스트로. 크롭 이미지는 담지 못하므로
// 어떤 건인지 되짚을 수 있게 id·세트명·좌표를 같이 적는다.
export function summarizeFeedbackForChat(entries: AdminEntry[]): string {
  if (!entries.length) return "";
  const out: string[] = [
    `# 인쇄 검수 피드백 ${entries.length}건`,
    "(오탐 = 검출이 틀렸다는 지적 · 미검출 = 놓친 결함. 크롭 이미지는 관리자 화면에서 id로 찾을 수 있음)",
    "",
  ];
  for (const e of entries) {
    const isErr = e.data?.kind === "error";
    out.push(`## [${e.id}] ${entryTime(e)}${isErr ? " — 분석 실패 보고" : ""}`);
    if (e.error) { out.push(`- 본문을 읽지 못함: ${e.error}`, ""); continue; }
    for (const s of e.data?.items ?? []) {
      out.push(`### 세트 "${s.set || "이름 없음"}"` +
               (s.page ? ` · 페이지 ${s.page}` : ""));
      if (isErr || s.error) {
        out.push(`- 오류: ${s.error || "문구 없음"}`);
        if (s.note) out.push(`- 사용자 메모: "${s.note.replace(/\s+/g, " ").trim()}"`);
        if (s.refFile) out.push(`- 원본: ${s.refFile.name} (${fmtMB(s.refFile.size)})`);
        if (s.testFile) out.push(`- 인쇄물: ${s.testFile.name} (${fmtMB(s.testFile.size)})`);
        if (s.logs?.length)
          out.push("- 마지막 로그:", "```", ...s.logs.slice(-15), "```");
        continue;
      }
      for (const d of s.feedback?.defects ?? []) {
        const bits = [d.fp ? "오탐" : "정탐", d.ktype || d.type || "결함"];
        if (d.cause) bits.push(`원인: ${d.cause}`);
        if (d.bbox?.length === 4) bits.push(`bbox_ref=[${d.bbox.join(",")}]`);
        if (d.comment) bits.push(`"${d.comment.replace(/\s+/g, " ").trim()}"`);
        out.push(`- ${bits.join(" | ")}`);
      }
      for (const m of s.feedback?.missed ?? []) {
        const bits = ["미검출"];
        if (m.cause) bits.push(`원인: ${m.cause}`);
        if (m.x != null && m.y != null)
          bits.push(`위치=(${Math.round(m.x)},${Math.round(m.y)})`);
        if (m.comment) bits.push(`"${m.comment.replace(/\s+/g, " ").trim()}"`);
        out.push(`- ${bits.join(" | ")}`);
      }
      if (!(s.feedback?.defects ?? []).length && !(s.feedback?.missed ?? []).length)
        out.push("- (내용 없음)");
    }
    out.push("");
  }
  return out.join("\n");
}

// 클립보드 복사. navigator.clipboard는 보안 컨텍스트(HTTPS/localhost)에서만
// 동작해서, 사내망 http:// 접속을 위해 execCommand 폴백을 둔다.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 폴백으로 */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- 결과 보존
// 새로고침·재방문 후에도 결과를 이어서 볼 수 있도록 브라우저(IndexedDB)에 저장한다.
// 저장 대상은 원본 파일 + 정합 이미지 + 분석 결과뿐 — 오버레이·확대용 캔버스는
// 복원할 때 다시 만든다(용량 절약). 서버로는 전송되지 않는다.
export const canvasToBlob = (c: HTMLCanvasElement, type = "image/jpeg", q = 0.92) =>
  new Promise<Blob | null>((res) => c.toBlob(res, type, q));

export async function blobToCanvas(b: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

const packFile = (f?: File) =>
  f ? { blob: f as Blob, name: f.name, type: f.type } : undefined;
const unpackFile = (p?: { blob: Blob; name: string; type: string }) =>
  p ? new File([p.blob], p.name, { type: p.type }) : undefined;

// 세트/페이지 태그 — 복원 시 그대로 되살린다(구버전 레코드는 기본값 보정).
const tag = (s: StoredSet) => ({
  setId: s.setId ?? 0,
  page: s.page ?? 1,
  pageCount: s.pageCount ?? 1,
});

export async function serializeResults(results: ResultItem[]): Promise<StoredSet[]> {
  const out: StoredSet[] = [];
  for (const it of results) {
    if (!it) continue;
    const meta = { setId: it.setId, page: it.page, pageCount: it.pageCount };
    if (it.error || !it.alignedCanvas || !it.result) {
      out.push({ name: it.name, ...meta, error: it.error });
      continue;
    }
    const aligned = await canvasToBlob(it.alignedCanvas);
    out.push({
      name: it.name,
      ...meta,
      result: it.result,
      fb: it.fb,
      alignedImage: aligned ?? undefined,
      refFile: packFile(it.refFile),
      testFile: packFile(it.testFile),
    });
  }
  return out;
}

export async function restoreResults(sets: StoredSet[]): Promise<ResultItem[]> {
  const out: ResultItem[] = [];
  for (const s of sets) {
    if (s.error || !s.result || !s.alignedImage || !s.refFile) {
      out.push({ name: s.name, ...tag(s),
                 error: s.error || "복원할 수 없는 결과입니다." });
      continue;
    }
    try {
      const refCanvas = await blobToCanvas(s.refFile.blob);
      const alignedCanvas = await blobToCanvas(s.alignedImage);
      const art = buildDisplayArtifacts(s.result.findings, refCanvas, alignedCanvas);
      out.push({ name: s.name, ...tag(s), result: s.result, fb: s.fb, ...art,
                 refCanvas, alignedCanvas,
                 refFile: unpackFile(s.refFile),
                 testFile: unpackFile(s.testFile) });
    } catch {
      out.push({ name: s.name, ...tag(s), error: "결과 복원에 실패했습니다." });
    }
  }
  return out;
}

export async function flushFbQueue(): Promise<number> {
  const q = loadFbQueue();
  if (!q.length) return 0;
  const remain: FeedbackPayload[] = [];
  let sent = 0;
  for (const p of q) {
    if (await trySendFeedback(p)) sent++;
    else remain.push(p);
  }
  saveFbQueue(remain);
  return sent;
}

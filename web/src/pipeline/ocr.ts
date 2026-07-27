// tesseract.js 결과 → compare_artwork.py ocr_words()와 동일한 단어 목록.
// {text, conf, bbox:[x,y,w,h], line:[block,par,line]} — conf<minConf 및 빈 단어 제외.
import { normWord } from "./textcheck.ts";
import type { Word } from "../types.ts";

interface TessWord {
  text?: string;
  confidence?: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  line?: unknown;
}

interface TessData {
  blocks?: Array<{
    paragraphs?: Array<{ lines?: Array<{ words?: TessWord[] }> }>;
  }>;
  words?: TessWord[];
}

export function wordsFromTesseract(data: TessData, minConf: number): Word[] {
  const out: Word[] = [];
  const pushWord = (w: TessWord, b: number, p: number, l: number) => {
    const text = normWord(w.text || "");
    const conf = typeof w.confidence === "number" ? w.confidence : -1;
    if (!text || conf < minConf) return;
    const bb = w.bbox;
    out.push({
      text, conf,
      bbox: [bb.x0, bb.y0, bb.x1 - bb.x0, bb.y1 - bb.y0],
      line: [b, p, l],
    });
  };
  if (data.blocks && data.blocks.length) {
    data.blocks.forEach((blk, bi) =>
      (blk.paragraphs || []).forEach((par, pi) =>
        (par.lines || []).forEach((ln, li) =>
          (ln.words || []).forEach((w) => pushWord(w, bi + 1, pi + 1, li + 1)))));
    return out;
  }
  // 구버전 flat 배열 폴백 — line 객체 identity로 라인 번호 부여
  const lineIds = new Map<unknown, number>();
  (data.words || []).forEach((w) => {
    let lid = lineIds.get(w.line);
    if (lid === undefined) {
      lid = lineIds.size + 1;
      lineIds.set(w.line, lid);
    }
    pushWord(w, 0, 0, lid);
  });
  return out;
}

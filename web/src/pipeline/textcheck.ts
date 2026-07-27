// OCR 텍스트 대조 (compare_artwork.py 3.7 포트)
import { SequenceMatcher } from "./seqmatch.ts";
import type { BBox, Word } from "../types.ts";

export interface TextMismatch {
  bbox: BBox;
  refText: string;
  testText: string;
  tag: string;
}

export function normWord(t: string): string {
  return t
    .replace(/‘/g, "'").replace(/’/g, "'")
    .replace(/“/g, '"').replace(/”/g, '"')
    .replace(/–/g, "-").replace(/—/g, "-")
    .trim();
}

// 혼동 문자 클래스 — 클래스 내 치환은 결함이 아님 (Python _CONFUSABLE와 동일)
const CONFUSABLE = new Map<string, string>();
for (const [k, grp] of Object.entries(
  { "0": "0OoQ", "1": "1lI|i", "5": "5Ss", "8": "8B", "2": "2Zz" })) {
  for (const c of grp) CONFUSABLE.set(c, k);
}

function translateConfusable(s: string): string {
  let out = "";
  for (const ch of s) out += CONFUSABLE.get(ch) || ch;
  return out;
}

const ALNUM_RE = /[\p{L}\p{N}]/u;

function alnum(s: string): string {
  let out = "";
  for (const ch of s) if (ALNUM_RE.test(ch)) out += ch;
  return out;
}

export function trivialDiff(tag: string, aWords: string[], bWords: string[]): boolean {
  const aJoin = aWords.join(""), bJoin = bWords.join("");
  if (!alnum(aJoin) && !alnum(bJoin)) return true;
  if (aJoin === bJoin) return true;
  if (translateConfusable(aJoin) === translateConfusable(bJoin)) return true;
  if ((tag === "insert" || tag === "delete") &&
      (alnum(aJoin) + alnum(bJoin)).length < 4) return true;
  return false;
}

export function textMismatches(refWords: Word[], testWords: Word[]): TextMismatch[] {
  const a = refWords.map((w) => w.text);
  const b = testWords.map((w) => w.text);
  const sm = new SequenceMatcher(a, b);
  const out: TextMismatch[] = [];
  for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
    if (tag === "equal") continue;
    const refSeg = a.slice(i1, i2);
    const testSeg = b.slice(j1, j2);
    if (trivialDiff(tag, refSeg, testSeg)) continue;
    const boxes: BBox[] = [];
    for (let j = j1; j < j2; j++) boxes.push(testWords[j].bbox);
    if (!boxes.length) for (let i = i1; i < i2; i++) boxes.push(refWords[i].bbox);
    const xs = boxes.map((b2) => b2[0]);
    const ys = boxes.map((b2) => b2[1]);
    const x2 = boxes.map((b2) => b2[0] + b2[2]);
    const y2 = boxes.map((b2) => b2[1] + b2[3]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    out.push({
      bbox: [minX, minY, Math.max(...x2) - minX, Math.max(...y2) - minY],
      refText: refSeg.join(" "),
      testText: testSeg.join(" "),
      tag,
    });
  }
  return out;
}

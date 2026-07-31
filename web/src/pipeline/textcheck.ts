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
  // 대소문자만 다른 경우 ('for' vs 'For', 'AST' vs 'ast') — 인쇄 결함은 글자
  // 모양을 훼손하지 그 자체를 대문자로 바꾸지 않는다. 진짜 글리프 훼손이라면
  // 잉크 diff 경로가 잡는다. (구두점 차이는 여기서 무시하지 않는다 — 빠진
  // 마침표는 실제 결함일 수 있어 계속 보고한다.)
  if (translateConfusable(aJoin.toLowerCase()) ===
      translateConfusable(bJoin.toLowerCase())) return true;
  if ((tag === "insert" || tag === "delete") &&
      (alnum(aJoin) + alnum(bJoin)).length < 4) return true;
  // 단어 조각 오독 — 한쪽이 다른 쪽의 부분 문자열인 1~2자 조각이면 인쇄 결함이
  // 아니라 판독 실패다. 뒷비침·저대비가 겹친 줄에서 OCR이 단어 앞부분을 놓치고
  // 끝 글자만 남기는 일이 있다(실측: tesseract.js가 "Owner's"를 "s"로만 읽어
  // 이 엔진에만 오탐이 났다). 단어가 실제로 지워졌다면 잉크 diff가 훨씬 큰
  // 면적으로 잡는다.
  if (tag === "replace") {
    const aN = alnum(aJoin).toLowerCase(), bN = alnum(bJoin).toLowerCase();
    const [short, long] = aN.length <= bN.length ? [aN, bN] : [bN, aN];
    if (short.length > 0 && short.length <= 2 && long.includes(short)) return true;
  }
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

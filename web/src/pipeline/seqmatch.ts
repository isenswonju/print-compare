// Python difflib.SequenceMatcher(autojunk=False) 포트 — get_opcodes()까지.
// 텍스트 대조 결과가 Python판과 동일해야 하므로 알고리즘을 그대로 옮겼다.
export type Opcode = [tag: string, i1: number, i2: number, j1: number, j2: number];
type Block = [number, number, number];

export class SequenceMatcher {
  private a: string[];
  private b: string[];
  private b2j: Map<string, number[]>;
  private matchingBlocks: Block[] | null = null;

  constructor(a: string[], b: string[]) {
    this.a = a;
    this.b = b;
    this.b2j = new Map();
    b.forEach((elt, i) => {
      const l = this.b2j.get(elt);
      if (l) l.push(i);
      else this.b2j.set(elt, [i]);
    });
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i]) || [];
      for (const j of indices) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // junk 없음(autojunk=False, isjunk=None)이므로 확장 단계는 동일 원소 확장만.
    // 이 경우 위 j2len DP가 이미 최장 연속 일치를 찾으므로 아래 확장 루프의 본문은
    // 절대 실행되지 않는다(조건이 항상 거짓). CPython difflib와의 1:1 포트를 위해
    // 코드는 남겨두되, 도달 불가라 커버리지에서 제외한다.
    /* v8 ignore start */
    while (besti > alo && bestj > blo && this.a[besti - 1] === this.b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi &&
           this.a[besti + bestsize] === this.b[bestj + bestsize]) {
      bestsize++;
    }
    /* v8 ignore stop */
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Block[] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    // 블록들은 a에서 서로 겹치지 않는 구간이라 x[0]가 같은 경우는 없다 →
    // 타이브레이크(|| x[1]-y[1])는 difflib와의 동치를 위해 두되 도달하지 않는다.
    /* v8 ignore start */
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    /* v8 ignore stop */
    // 인접 블록 병합
    let i1 = 0, j1 = 0, k1 = 0;
    const merged: Block[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) merged.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    this.matchingBlocks = merged;
    return merged;
  }

  getOpcodes(): Opcode[] {
    let i = 0, j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return answer;
  }
}

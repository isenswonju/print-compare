"""OCR text_mismatch 억제 규칙 후보의 효과를 실제 라벨로 정량 측정한다.

피드백 기반 튜닝의 근거 자료를 만드는 도구다. 파이프라인을 한 번만 돌려
OCR 단어 목록을 캐시하고, 그 위에서 규칙 후보들을 갈아끼우며 어떤 오탐이
사라지는지 센다. (엔진을 고치기 전에 효과와 부작용을 먼저 본다.)

사용:
    python tools/ocr_rules_eval.py <REF.png> <TEST.png> [--cache <json>]
"""
from __future__ import annotations

import argparse
import difflib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import compare_artwork as ca  # noqa: E402


def load_words(ref: Path, test: Path, cache: Path | None):
    """REF와 (정합된) TEST의 OCR 단어 목록. 파이프라인과 같은 순서로 만든다.

    OCR이 편당 ~60초라 캐시가 있으면 재사용한다.
    """
    if cache and cache.exists():
        d = json.loads(cache.read_text())
        return d["ref"], d["test"]
    cfg = ca.Config()
    ref_img = ca.imread_gray(ref)
    test_img = ca.imread_gray(test)
    aligned = ca.global_align(ref_img, test_img, cfg)
    if cfg.use_tile_refine:
        aligned = ca.tile_refine(ref_img, aligned, cfg, None)
    words = {"ref": ca.ocr_words(ref_img, cfg),
             "test": ca.ocr_words(aligned, cfg)}
    if cache:
        cache.write_text(json.dumps(words))
    return words["ref"], words["test"]


# ---------------------------------------------------------------- 규칙 후보
def fold_confusable(s: str) -> str:
    return s.translate(ca._CONFUSABLE)


def rule_base(tag, a, b) -> bool:
    """현재 배포된 규칙(대소문자 접기 포함)."""
    return ca._trivial_diff(tag, a, b)


def rule_punct(tag, a, b) -> bool:
    """추가 후보 A — 영숫자 내용이 같으면 무시(구두점·기호 차이 허용)."""
    if rule_base(tag, a, b):
        return True
    aj, bj = "".join(a), "".join(b)
    return (fold_confusable(ca._alnum(aj).lower())
            == fold_confusable(ca._alnum(bj).lower()))


def rule_sharp_s(tag, a, b) -> bool:
    """추가 후보 B — 확장 로마자 ß를 B/8 혼동 클래스에 넣는다."""
    if rule_base(tag, a, b):
        return True
    tr = str.maketrans({"ß": "8", "B": "8", "b": "8"})
    aj, bj = "".join(a).translate(tr), "".join(b).translate(tr)
    return fold_confusable(aj.lower()) == fold_confusable(bj.lower())


def rule_c_zero(tag, a, b) -> bool:
    """추가 후보 C — C/c를 0/O 혼동 클래스에 넣는다('°C' vs '°0')."""
    if rule_base(tag, a, b):
        return True
    tr = str.maketrans({"C": "0", "c": "0"})
    aj, bj = "".join(a).translate(tr), "".join(b).translate(tr)
    return fold_confusable(aj.lower()) == fold_confusable(bj.lower())


def rule_all(tag, a, b) -> bool:
    """A+B+C 모두 적용."""
    return (rule_punct(tag, a, b) or rule_sharp_s(tag, a, b)
            or rule_c_zero(tag, a, b))


def rule_prev(tag, a, b) -> bool:
    """수정 전 규칙 — 대소문자 접기 없음(비교 기준)."""
    aj, bj = "".join(a), "".join(b)
    if not ca._alnum(aj) and not ca._alnum(bj):
        return True
    if aj == bj:
        return True
    if fold_confusable(aj) == fold_confusable(bj):
        return True
    if tag in ("insert", "delete") and len(ca._alnum(aj) + ca._alnum(bj)) < 4:
        return True
    return False


RULES = [
    ("수정 전(기준)", rule_prev),
    ("현재(대소문자 접기)", rule_base),
    ("+A 구두점 무시", rule_punct),
    ("+B ß↔B 혼동", rule_sharp_s),
    ("+C C↔0 혼동", rule_c_zero),
    ("+A+B+C 전부", rule_all),
]


def mismatches_under(rule, ref_words, test_words):
    a = [w["text"] for w in ref_words]
    b = [w["text"] for w in test_words]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        ref_seg, test_seg = a[i1:i2], b[j1:j2]
        if rule(tag, ref_seg, test_seg):
            continue
        boxes = [test_words[j]["bbox"] for j in range(j1, j2)] or \
                [ref_words[i]["bbox"] for i in range(i1, i2)]
        xs = [bx for bx, _, _, _ in boxes]
        ys = [by for _, by, _, _ in boxes]
        x2 = [bx + bw for bx, _, bw, _ in boxes]
        y2 = [by + bh for _, by, _, bh in boxes]
        out.append({
            "bbox": (min(xs), min(ys), max(x2) - min(xs), max(y2) - min(ys)),
            "ref": " ".join(ref_seg), "test": " ".join(test_seg), "tag": tag,
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("test")
    ap.add_argument("--cache")
    args = ap.parse_args()
    cache = Path(args.cache) if args.cache else None
    ref_words, test_words = load_words(Path(args.ref), Path(args.test), cache)
    print(f"OCR 단어: REF {len(ref_words)} / TEST {len(test_words)}\n")

    base = mismatches_under(rule_prev, ref_words, test_words)
    for name, rule in RULES:
        got = mismatches_under(rule, ref_words, test_words)
        removed = len(base) - len(got)
        print(f"{name:22} text_mismatch {len(got):3}건"
              + (f"  (수정 전 대비 -{removed})" if removed else ""))

    print("\n수정 전 규칙에서 나오던 text_mismatch (면적 큰 순):")
    for m in sorted(base, key=lambda m: -m["bbox"][2] * m["bbox"][3]):
        x, y, w, h = m["bbox"]
        surv = [n for n, r in RULES[1:]
                if m not in mismatches_under(r, ref_words, test_words)]
        tag = f"  ← {'/'.join(surv)}로 제거" if surv else ""
        print(f"  {w:5}x{h:4} ({x:5},{y:5})  '{m['ref']}' → '{m['test']}'{tag}")


if __name__ == "__main__":
    main()

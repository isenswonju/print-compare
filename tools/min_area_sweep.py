"""min_area 임계값 트레이드오프 표 — 작은 결함 검출 vs 오탐 증가.

미검출 가혹 테스트에서 면적 40~60px대 결함(마침표 삭제·획 끊김·미세 스팟)이
전부 놓쳤다. min_area를 낮추면 잡히지만 오탐이 늘어난다. 얼마나 늘어나는지를
회귀 픽스처(정답 9건이 확정된 쌍)로 실측해 고를 수 있게 한다.

사용:
    python tools/min_area_sweep.py [--areas 60,40,30,20,15]
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_artwork import Config, run_pipeline  # noqa: E402
from tools.recall_stress import REF, inject  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIX_REF = ROOT / "tests" / "fixtures" / "PGA1E0398_REF.png"
FIX_TEST = ROOT / "tests" / "fixtures" / "PGA1E0398_TEST.png"

# tests/test_fixture.py의 수락 기준과 같은 정답 목록(9건).
EXPECTED = [
    (1, {"extra"}, (1520, 670, 200, 170)),
    (2, {"extra", "text_mismatch"}, (4900, 700, 100, 60)),
    (3, {"extra"}, (4850, 1215, 130, 140)),
    (4, {"extra", "text_mismatch"}, (3390, 2635, 130, 130)),
    (5, {"extra"}, (1700, 2960, 40, 40)),
    (6, {"showthrough"}, (512, 5469, 2157, 606)),
    (7, {"extra"}, (1330, 6340, 160, 90)),
    (8, {"extra", "text_mismatch"}, (3930, 6090, 190, 80)),
    (9, {"extra", "text_mismatch"}, (3950, 4695, 140, 70)),
]
TOL = 80

# 가혹 테스트에서 놓친 작은 결함들
SMALL_KINDS = ["spot_tiny", "erase_period", "thin_stroke"]


def center(b):
    x, y, w, h = b
    return x + w / 2, y + h / 2


def match(f, exp_bbox):
    cx, cy = center(f.bbox_ref)
    x, y, w, h = exp_bbox
    return (x - TOL <= cx <= x + w + TOL) and (y - TOL <= cy <= y + h + TOL)


def score_fixture(cfg, tmp):
    findings = run_pipeline(FIX_REF, FIX_TEST, tmp / "out", cfg)
    shown = [f for f in findings
             if f.type != "trim_mark_expected" and f.severity != "expected"]
    hit_ids, matched = [], set()
    for num, types, bbox in EXPECTED:
        for f in shown:
            if f.type in types and match(f, bbox):
                hit_ids.append(num)
                matched.add(id(f))
                break
    fp = [f for f in shown if id(f) not in matched]
    return len(hit_ids), len(fp), sorted(set(range(1, 10)) - set(hit_ids))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--areas", default="60,40,30,20,15")
    args = ap.parse_args()
    areas = [int(a) for a in args.areas.split(",")]

    ref = cv2.imread(str(REF), cv2.IMREAD_GRAYSCALE)
    tmp = Path(tempfile.mkdtemp(prefix="sweep-"))
    ref_path = tmp / "ref.png"
    cv2.imwrite(str(ref_path), ref)
    small = {}
    for kind in SMALL_KINDS:
        img, exp, desc = inject(ref, kind, ref)
        p = tmp / f"{kind}.png"
        cv2.imwrite(str(p), img)
        small[kind] = (p, exp, desc)

    print(f"{'min_area':>9} │ {'픽스처 정답':^12} │ {'오탐':^5} │ 작은 결함 검출")
    print("─" * 78)
    for area in areas:
        cfg = Config(use_ocr=False, min_area=area)
        hits, fp, missed = score_fixture(cfg, tmp)
        caught = []
        for kind, (p, exp, desc) in small.items():
            fs = run_pipeline(ref_path, p, tmp / "out", cfg)
            ok = any(f.type in ("extra", "missing") and
                     f.bbox_ref[0] < exp[0] + exp[2] + 90 and
                     f.bbox_ref[0] + f.bbox_ref[2] > exp[0] - 90 and
                     f.bbox_ref[1] < exp[1] + exp[3] + 90 and
                     f.bbox_ref[1] + f.bbox_ref[3] > exp[1] - 90
                     for f in fs)
            caught.append(f"{desc.split('(')[0].strip()}:{'○' if ok else '✗'}")
        miss = f" (놓친 정답 {missed})" if missed else ""
        print(f"{area:>9} │ {hits:>5}/9{'':6} │ {fp:>5} │ {'  '.join(caught)}{miss}")
    print("\n※ 오탐은 픽스처 기준(수락 한도 5건). OCR은 끔(픽셀 경로만).")
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()

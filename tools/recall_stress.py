"""미검출 가혹 테스트 — 알려진 결함을 심어 넣고 엔진이 놓치는지 본다.

의료기기 라벨 검수에서 오탐은 사람이 걸러낼 수 있지만 **미검출은 통과되어
나간다**. 그래서 이 테스트의 판정 기준은 단 하나: 심어 넣은 결함을 잡았는가.

두 단계로 돌린다.
  tier 1 (clean)     — REF를 그대로 복사한 뒤 결함만 심는다. 여기서 놓치면
                       임계값·필터가 확실히 잘못된 것이다(하한선 검사).
  tier 2 (degraded)  — 전체에 블러+노이즈+톤 저하를 먹여 실제 인쇄물처럼 만든
                       뒤 결함을 심는다. 질감 차이가 결함을 덮어버리는지 본다
                       — 실전에서 미검출이 나는 조건이다.

사용:
    python tools/recall_stress.py                 # 전부
    python tools/recall_stress.py --tier clean    # 한 단계만
    python tools/recall_stress.py --no-ocr        # 픽셀 경로만(빠름)
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_artwork import Config, run_pipeline  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
REF = FIXTURES / "PGA1E0398_REF.png"

# 결함을 심을 좌표 — REF에서 글자·괘선이 있는 영역(육안 확인한 본문 영역).
TEXT_AREA = (1500, 2900)      # 본문 문단
TEXT_AREA2 = (3300, 2670)     # 'Results' 부근
NUM_AREA = (4820, 710)        # '2025-04' 로트/개정 행
BLANK_AREA = (2700, 4200)     # 여백


# 주입 위치를 픽셀로 검증한다 — 검은 글자 위에 검은 점을 찍으면 애초에 차이가
# 생기지 않아 "미검출"이 엔진 탓인지 테스트 탓인지 구분할 수 없다.
def find_white(img: np.ndarray, near: tuple, w: int, h: int) -> tuple:
    """near 주변에서 완전히 흰(≥245) w×h 창을 찾는다."""
    x0, y0 = near
    for dy in range(0, 900, 10):
        for dx in range(0, 900, 10):
            for sy in (1, -1):
                for sx in (1, -1):
                    x, y = x0 + sx * dx, y0 + sy * dy
                    if x < 0 or y < 0 or y + h >= img.shape[0] or x + w >= img.shape[1]:
                        continue
                    if img[y:y + h, x:x + w].min() >= 245:
                        return x, y
    raise RuntimeError(f"흰 영역을 못 찾음 near={near}")


def find_ink(img: np.ndarray, near: tuple, w: int, h: int,
             min_ink_ratio: float = 0.18) -> tuple:
    """near 주변에서 잉크(≤100)가 충분히 찬 w×h 창을 찾는다(글자 위)."""
    x0, y0 = near
    for dy in range(0, 900, 6):
        for dx in range(0, 1200, 6):
            for sy in (1, -1):
                for sx in (1, -1):
                    x, y = x0 + sx * dx, y0 + sy * dy
                    if x < 0 or y < 0 or y + h >= img.shape[0] or x + w >= img.shape[1]:
                        continue
                    roi = img[y:y + h, x:x + w]
                    if (roi <= 100).mean() >= min_ink_ratio:
                        return x, y
    raise RuntimeError(f"잉크 영역을 못 찾음 near={near}")


def inject(img: np.ndarray, kind: str,
           ref: np.ndarray) -> tuple[np.ndarray, tuple, str]:
    """결함을 심고 (이미지, 기대 bbox, 설명)을 돌려준다.

    위치는 원본 REF(ref)를 기준으로 찾는다 — degraded tier에서도 같은 자리에
    같은 결함이 들어가야 두 단계를 비교할 수 있다.
    """
    out = img.copy()
    if kind == "spot_tiny":       # 잉크 스팟(아주 작음) — 최소 면적 경계 근처
        x, y = find_white(ref, BLANK_AREA, 20, 20)
        cv2.circle(out, (x + 10, y + 10), 4, 0, -1)
        return out, (x, y, 20, 20), "여백 잉크 스팟 r=4px(면적 50px)"
    if kind == "spot_small":
        x, y = find_white(ref, (BLANK_AREA[0] + 300, BLANK_AREA[1]), 30, 30)
        cv2.circle(out, (x + 15, y + 15), 8, 0, -1)
        return out, (x, y, 30, 30), "여백 잉크 스팟 r=8px(면적 201px)"
    if kind == "spot_near_text":  # 글자 사이 여백에 잉크 오염
        x, y = find_white(ref, TEXT_AREA, 18, 18)
        cv2.circle(out, (x + 9, y + 9), 6, 0, -1)
        return out, (x, y, 18, 18), "글자 사이 여백 잉크 오염 r=6px(면적 113px)"
    if kind == "erase_char":      # 글자 1자 미인쇄
        x, y = find_ink(ref, TEXT_AREA, 30, 40, 0.25)
        out[y:y + 40, x:x + 30] = 255
        return out, (x, y, 30, 40), "글자 1자 미인쇄(30x40 백색)"
    if kind == "erase_word":      # 단어 통째 미인쇄
        x, y = find_ink(ref, TEXT_AREA2, 200, 45, 0.15)
        out[y:y + 45, x:x + 200] = 255
        return out, (x, y, 200, 45), "단어 미인쇄(200x45 백색)"
    if kind == "erase_line":      # 한 줄 통째 미인쇄
        x, y = find_ink(ref, TEXT_AREA, 900, 40, 0.10)
        out[y:y + 40, x:x + 900] = 255
        return out, (x, y, 900, 40), "한 줄 미인쇄(900x40 백색)"
    if kind == "erase_period":    # 아주 작은 잉크 삭제(마침표 크기)
        x, y = find_ink(ref, TEXT_AREA, 8, 8, 0.60)
        out[y:y + 8, x:x + 8] = 255
        return out, (x - 2, y - 2, 12, 12), "마침표 크기 잉크 삭제(8x8, 면적 ~38px)"
    if kind == "fill_glyph":      # 글자 속 빈 공간 메워짐(C→O, 0 메워짐)
        x, y = find_white(ref, NUM_AREA, 20, 20)
        cv2.circle(out, (x + 10, y + 10), 7, 0, -1)
        return out, (x, y, 20, 20), "숫자 행 메워짐 r=7px(면적 154px)"
    if kind == "thin_stroke":     # 획 일부 끊김(가는 선 삭제)
        x, y = find_ink(ref, TEXT_AREA, 4, 20, 0.70)
        out[y:y + 20, x:x + 4] = 255
        return out, (x - 3, y - 3, 10, 26), "획 끊김(4x20, 면적 ~56px)"
    if kind == "shift_block":     # 국소 이동(정합 어긋남과 구분되어야 함)
        x, y = find_ink(ref, TEXT_AREA2, 300, 50, 0.12)
        blk = out[y:y + 50, x:x + 300].copy()
        out[y:y + 50, x:x + 300] = 255
        out[y + 6:y + 56, x:x + 300] = blk
        return out, (x, y, 300, 56), "블록 6px 아래로 이동"
    if kind == "faded_word":      # 단어가 옅게 인쇄됨(미인쇄는 아님)
        x, y = find_ink(ref, TEXT_AREA2, 200, 45, 0.15)
        roi = out[y:y + 45, x:x + 200]
        out[y:y + 45, x:x + 200] = (roi.astype(np.float32) * 0.35 + 165).clip(
            0, 255).astype(np.uint8)
        return out, (x, y, 200, 45), "단어 옅은 인쇄(잉크가 회색 165)"
    raise ValueError(kind)


KINDS = ["spot_tiny", "spot_small", "spot_near_text", "erase_char", "erase_word",
         "erase_line", "erase_period", "fill_glyph", "thin_stroke",
         "shift_block", "faded_word"]


def degrade(img: np.ndarray, seed: int = 7) -> np.ndarray:
    """실제 인쇄물처럼 질감을 떨어뜨린다 — 약한 블러 + 노이즈 + 톤 저하."""
    rng = np.random.default_rng(seed)
    out = cv2.GaussianBlur(img, (3, 3), 0.8)
    noise = rng.normal(0, 6, out.shape).astype(np.float32)
    out = (out.astype(np.float32) * 0.94 + 10 + noise).clip(0, 255)
    return out.astype(np.uint8)


def hit(findings, exp, tol=90) -> list:
    """기대 bbox를 tol만큼 넓힌 영역과 겹치는 결함(표시 대상만)."""
    ex, ey, ew, eh = exp
    x0, y0, x1, y1 = ex - tol, ey - tol, ex + ew + tol, ey + eh + tol
    got = []
    for f in findings:
        if f.type in ("showthrough", "trim_mark_expected", "layout_reflow"):
            continue
        if f.severity == "expected":
            continue
        fx, fy, fw, fh = f.bbox_ref
        if fx < x1 and fx + fw > x0 and fy < y1 and fy + fh > y0:
            got.append(f)
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=["clean", "degraded", "both"],
                    default="both")
    ap.add_argument("--no-ocr", action="store_true")
    ap.add_argument("--kinds", help="쉼표로 구분한 결함 종류(기본 전체)")
    args = ap.parse_args()
    kinds = args.kinds.split(",") if args.kinds else KINDS
    tiers = ["clean", "degraded"] if args.tier == "both" else [args.tier]

    ref = cv2.imread(str(REF), cv2.IMREAD_GRAYSCALE)
    cfg = Config(use_ocr=not args.no_ocr)
    tmp = Path(tempfile.mkdtemp(prefix="recall-"))
    ref_path = tmp / "ref.png"
    cv2.imwrite(str(ref_path), ref)

    print(f"REF {ref.shape[1]}x{ref.shape[0]} · OCR={'끔' if args.no_ocr else '켬'}"
          f" · 결함 {len(kinds)}종 × {len(tiers)}단계\n")
    misses = []
    for tier in tiers:
        base = ref if tier == "clean" else degrade(ref)
        print(f"── tier: {tier}" +
              ("" if tier == "clean" else " (전체 블러+노이즈+톤 저하)"))
        for kind in kinds:
            test, exp, desc = inject(base, kind, ref)
            tp = tmp / f"{tier}_{kind}.png"
            cv2.imwrite(str(tp), test)
            findings = run_pipeline(ref_path, tp, tmp / "out", cfg)
            got = hit(findings, exp)
            shown = [f for f in findings
                     if f.type not in ("showthrough", "trim_mark_expected",
                                       "layout_reflow")
                     and f.severity != "expected"]
            mark = "검출" if got else "미검출 ❌"
            kinds_str = ",".join(sorted({f.type for f in got})) or "-"
            print(f"  {mark:8} {desc:32} 유형={kinds_str:24} "
                  f"전체표시={len(shown)}건")
            if not got:
                misses.append((tier, desc))
            tp.unlink()
    print()
    if misses:
        print(f"❌ 미검출 {len(misses)}건:")
        for t, d in misses:
            print(f"   [{t}] {d}")
    else:
        print("✅ 심어 넣은 결함 전부 검출")
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if misses else 0


if __name__ == "__main__":
    sys.exit(main())

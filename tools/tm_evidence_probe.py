"""text_mismatch 픽셀 증거 실측 — back-pair TEST-1 사용자 판정 대조용 일회성 프로브.

각 OCR 불일치 후보에 대해 diff blob(뭉친 잉크 덩어리) 크기를 재서,
실결함/오탐을 가르는 경계값을 데이터로 정한다.
"""
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from compare_artwork import (Config, imread_gray, global_align, tile_refine,
                             flatten_background, ink_mask, ocr_words,
                             text_mismatches, pixel_evidence, ellipse)

PAIR = ROOT / "private" / "bench-cases" / "back-pair"

# 사용자 판정 (2026-08-03): finding id → 라벨. text_mismatch id 만.
REAL = {9, 10, 11, 12}
FP = {3, 5, 6, 7, 8, 16, 17, 18, 19, 21, 22, 23, 24, 25}


def blob_stats(mm, ref_ink, test_ink, pad_x=40, pad_y=10):
    x, y, w, h = mm["bbox"]
    hh, ww = ref_ink.shape
    x0, y0 = max(x - pad_x, 0), max(y - pad_y, 0)
    x1, y1 = min(x + w + pad_x, ww), min(y + h + pad_y, hh)
    r, t = ref_ink[y0:y1, x0:x1], test_ink[y0:y1, x0:x1]
    k3 = ellipse(3)
    d = cv2.bitwise_or(
        cv2.bitwise_and(t, cv2.bitwise_not(cv2.dilate(r, k3))),
        cv2.bitwise_and(r, cv2.bitwise_not(cv2.dilate(t, k3))))
    n, _, stats, _ = cv2.connectedComponentsWithStats(d, connectivity=8)
    areas = sorted((int(a) for a in stats[1:, cv2.CC_STAT_AREA]), reverse=True)
    return areas[:5], int(d.sum() // 255)


def main():
    cfg = Config()
    ref = imread_gray(PAIR / "REF.png")
    test = imread_gray(PAIR / "TEST-1.png")
    aligned = global_align(ref, test, cfg)
    aligned = tile_refine(ref, aligned, cfg, None)
    norm_test = flatten_background(aligned, cfg)
    ref_ink = ink_mask(ref, cfg)
    test_ink = ink_mask(norm_test, cfg)
    ref_words = ocr_words(ref, cfg)
    test_words = ocr_words(aligned, cfg)

    print(f"{'라벨':4} {'tag':7} {'top blobs':28} {'총px':>6}  bbox/텍스트")
    for mm in text_mismatches(ref_words, test_words):
        if not pixel_evidence(mm, ref_ink, test_ink)[0]:
            continue  # 현행 엔진이 이미 거르는 것은 제외
        blobs, tot = blob_stats(mm, ref_ink, test_ink)
        print(f"{'':4} {mm['tag']:7} {str(blobs):28} {tot:>6}  "
              f"{mm['bbox']}  '{mm['ref_text'][:30]}'→'{mm['test_text'][:30]}'")


if __name__ == "__main__":
    main()

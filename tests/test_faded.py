"""인쇄 농도 검사(3.4b) 회귀 — 옅게 인쇄된 글자를 잡고, 전체가 옅으면 통과.

미검출 가혹 테스트(tools/recall_stress.py)에서 "단어 하나가 통째로 흐리게
인쇄됨"이 9000px 크기인데도 0건이던 것을 막기 위한 가드다. 작은 합성 이미지로
빠르게 돌린다(실물 라벨 검증은 recall_stress.py 담당).
"""

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_artwork import (Config, content_bbox_of, faded_findings,  # noqa: E402
                            ink_mask)


def make_page(fade_box=None, fade_all=False):
    """흰 배경에 글자 블록을 격자로 찍은 합성 페이지.

    fade_box: (x, y, w, h) 이 영역만 옅게 (국소 결함)
    fade_all: 페이지 전체를 옅게 (전체 인쇄 질감 저하 — 결함 아님)
    """
    img = np.full((600, 900), 255, np.uint8)
    for row in range(6):
        for col in range(9):
            x, y = 40 + col * 95, 40 + row * 95
            cv2.rectangle(img, (x, y), (x + 60, y + 55), 0, -1)
            # 글자처럼 속을 비워 획 형태를 만든다
            cv2.rectangle(img, (x + 14, y + 14), (x + 46, y + 41), 255, -1)
    if fade_all:
        img = (img.astype(np.float32) * 0.45 + 140).clip(0, 255).astype(np.uint8)
    if fade_box:
        x, y, w, h = fade_box
        roi = img[y:y + h, x:x + w].astype(np.float32)
        img[y:y + h, x:x + w] = (roi * 0.35 + 165).clip(0, 255).astype(np.uint8)
    return img


def hits(ref, test):
    cfg = Config(use_ocr=False)
    ref_ink, test_ink = ink_mask(ref, cfg), ink_mask(test, cfg)
    cbox = content_bbox_of(ref_ink)
    return faded_findings(ref_ink, test_ink, ref, test, cfg, cbox)


def test_identical_pages_have_no_faded():
    ref = make_page()
    assert hits(ref, ref.copy()) == []


def test_locally_faded_block_is_detected():
    ref = make_page()
    test = make_page(fade_box=(120, 120, 130, 130))
    got = hits(ref, test)
    assert got, "국소적으로 옅게 인쇄된 글자를 잡지 못했다"
    # 검출 위치가 옅게 만든 영역과 겹쳐야 한다
    assert any(x < 250 and x + w > 120 and y < 250 and y + h > 120
               for x, y, w, h in (g["bbox"] for g in got))
    assert all(g["dark_ratio"] < 1.0 for g in got)


def test_globally_faded_page_is_not_reported():
    """전체가 옅으면(인쇄 질감 차이) 결함이 아니다 — 페이지 중앙값 대비 판정."""
    ref = make_page()
    test = make_page(fade_all=True)
    assert hits(ref, test) == [], "전체적인 농도 저하를 결함으로 보고했다"


def test_globally_faded_still_finds_local_anomaly():
    """전체가 옅은 상태에서도 유독 더 옅은 부분은 잡는다."""
    ref = make_page()
    test = make_page(fade_box=(120, 120, 130, 130), fade_all=True)
    assert hits(ref, test), "전체 저하 + 국소 결함 조합에서 국소분을 놓쳤다"

"""아트웍 성질 기록 — 새 원본이 우리 픽스처와 어떻게 다른지 한 줄로 남긴다.

케이스가 늘어나면 "이 원본은 뭐가 달라서 결과가 다른가"를 매번 다시 조사하게
된다. 들여올 때 재서 케이스 note 에 적어 두면 그 조사를 안 해도 된다.

재는 것은 둘이다.
* **큰 솔리드 잉크 영역**(배경 평탄화 커널 81px보다 두꺼운 덩어리) — 농도 검사가
  보지 않는 영역이다(적응 임계값이 큰 덩어리의 안쪽을 잉크로 잡지 않는다).
  다만 실측(2026-07-31) 결과 픽셀 diff 가 그 안의 결손·옅은 인쇄를 잡는다:
  200px 두께 바 안의 흰 반점 r=12 → extra 1880px 검출, 바 전체를 회색 120/180으로
  옅게 인쇄 → missing 32844px 검출. 즉 "검출 사각지대"가 아니라 "농도 경로가
  담당하지 않는 영역"이다.
* **회색 톤 비율**(190~235) — 망점 박스처럼 옅은 톤이 많은 원본은 농도 검사가
  예민해질 수 있는 자리다(2026-07-30 오탐 15건의 원인이 이 톤이었다).
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from compare_artwork import Config, ellipse, imread_gray, ink_mask

SOLID_DARK_MAX = 128       # 이보다 어두우면 솔리드 잉크로 본다
GRAY_TONE = (190, 235)     # 망점·톤 박스로 보는 밝기 구간


def profile(path: Path, cfg: Config | None = None) -> dict:
    cfg = cfg or Config()
    img = imread_gray(path)
    h, w = img.shape[:2]
    ink_px = int(cv2.countNonZero(ink_mask(img, cfg)))

    # 적응 임계값은 큰 솔리드의 안쪽을 잉크로 잡지 않으므로 회색조에서 직접 잰다.
    dark = ((img <= SOLID_DARK_MAX).astype(np.uint8) * 255)
    core = cv2.erode(dark, ellipse(max(cfg.bg_kernel // 2 * 2 + 1, 3)))
    solid_px = int(cv2.countNonZero(core))
    bbox = None
    if solid_px:
        n, _lab, stats, _c = cv2.connectedComponentsWithStats(core, 8)
        if n > 1:
            i = 1 + int(stats[1:, cv2.CC_STAT_AREA].argmax())
            bbox = [int(stats[i, 0]), int(stats[i, 1]),
                    int(stats[i, 2]), int(stats[i, 3])]

    tone_px = int(((img >= GRAY_TONE[0]) & (img <= GRAY_TONE[1])).sum())
    return {"size": [w, h], "ink_px": ink_px, "solid_px": solid_px,
            "solid_bbox": bbox, "gray_tone_ratio": round(tone_px / (w * h), 4)}


def profile_note(p: dict) -> str:
    """케이스 note 에 붙일 한 줄(사실만 — 판단은 결과가 나온 뒤에 한다)."""
    bits = [f"{p['size'][0]}x{p['size'][1]}",
            f"회색 톤 {p['gray_tone_ratio'] * 100:.1f}%"]
    if p["solid_px"]:
        bits.append(f"큰 솔리드 잉크 {p['solid_px']}px(bbox={p['solid_bbox']}) "
                    f"— 농도 검사는 이 영역을 보지 않는다(픽셀 diff가 담당)")
    else:
        bits.append("큰 솔리드 잉크 없음")
    return " · ".join(bits)


__all__ = ["profile", "profile_note", "SOLID_DARK_MAX", "GRAY_TONE"]

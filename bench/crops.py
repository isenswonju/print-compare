"""표류·오탐 항목의 REF/TEST 크롭 저장 — 눈으로 1분 안에 판정하기 위한 것.

리포트가 `faded/minor [534, 502, 4491, 184]` 라고만 알려주면 사람은 결국 엔진을
다시 돌려 확인해야 한다. 그래서 판정이 필요한 항목마다 REF와 TEST의 같은 자리를
나란히 붙여 `bench/out/crops/<케이스>/`에 남긴다(생성물이라 git 제외).

정합된 TEST(`aligned_test.png`)가 있으면 그것을 쓴다 — 스캔 스큐가 남은 원본
TEST를 같은 좌표로 자르면 엉뚱한 자리가 나온다.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

PAD = 80             # 크롭 여유(px) — 문맥이 없으면 무엇을 보는지 알 수 없다
MAX_PER_CASE = 12    # 한 케이스에서 너무 많이 뽑으면 아무도 안 본다
LABEL_H = 28


def _crop(img: np.ndarray, bbox, pad: int) -> np.ndarray:
    x, y, w, h = (int(v) for v in bbox)
    h_img, w_img = img.shape[:2]
    x0, y0 = max(x - pad, 0), max(y - pad, 0)
    x1, y1 = min(x + w + pad, w_img), min(y + h + pad, h_img)
    if x1 <= x0 or y1 <= y0:
        return np.full((LABEL_H, LABEL_H), 220, np.uint8)
    out = img[y0:y1, x0:x1].copy()
    # 대상 위치를 박스로 표시(문맥 안에서 어디를 봐야 하는지)
    cv2.rectangle(out, (x - x0, y - y0), (x - x0 + w, y - y0 + h), 0, 2)
    return out


def _tagged(crop: np.ndarray, text: str) -> np.ndarray:
    bar = np.full((LABEL_H, crop.shape[1]), 255, np.uint8)
    cv2.putText(bar, text, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 1,
                cv2.LINE_AA)
    return np.vstack([bar, crop])


def save_crops(case_id: str, ref_path: Path, test_path: Path,
               artifacts: Path | None, items: list[dict], out_root: Path,
               pad: int = PAD, limit: int = MAX_PER_CASE) -> list[str]:
    """items: [{tag, bbox, label}] → 저장한 파일의 상대 경로 목록."""
    items = [it for it in items if it.get("bbox")][:limit]
    if not items:
        return []
    ref = cv2.imread(str(ref_path), cv2.IMREAD_GRAYSCALE)
    aligned_path = (artifacts / "aligned_test.png") if artifacts else None
    src = aligned_path if aligned_path and aligned_path.exists() else test_path
    test = cv2.imread(str(src), cv2.IMREAD_GRAYSCALE)
    if ref is None or test is None:
        return []

    out_dir = out_root / "crops" / case_id
    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    for i, it in enumerate(items, 1):
        a = _tagged(_crop(ref, it["bbox"], pad), "REF")
        b = _tagged(_crop(test, it["bbox"], pad),
                    "TEST(정합)" if src != test_path else "TEST")
        h = max(a.shape[0], b.shape[0])
        pair = np.full((h, a.shape[1] + b.shape[1] + 8), 255, np.uint8)
        pair[:a.shape[0], :a.shape[1]] = a
        pair[:b.shape[0], a.shape[1] + 8:] = b
        name = f"{it.get('tag', 'item')}-{i}.png"
        if cv2.imwrite(str(out_dir / name), pair):
            saved.append(f"crops/{case_id}/{name}")
    return saved


def drift_items(sc, drift) -> list[dict]:
    """사람이 눈으로 봐야 하는 항목만 모은다(오탐 · 표류 신규/소실)."""
    items: list[dict] = []
    for f in sc.fps:
        items.append({"tag": "오탐", "bbox": f["bbox"],
                      "label": f"{f['type']}/{f['severity']} {f['note']}"})
    if drift:
        for f in drift.new:
            items.append({"tag": "신규", "bbox": f["bbox"],
                          "label": f"기준선에 없던 {f['type']}"})
        for f in drift.lost:
            items.append({"tag": "소실", "bbox": f["bbox"],
                          "label": f"기준선에 있던 {f['type']}"})
    for zone_id, f in sc.forbid_hits:
        items.append({"tag": "금지영역부활", "bbox": f["bbox"],
                      "label": f"{zone_id} {f['type']}"})
    # 같은 자리를 여러 번 뽑지 않는다
    seen: set[tuple] = set()
    uniq = []
    for it in items:
        key = tuple(it["bbox"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(it)
    return uniq


__all__ = ["save_crops", "drift_items", "MAX_PER_CASE", "PAD"]

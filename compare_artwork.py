#!/usr/bin/env python3
"""compare_artwork.py — 인쇄 아트웍(REF) vs 실물 스캔(TEST) 결함 자동 검출.

승인 아트웍 PNG(REF)와 실물 인쇄 스캔 PNG(TEST)를 정합·비교해 인쇄 결함을
검출/분류하고 annotated.png, contact_sheet.png, findings.json/csv 를 생성한다.
기본 동작은 100% 결정론적(OpenCV). --llm-verify 로 선택적 LLM 검증 훅 사용.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

# ---------------------------------------------------------------------------
# 설정
# ---------------------------------------------------------------------------

REF_BASE_WIDTH = 5564  # min-area 기준 해상도


@dataclass
class Config:
    tol: int = 5                    # 타일 정합 후 diff 팽창 허용치(px)
    tol_fallback: int = 13          # 타일 정합 생략(폴백) 시 허용치
    min_area: int = 40              # REF 폭 5564px 기준 최소 diff 잉크 픽셀 수
                                    # (60→40: 미검출 가혹 테스트에서 50px급 결함을
                                    #  놓쳤고, 40에서는 픽스처 오탐이 늘지 않았다)
    use_ocr: bool = True
    use_tile_refine: bool = True
    llm_verify: bool = False
    debug: bool = False

    # 전역 정합
    orb_features: int = 20000
    lowe_ratio: float = 0.75
    ransac_thresh: float = 3.0
    min_inliers: int = 300
    scale_range: tuple = (0.9, 1.1)
    downscale_long: int = 2000

    # 타일 정합
    tile: int = 768
    overlap: int = 128
    min_response: float = 0.05
    max_shift: float = 20.0

    # 이진화
    bg_kernel: int = 81
    thresh_block: int = 41
    thresh_c: int = 18

    # 군집화
    merge_kernel: int = 31
    margin_ratio: float = 0.06      # 재단선/레지스터 마크 마진

    # 망점(halftone) 오탐 억제 — 실측 튜닝값
    # TP diff 픽셀 평균 밝기 ≤174, 망점/고스트 FP ≥206 (임계 190)
    extra_max_norm: int = 190      # extra: diff 픽셀의 norm_TEST 평균이 이보다 밝으면 망점/고스트
    missing_max_ref: int = 190     # missing: diff 픽셀의 REF 평균이 이보다 밝으면 회색 박스 톤 차이

    # 리플로우(개정 줄 밀림) 억제 — diff 내용이 상대 이미지 근처에 그대로
    # 존재하면(문맥 포함 템플릿 매칭) 결함이 아니라 줄 밀림으로 판정
    reflow_search_y: int = 200     # REF 폭 5564 기준 세로 탐색 반경(px)
    reflow_search_x: int = 60
    reflow_pad: int = 48           # 매칭 문맥 패딩(px)
    reflow_min_corr: float = 0.85
    reflow_exclude: int = 12       # 이 변위 이내 매칭은 정상 정합(억제 대상 아님)
    reflow_min_cover: float = 0.6  # diff 잉크가 변위 위치의 상대 잉크로 덮여야 하는 비율

    # 잉크 커버리지 검사(3.4b) — 얇은 획 끊김 / 옅은 인쇄
    # 판정은 페이지 중앙값 대비 상대값이라, 전체적으로 옅은 인쇄는 통과하고
    # 국소적으로 유독 빠진/흐린 덩어리만 걸린다.
    cover_min_area: int = 120      # 검사 대상 REF 잉크 덩어리 최소 면적(REF 폭 5564 기준)
    cover_merge: int = 3           # 붙은 획만 잇는 최소 팽창(글자 단위 유지)
    cover_pad: int = 3             # TEST를 훑는 여유(px) — 잔여 정합 오차 흡수
    cover_ref_max: int = 190       # 농도 비교 대상 REF 잉크의 밝기 상한(배경 평탄화
                                   # 후 기준 = 배경보다 25% 이상 어두운 픽셀만).
                                   # 회색 톤 박스(210)와 배경 대비 10 남짓인 망점
                                   # 잡티가 잉크로 섞이면, TEST만 평탄화되는 비대칭
                                   # 때문에 통째로 "옅은 인쇄"로 오탐된다
                                   # (안전망 identity 실측: 아트웍 1 + 스캔 11건).
                                   # 근거값은 missing_max_ref와 동일.
    fade_rel: float = 0.70         # 농도비가 페이지 중앙값의 이 배수 미만이면 옅은 인쇄
    fade_abs: float = 0.80         # 동시에 이 절대값 미만일 때만(전체가 옅은 경우 방어)

    # 뒷비침
    ghost_lo: int = 150
    ghost_hi: int = 225
    ghost_blur: int = 7            # 망점 도트 제거용 median blur (획 폭 있는 고스트만 생존)
    ghost_band_hi: int = 214       # blur 후 밴드 상한(회색 박스 평탄값 ~221 제외)
    ghost_ref_white: int = 215     # REF 백색 기준(회색 박스 톤 210 제외)
    ghost_ref_erode: int = 9
    ghost_merge: int = 61
    ghost_min_area: int = 800

    # OCR
    ocr_min_conf: int = 40


@dataclass
class Finding:
    id: int = 0
    type: str = ""       # extra | missing | faded | showthrough | text_mismatch
                         # | trim_mark_expected | layout_reflow
    severity: str = ""   # critical | major | minor | expected
    bbox_ref: tuple = (0, 0, 0, 0)
    area_px: int = 0
    near_text: str = ""
    note: str = ""
    # 임계값 여유도(정확도 안전망용). {"margin": 1.25, "basis": "면적 50 / 최소 40"}
    # margin 1.0 = 임계값에 딱 걸친 상태. 통과했는데 마진이 줄어드는 변경은
    # "아직 안 터진 회귀"이므로 bench 가 WARN 으로 잡는다. 연속 점수가 없는
    # 유형(text_mismatch)은 비워 둔다.
    metrics: dict = field(default_factory=dict)

    def to_dict(self):
        d = {
            "id": self.id,
            "type": self.type,
            "severity": self.severity,
            "bbox_ref": [int(v) for v in self.bbox_ref],
            "area_px": int(self.area_px),
            "near_text": self.near_text,
            "note": self.note,
        }
        if self.metrics:
            d["metrics"] = self.metrics
        return d


def area_margin(area: float, min_area: float) -> dict:
    """면적 임계값에 대한 여유도. margin 1.0 = 임계값에 딱 걸친 상태."""
    if min_area <= 0:
        return {}
    return {"margin": round(float(area) / min_area, 3),
            "basis": f"면적 {int(area)} / 최소 {min_area:.0f}px"}


# ---------------------------------------------------------------------------
# 한글 경로 안전 I/O
# ---------------------------------------------------------------------------

def _render_pdf_gray(path: Path, dpi: int = 600) -> np.ndarray:
    """PDF 첫 페이지를 지정 dpi로 래스터화해 그레이스케일 ndarray로 반환.

    브라우저판(web/src/pipeline/pdf.ts)과 동일하게 600dpi·흰 배경·첫 페이지.
    시스템 의존성 없는 pypdfium2 사용(pip install pypdfium2).
    """
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise SystemExit(
            "[에러] PDF 입력에는 pypdfium2가 필요합니다: pip install pypdfium2")
    pdf = pdfium.PdfDocument(str(path))
    try:
        if len(pdf) == 0:
            raise SystemExit(f"[에러] 페이지가 없는 PDF입니다: {path}")
        page = pdf[0]
        scale = dpi / 72.0
        w_pt, h_pt = page.get_size()
        longest = max(w_pt, h_pt) * scale
        max_dim = 12000  # 과대 캔버스 방지(브라우저판과 동일 상한)
        if longest > max_dim:
            scale *= max_dim / longest
        bitmap = page.render(scale=scale)
        arr = bitmap.to_numpy()
        mode = bitmap.mode  # 'RGB' | 'BGR' | 'RGBA' | 'BGRA' | 'L' ...
        bitmap.close()
        if arr.ndim == 2 or mode in ("L", "grey", "gray"):
            return arr if arr.ndim == 2 else arr[:, :, 0]
        chans = arr[:, :, :3].astype(np.float32)
        if mode.startswith("BGR"):  # BGR(A) → RGB 순서로 정렬
            chans = chans[:, :, ::-1]
        if mode.endswith("A"):      # 알파를 흰 배경에 합성
            a = arr[:, :, 3:4].astype(np.float32) / 255.0
            chans = chans * a + 255.0 * (1.0 - a)
        gray = cv2.cvtColor(chans.astype(np.uint8), cv2.COLOR_RGB2GRAY)
        return gray
    finally:
        pdf.close()


def imread_gray(path: Path) -> np.ndarray:
    if path.suffix.lower() == ".pdf":
        return _render_pdf_gray(path)
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise SystemExit(f"[에러] 이미지를 열 수 없습니다: {path}")
    return img


def imwrite(path: Path, img: np.ndarray) -> None:
    ok, buf = cv2.imencode(path.suffix or ".png", img)
    if not ok:
        raise RuntimeError(f"이미지 인코딩 실패: {path}")
    buf.tofile(str(path))


def ellipse(k: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))


# ---------------------------------------------------------------------------
# 3.1 전역 정합
# ---------------------------------------------------------------------------

def global_align(ref: np.ndarray, test: np.ndarray, cfg: Config) -> np.ndarray:
    """ORB + RANSAC homography로 TEST를 REF 좌표계로 warp."""

    def downscale(img):
        s = cfg.downscale_long / max(img.shape)
        if s >= 1.0:
            return img, 1.0
        small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        return small, s

    ref_s, s_ref = downscale(ref)
    test_s, s_test = downscale(test)

    orb = cv2.ORB_create(nfeatures=cfg.orb_features)
    kp_r, des_r = orb.detectAndCompute(ref_s, None)
    kp_t, des_t = orb.detectAndCompute(test_s, None)
    if des_r is None or des_t is None:
        raise SystemExit("[에러] ORB 특징점 추출 실패 — 이미지 내용을 확인하세요.")

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    knn = matcher.knnMatch(des_t, des_r, k=2)
    good = [m for m, n in (p for p in knn if len(p) == 2)
            if m.distance < cfg.lowe_ratio * n.distance]
    if len(good) < 4:
        raise SystemExit(f"[에러] 매칭 부족(good={len(good)}) — 정합 불가.")

    src = np.float32([kp_t[m.queryIdx].pt for m in good]) / s_test
    dst = np.float32([kp_r[m.trainIdx].pt for m in good]) / s_ref

    H, mask = cv2.findHomography(src, dst, cv2.RANSAC,
                                 ransacReprojThreshold=cfg.ransac_thresh)
    if H is None:
        raise SystemExit("[에러] homography 추정 실패.")
    inliers = int(mask.sum())

    Hn = H / H[2, 2]
    sx = float(np.hypot(Hn[0, 0], Hn[1, 0]))
    sy = float(np.hypot(Hn[0, 1], Hn[1, 1]))
    lo, hi = cfg.scale_range
    if inliers < cfg.min_inliers:
        raise SystemExit(
            f"[에러] 전역 정합 검증 실패: inlier={inliers} (< {cfg.min_inliers}). "
            "입력 이미지 쌍이 동일 아트웍인지 확인하세요.")
    if not (lo <= sx <= hi and lo <= sy <= hi):
        raise SystemExit(
            f"[에러] 전역 정합 검증 실패: 스케일 성분 sx={sx:.3f}, sy={sy:.3f} "
            f"(허용 {lo}~{hi}).")

    print(f"[정합] good match {len(good)}, inlier {inliers}, "
          f"scale ({sx:.3f}, {sy:.3f})")

    aligned = cv2.warpPerspective(test, H, (ref.shape[1], ref.shape[0]),
                                  flags=cv2.INTER_LINEAR, borderValue=255)
    return aligned


# ---------------------------------------------------------------------------
# 3.2 타일 국소 정밀 정합
# ---------------------------------------------------------------------------

def _fill_invalid(grid: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """무효 타일을 유효 이웃 중앙값으로 채움(반복)."""
    grid = grid.copy()
    valid = valid.copy()
    ny, nx = grid.shape
    for _ in range(max(ny, nx)):
        if valid.all():
            break
        new_grid, new_valid = grid.copy(), valid.copy()
        for i in range(ny):
            for j in range(nx):
                if valid[i, j]:
                    continue
                neigh = []
                for di in (-1, 0, 1):
                    for dj in (-1, 0, 1):
                        ii, jj = i + di, j + dj
                        if 0 <= ii < ny and 0 <= jj < nx and valid[ii, jj]:
                            neigh.append(grid[ii, jj])
                if neigh:
                    new_grid[i, j] = float(np.median(neigh))
                    new_valid[i, j] = True
        grid, valid = new_grid, new_valid
    grid[~valid] = 0.0
    return grid


def _upsample_grid(grid: np.ndarray, cxs: np.ndarray, cys: np.ndarray,
                   w: int, h: int) -> np.ndarray:
    """타일 중심 격자값을 전체 해상도로 bilinear 보간."""
    ny, nx = grid.shape
    xf = np.arange(w, dtype=np.float64)
    rows = np.empty((ny, w), np.float32)
    for i in range(ny):
        rows[i] = np.interp(xf, cxs, grid[i].astype(np.float64))
    if ny == 1:
        return np.repeat(rows, h, axis=0)
    yf = np.arange(h, dtype=np.float64)
    i1 = np.clip(np.searchsorted(cys, yf), 1, ny - 1)
    i0 = i1 - 1
    wgt = np.clip((yf - cys[i0]) / (cys[i1] - cys[i0]), 0, 1).astype(np.float32)[:, None]
    return rows[i0] * (1 - wgt) + rows[i1] * wgt


def tile_refine(ref: np.ndarray, aligned: np.ndarray, cfg: Config,
                debug_dir: Path | None = None) -> np.ndarray:
    """phaseCorrelate 타일 격자로 잔차 변위장을 추정, remap으로 재정합."""
    h, w = ref.shape
    tile, stride = cfg.tile, cfg.tile - cfg.overlap
    xs = list(range(0, max(w - tile, 0) + 1, stride))
    ys = list(range(0, max(h - tile, 0) + 1, stride))
    if xs[-1] != w - tile:
        xs.append(w - tile)
    if ys[-1] != h - tile:
        ys.append(h - tile)

    win = np.outer(np.hanning(tile), np.hanning(tile)).astype(np.float32)
    dxg = np.zeros((len(ys), len(xs)), np.float32)
    dyg = np.zeros_like(dxg)
    valid = np.zeros(dxg.shape, bool)

    for i, y0 in enumerate(ys):
        for j, x0 in enumerate(xs):
            rt = ref[y0:y0 + tile, x0:x0 + tile].astype(np.float32)
            tt = aligned[y0:y0 + tile, x0:x0 + tile].astype(np.float32)
            (dx, dy), resp = cv2.phaseCorrelate(rt * win, tt * win)
            if resp >= cfg.min_response and np.hypot(dx, dy) <= cfg.max_shift:
                dxg[i, j], dyg[i, j] = dx, dy
                valid[i, j] = True

    n_valid = int(valid.sum())
    print(f"[타일 정합] {dxg.size}개 타일 중 유효 {n_valid}개, "
          f"|shift| 중앙값 {np.median(np.hypot(dxg[valid], dyg[valid])):.2f}px"
          if n_valid else "[타일 정합] 유효 타일 없음 — 정밀 정합 생략")
    if not n_valid:
        return aligned

    dxg = _fill_invalid(dxg, valid)
    dyg = _fill_invalid(dyg, valid)

    cxs = np.array([x + tile / 2 for x in xs], np.float64)
    cys = np.array([y + tile / 2 for y in ys], np.float64)

    map_x = _upsample_grid(dxg, cxs, cys, w, h)
    map_x += np.arange(w, dtype=np.float32)[None, :]
    map_y = _upsample_grid(dyg, cxs, cys, w, h)
    map_y += np.arange(h, dtype=np.float32)[:, None]

    refined = cv2.remap(aligned, map_x, map_y, cv2.INTER_LINEAR,
                        borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    if debug_dir:
        imwrite(debug_dir / "tile_dx.png",
                cv2.normalize(dxg, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8))
        imwrite(debug_dir / "tile_dy.png",
                cv2.normalize(dyg, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8))
    return refined


# ---------------------------------------------------------------------------
# 3.3 잉크 이진화
# ---------------------------------------------------------------------------

def flatten_background(img: np.ndarray, cfg: Config) -> np.ndarray:
    bg = cv2.morphologyEx(img, cv2.MORPH_CLOSE, ellipse(cfg.bg_kernel))
    return cv2.divide(img, bg, scale=255)


def ink_mask(gray: np.ndarray, cfg: Config) -> np.ndarray:
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                 cv2.THRESH_BINARY_INV,
                                 blockSize=cfg.thresh_block, C=cfg.thresh_c)


# ---------------------------------------------------------------------------
# 3.4 구조 diff
# ---------------------------------------------------------------------------

def structural_diff(ref_ink: np.ndarray, test_ink: np.ndarray, tol: int):
    """(open 후 extra, open 후 missing, 원시 extra, 원시 missing) 반환."""
    k = ellipse(tol)
    raw_extra = cv2.bitwise_and(test_ink, cv2.bitwise_not(cv2.dilate(ref_ink, k)))
    raw_missing = cv2.bitwise_and(ref_ink, cv2.bitwise_not(cv2.dilate(test_ink, k)))
    open3 = ellipse(3)
    extra = cv2.morphologyEx(raw_extra, cv2.MORPH_OPEN, open3)
    missing = cv2.morphologyEx(raw_missing, cv2.MORPH_OPEN, open3)
    return extra, missing, raw_extra, raw_missing


# ---------------------------------------------------------------------------
# 3.4b 인쇄 농도 검사 — 옅게 인쇄된 결함 검출
# ---------------------------------------------------------------------------
# 픽셀 diff(3.4)는 두 가지를 원리적으로 못 잡는다.
#   * 옅은 인쇄: 잉크 마스크가 이진이라 "회색으로 인쇄된 글자"도 잉크로 잡혀
#     diff가 0이다. 단어 하나가 통째로 흐려도 검출되지 않았다(9000px인데 0건).
#   * 얇은 획 끊김(폭 ≤4px): 여기서도 못 잡는다. 잔여 정합 오차 2~3px를 흡수하려면
#     근처를 훑어야 하는데, 그러면 4px 결손은 이웃 잉크에 덮인다. 실측에서 cover
#     0.99·농도비 1.12로 정상과 구분되지 않았다 — 정합 정밀도의 한계다.
#
# 그래서 픽셀 대신 **REF 잉크 덩어리(글자·획) 단위로 집계값을 비교**한다.
# 덩어리 박스 안의 잉크량·잉크 농도를 REF와 TEST에서 각각 재는 방식이라
# 위치가 몇 px 어긋나도 값이 흔들리지 않는다 — tol을 낮출 필요가 없다.
#
# 핵심은 **페이지 중앙값 대비 상대 판정**이다. 인쇄 질감이 전체적으로 떨어지면
# 모든 덩어리의 잉크량·농도가 함께 낮아지므로, 절대 기준으로 보면 페이지 전체가
# 결함이 된다(사용자 피드백의 "망점·질감" 오탐이 정확히 이 형태였다). 페이지
# 중앙값을 기준선으로 삼으면 "전체적으로 옅은 인쇄"는 통과하고 "유독 이 덩어리만
# 빠졌다/흐리다"만 남는다.

def faded_findings(ref_ink: np.ndarray, test_ink: np.ndarray,
                   ref: np.ndarray, norm_test: np.ndarray,
                   cfg: Config, cbox: tuple,
                   norm_ref: np.ndarray | None = None) -> list[dict]:
    """REF 잉크 덩어리별 인쇄 농도를 비교해 '옅게 인쇄된' 후보를 낸다.

    반환: [{bbox, area, cover, dark_ratio, lim}]

    norm_ref: 배경 평탄화한 REF(주지 않으면 여기서 계산). 농도 비교 대상 픽셀을
    고르는 데만 쓴다 — 절대 밝기로 고르면 (a) 회색 톤 박스(210)와 (b) 배경 대비
    10 남짓인 망점 잡티가 잉크로 섞여 들어와, TEST만 평탄화되는 비대칭 때문에
    통째로 '옅은 인쇄'로 오탐된다(안전망 identity 케이스 실측: 아트웍 1건 +
    스캔 11건). 평탄화 후 밝기로 보면 "배경보다 충분히 어두운 잉크"만 남는다.
    """
    px = ref.shape[1] / REF_BASE_WIDTH
    min_area = max(int(cfg.cover_min_area * px ** 2), 20)
    # 여유(pad)는 좁게 — 넓으면 옆 글자의 잉크가 결손을 덮어 픽셀 diff와 같은
    # 한계에 빠진다(tol 문제와 동일). 잔여 정합 오차는 타일 정합 후 |shift|
    # 중앙값 2~3px이고, 전체적인 어긋남은 페이지 중앙값 정규화가 흡수한다.
    pad = max(round(cfg.cover_pad * px), 2)

    # 글자 단위로 본다(획을 문단으로 묶으면 국소 이상이 평균에 묻힌다). 붙어 있는
    # 획만 이어지도록 아주 작은 커널로만 묶는다.
    grouped = (cv2.dilate(ref_ink, ellipse(cfg.cover_merge))
               if cfg.cover_merge > 1 else ref_ink)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(grouped, 8, cv2.CV_32S)
    if n <= 1:
        return []

    # REF 잉크가 있는 자리에서 REF와 TEST의 잉크 진하기를 **같은 픽셀 집합**으로
    # 잰다. TEST는 최대값 필터(dilate)로 pad만큼 훑어 정합 오차에 둔감하게 한다.
    ref_dark = (255 - ref).astype(np.int32)
    test_dark = cv2.dilate(255 - norm_test, ellipse(2 * pad + 1)).astype(np.int32)
    test_ink_near = cv2.dilate(test_ink, ellipse(2 * pad + 1))

    # 컴포넌트가 수만 개라 파이썬 루프로는 못 돈다 — bincount로 한 번에 집계한다.
    # 잉크 판정은 평탄화 후 밝기(= 배경 대비)로 한다 — 위 docstring 참조.
    if norm_ref is None:
        norm_ref = flatten_background(ref, cfg)
    ink = (ref_ink > 0) & (norm_ref <= cfg.cover_ref_max)
    lab = labels[ink]
    area = np.bincount(lab, minlength=n).astype(np.float64)
    covered = np.bincount(lab, weights=(test_ink_near[ink] > 0).astype(np.float64),
                          minlength=n)
    ref_sum = np.bincount(lab, weights=ref_dark[ink].astype(np.float64),
                          minlength=n)
    test_sum = np.bincount(lab, weights=test_dark[ink].astype(np.float64),
                           minlength=n)
    with np.errstate(divide="ignore", invalid="ignore"):
        cover = np.where(area > 0, covered / area, 1.0)
        dark_ratio = np.where(ref_sum > 0, test_sum / ref_sum, 1.0)

    cx0, cy0, cx1, cy1 = cbox
    x, y, w, h = (stats[:, 0], stats[:, 1], stats[:, 2], stats[:, 3])
    inside = (x + w >= cx0) & (x <= cx1) & (y + h >= cy0) & (y <= cy1)
    keep = (area >= min_area) & inside
    keep[0] = False                      # 배경 라벨
    idx = np.nonzero(keep)[0]
    if idx.size == 0:
        return []

    # 페이지 기준선(중앙값) — 전체적인 인쇄 질감 차이를 상쇄한다. 실측에서 전체
    # 블러+노이즈+톤 저하를 먹여도 중앙값이 1.13→1.11로만 움직였다(=전체적으로
    # 옅은 인쇄는 통과), 반면 국소적으로 옅어진 글자는 0.49로 떨어진다.
    med_dark = float(np.median(dark_ratio[idx]))
    lim = min(cfg.fade_rel * med_dark, cfg.fade_abs)
    out = []
    for i in idx:
        d = float(dark_ratio[i])
        if d >= lim:
            continue
        out.append({"bbox": (int(x[i]), int(y[i]), int(w[i]), int(h[i])),
                    "area": int(area[i]), "cover": float(cover[i]),
                    "dark_ratio": d, "lim": float(lim)})
    return out


# ---------------------------------------------------------------------------
# 3.5 군집화 / 필터링 / 기대차이
# ---------------------------------------------------------------------------

def cluster_components(diff: np.ndarray, raw_diff: np.ndarray, gray_src: np.ndarray,
                       max_gray: int, cfg: Config, ref_shape: tuple,
                       content_bbox: tuple) -> list[dict]:
    """diff 마스크를 병합·군집화해 (bbox, 실제 diff 픽셀 수) 목록 반환.

    - 면적은 open 전 원시 diff(raw_diff) 기준으로 계산(획 부착 소형 결함 보존)
    - gray_src(diff 픽셀 위치의 밝기 소스)의 평균이 max_gray보다 밝은 성분은
      망점/고스트 톤 차이로 보고 제외 (함정 #2)
    """
    h, w = ref_shape
    min_area = cfg.min_area * (w / REF_BASE_WIDTH) ** 2
    merged = cv2.dilate(diff, ellipse(cfg.merge_kernel))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(merged, 8)
    cx0, cy0, cx1, cy1 = content_bbox
    out = []
    for i in range(1, n):
        x, y, bw, bh = stats[i, 0], stats[i, 1], stats[i, 2], stats[i, 3]
        roi = diff[y:y + bh, x:x + bw]
        # 병합 팽창분을 걷어낸 실제 diff 잉크 픽셀 수(원시 diff 기준)
        area = int(cv2.countNonZero(raw_diff[y:y + bh, x:x + bw]))
        if area < min_area:
            continue
        # 콘텐츠 마스크: REF 잉크 bbox 밖 성분 제외
        if x + bw < cx0 or x > cx1 or y + bh < cy0 or y > cy1:
            continue
        mask = roi > 0
        if not mask.any():
            continue
        # 망점/고스트 톤 차이 억제: diff 픽셀 평균 밝기 검사
        mean_gray = float(gray_src[y:y + bh, x:x + bw][mask].mean())
        if mean_gray > max_gray:
            continue
        # bbox를 실제 diff 픽셀 범위로 타이트하게 축소
        ys_nz, xs_nz = np.nonzero(mask)
        tx, ty = int(x) + int(xs_nz.min()), int(y) + int(ys_nz.min())
        tw = int(xs_nz.max() - xs_nz.min()) + 1
        th = int(ys_nz.max() - ys_nz.min()) + 1
        out.append({"bbox": (tx, ty, tw, th), "area": area})
    return out


def in_margin(bbox: tuple, ref_shape: tuple, ratio: float) -> bool:
    h, w = ref_shape
    mx, my = w * ratio, h * ratio
    x, y, bw, bh = bbox
    return (x + bw <= mx) or (x >= w - mx) or (y + bh <= my) or (y >= h - my)


def content_bbox_of(ref_ink: np.ndarray) -> tuple:
    nz = cv2.findNonZero(ref_ink)
    if nz is None:
        return (0, 0, ref_ink.shape[1], ref_ink.shape[0])
    x, y, w, h = cv2.boundingRect(nz)
    return (x, y, x + w, y + h)


# ---------------------------------------------------------------------------
# 3.5b 리플로우(개정 줄 밀림) 억제
# ---------------------------------------------------------------------------

def find_shifted_match(src: np.ndarray, dst: np.ndarray, bbox: tuple,
                       pad: int, search_x: int, search_y: int,
                       exclude_r: int = 0) -> tuple[float, int, int]:
    """bbox 크롭(문맥 패딩 포함)을 dst의 국소 탐색창에서 템플릿 매칭.

    개정판 간 문구 추가/삭제로 이후 줄이 통째로 밀리면(reflow) 픽셀 diff는
    밀린 모든 줄을 missing/extra 쌍으로 오탐한다. diff 내용이 상대 이미지의
    변위된 위치에 그대로 존재하면 결함이 아닌 줄 밀림이다. 패딩으로 주변
    문맥을 포함시켜, 실제 결함(주변은 정합·해당 부분만 상이)은 어떤 변위
    에서도 높은 상관을 얻지 못하게 한다.

    exclude_r > 0 이면 |dx|,|dy| <= exclude_r 인 무변위 부근 응답은 무시.
    반환: (최고 상관, dx, dy). 매칭 불가 시 (-1, 0, 0).
    """
    x, y, w, h = bbox
    hh, ww = src.shape
    tx0, ty0 = max(x - pad, 0), max(y - pad, 0)
    tx1, ty1 = min(x + w + pad, ww), min(y + h + pad, hh)
    tmpl = src[ty0:ty1, tx0:tx1]
    if min(tmpl.shape) < 8:
        return -1.0, 0, 0
    wx0, wy0 = max(tx0 - search_x, 0), max(ty0 - search_y, 0)
    wx1, wy1 = min(tx1 + search_x, ww), min(ty1 + search_y, hh)
    win = dst[wy0:wy1, wx0:wx1]
    if win.shape[0] < tmpl.shape[0] or win.shape[1] < tmpl.shape[1]:
        return -1.0, 0, 0
    res = cv2.matchTemplate(win, tmpl, cv2.TM_CCOEFF_NORMED)
    zj, zi = tx0 - wx0, ty0 - wy0  # 무변위(dx=dy=0)의 응답 좌표
    if exclude_r > 0:
        i0, i1 = max(zi - exclude_r, 0), min(zi + exclude_r + 1, res.shape[0])
        j0, j1 = max(zj - exclude_r, 0), min(zj + exclude_r + 1, res.shape[1])
        res[i0:i1, j0:j1] = -1.0
    _, corr, _, (j, i) = cv2.minMaxLoc(res)
    return float(corr), j - zj, i - zi


# ---------------------------------------------------------------------------
# 3.6 뒷비침 검출
# ---------------------------------------------------------------------------

def detect_showthrough(norm_test: np.ndarray, ref: np.ndarray,
                       cfg: Config, content_bbox: tuple) -> list[dict]:
    # median blur: 망점 도트는 평탄화되어 밴드를 벗어나고, 획 폭이 있는
    # 고스트 텍스트만 밴드(151~214)에 남는다. REF 백색 기준 215는
    # 회색 박스 톤(~210)을 제외하기 위함 (함정 #2).
    blurred = cv2.medianBlur(norm_test, cfg.ghost_blur)
    band = cv2.inRange(blurred, cfg.ghost_lo + 1, cfg.ghost_band_hi)
    ref_white = (cv2.erode(ref, ellipse(cfg.ghost_ref_erode))
                 > cfg.ghost_ref_white).astype(np.uint8) * 255
    ghost = cv2.bitwise_and(band, ref_white)
    ghost = cv2.morphologyEx(ghost, cv2.MORPH_OPEN, ellipse(3))
    merged = cv2.dilate(ghost, ellipse(cfg.ghost_merge))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(merged, 8)
    cx0, cy0, cx1, cy1 = content_bbox
    out = []
    for i in range(1, n):
        x, y, bw, bh = stats[i, 0], stats[i, 1], stats[i, 2], stats[i, 3]
        roi = ghost[y:y + bh, x:x + bw]
        area = int(cv2.countNonZero(roi))
        if area <= cfg.ghost_min_area:
            continue
        if x + bw < cx0 or x > cx1 or y + bh < cy0 or y > cy1:
            continue
        ys_nz, xs_nz = np.nonzero(roi)
        tx, ty = int(x) + int(xs_nz.min()), int(y) + int(ys_nz.min())
        tw = int(xs_nz.max() - xs_nz.min()) + 1
        th = int(ys_nz.max() - ys_nz.min()) + 1
        out.append({"bbox": (tx, ty, tw, th), "area": area})
    return out


# ---------------------------------------------------------------------------
# 3.7 OCR 텍스트 대조
# ---------------------------------------------------------------------------

_PUNCT = set(".,;:!?'\"`-–—()[]{}|/\\*·")


def _norm_word(t: str) -> str:
    return (t.replace("‘", "'").replace("’", "'")
             .replace("“", '"').replace("”", '"')
             .replace("–", "-").replace("—", "-").strip())


def ocr_words(img: np.ndarray, cfg: Config) -> list[dict]:
    import pytesseract
    data = pytesseract.image_to_data(img, lang="eng", config="--psm 3",
                                     output_type=pytesseract.Output.DICT)
    words = []
    for i in range(len(data["text"])):
        txt = _norm_word(data["text"][i])
        try:
            conf = float(data["conf"][i])
        except (ValueError, TypeError):
            conf = -1.0
        if not txt or conf < cfg.ocr_min_conf:
            continue
        words.append({
            "text": txt,
            "conf": conf,
            "bbox": (data["left"][i], data["top"][i],
                     data["width"][i], data["height"][i]),
            "line": (data["block_num"][i], data["par_num"][i], data["line_num"][i]),
        })
    return words


# OCR 혼동 문자 클래스(스캔 품질에 따른 오독) — 클래스 내 치환은 결함이 아님.
# C↔O 같은 실제 결함성 변형은 클래스에 없으므로 보존된다.
_CONFUSABLE = str.maketrans({c: k for k, grp in
                             {"0": "0OoQ", "1": "1lI|i", "5": "5Ss",
                              "8": "8B", "2": "2Zz"}.items() for c in grp})


def _alnum(s: str) -> str:
    return "".join(ch for ch in s if ch.isalnum())


def _trivial_diff(tag: str, a_words: list[str], b_words: list[str]) -> bool:
    """OCR 노이즈성 차이 판정 — True면 무시."""
    a_join, b_join = "".join(a_words), "".join(b_words)
    # 순수 기호/구두점 차이(불릿 ¢/* 오독, 따옴표 등)
    if not _alnum(a_join) and not _alnum(b_join):
        return True
    # 띄어쓰기만 다른 경우 ('a new' vs 'anew')
    if a_join == b_join:
        return True
    # 혼동 문자 정규화 후 동일 ('1-SENS' vs 'i-SENS')
    if a_join.translate(_CONFUSABLE) == b_join.translate(_CONFUSABLE):
        return True
    # 대소문자만 다른 경우 ('for' vs 'For', 'AST' vs 'ast') — 인쇄 결함은 글자
    # 모양을 훼손하지 그 자체를 대문자로 바꾸지 않는다. 진짜 글리프 훼손이라면
    # 잉크 diff 경로가 잡는다. (구두점 차이는 여기서 무시하지 않는다 — 빠진
    # 마침표는 실제 결함일 수 있어 계속 보고한다.)
    if (a_join.lower().translate(_CONFUSABLE)
            == b_join.lower().translate(_CONFUSABLE)):
        return True
    # rn→m 접합 오독('return'→'retum')은 2자→1자라 translate 로는 못 잡는다
    a_f = a_join.lower().translate(_CONFUSABLE).replace("rn", "m")
    b_f = b_join.lower().translate(_CONFUSABLE).replace("rn", "m")
    if a_f == b_f:
        return True
    # 삽입/삭제는 실단어 수준(영숫자 4자 이상)만 결함으로 인정
    if tag in ("insert", "delete") and len(_alnum(a_join) + _alnum(b_join)) < 4:
        return True
    # 단어 조각 오독 — 한쪽이 다른 쪽의 부분 문자열인 1~2자 조각이면 인쇄 결함이
    # 아니라 판독 실패다. 뒷비침·저대비가 겹친 줄에서 OCR이 단어 앞부분을 놓치고
    # 끝 글자만 남기는 일이 있다(실측: tesseract.js가 "Owner's"를 "s"로만 읽어
    # web 엔진에만 text_mismatch 오탐이 났다. 네이티브 tesseract는 정상 판독).
    # 단어가 실제로 지워진 결함이라면 잉크 diff가 훨씬 큰 면적으로 잡는다
    # (미검출 가혹 테스트 erase_word: 200×45로 검출됨).
    if tag == "replace":
        a_n, b_n = _alnum(a_join).lower(), _alnum(b_join).lower()
        short, long_ = sorted((a_n, b_n), key=len)
        if 0 < len(short) <= 2 and short in long_:
            return True
        # 한쪽이 다른 쪽에 통째로 들어 있고 차이가 영숫자 1~2자뿐이면 줄 경계
        # 병합/탈락 오독이다('Strips'→'Strip', 'retum…results'→'…results e').
        # 차이 0자(구두점만 다름: 'blood'→'blood.')는 실결함일 수 있으므로
        # 여기서 거르지 않고 픽셀 증거(pixel_evidence)로 판정한다. 글자가 정말
        # 지워졌다면 잉크 누락 증거가 단어 박스 안에서 잡히고, 글자가 정말
        # 추가됐다면 extra 경로가 글리프 면적으로 잡는다.
        a_nf, b_nf = _alnum(a_f), _alnum(b_f)
        short_f, long_f = sorted((a_nf, b_nf), key=len)
        if short_f and short_f in long_f and 1 <= len(long_f) - len(short_f) <= 2:
            return True
        # 여러 단어(3+)가 반토막 이하 텍스트로 붕괴 — 뒷비침·저대비 블록에서
        # OCR이 줄을 통째로 잘못 묶어 읽은 판독 실패다(실측: back-pair TEST-1
        # 'e Keep test strips …' 49단어 → '= vil'). 단어가 정말 지워진
        # 결함이라면 잉크 diff가 큰 면적으로 잡는다(bench erase_word/erase_line).
        if len(a_words) >= 3 and len(b_n) < 0.5 * len(a_n):
            return True
    return False


def text_mismatches(ref_words: list[dict], test_words: list[dict]) -> list[dict]:
    a = [w["text"] for w in ref_words]
    b = [w["text"] for w in test_words]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        ref_seg = a[i1:i2]
        test_seg = b[j1:j2]
        if _trivial_diff(tag, ref_seg, test_seg):
            continue
        # bbox: TEST 쪽 단어 박스(없으면 REF 쪽) 합집합
        boxes = [test_words[j]["bbox"] for j in range(j1, j2)] or \
                [ref_words[i]["bbox"] for i in range(i1, i2)]
        xs = [bx for bx, _, _, _ in boxes]
        ys = [by for _, by, _, _ in boxes]
        x2 = [bx + bw for bx, _, bw, _ in boxes]
        y2 = [by + bh for _, by, _, bh in boxes]
        bbox = (min(xs), min(ys), max(x2) - min(xs), max(y2) - min(ys))
        out.append({
            "bbox": bbox,
            "ref_text": " ".join(ref_seg),
            "test_text": " ".join(test_seg),
            "tag": tag,
        })
    return out


EV_PAD_X = 40        # 단어 곁 추가 잉크(붙은 구두점 등) 탐색 여백
EV_PAD_Y = 10
EV_BLOB_MIN = 60     # 증거로 인정할 최소 잉크 덩어리(px)


def pixel_evidence(mm: dict, ref_ink: np.ndarray,
                   test_ink: np.ndarray) -> tuple[bool, tuple | None]:
    """OCR 불일치의 픽셀 증거 대조 — (인정 여부, 증거 덩어리 합집합 bbox).

    종전에는 국소 diff "비율 ≥ 5%"만 요구해, 작은 단어 박스에서는 AA 노이즈
    몇 px, 큰 박스에서는 뒷비침 질감이 통과했다(오탐 병목). 이제 **뭉친
    덩어리(blob)** 를 요구한다. 실측(back-pair TEST-1, 2026-08-03 사용자 판정
    18건): 실결함의 최대 blob ≥ 75px, 오탐(뒷비침·번짐·불릿 오독) ≤ 55px.

    - 추가 잉크(TEST에만): 단어 곁 구두점도 결함이므로 패딩 영역까지 인정
    - 누락 잉크(REF에만): 사라진 글리프는 단어 박스 **안**에 있어야 한다 —
      박스 밖 누락은 인접 오염이다(실측: 'Strips'→'Strip' 곁 683px 오탐)
    - delete/insert: 종전대로 잉크 총량 비(단어 통째 증발/출현)
    - 반환 bbox는 증거 위치라서 annotated 빨간 박스가 실제 결함 위에 그려진다
      (종전엔 OCR 단어 박스를 그려 위치가 어긋났다)
    """
    x, y, w, h = mm["bbox"]
    hh, ww = ref_ink.shape
    x0, y0 = max(x - EV_PAD_X, 0), max(y - EV_PAD_Y, 0)
    x1, y1 = min(x + w + EV_PAD_X, ww), min(y + h + EV_PAD_Y, hh)
    r = ref_ink[y0:y1, x0:x1]
    t = test_ink[y0:y1, x0:x1]
    if mm["tag"] == "delete":
        return int(cv2.countNonZero(t)) < 0.5 * int(cv2.countNonZero(r)), None
    if mm["tag"] == "insert":
        return int(cv2.countNonZero(r)) < 0.5 * int(cv2.countNonZero(t)), None
    k3 = ellipse(3)
    added = cv2.bitwise_and(t, cv2.bitwise_not(cv2.dilate(r, k3)))
    lost = cv2.bitwise_and(r, cv2.bitwise_not(cv2.dilate(t, k3)))
    boxes = []
    for mask, need_inside in ((added, False), (lost, True)):
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        for i in range(1, n):
            bx, by, bw, bh, area = (int(v) for v in stats[i][:5])
            if area < EV_BLOB_MIN:
                continue
            abs_box = (x0 + bx, y0 + by, bw, bh)
            if need_inside and not boxes_intersect(abs_box, mm["bbox"]):
                continue
            boxes.append(abs_box)
    if not boxes:
        return False, None
    ex0 = min(b[0] for b in boxes)
    ey0 = min(b[1] for b in boxes)
    ex1 = max(b[0] + b[2] for b in boxes)
    ey1 = max(b[1] + b[3] for b in boxes)
    return True, (ex0, ey0, ex1 - ex0, ey1 - ey0)


# ---------------------------------------------------------------------------
# 3.8 심각도 분류
# ---------------------------------------------------------------------------

def line_boxes_with(ref_words: list[dict], token: str) -> list[tuple]:
    """token(대소문자 무시)을 포함한 라인의 합집합 bbox 목록."""
    lines: dict[tuple, list] = {}
    hits: set = set()
    for w in ref_words:
        lines.setdefault(w["line"], []).append(w["bbox"])
        if token.lower() in w["text"].lower():
            hits.add(w["line"])
    out = []
    for key in hits:
        boxes = lines[key]
        xs = [b[0] for b in boxes]
        ys = [b[1] for b in boxes]
        x2 = [b[0] + b[2] for b in boxes]
        y2 = [b[1] + b[3] for b in boxes]
        out.append((min(xs), min(ys), max(x2) - min(xs), max(y2) - min(ys)))
    return out


def boxes_intersect(a: tuple, b: tuple) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (ax + aw < bx or bx + bw < ax or ay + ah < by or by + bh < ay)


def dup_of_text_mismatch(f: Finding, findings: list[Finding]) -> bool:
    """잉크 diff 결함이 text_mismatch 에 **대부분 포함**되면 중복 보고.

    '조금이라도 겹치면' 강등하던 것을 교차 면적 ≥ 50% 로 좁혔다 — 세로로 긴
    실결함이 단어 박스와 살짝 겹쳤다고 회색이 되는 오강등이 있었다(실측:
    back-pair TEST-2, 83x311 잉여 잉크가 'respective' 오독 박스에 먹힘).
    """
    if f.type not in ("extra", "missing"):
        return False
    fx, fy, fw, fh = f.bbox_ref
    farea = max(fw * fh, 1)
    for t in findings:
        if t.type != "text_mismatch":
            continue
        tx, ty, tw, th = t.bbox_ref
        ix = max(0, min(fx + fw, tx + tw) - max(fx, tx))
        iy = max(0, min(fy + fh, ty + th) - max(fy, ty))
        if ix * iy >= 0.5 * farea:
            return True
    return False


def ruled_box_mask(ref_ink: np.ndarray) -> np.ndarray:
    """수평·수직 장선으로 둘러싸인 괘선 박스 영역 마스크."""
    horiz = cv2.morphologyEx(ref_ink, cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_RECT, (101, 1)))
    vert = cv2.morphologyEx(ref_ink, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_RECT, (1, 101)))
    lines = cv2.bitwise_or(horiz, vert)
    lines = cv2.dilate(lines, ellipse(5))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(lines, 8)
    mask = np.zeros_like(ref_ink)
    for i in range(1, n):
        x, y, w, h = stats[i, 0], stats[i, 1], stats[i, 2], stats[i, 3]
        if w > 300 and h > 300:  # 수평+수직선이 연결된 실제 박스 구조만
            mask[y:y + h, x:x + w] = 255
    return mask


def classify_severity(f: Finding, ref_words: list[dict],
                      rev_lines: list[tuple], box_mask: np.ndarray) -> str:
    if f.type in ("trim_mark_expected", "layout_reflow"):
        return "expected"
    if f.type == "text_mismatch":
        return "critical"
    for lb in rev_lines:
        if boxes_intersect(f.bbox_ref, lb):
            return "critical"
    for w in ref_words:
        if boxes_intersect(f.bbox_ref, w["bbox"]):
            return "major"
    if f.type == "showthrough":
        return "major"
    x, y, bw, bh = f.bbox_ref
    cx = min(max(x + bw // 2, 0), box_mask.shape[1] - 1)
    cy = min(max(y + bh // 2, 0), box_mask.shape[0] - 1)
    if box_mask[cy, cx]:
        return "major"
    return "minor"


def nearest_text(bbox: tuple, ref_words: list[dict], k: int = 3) -> str:
    if not ref_words:
        return ""
    x, y, w, h = bbox
    cx, cy = x + w / 2, y + h / 2
    scored = sorted(
        ref_words,
        key=lambda wd: (wd["bbox"][0] + wd["bbox"][2] / 2 - cx) ** 2
                     + (wd["bbox"][1] + wd["bbox"][3] / 2 - cy) ** 2)
    return " ".join(wd["text"] for wd in scored[:k])


# ---------------------------------------------------------------------------
# 3.9 리포트 렌더링
# ---------------------------------------------------------------------------

def render_annotated(test_aligned: np.ndarray, findings: list[Finding],
                     out: Path) -> None:
    canvas = cv2.cvtColor(test_aligned, cv2.COLOR_GRAY2BGR)
    for f in findings:
        x, y, w, h = f.bbox_ref
        # showthrough(불량 미처리)와 text_mismatch 중복 보고는 회색 표시
        if (f.severity == "expected" or f.type == "showthrough"
                or dup_of_text_mismatch(f, findings)):
            cv2.rectangle(canvas, (x, y), (x + w, y + h), (160, 160, 160), 4)
            continue
        cv2.rectangle(canvas, (x, y), (x + w, y + h), (0, 0, 255), 9)
        cv2.putText(canvas, str(f.id), (x, max(y - 20, 60)),
                    cv2.FONT_HERSHEY_SIMPLEX, 2.6, (0, 0, 255), 6, cv2.LINE_AA)
    small = cv2.resize(canvas, None, fx=0.45, fy=0.45,
                       interpolation=cv2.INTER_AREA)
    imwrite(out, small)


def _crop_pad(img: np.ndarray, bbox: tuple, pad: int = 80) -> np.ndarray:
    x, y, w, h = bbox
    h_img, w_img = img.shape[:2]
    x0, y0 = max(x - pad, 0), max(y - pad, 0)
    x1, y1 = min(x + w + pad, w_img), min(y + h + pad, h_img)
    return img[y0:y1, x0:x1]


def _tagged(crop_gray: np.ndarray, tag: str, color: tuple,
            width: int) -> np.ndarray:
    """크롭을 폭에 맞춰 정규화(과확대 4배 제한, 여백 패딩) 후 태그를 그린다."""
    s = min(width / crop_gray.shape[1], 4.0)
    resized = cv2.resize(crop_gray, None, fx=s, fy=s,
                         interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    img = cv2.cvtColor(resized, cv2.COLOR_GRAY2BGR)
    if img.shape[1] < width:
        pad = np.full((img.shape[0], width - img.shape[1], 3), 255, np.uint8)
        img = np.hstack([img, pad])
    cv2.rectangle(img, (0, 0), (140, 54), color, -1)
    cv2.putText(img, tag, (12, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2,
                (255, 255, 255), 3, cv2.LINE_AA)
    return img


def render_contact_sheet(ref: np.ndarray, test_aligned: np.ndarray,
                         findings: list[Finding], out: Path,
                         width: int = 2000, max_height: int = 60000) -> None:
    # max_height: 브라우저 이미지 디코딩 한계(~65,535px)를 넘지 않도록 상한.
    # 초과분은 생략하고 마지막에 안내 행을 붙인다(상세는 findings.json/csv).
    blocks = []
    height = 0
    n_skipped = 0
    targets = [f for f in findings
               if f.severity != "expected" and f.type != "showthrough"
               and not dup_of_text_mismatch(f, findings)]
    for f in targets:
        header = np.full((90, width, 3), 255, np.uint8)
        title = f"#{f.id}  {f.type}  [{f.severity.upper()}]  bbox={list(f.bbox_ref)}"
        cv2.putText(header, title, (16, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4,
                    (0, 0, 0), 3, cv2.LINE_AA)

        ref_c = _tagged(_crop_pad(ref, f.bbox_ref), "REF", (120, 120, 120), width)
        test_c = _tagged(_crop_pad(test_aligned, f.bbox_ref), "TEST", (0, 0, 255), width)
        sep = np.zeros((6, width, 3), np.uint8)
        sep[:, :] = (0, 0, 255)
        gap = np.full((40, width, 3), 255, np.uint8)
        block_h = sum(b.shape[0] for b in (header, ref_c, sep, test_c, gap))
        if height + block_h > max_height - 90:
            n_skipped = len(targets) - targets.index(f)
            break
        blocks += [header, ref_c, sep, test_c, gap]
        height += block_h
    if n_skipped:
        footer = np.full((90, width, 3), 255, np.uint8)
        cv2.putText(footer, f"... {n_skipped} more findings omitted "
                    "(see findings.json / findings.csv)", (16, 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 255), 3, cv2.LINE_AA)
        blocks.append(footer)
    if not blocks:
        blocks = [np.full((90, width, 3), 255, np.uint8)]
        cv2.putText(blocks[0], "No defects found", (16, 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 3, cv2.LINE_AA)
    imwrite(out, np.vstack(blocks))


def write_reports(findings: list[Finding], outdir: Path) -> None:
    data = [f.to_dict() for f in findings]
    (outdir / "findings.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    with open(outdir / "findings.csv", "w", newline="", encoding="utf-8-sig") as fp:
        wr = csv.writer(fp)
        wr.writerow(["id", "type", "severity", "x", "y", "w", "h",
                     "area_px", "near_text", "note"])
        for f in findings:
            wr.writerow([f.id, f.type, f.severity, *f.bbox_ref,
                         f.area_px, f.near_text, f.note])


def print_summary(findings: list[Finding]) -> None:
    print()
    print(f"{'번호':>4} {'유형':<18} {'심각도':<10} {'bbox (x,y,w,h)':<28} 비고")
    print("-" * 100)
    for f in findings:
        print(f"{f.id:>4} {f.type:<18} {f.severity:<10} "
              f"{str(list(f.bbox_ref)):<28} {f.note}")
    n_defect = sum(1 for f in findings if f.severity != "expected")
    n_exp = len(findings) - n_defect
    print("-" * 100)
    print(f"결함 {n_defect}건, 기대 차이(재단선 등) {n_exp}건")


# ---------------------------------------------------------------------------
# 6. (선택) LLM 검증 훅
# ---------------------------------------------------------------------------

def llm_verify(findings: list[Finding], ref: np.ndarray,
               test_aligned: np.ndarray) -> None:
    """결함 후보 크롭 쌍만 Claude(haiku급)에 배치 전송해 defect|noise|expected 분류.
    전체 페이지 이미지는 절대 전송하지 않는다."""
    try:
        import anthropic
    except ImportError:
        print("[LLM] anthropic 패키지 미설치 — pip install anthropic 후 재시도.")
        return
    import base64

    def crop_b64(img, bbox):
        c = _crop_pad(img, bbox, pad=40)
        # 각 크롭 ≤ 400×200
        s = min(400 / c.shape[1], 200 / c.shape[0], 1.0)
        if s < 1.0:
            c = cv2.resize(c, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", c)
        return base64.standard_b64encode(buf.tobytes()).decode()

    client = anthropic.Anthropic()
    targets = [f for f in findings
               if f.severity != "expected" and f.type != "showthrough"
               and not dup_of_text_mismatch(f, findings)]
    content = [{"type": "text", "text":
                "다음은 인쇄물 검수에서 검출된 결함 후보들입니다. 각 후보마다 REF(승인 아트웍) "
                "크롭과 TEST(실물 스캔) 크롭이 순서대로 주어집니다. 각 후보를 "
                "defect(실제 인쇄 결함) | noise(스캔 노이즈/오탐) | expected(정상적 차이) 로 "
                '분류하고 JSON 배열로만 답하세요: [{"id": n, "verdict": "...", "reason": "한 줄"}]'}]
    for f in targets:
        content.append({"type": "text", "text": f"--- 후보 #{f.id} ({f.type}) REF/TEST ---"})
        for img in (ref, test_aligned):
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": "image/png",
                "data": crop_b64(img, f.bbox_ref)}})

    resp = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=2048,
        messages=[{"role": "user", "content": content}],
    )
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        start, end = text.index("["), text.rindex("]") + 1
        verdicts = {v["id"]: v for v in json.loads(text[start:end])}
    except (ValueError, KeyError, json.JSONDecodeError):
        print(f"[LLM] 응답 파싱 실패:\n{text}")
        return
    for f in targets:
        v = verdicts.get(f.id)
        if v:
            f.note += f" [LLM: {v['verdict']} — {v.get('reason', '')}]"
    print(f"[LLM] {len(verdicts)}/{len(targets)}건 검증 완료")


# ---------------------------------------------------------------------------
# 파이프라인 본체
# ---------------------------------------------------------------------------

def run_pipeline(ref_path: Path, test_path: Path, outdir: Path,
                 cfg: Config) -> list[Finding]:
    t0 = time.time()
    outdir.mkdir(parents=True, exist_ok=True)
    debug_dir = None
    if cfg.debug:
        debug_dir = outdir / "debug"
        debug_dir.mkdir(exist_ok=True)

    ref = imread_gray(ref_path)
    test = imread_gray(test_path)
    print(f"[입력] REF {ref.shape[1]}x{ref.shape[0]}, "
          f"TEST {test.shape[1]}x{test.shape[0]}")

    # 3.1 전역 정합
    aligned = global_align(ref, test, cfg)

    # 3.2 타일 정밀 정합
    if cfg.use_tile_refine:
        aligned = tile_refine(ref, aligned, cfg, debug_dir)
        tol = cfg.tol
    else:
        tol = cfg.tol_fallback
        print(f"[타일 정합] 생략(폴백 모드) — tol={tol}")
    imwrite(outdir / "aligned_test.png", aligned)

    # 3.3 이진화
    norm_test = flatten_background(aligned, cfg)
    ref_ink = ink_mask(ref, cfg)
    test_ink = ink_mask(norm_test, cfg)
    if debug_dir:
        imwrite(debug_dir / "norm_test.png", norm_test)
        imwrite(debug_dir / "ref_ink.png", ref_ink)
        imwrite(debug_dir / "test_ink.png", test_ink)

    # 3.4 구조 diff
    extra, missing, raw_extra, raw_missing = structural_diff(ref_ink, test_ink, tol)
    if debug_dir:
        imwrite(debug_dir / "extra.png", extra)
        imwrite(debug_dir / "missing.png", missing)

    # 3.5 군집화 (+ 망점 톤 차이 억제)
    cbox = content_bbox_of(ref_ink)
    extra_comps = cluster_components(extra, raw_extra, norm_test,
                                     cfg.extra_max_norm, cfg, ref.shape, cbox)
    missing_comps = cluster_components(missing, raw_missing, ref,
                                       cfg.missing_max_ref, cfg, ref.shape, cbox)

    # 3.5b 리플로우 억제: diff 내용이 상대 이미지의 변위 위치에 그대로 있으면
    # 개정 줄 밀림으로 판정. extra는 TEST 크롭을 REF에서, missing은 REF 크롭을
    # TEST에서 찾는다.
    rf_scale = ref.shape[1] / REF_BASE_WIDTH
    rf_pad = max(round(cfg.reflow_pad * rf_scale), 16)
    rf_sx = max(round(cfg.reflow_search_x * rf_scale), 20)
    rf_sy = max(round(cfg.reflow_search_y * rf_scale), 40)
    rf_ex = max(round(cfg.reflow_exclude * rf_scale), 6)

    ref_ink_dil = cv2.dilate(ref_ink, ellipse(5))
    test_ink_dil = cv2.dilate(test_ink, ellipse(5))

    def is_reflow(src, dst, bbox, diff_mask, dst_ink_dil):
        """상관 매칭 + 픽셀 검증. 문맥이 자기유사(장선·여백)해 상관만으로는
        오억제될 수 있으므로, diff 잉크 픽셀이 변위 위치에서 실제 상대 잉크로
        덮이는지(reflow_min_cover)까지 확인한다."""
        corr, dx, dy = find_shifted_match(src, dst, bbox, rf_pad,
                                          rf_sx, rf_sy, exclude_r=rf_ex)
        if corr < cfg.reflow_min_corr:
            return False
        x, y, w, h = bbox
        ys_nz, xs_nz = np.nonzero(diff_mask[y:y + h, x:x + w])
        if len(ys_nz) == 0:
            return True
        hh, ww = dst_ink_dil.shape
        yy = np.clip(ys_nz + y + dy, 0, hh - 1)
        xx = np.clip(xs_nz + x + dx, 0, ww - 1)
        cover = float((dst_ink_dil[yy, xx] > 0).mean())
        return cover >= cfg.reflow_min_cover

    reflow_boxes: list[tuple] = []

    def split_reflow(comps, src, dst, diff_mask, dst_ink_dil):
        kept = []
        for c in comps:
            if is_reflow(src, dst, c["bbox"], diff_mask, dst_ink_dil):
                reflow_boxes.append(c["bbox"])
            else:
                kept.append(c)
        return kept

    n_extra_all, n_missing_all = len(extra_comps), len(missing_comps)
    extra_comps = split_reflow(extra_comps, norm_test, ref, raw_extra, ref_ink_dil)
    missing_comps = split_reflow(missing_comps, ref, norm_test,
                                 raw_missing, test_ink_dil)

    # 3.5c 질감 존 억제 — 번짐·흐릿 인쇄 지역의 소형 diff 는 결함이 아니라
    # 인쇄 품질 저하다. 실측(back-pair TEST-2, 2026-08-03 사용자 판정): 오탐
    # 4건의 주변(±150px)엔 <30px 부스러기가 119~219개, 실결함 주변은 2~49개
    # (실결함 곁 노이즈는 큰 덩어리 몇 개 — 인접 실결함의 잔재). 부스러기가
    # 많은 지역의 소형 성분만 억제하고, 큰 성분(세로 311px 실결함 등)은
    # 면적 면제로 지킨다.
    raw_all = cv2.bitwise_or(raw_extra, raw_missing)
    px2 = (ref.shape[1] / REF_BASE_WIDTH) ** 2
    speck_max = 18 * px2            # 부스러기로 칠 최대 면적
    # 실측: 오탐 존은 기준폭 환산 70~128개, 실결함 최대는 pga #2(REV 행
    # 메워짐)의 60개 — 65로 가른다
    speck_thresh = 65 * px2
    tz_pad = max(round(115 * ref.shape[1] / REF_BASE_WIDTH), 60)
    tz_exempt = 880 * px2           # 이 면적 이상 성분은 존과 무관하게 보고
    tz_extra_bright = 112           # extra 는 잉크가 이보다 옅을 때만 억제 —
    #                                 진짜 메워짐/스팟은 진하고(실측 84~108),
    #                                 번짐 잔재는 옅다(실측 121~130)

    def in_texture_zone(c, is_extra: bool) -> bool:
        if c["area"] >= tz_exempt:
            return False
        x, y, w2, h2 = c["bbox"]
        if is_extra:
            m = raw_extra[y:y + h2, x:x + w2] > 0
            if m.any() and float(norm_test[y:y + h2, x:x + w2][m].mean()) \
                    <= tz_extra_bright:
                return False
        hh, ww = raw_all.shape
        x0, y0 = max(x - tz_pad, 0), max(y - tz_pad, 0)
        x1, y1 = min(x + w2 + tz_pad, ww), min(y + h2 + tz_pad, hh)
        win = raw_all[y0:y1, x0:x1].copy()
        win[y - y0:y - y0 + h2, x - x0:x - x0 + w2] = 0   # 자기 자신 제외
        n, _, stats, _ = cv2.connectedComponentsWithStats(win, connectivity=8)
        specks = sum(1 for i in range(1, n)
                     if stats[i, cv2.CC_STAT_AREA] < speck_max)
        return specks >= speck_thresh

    n_tz = 0
    kept_e, kept_m = [], []
    for comps, kept, is_extra in ((extra_comps, kept_e, True),
                                  (missing_comps, kept_m, False)):
        for c in comps:
            if in_texture_zone(c, is_extra):
                n_tz += 1
            else:
                kept.append(c)
    extra_comps, missing_comps = kept_e, kept_m
    if n_tz:
        print(f"[질감] 번짐/흐릿 존 소형 diff 억제 {n_tz}건")

    findings: list[Finding] = []
    min_area_eff = cfg.min_area * (ref.shape[1] / REF_BASE_WIDTH) ** 2
    for c in extra_comps:
        findings.append(Finding(type="extra", bbox_ref=c["bbox"], area_px=c["area"],
                                metrics=area_margin(c["area"], min_area_eff)))
    for c in missing_comps:
        if in_margin(c["bbox"], ref.shape, cfg.margin_ratio):
            findings.append(Finding(type="trim_mark_expected",
                                    bbox_ref=c["bbox"], area_px=c["area"],
                                    note="재단선/레지스터 마크 (TEST 재단 완료) — 정상"))
        else:
            findings.append(Finding(type="missing", bbox_ref=c["bbox"],
                                    area_px=c["area"],
                                    metrics=area_margin(c["area"], min_area_eff)))

    # 3.4b 잉크 커버리지 — 픽셀 diff가 원리적으로 못 잡는 얇은 결손·옅은 인쇄.
    # 이미 보고된 결함·리플로우 영역과 겹치는 것은 중복이라 뺀다.
    cover_hits = faded_findings(ref_ink, test_ink, ref, norm_test, cfg, cbox)
    reported = [f.bbox_ref for f in findings] + reflow_boxes
    n_cover = 0
    for c in cover_hits:
        if any(boxes_intersect(c["bbox"], b) for b in reported):
            continue
        if in_margin(c["bbox"], ref.shape, cfg.margin_ratio):
            continue
        findings.append(Finding(
            type="faded", bbox_ref=c["bbox"], area_px=c["area"],
            note=f"인쇄 농도 부족 — 잉크 진하기가 이 페이지 평균의 "
                 f"{c['dark_ratio'] * 100:.0f}% 수준(옅게 인쇄됨)",
            # 농도는 낮을수록 결함이라 여유도가 판정선/실측값 비율이다.
            metrics={"margin": round(c["lim"] / c["dark_ratio"], 3)
                               if c["dark_ratio"] > 0 else None,
                     "basis": f"농도비 {c['dark_ratio']:.3f} / 판정선 {c['lim']:.3f}"}))
        n_cover += 1
    if cover_hits:
        print(f"[농도] 옅은 인쇄 후보 {len(cover_hits)}건 → 신규 보고 {n_cover}건")

    # 3.6 뒷비침 (밀린 본문 텍스트가 고스트로 오탐되는 경우도 리플로우 매칭으로 억제)
    # 위/아래 밀림량이 다른 경계 성분은 단일 변위 매칭이 실패할 수 있으므로,
    # 이미 리플로우로 억제된 영역과 유의미하게 겹치는 성분도 함께 억제한다.
    ink_reflow_boxes = list(reflow_boxes)

    def overlaps_reflow(bbox):
        x, y, w, h = bbox
        for rx, ry, rw, rh in ink_reflow_boxes:
            ix = max(0, min(x + w, rx + rw) - max(x, rx))
            iy = max(0, min(y + h, ry + rh) - max(y, ry))
            if ix * iy > 0.1 * w * h:
                return True
        return False

    st_comps = detect_showthrough(norm_test, ref, cfg, cbox)
    st_comps = split_reflow(st_comps, norm_test, ref, test_ink, ref_ink_dil)
    st_kept = []
    for c in st_comps:
        if overlaps_reflow(c["bbox"]):
            reflow_boxes.append(c["bbox"])
        else:
            st_kept.append(c)
    st_comps = st_kept
    for c in st_comps:
        findings.append(Finding(type="showthrough", bbox_ref=c["bbox"],
                                area_px=c["area"],
                                note="뒷면 인쇄 비침(show-through) — 옅은 회색 고스트",
                                metrics=area_margin(c["area"], cfg.ghost_min_area)))
    print(f"[diff] extra {len(extra_comps)}/{n_extra_all}, "
          f"missing {len(missing_comps)}/{n_missing_all}, "
          f"showthrough {len(st_comps)}, 리플로우 억제 {len(reflow_boxes)}건")

    if reflow_boxes:
        xs0 = min(b[0] for b in reflow_boxes)
        ys0 = min(b[1] for b in reflow_boxes)
        xs1 = max(b[0] + b[2] for b in reflow_boxes)
        ys1 = max(b[1] + b[3] for b in reflow_boxes)
        findings.append(Finding(
            type="layout_reflow", severity="expected",
            bbox_ref=(xs0, ys0, xs1 - xs0, ys1 - ys0),
            area_px=sum(b[2] * b[3] for b in reflow_boxes),
            note=f"개정 줄 밀림(reflow) 영역 {len(reflow_boxes)}건 — 동일 내용이 "
                 "국소 이동만 된 것으로 결함 아님. 문구 변경 자체는 "
                 "text_mismatch로 별도 보고됨"))

    # 3.7 OCR
    ref_words: list[dict] = []
    rev_lines: list[tuple] = []
    if cfg.use_ocr:
        try:
            t_ocr = time.time()
            ref_words = ocr_words(ref, cfg)
            test_words = ocr_words(aligned, cfg)
            print(f"[OCR] REF {len(ref_words)}단어, TEST {len(test_words)}단어 "
                  f"({time.time() - t_ocr:.1f}s)")
            rev_lines = line_boxes_with(ref_words, "REV")
            for mm in text_mismatches(ref_words, test_words):
                ok, ev_bbox = pixel_evidence(mm, ref_ink, test_ink)
                if not ok:
                    continue
                # 리플로우 지역에서는 국소 diff가 커서 픽셀 대조가 무력화됨 —
                # 동일 글리프가 변위 위치에 있으면 OCR 오독으로 보고 제외
                if mm["tag"] == "delete":
                    rf_args = (ref, norm_test, ref_ink, test_ink_dil)
                else:
                    rf_args = (norm_test, ref, test_ink, ref_ink_dil)
                if is_reflow(rf_args[0], rf_args[1], mm["bbox"],
                             rf_args[2], rf_args[3]):
                    continue
                bbox = ev_bbox or mm["bbox"]
                findings.append(Finding(
                    type="text_mismatch", bbox_ref=bbox,
                    area_px=bbox[2] * bbox[3],
                    note=f"OCR 불일치: '{mm['ref_text']}' → '{mm['test_text']}'"))
        except Exception as e:  # tesseract 미설치 등
            print(f"[OCR] 실패({e}) — OCR 경로 생략. --no-ocr 로 경고 억제 가능.")

    # 3.8 심각도
    box_mask = ruled_box_mask(ref_ink)
    if debug_dir:
        imwrite(debug_dir / "box_mask.png", box_mask)
    for f in findings:
        f.severity = classify_severity(f, ref_words, rev_lines, box_mask)
        f.near_text = nearest_text(f.bbox_ref, ref_words)
        if not f.note:
            if f.type == "extra":
                f.note = "TEST에만 존재하는 잉여 잉크"
                if f.severity == "critical":
                    f.note += " — 문서번호/개정(REV) 행 침범"
                elif f.severity == "major":
                    f.note += " — 글자/괘선 영역 침범"
            elif f.type == "missing":
                f.note = "REF 대비 잉크 누락"

    # 정렬(위→아래, 좌→우) 후 번호 부여: 화면에 표시되는 결함이 1..N 연속이
    # 되도록 표시 대상(억제·뒷비침·expected 제외)을 먼저 배치한다.
    def _pos_key(f):
        return (f.bbox_ref[1], f.bbox_ref[0])

    shown = sorted((f for f in findings
                    if f.severity != "expected" and f.type != "showthrough"
                    and not dup_of_text_mismatch(f, findings)), key=_pos_key)
    rest = sorted((f for f in findings if f not in shown), key=_pos_key)
    findings[:] = shown + rest
    for i, f in enumerate(findings, 1):
        f.id = i

    # 6. LLM 검증 훅(선택)
    if cfg.llm_verify:
        llm_verify(findings, ref, aligned)

    # 3.9 리포트
    render_annotated(aligned, findings, outdir / "annotated.png")
    render_contact_sheet(ref, aligned, findings, outdir / "contact_sheet.png")
    write_reports(findings, outdir)
    print_summary(findings)
    print(f"\n[완료] {time.time() - t0:.1f}s, 산출물: {outdir}")
    return findings


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(
        description="인쇄 아트웍(REF) vs 실물 스캔(TEST) 결함 자동 검출")
    ap.add_argument("ref", type=Path, help="승인 아트웍 PNG (REF)")
    ap.add_argument("test", type=Path, help="실물 스캔 PNG (TEST)")
    ap.add_argument("-o", "--outdir", type=Path, required=True, help="출력 디렉토리")
    ap.add_argument("--tol", type=int, default=5, help="diff 팽창 허용치(px), 기본 5")
    # 기본값은 Config.min_area 와 같아야 한다 — 0039b01 에서 엔진 기본을 40으로
    # 내릴 때 CLI 만 60으로 남아, CLI 실행에서만 소형 결함(70~100px 오염)이
    # 빠지는 불일치가 있었다(실측: back-pair '10' 오염 87px 미검출).
    ap.add_argument("--min-area", type=int, default=40,
                    help="최소 diff 잉크 픽셀 수(REF 폭 5564 기준), 기본 40")
    ap.add_argument("--no-ocr", action="store_true", help="OCR 텍스트 대조 비활성")
    ap.add_argument("--no-tile-refine", action="store_true",
                    help="타일 정밀 정합 생략(폴백 모드, tol=13)")
    ap.add_argument("--llm-verify", action="store_true",
                    help="결함 후보 크롭을 Claude API로 검증(선택)")
    ap.add_argument("--debug", action="store_true", help="중간 마스크를 debug/에 저장")
    args = ap.parse_args(argv)

    cfg = Config(tol=args.tol, min_area=args.min_area,
                 use_ocr=not args.no_ocr,
                 use_tile_refine=not args.no_tile_refine,
                 llm_verify=args.llm_verify, debug=args.debug)
    run_pipeline(args.ref, args.test, args.outdir, cfg)


if __name__ == "__main__":
    main()

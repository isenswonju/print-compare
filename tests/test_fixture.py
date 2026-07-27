"""회귀 픽스처 테스트 — PGA1E0398 REF/TEST 쌍.

수락 기준:
  * 아래 9건이 모두 검출 (검출 bbox 중심이 기대 bbox ±80px 이내)
  * false positive ≤ 5건
  * 재단선/레지스터 마크는 trim_mark_expected로 분류, 결함 카운트 제외
  * #2는 REV 행이므로 CRITICAL
  * #9는 extra 또는 text_mismatch 중 최소 한 경로에서 검출

좌표 출처: 지시서 §5 표. 단, #2와 #5는 표의 근사 좌표가 실물과 어긋나
(픽셀·육안·OCR로 재검증한) 실좌표로 교정했다:
  * #2 "2025-04의 0 메워짐": 표 (4740,690,130,60) → 실측 (4900,700,100,60).
    REF에서 "398 REV3 2025-04"의 '0' 글리프는 x≈4946에 위치하며, TEST에서
    해당 '0'이 메워진 것을 크롭으로 확인.
  * #5 "expiration의 n 잉크 뭉침": 표 (1830,2955,190,90) → 실측 (1700,2960,40,40).
    OCR 기준 해당 행의 "expiration"은 x 1488~1734에 있고(표 좌표는 단어 우측
    여백을 가리킴), TEST에서 마지막 'n'의 잉크 뭉침을 크롭으로 확인.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_artwork import Config, run_pipeline  # noqa: E402

FIXTURE_DIR = Path(__file__).parent / "fixtures"
REF = FIXTURE_DIR / "PGA1E0398_REF.png"
TEST = FIXTURE_DIR / "PGA1E0398_TEST.png"

TOL = 80  # bbox 중심 오차 허용(px)

# (번호, 허용 유형들, 기대 bbox, CRITICAL 필수 여부)
EXPECTED = [
    (1, {"extra"},                  (1520,  670, 200, 170), False),
    (2, {"extra"},                  (4900,  700, 100,  60), True),   # REV 행 — 실측 교정
    (3, {"extra"},                  (4850, 1215, 130, 140), False),
    (4, {"extra", "text_mismatch"}, (3390, 2635, 130, 130), False),
    (5, {"extra"},                  (1700, 2960,  40,  40), False),  # 실측 교정
    (6, {"showthrough"},            (512,  5469, 2157, 606), False),
    (7, {"extra"},                  (1330, 6340, 160,  90), False),
    (8, {"extra", "text_mismatch"}, (3930, 6090, 190,  80), False),
    (9, {"extra", "text_mismatch"}, (3950, 4695, 140,  70), False),
]


def center(bbox):
    x, y, w, h = bbox
    return (x + w / 2, y + h / 2)


def matches(finding, exp_bbox):
    """검출 bbox 중심이 기대 bbox를 ±TOL 만큼 확장한 영역 안에 있으면 매칭."""
    cx, cy = center(finding["bbox_ref"])
    x, y, w, h = exp_bbox
    return (x - TOL <= cx <= x + w + TOL) and (y - TOL <= cy <= y + h + TOL)


@pytest.fixture(scope="session")
def findings(tmp_path_factory):
    outdir = tmp_path_factory.mktemp("out")
    run_pipeline(REF, TEST, outdir, Config())
    data = json.loads((outdir / "findings.json").read_text(encoding="utf-8"))
    return data, outdir


def test_all_nine_defects_detected(findings):
    data, _ = findings
    missed = []
    for num, types, bbox, _ in EXPECTED:
        hits = [f for f in data if f["type"] in types and matches(f, bbox)]
        if not hits:
            missed.append(num)
    assert not missed, f"미검출 결함: {missed}"


def test_rev_row_defect_is_critical(findings):
    data, _ = findings
    num, types, bbox, _ = EXPECTED[1]
    hits = [f for f in data if f["type"] in types and matches(f, bbox)]
    assert hits, "#2 (REV 행 0 메워짐) 미검출"
    assert any(f["severity"] == "critical" for f in hits), \
        f"#2는 CRITICAL이어야 함: {hits}"


def test_defect9_detected_by_diff_or_ocr(findings):
    data, _ = findings
    num, types, bbox, _ = EXPECTED[8]
    hits = [f for f in data if f["type"] in ("extra", "text_mismatch")
            and matches(f, bbox)]
    assert hits, "#9 (Control→Oontrol) — 정밀 diff/OCR 어느 경로에서도 미검출"


def test_false_positives_within_budget(findings):
    data, _ = findings
    fps = []
    for f in data:
        if f["type"] == "trim_mark_expected":
            continue
        if any(f["type"] in types and matches(f, bbox)
               for _, types, bbox, _ in EXPECTED):
            continue
        fps.append(f)
    assert len(fps) <= 5, (
        f"false positive {len(fps)}건 (> 5): "
        + "; ".join(f"#{f['id']} {f['type']} {f['bbox_ref']}" for f in fps))


def test_trim_marks_expected_and_excluded(findings):
    data, _ = findings
    trims = [f for f in data if f["type"] == "trim_mark_expected"]
    assert len(trims) >= 4, f"재단선/레지스터 마크 성분 부족: {len(trims)}"
    assert all(f["severity"] == "expected" for f in trims), \
        "trim_mark_expected는 severity=expected여야 함"
    # 네 모서리 각각에 최소 1건
    w, h = 5564, 7100
    corners = {"TL": (0, 0), "TR": (w, 0), "BL": (0, h), "BR": (w, h)}
    for name, (cx, cy) in corners.items():
        near = [f for f in trims
                if abs(center(f["bbox_ref"])[0] - cx) < w * 0.15
                and abs(center(f["bbox_ref"])[1] - cy) < h * 0.15]
        assert near, f"{name} 모서리 재단선 미분류"


def test_output_artifacts_exist(findings):
    _, outdir = findings
    for name in ("aligned_test.png", "annotated.png", "contact_sheet.png",
                 "findings.json", "findings.csv"):
        assert (outdir / name).exists(), f"산출물 누락: {name}"
    # CSV UTF-8 BOM 확인 (엑셀 열람용)
    raw = (outdir / "findings.csv").read_bytes()
    assert raw[:3] == b"\xef\xbb\xbf", "findings.csv는 UTF-8 BOM이어야 함"

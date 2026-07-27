"""리플로우 회귀 테스트 — test2/ REV2(REF) vs REV3(TEST) 쌍.

REF와 TEST가 서로 다른 개정판이라 문구 추가로 이후 본문이 줄 단위로
밀리는(reflow) 케이스. 수락 기준:
  * 진짜 변경점 검출: REV 행 변경(REV2 2020/11 → REV3 2025-04)이
    text_mismatch CRITICAL로, 습도 문구 추가 단락이 검출됨
  * 밀린 줄들이 결함으로 오탐되지 않음 — 결함(비 expected) ≤ 25건
    (리플로우 억제 전에는 200건 이상 쏟아졌다)
  * showthrough 오탐 없음 (이 스캔에 진성 고스트 없음)
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_artwork import Config, run_pipeline  # noqa: E402

DATA_DIR = Path(__file__).resolve().parents[1] / "test2"
REF = DATA_DIR / "REF.png"
TEST = DATA_DIR / "TEST.png"

pytestmark = pytest.mark.skipif(
    not (REF.exists() and TEST.exists()), reason="test2 이미지 없음")


@pytest.fixture(scope="module")
def findings(tmp_path_factory):
    out = tmp_path_factory.mktemp("out_reflow")
    return [f.to_dict() for f in run_pipeline(REF, TEST, out, Config())]


def defects(findings):
    return [f for f in findings if f["severity"] != "expected"]


def test_rev_change_detected(findings):
    assert any(f["type"] == "text_mismatch" and f["severity"] == "critical"
               and "REV2" in f["note"] and "REV3" in f["note"]
               for f in findings), "REV 행 변경이 text_mismatch로 검출돼야 함"


def test_changed_paragraph_detected(findings):
    # 습도 문구가 추가된 STORAGE 첫 단락(y≈1874~2081) 영역 검출
    assert any(f["type"] in ("text_mismatch", "extra", "missing")
               and 1800 <= f["bbox_ref"][1] <= 2100
               for f in defects(findings)), "변경 단락이 검출돼야 함"


def test_reflow_suppressed(findings):
    n = len(defects(findings))
    assert n <= 25, f"리플로우 오탐 억제 실패 — 결함 {n}건 (기대 ≤ 25)"
    assert any(f["type"] == "layout_reflow" for f in findings), \
        "억제된 리플로우 영역이 layout_reflow로 보고돼야 함"


def test_no_showthrough_false_positive(findings):
    st = [f for f in defects(findings) if f["type"] == "showthrough"]
    assert not st, f"showthrough 오탐 {len(st)}건: {[f['bbox_ref'] for f in st]}"

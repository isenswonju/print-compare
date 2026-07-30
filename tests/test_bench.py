"""정확도 안전망(bench) 자체의 회귀 테스트.

안전망이 조용히 망가지면(계약을 안 보거나, 표류를 못 잡거나) 엔진 회귀가 그대로
통과한다. 그래서 채점·표류 판정 로직은 실물 이미지 없이 빠르게 검사한다.
실물 케이스 실행은 `python -m bench.run` 담당.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench.cases import case_from_dict, load_cases  # noqa: E402
from bench.report import Drift, compare_baseline, iou, record_of  # noqa: E402
from bench.score import brief, is_defect, score  # noqa: E402


def finding(fid, ftype, bbox, severity="major", margin=None, note=""):
    f = {"id": fid, "type": ftype, "severity": severity, "bbox_ref": list(bbox),
         "area_px": bbox[2] * bbox[3], "near_text": "", "note": note}
    if margin is not None:
        f["metrics"] = {"margin": margin, "basis": "테스트"}
    return f


def labeled(**kw):
    base = {"id": "t", "kind": "labeled", "source": {"ref": "a", "test": "b"},
            "fp_budget": 0}
    return case_from_dict({**base, **kw})


REF_W = 5564


# --------------------------------------------------------------- 계약(1층)
def test_must_find_hit_and_margin():
    case = labeled(must_find=[{"id": "d1", "types": ["extra"],
                               "bbox": [1000, 1000, 50, 50]}])
    sc = score(case, [finding(1, "extra", (1010, 1010, 40, 40), margin=2.5)], REF_W)
    assert sc.ok and not sc.missed
    assert sc.margins() == {"d1": 2.5}
    assert sc.recall == (1, 1)


def test_must_find_miss_is_failure():
    case = labeled(must_find=[{"id": "d1", "bbox": [1000, 1000, 50, 50]}])
    sc = score(case, [finding(1, "extra", (4000, 4000, 40, 40))], REF_W)
    assert not sc.ok
    assert sc.missed == ["d1"]
    assert any("must_find 누락" in m for m in sc.failures)


def test_type_must_match_when_specified():
    case = labeled(must_find=[{"id": "d1", "types": ["showthrough"],
                               "bbox": [1000, 1000, 50, 50]}],
                   fp_budget=1)
    sc = score(case, [finding(1, "extra", (1000, 1000, 50, 50))], REF_W)
    assert sc.missed == ["d1"], "유형이 다른 검출로 라벨을 만족시켜선 안 된다"


def test_tolerance_scales_with_resolution():
    """라벨 좌표 허용 오차는 REF 폭에 비례한다(저해상도 스캔에서 과대 허용 금지)."""
    case = labeled(must_find=[{"id": "d1", "bbox": [1000, 1000, 10, 10],
                               "tol": 80}])
    near = finding(1, "extra", (1085, 1000, 5, 5))       # 라벨에서 75px
    assert score(case, [near], REF_W).ok                  # 폭 5564 → 허용 80px
    sc = score(case, [near], REF_W // 4)                  # 폭 1391 → 허용 20px
    assert sc.missed == ["d1"]


def test_point_label_from_user_feedback():
    """사용자 피드백의 미검출 좌표는 점 하나뿐이다 — 허용 반경으로 매칭한다."""
    case = labeled(must_find=[{"id": "m1", "point": [2000, 3000]}])
    assert score(case, [finding(1, "missing", (1960, 2970, 30, 30))], REF_W).ok


def test_critical_label_requires_critical_severity():
    case = labeled(must_find=[{"id": "d2", "bbox": [1000, 1000, 50, 50],
                               "critical": True}])
    sc = score(case, [finding(1, "extra", (1000, 1000, 50, 50), "major")], REF_W)
    assert not sc.ok and any("critical" in m for m in sc.failures)
    ok = score(case, [finding(1, "extra", (1000, 1000, 50, 50), "critical")], REF_W)
    assert ok.ok


def test_forbid_zone_revival_is_failure():
    case = labeled(forbid=[{"id": "fp-망점", "bbox": [0, 0, 500, 500],
                            "note": "사용자 확인 오탐"}], fp_budget=9)
    sc = score(case, [finding(1, "extra", (100, 100, 20, 20))], REF_W)
    assert not sc.ok
    assert sc.forbid_hits and "결함 부활" in sc.failures[0]


def test_fp_budget():
    case = labeled(fp_budget=1)
    one = score(case, [finding(1, "extra", (10, 10, 5, 5))], REF_W)
    assert one.ok and len(one.fps) == 1
    two = score(case, [finding(1, "extra", (10, 10, 5, 5)),
                       finding(2, "extra", (900, 900, 5, 5))], REF_W)
    assert not two.ok and "예산" in two.failures[0]


def test_expected_and_reflow_are_not_defects():
    """재단선·리플로우는 결함으로 세지 않는다(예산 소모 없음)."""
    case = labeled(fp_budget=0)
    sc = score(case, [
        finding(1, "trim_mark_expected", (0, 0, 50, 50), "expected"),
        finding(2, "layout_reflow", (10, 10, 100, 100), "expected"),
    ], REF_W)
    assert sc.ok and sc.defects_total == 0
    assert not is_defect({"type": "extra", "severity": "expected"})


def test_waived_label_is_excluded_from_gate_but_reported():
    """원장에 적힌 포기 라벨은 게이트에서 빠지되 현황은 보고된다."""
    case = labeled(must_find=[{"id": "thin_stroke", "bbox": [10, 10, 8, 8]}],
                   waived=[{"label": "thin_stroke", "commit": "abc",
                            "lost": "획 끊김", "gained": "오탐 폭증 방지"}])
    sc = score(case, [], REF_W)
    assert sc.ok, "포기 라벨은 FAIL을 만들지 않는다"
    assert sc.waived_missed == ["thin_stroke"]

    revived = score(case, [finding(1, "missing", (10, 10, 8, 8))], REF_W)
    assert revived.ok
    assert revived.waived_found == ["thin_stroke"]
    assert any("원장" in w for w in revived.warnings), "되살아났으면 알려야 한다"
    assert not revived.fps, "포기 라벨 위치의 검출은 오탐이 아니다"


# --------------------------------------------------------------- 표류(2층)
def base_with(rec: dict) -> dict:
    return {"version": 1, "records": {"python/t": rec}}


def make_record(fp_count=1, margins=None, unlabeled=None, elapsed=10.0):
    return {"accepted_at": "2026-07-30T00:00:00+09:00",
            "fingerprint": {"config_hash": "aaa", "commit": "c0"},
            "recall": [1, 1], "fp_count": fp_count,
            "margins": margins or {}, "unlabeled": unlabeled or [],
            "elapsed_s": elapsed, "defects_total": fp_count,
            "findings_total": fp_count}


def test_new_and_lost_unlabeled_findings_are_drift():
    case = labeled(fp_budget=5)
    prev = [{"type": "extra", "severity": "minor", "bbox": [100, 100, 20, 20],
             "note": "", "margin": None}]
    sc = score(case, [finding(1, "extra", (3000, 3000, 20, 20))], REF_W)
    d = compare_baseline(sc, "python", 10.0, {"config_hash": "aaa", "commit": "c0"},
                         base_with(make_record(fp_count=1, unlabeled=prev)))
    assert len(d.new) == 1 and len(d.lost) == 1
    assert d.fp_delta == 0, "건수는 같고 자리만 바뀐 경우도 표류로 보여야 한다"


def test_margin_drop_is_flagged():
    case = labeled(must_find=[{"id": "d1", "bbox": [1000, 1000, 50, 50]}])
    sc = score(case, [finding(1, "extra", (1000, 1000, 50, 50), margin=1.05)], REF_W)
    d = compare_baseline(sc, "python", 10.0, {"config_hash": "aaa", "commit": "c0"},
                         base_with(make_record(fp_count=0, margins={"d1": 1.60})))
    assert d.margin_drops == [("d1", 1.60, 1.05)]


def test_margin_stable_is_not_flagged():
    case = labeled(must_find=[{"id": "d1", "bbox": [1000, 1000, 50, 50]}])
    sc = score(case, [finding(1, "extra", (1000, 1000, 50, 50), margin=1.55)], REF_W)
    d = compare_baseline(sc, "python", 10.0, {"config_hash": "aaa", "commit": "c0"},
                         base_with(make_record(fp_count=0, margins={"d1": 1.60})))
    assert not d.margin_drops


def test_no_baseline_returns_none():
    sc = score(labeled(), [], REF_W)
    assert compare_baseline(sc, "python", 1.0, {}, {"version": 1, "records": {}}) is None


def test_threshold_change_is_reported():
    sc = score(labeled(), [], REF_W)
    d = compare_baseline(sc, "python", 10.0,
                         {"config_hash": "bbb", "commit": "c0"},
                         base_with(make_record(fp_count=0)))
    assert "config_hash" in d.env_changed


def test_commit_change_alone_is_not_reported():
    """커밋은 고칠 때마다 바뀐다 — 매번 뜨는 경고는 아무도 읽지 않는다."""
    sc = score(labeled(), [], REF_W)
    d = compare_baseline(sc, "python", 10.0,
                         {"config_hash": "aaa", "commit": "c99"},
                         base_with(make_record(fp_count=0)))
    assert not d.env_changed and d.empty


def test_slowdown_threshold():
    sc = score(labeled(), [], REF_W)
    fp = {"config_hash": "aaa", "commit": "c0"}
    assert compare_baseline(sc, "python", 12.0, fp,
                            base_with(make_record(fp_count=0, elapsed=10.0))
                            ).slowdown is None
    assert compare_baseline(sc, "python", 14.0, fp,
                            base_with(make_record(fp_count=0, elapsed=10.0))
                            ).slowdown == 1.4


def test_iou_matching():
    assert iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert iou([0, 0, 10, 10], [100, 100, 10, 10]) == 0.0
    assert 0.3 < iou([0, 0, 10, 10], [2, 2, 10, 10]) < 1.0


def test_record_round_trips_as_json():
    case = labeled(must_find=[{"id": "d1", "bbox": [1000, 1000, 50, 50]}],
                   fp_budget=2)
    sc = score(case, [finding(1, "extra", (1000, 1000, 50, 50), margin=3.0),
                      finding(2, "missing", (4000, 10, 30, 30))], REF_W)
    rec = record_of(sc, "python", 12.3, {"commit": "abc", "config_hash": "h"})
    assert json.loads(json.dumps(rec, ensure_ascii=False))["margins"] == {"d1": 3.0}
    assert rec["fp_count"] == 1


# --------------------------------------------------------------- 케이스 적재
def test_expand_multiplies_cases():
    cases = load_cases()
    ids = {c.id for c in cases}
    assert "benign-shift_rotate" in ids and "benign-combo" in ids
    assert "inject-erase_word-degraded" in ids
    assert "pga1e0398" in ids


def test_every_case_id_is_unique_and_grouped():
    cases = load_cases()
    assert len(cases) == len({c.id for c in cases})
    assert all(c.group in ("guard", "tune") for c in cases)
    assert all(c.kind in ("labeled", "identity", "benign", "injected")
               for c in cases)


def test_identity_and_benign_cases_have_zero_budget():
    """공짜 오탐 감시망의 정답은 '결함 0건'이다 — 예산을 열어두면 의미가 없다."""
    for c in load_cases():
        if c.kind in ("identity", "benign"):
            assert c.fp_budget == 0, c.id
            assert not c.must_find, c.id


def test_labeled_case_missing_image_is_skipped_not_failed():
    from bench.cases import MissingImages
    case = labeled(source={"ref": "없는파일-ref.png", "test": "없는파일-test.png"})
    with pytest.raises(MissingImages):
        case.materialize()


def test_brief_keeps_margin_and_truncates_note():
    f = finding(1, "extra", (1, 2, 3, 4), margin=1.5, note="가" * 200)
    b = brief(f)
    assert b["margin"] == 1.5 and len(b["note"]) == 60


# --------------------------------------------------------------- 판정용 크롭
def test_crops_pair_ref_and_test(tmp_path):
    import cv2
    import numpy as np
    from bench.crops import drift_items, save_crops

    ref = np.full((400, 600), 255, np.uint8)
    cv2.rectangle(ref, (100, 100), (160, 160), 0, -1)
    test = ref.copy()
    cv2.circle(test, (300, 200), 12, 0, -1)          # TEST에만 있는 잉크
    cv2.imwrite(str(tmp_path / "ref.png"), ref)
    cv2.imwrite(str(tmp_path / "test.png"), test)

    case = labeled(fp_budget=1)
    sc = score(case, [finding(1, "extra", (288, 188, 24, 24))], REF_W)
    items = drift_items(sc, None)
    assert len(items) == 1 and items[0]["tag"] == "오탐"

    saved = save_crops("t", tmp_path / "ref.png", tmp_path / "test.png", None,
                       items, tmp_path / "out")
    assert saved == ["crops/t/오탐-1.png"]
    img = cv2.imread(str(tmp_path / "out" / saved[0]), cv2.IMREAD_GRAYSCALE)
    assert img is not None and img.shape[1] > 24 * 2, "REF·TEST가 나란히 붙어야 한다"


def test_crops_are_capped_and_deduped(tmp_path):
    import cv2
    import numpy as np
    from bench.crops import save_crops
    img = np.full((400, 600), 255, np.uint8)
    cv2.imwrite(str(tmp_path / "a.png"), img)
    items = [{"tag": "오탐", "bbox": [10, 10, 5, 5]} for _ in range(30)]
    saved = save_crops("t", tmp_path / "a.png", tmp_path / "a.png", None, items,
                       tmp_path / "out", limit=12)
    assert len(saved) == 12


def test_crops_skip_when_nothing_to_judge(tmp_path):
    from bench.crops import save_crops
    assert save_crops("t", tmp_path / "없음.png", tmp_path / "없음.png", None,
                      [], tmp_path / "out") == []


# --------------------------------------------------- 피드백 → 케이스 변환
def png_data_url(seed: int) -> str:
    import base64

    import cv2
    import numpy as np
    img = np.full((40, 60), 255, np.uint8)
    img[10:20, 10 + seed:20 + seed] = 0
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def feedback_payload(**over):
    item = {
        "set": "PGA 라벨 앞면",
        "findings": [
            {"id": 1, "type": "extra", "severity": "major",
             "bbox_ref": [100, 100, 20, 20], "note": ""},
            {"id": 2, "type": "faded", "severity": "minor",
             "bbox_ref": [900, 900, 30, 30], "note": ""},
            {"id": 3, "type": "trim_mark_expected", "severity": "expected",
             "bbox_ref": [0, 0, 10, 10], "note": ""},
        ],
        "feedback": {
            "defects": [
                {"id": 1, "fp": False, "ktype": "잉크 스팟", "type": "extra",
                 "bbox": [100, 100, 20, 20], "comment": "실제 결함"},
                {"id": 2, "fp": True, "ktype": "옅은 인쇄",
                 "bbox": [900, 900, 30, 30], "cause": "망점 톤 차이"},
            ],
            "missed": [{"x": 2000, "y": 3000, "comment": "여기 점 놓쳤음"}],
        },
        "refImage": png_data_url(0),
        "testImage": png_data_url(5),
    }
    item.update(over)
    return {"received": "2026-07-30T20:00:00",
            "data": {"app": "artwork-compare-web", "items": [item]}}


@pytest.fixture
def importer(tmp_path, monkeypatch):
    from bench import import_feedback as imp
    monkeypatch.setattr(imp, "CASE_DIR", tmp_path / "cases")
    monkeypatch.setattr(imp, "IMAGE_DIR", tmp_path / "images")
    (tmp_path / "cases").mkdir()
    src = tmp_path / "feedback.jsonl"
    src.write_text(json.dumps(feedback_payload(), ensure_ascii=False) + "\n",
                   encoding="utf-8")
    return imp, src, tmp_path


def test_import_maps_user_labels_to_contract(importer):
    imp, src, tmp = importer
    assert imp.main(["--source", str(src)]) == 0
    files = list((tmp / "cases").glob("*.json"))
    assert len(files) == 1
    case = json.loads(files[0].read_text(encoding="utf-8"))

    # 정탐 → must_find(유형 포함), 오탐 → forbid, 미검출 좌표 → 점 라벨
    ids = {m["id"] for m in case["must_find"]}
    assert ids == {"d1", "m1"}
    assert [m for m in case["must_find"] if m["id"] == "d1"][0]["types"] == ["extra"]
    assert [m for m in case["must_find"] if m["id"] == "m1"][0]["point"] == [2000, 3000]
    assert len(case["forbid"]) == 1 and "망점 톤 차이" in case["forbid"][0]["note"]
    # 새 케이스는 홀드아웃(guard) — 임계값 튜닝에 쓰지 않는다
    assert case["group"] == "guard"
    # 라벨이 붙은 검출은 예산에서 빠지고, 재단선은 애초에 결함이 아니다
    assert case["fp_budget"] == 0
    # 이미지는 private/(git 제외)에 저장된다
    stem = files[0].stem
    assert (tmp / "images" / stem / "REF.png").exists()
    assert (tmp / "images" / stem / "TEST.png").exists()
    assert case["source"]["ref"].startswith("private/bench-cases/")


def test_import_is_idempotent_and_preserves_ledger(importer):
    imp, src, tmp = importer
    imp.main(["--source", str(src)])
    path = list((tmp / "cases").glob("*.json"))[0]
    case = json.loads(path.read_text(encoding="utf-8"))
    case["waived"] = [{"label": "d1", "commit": "abc", "lost": "x", "gained": "y"}]
    case["fp_budget"] = 0
    path.write_text(json.dumps(case, ensure_ascii=False), encoding="utf-8")

    imp.main(["--source", str(src)])       # 같은 피드백 재수입
    again = json.loads(path.read_text(encoding="utf-8"))
    assert again["waived"], "원장이 재수입으로 지워지면 안 된다"
    assert len(again["must_find"]) == 2, "같은 라벨이 중복 추가돼선 안 된다"
    assert len(again["forbid"]) == 1


def test_import_skips_feedback_without_images(importer):
    imp, _src, tmp = importer
    rec = feedback_payload()
    rec["data"]["items"][0].pop("refImage")
    src2 = tmp / "no-image.jsonl"
    src2.write_text(json.dumps(rec, ensure_ascii=False) + "\n", encoding="utf-8")
    assert imp.main(["--source", str(src2)]) == 0
    assert not list((tmp / "cases").glob("*.json"))


def test_import_ignores_error_reports(importer):
    imp, _src, tmp = importer
    rec = {"data": {"kind": "error", "items": [{"set": "x", "error": "정합 실패"}]}}
    src2 = tmp / "err.jsonl"
    src2.write_text(json.dumps(rec, ensure_ascii=False) + "\n", encoding="utf-8")
    assert imp.main(["--source", str(src2)]) == 0
    assert not list((tmp / "cases").glob("*.json"))


def test_import_dry_run_writes_nothing(importer):
    imp, src, tmp = importer
    imp.main(["--source", str(src), "--dry-run"])
    assert not list((tmp / "cases").glob("*.json"))
    assert not (tmp / "images").exists()

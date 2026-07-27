"""피드백 수집 서버(/feedback) 테스트 — webapp.py.

검수자 피드백이 서버로 제대로 전송·저장되는지 검증한다(오탐 튜닝의 입력이라
중요). Flask test client로 POST하고 feedback.jsonl + images/ 저장을 확인한다.
FEEDBACK_DIR을 tmp로 바꿔 저장소를 오염시키지 않는다.
"""

import base64
import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import webapp  # noqa: E402

Image = pytest.importorskip("PIL.Image", reason="테스트 이미지 생성에 Pillow 필요")


def _png_data_url() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(webapp, "FEEDBACK_DIR", tmp_path / "feedback")
    webapp.app.config["TESTING"] = True
    return webapp.app.test_client(), tmp_path / "feedback"


def test_feedback_saves_jsonl_and_separates_image(client):
    c, fb_dir = client
    payload = {
        "app": "artwork-compare-web",
        "items": [{
            "set": "세트1",
            "refImage": _png_data_url(),
            "testImage": _png_data_url(),
            "feedback": {
                "defects": [{"id": 1, "fp": True, "comment": "스캔 먼지"}],
                "missed": [{"x": 5, "y": 6, "comment": "여기 못잡음"}],
            },
        }],
    }
    r = c.post("/feedback", json=payload)
    assert r.status_code == 200
    assert r.get_json()["ok"] is True

    # jsonl 한 줄 기록
    lines = (fb_dir / "feedback.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    item = rec["data"]["items"][0]
    assert item["set"] == "세트1"
    # 피드백 내용 보존
    assert item["feedback"]["defects"][0]["comment"] == "스캔 먼지"
    assert item["feedback"]["missed"][0]["comment"] == "여기 못잡음"
    # 원본 이미지는 파일로 분리, jsonl엔 경로만
    assert "refImage" not in item and "testImage" not in item
    assert (fb_dir / item["refImageFile"]).is_file()
    assert (fb_dir / item["testImageFile"]).is_file()


def test_feedback_appends_multiple(client):
    c, fb_dir = client
    for i in range(3):
        assert c.post("/feedback", json={"items": [{"set": f"s{i}"}]}).status_code == 200
    lines = (fb_dir / "feedback.jsonl").read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3


def test_feedback_rejects_empty_body(client):
    c, _ = client
    r = c.post("/feedback", data="", content_type="application/json")
    assert r.status_code == 400


def test_feedback_options_preflight(client):
    c, _ = client
    r = c.open("/feedback", method="OPTIONS")
    assert r.status_code == 204
    assert r.headers.get("Access-Control-Allow-Methods")

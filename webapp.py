#!/usr/bin/env python3
"""webapp.py — 인쇄 검수 지원 서버 (경량).

검수·분석은 전부 브라우저판(web/, 정적 SPA)이 수행한다. 이 서버는 두 가지만 한다:
  1. /app/       — 브라우저판 정적 서빙 (사내망 접속용)
  2. /feedback   — 검수자 피드백 수집 → feedback/feedback.jsonl + images/
                   (오탐 튜닝의 입력 데이터. Claude가 "피드백 반영 개선" 요청 시 읽음)

옛 서버측 분석 웹 UI는 2026-07-24 제거됨. 분석 엔진(compare_artwork.py)은
브라우저판 정확도 검증과 튜닝의 기준으로 저장소에 유지된다.

실행:  python3 webapp.py --host 0.0.0.0   → http://<IP>:8501/app/
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import time
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, request, send_from_directory

BASE = Path(__file__).resolve().parent
WEB_DIST = BASE / "web" / "dist"
FEEDBACK_DIR = BASE / "feedback"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 피드백에 원본 이미지 포함

FEEDBACK_ALLOWED_ORIGINS = {
    "https://isenswonju-print-compare.static.hf.space",
}


@app.get("/")
def index():
    return redirect("/app/")


@app.get("/healthz")
def healthz():
    """건강검진 — 필요할 때 상태 확인에 사용한다.

    프로세스 생존은 launchd KeepAlive 가 지키므로, 여기서는 "살아 있는데
    일을 못 하는" 상태를 검사한다: 피드백 디렉터리 쓰기 가능 여부와 디스크
    여유. 실제 쓰기까지 해봐야 읽기전용 마운트·권한 문제를 잡는다.
    """
    ok, error = True, ""
    try:
        FEEDBACK_DIR.mkdir(exist_ok=True)
        probe = FEEDBACK_DIR / ".healthz-probe"
        probe.write_text(time.strftime("%Y-%m-%dT%H:%M:%S"), encoding="utf-8")
        probe.unlink()
    except Exception as e:  # noqa: BLE001
        ok, error = False, f"feedback 쓰기 실패: {e}"
    free_mb = shutil.disk_usage(BASE).free // 1_000_000
    if ok and free_mb < 500:
        ok, error = False, f"디스크 여유 부족: {free_mb}MB"
    body = jsonify(ok=ok, error=error, free_mb=free_mb,
                   dist_built=(WEB_DIST / "index.html").is_file())
    return body, (200 if ok else 503)


# ---------------------------------------------------------------------------
# 브라우저판(SPA) 정적 서빙
# ---------------------------------------------------------------------------

@app.get("/app")
def webapp_redirect():
    return redirect("/app/")


@app.get("/app/")
@app.get("/app/<path:name>")
def webapp_static(name="index.html"):
    if ".." in name:
        abort(404)
    if not (WEB_DIST / name).is_file():
        name = "index.html"          # SPA 폴백
    if not (WEB_DIST / name).is_file():
        abort(404)                   # dist 미빌드
    return send_from_directory(WEB_DIST, name)


# ---------------------------------------------------------------------------
# 피드백 수집
# ---------------------------------------------------------------------------

def _feedback_cors(resp):
    origin = request.headers.get("Origin", "")
    if origin in FEEDBACK_ALLOWED_ORIGINS:
        resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def _save_data_url(s: str, path_base: Path) -> str | None:
    """data URL을 파일로 저장하고 상대 경로를 반환 (jsonl 비대화 방지)."""
    try:
        header, b64 = s.split(",", 1)
        ext = ".png" if "png" in header else ".jpg"
        path = path_base.with_suffix(ext)
        path.write_bytes(base64.b64decode(b64))
        return str(path.relative_to(FEEDBACK_DIR))
    except Exception:  # noqa: BLE001 — 이미지 하나 실패가 피드백을 잃게 하면 안 됨
        return None


@app.route("/feedback", methods=["POST", "OPTIONS"])
def feedback():
    if request.method == "OPTIONS":
        return _feedback_cors(app.make_response(("", 204)))
    data = request.get_json(silent=True)
    if not data:
        abort(400, "JSON 본문이 필요합니다")
    FEEDBACK_DIR.mkdir(exist_ok=True)
    # 원본 이미지는 파일로 분리 저장하고 jsonl에는 경로만 남긴다
    ts = time.strftime("%Y%m%d_%H%M%S")
    img_dir = FEEDBACK_DIR / "images"
    for i, item in enumerate(data.get("items", [])):
        img_dir.mkdir(parents=True, exist_ok=True)
        for key, tag in (("refImage", "REF"), ("testImage", "TEST")):
            if item.get(key):
                rel = _save_data_url(item.pop(key), img_dir / f"{ts}_{i}_{tag}")
                if rel:
                    item[key + "File"] = rel
    rec = {
        "received": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "ip": request.remote_addr,
        "data": data,
    }
    with open(FEEDBACK_DIR / "feedback.jsonl", "a", encoding="utf-8") as fp:
        fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return _feedback_cors(jsonify(ok=True))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="인쇄 검수 지원 서버")
    ap.add_argument("--host", default="127.0.0.1",
                    help="0.0.0.0 이면 같은 네트워크의 다른 PC에서도 접속 가능")
    ap.add_argument("--port", type=int, default=8501)
    ap.add_argument("--no-reload", action="store_true",
                    help="코드 변경 시 자동 재시작(reloader) 끄기")
    args = ap.parse_args()
    if args.no_reload or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        print(f"\n  ▶ 브라우저판:  http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}/app/\n")
    # debug(Werkzeug 디버거)는 외부 공개 시 RCE 구멍 — 절대 켜지 말 것
    app.run(host=args.host, port=args.port, threaded=True,
            use_reloader=not args.no_reload)

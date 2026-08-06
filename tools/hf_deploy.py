"""브라우저판 HF Space 배포 — 빌드 → 업로드 → 실서비스 검증까지 한 명령.

엔진을 고치고 이 스크립트를 안 돌리면 구엔진이 계속 서비스된다
(실측: 2026-08-05 배포 누락으로 구엔진 오탐 45건이 재판정됨). 그래서
업로드가 끝나면 실제 서비스 URL 의 version.json 을 다시 읽어 로컬 엔진
지문(bench.engines.pipeline_hash)과 일치할 때까지 확인한다.

    python3 tools/hf_deploy.py             # build + upload + verify
    python3 tools/hf_deploy.py --no-build  # 이미 빌드된 dist 를 업로드
    python3 tools/hf_deploy.py --dry-run   # 업로드 없이 빌드·지문만 확인

매일 03:10 bench.sync 가 같은 지문을 대조해 배포 누락을 알림으로 잡는다.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench.engines import git_state, pipeline_hash  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "web" / "dist"
REPO_ID = "I-SENS/artwork-compare"
SPACE_URL = "https://i-sens-artwork-compare.static.hf.space"
VERIFY_TRIES = 10          # CDN 전파를 기다리는 재시도 횟수
VERIFY_WAIT_S = 20


def fetch_deployed_version(timeout: int = 15) -> dict:
    """서비스 중인 version.json. 캐시를 우회하도록 쿼리를 붙인다."""
    url = f"{SPACE_URL}/version.json?t={int(time.time())}"
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build() -> None:
    print("· npm run build (web/)")
    subprocess.run(["npm", "run", "build"], cwd=ROOT / "web", check=True)


def check_local_stamp() -> dict:
    """dist/version.json 이 지금의 소스와 일치하는지 — 낡은 빌드 업로드 방지."""
    stamp_file = DIST / "version.json"
    if not stamp_file.exists():
        raise SystemExit("dist/version.json 이 없다 — 빌드가 낡았다. "
                         "--no-build 를 빼고 다시 돌릴 것.")
    stamp = json.loads(stamp_file.read_text(encoding="utf-8"))
    local = pipeline_hash()
    if stamp.get("pipeline_hash") != local:
        raise SystemExit(f"dist 는 {stamp.get('pipeline_hash')} 인데 소스는 "
                         f"{local} — 빌드가 낡았다. --no-build 를 빼고 다시 돌릴 것.")
    return stamp


def upload(stamp: dict) -> None:
    from huggingface_hub import upload_folder
    gs = git_state()
    msg = (f"deploy {gs['commit']}{'+dirty' if gs['dirty'] else ''} "
           f"pipeline={stamp['pipeline_hash']}")
    print(f"· upload_folder → {REPO_ID} ({msg})")
    # delete_patterns: 해시 파일명이 매번 바뀌어 옛 번들이 무한히 쌓인다 — 청소.
    upload_folder(repo_id=REPO_ID, repo_type="space", folder_path=str(DIST),
                  commit_message=msg, delete_patterns=["assets/**"])


def verify(stamp: dict) -> None:
    want = stamp["pipeline_hash"]
    for i in range(VERIFY_TRIES):
        try:
            got = fetch_deployed_version().get("pipeline_hash")
        except Exception as e:
            got = f"(조회 실패: {e})"
        if got == want:
            print(f"✅ 배포 검증 완료 — 서비스 중인 엔진 지문 {got}")
            return
        print(f"  … 아직 {got}, 기대 {want} — {VERIFY_WAIT_S}s 후 재시도 "
              f"({i + 1}/{VERIFY_TRIES})")
        time.sleep(VERIFY_WAIT_S)
    raise SystemExit(f"❌ 업로드는 됐지만 {SPACE_URL} 이 아직 새 지문({want})을 "
                     f"내놓지 않는다. 잠시 후 bench.sync 가 다시 대조하니 "
                     f"수동으로 {SPACE_URL}/version.json 을 확인할 것.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-build", action="store_true",
                    help="빌드를 건너뛰고 dist 를 그대로 업로드")
    ap.add_argument("--dry-run", action="store_true",
                    help="업로드 없이 빌드와 지문 확인까지만")
    args = ap.parse_args(argv)

    if not args.no_build:
        build()
    stamp = check_local_stamp()
    print(f"· 로컬 엔진 지문 {stamp['pipeline_hash']} "
          f"(git {stamp.get('git')}{'+dirty' if stamp.get('dirty') else ''})")
    if stamp.get("dirty"):
        print("⚠️  커밋 안 된 엔진 변경이 빌드에 들어 있다 — 배포 후 꼭 커밋할 것.")
    if args.dry_run:
        print("· dry-run — 업로드 생략")
        return 0
    upload(stamp)
    verify(stamp)
    return 0


if __name__ == "__main__":
    sys.exit(main())

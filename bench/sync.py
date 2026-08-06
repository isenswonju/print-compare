"""매일 도는 정확도 점검 — launchd(`com.artwork-compare.bench-sync`)가 실행한다.

  0) 배포 지문 대조(배포 누락 감지) + 피드백 수집 경로 건강검진
  1) 공용 보관함에 새로 올라온 아트웍을 감시 케이스로 들여온다
  2) 전 케이스를 python 엔진으로 돌려 계약이 깨졌는지 본다
  3) 새 케이스가 생겼거나 게이트가 깨졌을 때만 알림을 띄운다

저장소를 더럽히지 않는다: 이력은 남기지 않고(`--no-history`), **기준선은 절대
자동 승인하지 않는다** — 자동으로 갱신하면 안전망이 그냥 로그가 된다. 사람이
결과를 보고 `--accept` 해야 한다. 새로 생긴 케이스 JSON만 작업 트리에 남는데,
그건 검토하고 커밋해야 하는 물건이라 그대로 두는 게 맞다.

`--if-stale`: 오늘 이미 완주한 이력이 있으면 그냥 통과(0)로 끝낸다. launchd 가
부팅/로그인 때마다(RunAtLoad) 따라잡기 실행을 걸어도 하루 한 번만 돌게 하는
가드다 — 이 기계는 03:10에 대개 꺼져 있어 달력 스케줄만으로는 영영 안 돈다.

수동 실행:  python3 -m bench.sync   (가드 없음 — 언제나 돈다)
"""
from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from .cases import CASE_DIR, ROOT

LOG = ROOT / "bench" / "out" / "sync.log"
PW_FILE = ROOT / "private" / ".library-password"
STAMP = ROOT / "bench" / "out" / ".last-sync-date"   # 완주한 날짜(YYYY-MM-DD)
MAX_LOG_LINES = 4000


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    if LOG.exists():
        lines = LOG.read_text(encoding="utf-8").splitlines()
        if len(lines) > MAX_LOG_LINES:      # 무한정 자라지 않게
            LOG.write_text("\n".join(lines[-MAX_LOG_LINES // 2:]) + "\n",
                           encoding="utf-8")
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG, "a", encoding="utf-8") as fp:
        fp.write(f"{stamp} {msg}\n")
    print(f"{stamp} {msg}", flush=True)


def notify(title: str, body: str) -> None:
    """GUI 세션이면 알림을 띄운다(아니면 조용히 넘어간다)."""
    try:
        subprocess.run(["/usr/bin/osascript", "-e",
                        f'display notification "{body}" with title "{title}"'],
                       capture_output=True, timeout=20)
    except Exception:
        pass


def case_files() -> set[str]:
    return {p.name for p in CASE_DIR.glob("*.json")}


SPACE_URL = "https://i-sens-artwork-compare.static.hf.space"


def check_deploy() -> bool:
    """서비스 중인 HF Space 의 엔진 지문이 로컬과 같은지 매일 대조한다.

    "엔진은 고쳤는데 재배포를 빠뜨림"(2026-08-05, 구엔진 오탐 45건 재판정)의
    재발 방지. 어긋나면 알림만 띄운다 — 자동 배포는 하지 않는다(빌드 검증 없이
    올리면 안전망이 아니라 사고 전파기가 된다). 재배포: tools/hf_deploy.py

    반환값: 네트워크로 Space 에 도달했는가 — check_feedback_health 가
    "오프라인"과 "상대 서버 장애"를 구분하는 데 쓴다.
    """
    import json
    import time
    import urllib.request
    from .engines import pipeline_hash

    local = pipeline_hash()
    url = f"{SPACE_URL}/version.json?t={int(time.time())}"
    try:
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            info = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            log("배포본에 version.json 이 없다 — version-stamp 이전 배포")
            notify("인쇄 검수 배포 ⚠️",
                   "HF Space 배포본이 낡았습니다(지문 없음). "
                   "python3 tools/hf_deploy.py 로 재배포하세요.")
        else:
            log(f"배포 지문 조회 실패(건너뜀): HTTP {e.code}")
        return True                      # HTTP 응답 = 네트워크는 살아 있다
    except Exception as e:
        # 오프라인/HF 장애 — 배포 문제라는 증거가 아니므로 조용히 넘어간다
        log(f"배포 지문 조회 실패(건너뜀): {e}")
        return False

    deployed = info.get("pipeline_hash")
    if deployed == local:
        log(f"배포 지문 일치 ({local}, git {info.get('git')})")
    else:
        log(f"배포 지문 불일치 — 서비스 {deployed}(git {info.get('git')}), "
            f"로컬 {local}")
        notify("인쇄 검수 배포 ⚠️",
               "HF Space 의 엔진이 로컬과 다릅니다. "
               "python3 tools/hf_deploy.py 로 재배포하세요.")
    return True


COLLECT_URL = "https://inkspect-feedback.vercel.app/api/feedback"
LOCAL_HEALTHZ = "http://127.0.0.1:8501/healthz"


def check_feedback_health(net_ok: bool) -> None:
    """피드백 수집 경로 건강검진 — "살아 있는데 저장이 안 되는" 상태를 잡는다.

    주경로(브라우저 → Vercel inkspect-feedback)와 폴백(사내망 Flask /feedback)
    을 모두 본다. 프로세스 죽음은 launchd KeepAlive 가 복구하므로, 여기서 잡는
    것은 그 너머다: Vercel 장애, launchd 에이전트 언로드, 디스크/권한 문제.
    """
    import urllib.error
    import urllib.request

    # 1) 주경로: Vercel 수집기 도달성. HTTP 응답이면(405 라도) 살아 있는 것.
    if net_ok:                     # 오프라인이면 오경보만 나므로 건너뛴다
        try:
            req = urllib.request.Request(COLLECT_URL, method="OPTIONS")
            urllib.request.urlopen(req, timeout=15)
            log("피드백 수집기(Vercel) 응답 정상")
        except urllib.error.HTTPError as e:
            if e.code >= 500:
                log(f"피드백 수집기 5xx: {e.code}")
                notify("인쇄 검수 피드백 ⚠️",
                       f"Vercel 수집기가 {e.code}를 반환합니다 — "
                       f"사용자 피드백이 유실될 수 있습니다.")
            else:
                log(f"피드백 수집기(Vercel) 응답 정상 (HTTP {e.code})")
        except Exception as e:
            log(f"피드백 수집기 접속 실패: {e}")
            notify("인쇄 검수 피드백 ⚠️",
                   "Vercel 수집기에 접속할 수 없습니다 — "
                   "사용자 피드백이 유실될 수 있습니다.")

    # 2) 폴백: 로컬 Flask — /healthz 가 feedback/ 실제 쓰기까지 검사한다.
    try:
        with urllib.request.urlopen(LOCAL_HEALTHZ, timeout=10) as resp:
            log(f"로컬 서버 건강 정상 ({resp.read(200).decode('utf-8', 'replace').strip()})")
    except urllib.error.HTTPError as e:
        detail = e.read(200).decode("utf-8", "replace").strip()
        log(f"로컬 서버 비정상: HTTP {e.code} {detail}")
        notify("인쇄 검수 서버 ⚠️",
               f"webapp.py 가 살아 있지만 일을 못 합니다: {detail}")
    except Exception as e:
        log(f"로컬 서버 접속 실패: {e}")
        notify("인쇄 검수 서버 ⚠️",
               "webapp.py(8501) 가 응답하지 않습니다 — "
               "launchctl 로 com.artwork-compare.server 를 확인하세요.")


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    today = datetime.now().strftime("%Y-%m-%d")
    if "--if-stale" in argv:
        last = STAMP.read_text(encoding="utf-8").strip() if STAMP.exists() else ""
        if last == today:
            log("오늘 이미 점검 완주 — 건너뜀 (--if-stale)")
            return 0

    log("── 시작")
    new_cases: list[str] = []

    # 0) 배포 지문 + 피드백 경로 건강검진 (빠르고 독립적이라 먼저)
    net_ok = check_deploy()
    check_feedback_health(net_ok)

    # 1) 보관함에서 새 아트웍
    if PW_FILE.exists():
        before = case_files()
        os.environ.setdefault("ADMIN_PASSWORD",
                              PW_FILE.read_text(encoding="utf-8").strip())
        try:
            from . import import_library
            import_library.main(["--server", "--limit", "50"])
        except SystemExit:
            pass
        except Exception as e:
            log(f"보관함 수입 실패: {e}")
        new_cases = sorted(case_files() - before)
        if new_cases:
            log(f"새 아트웍 케이스 파일 {len(new_cases)}건: {', '.join(new_cases)}")
    else:
        log(f"보관함 비밀번호 파일이 없어 수입은 건너뜀 ({PW_FILE})")

    # 2) 전 케이스 점검 — 이력·기준선은 건드리지 않는다
    from . import run as bench_run
    rc = bench_run.main(["--no-history", "--no-timing"])
    if rc == 0:
        log("게이트 PASS")
        if new_cases:
            notify("인쇄 검수 안전망",
                   f"새 아트웍 {len(new_cases)}건이 케이스가 됐고 게이트는 통과. "
                   f"검토 후 커밋하세요.")
    else:
        log("게이트 FAIL — bench/out/report.md 확인")
        notify("인쇄 검수 안전망 ❌",
               "정확도 게이트가 깨졌습니다. bench/out/report.md 확인")
    # 게이트 결과와 무관하게 "오늘 완주" 도장 — FAIL 도 이미 알림을 띄웠으므로
    # 같은 날 재부팅 때마다 25분짜리 점검을 다시 돌 이유가 없다.
    STAMP.write_text(today + "\n", encoding="utf-8")
    log("── 끝")
    return rc


if __name__ == "__main__":
    sys.exit(main())

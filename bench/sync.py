"""매일 도는 정확도 점검 — launchd(`com.artwork-compare.bench-sync`)가 실행한다.

  1) 공용 보관함에 새로 올라온 아트웍을 감시 케이스로 들여온다
  2) 전 케이스를 python 엔진으로 돌려 계약이 깨졌는지 본다
  3) 새 케이스가 생겼거나 게이트가 깨졌을 때만 알림을 띄운다

저장소를 더럽히지 않는다: 이력은 남기지 않고(`--no-history`), **기준선은 절대
자동 승인하지 않는다** — 자동으로 갱신하면 안전망이 그냥 로그가 된다. 사람이
결과를 보고 `--accept` 해야 한다. 새로 생긴 케이스 JSON만 작업 트리에 남는데,
그건 검토하고 커밋해야 하는 물건이라 그대로 두는 게 맞다.

수동 실행:  python3 -m bench.sync
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


def main(argv=None) -> int:
    log("── 시작")
    new_cases: list[str] = []

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
    log("── 끝")
    return rc


if __name__ == "__main__":
    sys.exit(main())

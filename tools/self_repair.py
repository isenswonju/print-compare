"""게이트 FAIL 시 자가수리 — Claude Code 헤드리스로 패치 **브랜치**를 만든다.

원칙: 수리는 기계가, 승인은 사람이.
  · 격리된 git worktree 에서 작업 — 메인 체크아웃(작업 중일 수 있음)은 안 건드림
  · 산출물은 repair/* 브랜치의 커밋뿐 — push · bench.run --accept · 배포는 안 한다
    (프롬프트 금지 + 헤드리스라 HF 토큰 승인 대화도 못 연다)
  · 자동 실행(bench.sync)은 private/.self-repair-on 파일이 있을 때만 — 옵트인.
    지우면 알림까지만 오고 수리는 수동이 된다.

    python3 tools/self_repair.py            # 지금 수리 시도(마커 불필요)
    python3 tools/self_repair.py --auto     # sync 가 부르는 형태 — 마커 필요
    python3 tools/self_repair.py --smoke    # 배관 검증(워크트리+CLI 왕복만, 수리 없음)

검토: git log repair/<이름>  →  git diff main...repair/<이름>  →  병합은 사람이.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench.sync import log, notify  # noqa: E402 — sync.log 에 같이 남긴다

ROOT = Path(__file__).resolve().parents[1]
MARKER = ROOT / "private" / ".self-repair-on"
LOG_OUT = ROOT / "bench" / "out" / "self-repair.log"
TIMEOUT_S = 3600
# 워크트리는 git 추적 파일만 담는다 — 엔진 실행에 필요한 비추적 자산은 링크.
LINK_DIRS = ["private", "feedback", "web/node_modules"]

REPAIR_PROMPT = """\
너는 인쇄 검수 프로젝트의 자가수리 에이전트다. 정확도 게이트(bench)가 깨져
격리된 worktree 에서 실행됐다. 임무: 원인을 찾아 엔진을 고치고 게이트를
PASS 시킨 뒤 커밋하라. 검토와 병합은 사람이 한다.

절차:
1. python3 -m bench.run --no-history 로 실패를 재현하고 bench/out/report.md 를 읽어라.
2. 원인을 진단하라. 엔진이 틀렸다고 전제하라 — 계약(bench/cases/*.json)·
   기준선(bench/baseline.json)·원장을 고쳐서 통과시키는 것은 금지다.
3. compare_artwork.py 를 고쳐라. 판정 로직을 바꿨다면 web/src/pipeline/ 에
   같은 변경을 미러링하라 — 두 엔진은 같은 계약을 만족해야 한다.
4. python3 -m bench.run --no-history 전체가 PASS 인지 확인하라. 미러링을
   했다면 영향 케이스에 --engine web 도 돌려라.
5. PASS 면 커밋하라(메시지: 원인·수정·검증 요약). 끝까지 원인을 못 고치면
   코드 원복 후 진단 내용만 SELF_REPAIR_NOTES.md 로 커밋하라.

금지: git push, bench.run --accept, 계약·기준선·원장 수정, HF 배포(hf_deploy),
이 worktree 밖 파일 수정. 마지막 출력으로 한 줄 요약을 남겨라.
"""

SMOKE_PROMPT = """\
배관 검증이다. SMOKE.md 파일을 만들어 "자가수리 배관 검증 OK" 한 줄을 쓰고
"chore: self-repair smoke test" 메시지로 커밋하라. 다른 일은 하지 마라.
"""


def find_claude() -> str:
    # launchd 의 PATH 에는 ~/.local/bin 이 없다 — 직접 찾는다.
    found = shutil.which("claude")
    if found:
        return found
    for p in (Path.home() / ".local/bin/claude",
              Path("/opt/homebrew/bin/claude")):
        if p.is_file():
            return str(p)
    raise SystemExit("claude CLI 를 찾을 수 없다")


def sh(cmd: list[str], cwd: Path | None = None, timeout: int = 120) -> str:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} 실패: {proc.stderr.strip()[:300]}")
    return proc.stdout.strip()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--auto", action="store_true",
                    help="sync 자동 호출 — private/.self-repair-on 필요")
    ap.add_argument("--smoke", action="store_true",
                    help="배관 검증만(트리비얼 프롬프트, 5분 제한)")
    args = ap.parse_args(argv)

    if args.auto and not MARKER.exists():
        log("자가수리 꺼짐(private/.self-repair-on 없음) — 건너뜀")
        return 0
    claude = find_claude()

    stamp = time.strftime("%Y%m%d-%H%M")
    branch = f"repair/{stamp}" + ("-smoke" if args.smoke else "")
    base = sh(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    wt = Path(tempfile.mkdtemp(prefix="print-compare-repair-"))
    log(f"자가수리 시작 — 브랜치 {branch}, worktree {wt}")
    sh(["git", "-C", str(ROOT), "worktree", "add", "-b", branch,
        str(wt), base])
    try:
        for rel in LINK_DIRS:
            src = ROOT / rel
            if src.exists():
                dst = wt / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.symlink_to(src)

        prompt = SMOKE_PROMPT if args.smoke else REPAIR_PROMPT
        timeout = 300 if args.smoke else TIMEOUT_S
        LOG_OUT.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [claude, "-p", prompt,
             "--permission-mode", "acceptEdits",
             "--allowedTools", "Bash,Edit,Write,Read,Glob,Grep"],
            cwd=wt, capture_output=True, text=True, timeout=timeout)
        LOG_OUT.write_text(
            f"── {stamp} {branch} (rc={proc.returncode})\n"
            f"{proc.stdout}\n{proc.stderr}\n", encoding="utf-8")

        n_commits = int(sh(["git", "-C", str(wt), "rev-list", "--count",
                            f"{base}..HEAD"]))
    finally:
        # 커밋은 브랜치에 남는다 — worktree 는 어떤 경우든 정리한다.
        subprocess.run(["git", "-C", str(ROOT), "worktree", "remove",
                        "--force", str(wt)], capture_output=True)

    if n_commits > 0:
        notes = "SELF_REPAIR_NOTES.md" in sh(
            ["git", "-C", str(ROOT), "diff", "--name-only",
             f"{base}..{branch}"])
        what = "진단 노트만(수리 실패)" if notes and not args.smoke else "패치"
        log(f"자가수리 종료 — {branch} 에 커밋 {n_commits}건 ({what})")
        notify("인쇄 검수 자가수리",
               f"{what}가 {branch} 브랜치에 준비됐습니다. "
               f"git diff main...{branch} 로 검토 후 병합하세요.")
        return 0
    # 커밋이 없으면 브랜치는 소음이다 — 지운다.
    subprocess.run(["git", "-C", str(ROOT), "branch", "-D", branch],
                   capture_output=True)
    log(f"자가수리 종료 — 커밋 없음(rc={proc.returncode}), "
        f"로그 {LOG_OUT}")
    notify("인쇄 검수 자가수리 ❌",
           f"수리 시도가 결과 없이 끝났습니다 — {LOG_OUT} 확인")
    return 1


if __name__ == "__main__":
    sys.exit(main())

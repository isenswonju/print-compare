"""피드백 처리 상태를 사이트 피드백 페이지와 동기화한다.

프롬프트로 피드백을 반영한 뒤 이 도구로 '확인' 표시를 찍으면, 앱의 피드백
페이지(수집기 /api/admin)에 그대로 반영된다 — 팀 전체가 같은 상태를 본다.
앱에서 손으로 누르는 확인/미확인 토글과 **같은 저장소**를 쓴다.

    python tools/feedback_status.py --list              # 미확인 건만
    python tools/feedback_status.py --list --all        # 전부
    python tools/feedback_status.py --done <id> [<id>…] # 반영 완료로 표시
    python tools/feedback_status.py --undo <id> [<id>…] # 다시 미확인으로

인증은 없다 — 앱의 피드백 페이지와 동일하다.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADMIN_URL = "https://inkspect-feedback.vercel.app/api/admin"


def call(body: dict, timeout: int = 20) -> dict:
    req = urllib.request.Request(
        ADMIN_URL, method="POST",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"수집기 오류 {e.code}: {e.read()[:200].decode(errors='replace')}") from None
    except urllib.error.URLError as e:
        raise SystemExit(f"수집기에 연결할 수 없다: {e.reason}") from None


def summarize(entry: dict) -> str:
    """피드백 1건을 두 줄로. 어떤 건인지, 무엇을 지적했는지 알아볼 만큼만."""
    data = entry.get("data") or {}
    items = data.get("items") or []
    sets, fp, missed, causes, comment = [], 0, 0, {}, ""
    for it in items:
        if it.get("set"):
            sets.append(str(it["set"]))
        fb = it.get("feedback") or {}
        missed += len(fb.get("missed") or [])
        for d in fb.get("defects") or []:
            if d.get("fp"):
                fp += 1
                c = d.get("cause")
                if c:
                    causes[c] = causes.get(c, 0) + 1
            if not comment and d.get("comment"):
                comment = str(d["comment"]).replace("\n", " ").strip()

    when = (entry.get("received") or entry.get("uploadedAt") or "")[:16].replace("T", " ")
    label = ", ".join(sets[:2]) or "(세트 이름 없음)"
    if len(sets) > 2:
        label += f" 외 {len(sets) - 2}"

    marks = []
    if fp:
        top = sorted(causes.items(), key=lambda kv: -kv[1])
        why = f" ({', '.join(k for k, _ in top[:2])})" if top else ""
        marks.append(f"오탐 지목 {fp}건{why}")
    if missed:
        marks.append(f"미검출 지목 {missed}건")
    if not marks:
        marks.append("지목 없음")

    line = f"{when}  {label}  —  {' · '.join(marks)}"
    if comment:
        line += "\n         \u201c" + (comment[:70] + ("\u2026" if len(comment) > 70 else "")) + "\u201d"
    return line


def cmd_list(show_all: bool) -> int:
    data = call({})
    items = data.get("items") or []
    read = set(data.get("read") or [])
    rows = items if show_all else [e for e in items if e.get("id") not in read]
    print(f"전체 {len(items)}건 · 확인 {len(read)}건 · 미확인 {len(items) - len(read)}건")
    if not rows:
        print("\n표시할 건이 없다." if show_all else "\n미확인 피드백이 없다.")
        return 0
    print()
    for e in rows:
        eid = e.get("id", "?")
        mark = "확인" if eid in read else "미확인"
        print(f"  [{mark}] {eid}")
        print(f"         {summarize(e)}")
    print(f"\n반영을 마쳤으면:  python tools/feedback_status.py --done <id> …")
    return 0


def cmd_mark(ids: list[str], read: bool) -> int:
    if not ids:
        raise SystemExit("id 를 하나 이상 넘길 것.")
    res = call({"action": "read", "ids": ids, "read": read})
    now = set(res.get("read") or [])
    word = "반영 완료(확인)" if read else "미확인"
    missed = [i for i in ids if (i in now) != read]
    for i in ids:
        print(f"  {'✅' if (i in now) == read else '⚠️ '} {i} → {word}")
    if missed:
        print(f"\n⚠️  {len(missed)}건이 반영되지 않았다 — id 가 맞는지 --list 로 확인할 것.")
        return 1
    print(f"\n{len(ids)}건을 '{word}' 으로 표시했다. 앱의 피드백 페이지에 바로 보인다.")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--list", action="store_true", help="피드백 목록 보기")
    g.add_argument("--done", nargs="+", metavar="ID", help="반영 완료로 표시")
    g.add_argument("--undo", nargs="+", metavar="ID", help="다시 미확인으로")
    ap.add_argument("--all", action="store_true", help="--list 에서 확인된 건도 함께")
    args = ap.parse_args(argv)

    if args.list:
        return cmd_list(args.all)
    if args.done:
        return cmd_mark(args.done, True)
    return cmd_mark(args.undo, False)


if __name__ == "__main__":
    sys.exit(main())

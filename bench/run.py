"""정확도 안전망 실행기.

    python -m bench.run                      # 전 케이스, python 엔진
    python -m bench.run --engine web         # 사용자가 쓰는 브라우저 엔진(TS)
    python -m bench.run --only pga1e0398     # 케이스 골라서
    python -m bench.run --group guard        # 홀드아웃만(게이트용)
    python -m bench.run --fast               # OCR 끄고 빠르게(커밋마다용)
    python -m bench.run --accept             # 지금 결과를 기준선으로 승인
    python -m bench.run --list               # 케이스 목록

종료 코드 0 = PASS, 1 = 계약 위반(FAIL). 표류(WARN)는 0이다 — 사람이 판정해
라벨로 승격시키는 것이 목적이고, 자동으로 막으면 아무도 안 본다.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path

from . import report as rp
from .cases import Case, MissingImages, load_cases
from .crops import drift_items, save_crops
from .engines import ENGINES, fingerprint, run_engine
from .score import score


def pick(cases: list[Case], only: str | None, group: str) -> list[Case]:
    out = cases
    if group != "all":
        out = [c for c in out if c.group == group]
    if only:
        # 정확한 id, `benign` 같은 접두사, `lib-` 처럼 하이픈으로 끝나는 접두사
        want = {s.strip() for s in only.split(",") if s.strip()}

        def wanted(cid: str) -> set[str]:
            return {w for w in want
                    if cid == w or cid.startswith(w + "-")
                    or (w.endswith("-") and cid.startswith(w))}

        out = [c for c in out if wanted(c.id)]
        missing = want - {w for c in out for w in wanted(c.id)}
        if missing:
            raise SystemExit(f"그런 케이스가 없다: {', '.join(sorted(missing))}")
    return out


def run_case(case: Case, engine: str, fast: bool, keep: Path | None,
             base: dict, fp: dict, timing: bool = True) -> dict:
    row: dict = {"case": case.id, "group": case.group, "kind": case.kind,
                 "status": "SKIP", "reason": "", "elapsed": 0.0,
                 "failures": [], "warnings": [], "score": None, "drift": None,
                 "crops": []}
    try:
        ref, test = case.materialize()
    except MissingImages as e:
        row["reason"] = f"이미지 없음({e}) — 실물 케이스는 private/ 에서 받아와야 한다"
        return row
    except Exception as e:                     # 레시피 오류 등
        row["reason"] = f"케이스 준비 실패: {e}"
        return row

    use_ocr = case.use_ocr and not fast
    try:
        run = run_engine(engine, ref, test, use_ocr=use_ocr,
                         keep=(keep / case.id) if keep else None)
    except Exception as e:
        row["status"] = "FAIL"
        row["failures"] = [f"엔진 실행 실패: {e}"]
        row["elapsed"] = 0.0
        row["score"] = score(case, [], 1)      # 전부 미검출로 기록
        row["score"].failures = row["failures"]
        row["score"].ok = False
        return row

    sc = score(case, run.findings, run.ref_w)
    row["elapsed"] = run.elapsed_s
    row["score"] = sc
    row["findings"] = run.findings
    if not use_ocr:
        sc.warnings.append("OCR 없이 실행됨(--fast) — 텍스트 경로는 검사되지 않았다")

    drift = rp.compare_baseline(sc, engine, run.elapsed_s, fp, base)
    row["drift"] = drift
    if drift:
        if drift.fp_delta > 0:
            sc.failures.append(
                f"오탐이 기준선보다 {drift.fp_delta}건 늘었다 "
                f"(기준선 승인 {drift.baseline_at})")
        elif drift.fp_delta < 0:
            sc.warnings.append(f"오탐 {-drift.fp_delta}건 감소 — 개선이면 "
                               f"--accept 로 기준선을 내려라")
        for label, was, now in drift.margin_drops:
            sc.warnings.append(
                f"마진 감소: {label} {was:.2f}× → {now:.2f}× "
                f"(통과 중이지만 임계값에 가까워졌다)")
        for f in drift.new:
            sc.warnings.append(
                f"기준선에 없던 검출: {f['type']}/{f['severity']} {f['bbox']} "
                f"{f['note']}")
        for f in drift.lost:
            sc.warnings.append(
                f"기준선에 있던 검출이 사라짐: {f['type']}/{f['severity']} "
                f"{f['bbox']} {f['note']}")
        if drift.slowdown and timing:
            sc.warnings.append(f"실행 시간 {drift.slowdown}배")
        if drift.env_changed:
            sc.warnings.append(f"환경/설정 변화: {drift.env_changed}")
    else:
        sc.warnings.append("기준선 없음 — 결과를 확인하고 --accept 로 승인하라")

    # 판정이 필요한 항목은 크롭을 남긴다 — 좌표만 있는 리포트는 결국 엔진을
    # 다시 돌려보게 만든다. 산출물(정합 TEST)은 크롭을 뜬 뒤 정리한다.
    try:
        row["crops"] = save_crops(case.id, ref, test, run.artifacts,
                                  drift_items(sc, drift), rp.OUT_DIR)
    except Exception as e:                     # 크롭 실패가 게이트를 막지는 않는다
        row["crops"] = []
        sc.warnings.append(f"크롭 저장 실패: {e}")
    finally:
        if keep is None and run.artifacts:
            shutil.rmtree(run.artifacts, ignore_errors=True)

    sc.ok = not sc.failures
    row["status"] = "PASS" if sc.ok else "FAIL"
    row["failures"] = sc.failures
    row["warnings"] = sc.warnings
    return row


def console(results: list[dict]) -> None:
    print()
    print(f"{'케이스':<28} {'셋':<6} {'판정':<6} {'검출':>7} {'오탐':>8} "
          f"{'최소마진':>9} {'시간':>7}")
    print("-" * 82)
    for r in results:
        sc = r.get("score")
        if sc is None:   # SKIP 또는 벤치 내부 오류 — 지표가 없다
            print(f"{r['case']:<28} {r['group']:<6} {r['status']:<6} "
                  f"{'-':>7} {'-':>8} {'-':>9} {'-':>7}  "
                  f"{r['reason'] or (r['failures'][0] if r['failures'] else '')}")
            continue
        hits, total = sc.recall
        margins = sc.margins()
        mark = r["status"] if r["status"] == "FAIL" else (
            "WARN" if r["warnings"] else "PASS")
        print(f"{r['case']:<28} {r['group']:<6} {mark:<6} "
              f"{f'{hits}/{total}':>7} {f'{len(sc.fps)}/{sc.fp_budget}':>8} "
              f"{(f'{min(margins.values()):.2f}x' if margins else '-'):>9} "
              f"{r['elapsed']:>6.0f}s")
    print("-" * 82)
    for r in results:
        for msg in r["failures"]:
            print(f"  ❌ [{r['case']}] {msg}")
    for r in results:
        if r["status"] != "FAIL":
            for msg in r["warnings"]:
                print(f"  ⚠️  [{r['case']}] {msg}")


def use_utf8_console() -> None:
    """콘솔 출력 코덱을 UTF-8로 고정한다.

    Windows 기본 콘솔 코덱(cp949)은 리포트에 쓰는 '⚠'·'—' 같은 글자를 못 찍고
    UnicodeEncodeError 로 죽는다 — 실제로는 9개 케이스가 전부 PASS 였는데
    결과를 인쇄하다 죽어 pre-commit 훅이 커밋을 막았다(2026-09-09).
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # 리다이렉트된 스트림 등
            pass


def main(argv=None) -> int:
    use_utf8_console()
    ap = argparse.ArgumentParser(
        description="정확도 회귀 안전망 — 계약(FAIL) + 표류(WARN) 2층 게이트")
    ap.add_argument("--engine", default="python", choices=ENGINES)
    ap.add_argument("--only", help="케이스 id(쉼표 구분). 접두사도 됨(benign)")
    ap.add_argument("--group", default="all", choices=["all", "guard", "tune"])
    ap.add_argument("--fast", action="store_true", help="OCR 끄고 빠르게")
    ap.add_argument("--accept", action="store_true",
                    help="현재 결과를 기준선으로 승인(사람 판단 후에만)")
    ap.add_argument("--force", action="store_true",
                    help="--accept 할 때 FAIL 케이스까지 승인")
    ap.add_argument("--keep", type=Path, help="엔진 산출물을 남길 디렉터리")
    ap.add_argument("--json", type=Path, help="결과를 JSON으로도 저장")
    ap.add_argument("--no-timing", action="store_true",
                    help="실행 시간 경고를 끈다 — 예약 실행(launchd)은 우선순위가 "
                         "달라 늘 1.6배쯤 느려서, 켜두면 경고가 신호를 덮는다")
    ap.add_argument("--no-history", action="store_true",
                    help="이력(history.jsonl)에 남기지 않는다 — 커밋 훅처럼 "
                         "같은 코드를 반복 실행하는 자리에서 쓴다")
    ap.add_argument("--list", action="store_true", help="케이스 목록만 출력")
    args = ap.parse_args(argv)

    # OCR 이 있어야 하는데 없으면 조용히 빠진 채로 채점된다 — 그러면 텍스트
    # 경로에 걸린 라벨(예: REV 행 critical)이 근거 없이 깨진다. 실측: launchd 는
    # PATH 가 최소라 tesseract 를 못 찾아 매일 FAIL 이 났다.
    if args.engine == "python" and not args.fast and not shutil.which("tesseract"):
        raise SystemExit(
            "tesseract 가 PATH 에 없다 — OCR 경로가 통째로 빠진 채 채점된다.\n"
            "  설치: brew install tesseract   /   끄고 돌리려면: --fast")

    cases = pick(load_cases(), args.only, args.group)
    if args.list:
        for c in cases:
            labels = len(c.active_must_find())
            print(f"{c.id:<28} {c.kind:<9} {c.group:<6} "
                  f"라벨 {labels:>2} 포기 {len(c.waived):>2} "
                  f"예산 {c.fp_budget:>2}  {c.note or c.origin}")
        print(f"\n총 {len(cases)}건")
        return 0
    if not cases:
        print("돌릴 케이스가 없다.")
        return 0

    fp = fingerprint(args.engine)
    base = rp.load_baseline()
    print(f"엔진 {args.engine} · 커밋 {fp['commit']}"
          f"{' (수정중)' if fp['dirty'] else ''} · 설정해시 {fp['config_hash']}"
          f" · 케이스 {len(cases)}건" + (" · OCR 끔" if args.fast else ""))

    results: list[dict] = []
    total_elapsed = 0.0
    for i, case in enumerate(cases, 1):
        print(f"[{i}/{len(cases)}] {case.id} … ", end="", flush=True)
        try:
            row = run_case(case, args.engine, args.fast, args.keep, base, fp,
                           timing=not args.no_timing)
        except KeyboardInterrupt:
            print("\n중단됨 — 여기까지의 결과만 리포트한다.")
            break
        except Exception:
            traceback.print_exc()
            row = {"case": case.id, "group": case.group, "kind": case.kind,
                   "status": "FAIL", "reason": "", "elapsed": 0.0,
                   "failures": ["벤치 내부 오류(위 트레이스백)"], "warnings": [],
                   "score": None, "drift": None}
        results.append(row)
        total_elapsed += row["elapsed"]
        print(row["status"] if row["status"] != "PASS" or not row["warnings"]
              else "PASS(경고)")

    console(results)
    text = rp.render(results, fp, total_elapsed)
    path = rp.write_report(text)
    rows = ([] if args.no_history else
            [rp.history_row(r["score"], args.engine, r["elapsed"], fp, r["group"])
             for r in results if r.get("score")])
    rp.append_history(rows)
    print(f"\n리포트: {path.relative_to(rp.BENCH.parent)}" +
          (" · 이력 남기지 않음(--no-history)" if args.no_history else
           f" · 이력 {len(rows)}행 → {rp.HISTORY_PATH.relative_to(rp.BENCH.parent)}"))

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(
            [{k: v for k, v in r.items()
              if k in ("case", "group", "kind", "status", "reason", "elapsed",
                       "failures", "warnings")}
             | ({"recall": list(r["score"].recall),
                 "fp": len(r["score"].fps),
                 "margins": r["score"].margins()} if r.get("score") else {})
             for r in results], ensure_ascii=False, indent=2), encoding="utf-8")

    if args.accept:
        accepted, refused = [], []
        for r in results:
            if not r.get("score"):
                continue
            if r["status"] == "FAIL" and not args.force:
                refused.append(r["case"])
                continue
            base.setdefault("records", {})[rp.key_of(args.engine, r["case"])] = \
                rp.record_of(r["score"], args.engine, r["elapsed"], fp)
            accepted.append(r["case"])
        rp.save_baseline(base)
        print(f"기준선 승인 {len(accepted)}건 → "
              f"{rp.BASELINE_PATH.relative_to(rp.BENCH.parent)}")
        if refused:
            print(f"승인 거부(FAIL) {len(refused)}건: {', '.join(refused)}"
                  f" — 정말 승인하려면 --accept --force (원장에 이유를 남겨라)")

    fails = [r for r in results if r["status"] == "FAIL"]
    print(("❌ FAIL " + str(len(fails)) + "건") if fails else "✅ PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

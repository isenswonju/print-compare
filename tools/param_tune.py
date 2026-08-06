"""파라미터 자가튜닝 제안기 — 계약 전체를 목적함수로 스윕하고 **제안서만** 쓴다.

새 labeled 케이스가 쌓였을 때(매일 sync 알림) 돌린다. 후보 값마다 전 케이스를
python 엔진으로 실행·채점해 현재 설정과 비교하고, 결과를
bench/out/tuning-proposal.md 에 남긴다. **아무것도 자동 적용하지 않는다** —
적용은 사람이 Config(compare_artwork.py)와 web/src/pipeline/config.ts 를
같이 고치고 `python3 -m bench.run --accept` 로 승인해야 한다.

과적합 방지: 후보 비교(목적함수)는 tune 그룹으로만 하고, guard 그룹(홀드아웃)
결과는 검증용으로 병기한다. guard 를 보고 값을 고르기 시작하면 홀드아웃이
아니게 된다.

    python3 tools/param_tune.py                          # 기본 스윕(튜닝 이력 있는 4개)
    python3 tools/param_tune.py --sweep min_area=30,40,50
    python3 tools/param_tune.py --fast                   # OCR 끔(빠른 예비 스윕)
    python3 tools/param_tune.py --only back1             # 케이스 골라서

한 번에 한 파라미터만 움직인다(one-at-a-time) — 조합 폭발도, "왜 좋아졌는지
모르는 승자"도 피한다.
"""
from __future__ import annotations

import argparse
import sys
import time
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bench.cases import Case, MissingImages, load_cases  # noqa: E402
from bench.engines import run_engine  # noqa: E402
from bench.run import pick  # noqa: E402
from bench.score import CaseScore, score  # noqa: E402
from compare_artwork import Config  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "bench" / "out" / "tuning-proposal.md"

# 기본 스윕 — 실측 튜닝 이력이 있는 손잡이만. 값 근거는 Config 주석 참고.
DEFAULT_SWEEP = {
    "min_area": [30, 40, 50, 60],
    "extra_max_norm": [180, 190, 200],
    "missing_max_ref": [180, 190, 200],
    "fade_rel": [0.65, 0.70, 0.75],
}


def parse_sweeps(specs: list[str]) -> dict[str, list]:
    valid = asdict(Config())
    out: dict[str, list] = {}
    for spec in specs:
        name, _, vals = spec.partition("=")
        if name not in valid:
            raise SystemExit(f"Config 에 없는 파라미터: {name}")
        cast = type(valid[name])
        if cast not in (int, float):
            raise SystemExit(f"{name} 은 {cast.__name__} 라 스윕할 수 없다")
        out[name] = [cast(float(v)) for v in vals.split(",") if v.strip()]
    return out


def run_config(cases: list[Case], mats: dict[str, tuple[Path, Path]],
               overrides: dict, fast: bool, tag: str) -> dict[str, CaseScore]:
    scores: dict[str, CaseScore] = {}
    for i, case in enumerate(cases, 1):
        ref, test = mats[case.id]
        print(f"  [{tag}] {i}/{len(cases)} {case.id} …", end="", flush=True)
        t0 = time.time()
        try:
            run = run_engine("python", ref, test,
                             use_ocr=case.use_ocr and not fast,
                             config_overrides=overrides)
            sc = score(case, run.findings, run.ref_w)
        except Exception as e:  # noqa: BLE001 — 후보 값이 엔진을 죽여도 스윕은 계속
            sc = score(case, [], 1)
            sc.ok = False
            sc.failures.append(f"엔진 실행 실패: {e}")
        scores[case.id] = sc
        print(f" {'FAIL' if sc.failures else 'ok'} ({time.time() - t0:.0f}s)")
    return scores


def summarize(scores: dict[str, CaseScore], cases: list[Case],
              group: str) -> dict:
    ids = [c.id for c in cases if c.group == group]
    subset = [scores[i] for i in ids if i in scores]
    margins = [m for sc in subset for m in sc.margins().values()]
    return {
        "fail_cases": sum(1 for sc in subset if sc.failures),
        "missed": sum(len(sc.missed) for sc in subset),
        "fps": sum(len(sc.fps) for sc in subset),
        "min_margin": min(margins) if margins else None,
    }


def fmt(s: dict) -> str:
    mm = f"{s['min_margin']:.2f}×" if s["min_margin"] is not None else "-"
    return f"{s['fail_cases']} · {s['missed']} · {s['fps']} · {mm}"


def dominates(cand: dict, cur: dict) -> bool:
    """tune 셋에서 현재 설정보다 못한 데가 없고 나은 데가 있는가."""
    if cand["fail_cases"] > cur["fail_cases"] or cand["missed"] > cur["missed"] \
            or cand["fps"] > cur["fps"]:
        return False
    cm, km = cur["min_margin"], cand["min_margin"]
    if cm is not None and km is not None and km < cm - 1e-9:
        return False
    return (cand["fail_cases"], cand["missed"], cand["fps"]) \
        < (cur["fail_cases"], cur["missed"], cur["fps"]) \
        or (cm is not None and km is not None and km > cm + 1e-9)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--sweep", action="append", default=[],
                    metavar="NAME=V1,V2", help="스윕할 파라미터(반복 가능)")
    ap.add_argument("--fast", action="store_true", help="OCR 끔 — 예비 스윕용")
    ap.add_argument("--only", help="케이스 id/접두사 필터(bench.run 과 동일)")
    args = ap.parse_args(argv)

    sweeps = parse_sweeps(args.sweep) if args.sweep else DEFAULT_SWEEP
    current = asdict(Config())

    cases = pick(load_cases(), args.only, "all")
    mats: dict[str, tuple[Path, Path]] = {}
    skipped = []
    for c in cases:
        try:
            mats[c.id] = c.materialize()
        except MissingImages:
            skipped.append(c.id)
    cases = [c for c in cases if c.id in mats]
    if skipped:
        print(f"이미지 없어 제외: {', '.join(skipped)}")
    if not cases:
        raise SystemExit("돌릴 케이스가 없다")

    n_runs = 1 + sum(len([v for v in vs if v != current[k]])
                     for k, vs in sweeps.items())
    print(f"케이스 {len(cases)}건 × 설정 {n_runs}개"
          f"{' (OCR 끔)' if args.fast else ''} — 시작")

    base_scores = run_config(cases, mats, {}, args.fast, "현재")
    base_tune = summarize(base_scores, cases, "tune")
    base_guard = summarize(base_scores, cases, "guard")

    lines = [
        "# 파라미터 튜닝 제안서", "",
        f"생성: {time.strftime('%Y-%m-%d %H:%M')} · 케이스 {len(cases)}건"
        f"{' · OCR 끔(--fast) — 최종 판단 전 OCR 켜고 재확인' if args.fast else ''}",
        "",
        "목적함수는 **tune 그룹**, guard(홀드아웃)는 검증 병기. 표 값:",
        "FAIL 케이스 | 미검출 | 오탐 | 최소마진.", "",
        "**이 파일은 제안일 뿐이다.** 적용하려면 compare_artwork.py 의 Config 와",
        "web/src/pipeline/config.ts 를 **함께** 고치고, `python3 -m bench.run` 전체",
        "게이트 → `--accept` → `python3 tools/hf_deploy.py` 순서로 마무리할 것.", "",
    ]
    proposals = []
    for name, values in sweeps.items():
        lines += [f"## {name} (현재 {current[name]})", "",
                  "| 값 | tune: FAIL·미검출·오탐·최소마진 "
                  "| guard(홀드아웃) | 판정 |",
                  "|---|---|---|---|",
                  f"| **{current[name]} (현재)** | {fmt(base_tune)} "
                  f"| {fmt(base_guard)} | 기준 |"]
        for v in values:
            if v == current[name]:
                continue
            scores = run_config(cases, mats, {name: v}, args.fast, f"{name}={v}")
            t, g = summarize(scores, cases, "tune"), summarize(scores, cases, "guard")
            better = dominates(t, base_tune)
            guard_bad = g["fail_cases"] > base_guard["fail_cases"] \
                or g["fps"] > base_guard["fps"]
            verdict = ("**제안** ✅" if better and not guard_bad
                       else "tune 개선·guard 악화 ⚠️" if better
                       else "이득 없음")
            if better and not guard_bad:
                proposals.append(f"{name}: {current[name]} → {v}")
            lines.append(f"| {v} | {fmt(t)} | {fmt(g)} | {verdict} |")
        lines.append("")

    lines += ["## 요약", ""]
    lines += [f"- {p}" for p in proposals] if proposals else \
             ["- 현재 설정을 이기는 후보 없음 — 지금 값이 이 계약 셋의 국소 최적."]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n제안서: {OUT}")
    for p in proposals:
        print(f"  제안: {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

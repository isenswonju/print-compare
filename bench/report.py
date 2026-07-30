"""기준선(baseline)·표류(drift)·이력(history)·리포트.

* `bench/baseline.json` — **사람이 승인한** 기준선(커밋 대상). `--accept` 로만
  갱신된다. 자동 갱신하면 안전망은 그냥 로그가 되므로 절대 자동화하지 않는다.
* `bench/history.jsonl` — 케이스 × 커밋 시계열(커밋 대상). "언제부터 나빠졌나"를
  되짚고 회귀를 커밋에 붙일 수 있다.
* `bench/out/report.md` — 사람이 1분 안에 판정할 수 있는 실행 리포트(생성물).

표류(2층)는 FAIL 이 아니라 WARN 이다. 사람이 판정한 뒤 케이스 JSON 의
must_find / forbid 로 승격하는 것이 이 루프의 목적이다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .score import CaseScore

BENCH = Path(__file__).parent
BASELINE_PATH = BENCH / "baseline.json"
HISTORY_PATH = BENCH / "history.jsonl"
OUT_DIR = BENCH / "out"

MARGIN_DROP_WARN = 0.20     # 마진 20% 이상 감소 → 경고
SLOWDOWN_WARN = 1.30        # 런타임 1.3배 초과 → 경고
IOU_SAME = 0.30             # 이 이상 겹치면 같은 검출로 본다


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------------------
# 기준선
# ---------------------------------------------------------------------------

def load_baseline() -> dict:
    if not BASELINE_PATH.exists():
        return {"version": 1, "records": {}}
    return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))


def key_of(engine: str, case_id: str) -> str:
    return f"{engine}/{case_id}"


def record_of(sc: CaseScore, engine: str, elapsed: float, fp: dict) -> dict:
    hits, total = sc.recall
    return {
        "accepted_at": now_iso(),
        "fingerprint": fp,
        "recall": [hits, total],
        "fp_count": len(sc.fps),
        "defects_total": sc.defects_total,
        "findings_total": sc.findings_total,
        "margins": {k: round(v, 3) for k, v in sc.margins().items()},
        "unlabeled": sc.unlabeled(),
        "elapsed_s": round(elapsed, 1),
    }


def save_baseline(base: dict) -> None:
    BASELINE_PATH.write_text(
        json.dumps(base, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8")


# ---------------------------------------------------------------------------
# 표류 판정 (2층)
# ---------------------------------------------------------------------------

@dataclass
class Drift:
    new: list[dict]                  # 기준선에 없던 검출
    lost: list[dict]                 # 기준선에 있었는데 사라진 검출
    margin_drops: list[tuple[str, float, float]]
    fp_delta: int
    slowdown: float | None
    env_changed: dict
    baseline_at: str | None

    @property
    def empty(self) -> bool:
        return not (self.new or self.lost or self.margin_drops
                    or self.fp_delta or self.slowdown)


def compare_baseline(sc: CaseScore, engine: str, elapsed: float, fp: dict,
                     base: dict) -> Drift | None:
    rec = base.get("records", {}).get(key_of(engine, sc.case_id))
    if not rec:
        return None
    prev = rec.get("unlabeled", [])
    cur = sc.unlabeled()
    used: set[int] = set()
    new = []
    for c in cur:
        hit = None
        for i, p in enumerate(prev):
            if i in used:
                continue
            if iou(c["bbox"], p["bbox"]) >= IOU_SAME:
                hit = i
                break
        if hit is None:
            new.append(c)
        else:
            used.add(hit)
    lost = [p for i, p in enumerate(prev) if i not in used]

    drops = []
    for label, m in sc.margins().items():
        was = rec.get("margins", {}).get(label)
        if was and m < was * (1 - MARGIN_DROP_WARN):
            drops.append((label, float(was), float(m)))

    prev_elapsed = rec.get("elapsed_s") or 0
    slow = (round(elapsed / prev_elapsed, 2)
            if prev_elapsed and elapsed > prev_elapsed * SLOWDOWN_WARN else None)

    env = {}
    pfp = rec.get("fingerprint", {})
    for k in ("config_hash", "commit"):
        if pfp.get(k) != fp.get(k):
            env[k] = f"{pfp.get(k)} → {fp.get(k)}"
    if pfp.get("versions") != fp.get("versions"):
        env["versions"] = f"{pfp.get('versions')} → {fp.get('versions')}"

    return Drift(new=new, lost=lost, margin_drops=drops,
                 fp_delta=len(cur) - int(rec.get("fp_count", 0)),
                 slowdown=slow, env_changed=env,
                 baseline_at=rec.get("accepted_at"))


# ---------------------------------------------------------------------------
# 이력
# ---------------------------------------------------------------------------

def append_history(rows: list[dict]) -> None:
    if not rows:
        return
    with open(HISTORY_PATH, "a", encoding="utf-8") as fp:
        for r in rows:
            fp.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")


def history_row(sc: CaseScore, engine: str, elapsed: float, fp: dict,
                group: str) -> dict:
    hits, total = sc.recall
    return {"at": now_iso(), "engine": engine, "case": sc.case_id,
            "group": group, "ok": sc.ok, "hits": hits, "labels": total,
            "fp": len(sc.fps), "defects": sc.defects_total,
            "margins": {k: round(v, 3) for k, v in sc.margins().items()},
            "elapsed_s": round(elapsed, 1),
            "commit": fp.get("commit"), "dirty": fp.get("dirty"),
            "config_hash": fp.get("config_hash")}


# ---------------------------------------------------------------------------
# 리포트
# ---------------------------------------------------------------------------

def _fmt_margins(margins: dict[str, float]) -> str:
    if not margins:
        return "-"
    lo = min(margins.values())
    return f"최소 {lo:.2f}× ({len(margins)}개)"


def render(results: list[dict], fp: dict, elapsed_total: float) -> str:
    """실행 리포트(markdown). results 항목: case/score/drift/status/elapsed."""
    lines: list[str] = []
    fails = [r for r in results if r["status"] == "FAIL"]
    warns = [r for r in results if r["status"] == "PASS" and r["warnings"]]
    skips = [r for r in results if r["status"] == "SKIP"]
    verdict = "❌ FAIL" if fails else "✅ PASS"

    lines += [f"# 정확도 안전망 리포트 — {verdict}", "",
              f"- 시각: {now_iso()}",
              f"- 엔진: `{fp['engine']}` · 커밋 `{fp['commit']}`"
              f"{' (수정중)' if fp.get('dirty') else ''}"
              f" · 설정해시 `{fp['config_hash']}`",
              f"- 버전: {fp.get('versions')}",
              f"- 케이스 {len(results)}건 중 실패 {len(fails)} · 경고 {len(warns)}"
              f" · 건너뜀 {len(skips)} · 총 {elapsed_total / 60:.1f}분", ""]

    lines += ["| 케이스 | 셋 | 판정 | 검출 | 오탐 | 마진 | 시간 |",
              "|---|---|---|---|---|---|---|"]
    for r in results:
        sc: CaseScore | None = r.get("score")
        if sc is None:   # SKIP 또는 벤치 내부 오류
            mark = "⏭ SKIP" if r["status"] == "SKIP" else f"❌ {r['status']}"
            lines.append(f"| `{r['case']}` | {r['group']} | {mark} | - | - | - | - |")
            continue
        hits, total = sc.recall
        mark = {"FAIL": "❌", "PASS": "✅"}[r["status"]]
        if r["status"] == "PASS" and r["warnings"]:
            mark = "⚠️"
        lines.append(
            f"| `{r['case']}` | {r['group']} | {mark} {r['status']} | "
            f"{hits}/{total} | {len(sc.fps)}/{sc.fp_budget} | "
            f"{_fmt_margins(sc.margins())} | {r['elapsed']:.0f}s |")
    lines.append("")

    if fails:
        lines += ["## ❌ 계약 위반 (머지 불가)", ""]
        for r in fails:
            lines.append(f"### `{r['case']}`")
            for msg in r["failures"]:
                lines.append(f"- {msg}")
            lines.append("")

    if warns:
        lines += ["## ⚠️ 표류 — 사람이 판정해서 라벨로 승격할 것", ""]
        for r in warns:
            lines.append(f"### `{r['case']}`")
            for msg in r["warnings"]:
                lines.append(f"- {msg}")
            lines.append("")

    if skips:
        lines += ["## ⏭ 건너뜀", ""]
        for r in skips:
            lines.append(f"- `{r['case']}`: {r['reason']}")
        lines.append("")

    waived_any = [r for r in results if r.get("score") and
                  (r["score"].waived_found or r["score"].waived_missed)]
    if waived_any:
        lines += ["## 📒 포기 원장(waived) 현황", "",
                  "게이트에서 제외된 라벨이다. 되살아났다면 원장에서 지우고 "
                  "계약으로 올려라.", ""]
        for r in waived_any:
            sc = r["score"]
            if sc.waived_found:
                lines.append(f"- `{r['case']}` 되살아남: {', '.join(sc.waived_found)}")
            if sc.waived_missed:
                lines.append(f"- `{r['case']}` 여전히 포기: {', '.join(sc.waived_missed)}")
        lines.append("")

    return "\n".join(lines) + "\n"


def write_report(text: str) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / "report.md"
    path.write_text(text, encoding="utf-8")
    return path


__all__ = ["load_baseline", "save_baseline", "record_of", "key_of",
           "compare_baseline", "append_history", "history_row", "render",
           "write_report", "Drift", "iou", "now_iso", "BASELINE_PATH",
           "HISTORY_PATH", "OUT_DIR"]

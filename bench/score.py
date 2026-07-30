"""채점 — 계약(1층) 판정과 마진 계산.

판정 규칙(README "정확도 안전망" §게이트와 동일)
  FAIL  · must_find 누락
        · critical 라벨인데 심각도가 critical이 아님
        · forbid(사용자 확인 오탐) 영역에서 결함 부활
        · 오탐이 fp_budget 초과
  WARN  · 원장에 포기로 적힌 라벨이 다시 검출됨(원장 정리 필요)
        · 마진 감소 / 라벨 없는 영역의 표류 → report.py 에서 baseline과 대조

마진(margin)은 "임계값을 얼마나 여유롭게 넘겼나"다. 1.0이면 임계값에 딱 걸친
상태고, 값이 작아지면 아직 통과 중이어도 다음 변경에서 떨어질 후보다.
엔진이 findings 의 `metrics.margin` 으로 실어 보낸다(없으면 None).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .cases import DEFECT_TYPES_EXCLUDED, Case, MustFind


def is_defect(f: dict) -> bool:
    """사람에게 결함으로 표시되는 항목인가(기대 차이·리플로우 제외)."""
    return (f.get("severity") != "expected"
            and f.get("type") not in DEFECT_TYPES_EXCLUDED)


def overlaps(bbox, region) -> bool:
    x, y, w, h = bbox
    x0, y0, x1, y1 = region
    return x < x1 and x + w > x0 and y < y1 and y + h > y0


def margin_of(f: dict) -> float | None:
    m = (f.get("metrics") or {}).get("margin")
    return float(m) if isinstance(m, (int, float)) else None


def brief(f: dict) -> dict:
    return {"id": f.get("id"), "type": f.get("type"),
            "severity": f.get("severity"), "bbox": list(f.get("bbox_ref", [])),
            "area_px": f.get("area_px"), "margin": margin_of(f),
            "note": (f.get("note") or "")[:60]}


@dataclass
class Hit:
    label: str
    finding: dict
    margin: float | None
    severity_ok: bool


@dataclass
class CaseScore:
    case_id: str
    ok: bool = True
    hits: list[Hit] = field(default_factory=list)
    missed: list[str] = field(default_factory=list)
    waived_found: list[str] = field(default_factory=list)
    waived_missed: list[str] = field(default_factory=list)
    forbid_hits: list[tuple[str, dict]] = field(default_factory=list)
    fps: list[dict] = field(default_factory=list)
    fp_budget: int = 0
    findings_total: int = 0
    defects_total: int = 0
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def recall(self) -> tuple[int, int]:
        return len(self.hits), len(self.hits) + len(self.missed)

    def margins(self) -> dict[str, float]:
        return {h.label: h.margin for h in self.hits if h.margin is not None}

    def unlabeled(self) -> list[dict]:
        """라벨과 무관한 검출 = 2층 표류 감시 대상."""
        return self.fps


def _match(label: MustFind, defects: list[dict], ref_w: int) -> list[dict]:
    region = label.region(ref_w)
    return [f for f in defects
            if (label.types is None or f.get("type") in label.types)
            and overlaps(f.get("bbox_ref", (0, 0, 0, 0)), region)]


def score(case: Case, findings: list[dict], ref_w: int) -> CaseScore:
    sc = CaseScore(case_id=case.id, fp_budget=case.fp_budget)
    sc.findings_total = len(findings)
    defects = [f for f in findings if is_defect(f)]
    sc.defects_total = len(defects)
    waived = case.waived_ids
    claimed: set[int] = set()

    for label in case.must_find:
        cands = _match(label, defects, ref_w)
        for f in cands:
            claimed.add(id(f))
        if label.id in waived:
            (sc.waived_found if cands else sc.waived_missed).append(label.id)
            if cands:
                sc.warnings.append(
                    f"포기로 기록된 라벨 '{label.id}'이 다시 검출됨 — "
                    f"원장(waived)에서 지우고 계약으로 올려라")
            continue
        if not cands:
            sc.missed.append(label.id)
            sc.failures.append(
                f"must_find 누락: {label.id}" + (f" ({label.note})" if label.note else ""))
            continue
        # 가장 마진이 큰(=가장 확실한) 검출을 대표로 삼는다.
        best = max(cands, key=lambda f: (margin_of(f) or 0.0, f.get("area_px") or 0))
        sev_ok = (not label.critical
                  or any(f.get("severity") == "critical" for f in cands))
        sc.hits.append(Hit(label.id, best, margin_of(best), sev_ok))
        if not sev_ok:
            sc.failures.append(
                f"'{label.id}'는 critical이어야 하는데 "
                f"{best.get('severity')}로 분류됨")

    for zone in case.forbid:
        region = zone.region(ref_w)
        for f in defects:
            if overlaps(f.get("bbox_ref", (0, 0, 0, 0)), region):
                sc.forbid_hits.append((zone.id, brief(f)))
                sc.failures.append(
                    f"오탐 확인 영역 '{zone.id}'에서 결함 부활: "
                    f"{f.get('type')} {list(f.get('bbox_ref', []))}"
                    + (f" — {zone.note}" if zone.note else ""))

    sc.fps = [brief(f) for f in defects if id(f) not in claimed]
    if len(sc.fps) > case.fp_budget:
        sc.failures.append(
            f"오탐 {len(sc.fps)}건 > 예산 {case.fp_budget}건")

    sc.ok = not sc.failures
    return sc


__all__ = ["score", "CaseScore", "Hit", "is_defect", "overlaps", "margin_of",
           "brief"]

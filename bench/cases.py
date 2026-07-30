"""케이스 정의·적재·합성.

케이스는 두 갈래다.

* **실물(labeled)** — 사용자가 올린 REF/TEST 쌍 + 사람이 확인한 라벨.
  이미지는 의료기기 라벨 데이터라 저장소에 넣지 않는다(`private/bench-cases/`).
  라벨 JSON만 `bench/cases/`에 커밋하고, 이미지가 없는 환경에서는 SKIP으로
  표시해 게이트에서 제외한다 — 새 클론에서 벤치가 못 도는 일이 없도록.
* **합성(identity / benign / injected)** — 커밋된 픽스처에서 결정론적으로
  만든다. 라벨링 비용이 0이고 어디서든 같은 이미지가 재현된다.
    - identity : REF를 자기 자신과 비교 → 결함 0건이어야 한다.
    - benign   : 결함 없이 "인쇄물처럼" 열화시킨 TEST → 결함 0건이어야 한다
                 (오탐 팽창을 라벨 없이 잡는 공짜 감시망).
    - injected : 알려진 결함을 심는다(`tools/recall_stress.py` 주입기 재사용)
                 → 심은 자리를 must_find 라벨로 자동 생성.

이미지 캐시는 `bench/work/<케이스>/`에 두고 레시피 해시가 같으면 재사용한다.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from tools.recall_stress import KINDS as INJECT_KINDS
from tools.recall_stress import degrade, inject

ROOT = Path(__file__).resolve().parents[1]
CASE_DIR = Path(__file__).parent / "cases"
WORK_DIR = Path(__file__).parent / "work"
REF_BASE_WIDTH = 5564

# 라벨 좌표 허용 오차(px, REF 폭 5564 기준). 사용자가 화면에서 찍은 좌표와
# 엔진 bbox는 수십 px 어긋나는 게 정상이라 관대하게 잡는다.
DEFAULT_TOL = 80

DEFECT_TYPES_EXCLUDED = ("trim_mark_expected", "layout_reflow")


class MissingImages(Exception):
    """실물 케이스 이미지가 로컬에 없다(SKIP 처리)."""


@dataclass
class MustFind:
    """반드시 검출돼야 하는 영역. bbox 또는 point(사용자 클릭 좌표) 중 하나."""
    id: str
    bbox: tuple[int, int, int, int] | None = None
    point: tuple[int, int] | None = None
    types: frozenset[str] | None = None   # None = 결함이면 유형 무관
    tol: int = DEFAULT_TOL
    critical: bool = False
    note: str = ""

    def region(self, ref_w: int) -> tuple[int, int, int, int]:
        """허용 오차까지 넓힌 (x0, y0, x1, y1)."""
        tol = max(round(self.tol * ref_w / REF_BASE_WIDTH), 8)
        if self.bbox:
            x, y, w, h = self.bbox
        else:
            x, y, w, h = (*self.point, 0, 0)  # type: ignore[misc]
        return (x - tol, y - tol, x + w + tol, y + h + tol)


@dataclass
class Forbid:
    """사용자가 오탐이라고 확인한 영역 — 여기서 결함이 뜨면 FAIL."""
    id: str
    bbox: tuple[int, int, int, int]
    note: str = ""

    def region(self, ref_w: int) -> tuple[int, int, int, int]:
        x, y, w, h = self.bbox
        return (x, y, x + w, y + h)


@dataclass
class Case:
    id: str
    kind: str                      # labeled | identity | benign | injected
    group: str = "guard"           # guard(홀드아웃) | tune(튜닝에 공개)
    must_find: list[MustFind] = field(default_factory=list)
    forbid: list[Forbid] = field(default_factory=list)
    fp_budget: int = 0
    waived: list[dict] = field(default_factory=list)
    source: dict = field(default_factory=dict)
    use_ocr: bool = True
    note: str = ""
    origin: str = ""               # 이 케이스가 온 곳(파일 경로/피드백 id)

    # ---- 라벨 조회 -------------------------------------------------------
    @property
    def waived_ids(self) -> set[str]:
        return {str(w.get("label")) for w in self.waived}

    def active_must_find(self) -> list[MustFind]:
        """원장에 기록된 포기 라벨(waived)을 뺀 나머지 — 실제 게이트 대상."""
        return [m for m in self.must_find if m.id not in self.waived_ids]

    # ---- 이미지 준비 -----------------------------------------------------
    def materialize(self) -> tuple[Path, Path]:
        """REF/TEST 이미지 경로를 준비해 돌려준다(필요하면 합성·캐시)."""
        if self.kind == "labeled":
            ref, test = (ROOT / self.source["ref"], ROOT / self.source["test"])
            if not ref.exists() or not test.exists():
                raise MissingImages(f"{ref.name} / {test.name}")
            return ref, test
        return _synthesize(self)


# ---------------------------------------------------------------------------
# 합성 케이스
# ---------------------------------------------------------------------------

def _recipe_hash(case: Case) -> str:
    payload = json.dumps({"kind": case.kind, "source": case.source},
                         sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


def benign_variants() -> dict[str, callable]:
    """결함이 아닌 열화 레시피 — 전부 "결함 0건"이 정답이다.

    실제 스캔에서 벌어지는 일만 담는다: 스캐너 스큐·평행이동, 인쇄 질감 저하
    (블러+노이즈), 전체적으로 옅은 인쇄, JPEG 저장 손실.
    """
    def shift_rotate(img: np.ndarray) -> np.ndarray:
        h, w = img.shape
        m = cv2.getRotationMatrix2D((w / 2, h / 2), 0.25, 1.0)
        m[0, 2] += 3
        m[1, 2] -= 2
        return cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_CONSTANT, borderValue=255)

    def blur_noise(img: np.ndarray) -> np.ndarray:
        return degrade(img, seed=11)

    def tone_down(img: np.ndarray) -> np.ndarray:
        # 전체적으로 옅게(잉크 절약 인쇄) — 상대 판정이라 통과해야 한다.
        return (img.astype(np.float32) * 0.72 + 62).clip(0, 255).astype(np.uint8)

    def jpeg(img: np.ndarray) -> np.ndarray:
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
        if not ok:
            raise RuntimeError("jpeg 인코딩 실패")
        return cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)

    def combo(img: np.ndarray) -> np.ndarray:
        return blur_noise(shift_rotate(img))

    return {"shift_rotate": shift_rotate, "blur_noise": blur_noise,
            "tone_down": tone_down, "jpeg": jpeg, "combo": combo}


@lru_cache(maxsize=4)
def _read_gray(rel: str) -> np.ndarray:
    """기준 이미지 읽기 — 케이스 30건이 같은 픽스처를 쓰므로 캐시한다."""
    path = ROOT / rel
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE) if path.exists() else None
    if img is None:
        raise MissingImages(rel)
    return img


@lru_cache(maxsize=4)
def _degraded(rel: str) -> np.ndarray:
    return degrade(_read_gray(rel))


def _base_image(case: Case) -> tuple[np.ndarray, Path]:
    rel = case.source.get("base", "tests/fixtures/PGA1E0398_REF.png")
    return _read_gray(rel), ROOT / rel


def _canvas(case: Case) -> np.ndarray:
    """injected 케이스의 바탕 — clean 은 REF 그대로, degraded 는 열화판."""
    rel = case.source.get("base", "tests/fixtures/PGA1E0398_REF.png")
    return (_read_gray(rel) if case.source.get("tier", "clean") == "clean"
            else _degraded(rel))


def _synthesize(case: Case) -> tuple[Path, Path]:
    out = WORK_DIR / f"{case.id}-{_recipe_hash(case)}"
    ref_path, test_path = out / "ref.png", out / "test.png"
    if ref_path.exists() and test_path.exists():
        return ref_path, test_path        # 레시피 동일 — 캐시 재사용

    base, _ = _base_image(case)
    out.mkdir(parents=True, exist_ok=True)
    ref = base
    if case.kind == "identity":
        test = base.copy()
    elif case.kind == "benign":
        recipe = case.source["recipe"]
        test = benign_variants()[recipe](base)
    elif case.kind == "injected":
        test, _bbox, _desc = inject(_canvas(case), case.source["defect"], base)
    else:
        raise ValueError(f"알 수 없는 케이스 종류: {case.kind}")

    # 원자적 저장 — 중간에 끊겨도 반쪽 캐시를 재사용하지 않도록 임시명 후 rename
    for path, img in ((ref_path, ref), (test_path, test)):
        tmp = path.with_suffix(".tmp.png")
        if not cv2.imwrite(str(tmp), img):
            raise RuntimeError(f"이미지 저장 실패: {tmp}")
        tmp.replace(path)
    return ref_path, test_path


def injected_label(case: Case) -> MustFind:
    """injected 케이스의 must_find 라벨을 주입기에서 그대로 얻는다."""
    base, _ = _base_image(case)
    _img, bbox, desc = inject(_canvas(case), case.source["defect"], base)
    return MustFind(id=case.source["defect"], bbox=tuple(bbox), tol=90, note=desc)


# ---------------------------------------------------------------------------
# 적재
# ---------------------------------------------------------------------------

def _mk_must_find(d: dict) -> MustFind:
    types = d.get("types")
    return MustFind(
        id=str(d.get("id") or d.get("label") or "?"),
        bbox=tuple(d["bbox"]) if d.get("bbox") else None,
        point=tuple(d["point"]) if d.get("point") else None,
        types=frozenset(types) if types else None,
        tol=int(d.get("tol", DEFAULT_TOL)),
        critical=bool(d.get("critical", False)),
        note=d.get("note", ""))


def case_from_dict(d: dict, origin: str = "") -> Case:
    case = Case(
        id=d["id"], kind=d["kind"], group=d.get("group", "guard"),
        must_find=[_mk_must_find(m) for m in d.get("must_find", [])],
        forbid=[Forbid(id=str(f.get("id", "?")), bbox=tuple(f["bbox"]),
                       note=f.get("note", "")) for f in d.get("forbid", [])],
        fp_budget=int(d.get("fp_budget", 0)),
        waived=list(d.get("waived", [])),
        source=d.get("source", {}),
        use_ocr=bool(d.get("use_ocr", True)),
        note=d.get("note", ""), origin=origin)
    if case.kind == "injected" and not case.must_find:
        case.must_find = [injected_label(case)]
    return case


def expand(d: dict, origin: str) -> list[Case]:
    """`expand` 항목이 있으면 한 정의에서 여러 케이스를 펼친다.

    예) {"id": "benign", "kind": "benign", "expand": {"recipe": [...]}} →
        benign-shift_rotate, benign-blur_noise, ...

    펼쳐진 케이스 하나만 다르게 두려면(예: 구조적 한계로 포기한 결함 종류에
    원장을 달 때) `overrides: {"<케이스 id>": {...}}` 로 덮어쓴다.
    """
    spec = d.get("expand")
    if not spec:
        return [case_from_dict(d, origin)]
    keys = list(spec)
    overrides = d.get("overrides", {})
    unused = set(overrides)
    cases: list[Case] = []

    def walk(i: int, chosen: dict):
        if i == len(keys):
            sub = json.loads(json.dumps(d))
            sub.pop("expand")
            sub.pop("overrides", None)
            sub["source"] = {**sub.get("source", {}), **chosen}
            sub["id"] = "-".join([d["id"], *(str(v) for v in chosen.values())])
            sub.update(overrides.get(sub["id"], {}))
            unused.discard(sub["id"])
            cases.append(case_from_dict(sub, origin))
            return
        for value in spec[keys[i]]:
            walk(i + 1, {**chosen, keys[i]: value})

    walk(0, {})
    if unused:
        # 오타로 원장이 조용히 사라지는 것을 막는다(포기 기록이 없어지면
        # 게이트가 FAIL 로 바뀌므로 눈에는 띄지만, 이유는 사라진다).
        raise ValueError(f"overrides 에 없는 케이스 id: {', '.join(sorted(unused))}")
    return cases


def load_cases(paths: list[Path] | None = None) -> list[Case]:
    files = sorted(paths or CASE_DIR.glob("*.json"))
    cases: list[Case] = []
    seen: set[str] = set()
    for f in files:
        data = json.loads(f.read_text(encoding="utf-8"))
        for d in (data if isinstance(data, list) else [data]):
            for case in expand(d, str(f.relative_to(ROOT))):
                if case.id in seen:
                    raise ValueError(f"케이스 id 중복: {case.id} ({f.name})")
                seen.add(case.id)
                cases.append(case)
    return cases


__all__ = ["Case", "MustFind", "Forbid", "MissingImages", "load_cases",
           "case_from_dict", "benign_variants", "INJECT_KINDS",
           "DEFECT_TYPES_EXCLUDED", "ROOT", "CASE_DIR", "WORK_DIR"]

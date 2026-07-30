"""사용자 피드백 → 회귀 케이스 자동 변환.

피드백 1건에는 안전망이 필요한 모든 재료가 이미 들어 있다
(`web/src/lib.ts` buildFeedbackPayload):

  · 원본 REF/TEST 이미지 전체        → 케이스 이미지
  · 엔진이 낸 findings              → 오탐 예산 실측값
  · 사용자 판정 `defects[].fp`      → true면 **forbid**(다시 뜨면 FAIL)
                                      false면 **must_find**(정탐 — 계속 잡아야 함)
  · 사용자가 찍은 `missed[]` 좌표    → **must_find**(점 라벨)

즉 피드백을 붙여넣기만 하면 계약이 한 건 늘어난다. 이 스크립트가 그 변환이다.

    python -m bench.import_feedback                      # feedback/feedback.jsonl
    python -m bench.import_feedback --file 붙여넣은.json   # 수집기에서 받은 JSON
    python -m bench.import_feedback --dry-run            # 무엇이 생기는지만 본다

이미지는 의료기기 라벨 데이터이므로 `private/bench-cases/`(git 제외)에 두고,
라벨 JSON만 `bench/cases/`(커밋)에 쓴다. 이미지가 없는 환경에서는 해당 케이스가
SKIP 될 뿐 벤치는 계속 돈다.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

from .cases import ROOT

CASE_DIR = Path(__file__).parent / "cases"
IMAGE_DIR = ROOT / "private" / "bench-cases"
FEEDBACK_DIR = ROOT / "feedback"
DEFAULT_JSONL = FEEDBACK_DIR / "feedback.jsonl"

# 사용자 유형 표기(ktype) → 엔진 유형. 라벨에 유형을 박아두면 "다른 이유로
# 우연히 잡힌 검출"이 계약을 만족시키는 것을 막는다. 애매하면 비운다(유형 무관).
KTYPE_TO_TYPES = {
    "잉크 스팟": ["extra"],
    "잉여 잉크": ["extra"],
    "누락": ["missing"],
    "잉크 누락": ["missing"],
    "옅은 인쇄": ["faded"],
    "인쇄 농도": ["faded"],
    "뒷비침": ["showthrough"],
    "문구 불일치": ["text_mismatch"],
}


def slug(text: str) -> str:
    s = re.sub(r"[^0-9A-Za-z가-힣]+", "-", (text or "").strip()).strip("-")
    return (s[:24] or "무제").lower()


def load_records(jsonl: Path | None, file: Path | None) -> list[dict]:
    """수집 서버 jsonl 이든 붙여넣은 JSON 이든 같은 모양으로 펴서 돌려준다."""
    out: list[dict] = []
    if file:
        data = json.loads(file.read_text(encoding="utf-8"))
        out += data if isinstance(data, list) else [data]
    if jsonl and jsonl.exists():
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def items_of(rec: dict) -> list[dict]:
    """레코드 한 건에서 세트 목록을 꺼낸다(수집기 포맷/원본 payload 모두 지원)."""
    data = rec.get("data", rec)
    if data.get("kind") == "error":
        return []                      # 분석 실패 보고는 케이스가 될 수 없다
    return [it for it in data.get("items", []) if it.get("feedback")]


def image_bytes(item: dict, key: str) -> bytes | None:
    """refImage(data URL) 또는 refImageFile(수집 서버가 분리 저장한 파일)."""
    url = item.get(key)
    if url and isinstance(url, str) and "," in url:
        try:
            return base64.b64decode(url.split(",", 1)[1])
        except Exception:
            return None
    rel = item.get(key + "File")
    if rel:
        path = FEEDBACK_DIR / rel
        if path.exists():
            return path.read_bytes()
    return None


def bbox_of(d: dict) -> list[int] | None:
    b = d.get("bbox")
    if isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) for v in b):
        return [int(v) for v in b]
    return None


def types_of(d: dict) -> list[str] | None:
    if d.get("type"):
        return [str(d["type"])]
    for k, v in KTYPE_TO_TYPES.items():
        if k in str(d.get("ktype") or ""):
            return v
    return None


def build_case(item: dict, case_id: str, ref_rel: str, test_rel: str,
               group: str) -> dict:
    fb = item.get("feedback") or {}
    must, forbid = [], []
    for i, d in enumerate(fb.get("defects") or [], 1):
        bbox = bbox_of(d)
        if not bbox:
            continue
        note = " / ".join(x for x in (d.get("cause"), d.get("comment")) if x)
        if d.get("fp"):
            forbid.append({"id": f"fp{i}", "bbox": bbox,
                           "note": f"사용자 확인 오탐: {note or '이유 미기재'}"})
        else:
            entry = {"id": f"d{i}", "bbox": bbox,
                     "note": f"사용자 확인 정탐: {note or d.get('ktype') or ''}"}
            t = types_of(d)
            if t:
                entry["types"] = t
            must.append(entry)
    for i, m in enumerate(fb.get("missed") or [], 1):
        if m.get("x") is None or m.get("y") is None:
            continue
        note = " / ".join(x for x in (m.get("cause"), m.get("comment")) if x)
        must.append({"id": f"m{i}", "point": [int(m["x"]), int(m["y"])],
                     "note": f"사용자 지적 미검출: {note or '이유 미기재'}"})

    # 오탐 예산은 "가져온 시점의 실측 오탐 수" — 라벨과 무관한 결함 개수다.
    # 확인되지 않은 검출을 계약으로 굳히지 않기 위한 값이며, 사용자가 오탐으로
    # 지목하면 forbid 로 옮기고 예산을 낮춘다.
    defects = [f for f in (item.get("findings") or [])
               if f.get("severity") != "expected"
               and f.get("type") not in ("trim_mark_expected", "layout_reflow")]
    labeled_ids = {f.get("id") for f in defects
                   if any(bbox_of(d) and f.get("bbox_ref")
                          and _overlap(f["bbox_ref"], bbox_of(d))
                          for d in (fb.get("defects") or []))}
    budget = max(len(defects) - len(labeled_ids), 0)

    return {
        "id": case_id, "kind": "labeled", "group": group,
        "source": {"ref": ref_rel, "test": test_rel},
        "fp_budget": budget,
        "must_find": must, "forbid": forbid, "waived": [],
        "note": f"피드백에서 자동 생성 — 세트 '{item.get('set') or '이름 없음'}'. "
                f"예산 {budget}은 가져온 시점 실측값이니, 오탐을 확인하면 "
                f"forbid 로 옮기고 낮춰라",
    }


def _overlap(a, b) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def merge_into(existing: dict, fresh: dict) -> tuple[dict, int]:
    """이미 있는 케이스에 새 라벨만 더한다(계약·원장을 지운 채 덮어쓰지 않는다)."""
    added = 0
    for field in ("must_find", "forbid"):
        have = existing.setdefault(field, [])
        for label in fresh.get(field, []):
            same = any(
                (label.get("bbox") and l.get("bbox")
                 and _overlap(label["bbox"], l["bbox"]))
                or (label.get("point") and l.get("point")
                    and abs(label["point"][0] - l["point"][0]) < 40
                    and abs(label["point"][1] - l["point"][1]) < 40)
                for l in have)
            if same:
                continue
            ids = {l.get("id") for l in have}
            new_id = label["id"]
            while new_id in ids:
                new_id += "b"
            have.append({**label, "id": new_id})
            added += 1
    return existing, added


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="피드백 → 회귀 케이스 변환")
    ap.add_argument("--source", type=Path, default=DEFAULT_JSONL,
                    help=f"수집 서버 jsonl (기본 {DEFAULT_JSONL.name})")
    ap.add_argument("--file", type=Path, help="수집기에서 받은/붙여넣은 JSON")
    ap.add_argument("--group", default="guard", choices=["guard", "tune"],
                    help="새 케이스의 셋(기본 guard — 튜닝에 쓰지 않는 홀드아웃)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    records = load_records(args.source, args.file)
    if not records:
        print(f"피드백이 없다: {args.source} (또는 --file 로 지정)")
        return 0

    made, merged, skipped = 0, 0, 0
    for rec in records:
        for item in items_of(rec):
            ref_b = image_bytes(item, "refImage")
            test_b = image_bytes(item, "testImage")
            if not ref_b or not test_b:
                print(f"⏭  이미지 없는 피드백 건너뜀 — 세트 "
                      f"'{item.get('set') or '이름 없음'}' "
                      f"(사용자가 원본 전송에 동의하지 않은 건)")
                skipped += 1
                continue
            digest = hashlib.sha256(ref_b + test_b).hexdigest()[:8]
            case_id = f"fb-{digest}-{slug(item.get('set'))}"
            img_dir = IMAGE_DIR / case_id
            ref_rel = f"private/bench-cases/{case_id}/REF.png"
            test_rel = f"private/bench-cases/{case_id}/TEST.png"
            fresh = build_case(item, case_id, ref_rel, test_rel, args.group)
            n_labels = len(fresh["must_find"]) + len(fresh["forbid"])
            if not n_labels:
                print(f"⏭  라벨이 없는 피드백 건너뜀 — {case_id}")
                skipped += 1
                continue

            path = CASE_DIR / f"{case_id}.json"
            if path.exists():
                old = json.loads(path.read_text(encoding="utf-8"))
                out, added = merge_into(old, fresh)
                verb, extra = ("병합", f"새 라벨 {added}건")
                merged += 1
            else:
                out, extra = fresh, f"라벨 {n_labels}건 · 예산 {fresh['fp_budget']}"
                verb = "생성"
                made += 1
            print(f"{'(예정) ' if args.dry_run else ''}{verb} {case_id} — {extra}")
            if args.dry_run:
                continue
            img_dir.mkdir(parents=True, exist_ok=True)
            (img_dir / "REF.png").write_bytes(ref_b)
            (img_dir / "TEST.png").write_bytes(test_b)
            path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")

    print(f"\n생성 {made} · 병합 {merged} · 건너뜀 {skipped}")
    if made or merged:
        print("다음: python -m bench.run --only <케이스> 로 확인하고, 결과가 "
              "맞으면 --accept 로 기준선을 잡아라")
    return 0


if __name__ == "__main__":
    sys.exit(main())

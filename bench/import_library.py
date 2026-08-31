"""사용자가 올린 아트웍 → 오탐 감시 케이스(라벨 비용 0).

우리가 손으로 고른 픽스처 하나로는 현장에서 쓰이는 아트웍의 성질을 다 담을 수
없다. 사용자가 실제로 올린 원본이 들어오는 대로 자동으로 케이스가 되게 한다.

원본 하나에서 케이스 두 개가 나온다. 둘 다 **정답이 "결함 0건"이라 라벨이
필요 없다** — 사람 손을 전혀 타지 않고 오탐 감시망이 넓어진다.
  · identity : 자기 자신과 비교
  · benign   : 결함 아닌 열화(스캔 스큐+질감)를 먹인 사본과 비교

들여올 때 아트웍 성질을 재서(`bench/artwork.py`) 케이스 note 에 남긴다 —
회색 톤 비율, 큰 솔리드 잉크 영역 유무. 나중에 "이 원본은 뭐가 달라서 결과가
다른가"를 다시 조사하지 않기 위해서다.

    python -m bench.import_library --dir ~/원본모음
    python -m bench.import_library --server            # 공용 서버 보관함
    python -m bench.import_library --server --dry-run  # 무엇이 생기는지만

이미지는 `private/bench-cases/`(git 제외)에, 케이스 JSON만 커밋한다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from .artwork import profile, profile_note
from .cases import ROOT
from .import_feedback import slug

CASE_DIR = Path(__file__).parent / "cases"
IMAGE_DIR = ROOT / "private" / "bench-cases"
LIBRARY_URL = "https://inkspect-feedback.vercel.app/api/library"
SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf"}
DEFAULT_RECIPES = ["combo"]


# ---------------------------------------------------------------------------
# 원본 모으기
# ---------------------------------------------------------------------------

def from_dir(path: Path, limit: int) -> list[tuple[str, bytes]]:
    files = sorted(p for p in path.rglob("*")
                   if p.suffix.lower() in SUFFIXES and p.is_file())
    return [(p.name, p.read_bytes()) for p in files[:limit]]


def _post(url: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def from_server(url: str, limit: int) -> list[tuple[str, bytes]]:
    """공용 보관함의 파일 목록 → 내용 주소(해시)로 내려받는다.

    매니페스트에 파일명이 있으면 그걸 쓰고, 없으면 해시를 이름으로 쓴다.
    (프로토콜은 web/src/server-library.ts 와 동일하다 — 비밀번호 없음.)
    """
    listing = _post(url, {"action": "listfiles"})
    files = listing.get("files", [])
    names: dict[str, str] = {}
    if listing.get("manifestUrl"):
        try:
            with urllib.request.urlopen(listing["manifestUrl"], timeout=60) as r:
                manifest = json.loads(r.read().decode())
            for a in manifest.get("artworks", []):
                if a.get("hash"):
                    names[a["hash"]] = a.get("name") or a["hash"]
        except Exception as e:                       # 매니페스트가 없어도 진행
            print(f"(매니페스트를 읽지 못했다 — 파일명 대신 해시를 쓴다: {e})")
    out: list[tuple[str, bytes]] = []
    for f in files[:limit]:
        try:
            with urllib.request.urlopen(f["url"], timeout=300) as r:
                out.append((names.get(f.get("hash", ""), f.get("hash", "artwork")),
                            r.read()))
        except Exception as e:
            print(f"⏭  내려받기 실패({f.get('hash')}): {e}")
    return out


# ---------------------------------------------------------------------------
# 케이스 만들기
# ---------------------------------------------------------------------------

MIN_SIDE = 400          # 이보다 작은 그림은 아트웍이 아니다(개발용 더미 등)


def corpus_hashes() -> dict[str, str]:
    """이미 케이스가 쓰고 있는 이미지들의 내용 해시 → 케이스 id.

    보관함에는 우리 픽스처와 같은 파일이 올라와 있을 수 있다. 같은 그림으로
    케이스를 하나 더 만들면 실행 시간만 두 배가 된다.
    """
    out: dict[str, str] = {}
    for f in sorted(CASE_DIR.glob("*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        for case in (data if isinstance(data, list) else [data]):
            for key in ("base", "ref", "test"):
                rel = case.get("source", {}).get(key)
                if not rel:
                    continue
                path = ROOT / rel
                if path.exists():
                    out.setdefault(
                        hashlib.sha256(path.read_bytes()).hexdigest(), case["id"])
    return out


def looks_like_artwork(raw: bytes, name: str) -> bool:
    """개발용 더미나 깨진 파일을 케이스로 만들지 않는다.

    바이트 수가 아니라 **디코딩한 크기**로 판단한다 — 흰 바탕 라벨은 압축이 잘
    돼 파일이 작을 수 있다. 실측: 보관함에 69바이트짜리 더미('hashProd1')가
    올라와 있었다.
    """
    if name.lower().endswith(".pdf"):
        return len(raw) > 1000
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return False
    return min(img.shape[:2]) >= MIN_SIDE


def to_png(name: str, raw: bytes, dest: Path) -> bool:
    """PDF·JPG 등 무엇이 오든 벤치가 읽을 수 있는 PNG 한 장으로 만든다."""
    from compare_artwork import imread_gray
    tmp = dest.parent / ("_원본" + Path(name).suffix.lower())
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_bytes(raw)
    try:
        img = imread_gray(tmp)                       # PDF는 600dpi 래스터화
    except Exception as e:
        print(f"⏭  읽지 못함({name}): {e}")
        return False
    finally:
        tmp.unlink(missing_ok=True)
    return bool(cv2.imwrite(str(dest), img))


def build_cases(case_id: str, base_rel: str, group: str, recipes: list[str],
                note: str) -> list[dict]:
    common = {"group": group, "fp_budget": 0, "source": {"base": base_rel}}
    cases = [{"id": f"{case_id}-identity", "kind": "identity", **common,
              "note": f"사용자 업로드 아트웍 자기비교 — 결함 0건이 정답. {note}"}]
    for r in recipes:
        cases.append({"id": f"{case_id}-{r}", "kind": "benign",
                      **{**common, "source": {"base": base_rel, "recipe": r}},
                      "note": f"사용자 업로드 아트웍 열화({r}) — 결함 0건이 정답. {note}"})
    return cases


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="사용자 업로드 아트웍 → 오탐 감시 케이스")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dir", type=Path, help="원본이 있는 로컬 폴더")
    src.add_argument("--server", action="store_true", help="공용 서버 보관함에서")
    ap.add_argument("--url", default=LIBRARY_URL)
    ap.add_argument("--limit", type=int, default=10, help="최대 원본 수(기본 10)")
    ap.add_argument("--recipes", default=",".join(DEFAULT_RECIPES),
                    help="benign 레시피(쉼표). 원본당 케이스 수가 늘어난다")
    ap.add_argument("--group", default="guard", choices=["guard", "tune"])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if args.server:
        try:
            items = from_server(args.url, args.limit)
        except Exception as e:
            print(f"보관함에 접근하지 못했다: {e}")
            return 2
    else:
        if not args.dir.is_dir():
            print(f"폴더가 아니다: {args.dir}")
            return 2
        items = from_dir(args.dir, args.limit)

    if not items:
        print("가져올 원본이 없다. (공용 보관함이 비어 있다 — 앱에서 원본을 "
              "하나라도 넣으면 자동으로 서버에 올라간다)")
        return 0

    recipes = [r.strip() for r in args.recipes.split(",") if r.strip()]
    known = corpus_hashes()
    seen: set[str] = set()
    made = skipped = flagged = 0
    for name, raw in items:
        full = hashlib.sha256(raw).hexdigest()
        if not looks_like_artwork(raw, name):
            print(f"⏭  아트웍이 아닌 파일 건너뜀: {name} ({len(raw)}바이트 — "
                  f"개발용 더미로 보인다)")
            skipped += 1
            continue
        if full in seen:
            print(f"⏭  같은 내용 중복: {name}")
            skipped += 1
            continue
        seen.add(full)
        if full in known:
            print(f"⏭  이미 케이스가 쓰는 그림: {name} → {known[full]}")
            skipped += 1
            continue
        digest = full[:8]
        case_id = f"lib-{digest}-{slug(Path(name).stem)}"
        path = CASE_DIR / f"{case_id}.json"
        img_rel = f"private/bench-cases/{case_id}/BASE.png"
        img_path = IMAGE_DIR / case_id / "BASE.png"

        if path.exists():
            print(f"⏭  이미 있는 원본: {case_id}")
            skipped += 1
            continue
        if args.dry_run:
            print(f"(예정) {case_id} — {name} ({len(raw) / 1e6:.1f}MB) "
                  f"케이스 {1 + len(recipes)}건")
            made += 1
            continue
        if not to_png(name, raw, img_path):
            skipped += 1
            continue

        prof = profile(img_path)
        note = profile_note(prof)
        if prof["solid_px"]:
            flagged += 1
        cases = build_cases(case_id, img_rel, args.group, recipes, note)
        path.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        print(f"생성 {case_id} — 케이스 {len(cases)}건 · {note}")
        made += 1

    print(f"\n원본 {made}건 · 건너뜀 {skipped}건" +
          (f" · 큰 솔리드 잉크 영역이 있는 원본 {flagged}건" if flagged else ""))
    if made and not args.dry_run:
        print("다음: python -m bench.run --only lib- 로 확인하고 --accept 로 기준선을 잡아라")
    return 0


if __name__ == "__main__":
    sys.exit(main())

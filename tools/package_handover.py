"""인수인계용 압축본을 만든다 — 받는 쪽은 풀고 설치.bat 만 누르면 된다.

    python3 tools/package_handover.py                 # ~/Desktop 에 생성
    python3 tools/package_handover.py -o /경로/폴더
    python3 tools/package_handover.py --no-private    # 실물 라벨 이미지 제외

다시 만들어지는 것(node_modules·빌드 산출물·작업 캐시)은 빼고, 되돌리기에
필요한 이력(.git)은 넣는다. 바탕화면의 계정 시트가 있으면 압축 루트에 함께 넣는다.
"""
from __future__ import annotations

import argparse
import sys
import unicodedata
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 통째로 제외할 디렉터리 (프로젝트 루트 기준)
SKIP_DIRS = {
    "web/node_modules", "node_modules", "web/dist", "dist",
    "bench/work", "bench/out", "web/coverage", "coverage",
    ".pytest_cache", "webjobs", "라벨 AI 테스트",
    "backend/node_modules", "backend/.vercel", "inkspect-feedback",
}
# 이름만 보고 제외
SKIP_NAMES = {".DS_Store"}
SKIP_SUFFIX = {".pyc", ".log"}
# 절대 넣지 않는 파일 — 비밀번호가 들어가는 곳
NEVER = {"private/인수인계-계정.md", "private/.library-password"}
ACCOUNT_SHEET = ROOT.parent / "인수인계-계정.txt"


def skipped(rel: str) -> bool:
    # macOS 는 파일명을 NFD 로 돌려준다 — 한글 폴더 이름이 안 걸리므로 맞춰 준다
    rel = unicodedata.normalize("NFC", rel)
    if rel in NEVER:
        return True
    parts = rel.split("/")
    if parts[-1] in SKIP_NAMES or Path(rel).suffix in SKIP_SUFFIX:
        return True
    if "__pycache__" in parts:
        return True
    for d in SKIP_DIRS:
        if rel == d or rel.startswith(d + "/"):
            return True
    return False


def collect(include_private: bool) -> list[Path]:
    out = []
    for p in ROOT.rglob("*"):
        if not p.is_file() or p.is_symlink():
            continue
        rel = unicodedata.normalize("NFC", p.relative_to(ROOT).as_posix())
        if skipped(rel):
            continue
        if not include_private and (rel == "private" or rel.startswith("private/")):
            continue
        out.append(p)
    return sorted(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", type=Path, default=Path.home() / "Desktop",
                    help="압축본을 만들 폴더 (기본: 바탕화면)")
    ap.add_argument("--no-private", action="store_true",
                    help="private/ (실물 라벨 이미지·감시 케이스) 제외")
    args = ap.parse_args(argv)

    include_private = not args.no_private
    files = collect(include_private)
    if not files:
        raise SystemExit("넣을 파일이 없다 — 실행 위치를 확인할 것.")

    args.out.mkdir(parents=True, exist_ok=True)
    dest = args.out / f"인쇄검수-인수인계-{date.today():%Y%m%d}.zip"

    raw = sum(f.stat().st_size for f in files)
    print(f"· 파일 {len(files):,}개 · 원본 {raw / 1e6:,.0f}MB")
    print(f"· 압축 중 → {dest}")

    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for i, f in enumerate(files, 1):
            z.write(f, f.relative_to(ROOT).as_posix())
            if i % 2000 == 0:
                print(f"   … {i:,}/{len(files):,}")
        if ACCOUNT_SHEET.exists():
            z.write(ACCOUNT_SHEET, "인수인계-계정.txt")

    size = dest.stat().st_size
    print(f"\n✅ 완료 — {dest.name}  ({size / 1e6:,.0f}MB)")

    print("\n받는 쪽 안내:")
    print("  1) 경로에 한글·띄어쓰기 없는 폴더에 압축을 푼다 (예: C:\\print-compare)")
    print("  2) 설치.bat 더블클릭 → 브라우저 로그인 창만 승인")
    print("  3) 결과가 전부 [완료]이면 이후에는 시작.bat만 더블클릭")

    if ACCOUNT_SHEET.exists():
        print("\n계정 시트도 압축본 안에 넣었다.")
    else:
        print("\n⚠️  바탕화면의 인수인계-계정.txt를 찾지 못해 계정 시트는 빠졌다.")
    if include_private:
        print("\n⚠️  이 압축본에는 실물 라벨 이미지(의료기기 데이터)가 들어 있다.")
        print("    사내 전달 경로로만 보내고, 열린 공유 폴더에 두지 말 것.")
    else:
        print("\n참고: private/ 를 뺐다 — 실물 라벨 감시 케이스는 SKIP 되고")
        print("      나머지 정확도 검사는 그대로 돈다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

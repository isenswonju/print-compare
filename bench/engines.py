"""엔진 어댑터 — 같은 케이스를 어느 엔진으로도 돌릴 수 있게 감싼다.

* `python` — `compare_artwork.run_pipeline` (기준 구현. 빠르고 디버깅 쉽다)
* `web`    — `web/tools/harness.cjs` 를 통해 **사용자가 실제로 쓰는**
             브라우저 엔진(TS)을 Node에서 돌린다.

두 엔진의 결과가 갈리는 것 자체도 신호이므로(README §회귀 테스트) 게이트는
양쪽 다 돌릴 수 있어야 한다.

지문(fingerprint)은 baseline 과 함께 저장한다 — 차이가 코드 탓인지 환경 탓인지
구분하지 못하면 표류 리포트를 신뢰할 수 없다.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import re
import struct
import subprocess
import tempfile
import time
from contextlib import redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path

from .cases import ROOT

ENGINES = ("python", "web")


@dataclass
class EngineRun:
    findings: list[dict]
    ref_w: int
    ref_h: int
    elapsed_s: float
    log: str = ""
    artifacts: Path | None = None
    extra: dict = field(default_factory=dict)


def png_size(path: Path) -> tuple[int, int]:
    """PNG IHDR 에서 가로·세로만 읽는다(20MB 디코딩 회피)."""
    with open(path, "rb") as fp:
        head = fp.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        import cv2
        img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise RuntimeError(f"이미지를 읽을 수 없다: {path}")
        return img.shape[1], img.shape[0]
    w, h = struct.unpack(">II", head[16:24])
    return int(w), int(h)


# ---------------------------------------------------------------------------
# 지문
# ---------------------------------------------------------------------------

def _sh(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True,
                              timeout=20).stdout.strip()
    except Exception:
        return ""


def git_state() -> dict:
    commit = _sh(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"])
    dirty = bool(_sh(["git", "-C", str(ROOT), "status", "--porcelain",
                      "--untracked-files=no"]))
    return {"commit": commit or "unknown", "dirty": dirty}


def config_hash(engine: str) -> str:
    """엔진 설정값의 해시 — 임계값이 바뀌면 값이 바뀐다."""
    if engine == "python":
        from dataclasses import asdict

        from compare_artwork import Config
        payload = json.dumps(asdict(Config()), sort_keys=True, default=str)
    else:
        payload = (ROOT / "web/src/pipeline/config.ts").read_text(encoding="utf-8")
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


def pipeline_hash() -> str:
    """web 엔진 소스(web/src/pipeline/) 지문 — 배포본 대조용.

    vite 의 version-stamp 플러그인(web/vite.config.js)이 빌드 때 같은 계산으로
    dist/version.json 에 박아 두고, bench.sync 와 tools/hf_deploy.py 가 이 값과
    대조한다. 테스트 파일은 배포 엔진에 안 실리므로 제외 — 규칙을 바꾸면
    반드시 양쪽을 함께 바꿀 것.
    """
    src = ROOT / "web" / "src" / "pipeline"
    rels = sorted(p.relative_to(src).as_posix() for p in src.rglob("*")
                  if p.is_file() and not p.name.endswith(".test.ts")
                  and not p.name.startswith("__fixtures__"))
    h = hashlib.sha256()
    for rel in rels:
        h.update(rel.encode() + b"\0")
        h.update((src / rel).read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:12]


def fingerprint(engine: str) -> dict:
    fp = {"engine": engine, "config_hash": config_hash(engine), **git_state(),
          "os": f"{platform.system()} {platform.machine()}"}
    if engine == "python":
        import cv2
        import numpy
        tv = re.search(r"tesseract\s+v?([\d.]+)", _sh(["tesseract", "--version"]))
        fp["versions"] = {
            "python": platform.python_version(),
            "opencv": cv2.__version__, "numpy": numpy.__version__,
            "tesseract": tv.group(1) if tv else "없음",
        }
    else:
        pkg = json.loads((ROOT / "web/package.json").read_text(encoding="utf-8"))
        deps = pkg.get("dependencies", {})
        fp["versions"] = {
            "node": _sh(["node", "-v"]),
            "opencv-js": deps.get("@techstark/opencv-js", "?"),
            "tesseract.js": deps.get("tesseract.js", "?"),
        }
    return fp


# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------

def _run_python(ref: Path, test: Path, use_ocr: bool,
                keep: Path | None, overrides: dict | None = None) -> EngineRun:
    from compare_artwork import Config, run_pipeline

    outdir = keep or Path(tempfile.mkdtemp(prefix="bench-py-"))
    buf = io.StringIO()
    t0 = time.time()
    with redirect_stdout(buf):
        findings = run_pipeline(ref, test, outdir,
                                Config(use_ocr=use_ocr, **(overrides or {})))
    elapsed = time.time() - t0
    w, h = png_size(ref)
    return EngineRun([f.to_dict() for f in findings], w, h, elapsed,
                     log=buf.getvalue(), artifacts=outdir)


def _run_web(ref: Path, test: Path, use_ocr: bool,
             keep: Path | None) -> EngineRun:
    outdir = keep or Path(tempfile.mkdtemp(prefix="bench-web-"))
    outdir.mkdir(parents=True, exist_ok=True)
    out_json = outdir / "findings.json"
    cmd = ["node", "tools/harness.cjs", str(ref.resolve()), str(test.resolve()),
           "--json", str(out_json.resolve())]
    if not use_ocr:
        cmd.append("--no-ocr")
    # tesseract.js 는 langPath 에서 `eng.traineddata.gz`(압축본)를 찾는다 —
    # web/eng.traineddata(비압축)를 가리키면 ENOENT 로 죽는다. 자체 호스팅 경로를
    # 쓰면 CDN 없이도 돈다.
    env = {**os.environ,
           "NODE_OPTIONS": os.environ.get("NODE_OPTIONS", "--max-old-space-size=8192"),
           "OCR_LANG_PATH": os.environ.get(
               "OCR_LANG_PATH", str(ROOT / "web" / "public" / "tesseract" / "lang"))}
    t0 = time.time()
    # 하니스 로그는 한국어(UTF-8)다. text=True 만 주면 Windows 기본 코덱(cp949)으로
    # 디코딩하다 죽고, 그러면 proc.stdout 이 None 이라 케이스가 통째로 FAIL 로
    # 보인다 — 실제로는 엔진이 정상 실행된 뒤였다. 코덱을 못 박는다.
    proc = subprocess.run(cmd, cwd=ROOT / "web", capture_output=True, text=True,
                          encoding="utf-8", errors="replace",
                          env=env, timeout=1800)
    elapsed = time.time() - t0
    if proc.returncode != 0 or not out_json.exists():
        # opencv.js 는 한 줄이 수십만 자인 minify 본이라, 그대로 tail 하면 정작
        # 필요한 예외 메시지가 화면에서 밀려난다 — 긴 줄은 걷어낸다.
        lines = [ln for ln in (proc.stderr or proc.stdout or "").splitlines()
                 if ln.strip() and len(ln) < 300]
        raise RuntimeError("web 엔진 실행 실패:\n" + "\n".join(lines[-12:]))
    data = json.loads(out_json.read_text(encoding="utf-8"))
    w, h = png_size(ref)
    return EngineRun(data["findings"], w, h, elapsed,
                     log=proc.stdout[-4000:], artifacts=outdir,
                     extra={"totalMs": data.get("totalMs")})


def run_engine(engine: str, ref: Path, test: Path, use_ocr: bool = True,
               keep: Path | None = None,
               config_overrides: dict | None = None) -> EngineRun:
    """config_overrides: Config 필드 덮어쓰기 — 파라미터 스윕(tools/param_tune.py)
    전용. python 엔진만 지원한다(웹 엔진 설정은 config.ts 에 박혀 있다)."""
    if engine == "python":
        return _run_python(ref, test, use_ocr, keep, config_overrides)
    if engine == "web":
        if config_overrides:
            raise ValueError("web 엔진은 config_overrides 를 지원하지 않는다")
        return _run_web(ref, test, use_ocr, keep)
    raise ValueError(f"알 수 없는 엔진: {engine} (가능: {', '.join(ENGINES)})")


__all__ = ["run_engine", "fingerprint", "config_hash", "pipeline_hash",
           "git_state", "png_size", "EngineRun", "ENGINES"]

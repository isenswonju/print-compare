"""PDF 입력 래스터화 테스트 — imread_gray / _render_pdf_gray.

브라우저판(web/src/pipeline/pdf.ts)과 동일 계약: 첫 페이지, 600dpi(캔버스
한계 내), 흰 배경, 그레이스케일. 합성 PDF를 PIL로 만들어 검증한다.
pypdfium2(런타임) 또는 Pillow(테스트 픽스처 생성)가 없으면 스킵.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare_artwork import imread_gray  # noqa: E402

pytest.importorskip("pypdfium2", reason="PDF 입력에 pypdfium2 필요")
Image = pytest.importorskip("PIL.Image", reason="테스트 PDF 생성에 Pillow 필요")
from PIL import ImageDraw  # noqa: E402


@pytest.fixture(scope="module")
def synthetic_pdf(tmp_path_factory):
    """흰 300x400 배경에 검은 사각형(50,60)-(150,160) 1페이지 PDF."""
    img = Image.new("RGB", (300, 400), "white")
    ImageDraw.Draw(img).rectangle([50, 60, 150, 160], fill="black")
    path = tmp_path_factory.mktemp("pdf") / "synthetic.pdf"
    img.save(str(path), "PDF", resolution=72.0)
    return path


def test_pdf_rasterizes_to_gray(synthetic_pdf):
    gray = imread_gray(synthetic_pdf)
    assert gray.ndim == 2 and gray.dtype == np.uint8, "2D uint8 그레이스케일이어야 함"


def test_pdf_600dpi_scale(synthetic_pdf):
    # 72dpi 페이지(300x400 pt) → 600dpi(scale 8.33) → ~2500x3333px
    gray = imread_gray(synthetic_pdf)
    h, w = gray.shape
    assert 2450 <= w <= 2550, f"600dpi 폭 기대 ~2500, got {w}"
    assert 3280 <= h <= 3400, f"600dpi 높이 기대 ~3333, got {h}"


def test_pdf_white_background_black_shape(synthetic_pdf):
    gray = imread_gray(synthetic_pdf)
    h, w = gray.shape
    assert int(gray[5, 5]) > 240, "투명/여백은 흰 배경으로 합성돼야 함"
    cx, cy = int(100 / 300 * w), int(110 / 400 * h)  # 사각형 중심
    assert int(gray[cy, cx]) < 40, "검은 도형은 어둡게 렌더돼야 함"


def test_missing_pdf_dependency_message(monkeypatch, synthetic_pdf):
    # pypdfium2 import를 막아 안내 메시지가 나오는지 확인
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "pypdfium2":
            raise ImportError("blocked")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(SystemExit) as e:
        imread_gray(synthetic_pdf)
    assert "pypdfium2" in str(e.value)

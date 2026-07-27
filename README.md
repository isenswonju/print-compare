# Inkspect — 인쇄물 아트웍(REF) vs 실물 스캔(TEST) 결함 자동 검출

승인 원본(아트웍)과 실물 인쇄/스캔을 정합·비교해 인쇄 결함을 검출·분류·리포트하는
프리프레스/인쇄 QA 도구. **100% 결정론적(OpenCV)** 이며, 브라우저판은 분석이 전부
**접속자 브라우저 안(wasm)** 에서 실행돼 이미지가 외부로 나가지 않는다(규제 산업의
라벨 검수에 적합).

입력: PNG · JPG · **PDF**(다중 페이지). 한 세트(품목)에 원본·실물 각각 여러 파일/
페이지를 넣어 페이지쌍 단위로 분석한다.

검출 대상: 잉크 스팟, 글자 뭉개짐/메워짐(C→O 등), 잉여 점·대시, 뒷비침(show-through),
누락 잉크, 텍스트 불일치(OCR).

## 구성

- `web/` — 브라우저판 SPA (React + TypeScript, opencv.js / tesseract.js / pdf.js).
  분석·OCR·PDF 래스터화가 모두 클라이언트에서 실행. 정적 호스팅만으로 배포 가능.
- `compare_artwork.py` — 기준 Python 엔진(CLI). 브라우저판 정확도 검증과 오탐 튜닝의
  기준으로 유지.
- `webapp.py` — 경량 지원 서버(선택): `/app/` 정적 서빙 + `/feedback` 피드백 수집.

브랜드/도메인 특화 값(서비스명·로고 등)은 `web/src/branding.ts` 한 곳에 격리돼 있다.

## 개발

```bash
cd web
pnpm install
pnpm dev          # 개발 서버
pnpm test         # 단위(jsdom) + 브라우저(실 Chrome) 테스트
pnpm build        # dist/ 정적 산출물
```

Python 엔진/서버:

```bash
pip install opencv-python-headless numpy pytesseract flask
pip install pypdfium2          # PDF 입력을 쓸 때만
python -m pytest tests/ -v
python3 webapp.py --host 0.0.0.0   # http://<IP>:8501/app/
```

## 배포

브라우저판은 순수 정적 SPA(`vite base "./"`)라 어떤 정적 호스트에도 올릴 수 있다
(Vercel, Cloudflare Pages, Netlify, S3 등). `pnpm build` 후 `web/dist/`를 배포.
`webapp.py`는 사내망 서빙/피드백 수집이 필요할 때만 쓴다.

## CLI

```
python compare_artwork.py <REF> <TEST> -o <outdir> [--tol 5] [--no-ocr] ...
```

`findings.json` / `findings.csv` / `annotated.png` / `contact_sheet.png`를 생성한다.
파이프라인·파라미터 상세는 `compare_artwork.py` 상단 주석과 코드 내 설명 참조.

## 테스트

- 브라우저판: `pnpm test` (vitest — 결정론 로직·IndexedDB·피드백은 unit(jsdom),
  canvas/pdf.js/직렬화는 실 Chrome browser 프로젝트).
- Python: `python -m pytest tests/` (픽스처 회귀 + PDF 래스터화 + 피드백 서버).

기여 시 **TDD**(실패 테스트 먼저)로 진행하고 커버리지를 합리적 선에서 높게 유지한다.

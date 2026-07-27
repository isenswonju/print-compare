# 인쇄 검수 — 아트웍(REF) vs 실물 스캔(TEST) 결함 자동 검출

의료기기 라벨링 인쇄 검수 도구. 승인 아트웍(REF)과 실물 스캔(TEST)을
정합·비교해 인쇄 결함을 검출·분류·리포트한다. **100% 결정론적(OpenCV)**.

**주 사용 형태는 브라우저판(`web/`)이다** — 분석 전체가 접속자 브라우저(wasm)
안에서 실행되는 정적 SPA. 배포:
- 상시(무료): https://i-sens-artwork-compare.static.hf.space/
- 사내망: http://<맥미니 IP>:8501/app/ (launchd 상주 `webapp.py`가 서빙)

구성 요소:
- `web/` — 브라우저판 (React+TS, opencv.js/tesseract.js). 재배포:
  `cd web && npm run build` 후 huggingface_hub `upload_folder(dist)`.
- `compare_artwork.py` — 기준 Python 엔진(CLI). 브라우저판 정확도 검증
  (`web/tools/harness.cjs`)과 오탐 튜닝의 기준으로 유지.
- `webapp.py` — 경량 지원 서버: `/app/` 정적 서빙 + `/feedback` 피드백 수집
  (`feedback/feedback.jsonl` + `feedback/images/` — 오탐 튜닝 입력 데이터).
  옛 서버측 분석 웹 UI는 2026-07-24 제거됨.

입력 형식: PNG · JPG · **PDF**. PDF는 첫 페이지를 600dpi 흰 배경 PNG로
래스터화한 뒤 분석한다(브라우저판은 self-host pdf.js, Python판은 pypdfium2 —
양쪽 동일 계약). REF/TEST 중 한쪽만 PDF여도 된다.

검출 대상: 잉크 스팟, 글자 뭉개짐/메워짐(C→O 등), 잉여 점·대시,
뒷비침(show-through), 누락 잉크.
결함으로 보고하지 않는 것: 재단선/레지스터 마크 부재, 스캔 스큐,
회색 박스 망점 톤 차이.

## 설치

```bash
pip install opencv-python-headless numpy pytesseract
pip install pypdfium2          # PDF 입력을 쓸 때만 (시스템 의존성 없음)
# OCR 경로(§3.7)를 쓰려면 시스템 tesseract 필요:
brew install tesseract        # macOS
apt install tesseract-ocr     # Debian/Ubuntu
```

Python 3.10+.

## 지원 서버 (사내망 서빙 + 피드백 수집)

```bash
pip install flask
python3 webapp.py --host 0.0.0.0   # → http://<내IP>:8501/app/
```

브라우저에서 REF/TEST 이미지(또는 PDF)를 드래그&드롭 → 검수 시작 → 십수 초 후
결함 테이블·오버레이·확대 비교 시트·CSV 다운로드가 표시된다.
업로드 파일과 결과는 로컬 `webjobs/`에만 저장되며(7일 후 자동 정리)
**외부로 전송되지 않는다** — 의료기기 라벨 데이터를 클라우드에 올리지 않기
위한 의도적 설계다.

## 외부 공유 (사내 머신 + Tailscale Funnel) — 현재 방식

완전 무료이고 이미지가 사내 머신을 벗어나지 않는다 ("외부 미전송" 설계 유지).

**고정 공유 주소: https://macmini.tail5860bc.ts.net/** (재부팅해도 불변)

구성 (모두 로그인 시 자동 시작, 수동 개입 불필요):
- 웹서버: launchd(`~/Library/LaunchAgents/com.artwork-compare.server.plist`)가
  `start_server.sh` 실행. 수동 재시작:
  `launchctl kickstart -k gui/501/com.artwork-compare.server`
- 외부 공개: Tailscale Funnel (계정 isenswonju@, 로그인 항목에 등록됨).
  상태 확인: `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status`
- 기본은 접속 암호 없음 — URL 아는 사람은 누구나 사용 가능하니 사내에만
  공유. 암호를 걸려면 launchd plist에 `APP_PASSWORD` 환경변수 추가.
- 이 머신(macmini)이 켜져 있어야 접속 가능. 다른 머신으로 옮기면
  Funnel 주소의 호스트명이 바뀐다.
- 임시 대안 터널(계정 불필요, URL 매번 변경):
  `cloudflared tunnel --url http://127.0.0.1:8501 --protocol http2`
  (이 네트워크는 QUIC/UDP가 막혀 있어 `--protocol http2` 필요)

### (보류) 클라우드 배포 패키지 `hf-space/`

Docker 컨테이너 호스팅(HF Spaces 유료 PRO, Cloud Run, Fly.io 등)용 패키지.
Hugging Face가 2026년 무료 Docker Space를 폐지해 보류 중이다.
업로드 원본 즉시 삭제 + 결과물 30분 TTL(`JOB_TTL_MINUTES`)이 켜져 있어
클라우드 체류 데이터를 최소화한다 (로컬 기본값은 7일).
`webapp.py` 수정 시 `hf-space/`에 다시 복사해야 반영된다.

## CLI 사용법

```
python compare_artwork.py <REF.png> <TEST.png> -o <outdir> \
    [--tol 5] [--min-area 60] [--no-ocr] [--no-tile-refine] \
    [--llm-verify] [--debug]
```

| 산출물 | 내용 |
|---|---|
| `aligned_test.png` | REF 좌표계로 정합된 TEST |
| `annotated.png` | 결함 번호 + 빨간 박스 오버레이 (0.45배 축소) |
| `contact_sheet.png` | 결함별 [헤더 / REF 크롭 / TEST 크롭] 세로 스택 |
| `findings.json` | 결함 목록 (스키마는 아래) |
| `findings.csv` | 엑셀 열람용 (UTF-8 BOM) |
| `debug/` | `--debug` 시 단계별 중간 마스크 |

stdout에 요약 테이블(번호/유형/심각도/bbox/비고)이 출력된다.

### findings.json 스키마

```json
[{
  "id": 1,
  "type": "extra | missing | showthrough | text_mismatch | trim_mark_expected | layout_reflow",
  "severity": "critical | major | minor | expected",
  "bbox_ref": [x, y, w, h],
  "area_px": 123,
  "near_text": "expiration date printed",
  "note": "잉크 뭉침으로 n 획 손상"
}]
```

## 파이프라인 개요

1. **전역 정합** — ORB(20k) + Lowe ratio 0.75 + RANSAC homography,
   `warpPerspective(..., borderValue=255)`.
   게이트: inlier ≥ 300, 스케일 성분 0.9~1.1 (불만족 시 명확한 에러로 중단).
2. **타일 국소 정밀 정합** (핵심 차별점) — 768px 타일(오버랩 128) 격자에서
   Hann window + `phaseCorrelate`로 잔차 변위(전역 정합 후 5~15px)를 추정,
   bilinear 보간 변위장으로 `remap`. 이 단계 덕분에 diff 팽창 허용치를
   **5px**로 줄일 수 있어, 기존 획에 붙은 추가 잉크(메워진 C→O 등)가
   팽창 그림자에 숨지 않는다.
3. **잉크 이진화** — TEST는 CLOSE(81×81) 배경 평탄화 후 divide,
   양쪽 adaptiveThreshold(block 41, C 18).
4. **구조 diff** — `extra = TEST ∧ ¬dilate(REF, tol)`,
   `missing = REF ∧ ¬dilate(TEST, tol)`, open(3×3).
5. **군집화·필터** — dilate(31×31) 병합 → connectedComponents,
   면적은 open 전 원시 diff 기준(획 부착 소형 결함 보존),
   `min-area`(REF 폭 5564 기준 60px, 해상도에 (w/5564)² 비례) 미만 제거.
   외곽 6% 마진의 missing 성분은 `trim_mark_expected`로 분류.
5b. **리플로우 억제** — 개정판 간 문구 추가/삭제로 이후 본문이 줄 단위로
   밀리면(reflow) 픽셀 diff는 밀린 모든 줄을 extra/missing 쌍으로 오탐한다.
   각 diff 성분을 문맥 패딩(48px) 포함 크롭해 상대 이미지의 국소 창
   (세로 ±200px, 가로 ±60px)에서 `matchTemplate`(CCOEFF_NORMED ≥ 0.85,
   무변위 ±12px 제외)로 찾고, diff 잉크 픽셀의 60% 이상이 변위 위치의
   상대 잉크로 덮이는 경우에만 줄 밀림으로 판정해 억제. 억제된 영역은
   `layout_reflow`(expected) 1건으로 합산 보고되며, 밀림을 유발한 문구
   변경 자체는 OCR 경로가 `text_mismatch`로 잡는다.
6. **뒷비침** — medianBlur(7) 후 151~214 밴드 ∧ REF 백색(>215, erode 9).
   리플로우로 밀린 본문이 고스트로 오탐되는 것을 막기 위해 5b와 동일
   매칭 + 억제 영역 겹침(>10%) 검사를 적용.
7. **OCR 안전망** — tesseract(eng, psm 3)로 REF/정합 TEST 단어 시퀀스를
   SequenceMatcher 정렬, 불일치를 `text_mismatch`(CRITICAL)로 보고.
8. **심각도** — CRITICAL: text_mismatch 또는 REV 행 교차 /
   MAJOR: 글자·괘선 박스 교차, showthrough / MINOR: 여백 고립 반점.

## 파라미터 튜닝 가이드

| 파라미터 | 기본값 | 언제 조정하나 |
|---|---|---|
| `--tol` | 5 | 타일 정합 후에도 잔차가 큰 저품질 스캔이면 7~9로. 키울수록 획 부착 결함이 숨는다. |
| `--min-area` | 60 | 더 작은 반점까지 잡으려면 낮춘다(오탐 증가). 기준 해상도(폭 5564px) 값이며 자동 스케일된다. |
| `--no-tile-refine` | off | 폴백 모드. 타일 정합을 생략하고 tol=13을 쓴다. 잔차 흡수를 위해 팽창이 커져 **획 부착 결함을 놓친다** — 디버깅 용도로만. |
| `--no-ocr` | off | tesseract 미설치 환경, 또는 속도 우선일 때. C→O류 훼손의 이중 검출망이 꺼진다. |
| `Config.extra_max_norm` | 190 | extra 후보의 diff 픽셀 평균 밝기 상한. 실측: 진성 결함 ≤174, 망점/고스트 오탐 ≥206. 흐린 잉크 결함이 걸러지면 올린다. |
| `Config.missing_max_ref` | 190 | missing 후보의 REF 밝기 상한(회색 박스 톤 차이 억제). |
| `Config.ghost_ref_white` | 215 | 뒷비침 판정용 REF 백색 기준. 회색 박스 톤(~210)을 제외하는 값. 아트웍의 회색 톤이 더 밝으면 올린다. |
| `Config.ghost_band_hi` | 214 | blur 후 고스트 밴드 상한. 회색 박스 평탄값(~221)보다 낮아야 한다. |
| `Config.ocr_min_conf` | 40 | OCR 단어 신뢰도 하한. 스캔이 거칠어 OCR 오탐이 늘면 올린다. |
| `Config.reflow_search_y` | 200 | 리플로우 매칭 세로 탐색 반경(REF 폭 5564 기준). 개정 간 줄 밀림이 3줄 이상이면 올린다. |
| `Config.reflow_min_corr` | 0.85 | 리플로우 판정 상관 하한. 낮추면 억제가 공격적이 되어 진성 결함을 놓칠 수 있다. |
| `Config.reflow_min_cover` | 0.6 | diff 잉크가 변위 위치 상대 잉크로 덮여야 하는 비율. 상관 매칭의 자기유사 문맥(장선·여백) 오억제를 막는 2차 검증. |

정합·이진화 파라미터(ORB 20k, ratio 0.75, RANSAC 3.0, 타일 768/128,
blockSize 41/C 18 등)는 실측 검증값이므로 유지를 권장.

### 지시서 대비 조정 사항 (픽스처 실측 근거)

- **뒷비침 규칙 보강**: 원 사양(`150<norm<225 ∧ erode(REF)>200`)은 이
  픽스처에서 회색 망점 박스(REF 톤 210, TEST 망점 spread)를 통째로
  오탐했다. medianBlur(7)로 망점 도트를 평탄화하고(획 폭 있는 고스트만
  밴드에 잔류), REF 백색 기준을 215로 올려 회색 박스를 제외했다.
  진짜 CAUTION 박스 뒷비침은 그대로 검출된다.
- **군집 면적을 원시 diff 기준으로 계산**: open(3×3) 후 면적으로는
  픽스처 #5(expiration의 n 뭉침, 원시 62px → open 후 43px)가
  min-area(60)에 걸려 탈락한다. 군집 구조는 open 후 마스크로 잡되
  면적은 open 전 값을 쓴다.
- **diff 픽셀 밝기 필터**(extra ≤190 / missing ≤190): 망점 박스 가장자리
  톤 차이와 고스트 텍스트가 extra/missing으로 새는 것을 억제(함정 #2).
- **OCR 픽셀 증거 대조**: 텍스트 불일치는 해당 bbox에 실제 잉크 diff가
  있어야 결함으로 인정. 망점 영역 OCR 판독 실패('타이틀 문구 삭제')와
  동일 글리프 오독('&'→'4', '1-SENS'→'i-SENS')을 배제한다.
  C→O 같은 결함성 변형은 잉크 증거가 있으므로 보존된다.

## 회귀 테스트

```bash
python -m pytest tests/ -v
```

`tests/fixtures/`의 PGA1E0398 REF/TEST 쌍으로 9건 결함 검출 + FP ≤ 5 +
재단선 4모서리 expected 분류를 검증한다 (약 13초).

참고: 지시서 §5 표의 #2, #5 좌표는 근사치가 실물과 어긋나 실측 좌표로
교정했다(근거는 `tests/test_fixture.py` docstring 참조).

## (선택) LLM 검증 훅

```bash
export ANTHROPIC_API_KEY=...
python compare_artwork.py REF.png TEST.png -o out --llm-verify
```

결함 후보의 REF/TEST 크롭 쌍(각 ≤400×200px)만 Claude(haiku급)에 배치
전송해 `defect | noise | expected`로 분류하고 비고에 병기한다.
**전체 페이지 이미지는 절대 전송하지 않는다.** 기본 비활성이며,
결정론 파이프라인 단독으로 회귀 테스트를 통과한다.
`pip install anthropic` 필요.

## 성능

5564×7100 / 4960×7013 쌍 기준 (Apple Silicon):
정합+diff+리포트 약 4초, OCR 포함 약 13초.

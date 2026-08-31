# 인쇄 검수 — 아트웍(REF) vs 실물 스캔(TEST) 결함 자동 검출

의료기기 라벨링 인쇄 검수 도구. 승인 아트웍(REF)과 실물 스캔(TEST)을
정합·비교해 인쇄 결함을 검출·분류·리포트한다. **100% 결정론적(OpenCV)**.

**주 사용 형태는 브라우저판(`web/`)이다** — 분석 전체가 접속자 브라우저(wasm)
안에서 실행되는 정적 SPA. 배포:
- 상시(무료): https://i-sens-artwork-compare.static.hf.space/
- 사내망: http://<맥미니 IP>:8501/app/ (launchd 상주 `webapp.py`가 서빙)

구성 요소:
- `web/` — 브라우저판 (React+TS, opencv.js/tesseract.js). 재배포:
  `python3 tools/hf_deploy.py` (빌드→업로드→실서비스 지문 검증까지 한 명령).
  엔진 수정은 재배포까지가 한 세트다 — 빠뜨리면 매일 03:10 `bench.sync`가
  배포 지문(`version.json`) 불일치 알림으로 잡는다.
  원본 보관함은 **팀 공용 하나**다 — 서버(`inkspect-feedback`의 `/api/library`)가
  정본이고 IndexedDB는 LRU 캐시(목록만 자동 동기화, 본체는 사용 시 다운로드,
  삭제도 tombstone으로 전파). 비밀번호·로그인 없이 어느 기기에서 열든 같은
  보관함이 보인다. 자세한 구조는 `docs/원본보관함-영구저장-계획.md` §4-3,
  규모 실측은 §4-2.
  다중 샘플 모드: 인쇄물 스캔 1장에 같은 라벨이 여러 개면 세트의 "다중 샘플"을
  켠다 — 템플릿 매칭(0/90/180/270°)으로 샘플 위치를 찾아 샘플별로 나눠
  검수한다(`web/src/pipeline/multisample.ts`, 패리티 대상 아님).
- `compare_artwork.py` — 기준 Python 엔진(CLI). 브라우저판 정확도 검증
  (`web/tools/harness.cjs`)과 오탐 튜닝의 기준으로 유지.
- `webapp.py` — 경량 지원 서버: `/app/` 정적 서빙 + `/feedback` 피드백 수집
  (`feedback/feedback.jsonl` + `feedback/images/` — 오탐 튜닝 입력 데이터).
  옛 서버측 분석 웹 UI는 2026-07-24 제거됨.

입력 형식: PNG · JPG · **PDF**. PDF는 첫 페이지를 600dpi 흰 배경 PNG로
래스터화한 뒤 분석한다(브라우저판은 self-host pdf.js, Python판은 pypdfium2 —
양쪽 동일 계약). REF/TEST 중 한쪽만 PDF여도 된다.

검출 대상: 잉크 스팟, 글자 뭉개짐/메워짐(C→O 등), 잉여 점·대시,
뒷비침(show-through), 누락 잉크, **인쇄 농도 부족(옅게 인쇄됨)**.

검출 한계(실측): 잉크 면적 40px 미만, 그리고 글자 안쪽의 폭 4px 이하 결손
(획 끊김·마침표 크기 삭제)은 잡지 못한다. 후자는 잔여 정합 오차(2~3px)를
흡수하려면 주변을 훑어야 하고 그러면 결손이 이웃 잉크에 덮이는 구조적 한계다
(허용치를 낮추면 검출이 3~10배로 폭증해 쓸 수 없다). 자세한 측정은
`python tools/recall_stress.py`.
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
  "type": "extra | missing | faded | showthrough | text_mismatch | trim_mark_expected | layout_reflow",
  "severity": "critical | major | minor | expected",
  "bbox_ref": [x, y, w, h],
  "area_px": 123,
  "near_text": "expiration date printed",
  "note": "잉크 뭉침으로 n 획 손상",
  "metrics": { "margin": 3.08, "basis": "면적 123 / 최소 40px" }
}]
```

`metrics.margin`은 임계값 여유도다(1.0 = 임계값에 딱 걸침). 연속 점수가 없는
유형(`text_mismatch`)에는 없다. 정확도 안전망이 "통과했지만 임계값에
가까워지는" 회귀를 조기에 잡는 데 쓴다 — 아래 §정확도 안전망 참조.

잉여 잉크 계열(extra, 추가-잉크 증거 text_mismatch)에는 표시 유형 판별용
실측값이 더 붙는다(2026-08-05, 사용자 판정 8건 근거):
- `metrics.touch_text_px` — 잉여 잉크가 REF **글자 잉크**(OCR 단어 박스 안)와
  맞닿은 픽셀 수. 여백 오염('인쇄/오염' MAJOR) vs 인쇄 영역 침범('가독성'
  CRITICAL)을 가른다. 실측 경계: 오염 ≤6px / 침범 ≥33px → 웹 표시 매핑은 20px.
  괘선·표선 접촉은 세지 않는다.
- `metrics.evidence` — text_mismatch 픽셀 증거 극성(`added`|`lost`|`mixed`).
  전부 추가 잉크(`added`)면 내용이 바뀐 게 아니라 오염이 읽힘을 바꾼 것이므로
  '인쇄 오류(내용 불일치)'가 아니라 오염/침범으로 표시한다.

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
5c. **인쇄 농도**(3.4b) — 픽셀 diff는 잉크 마스크가 이진이라 "회색으로 인쇄된
   글자"도 잉크로 잡아 diff가 0이다(실측: 9000px 크기의 옅은 단어를 0건 검출).
   REF 잉크 덩어리(글자)마다 REF/TEST의 잉크 진하기를 같은 픽셀 집합에서 재고,
   **페이지 중앙값 대비** 유독 옅은 덩어리만 `faded`로 보고한다. 집계 대상은
   REF 밝기 ≤ `cover_ref_max`(190)인 픽셀뿐이다 — 회색 톤(망점 박스 ~210)은
   REF에서만 잉크로 잡히고 TEST는 평탄화로 흰색이 되어 통째로 오탐되기 때문. 상대 판정이라
   전체적인 인쇄 질감 저하는 통과한다(실측: 전체 블러+노이즈+톤 저하를 먹여도
   중앙값 1.13→1.11, 국소 결함은 0.49로 분리).
6. **뒷비침** — medianBlur(7) 후 151~214 밴드 ∧ REF 백색(>215, erode 9).
   리플로우로 밀린 본문이 고스트로 오탐되는 것을 막기 위해 5b와 동일
   매칭 + 억제 영역 겹침(>10%) 검사를 적용.
7. **OCR 안전망** — tesseract(eng, psm 3)로 REF/정합 TEST 단어 시퀀스를
   SequenceMatcher 정렬, 불일치를 `text_mismatch`(CRITICAL)로 보고.
8. **심각도** — CRITICAL: text_mismatch 또는 REV 행 교차 /
   MAJOR: 글자·괘선 박스 교차, showthrough, faded / MINOR: 여백 고립 반점.

## 파라미터 튜닝 가이드

| 파라미터 | 기본값 | 언제 조정하나 |
|---|---|---|
| `--tol` | 5 | 타일 정합 후에도 잔차가 큰 저품질 스캔이면 7~9로. 키울수록 획 부착 결함이 숨는다. |
| `--min-area` | 40 | 더 작은 반점까지 잡으려면 낮춘다(오탐 증가). 기준 해상도(폭 5564px) 값이며 자동 스케일된다. 60→40은 미검출 가혹 테스트 근거(50px 결함 확보, 픽스처 오탐 증가 0). |
| `Config.fade_rel` | 0.70 | 옅은 인쇄 판정 — 잉크 농도비가 페이지 중앙값의 이 배수 미만이면 보고. 상대 판정이라 전체적인 질감 저하는 통과한다. 올리면 민감해진다. |
| `Config.fade_abs` | 0.80 | 위 조건과 함께 충족해야 하는 절대 상한(전체가 옅은 경우 방어). |
| `Config.cover_min_area` | 120 | 농도 검사 대상 글자 덩어리 최소 면적. 낮추면 잔글씨까지 보지만 오탐이 는다. |
| `Config.cover_ref_max` | 190 | 농도 비교 대상으로 인정하는 REF 잉크 밝기 상한. 회색 톤(망점 박스 ~210)은 REF에서 잉크로 잡히지만 TEST는 평탄화로 흰색이 되어, 그대로 비교하면 박스가 통째로 "농도 4%" 오탐이 된다(안전망 identity 케이스 실측). 근거값은 `missing_max_ref`와 동일. |
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

값을 바꾸기 전에 `python3 tools/param_tune.py` 를 돌려라 — 후보 값마다 전
케이스를 채점해 제안서(`bench/out/tuning-proposal.md`)를 만든다. 목적함수는
tune 그룹, guard(홀드아웃)는 검증 병기라 과적합을 막는다. 자동 적용은 없다 —
적용은 Config 와 `web/src/pipeline/config.ts` 를 함께 고치는 것까지가 한 세트.

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
- **단어 조각 오독 무시**: 교체(replace) 중 한쪽이 다른 쪽의 부분 문자열인
  1~2자 조각이면 판독 실패로 본다. 뒷비침이 겹친 줄에서 OCR이 단어 앞부분을
  놓치고 끝 글자만 남기는 일이 있다(실측: tesseract.js가 `Owner's`를 `s`로만
  읽어 브라우저판에만 오탐). 단어가 실제로 지워진 결함이면 잉크 diff가 훨씬 큰
  면적으로 잡는다(가혹 테스트 `erase_word` 200×45 검출).

## 회귀 테스트

```bash
python -m pytest tests/ -v
```

정확도 도구 (피드백 기반 튜닝용):

```bash
python tools/recall_stress.py        # 미검출 가혹 테스트 — 결함을 심어 놓치는지
python tools/min_area_sweep.py       # 임계값 트레이드오프 표(검출 vs 오탐)
python tools/ocr_rules_eval.py REF TEST   # OCR 오탐 억제 규칙 후보 비교
```

`tests/fixtures/`의 PGA1E0398 REF/TEST 쌍으로 9건 결함 검출 + FP ≤ 5 +
재단선 4모서리 expected 분류를 검증한다 (약 13초).

참고: 지시서 §5 표의 #2, #5 좌표는 근사치가 실물과 어긋나 실측 좌표로
교정했다(근거는 `tests/test_fixture.py` docstring 참조).

## 정확도 안전망 (`bench/`) — 개선이 양날의 검이 되지 않게

엔진을 고칠 때마다 **잘 되던 케이스가 죽는지** 자동으로 확인한다.

```bash
python -m bench.run                  # 전 케이스(30건, 6.5분) — 종료코드 0=PASS, 1=FAIL
python -m bench.run --fast --group guard   # 오탐 감시만 OCR 끄고(7건, 30초 — 커밋마다)
python -m bench.run --group guard     # 홀드아웃만(OCR 포함)
python -m bench.run --only pga1e0398 --keep out/  # 한 건 + 산출물 보기
python -m bench.run --engine web      # 사용자가 쓰는 브라우저 엔진(TS)으로
python -m bench.run --accept          # 결과를 확인한 뒤 기준선으로 승인
python -m bench.import_feedback       # 피드백 → 케이스 자동 생성
```

### 커밋마다 자동 실행 (권장)

```bash
git config core.hooksPath hooks      # 클론당 1회
```

`hooks/pre-commit`이 **엔진·케이스를 건드린 커밋에서만** guard 셋을 OCR 없이
돌린다(약 30초). 문서·설정만 바꾼 커밋은 그냥 통과한다. 막히면
`bench/out/report.md`에 무엇이 깨졌는지와 판정용 크롭이 있고, 의도한 변경이면
`--accept`로 기준선을 올린 뒤 다시 커밋한다. 정말 넘겨야 하면
`git commit --no-verify`(대신 이유를 남길 것).

전체 게이트(라벨 계약·미검출·마진)는 6.5분이라 커밋마다 돌리지 않는다 —
배포 전이나 엔진을 손본 뒤 `python -m bench.run`으로 따로 돌린다.

### 매일 자동 점검 (launchd)

맥미니에서 **매일 03:10** 에 `bench/sync.py` 가 돈다.

0. HF 배포 지문 대조(배포 누락 감지) + 피드백 수집 경로 건강검진
   (Vercel 수집기 도달성, 로컬 `/healthz` — feedback/ 실제 쓰기 검사)
1. 공용 보관함에 새로 올라온 아트웍을 감시 케이스로 들여오고
2. 전 케이스를 python 엔진으로 점검하고
3. 실물(labeled) 케이스에서 python↔web 엔진의 계약 판정이 갈리는지 대조하고
   (사용자가 실제로 보는 것은 web 엔진이다 — 예산 내 오탐 수 요동은 로그만)
4. 게이트가 깨졌으면 자가수리를 시도한다 — `tools/self_repair.py` 가 격리
   worktree 에서 Claude Code 헤드리스로 원인을 고쳐 **repair/\* 브랜치**에
   패치를 제안한다(옵트인: `private/.self-repair-on`). push · `--accept` ·
   배포는 하지 않는다 — 검토와 병합은 사람 몫이다.

문제가 있을 때만(새 케이스·게이트 파손·배포 불일치·패리티 어긋남·수리 결과)
알림을 띄운다.

```bash
cp tools/com.artwork-compare.bench-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.artwork-compare.bench-sync.plist
launchctl kickstart -k gui/$(id -u)/com.artwork-compare.bench-sync   # 즉시 한 번
launchctl bootout   gui/$(id -u)/com.artwork-compare.bench-sync      # 끄기
```

기록은 `bench/out/sync.log`(생성물). **기준선은 자동 승인하지 않는다** — 자동
갱신하면 안전망이 그냥 로그가 되기 때문에, 사람이 결과를 보고 `--accept` 해야
한다. 이력(`history.jsonl`)도 남기지 않아 저장소가 매일 더러워지지 않는다.
새로 생긴 케이스 JSON만 작업 트리에 남는다(검토 후 커밋할 물건).
실행 시간 경고도 끈다(`--no-timing`) — launchd 는 우선순위가 달라 늘 1.6배쯤
느려서, 켜두면 경고 32건이 진짜 신호를 덮는다.

보관함 비밀번호는 `private/.library-password`(git 제외)에서 읽는다. 파일이 없으면
수입만 건너뛰고 점검은 그대로 돈다.

> launchd 작업은 `~/Desktop` 접근이 macOS TCC 로 막혀 있다 — `/bin/sh` 로 스크립트를
> 실행하면 `Operation not permitted` 로 죽는다. 그래서 서버 에이전트와 같은
> 바이너리(`/usr/bin/caffeinate` + pyenv python)로 실행한다.

### 2층 구조 — 왜 "이전 결과와의 비교"만으로는 안 되는가

이전 엔진의 출력에는 오탐이 섞여 있다(그래서 튜닝한다). 그걸 정답으로 굳히면
오탐 제거가 곧 "회귀"로 잡혀 안전망이 개선을 막는 브레이크가 된다. 그래서
기준을 둘로 나눈다.

| 층 | 무엇 | 판정 |
|---|---|---|
| 1층 **계약** | 사람이 확인한 사실 — `must_find`(반드시 잡을 영역) · `forbid`(사용자 확인 오탐 영역) · `fp_budget` | **FAIL** = 머지 불가 |
| 2층 **표류** | 라벨 없는 영역의 신규·소실 검출, 마진 감소, 런타임 증가 | **WARN** = 사람이 판정한 뒤 1층 라벨로 승격 |

2층은 버리는 정보가 아니라 1층을 키우는 공급 라인이다. 한 번 판정한 표류는
케이스 JSON에 라벨로 적히고, 그 뒤로는 영구히 계약이 된다.

게이트 규칙:
- **FAIL** — `must_find` 누락 / critical 라벨의 심각도 하락 / `forbid` 영역에서
  결함 부활 / 오탐이 `fp_budget` 초과 / 오탐이 **기준선보다 증가**
- **WARN** — 라벨 없는 영역의 표류, 마진 20% 이상 감소, 런타임 1.3배 초과,
  설정·환경 지문 변화, 포기 라벨의 부활
- 기준선(`bench/baseline.json`)은 `--accept`로만 갱신된다. 자동 갱신하면
  안전망은 그냥 로그가 되므로 절대 자동화하지 않는다.

### 마진 — pass/fail보다 빠른 경보

각 검출이 임계값을 얼마나 여유롭게 넘겼는지를 함께 기록한다
(`findings.json`의 `metrics.margin`, 1.0 = 임계값에 딱 걸침).

```
inject-spot_tiny   면적 50 / 최소 40px   → 1.23×   ← 위험. 다음 변경에서 떨어진다
inject-erase_line  면적 4044 / 최소 40px → 101×    ← 안전
```

통과했는데 마진이 1.6→1.05로 줄었다면 **아직 안 터진 회귀**다. pass/fail만
보면 절벽 끝에 서 있는 걸 모른다.

### 케이스 (30건)

| 종류 | 무엇 | 라벨 비용 |
|---|---|---|
| `labeled` | 실물 REF/TEST + 사람이 확인한 라벨 | 피드백에서 자동 생성 |
| `identity` | 같은 이미지끼리 비교 → 결함 0건이 정답 | 0 |
| `benign` | 결함 아닌 열화(스큐·질감·전체 옅음·JPEG) → 결함 0건 | 0 |
| `injected` | 알려진 결함 주입(`tools/recall_stress.py` 주입기) | 0 (자동 라벨) |

합성 케이스는 커밋된 픽스처에서 결정론적으로 재현되므로 새 클론에서도 그대로
돈다. 실물 이미지는 의료기기 라벨 데이터라 저장소에 넣지 않고
(`private/bench-cases/`, git 제외) **라벨 JSON만 커밋**한다 — 이미지가 없는
환경에서는 그 케이스만 SKIP 되고 나머지는 계속 돈다.

`tune` / `guard` 셋은 **과적합 방지**용이다. 임계값 스윕에 쓴 케이스로 게이트하면
현장 성능이 나빠진다. 임계값을 고를 때는 `tune`만 보고, `guard`는 게이트에서만
쓴다(피드백에서 새로 들어온 케이스는 기본 `guard`).

### 포기 원장(waived)

구조적 한계로 포기하는 케이스는 지우지 않고 **이유를 적어 게이트에서만 제외**한다.

```json
"waived": [{ "label": "thin_stroke", "date": "2026-07-30", "commit": "0039b01",
             "lost": "폭 4px 이하 획 끊김 미검출",
             "gained": "허용치를 낮추면 오탐이 3~10배로 폭증" }]
```

포기 라벨이 다시 검출되면 WARN으로 알려준다(원장에서 지우고 계약으로 올릴 때).
현재 원장: `erase_period`, `thin_stroke` (각 clean/degraded) — README 검출 한계와 동일.

### 리포트와 이력

- `bench/out/report.md` — 실행마다 새로 쓰는 판정용 리포트. 판정이 필요한 항목
  (오탐·표류·금지영역 부활)은 **REF/TEST를 나란히 붙인 크롭**을
  `bench/out/crops/<케이스>/`에 남기고 리포트에서 링크한다 — 좌표만 있는 리포트는
  결국 엔진을 다시 돌려보게 만든다.
- `bench/history.jsonl` — 케이스 × 커밋 × 지표(검출·오탐·마진·시간) 시계열.
  "언제부터 나빠졌나"를 커밋에 붙여 되짚을 수 있다.

### 사용자가 올린 아트웍을 그대로 감시망으로

우리가 고른 픽스처 하나로는 현장 아트웍의 성질을 다 담을 수 없다. 사용자가 올린
원본이 들어오는 대로 **라벨 없이** 케이스가 되게 한다(정답이 "결함 0건"이라
사람 손이 필요 없다).

```bash
python -m bench.import_library --dir ~/원본모음   # 로컬 폴더에서
python -m bench.import_library --server           # 공용 보관함(ADMIN_PASSWORD)
```

원본 하나 → `identity`(자기비교) + `benign`(스캔 스큐+질감 열화) 두 케이스.
PDF·JPG도 600dpi PNG로 정규화해 들인다. 들여올 때 아트웍 성질(회색 톤 비율,
큰 솔리드 잉크 영역)을 재서 케이스 note에 남긴다 — 나중에 "이 원본은 뭐가 달라서
결과가 다른가"를 다시 조사하지 않기 위해서다.

참고(2026-07-31 실측): 배경 평탄화 커널(81px)보다 두꺼운 **솔리드 잉크 영역은
검출 사각지대가 아니다**. 200px 두께 바 안의 흰 반점(r=12)은 `extra` 1880px로,
바 전체를 회색 120/180으로 옅게 인쇄한 것은 `missing` 32844px로 잡힌다. 농도(3.4b)
경로만 그 영역을 보지 않을 뿐 픽셀 diff가 담당한다.

### 두 엔진 대조

같은 케이스를 `--engine python`(기준 구현)과 `--engine web`(사용자가 쓰는 엔진)으로
돌려 기준선을 따로 갖는다. 두 엔진의 차이 자체가 신호다 — 실제로 web 전용 오탐을
하나 찾아 고쳤다: 뒷비침이 겹친 줄에서 tesseract.js가 `Owner's`를 끝의 `s`만 읽어
`text_mismatch`가 났다(네이티브 tesseract는 정상 판독). 부분 문자열인 1~2자 조각은
인쇄 결함이 아니라 판독 실패로 보고 무시한다(§3.7, 양 엔진 동일).
현재 pga1e0398 실측: 검출 9/9·오탐 1건으로 두 엔진 일치, 마진 오차 5% 이내.

한 결함이 diff·OCR 두 경로로 잡히면 **라벨에 유형을 둘 다 적는다**
(`"types": ["extra", "text_mismatch"]`). 한쪽만 적으면 다른 경로의 정탐이 오탐으로
집계된다 — 실제로 REV 행 결함에서 그랬다.

### 안전망이 실제로 잡은 것 (2026-07-30, 도입 첫 실행)

`identity`/`benign` 케이스가 **오탐 15건**을 잡았고 전부 원인이 하나였다 —
농도 검사(3.4b)가 회색 톤 박스를 "농도 4% 수준"으로 오탐. REF는 배경 평탄화를
하지 않고 TEST만 하는 비대칭 때문에, 회색 박스(210)가 REF에서는 잉크로 잡히고
TEST에서는 흰색이 되어 생긴 문제다. `cover_ref_max`(190)로 회색 톤을 농도 집계에서
빼서 고쳤다(실물 픽스처 오탐 2→1, 검출 9/9 유지 — `tests/test_faded.py`가 지킨다).

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

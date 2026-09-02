# AGENTS.md — 이 저장소에서 작업하는 AI 에이전트를 위한 규칙

Codex/Claude Code 등 AI 코딩 도구는 이 파일을 먼저 읽는다.
사람이 읽는 상세 문서는 `README.md`다.

## 이 프로젝트가 하는 일

의료기기 라벨 인쇄 검수 도구. 승인 아트웍(REF)과 실물 스캔(TEST)을 정합·비교해
인쇄 결함을 찾는다. 100% 결정론적(OpenCV) — AI 추론으로 결함을 판정하지 않는다.

실제 사용자가 쓰는 것은 **브라우저판(`web/`, TypeScript)** 이다.
`compare_artwork.py`(Python)는 정확도 기준이 되는 참조 구현이며, 두 엔진은
같은 결과를 내야 한다(패리티).

## 절대 규칙 (어기면 사고가 난다 — 과거 실제 사고 기록)

1. **엔진을 고쳤으면 반드시 재배포한다.** 검증 후 `main`에 커밋·push하면
   GitHub Actions가 자동 배포한다. Actions의 `실서비스 배포 및 확인` 성공까지
   확인한다. 자동 배포를 쓸 수 없을 때만 `python3 tools/hf_deploy.py`를 실행한다.
   빠뜨리면 사용자는 계속 옛 엔진을 쓴다(2026-08-05, 구엔진 오탐 45건 재판정).
2. **IndexedDB 버전을 올리지 않는다.** 스토어를 추가하지 말고 기존 스토어의
   키를 쓴다. 버전 업그레이드는 다른 탭에 막혀 앱이 영구 정지한다(2026-08-31).
3. **보관함 목록(매니페스트)은 절대 줄어들 수 없다.** 서버 읽기 실패를
   "비었다"로 해석해 덮어쓰면 팀 전체의 목록이 사라진다(2026-08-31).
4. **`bench --accept`(기준선 승인)를 임의로 실행하지 않는다.** 사람이 결과를
   눈으로 확인한 뒤에만 승인한다. 자동 승인하면 안전망이 그냥 로그가 된다.
5. **실물 라벨 이미지를 커밋하지 않는다.** 의료기기 데이터다.
   `private/`, `feedback/`, `bench/out/` 은 .gitignore 대상이며 그대로 둔다.
6. **피드백을 반영했으면 상태를 찍는다.** `tools/feedback_status.py --done`
   안 찍으면 앱에서 '미확인'으로 남아 같은 건을 두 번 조사하게 된다.
7. **판정 기준은 앱 피드백 데이터로만 바꾼다.** 사용자에게 추가 판정을 먼저
   요청하지 않는다. 임계값은 `bench/cases/`의 실측 근거로 움직인다.

## 코드를 고친 뒤 반드시 하는 검증 (순서대로)

```bash
python -m pytest tests/ -v                    # 1. 회귀 테스트 (~13초)
python -m bench.run --fast --group guard      # 2. 오탐 감시 (~30초)
python -m bench.run                           # 3. 엔진을 고쳤다면 전체 (~6.5분)
cd web && npm test                            # 4. web/ 를 고쳤다면
# 5. 엔진/web 변경이면 main에 push → Actions의 배포 성공 확인
#    (자동 배포 불가 시에만 python3 tools/hf_deploy.py)
```

`bench`가 FAIL이면 `bench/out/report.md`에 무엇이 깨졌는지와 판정용 크롭이 있다.
FAIL을 무시하고 진행하지 않는다.

## 피드백을 반영했으면 상태를 동기화한다

사용자 피드백은 앱의 **피드백 페이지**에서 팀 전체가 함께 본다. 프롬프트로
피드백을 반영했는데 상태를 안 찍으면, 앱에서는 계속 '미확인'으로 남아 다른
사람이 같은 건을 또 조사한다.

```bash
python tools/feedback_status.py --list          # 미확인 건 보기 (id 확인)
python tools/feedback_status.py --list --all    # 처리된 건까지 전부
python tools/feedback_status.py --done <id> …   # 반영을 마쳤으면 확인 표시
```

앱의 확인/미확인 토글과 **같은 저장소**를 쓴다 — 여기서 찍으면 앱에 바로 보인다.
인증은 없다(2026-09-02 제거). 비밀번호를 묻는 코드를 다시 넣지 말 것.

피드백 처리의 정해진 순서:

1. `--list` 로 미확인 건과 id 를 확인한다.
2. 지적 내용(`cause`, `comment`)을 읽고 원인을 조사한다.
3. 필요하면 `python -m bench.import_feedback` 로 케이스를 만들어 계약으로 굳힌다.
4. 엔진을 고치고 위의 검증 절차를 통과시킨다.
5. `main`에 커밋·push하고 GitHub Actions의 자동 배포 성공을 확인한다
   (자동 배포 불가 시에만 `tools/hf_deploy.py`).
6. **`--done <id>` 로 상태를 찍는다.** 여기까지가 한 세트다.

고치지 않기로 판단한 건(구조적 한계 등)도 `--done` 으로 닫되, 왜 닫는지를
사용자에게 먼저 설명하고 동의를 받는다. 조사 없이 닫지 않는다.

## 파일 지도

| 경로 | 무엇 |
|---|---|
| `web/src/pipeline/` | 브라우저판 검사 엔진 (실제 서비스되는 로직) |
| `web/src/App.tsx`, `components.tsx` | 화면·버튼·문구 |
| `web/src/pipeline/config.ts` | 브라우저판 임계값 |
| `compare_artwork.py` | Python 참조 엔진 + 임계값(`Config`) |
| `bench/` | 정확도 안전망(케이스·기준선·게이트) |
| `tools/hf_deploy.py` | 배포 (빌드 → 업로드 → 실서비스 지문 검증) |
| `tools/feedback_status.py` | 피드백 처리 상태를 앱 피드백 페이지와 동기화 |
| `web/public/handover.html` | 인수인계서 (사이트 안에서 열리는 사용 설명서) |
| `webapp.py` | 사내망 서빙 + 피드백 수집 |
| `docs/` | 설계 조사 기록 |

## 커밋

한국어로 쓴다. `타입(범위): 무엇을 왜` 형식.
예: `fix(web): 빈 매니페스트로 서버 목록을 덮어쓰던 동기화 사고 차단`

`git config core.hooksPath hooks` 가 설정돼 있으면 엔진·케이스를 건드린 커밋에서
자동으로 오탐 감시가 돈다(약 30초).

## 하지 말 것

- 임계값을 "감으로" 바꾸기 — 근거(실측 케이스)가 없으면 바꾸지 않는다.
- 결함 판정에 LLM을 끼워넣기 — 결정론 파이프라인이 단독으로 동작해야 한다.
- `bench/baseline.json`을 직접 편집 — `--accept`로만 갱신한다.
- 대규모 리팩터링 — 요청받은 범위만 고친다.

#!/bin/bash
# 인쇄 검수 지원 서버 시작 스크립트 (launchd가 로그인 시 자동 실행)
# 역할: 브라우저판 정적 서빙(/app/) + 피드백 수집(/feedback). 분석은 브라우저가 한다.
#
# --host 0.0.0.0: 같은 네트워크에서 http://<IP>:8501/app/ 접속 가능
# 외부 공개는 리버스 프록시/터널 등 배포 환경에 맞게 별도 구성
set -e
cd "$(dirname "$0")"

# macOS면 잠자기 방지(caffeinate) 포함
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -is python3 webapp.py --host 0.0.0.0 --port "${PORT:-8501}"
else
  exec python3 webapp.py --host 0.0.0.0 --port "${PORT:-8501}"
fi

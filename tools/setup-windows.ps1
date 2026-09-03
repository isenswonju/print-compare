<#
  인쇄 검수 도구 — Windows 초기 세팅
  압축을 푼 폴더에서 "설치.bat" 을 더블클릭하면 이 스크립트가 실행된다.
  여러 번 실행해도 안전하다(이미 된 것은 건너뛴다).
#>

$ErrorActionPreference = "Continue"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ok = @(); $warn = @(); $fail = @()

function Head($t) {
  Write-Host ""
  Write-Host ("=" * 62) -ForegroundColor DarkGray
  Write-Host "  $t" -ForegroundColor Cyan
  Write-Host ("=" * 62) -ForegroundColor DarkGray
}
function Has($c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }
function TryWinget($id, $label) {
  if (-not (Has "winget")) { return $false }
  Write-Host "  $label 을(를) 자동 설치합니다. 몇 분 걸립니다..." -ForegroundColor Yellow
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
  # 방금 설치한 것을 이 창에서 바로 쓰려면 PATH 를 다시 읽어야 한다
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
  return $true
}

Write-Host ""
Write-Host "  인쇄 검수 도구 — 초기 세팅" -ForegroundColor White
Write-Host "  폴더: $Root" -ForegroundColor DarkGray

# ----------------------------------------------------------- 1. Git + GitHub
Head "1/8  Git과 GitHub (저장·자동 배포에 필요)"
if (-not (Has "git")) { TryWinget "Git.Git" "Git" | Out-Null }
if (-not (Has "gh"))  { TryWinget "GitHub.cli" "GitHub 로그인 도구" | Out-Null }
if (Has "git") { $ok += "Git $(git --version)" }
else { $fail += "Git — 설치.bat 을 한 번 더 실행하세요." }
if (Has "gh") {
  gh auth status --hostname github.com 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  GitHub 브라우저 로그인이 열립니다. 회사 계정으로 승인하세요." -ForegroundColor Yellow
    gh auth login --hostname github.com --git-protocol https --web
  }
  gh auth status --hostname github.com 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok += "GitHub 로그인" }
  else { $fail += "GitHub 로그인 — 브라우저 승인을 마친 뒤 설치.bat 을 다시 실행하세요." }
} else { $fail += "GitHub 로그인 도구 — 설치.bat 을 한 번 더 실행하세요." }

# ---------------------------------------------------------------- 2. Node.js
Head "2/8  Node.js (앱을 빌드하는 데 필요)"
if (Has "node") {
  $v = (node -v)
  Write-Host "  이미 설치됨: $v" -ForegroundColor Green
  $ok += "Node.js $v"
} else {
  if (-not (TryWinget "OpenJS.NodeJS.LTS" "Node.js")) {
    Write-Host "  자동 설치를 못 했습니다." -ForegroundColor Red
  }
  if (Has "node") { $ok += "Node.js $(node -v)" }
  else {
    $fail += "Node.js — https://nodejs.org 에서 LTS 버전을 직접 받아 설치한 뒤 이 파일을 다시 실행하세요."
    Write-Host "  https://nodejs.org 에서 LTS 를 설치한 뒤 다시 실행하세요." -ForegroundColor Red
  }
}

# ------------------------------------------------------------------ 3. Python
Head "3/8  Python 3.12 (정확도 검사와 배포에 필요)"
$py = $null
$launcher = Get-Command py -ErrorAction SilentlyContinue
if ($launcher) {
  $candidate = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $candidate) { $py = "$candidate".Trim() }
}
if (-not $py -and (Has "python")) {
  $candidate = & python -c "import sys; print(sys.executable if sys.version_info[:2] == (3,12) else '')" 2>$null
  if ($candidate) { $py = "$candidate".Trim() }
}
if ($py) {
  $v = (& $py --version 2>&1)
  Write-Host "  이미 설치됨: $v" -ForegroundColor Green
  $ok += "$v"
} else {
  if (-not (TryWinget "Python.Python.3.12" "Python")) {
    Write-Host "  자동 설치를 못 했습니다." -ForegroundColor Red
  }
  if (Has "py") {
    $candidate = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $candidate) { $py = "$candidate".Trim() }
  }
  if ($py) { $ok += (& $py --version 2>&1) }
  else {
    $fail += "Python — https://www.python.org/downloads/ 에서 설치(설치 화면의 'Add to PATH' 를 반드시 체크)"
    Write-Host "  https://www.python.org/downloads/ 에서 설치하세요." -ForegroundColor Red
    Write-Host "  설치 첫 화면의 'Add python.exe to PATH' 를 꼭 체크해야 합니다." -ForegroundColor Yellow
  }
}

# -------------------------------------------------------------------- 4. Codex
Head "4/8  Codex (대화로 코드를 고쳐주는 도구)"
if (Has "codex") {
  Write-Host "  이미 설치됨: $(codex --version 2>&1)" -ForegroundColor Green
  $ok += "Codex"
} elseif (Has "npm") {
  Write-Host "  설치 중... (몇 분 걸립니다)" -ForegroundColor Yellow
  cmd /c "npm install -g @openai/codex" 2>&1 | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path","User")
  if (Has "codex") { Write-Host "  설치 완료" -ForegroundColor Green; $ok += "Codex" }
  else { $fail += "Codex — 창을 닫고 설치.bat 을 한 번 더 실행해 보세요." }
} else {
  $fail += "Codex — Node.js 가 먼저 설치돼야 합니다."
}
if (Has "codex") {
  codex login status 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  Codex 브라우저 로그인이 열립니다. 담당자 개인 계정도 괜찮습니다." -ForegroundColor Yellow
    codex login
  }
  codex login status 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok += "Codex 로그인" }
  else { $warn += "Codex 로그인 — 시작.bat 실행 후 로그인 안내를 따라도 됩니다." }
}

# ------------------------------------------------------- 4. 앱 빌드용 라이브러리
Head "5/8  앱 라이브러리 (web 폴더)"
if (Has "npm") {
  if (Test-Path (Join-Path $Root "web\node_modules")) {
    Write-Host "  이미 설치됨 (건너뜀)" -ForegroundColor Green
    $ok += "앱 라이브러리"
  } else {
    Write-Host "  설치 중... 용량이 커서 5~10분 걸릴 수 있습니다." -ForegroundColor Yellow
    Push-Location (Join-Path $Root "web")
    cmd /c "npm ci" 2>&1 | Select-Object -Last 3
    Pop-Location
    if (Test-Path (Join-Path $Root "web\node_modules")) {
      Write-Host "  설치 완료" -ForegroundColor Green; $ok += "앱 라이브러리"
    } else { $fail += "앱 라이브러리 — web 폴더에서 npm install 이 실패했습니다." }
  }
} else { $fail += "앱 라이브러리 — Node.js 가 먼저 설치돼야 합니다." }

# -------------------------------------------------- 5. 파이썬 라이브러리
Head "6/8  검사 엔진 라이브러리 (파이썬)"
if ($py) {
  Write-Host "  설치 중... 몇 분 걸립니다." -ForegroundColor Yellow
  & $py -m pip install --upgrade pip --quiet 2>&1 | Out-Null
  & $py -m pip install -r (Join-Path $Root "requirements.txt") --quiet 2>&1 | Select-Object -Last 5
  $chk = & $py -c "import cv2, numpy, pypdfium2; print('ok')" 2>&1
  if ("$chk" -match "ok") {
    Write-Host "  설치 완료" -ForegroundColor Green; $ok += "검사 엔진 라이브러리"
  } else {
    $fail += "파이썬 라이브러리 — 설치가 끝나지 않았습니다. 설치.bat 을 한 번 더 실행해 보세요."
    Write-Host "  $chk" -ForegroundColor Red
  }
} else { $fail += "파이썬 라이브러리 — Python 이 먼저 설치돼야 합니다." }

# ------------------------------------------------------------- 7. 저장소 연결
Head "7/8  회사 저장소와 자동 배포 확인"
if (Has "git") {
  git config core.hooksPath hooks
  git remote set-url origin https://github.com/isenswonju/print-compare.git 2>$null
  git config user.name isenswonju
  git config user.email isenswonju@gmail.com
  Write-Host "  저장 전 자동 검사를 켰습니다." -ForegroundColor Green
  $ok += "저장 전 자동 검사"
} else {
  $warn += "Git 이 없습니다 — 되돌리기와 저장 이력 기능을 쓰려면 https://git-scm.com 에서 설치하세요."
}
if (Has "gh") {
  gh repo view isenswonju/print-compare --json nameWithOwner 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok += "회사 GitHub 저장소 접근" }
  else { $fail += "GitHub 저장소 접근 — 회사 계정에 isenswonju/print-compare 권한이 필요합니다." }
  $secrets = gh secret list --repo isenswonju/print-compare 2>$null
  if ($secrets -match "(?m)^HF_TOKEN\s" -and
      $secrets -match "(?m)^VERCEL_TOKEN\s") { $ok += "자동 배포 토큰(Hugging Face·Vercel)" }
  else { $fail += "자동 배포 토큰 — GitHub Actions secrets에 HF_TOKEN과 VERCEL_TOKEN이 모두 필요합니다." }
}

# ------------------------------------------------------------- 8. 마무리 확인
Head "8/8  실행 준비 확인"
if ((Test-Path (Join-Path $Root "AGENTS.md")) -and
    (Test-Path (Join-Path $Root ".github\workflows\verify-and-deploy.yml"))) {
  $ok += "프로젝트 규칙과 자동 배포 워크플로우"
} else { $fail += "프로젝트 파일이 빠졌습니다 — 압축을 다시 받아 푸세요." }
if (-not (Has "tesseract")) {
  $warn += "글자 인식(OCR) 프로그램이 없습니다. 앱 사용에는 지장이 없고, 파이썬 쪽 전체 정확도 검사에만 필요합니다. 필요해지면 Codex 에게 'tesseract 설치 방법 알려줘' 라고 물어보세요."
}

# ------------------------------------------------------------------- 결과 요약
Write-Host ""
Write-Host ("=" * 62) -ForegroundColor DarkGray
Write-Host "  결과" -ForegroundColor White
Write-Host ("=" * 62) -ForegroundColor DarkGray
foreach ($i in $ok)   { Write-Host "  [완료] $i" -ForegroundColor Green }
foreach ($i in $warn) { Write-Host "  [참고] $i" -ForegroundColor Yellow }
foreach ($i in $fail) { Write-Host "  [필요] $i" -ForegroundColor Red }

Write-Host ""
if ($fail.Count -eq 0) {
  Write-Host "  세팅이 끝났습니다." -ForegroundColor Green
  Write-Host ""
  Write-Host "  인수인계 세팅이 모두 끝났습니다." -ForegroundColor White
  Write-Host "   앞으로는 '시작.bat'만 더블클릭하면 됩니다."
  Write-Host "   인수인계서(사용법)는 아래 주소에 있습니다:"
  Write-Host "      https://i-sens-print-compare.static.hf.space/handover.html" -ForegroundColor Cyan
} else {
  Write-Host "  [필요] 항목을 처리한 뒤 '설치.bat' 을 다시 실행하세요." -ForegroundColor Yellow
}
Write-Host ""

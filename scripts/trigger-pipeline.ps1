<#
.SYNOPSIS
  Запускает CI/CD pipeline в GitLab без участия владельца репозитория.

.DESCRIPTION
  Делает POST /api/v4/projects/<id>/trigger/pipeline. Этот endpoint
  не требует SSO/верификации аккаунта запускающего: достаточно одного
  trigger-token'а, который владелец проекта создаёт один раз в
  Settings → CI/CD → Pipeline trigger tokens. После этого любой, у кого
  есть токен, может пинать pipeline через API без UI-кнопок.

  Полезно, когда:
    - твой GitLab-аккаунт не верифицирован (free tier требует phone +
      payment-метод для запуска CI), а у владельца проекта верификация
      пройдена;
    - хочется триггерить деплой из локального скрипта вместо клика
      «Run pipeline» в браузере;
    - нужна автоматизация (cron, post-merge hook и т.п.).

  Что скрипт делает по шагам:
    1. Резолвит PROJECT_ID:
         a) -ProjectId параметр (приоритет 1)
         b) env $env:OWNCORD_GITLAB_PROJECT_ID (приоритет 2)
         c) GITLAB_PROJECT_ID из локального .gitlab-trigger-token (приоритет 3)
         d) автоматически через GET /projects/<urlencoded namespace/repo>
            (резолвится из git remote 'gitlab').
    2. Резолвит trigger-token:
         a) -Token параметр (приоритет 1)
         b) env $env:OWNCORD_GITLAB_TRIGGER_TOKEN (приоритет 2)
         c) GITLAB_TRIGGER_TOKEN из локального .gitlab-trigger-token (приоритет 3)
    3. Делает POST с указанным -Ref (default: main) и опциональными
       CI-переменными (-Variable @{KEY="value"}).
    4. Печатает id, status, web_url созданного pipeline. С -OpenInBrowser
       сразу открывает страницу pipeline'а в системном браузере.

  ВАЖНО: pipeline в .gitlab-ci.yml ограничен правилом
    if: '$CI_COMMIT_BRANCH == "main" && $CI_PIPELINE_SOURCE != "merge_request_event"'
  То есть API-trigger создаст pipeline только на ref=main (что и есть
  default). Для других веток нужно либо ослаблять workflow.rules, либо
  не ждать что что-то запустится.

.PARAMETER Ref
  Branch/tag, на котором запустить pipeline. Default: main.

.PARAMETER Token
  Trigger-token. Если не задан — читается из env / .gitlab-trigger-token.

.PARAMETER ProjectId
  Численный GitLab project ID. Если не задан — резолвится автоматически.

.PARAMETER Variable
  Hashtable дополнительных CI-переменных, которые попадут в pipeline
  как обычные `$VARS`. Например: -Variable @{FORCE_REBUILD="1"; ENV="prod"}.

.PARAMETER OpenInBrowser
  Сразу открыть web_url созданного pipeline в браузере.

.EXAMPLE
  # Дефолт: триггерим main, токен и id берутся из .gitlab-trigger-token
  .\scripts\trigger-pipeline.ps1

.EXAMPLE
  # С явным токеном и переменной
  .\scripts\trigger-pipeline.ps1 -Token "glptt-..." -Variable @{FOO="bar"}

.EXAMPLE
  # И сразу открываем pipeline в браузере
  .\scripts\trigger-pipeline.ps1 -OpenInBrowser

.NOTES
  Безопасность:
    - trigger-token = секрет. Кто его получит, сможет вызывать deploy
      на твой сервер столько раз, сколько хочет (хотя задеплоит он
      ровно тот код, что уже в main — никаких произвольных команд).
    - .gitlab-trigger-token обязан быть в .gitignore (есть).
    - Если токен утёк — отзови его в GitLab: Settings → CI/CD →
      Pipeline trigger tokens → корзина рядом с токеном.
#>

[CmdletBinding()]
param(
    [string]$Ref = "main",
    [string]$Token = "",
    [string]$ProjectId = "",
    [hashtable]$Variable = @{},
    [switch]$OpenInBrowser
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

# --- 0. Пути --------------------------------------------------------------
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot = Resolve-Path (Join-Path $ScriptRoot "..")
$TokenFile = Join-Path $RepoRoot ".gitlab-trigger-token"

# --- 1. Парсим .gitlab-trigger-token (KEY=VALUE построчно) ----------------
# Формат файла специально простой, чтобы не тащить ради него .env-парсер.
# Пустые строки и строки, начинающиеся с #, игнорируем. Значение может
# содержать = (берём первое вхождение как разделитель).
$ConfigPairs = @{}
if (Test-Path $TokenFile) {
    Get-Content $TokenFile | ForEach-Object {
        $line = $_.Trim()
        if (!$line -or $line.StartsWith("#")) { return }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { return }
        $k = $line.Substring(0, $eq).Trim()
        $v = $line.Substring($eq + 1).Trim()
        $ConfigPairs[$k] = $v
    }
}

# --- 2. Резолв PROJECT_ID -------------------------------------------------
if (-not $ProjectId) { $ProjectId = $env:OWNCORD_GITLAB_PROJECT_ID }
if (-not $ProjectId -and $ConfigPairs.ContainsKey('GITLAB_PROJECT_ID')) {
    $ProjectId = $ConfigPairs['GITLAB_PROJECT_ID']
}

if (-not $ProjectId) {
    Write-Step "Резолвим PROJECT_ID через git remote → GitLab API"

    $remoteUrl = ""
    try {
        $remoteUrl = (& git -C "$RepoRoot" config --get remote.gitlab.url) 2>$null
    } catch { $remoteUrl = "" }

    if (-not $remoteUrl) {
        # fallback: пробуем 'origin', если remote 'gitlab' не настроен
        try {
            $originUrl = (& git -C "$RepoRoot" config --get remote.origin.url) 2>$null
            if ($originUrl -match 'gitlab\.com') { $remoteUrl = $originUrl }
        } catch { }
    }

    if (-not $remoteUrl) {
        throw "Не нашёл git remote, указывающий на gitlab.com. Задай -ProjectId явно или впиши GITLAB_PROJECT_ID в $TokenFile."
    }

    if ($remoteUrl -match 'gitlab\.com[:/](.+?)(\.git)?$') {
        $projectPath = $Matches[1]
        $encoded = [System.Uri]::EscapeDataString($projectPath)
        Write-Host "  remote: $remoteUrl"
        Write-Host "  path:   $projectPath"
        try {
            $resp = Invoke-RestMethod `
                -Uri "https://gitlab.com/api/v4/projects/$encoded" `
                -Method Get `
                -ErrorAction Stop
            $ProjectId = "$($resp.id)"
            Write-Host "  id:     $ProjectId" -ForegroundColor Green
        } catch {
            $msg = $_.Exception.Message
            throw @"
Не удалось получить PROJECT_ID через публичное API ($msg).
Возможные причины:
  - репозиторий приватный (тогда GET требует Personal Access Token);
  - сетевой блок / прокси.
Способы решения:
  1) В GitLab: Settings → General → Project ID. Скопируй число.
  2) Добавь его в $TokenFile в формате:
       GITLAB_PROJECT_ID=12345678
  3) Или передай -ProjectId 12345678 при запуске.
"@
        }
    } else {
        throw "Не смог распарсить gitlab remote URL: $remoteUrl"
    }
}

# --- 3. Резолв trigger-токена --------------------------------------------
if (-not $Token) { $Token = $env:OWNCORD_GITLAB_TRIGGER_TOKEN }
if (-not $Token -and $ConfigPairs.ContainsKey('GITLAB_TRIGGER_TOKEN')) {
    $Token = $ConfigPairs['GITLAB_TRIGGER_TOKEN']
}
if (-not $Token) {
    Write-Host ""
    Write-Host "Trigger-токен не найден. Задай его одним из способов:" -ForegroundColor Yellow
    Write-Host "  1) Параметром: -Token <значение>"
    Write-Host "  2) Env (на сессию):"
    Write-Host "       `$env:OWNCORD_GITLAB_TRIGGER_TOKEN = 'glptt-...'"
    Write-Host "  3) Положи в файл $TokenFile строку:"
    Write-Host "       GITLAB_TRIGGER_TOKEN=glptt-..."
    Write-Host ""
    Write-Host "Создать токен: GitLab → Settings → CI/CD → Pipeline trigger tokens → Add new token."
    throw "Нет trigger-токена."
}

# --- 4. POST trigger ------------------------------------------------------
Write-Step "POST /api/v4/projects/$ProjectId/trigger/pipeline (ref=$Ref)"

# Используем application/x-www-form-urlencoded (Invoke-RestMethod так и
# отправит hashtable по умолчанию). GitLab принимает обе формы — и
# multipart, и urlencoded — но urlencoded работает в любой версии PS,
# а multipart (-Form) появился только в PowerShell 6+.
$body = @{
    token = $Token
    ref = $Ref
}
foreach ($k in $Variable.Keys) {
    # GitLab API: ключи передаются как 'variables[KEY]'.
    $body["variables[$k]"] = "$($Variable[$k])"
}

try {
    $resp = Invoke-RestMethod `
        -Uri "https://gitlab.com/api/v4/projects/$ProjectId/trigger/pipeline" `
        -Method Post `
        -Body $body `
        -ErrorAction Stop
} catch {
    # Пытаемся вытащить тело ответа — GitLab кладёт туда понятный JSON
    # с message.* при, например, неверном токене или несовместимом ref.
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $msg = "$msg`n  body: $($_.ErrorDetails.Message)"
    }
    throw "Pipeline не запустился: $msg"
}

# --- 5. Отчёт -------------------------------------------------------------
Write-Host ""
Write-Host "Pipeline создан:" -ForegroundColor Green
Write-Host "  id:      $($resp.id)"
Write-Host "  status:  $($resp.status)"
Write-Host "  ref:     $($resp.ref)"
Write-Host "  sha:     $($resp.sha)"
Write-Host "  url:     $($resp.web_url)" -ForegroundColor Cyan

if ($OpenInBrowser -and $resp.web_url) {
    Start-Process $resp.web_url
}

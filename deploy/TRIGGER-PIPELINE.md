# Запуск GitLab pipeline без UI

GitLab Free на новых аккаунтах требует верификацию (телефон + payment-метод)
для запуска CI вручную. Если ты — со-разработчик, у которого верификация
не пройдена, кликать «Run pipeline» в UI ты не сможешь.

**Обходной путь** — **Pipeline trigger token**: владелец проекта (с
верифицированным аккаунтом) создаёт один токен в Settings → CI/CD →
Pipeline trigger tokens, и любой держатель этого токена может пинать
pipeline через REST API без какой-либо проверки аккаунта.

```
[локальная машина]  ─── POST /api/v4/projects/<id>/trigger/pipeline ──▶  [gitlab.com]
                                                                              │
                                                                              ▼
                                                                       создаётся pipeline
                                                                       на ref=main (наш CI),
                                                                       deploy-job вызывает
                                                                       owncord-deploy.sh
                                                                       на сервере
```

## Один раз настроить

1. Попроси владельца проекта зайти в **GitLab → Settings → CI/CD →
   Pipeline trigger tokens → Add new token**, дать ему любое имя
   (например `owncord-cli`) и **скопировать** значение. Токены
   начинаются с `glptt-` и показываются **только один раз**.

2. Скопируй у себя локально:

   ```
   cp .gitlab-trigger-token.example .gitlab-trigger-token
   ```

   (на Windows в pwsh: `Copy-Item .gitlab-trigger-token.example .gitlab-trigger-token`)

3. Открой `.gitlab-trigger-token` и впиши:

   ```
   GITLAB_TRIGGER_TOKEN=glptt-xxxxxxxxxxxxxxxxxxxx
   # GITLAB_PROJECT_ID=12345678   ← опционально, см. ниже
   ```

   Файл уже в `.gitignore` — git его не увидит.

4. **PROJECT_ID** скрипт обычно резолвит сам через
   `GET /api/v4/projects/<namespace%2Frepo>`. Если репо приватный (а
   у нас это так), public-API вернёт 404 → раскомментируй
   `GITLAB_PROJECT_ID` в файле и впиши число из **GitLab → Settings →
   General → Project ID**.

## Каждый раз запускать

```pwsh
npm run deploy:trigger
```

Или напрямую:

```pwsh
powershell -ExecutionPolicy Bypass -File scripts/trigger-pipeline.ps1
```

С опциями:

```pwsh
# Триггерим pipeline на другой ветке (нужно ослабить workflow.rules в CI):
.\scripts\trigger-pipeline.ps1 -Ref hotfix/foo

# Передаём CI-переменные:
.\scripts\trigger-pipeline.ps1 -Variable @{FORCE_REBUILD = "1"; ENV = "prod"}

# Сразу открыть страницу pipeline в браузере после запуска:
.\scripts\trigger-pipeline.ps1 -OpenInBrowser
```

После успешного запуска скрипт выводит:

```
Pipeline создан:
  id:      123456789
  status:  created
  ref:     main
  sha:     abcdef123…
  url:     https://gitlab.com/startsevkirill010101/OwnCord/-/pipelines/123456789
```

Кликнув по url, ты увидишь job-логи в реальном времени.

## Ограничения

- Наш `.gitlab-ci.yml` запускает pipeline **только** на `main` (см.
  `workflow.rules` там же). Если триггеришь любой другой ref —
  GitLab примет запрос, но job'ы не создадутся, и pipeline быстро
  завершится в статусе `skipped`. Это не баг, это правило CI.

- Trigger-token **не имеет ограничений по веткам**. То есть им можно
  пинать pipeline на любой ref (если бы `workflow.rules` это позволял).

- Деплой-job выполняет ровно то, что лежит **в `main` в момент
  запуска**: токен не даёт право выполнить произвольные команды на
  сервере, только повторить уже-merge'нутый deploy.

## Безопасность токена

- Никогда не коммить `.gitlab-trigger-token` (`.gitignore` это уже
  блокирует, но всё равно перед `git add .` проверяй `git status`).
- Не выкладывай токен в чаты/issues/скриншоты.
- Если подозреваешь утечку — **сразу отзови**: GitLab → Settings →
  CI/CD → Pipeline trigger tokens → значок корзины рядом с токеном,
  затем создай новый и обнови `.gitlab-trigger-token`.
- Токены можно ротировать «бесшовно»: создай новый, замени локально,
  удали старый — pipeline'ы в процессе не пострадают.

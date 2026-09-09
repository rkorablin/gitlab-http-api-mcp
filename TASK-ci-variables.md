# Постановка: Project / Group CI/CD variables CRUD

> **Статус:** выполнено (tools + docs + smoke; v0.2.6).  
> **Не** коммитить в `cubekit-v2-common-general`.  
> **Контекст потребителя:** Cubekit v2 audit follow-up CUBV2-962/963 (и аналоги) — вынести plaintext develop passwords из `.gitlab-ci.yml` в GitLab **masked** CI/CD variables (как уже сделано для `CUBV2_STAGING_*`). Сейчас агент **не может** создать/обновить group/project variables через MCP → human gate или ad-hoc curl.

## Зачем

1. List / get / create / update / delete **persistent** CI/CD variables (Settings → CI/CD → Variables), не путать с one-shot `variables` у `gitlab_create_pipeline` (это только body на trigger pipeline).
2. Поддержать **project** и **group** scope (Cubekit: vars уровня группы `cubekit-v2`, как staging).
3. Masked / protected / raw / environment_scope — как в GitLab API.
4. Idempotent upsert для агентного сценария: «убедись что var есть с нужными флагами».

Docs GitLab:
- [Project-level CI/CD variables API](https://docs.gitlab.com/ee/api/project_level_variables.html)
- [Group-level CI/CD variables API](https://docs.gitlab.com/ee/api/group_level_variables.html)

Стиль — как в `server.mjs` (`glFetch`, `encodeProjectId` / path encode, `jsonContent`). Для group — encode group path (`cubekit-v2` → `cubekit-v2`).

## Проверка «чего нет сейчас» (2026-09-09)

В живом MCP `gitlab` (npx/`~/ai/gitlab-http-api-mcp` server.mjs) **нет** tools с `variable` в имени, кроме ephemeral `variables` у `gitlab_create_pipeline`.  
В прошлых TASK явно out of scope: `TASK-job-token-scope-allowlist.md` § Scope (out) — «DEPLOY_TOKEN / CI variables CRUD».

## Scope (in)

Минимум — **project** + **group** зеркала. Naming:

| Tool | HTTP |
|------|------|
| `gitlab_list_project_variables` | `GET /projects/:id/variables` |
| `gitlab_get_project_variable` | `GET /projects/:id/variables/:key` |
| `gitlab_create_project_variable` | `POST /projects/:id/variables` |
| `gitlab_update_project_variable` | `PUT /projects/:id/variables/:key` |
| `gitlab_delete_project_variable` | `DELETE /projects/:id/variables/:key` |
| `gitlab_list_group_variables` | `GET /groups/:id/variables` |
| `gitlab_get_group_variable` | `GET /groups/:id/variables/:key` |
| `gitlab_create_group_variable` | `POST /groups/:id/variables` |
| `gitlab_update_group_variable` | `PUT /groups/:id/variables/:key` |
| `gitlab_delete_group_variable` | `DELETE /groups/:id/variables/:key` |

### Общие параметры

| Параметр | Тип | Обяз. | Где | Описание |
|----------|-----|-------|-----|----------|
| `project_id` / `group_id` | string | да | list/get/create/update/delete | ID или path (`cubekit-v2/console/…` / `cubekit-v2`) |
| `key` | string | да | get/update/delete; create body | Имя переменной |
| `value` | string | да | create; update если меняем | Значение (**не** логировать в MCP response целиком при masked — см. ниже) |
| `variable_type` | string | нет | create/update | `env_var` (default) \| `file` |
| `protected` | boolean | нет | create/update | только protected branches/tags |
| `masked` | boolean | нет | create/update | masked in job log |
| `raw` | boolean | нет | create/update | expand `$` или нет |
| `environment_scope` | string | нет | create/update/get/list filter | default `*` |
| `description` | string | нет | create/update | если инстанс поддерживает |
| `filter[environment_scope]` | string | нет | get/update/delete при дубликатах key+scope | как в GitLab API |
| `page` / `per_page` | number | нет | list | пагинация |

### Поведение

- **create:** 201 → вернуть metadata (`key`, `protected`, `masked`, `raw`, `environment_scope`, `variable_type`); **value** в ответе — как отдаёт GitLab (обычно есть); в error text не дублировать value.
- **create при уже существующем key+scope:** либо вернуть понятный 400/409, либо рекомендовать `update` / отдельный upsert tool.
- **Желательно (тот же PR):** `gitlab_upsert_project_variable` / `gitlab_upsert_group_variable` — get → create или update; идемпотентно для агента.
- **list:** по умолчанию можно **не** возвращать `value` (или возвращать только если `include_values: true`), чтобы агент случайно не светил секреты в чат. Metadata всегда. Для get — value нужен sparingly; документировать риск.
- **delete:** 204 → `{ ok: true, key }`; отсутствие — idempotent `{ ok: true, already_absent: true }` или явный 404.
- **403/404** — понятный текст (нужен scope `api` + Maintainer/Owner на group/project).

### Безопасность (обязательно в README)

- Tools пишут секреты — только с явным намерением пользователя/задачи.
- Не печатать `value` в `console.error` / trace MCP.
- Masked vars в GitLab имеют ограничения на charset/length — при 400 от GitLab пробрасывать body ошибки.

## Scope (out)

- Instance-level variables.
- Rotation паролей в Postgres / Vault — потребитель.
- Массовый import из `.gitlab-ci.yml` — не в MCP; агент вызывает upsert в цикле.
- Changing pipeline schedule variables (отдельный API) — не сейчас.

## Типичный сценарий Cubekit (после publish)

Group `cubekit-v2`, masked+protected vars (значения = текущие plaintext из develop CI, без ротации в том же шаге):

- `CUBV2_DEVELOP_PG_IAM_PASSWORD`
- `CUBV2_DEVELOP_IAM_INITIAL_PASSWORD`
- `CUBV2_DEVELOP_BFF_SERVICE_PASSWORD`
- `CUBV2_DEVELOP_IAM_MFA_SECRET`
- `CUBV2_DEVELOP_PG_PLATFORM_PASSWORD`
- `CUBV2_DEVELOP_PG_ADMIN_PASSWORD`

Затем consumer-задачи CUBV2-962/963 правят `.gitlab-ci.yml` на `$CUBV2_DEVELOP_*`.

## DoD

- [x] Tools в `ListTools` + handlers в `server.mjs` (project + group CRUD; upsert желателен)
- [x] README + `ONBOARDING_PROMPT.md` обновлены (отделить от `gitlab_create_pipeline.variables`)
- [x] Smoke на **тестовом** group/project (не prod Cubekit без запроса): create masked → list → get → update → delete; upsert идемпотентен
- [x] bump `package.json` patch + готовность `npm publish`
- [x] В ответе агенту: версия пакета + как подтянуть (`npx …@latest` / local `GITLAB_HTTP_API_MCP_HOME`)

## После merge / publish

1. `npm publish` (или локальный `server.mjs` через `GITLAB_HTTP_API_MCP_HOME`).
2. Перезапуск Cursor MCP `gitlab`.
3. Можно снимать human-gate с CUBV2-962/963: агент upsert group vars → MR на `.gitlab-ci.yml`.

## Ссылки

- Предыдущий прецедент out-of-scope: `TASK-job-token-scope-allowlist.md`
- YouTrack потребители: CUBV2-962, CUBV2-963 (parent CUBV2-949 / audit CUBV2-947)

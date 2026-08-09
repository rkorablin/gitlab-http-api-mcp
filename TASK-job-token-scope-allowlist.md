# Постановка: CI job token scope / inbound allowlist

> **Статус:** выполнено (tools + docs + smoke; published v0.2.5).  
> **Не** коммитить в `cubekit-v2-common-general`.  
> **Контекст потребителя:** Cubekit v2 `cubekit-v2-common-system-tests` тянет registry-образы deployable через `CI_JOB_TOKEN`; без inbound allowlist на целевом проекте — `pull access denied`. Сейчас агент чинит allowlist через Shell/`curl` + PAT; нужен MCP.

## Зачем

1. Аудитить inbound job-token allowlist проекта (кто может ходить в проект/`read_registry` с чужим `CI_JOB_TOKEN`).  
2. Добавлять / снимать проект (и опционально группу) в allowlist **без** ручного UI и без ad-hoc curl.  
3. Типичный сценарий Cubekit: на каждом deployable (`auth-service`, `orm-*`, `public-host`, …) разрешить `common/cubekit-v2-common-system-tests`.

Стиль — как в `server.mjs` (`glFetch`, `encodeProjectId` / `projPath`, `jsonContent`).

Docs GitLab: [Job token scope API](https://docs.gitlab.com/ee/api/project_job_token_scopes.html)  
(пути: `/projects/:id/job_token_scope`, `…/allowlist`, `…/groups_allowlist`).

## Scope (in)

### 1. `gitlab_get_job_token_scope` (обязательно)

**HTTP:** `GET /projects/:id/job_token_scope`

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | ID или path целевого проекта (того, **в** который ходят с job token) |

**Ответ:** `{ inbound_enabled, outbound_enabled }` (как минимум).

### 2. `gitlab_list_job_token_allowlist` (обязательно)

**HTTP:** `GET /projects/:id/job_token_scope/allowlist`

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | Проект-владелец allowlist (deployable) |
| `page` / `per_page` | number | нет | Пагинация |

**Ответ:** массив проектов (`id`, `path_with_namespace`, …).  
Семантика: эти проекты **могут** использовать свой `CI_JOB_TOKEN` для доступа к `project_id`.

### 3. `gitlab_add_job_token_allowlist` (обязательно)

**HTTP:** `POST /projects/:id/job_token_scope/allowlist`  
Body: `{ "target_project_id": <number> }`

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | Проект-владелец (куда добавляем inbound) |
| `target_project_id` | number \| string | да | ID **или** path проекта-источника job token (агент: если string path — сначала resolve через `GET /projects/:path` → `id`) |

**Поведение:**
- 201 → `{ source_project_id, target_project_id }` (или как отдаёт инстанс).  
- Если запись уже есть — **idempotent OK** (200/201 или 409 → вернуть «already present», не валить сценарий).  
- 403/404 — понятный текст.

### 4. `gitlab_remove_job_token_allowlist` (обязательно)

**HTTP:** `DELETE /projects/:id/job_token_scope/allowlist/:target_project_id`

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | Владелец allowlist |
| `target_project_id` | number \| string | да | ID или path (path → resolve id) |

**Поведение:** 204 → `{ ok: true, … }`; отсутствие записи — idempotent OK или явный 404 в тексте.

### 5. Groups allowlist (желательно, тот же PR)

Зеркало project allowlist для групп:

| Tool | HTTP |
|------|------|
| `gitlab_list_job_token_groups_allowlist` | `GET …/job_token_scope/groups_allowlist` |
| `gitlab_add_job_token_groups_allowlist` | `POST …/groups_allowlist` body `{ target_group_id }` |
| `gitlab_remove_job_token_groups_allowlist` | `DELETE …/groups_allowlist/:target_group_id` |

Параметр `target_group_id`: number или path группы (resolve через Groups API при path).

## Scope (out)

- Массовый «прописать system-tests на все deployable Cubekit» — **не** в MCP; потребитель вызывает tools в цикле.  
- `DEPLOY_TOKEN` / CI variables CRUD.  
- Container Registry API (tag delete и т.п.).  
- Изменение `inbound_enabled` / `outbound_enabled` (patch scope) — только если понадобится follow-up; по умолчанию не трогать (на Cubekit уже `inbound_enabled: true`).

## Реальный прецедент (2026-08-09)

Падение CI system-tests: `pull access denied` на `…/cubekit-v2-auth-service` при login через `CI_JOB_TOKEN`.  
Allowlist был у старых console/platform/runtime/bff-app; **не** было у `auth-service`, `orm-meta`, `orm-data`, `public-host`.  
Фикс вручную: `POST …/allowlist` с `target_project_id=710` (system-tests) на каждый из четырёх.

## DoD

- [x] Tools в `ListTools` + handlers в `server.mjs` (минимум §1–4 + groups)  
- [x] README + `ONBOARDING_PROMPT.md`  
- [x] Smoke на **тестовом** проекте (не ломать prod Cubekit без запроса):  
  get scope → list → add dummy/test project → list contains → remove → list empty of that entry  
- [x] bump `package.json` patch + готовность npm publish  
- [x] Idempotent add/remove задокументированы

## Пример сценария потребителя (Cubekit)

```text
# Разрешить system-tests тянуть образ auth-service
1) gitlab_list_job_token_allowlist project_id=cubekit-v2/service/cubekit-v2-auth-service
2) gitlab_add_job_token_allowlist
     project_id=cubekit-v2/service/cubekit-v2-auth-service
     target_project_id=cubekit-v2/common/cubekit-v2-common-system-tests
3) gitlab_list_job_token_allowlist — verify path system-tests есть
# Повторить для остальных deployable registry
```

## Критерий приёмки

Из Cursor через MCP (без curl): list/add/remove inbound project allowlist; path→id resolve для `target_project_id`.

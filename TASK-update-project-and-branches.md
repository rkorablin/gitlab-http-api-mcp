# Постановка: update project + repository branches

> **Статус:** выполнено (tools + docs + smoke; publish npm — по процессу репо).  
> **Не** коммитить в `cubekit-v2-common-general` — канон Cubekit сюда не тащить.  
> **Контекст потребителя:** агенты Cubekit v2 (смена default branch `main`↔`develop` по политике веток); сейчас обходятся Shell/`glab`.

## Зачем

1. Менять **default branch** проекта через MCP (без CLI).  
2. Создавать ветку из `ref`, если её ещё нет (иначе `PUT default_branch` падает).  
3. (Опц.) листить ветки для verify.

Стиль реализации — как существующие tools в `server.mjs` (`glFetch`, `encodeProjectId` / `projPath`, `jsonContent`, регистрация в `ListTools`).

## Scope (in)

### 1. `gitlab_update_project` (обязательно)

**HTTP:** `PUT /projects/:id`  
Docs: [Edit project](https://docs.gitlab.com/ee/api/projects.html#edit-project)

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `id` | string | да | Project ID или path (`cubekit-v2/common/cubekit-v2-common-general`) |
| `default_branch` | string | нет* | Имя ветки; ветка **должна уже существовать** |
| `description` | string | нет | Опционально |
| `name` | string | нет | Опционально (осторожно) |

\* Хотя бы одно optional-поле должно быть передано. Для Cubekit минимум — `default_branch`.

**Поведение:**
- В body API — **только** явно заданные поля (паттерн `gitlab_update_issue` / `gitlab_update_merge_request`).
- Ответ: JSON проекта (как минимум `id`, `path_with_namespace`, `default_branch`).
- Ошибки GitLab (400/403/404) — пробрасывать текстом.

**Не в этом tool:** visibility, archive, delete, CI variables, members, protected branches.

### 2. `gitlab_create_repository_branch` (настоятельно желательно, тот же PR)

**HTTP:** `POST /projects/:id/repository/branches`  
Docs: [Create repository branch](https://docs.gitlab.com/ee/api/branches.html#create-repository-branch)

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | ID или path |
| `branch` | string | да | Имя новой ветки (`develop`) |
| `ref` | string | да | Source (`main`, SHA, tag) |

**Поведение:** 201 → branch object; если ветка уже есть — понятная ошибка (агент решит ignore / continue).

### 3. `gitlab_list_repository_branches` (опционально)

**HTTP:** `GET /projects/:id/repository/branches`

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | ID или path |
| `search` | string | нет | Фильтр |
| `page` / `per_page` | number | нет | Пагинация |

## Scope (out)

- Protected branches API (follow-up).  
- Удаление веток / удаление `main`.  
- Массовая миграция всех проектов Cubekit — не в MCP; потребитель вызовет tools в цикле.  
- MR merge/todo — уже есть `gitlab_merge_merge_request` и др.

## DoD

- [x] Tools в `ListTools` + handlers в `server.mjs`
- [x] README + `ONBOARDING_PROMPT.md` обновлены
- [x] Локальный smoke: `get_project` → (при необходимости) `create_repository_branch` → `update_project` `default_branch` → `get_project` verify  
  (на тестовом проекте; **не** менять default prod Cubekit без явного запроса пользователя)
- [x] bump `package.json` version (patch) + готовность publish npm по процессу репо

## Пример сценария потребителя

```text
1) gitlab_get_project id=…
2) если нет develop → gitlab_create_repository_branch branch=develop ref=main
3) gitlab_update_project id=… default_branch=develop
4) gitlab_get_project — verify default_branch
```

## Критерий приёмки

Из Cursor через MCP (без `glab`): создать ветку из ref и сменить default branch тестового проекта туда-обратно.

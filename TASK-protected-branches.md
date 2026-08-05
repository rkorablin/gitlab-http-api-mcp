# Постановка: protected branches API

> **Статус:** выполнено (tools + docs + smoke; publish — по запросу).  
> **Не** коммитить в `cubekit-v2-common-general`.  
> **Контекст потребителя:** Cubekit v2 branch policy v1 — non-lib: protect `develop`, не protect `main`; lib: protect `main`. Сейчас агент ходит в Shell/`glab`; нужен MCP.

## Зачем

После смены default branch нужно:

1. Снять protect с устаревшего `main` (non-lib).  
2. Поставить protect на `develop` (non-lib) / `main` (lib).  
3. Аудитить список protected branches без CLI.

Стиль — как в `server.mjs` (`glFetch`, `encodeProjectId` / `projPath`, `jsonContent`).

## Scope (in)

### 1. `gitlab_list_protected_branches` (обязательно)

**HTTP:** `GET /projects/:id/protected_branches`  
Docs: [List protected branches](https://docs.gitlab.com/ee/api/protected_branches.html#list-protected-branches)

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | ID или path |
| `search` | string | нет | Фильтр имени (если API поддерживает) |

**Ответ:** массив protected branch objects (как минимум `name`, access levels, `allow_force_push`).

### 2. `gitlab_protect_branch` (обязательно)

**HTTP:** `POST /projects/:id/protected_branches`  
Docs: [Protect repository branch](https://docs.gitlab.com/ee/api/protected_branches.html#protect-repository-branch)

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | ID или path |
| `name` | string | да | Имя ветки или wildcard (`develop`, `main`, `release/*`) |
| `push_access_level` | number | нет | Default **40** (Maintainers); 0 = No one, 30 = Developers + Maintainers |
| `merge_access_level` | number | нет | Default **40** |
| `allow_force_push` | boolean | нет | Default **false** |
| `code_owner_approval_required` | boolean | нет | Если инстанс поддерживает |

**Поведение:** 201 → object; если уже protected — понятная ошибка (или документировать idempotent re-protect, если GitLab позволяет).

### 3. `gitlab_unprotect_branch` (обязательно)

**HTTP:** `DELETE /projects/:id/protected_branches/:name`  
Docs: [Unprotect repository branch](https://docs.gitlab.com/ee/api/protected_branches.html#unprotect-repository-branch)

| Параметр | Тип | Обяз. | Описание |
|----------|-----|-------|----------|
| `project_id` | string | да | ID или path |
| `name` | string | да | Имя ветки (`main`) — URL-encode |

**Поведение:** 204 → успех (вернуть `{ "ok": true, "name": "…" }`); 404 — понятная ошибка.

## Scope (out)

- Allowed to merge/push per-user / per-group arrays (advanced) — follow-up, если понадобится.  
- Protected tags, environments.  
- Массовый audit скрипт Cubekit — не в MCP.

## Связь с уже сделанным

Рядом: `TASK-update-project-and-branches.md` (`gitlab_update_project`, create/list repository branches) — **выполнено**. Этот TASK — следующий слой для branch policy.

## DoD

- [x] Три tools в `ListTools` + handlers  
- [x] README + `ONBOARDING_PROMPT.md`  
- [x] Smoke на тестовом проекте: list → protect `tmp-protect-test` → list → unprotect → list  
  (**не** ломать prod Cubekit без явного запроса)  
- [x] bump `package.json` patch + готовность npm publish  

## Пример сценария потребителя (Cubekit non-lib)

```text
1) gitlab_list_protected_branches project_id=…
2) gitlab_unprotect_branch name=main
3) gitlab_protect_branch name=develop push_access_level=40 merge_access_level=40
4) gitlab_list_protected_branches — verify
```

## Критерий приёмки

Из Cursor через MCP (без `glab`): protect/unprotect/list на тестовой ветке.

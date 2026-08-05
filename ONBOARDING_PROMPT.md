ONBOARDING: custom GitLab MCP over HTTP API

Цель проекта — заменить официальный GitLab MCP-сервер локальной реализацией,
которая использует только HTTP API GitLab и полностью контролируется в этом
репозитории. Стиль и структура — по аналогии с `youtrack-http-api-mcp`.

Ключевые команды:

- `gitlab_get_current_user` — пользователь / токен
- `gitlab_list_projects` / `gitlab_get_project` / `gitlab_update_project` — проекты
  (в т.ч. смена `default_branch`)
- `gitlab_list_repository_branches` / `gitlab_create_repository_branch` — ветки
  репозитория (создать из `ref`, если ещё нет — перед сменой default)
- `gitlab_list_protected_branches` / `gitlab_protect_branch` /
  `gitlab_unprotect_branch` — protected branches (audit / protect / unprotect)
- **Issues:** `gitlab_list_issues`, `gitlab_get_issue`, `gitlab_create_issue`,
  `gitlab_update_issue`, `gitlab_list_issue_notes`, `gitlab_create_issue_note`
- **Merge requests:** `gitlab_list_merge_requests`, `gitlab_get_merge_request`,
  `gitlab_create_merge_request`, `gitlab_update_merge_request`,
  `gitlab_merge_merge_request`, `gitlab_get_merge_request_changes`,
  `gitlab_list_merge_request_notes`, `gitlab_list_merge_request_discussions`
- **CI/CD:** `gitlab_list_pipelines`, `gitlab_get_pipeline`,
  `gitlab_create_pipeline`, `gitlab_retry_pipeline`, `gitlab_cancel_pipeline`,
  `gitlab_list_pipeline_jobs`, `gitlab_get_job_trace`, `gitlab_retry_job`,
  `gitlab_play_job`

Расширять функциональность лучше небольшими, хорошо описанными инструментами
поверх HTTP API GitLab (см. официальную документацию GitLab API).

MCP через npx: в `mcp.json` использовать
`"args": ["--yes", "--prefer-online", "gitlab-http-api-mcp@latest"]`, чтобы при
перезапуске клиента подтягивалась свежая версия с npm.

ONBOARDING: custom GitLab MCP over HTTP API

Цель проекта — заменить официальный GitLab MCP-сервер локальной реализацией,
которая использует только HTTP API GitLab и полностью контролируется в этом
репозитории. Стиль и структура — по аналогии с `youtrack-http-api-mcp`.

Ключевые команды:

- `gitlab_get_current_user` — информация о токене/пользователе
- `gitlab_list_projects` / `gitlab_get_project` — работа с проектами/репозиториями
- `gitlab_list_issues` / `gitlab_get_issue` / `gitlab_create_issue` — задачи
- `gitlab_list_merge_requests` / `gitlab_get_merge_request` — merge request'ы

Расширять функциональность лучше небольшими, хорошо описанными инструментами
поверх HTTP API GitLab (см. официальную документацию GitLab API).

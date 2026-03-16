# gitlab-http-api-mcp

Самодельный MCP-сервер для GitLab, который ходит напрямую в HTTP API GitLab
(`GITLAB_API_URL`, `GITLAB_PERSONAL_ACCESS_TOKEN`) и предоставляет инструменты
для работы с проектами, задачами и merge request'ами.

## Требования

- Node.js 18+
- Доступный GitLab HTTP API и персональный токен с нужными правами.

## Установка

### Из исходников (GitHub)

```bash
git clone https://github.com/rkorablin/gitlab-http-api-mcp.git
cd gitlab-http-api-mcp
npm install
```

### Из npm

Локально в проект:

```bash
npm install gitlab-http-api-mcp
```

Глобально (для `npx` / CLI):

```bash
npm install -g gitlab-http-api-mcp
```

## Переменные окружения

- `GITLAB_API_URL` — базовый URL API, например `https://gitlab.example.com/api/v4`
- `GITLAB_PERSONAL_ACCESS_TOKEN` — персональный токен доступа GitLab

## Запуск в режиме MCP (stdio)

```bash
export GITLAB_API_URL="https://gitlab.example.com/api/v4"
export GITLAB_PERSONAL_ACCESS_TOKEN="glpat-..."
node server.mjs
```

## Интеграция с Cursor / другим MCP‑хостом

Добавьте сервер в конфиг MCP (например, `.cursor/mcp.json` → `mcpServers`).

### Вариант 1: Локальный клон

```json
"gitlab": {
  "command": "node",
  "args": ["/absolute/path/to/gitlab-http-api-mcp/server.mjs"],
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

### Вариант 2: npm / npx

Если пакет установлен глобально:

```json
"gitlab": {
  "command": "gitlab-http-api-mcp",
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

Через `npx`:

```json
"gitlab": {
  "command": "npx",
  "args": ["-y", "gitlab-http-api-mcp"],
  "env": {
    "GITLAB_API_URL": "https://gitlab.example.com/api/v4",
    "GITLAB_PERSONAL_ACCESS_TOKEN": "glpat-..."
  }
}
```

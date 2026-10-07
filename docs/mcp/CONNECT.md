# AG Lex MCP — подключение и деплой

## Для юристов: как подключить

Адрес коннектора: `https://<домен-AG-Lex>/mcp`

| Клиент | Как подключить | Доступ |
|--------|----------------|--------|
| Claude.ai / Claude Desktop | Settings → Connectors → Add custom connector → вставить адрес → войти email/паролем AG Lex | Полный (по вашей роли) |
| Claude Code | `claude mcp add --transport http aglex https://<домен>/mcp`, затем `/mcp` → Authenticate | Полный |
| Cursor | Settings → MCP → Add → `{"aglex": {"url": "https://<домен>/mcp"}}` | Полный |
| ChatGPT | Settings → Connectors → Developer mode → Create → адрес `/mcp`, OAuth | **Ограниченный**: справи, задачі, календар, кодекс. Без документів, білінгу, клієнтів (політика фірми для Plus/Pro) |

Отключить: удалить коннектор в клиенте, или в AG Lex: «Доступ» →
«AI-підключення (MCP)» → «Відключити». Там же администратор закрывает
конфиденциальных клиентов/дела от внешних AI. То же через API:
- свои подключения — `GET /api/me/connected-apps`, `DELETE /api/me/connected-apps/{client_id}`;
- администратор (право `manage`) — `GET /api/admin/connected-apps`,
  `DELETE /api/admin/connected-apps/{client_id}/{user_id}`.

После 5 неверных паролей на странице входа — пауза 15 минут.

Законы Украины/ЕС — второй коннектор Ansvar: `https://gateway.ansvar.eu/mcp`
(free, свой аккаунт). **Не вставляйте в запросы к Ansvar данные клиентов.**

### Без входа: секретное посилання

AG Lex → «Доступ» → «Посилання для Claude без входу»: название, доступ
(полный / ограниченный), ваш пароль → «Створити посилання». Скопируйте
`https://<домен>/mcp/k/aglx_lk_…` (показывается один раз) и вставьте в
Claude Desktop → Settings → Connectors → Add custom connector. Логин не
нужен.

- Работает от вашего имени и с вашими правами; действия в справах помечены
  «🤖 [<название> · посилання · MCP]», вызовы — в аудите.
- Кто знает ссылку — действует от вашего имени: не пересылайте её, при
  утечке — «Відкликати». До 10 ссылок на человека; администратор
  видит и отзывает все.
- Срок по умолчанию 90 дней; ссылка, не использованная 30 дней, перестаёт
  работать. При удалении сотрудника из команды все его ссылки и токены
  отзываются. Администратор: `DELETE /api/admin/mcp-access/{user_id}`
  отзывает всё MCP-доступ сотрудника разом.
- Ключ хранится только в виде хэша; nginx стека не пишет эти запросы ни в
  access-, ни в error-log и передаёт ключ бэкенду заголовком, uvicorn
  вырезает ключ из своих журналов. **Внешний TLS-прокси перед стеком
  (на сервере) обязательно настроить так же:**

  ```nginx
  location ^~ /mcp/k/ {
      access_log off;
      error_log /dev/null crit;
      proxy_pass http://127.0.0.1:8002;   # как в основном location /
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_buffering off;
      proxy_read_timeout 300s;
  }
  ```

**«Без обмежень»** (только партнёр/админ): галочка в той же форме —
бессрочная ссылка без лимитов, видит все дела фирмы (включая закрытые от AI),
пароль не спрашивается. Храните как пароль администратора.

### Открытый доступ: чистая ссылка `https://<домен>/mcp`

Решение фирмы 2026-10-07. В `.env` на сервере `MCP_OPEN_ACCESS=true` → голый
`https://<домен>/mcp` подключается в Claude без входа и без ключа, с полным
доступом «Без обмежень» (все дела, документы, клиенты, запись). Действия идут
от имени `MCP_OPEN_OWNER_EMAIL` (по умолчанию — самый старый пользователь с
правом `manage`), в справах — «🤖 [Відкрите посилання · посилання · MCP]».

- **Любой, кто знает адрес сайта, получает всю фирму.** Выключить —
  `MCP_OPEN_ACCESS=false` + перезапуск backend; «Відкликати» в UI действует
  только до следующего перезапуска.
- Клиенты со своим OAuth-токеном работают как раньше, от своего имени.
- Ссылки с ключом `/mcp/k/…` при включённом открытом доступе не нужны:
  при старте backend все они отзываются, новые создать нельзя (409), а на
  странице «Доступ» вместо формы показывается только чистая ссылка `/mcp`.

## Для админа: деплой

1. `.env` на сервере: `PUBLIC_BASE_URL=https://<домен>` (без `/` в конце).
   Это OAuth issuer и URL ресурса; после смены все выданные токены
   перестают проходить проверку `resource` → юристы переподключаются.
2. `docker compose up -d --build` — nginx уже проксирует `/mcp`, `/authorize`,
   `/token`, `/register`, `/revoke`, `/oauth/`, `/.well-known/oauth-*`.
3. Проверка:
   ```bash
   curl -s https://<домен>/.well-known/oauth-authorization-server | jq .issuer
   curl -si -X POST https://<домен>/mcp -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -i www-authenticate
   ```
   Ожидается issuer = `PUBLIC_BASE_URL` и `401` с `resource_metadata=…`.

### HTTPS (обязательно для Claude.ai / ChatGPT)

Сейчас edge nginx слушает только `:80` внутри контейнера → `8002` на хосте.
Вариант с минимальными изменениями — TLS на хосте перед `8002`:

```bash
apt install -y nginx certbot python3-certbot-nginx
cat >/etc/nginx/sites-available/aglex <<'EOF'
server {
    server_name <домен>;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
EOF
ln -s /etc/nginx/sites-available/aglex /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d <домен>          # выпуск + автопродление
```

DNS A-запись домена должна указывать на сервер, порты 80/443 открыты.
После этого закройте `8002` снаружи (firewall), чтобы трафик шёл только через TLS.

### Локальная проверка без домена

`uvicorn backend.main:app --workers 1 --port 8000` → `PUBLIC_BASE_URL`
по умолчанию `http://localhost:8000`. Подключение из Claude Code:
`claude mcp add --transport http aglex-local http://localhost:8000/mcp`,
или `npx @modelcontextprotocol/inspector`.

# Развёртывание

Запуск хаба и раннера как постоянных фоновых служб, настройка удалённого доступа и варианты установки.

> Нативные приложения [iOS / Android](./native-apps.ru.md#сопряжение-с-хабом) подключаются к тому же хабу, что и веб. Для сопряжения нужен HTTPS-адрес хаба (Android отклоняет `http://`). Push-реле для нативных уведомлений — отдельный сервис, не связанный с туннелями ниже.

## Архитектура

| Компонент | Роль | Обязателен |
|-----------|------|------------|
| **CLI** | Оборачивает ИИ-агентов, запускает сессии | Да |
| **Hub** | Центральный координатор: хранение, синхронизация, удалённый доступ | Да |
| **Runner** | Фоновый сервис для удалённого запуска сессий | Опционально |
| **Client** | Нативные iOS/Android, Web/PWA или Telegram Mini App | Один клиент для удалённого управления |

CLI и Runner подключаются к хабу по Socket.IO; клиенты отправляют действия через REST и получают живые обновления по SSE. Runner запускает CLI-сессии по запросу через хаб.

## Вариант 1. Быстрый старт (публичное реле)

Самый простой способ — публичное реле с E2E-шифрованием:

```bash
npx @twsxtd/hapi hub --relay
```

Хаб сам настраивает туннель через реле (`relay.hapi.run`) и выдаёт URL + QR-коды. Подходит для быстрой проверки без своей инфраструктуры.

> Реле по умолчанию использует UDP. Если есть проблемы с подключением — `HAPI_RELAY_FORCE_TCP=true`.

## Вариант 2. Cloudflare Tunnel (собственный домен)

Если нужен собственный HTTPS-домен (например, `hapi.example.com`) без публичного реле.

> **Важно:** Quick Tunnels (TryCloudflare) не поддерживаются — они [не работают с SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), который HAPI использует для живых обновлений. Используйте **Named Tunnel**.

```bash
# Установите cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Создать и настроить named-туннель
cloudflared tunnel create hapi
cloudflared tunnel route dns hapi hapi.example.com

# Запустить туннель (http2 вместо QUIC, чтобы избежать таймаутов долгих соединений)
cloudflared tunnel --protocol http2 --no-autoupdate run hapi
```

Хаб при этом слушает локально:

```bash
export HAPI_PUBLIC_URL="https://hapi.example.com"
export HAPI_LISTEN_HOST="127.0.0.1"
export HAPI_LISTEN_PORT="3006"
hapi hub
```

## Вариант 3. Tailscale

```bash
sudo tailscale up
```

По умолчанию хаб слушает только loopback. Для доступа через Tailscale-адрес:

```bash
HAPI_LISTEN_HOST=0.0.0.0 hapi hub
```

Ограничьте входящий доступ файрволом и открывайте `http://100.x.x.x:3006`. Для нативных приложений и HTTPS-функций браузера используйте HTTPS-эндпоинт (например, Tailscale Serve поверх локального хаба).

## Вариант 4. Обратный прокси / свой HTTPS

Оставьте хаб на `127.0.0.1:3006` и поставьте перед ним HTTPS-обратный прокси (Nginx, Caddy и т.п.). `HAPI_LISTEN_HOST` меняйте только если нужен другой адрес привязки.

Если `HAPI_API_URL` указывает на `https://...` с самоподписанным сертификатом, CLI может упасть с `Error: self signed certificate`. Решения (по приоритету):

1. Общедостоверный сертификат (Let's Encrypt);
2. Доверить свой приватный CA: `export NODE_EXTRA_CA_CERTS="/путь/к/ca.pem"`;
3. Только для разработки (НЕБЕЗОПАСНО): `export NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Фоновые службы

Чтобы HAPI переживал закрытие терминала и перезагрузки — запустите hub/runner как службу.

### Просто: nohup

```bash
mkdir -p ~/.hapi/logs
nohup hapi hub --relay > ~/.hapi/logs/hub.log 2>&1 &
nohup hapi runner start-sync > ~/.hapi/logs/runner.log 2>&1 &

tail -f ~/.hapi/logs/hub.log
pkill -f "hapi hub"; pkill -f "hapi runner"
```

### pm2 (рекомендуется для Node.js-пользователей)

```bash
npm install -g pm2
pm2 start "hapi hub --relay" --name hapi-hub
HAPI_RUNNER_SUPERVISED=1 pm2 start "hapi runner start-sync" --name hapi-runner
pm2 status; pm2 logs hapi-hub
pm2 startup && pm2 save   # автозапуск при перезагрузке
```

### macOS: launchd

Создайте plist-файлы для автозапуска на macOS.

**Хаб** (`~/Library/LaunchAgents/com.hapi.hub.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string><string>hub</string><string>--relay</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/Users/ВАШ_ПОЛЬЗОВАТЕЛЬ/.hapi/logs/hub.log</string>
    <key>StandardErrorPath</key><string>/Users/ВАШ_ПОЛЬЗОВАТЕЛЬ/.hapi/logs/hub.log</string>
</dict>
</plist>
```

**Раннер** (`~/Library/LaunchAgents/com.hapi.runner.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.hapi.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string><string>runner</string><string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HAPI_RUNNER_SUPERVISED</key><string>1</string>
    </dict>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key><integer>65536</integer>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/Users/ВАШ_ПОЛЬЗОВАТЕЛЬ/.hapi/logs/runner.log</string>
    <key>StandardErrorPath</key><string>/Users/ВАШ_ПОЛЬЗОВАТЕЛЬ/.hapi/logs/runner.log</string>
</dict>
</plist>
```

Загрузка/выгрузка служб:

```bash
# Запуск
launchctl load ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl load ~/Library/LaunchAgents/com.hapi.runner.plist

# Остановка
launchctl unload ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl unload ~/Library/LaunchAgents/com.hapi.runner.plist
```

> **Сон macOS:** при засыпании дисплея macOS может приостанавливать фоновые процессы. Используйте `caffeinate -dimsu hapi hub --relay`, чтобы этого избежать.

### Linux: systemd (user-уровень)

`~/.config/systemd/user/hapi-hub.service`:

```ini
[Unit]
Description=HAPI Hub
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hapi hub --relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/hapi-runner.service`:

```ini
[Unit]
Description=HAPI Runner
After=network.target hapi-hub.service

[Service]
Type=simple
KillMode=process
Environment=HAPI_RUNNER_SUPERVISED=1
ExecStart=/usr/local/bin/hapi runner start-sync
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now hapi-hub hapi-runner
loginctl enable-linger $USER   # чтобы работало и после выхода из сессии
```

> **Почему `KillMode=process`?** Сессии агентов отвязываются от раннера. По умолчанию `KillMode=control-group` завершал бы их при остановке службы раннера; `KillMode=process` сохраняет их при перезапусках и обновлениях раннера.

## Агенты

Запуск напрямую: `hapi <агент>`, например `hapi claude`, `hapi codex`, `hapi cursor`, `hapi dsh`. Полный список — `hapi --help` и [Supported Agents](./agents.ru.md).

### DeepSeek Harness (DSH)

HAPI запускает DSH через ACP. По умолчанию используется официальный `dsh-acp-demo`; исполняемый файл и его аргументы можно переопределить без разбора шелла:

```bash
export HAPI_DSH_ACP_COMMAND=dsh-acp-demo
export HAPI_DSH_ACP_CONFIG=/path/to/deepseek-harness/examples/acp-agent/cordis.yml
hapi dsh
```

Официальный ACP-демо работает только со свежими сессиями: он не поддерживает нативный resume, переключение моделей, инъекцию MCP и живую телеметрию инструментов/рассуждений. Общую политику разрешений определяет ACP-композиция; HAPI не объявляет для DSH resume или управление моделями.

## Telegram Mini App

Чтобы управлять HAPI через Telegram, задайте токен бота в настройках хаба (хранится в `~/.hapi/settings.json` как `telegramBotToken`) и экспортируйте его при запуске:

```bash
export TELEGRAM_BOT_TOKEN="..."
hapi hub
```

## Безопасность

- Токен доступа (`CLI_API_TOKEN`) — это фактически пароль: храните его в секрете, он используется для сопряжения приложений.
- Публичное реле шифрует трафик сквозным образом (WireGuard + TLS).
- Не включайте `NODE_TLS_REJECT_UNAUTHORIZED=0` в публичных сетях.


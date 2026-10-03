# Установка

Установите CLI HAPI и настройте хаб. О сборке и сопряжении клиентов для телефона
см. [Нативные приложения (iOS / Android)](./native-apps.ru.md); об установке в браузере —
см. [PWA](./pwa.ru.md).

## Предварительные требования

- Установлен хотя бы один поддерживаемый CLI агента (Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, ACP-сервер DeepSeek Harness и другие — см. [Поддерживаемые агенты](./agents.ru.md))

Проверьте, что ваш CLI установлен:

```bash
# Для Claude Code
claude --version

# Для OpenAI Codex CLI
codex --version

# Для Cursor Agent CLI
agent --version

# Для Grok Build CLI
grok --version

# Для OpenCode CLI
opencode --version
```

## Архитектура

HAPI использует такие роли времени выполнения:

| Компонент | Роль | Обязателен |
|-----------|------|----------|
| **CLI** | Оборачивает ИИ-агентов, запускает сессии | Да |
| **Hub** | Центральный координатор: хранение, синхронизация в реальном времени, удалённый доступ | Да |
| **Runner** | Фоновый сервис для удалённого запуска сессий | Опционально |
| **Client** | Нативные iOS/Android, Web/PWA или Telegram Mini App | Один клиент для удалённого управления |

### Как они работают вместе

CLI и Runner подключаются к хабу по Socket.IO; клиенты отправляют действия
через REST и получают живые обновления по SSE. Runner запускает CLI-сессии,
когда их запрашивают через хаб. См. [обзор архитектуры](./how-it-works.ru.md).

- **CLI**: выберите агента командой `hapi` или запустите напрямую `hapi <agent>`. CLI оборачивает вашего ИИ-агента и синхронизируется с хабом. В скриптах агента нужно указывать явно.
- **Hub**: выполните `hapi hub`. Хранит сессии, обрабатывает разрешения, обеспечивает удалённый доступ.
- **Runner**: выполните `hapi runner start`. Позволяет запускать сессии из нативных или веб-клиентов, не держа терминал открытым.
- **Client**: сопрягите нативное приложение с HTTPS-адресом хаба и токеном доступа или войдите через веб-приложение.

### Типичные сценарии

**Только локально**: `hapi hub` → `hapi` → работа в терминале

**Удалённый доступ**: `hapi hub --relay` → `hapi runner start` → сопрягите нативное приложение или откройте веб-приложение

## Установка CLI

```bash
npm install -g @twsxtd/hapi --registry=https://registry.npmjs.org
```

> Рекомендация: используйте официальный npm-реестр для глобальной установки. Некоторые зеркала могут не синхронизировать платформенные пакеты вовремя.

Или через Homebrew:

```bash
brew install tiann/tap/hapi
```

## Другие способы установки

<details>
<summary>npx (без установки)</summary>

```bash
npx @twsxtd/hapi
```
</details>

<details>
<summary>Готовый бинарь</summary>

Скачайте последний релиз из [GitHub Releases](https://github.com/tiann/hapi/releases).

```bash
xattr -d com.apple.quarantine ./hapi
chmod +x ./hapi
sudo mv ./hapi /usr/local/bin/
```
</details>

<details>
<summary>Сборка из исходников</summary>

Требуется Bun 1.4.0.

```bash
git clone https://github.com/tiann/hapi.git
cd hapi
bun install
bun build:single-exe

./cli/dist-exe/<target>/hapi
```

`<target>` — цель сборки Bun (например, `bun-linux-x64`, `bun-darwin-arm64`); по умолчанию — платформа и архитектура хоста.
</details>

## Настройка хаба

Хаб можно развернуть на:

- **Локальном компьютере** (по умолчанию) — запуск на вашей машине разработки
- **Удалённом хосте** — разверните хаб на VPS, облачном хосте или любой машине с доступом к сети

### По умолчанию: публичное реле (рекомендуется)

```bash
hapi hub --relay
```

Терминал отображает URL и QR-код. Отсканируйте, чтобы получить доступ отовсюду.

`hapi server` остаётся поддерживаемым псевдонимом.

- **Сквозное шифрование** через WireGuard + TLS
- Настройка не требуется
- Работает за NAT, файрволами и в любой сети

Об управлении ключами реле, TCP-fallback и self-hosted альтернативах туннелей см. [Развёртывание](./deployment.ru.md).

### Только локально

```bash
hapi hub
# или
hapi hub --no-relay
```

По умолчанию хаб слушает на `http://localhost:3006`.

При первом запуске HAPI:

1. Создаёт `~/.hapi/`
2. Генерирует безопасный токен доступа
3. Печатает токен и сохраняет его в `~/.hapi/settings.json`

<details>
<summary>Файлы конфигурации</summary>

```
~/.hapi/
├── settings.json      # Основная конфигурация
├── hapi.db           # База данных SQLite (хаб)
├── runner.state.json  # Состояние процесса раннера
└── logs/             # Файлы логов
```
</details>

<details>
<summary>Переменные окружения</summary>

| Переменная | По умолчанию | settings.json | Описание |
|----------|---------|---------------|-------------|
| `CLI_API_TOKEN` | Автогенерация | `cliApiToken` | Общий секрет для аутентификации |
| `HAPI_API_URL` | `http://localhost:3006` | `apiUrl` | URL хаба для подключений CLI |
| `HAPI_EXTRA_HEADERS_JSON` | - | `extraHeaders` | JSON-объект дополнительных исходящих заголовков для HTTP/WebSocket-запросов CLI → хаб |
| `HAPI_LISTEN_HOST` | `127.0.0.1` | `listenHost` | Адрес привязки HTTP хаба |
| `HAPI_LISTEN_PORT` | `3006` | `listenPort` | HTTP-порт хаба |
| `HAPI_PUBLIC_URL` | - | `publicUrl` | Публичный URL для внешнего доступа |
| `CORS_ORIGINS` | - | `corsOrigins` | Разрешённые CORS-origin (через запятую) |
| `TELEGRAM_BOT_TOKEN` | - | `telegramBotToken` | Токен Telegram Bot API |
| `TELEGRAM_NOTIFICATION` | `true` | `telegramNotification` | Включить уведомления Telegram |
| `SERVERCHAN_SENDKEY` | - | `serverChanSendKey` | SendKey Server酱 (ServerChan) для push-уведомлений |
| `SERVERCHAN_NOTIFICATION` | `true` | `serverChanNotification` | Включить уведомления ServerChan |
| `SERVERCHAN_BACKGROUND_ONLY` | `false` | `serverChanBackgroundOnly` | Отправлять уведомления ServerChan только когда в пространстве имён нет видимого подключения HAPI |
| `HAPI_RELAY_API` | `relay.hapi.run` | - | Домен API реле для публичного реле |
| `HAPI_RELAY_AUTH` | Ключ на хаб, выдаваемый реле | `relayAuthKey` | Переопределение ключа аутентификации реле (задавайте только если оператор выдал ключ) |
| `HAPI_RELAY_FORCE_TCP` | `false` | - | Принудительный TCP-режим для реле |
| `HAPI_OFFICIAL_WEB_URL` | `https://app.hapi.run` | - | Origin официального веб-приложения, добавляется в CORS при включённом реле |
| `VAPID_SUBJECT` | `mailto:admin@hapi.run` | - | Контактная информация Web Push |
| `HAPI_ANDROID_PUSH` | `auto` | `androidPushMode` | Android push: официальное реле по умолчанию, прямой FCM при настроенных приватных учётных данных; также принимает `relay`, `fcm`, `off` |
| `HAPI_IOS_PUSH` | `relay` | `iosPushMode` | iOS push: `relay`, прямой `apns` или `off` |
| `HAPI_PUSH_RELAY_URL` | `https://push.hapi.run` | `iosPushRelayUrl` | Общее push-реле Android/iOS, независимое от сетевого туннеля |
| `FCM_SERVICE_ACCOUNT_PATH` | - | `fcmServiceAccountPath` | Прямые учётные данные FCM для приватных сборок с тем же проектом Firebase |
| `HAPI_HOME` | `~/.hapi` | - | Путь каталога конфигурации |
| `DB_PATH` | `~/.hapi/hapi.db` | - | Путь файла базы данных |
| `HAPI_EXPERIMENTAL` | - | - | CLI: включить экспериментальные функции (`true`/`1`/`yes`) |
| `ELEVENLABS_API_KEY` | - | Settings / env | API-ключ ElevenLabs для голоса + диктовки |
| `ELEVENLABS_AGENT_ID` | Автосоздание | - | Пользовательский ID агента ElevenLabs |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | - | Settings / env | Голосовой ассистент Gemini Live |
| `DASHSCOPE_API_KEY` / `QWEN_API_KEY` | - | Settings / env | Голосовой ассистент Qwen Realtime |
| `VOICE_BACKEND` | Автоопределение | - | Бэкенд ассистента по умолчанию: `elevenlabs`, `gemini-live` или `qwen-realtime` |
| `OPENAI_API_KEY` | - | Settings / env | API-ключ OpenAI для диктовки (`gpt-transcribe` / `gpt-live-transcribe`) |
| `DEEPGRAM_API_KEY` | - | Settings / env | API-ключ Deepgram для диктовки (`nova-3`) |
| `GROQ_API_KEY` | - | Settings / env | API-ключ Groq для диктовки (`whisper-large-v3`) |
| `TRANSCRIPTION_BASE_URL` | - | Settings / env | Базовый URL OpenAI-совместимой/локальной транскрипции |
| `TRANSCRIPTION_MODEL` | - | Settings / env | Модель для OpenAI-совместимого эндпоинта транскрипции |
| `TRANSCRIPTION_API_KEY` | - | Settings / env | Опциональный bearer-токен для этого эндпоинта |
| `HAPI_TITLE_PROVIDER_BASE_URL` | - | - | Только для сервера: базовый URL OpenAI-совместимых Chat Completions для генерируемых заголовков сессий |
| `HAPI_TITLE_PROVIDER_API_KEY` | - | - | Только для сервера: API-ключ для генерируемых заголовков сессий; никогда не отправляется в браузер |
| `HAPI_TITLE_PROVIDER_MODEL` | - | - | Только для сервера: лёгкая модель для генерируемых заголовков сессий |
| `HAPI_TITLE_SUGGESTION_RATE_LIMIT` | `5` | - | Максимум предложений заголовка на сессию в окне лимита |
| `HAPI_TITLE_SUGGESTION_RATE_WINDOW_MS` | `600000` | - | Окно лимита предложений заголовка в миллисекундах |
| `HAPI_TITLE_PROVIDER_MAX_TOKENS` | `64` | - | Максимальный бюджет токенов завершения на заголовок; увеличьте для reasoning-провайдеров |
| `HAPI_TITLE_PROVIDER_TIMEOUT_MS` | `10000` | - | Таймаут запроса к провайдеру заголовков в миллисекундах |
</details>

Действие **Generate** в диалоге переименования сессии недоступно, пока все три
переменные `HAPI_TITLE_PROVIDER_*` не настроены на хабе. Провайдер
вызывается только по запросу; существующий ручной поток переименования не требует этих
переменных. Каждый запрос отправляет недавний видимый текст диалога пользователь/ассистент
(до 200 сохранённых сообщений и ограниченный промпт) этому настроенному провайдеру.

<details>
<summary>Пример settings.json</summary>

Приоритет конфигурации: **ENV > settings.json > default**

Когда значения ENV заданы и отсутствуют в settings.json, они автоматически сохраняются.
`HAPI_EXTRA_HEADERS_JSON` не сохраняется автоматически, чтобы учётные данные доступа не персистились неожиданно.

```json
{
  "$schema": "https://hapi.run/docs/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "listenPort": 3006,
  "publicUrl": "https://your-domain.com",
  "extraHeaders": {
    "Cookie": "CF_Authorization=..."
  }
}
```

JSON Schema: [settings.schema.json](https://hapi.run/docs/schemas/settings.schema.json)
</details>

## Настройка CLI

Если хаб не на localhost, задайте это перед запуском `hapi`:

```bash
export HAPI_API_URL="http://your-hub:3006"
export CLI_API_TOKEN="your-token-here"
export HAPI_EXTRA_HEADERS_JSON='{"Cookie":"CF_Authorization=..."}'
```

Или используйте интерактивный вход:

```bash
hapi auth login
```

Команды аутентификации:

```bash
hapi auth status
hapi auth login
hapi auth logout
```

Каждая машина получает уникальный ID, хранящийся в `~/.hapi/settings.json`. Это позволяет:

- подключать несколько машин к одному хабу;
- удалённо запускать сессии на конкретных машинах;
- мониторить здоровье машин.

### Диагностика

Выполните `hapi doctor` для полного отчёта диагностики: конфигурация, статус раннера, логи и релевантная информация об окружении.

```bash
hapi doctor          # Отчёт диагностики
hapi doctor clean    # Убить разбежавшиеся процессы hapi
```

## Настройка раннера

Запустите фоновый сервис для удалённого запуска сессий:

```bash
hapi runner start
hapi runner status
hapi runner logs
hapi runner stop
```

При работающем раннере:

- ваша машина появляется в списке «Machines»;
- вы можете удалённо запускать сессии из веб-приложения;
- сессии сохраняются даже когда терминал закрыт.

#### Раздельный хаб + удалённый раннер (обнаружение пиров)

Когда хаб работает на одном хосте, а раннер на другом, агенты внутри сессий, запущенных раннером, должны обнаруживать пиров через MCP **`list_peers`** (с теми же учётными данными хаба, что и CLI сессии). Предпочитайте это shell-вызову `hapi ping-peer --list`.

```
[Хост хаба]  hapi hub          ← БД сессий + /api/sessions
     ▲
     │ HAPI_API_URL + CLI_API_TOKEN
     │
[Хост раннера]  hapi runner start  → запускает CLI сессий
                      │
                      ▼
               сессия агента  → MCP list_peers / inspect_peer / ping_peer
```

На хосте раннера настройте **те же** URL хаба и токен, которые использует хаб:

```bash
export HAPI_API_URL="http://your-hub:3006"   # или Tailscale / публичный URL
export CLI_API_TOKEN="your-token-here"
# или: hapi auth login   # сохраняет токен; всё равно задайте HAPI_API_URL для удалённого хаба
hapi runner start
```

CLI сессии может экспортировать **явный** нестандартный `HAPI_API_URL` (из env или настроек) в окружение дочерних процессов, чтобы shell-помощники обращались к тому же удалённому хабу. Он **не** зеркалирует `CLI_API_TOKEN` в обёрнутые агенты (секреты из настроек/промпта не попадают в окружение агента; свежий `hapi` заново читает `~/.hapi/settings.json`, а токены systemd/env уже наследуются). Внутри сессии предпочитайте MCP `list_peers`. PTY веб-терминала по-прежнему вычищают секреты хаба. Если `--list` падает с ошибкой auth/URL, сообщение указывает на `hapi auth login` и настроенный URL хаба.

Дополнительные команды раннера:

```bash
hapi runner list                      # Список активных сессий
hapi runner stop-session <sessionId>  # Остановить одну сессию, управляемую раннером
```

Используйте `--workspace-root <path>`, чтобы ограничить каталоги, которые раннер может просматривать и в которых может запускать сессии. Повторяйте флаг для нескольких каталогов; поддерживается раскрытие `~`:

```bash
hapi runner start --workspace-root ~/projects --workspace-root ~/work
```

Без `--workspace-root` просмотр каталогов и запуск принимают пути
везде, куда имеет доступ учётная запись ОС раннера. Выбор каталога в iOS начинается
с домашнего каталога и может подниматься выше. Настройка корней ограничивает
и просмотр, и запуск этими корнями, включая цели символических ссылок.

О запуске хаба и раннера как постоянных фоновых служб (pm2, launchd, systemd) см. [Развёртывание](./deployment.ru.md). Для установок под супервизором задавайте `HAPI_RUNNER_SUPERVISED=1` для процесса раннера (systemd `Environment=` / pm2 `--env`), чтобы веб-кнопка **Restart** могла безопасно остановить раннер, зная, что супервизор холодно перезапустит его.

### Хабы с несколькими машинами

Можно запустить **один хаб** и **раннеры на многих машинах** (каждая машина ставит свой CLI). При обновлении хаба обновите CLI HAPI на каждой машине, которая является родителем сессий. После изменения бинаря CLI на диске раннер этой машины обычно **сам перезапускается** через передачу версии (если не задан `HAPI_DISABLE_VERSION_HANDOFF=1`). Пока раннер не сообщит возможности, которые требует хаб, веб-UI показывает баннер **Runner out of date** (сворачиваемый / откладываемый) с именем хоста и шагами обновления. Кнопка **Restart** на хосте в баннере — только запасной выход, когда передача версии застряла или отключена — хаб никогда не скачивает и не устанавливает пакеты на удалённых машинах.

## Заметки о безопасности

- Держите токены в секрете и ротируйте при необходимости
- Используйте HTTPS для публичного доступа
- Ограничивайте CORS-origin в проде

<details>
<summary>Пример файрвола (ufw)</summary>

```bash
ufw allow from 192.168.1.0/24 to any port 3006
```
</details>

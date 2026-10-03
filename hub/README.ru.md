# hapi-hub

Telegram-бот + HTTP API + обновления в реальном времени для хаба hapi.

## Что он делает

- Telegram-бот для уведомлений и точки входа в Mini App.
- HTTP API для сессий, сообщений, разрешений, машин и файлов.
- Поток Server-Sent Events для живых обновлений в веб- и нативных клиентах.
- Канал Socket.IO для подключений CLI.
- Отдаёт веб-приложение из `web/dist` или встроенных ассетов в едином бинарнике; режим сетевого реле использует отдельно размещённое официальное веб-приложение.
- Сохраняет состояние в SQLite через `bun:sqlite`.

## Конфигурация

Все параметры см. в `src/configuration.ts`.

### Обязательные

- `CLI_API_TOKEN` — базовый общий секрет, используемый CLI, веб-входом и нативным сопряжением. Клиенты добавляют `:<namespace>` для изоляции. Генерируется автоматически при первом запуске, если не задан.

### Необязательные (Telegram)

- `TELEGRAM_BOT_TOKEN` — токен от @BotFather.
- `HAPI_PUBLIC_URL` — публичный HTTPS-URL для доступа к Telegram Mini App. Также используется для вывода стандартных CORS-origins веб-приложения.

### Необязательные (голос)

Ключи провайдеров диктовки и голосового ассистента также можно добавить из **Настройки → Голос** (хранятся в `settings.json` в `providerCredentials`; env-переменные всё равно побеждают, когда заданы при запуске процесса).

- `ELEVENLABS_API_KEY` — ключ API ElevenLabs для голосового ассистента + диктовки.
- `ELEVENLABS_AGENT_ID` — id пользовательского агента ElevenLabs (создаётся автоматически, если не задан).
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` — голосовой ассистент Gemini Live.
- `DASHSCOPE_API_KEY` / `QWEN_API_KEY` — голосовой ассистент Qwen Realtime.
- `VOICE_BACKEND` — бэкенд ассистента по умолчанию (`elevenlabs`, `gemini-live` или `qwen-realtime`).
- `OPENAI_API_KEY` — диктовка OpenAI (`gpt-transcribe` / `gpt-live-transcribe`).
- `DEEPGRAM_API_KEY` — диктовка Deepgram (`nova-3`, стандартная и realtime).
- `GROQ_API_KEY` — диктовка Groq (`whisper-large-v3`).
- `TRANSCRIPTION_BASE_URL` и `TRANSCRIPTION_MODEL` — совместимый с OpenAI/локальный эндпоинт и модель транскрипции.
- `TRANSCRIPTION_API_KEY` — необязательный bearer-токен для совместимого с OpenAI эндпоинта.

### Необязательные

- `HAPI_LISTEN_HOST` — адрес привязки HTTP (по умолчанию: 127.0.0.1).
- `HAPI_LISTEN_PORT` — порт HTTP (по умолчанию: 3006).
- `CORS_ORIGINS` — origins через запятую или `*`.
- `HAPI_HOME` — каталог данных (по умолчанию: ~/.hapi).
- `DB_PATH` — путь к базе SQLite (по умолчанию: HAPI_HOME/hapi.db).
- `TELEGRAM_NOTIFICATION` — включить/выключить уведомления Telegram (по умолчанию: true).
- `HAPI_RELAY_API` — домен API реле (по умолчанию: relay.hapi.run).
- `HAPI_RELAY_AUTH` — явный ключ аутентификации реле. По умолчанию хаб получает и сохраняет индивидуально отзываемый ключ от реле. Сохранённый ключ, отклонённый с HTTP 403, отбрасывается и перевыпускается один раз; явно настроенный env-ключ нужно обновлять вручную.
- `HAPI_RELAY_FORCE_TCP` — форсировать режим реле TCP (true/1).
- `VAPID_SUBJECT` — контактный email/URL для Web Push.
- `HAPI_ANDROID_PUSH` — `auto` (по умолчанию: прямой FCM, когда настроены учётные данные, иначе реле), `relay`, `fcm` или `off`.
- `FCM_SERVICE_ACCOUNT_PATH` — JSON сервисного аккаунта для сборок с приватным Firebase; приложение должно использовать тот же проект. Неверные настроенные учётные данные отключают Android-push вместо переключения проектов.
- `HAPI_IOS_PUSH` — `relay` (по умолчанию), `apns` или `off`.
- `HAPI_PUSH_RELAY_URL` — общее push-реле Android/iOS (по умолчанию: `https://push.hapi.run`; сохраняется как `iosPushRelayUrl`). Не зависит от сетевого туннеля `--relay`.
- `HAPI_SESSION_IDLE_TIMEOUT_MS` — окно keep-alive-idle в мс (по умолчанию: 43200000 / 12 ч; `0` отключает). См. «Живость сессии» ниже.

Официальные нативные приложения регистрируют свои ключи шифрования автоматически;
настройка push-провайдера на свежем хабе не требуется. См. [контракт push нативного
компаньона](../docs/api/native-companion-contract.md) (англ.).

## Запуск

Бинарник (единый исполняемый файл):

```bash
export TELEGRAM_BOT_TOKEN="..."
export CLI_API_TOKEN="shared-secret"
export HAPI_PUBLIC_URL="https://your-domain.example"

hapi hub
```

`hapi server` по-прежнему поддерживается как псевдоним.

Для веб/нативных клиентов + CLI можно опустить TELEGRAM_BOT_TOKEN.
Чтобы включить Telegram, задайте TELEGRAM_BOT_TOKEN и HAPI_PUBLIC_URL, запустите хаб, откройте `/app`
в чате с ботом и привяжите Mini App через `CLI_API_TOKEN:<namespace>` по запросу.

Из исходников:

```bash
bun install
bun run dev:hub
```

## HTTP API

Ниже — обзор. Формы запросов/ответов и семантику ошибок см. в [контракте клиента](../docs/api/client-contract/index.md) (англ.),
а все эндпоинты — в `src/web/routes/`.

### Аутентификация (`src/web/routes/auth.ts`, `src/web/routes/bind.ts`)

- `POST /api/auth` — получить JWT-токен (Telegram initData или `CLI_API_TOKEN[:namespace]`).
- `POST /api/bind` — привязать аккаунт Telegram через initData + `CLI_API_TOKEN:<namespace>`.

### Сессии (`src/web/routes/sessions.ts`)

- `GET /api/sessions` — список всех сессий. Каждая сводка включает `hasConversationContent`, выводимый из сохранённых сообщений разговора (не из заголовков или событий жизненного цикла); полные SSE-обновления сессии несут изменения этого флага.
- `GET /api/sessions/:id` — детали сессии.
- `POST /api/sessions/:id/abort` — прервать сессию.
- `POST /api/sessions/:id/switch` — передать управление сессией вебу.
- `POST /api/sessions/:id/resume` — возобновить неактивную сессию.
- `POST /api/sessions/:id/reopen` — открыть сессию заново; следуйте возвращённому id сессии.
- `POST /api/sessions/:id/clear` — начать новый разговор, когда поддерживается.
- `POST /api/sessions/:id/upload` — загрузить файл (base64, максимум 50 МБ).
- `POST /api/sessions/:id/upload/delete` — удалить загруженный файл.
- `POST /api/sessions/:id/archive` — архивировать активную сессию.
- `PATCH /api/sessions/:id` — переименовать сессию.
- `DELETE /api/sessions/:id` — удалить неактивную сессию.
- `GET /api/sessions/:id/slash-commands` — список slash-команд.
- `GET /api/sessions/:id/skills` — список навыков.
- `POST /api/sessions/:id/permission-mode` — задать режим разрешений.
- `POST /api/sessions/:id/model` — задать предпочтение модели.
- `POST /api/sessions/:id/effort` — задать усилие для Claude, Grok или Pi; другие элементы конфигурации зависят от flavor/возможностей (см. контракт клиента).
- `GET/POST /api/sessions/:id/scratchlist` — читать/создавать записи заметок, сохраняемые хабом; маршруты обновления/удаления и вложений используют этот же префикс.

### Сообщения (`src/web/routes/messages.ts`)

- `GET /api/sessions/:id/messages` — получить сообщения (с пагинацией).
- `POST /api/sessions/:id/messages` — отправить сообщение.
- `POST /api/sessions/:id/messages/queued-state` — согласовать локальные id в очереди, неопределённые и вызванные.
- `DELETE /api/sessions/:id/messages/:messageId` — отменить сообщение в очереди.
- `POST /api/sessions/:id/messages/:messageId/steer` — направить сообщение очереди, когда сессия это поддерживает.
- `POST /api/sessions/:id/messages/:messageId/retry` — явно повторить неопределённую доставку, когда это безопасно; никогда не воспроизводить автоматически.

### Разрешения (`src/web/routes/permissions.ts`)

- `POST /api/sessions/:id/permissions/:requestId/approve` — одобрить разрешение.
- `POST /api/sessions/:id/permissions/:requestId/deny` — отклонить разрешение.

### Машины (`src/web/routes/machines.ts`)

- `GET /api/machines` — список машин онлайн.
- `PATCH /api/machines/:id` — задать/очистить отображаемое имя машины.
- `GET /api/machines/:id/agent-availability` — список установленных/настроенных агентов.
- `POST /api/machines/:id/spawn` — запустить новую сессию на машине.
- `POST /api/machines/:id/list-directory` — просмотреть каталоги в области раннера.
- `POST /api/machines/:id/paths/exists` — проверить существование пути.
- `POST /api/machines/:id/restart-runner` — запросить перезапуск раннера (требуется доступный путь перезапуска).

### Использование (`src/web/routes/usage.ts`)

- `GET /api/usage/summary` — получить использование токенов с учётом кеша для пространства имён владельца (`range=7d|30d|all`).

### Хранилище (`src/web/routes/storage.ts`)

- `GET /api/storage/sqlite` — размеры базы SQLite/WAL/SHM для пространства имён владельца.

### Git/файлы (`src/web/routes/git.ts`)

- `GET /api/sessions/:id/git-status` — статус git.
- `GET /api/sessions/:id/git-diff-numstat` — сводка диффа.
- `GET /api/sessions/:id/git-diff-file` — дифф по конкретному файлу.
- `GET /api/sessions/:id/file` — прочитать содержимое файла.
- `GET /api/sessions/:id/files` — поиск файлов через ripgrep.

### События (`src/web/routes/events.ts`)

- `GET /api/events` — поток SSE для живых обновлений.
- `POST /api/visibility` — сообщить состояние видимости клиента.

### Голос (`src/web/routes/voice.ts`)

- `POST /api/voice/token` — получить токен разговора ElevenLabs.
- `GET /api/voice/backend` — обнаружить настроенные бэкенды ассистента.
- `GET /api/voice/voices` — список голосов для выбранного бэкенда.
- `GET/PUT /api/voice/transcription/credentials` — прочитать маскированные настройки провайдера или обновить учётные данные (только владелец).
- `GET /api/voice/transcription/providers` — список настроенных провайдеров и поддерживаемых режимов.
- `POST /api/voice/transcription` — транскрибировать ограниченную запись.
- `POST /api/voice/transcription/realtime-token` — выпустить короткоживущие учётные данные OpenAI, ElevenLabs или Deepgram.

### Push-уведомления (`src/web/routes/push.ts`)

- `GET /api/push/vapid-public-key` — получить публичный ключ VAPID.
- `POST /api/push/subscribe` — подписаться на push-уведомления.
- `DELETE /api/push/subscribe` — отписаться.

Регистрация нативных Android/iOS использует `POST`/`DELETE /api/devices/register`
(`src/web/routes/devices.ts`); см. [контракт нативного push](../docs/api/native-companion-contract.md) (англ.).

### CLI (`src/web/routes/cli.ts`)

- `POST /cli/sessions` — создать/загрузить сессию.
- `GET /cli/sessions/:id` — получить сессию по ID.
- `POST /cli/machines` — создать/загрузить машину.
- `GET /cli/machines/:id` — получить машину по ID.

## Socket.IO

Обработчики событий см. в `src/socket/handlers/cli/index.ts` и `src/socket/handlers/terminal.ts`.

Пространства имён: `/cli` (сырой токен доступа CLI) и `/terminal` (JWT клиента).
Обычные обновления сессий веба/нативных приложений используют SSE, а не пространство имён Socket.IO CLI.

### События клиента (CLI → хаб)

- `message` — отправить сообщение в сессию.
- `update-metadata` — обновить метаданные сессии.
- `update-state` — обновить состояние агента.
- `session-alive` — поддерживать сессию активной.
- `session-ready` — Cursor ACP `session/load` (или `newSession`) успешен; хаб откладывает merge/dedup до его прихода при reopen.
- `session-end` — пометить сессию завершённой.
- `machine-alive` — поддерживать машину онлайн.
- `rpc-register` — зарегистрировать обработчик RPC.
- `rpc-unregister` — снять регистрацию обработчика RPC.

### События терминала (веб → хаб, `/terminal`)

- `terminal:create` — открыть терминал для сессии.
- `terminal:write` — отправить ввод.
- `terminal:resize` — изменить размеры.
- `terminal:close` — закрыть терминал.
- `agent-terminal:subscribe` / `agent-terminal:unsubscribe` — подключить/отключить поток терминала обёрнутого агента.
- `agent-terminal:input` / `agent-terminal:resize` — взаимодействовать с этим терминалом, когда поддерживается.

### События хаба (хаб → клиенты CLI, `/cli`)

- `update` — транслировать обновления сессий/сообщений.
- `rpc-request` — входящий вызов RPC.

Маршрутизацию RPC см. в `src/socket/rpcRegistry.ts`.

## Telegram-бот

Реализацию бота см. в `src/telegram/bot.ts`.

### Команды

- `/start` — приветственное сообщение со ссылкой на Mini App.
- `/app` — открыть Mini App.

### Возможности

- Уведомления о запросах разрешений с кнопками approve/deny.
- Уведомления о готовности сессии.
- Диплинки к сессиям Mini App.

Обработчики кнопок см. в `src/telegram/callbacks.ts`.

## Основная логика

Главный менеджер сессий/сообщений см. в `src/sync/syncEngine.ts`:

- Кеш сессий в памяти с версионированием.
- Пагинация и получение сообщений.
- Одобрение/отклонение разрешений.
- Маршрутизация методов RPC через Socket.IO.
- Публикация событий в SSE и Telegram.
- Операции Git и поиск файлов.
- Отслеживание активности и таймауты.

### Живость сессии

Два отдельных сигнала — намеренно (tiann/hapi#1820):

- **`active` / `activeAt`** — транспорт. Сокет CLI подключён; `session-alive` обновляет его примерно каждые 2 с. `sessionCache.expireInactive` сбрасывает `active` после 30 с молчания.
- **`metadata.lifecycleState`** — здоровье агента. `running` -> `idle` -> `running`, плюс `archived`.

Keep-alive доказывает наличие сокета, а не агента. Поэтому сессия может отправлять heartbeat днями без сообщений, размышлений и фоновых задач — `active: true` навсегда, и `expireInactive` никогда это не поймает. `sessionCache.reconcileKeepaliveIdle` (тот же тик 5 с) закрывает этот зазор: после `HAPI_SESSION_IDLE_TIMEOUT_MS` без прогресса агента он переводит `lifecycleState` `running` -> `idle`.

- `active` намеренно не трогается. CLI действительно доступен, и его переключение позволило бы `resumeSession` запустить второго агента против живого процесса, а также разблокировало бы dedup-merge / удаление для него.
- Прогресс означает сообщение в любом направлении, запрос в очереди или фоновую задачу — но никогда keep-alive. Сессии, которые думают, выполняют фоновые задачи или держат ожидающий запрос разрешения, не помечаются никогда.
- `idle` возвращается в `running` при следующем прогрессе, в пределах одного тика.
- `metadata.idleReconcileExempt: true` полностью исключает сессию.

## Хранилище

Постоянное хранение SQLite см. в `src/store/index.ts`:

- Сессии с метаданными и состоянием агента.
- Сообщения с поддержкой пагинации.
- Машины с состоянием раннера.
- Извлечение todo из сообщений.
- Таблица users для привязок Telegram (включает пространство имён).
- Записи/вложения заметок, использование, граф работ и registrations push.

Содержимое сообщений хранится через `src/store/contentCodec.ts`: слишком большие строки
внутри сообщений агента (гигантский вывод инструмента) усекаются по голове+хвосту при приёме,
а payload ≥256 символов сжимаются zstd (TEXT = открытый JSON, BLOB =
zstd). Запросы пользователя никогда не усекаются — строки очереди доставляются в CLI
дословно.

Скрипты обслуживания (запускайте с остановленным хабом перед подменой файлов):

- `scripts/compact-db.ts` — задним числом усечь + сжать + VACUUM существующую БД
  в новый файл (источник открывается только для чтения).
- `scripts/cleanup-sessions.ts` — массовое удаление сессий по числу сообщений, glob
  пути или шаблону первого сообщения.

## Структура исходников

- `src/web/` — HTTP-сервис и маршруты.
- `src/socket/` — настройка и обработчики Socket.IO.
- `src/socket/handlers/cli/` — модульные обработчики CLI.
- `src/telegram/` — Telegram-бот.
- `src/sync/` — основная логика сессий/сообщений.
- `src/store/` — постоянное хранение SQLite.
- `src/sse/` — Server-Sent Events.
- `src/config/` — загрузка и генерация конфигурации.
- `src/notifications/` — push- и Telegram-уведомления.
- `src/visibility/` — отслеживание видимости клиентов.

## Модель безопасности

Доступ контролируется:

- Проверкой Telegram initData плюс привязанными пользователями Telegram (привязка через `CLI_API_TOKEN:<namespace>`).
- Базовым секретом `CLI_API_TOKEN` для доступа CLI и браузера (пространство имён добавляется клиентами).

Безопасность транспорта зависит от HTTPS перед хабом.

## Сборка для развёртывания

Из корня репозитория:

```bash
bun run build:hub
bun run build:web
```

Результат сборки хаба — `hub/dist/index.js`, веб-ассеты — в `web/dist`.

## Замечания по сети

- Telegram Mini Apps требуют HTTPS и публичный URL. Если у хаба нет публичного IP, используйте Cloudflare Tunnel или Tailscale и задайте `HAPI_PUBLIC_URL` как HTTPS-эндпоинт.
- Если веб-приложение размещено на другом origin, задайте `CORS_ORIGINS` (или `HAPI_PUBLIC_URL`), включив origin этого статического хоста.

## Самостоятельный веб-хостинг

Веб-UI можно разместить отдельно от хаба (например, на GitHub Pages или Cloudflare Pages):

1. Соберите и разверните `web/dist` из корня репозитория.
2. Задайте `CORS_ORIGINS` (или `HAPI_PUBLIC_URL`) как origin статического хоста.
3. Откройте статический сайт, нажмите кнопку Hub на экране входа и введите origin хаба hapi.

Пустое переопределение хаба сохраняет стандартное поведение с тем же origin, когда хаб сам отдаёт веб-ассеты.

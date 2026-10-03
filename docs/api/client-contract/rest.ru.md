# REST-эндпоинты

Таблицы эндпоинтов для нативных клиентов, сгруппированные по функциям. Формы запросов/ответов ссылаются на схемы Zod в `shared/src/schemas.ts` и `shared/src/apiTypes.ts` (пакет `@hapi/protocol`) — источник истины по полям это те схемы, а не текст здесь. Поведение маршрутов опирается на `hub/src/web/routes/*.ts`; `web/src/api/client.ts` — эталонный потребитель.

Эти таблицы описывают интерфейс хаба. [Руководство по нативным приложениям](../../guide/native-apps.md#sessions-and-everyday-use) (англ.)
фиксирует текущую поддержку в UI iOS/Android; наличие обёртки API или поля
проводного протокола само по себе не означает, что приложение предоставляет эту функцию.

## Соглашения

- Все пути ниже относительны базового URL хаба. Маршруты `/api` требуют `Authorization: Bearer <JWT>`, кроме обмена `/api/auth` и Telegram `/api/bind` ([Auth](./auth.ru.md)).
- Параметры пути (`:id`, `:messageId`, …) должны быть URL-кодированы (веб-клиент везде использует `encodeURIComponent`).
- Тела запросов — JSON (`content-type: application/json`) с **одним исключением**: `POST /api/voice/transcription` использует `multipart/form-data`. Ответы — JSON, если не указано иное (сгенерированные изображения и вложения заметок возвращают сырые байты).
- Тела валидируются Zod; сбои возвращают `400` (см. [Ошибки](./errors.ru.md)).
- **gzip:** хаб сжимает JSON-ответы `/api/*`, когда `Accept-Encoding` допускает gzip. Согласование учитывает q-значения (`acceptsGzip` в `hub/src/web/sseCompression.ts`): `gzip;q=0` соблюдается как отказ, `*` учитывается, если запись `gzip` не переопределяет его. Отправляйте обычный `Accept-Encoding: gzip` и распаковывайте прозрачно. Поток SSE сжимается gzip отдельно, со сбросом на каждое событие — см. [SSE](./sse.ru.md). Источник: `hub/src/web/server.ts`.
- Несколько эндпоинтов **обёрнуты в RPC**: хаб пересылает запрос в CLI-процесс сессии по Socket.IO и ретранслирует результат. Они могут завершиться HTTP 200 + `{success: false, error}` или 503 — см. [Ошибки](./errors.ru.md#эндпоинты-в-обёртке-rpc).

## Интерактивный клиентский API

### Health

Источник: `hub/src/web/server.ts`.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /health` (без аутентификации) | — | `{status: 'ok', protocolVersion: number, capabilities: {workGraph?, titleSuggestion?}}` — возможности аддитивны, игнорируйте неизвестные ключи |

### Сессии — список и детали

Источник: `hub/src/web/routes/sessions.ts`; формы `SessionSchema` (`shared/src/schemas.ts`), `SessionSummary` (`shared/src/sessionSummary.ts`).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/sessions` | Query: `limit?` (1–500), `order?=updatedAt` | `{sessions: (SessionSummary & {futureScheduledMessageCount, nextScheduledAt})[]}` |
| `GET /api/sessions/:id` | — | `{session: Session}` (полная запись, включая `metadata`, `agentState`, `todos`, версии) |

Порядок списка по умолчанию: globalPinned → pinned → active → число ожидающих запросов → `updatedAt` по убыванию; `order=updatedAt` даёт чистую свежесть. Бейджи списка берутся из `SessionSummary.pendingRequestsCount` (авторитетный итог) и `pendingRequests` (не более 5, от старых к новым) — не выводите счётчики из `pendingRequests.length`.

### Сессии — жизненный цикл

Источник: `hub/src/web/routes/sessions.ts`; схемы запросов в `shared/src/apiTypes.ts`.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `POST /api/sessions/:id/resume` | `{permissionMode?}` (`ResumeSessionRequestSchema`) | `{type: 'success', sessionId}` |
| `POST /api/sessions/:id/reopen` | `{}` | `{ok: true, sessionId, resumed: boolean, cursorSessionProtocol?}` (`ReopenSessionResponseSchema`); `422 {error, missing[]}`, если метаданные неполны |
| `POST /api/sessions/:id/abort` | `{}` | `{ok: true}` (только активные сессии) |
| `POST /api/sessions/:id/archive` | `{}` | `{ok: true}` или `{ok: true, alreadyArchived: true}`; 409 для обычной неактивной сессии |
| `DELETE /api/sessions/:id` | — | `{ok: true}`; 409 пока активна (сначала архивируйте) |
| `PATCH /api/sessions/:id` | `{name}` (1–255 символов) | `{ok: true}` (переименование) |
| `PATCH /api/sessions/:id/summary` | `{text}` (1–255 символов) | `{ok: true}` |
| `PUT /api/sessions/:id/pin` | `{mode: 'none'\|'project'\|'global'}` | `{ok: true}` |
| `POST /api/sessions/:id/switch` | `{}` | `{ok: true}` — передаёт сессию под управлением терминала под удалённое управление |
| `POST /api/sessions/:id/clear` | `{}` | `{sessionId}` — только общие сессии; сначала возобновите неактивные сессии через раннер, затем создайте новый корень; переходите только в инициирующем представлении |
| `POST /api/sessions/:id/title-suggestion` | — | `{title}`; ошибки проходят как 422/429/502/503 |
| `GET /api/sessions/:id/slash-commands` | — | `SlashCommandsResponse` `{success, commands?, error?}` |
| `GET /api/sessions/:id/skills` | — | Форма `SkillsResponse` `{success, ...}` |

::: warning resume / reopen могут вернуть другой sessionId
Оба эндпоинта возвращают id сессии, которая теперь несёт разговор, — он **может отличаться от id, с которым вы их вызывали** (новый запуск под новым id; старая строка вытеснена). Клиенты должны перенести черновики поля ввода и заменить навигацию на возвращённый id. Эталон: `web/src/routes/sessions/followSupersedingSession.ts`; устойчивая связь также появляется как `metadata.supersededBySessionId` у старой сессии.
:::

Дополнительные API сессий без текущего нативного UI: `POST /api/sessions/:id/fork` `{messageLocalId?}` → `{sessionId}`, `POST /api/sessions/:id/rewind` `{messageLocalId}` → `{success: true}`, `GET /api/sessions/:id/export` (413, когда слишком велико). Доступность также зависит от возможностей истории сессии.

### Сообщения

Источник: `hub/src/web/routes/messages.ts`; схемы `MessagesQuerySchema`, `SendMessageRequestSchema`, `QueuedStateRequestSchema` (`shared/src/apiTypes.ts`), ответы `CancelMessageResponseSchema`, `SteerQueuedMessageResponseSchema` (`shared/src/schemas.ts`). Неизвестный результат steer устойчив и разрешается пользователем; нативные клиенты должны реализовать те же переходы.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/sessions/:id/messages` | Query: `limit?` (1–200, по умолчанию 50), пары курсоров `beforeSeq+beforeAt` \| `afterSeq+afterAt` (+ необязательные `untilSeq+untilAt`, `epoch` с `after`) | `MessagesResponse` `{messages: DecryptedMessage[], page: {direction, limit, epoch, reset, nextBefore*/nextAfter*, snapshotHead*, hasMore}}` — полная семантика курсоров в [Pagination](./pagination.ru.md) |
| `POST /api/sessions/:id/messages` | `{text, localId?, attachments?, scheduledAt?, deliveryMode?: 'queue'\|'steer'}` — нужен текст или вложения; `scheduledAt` требует `localId`, не более 7 дней вперёд, исключает вложения и steer | `{ok: true}` — само сообщение приходит по SSE (`message-received`), согласуется по `localId` |
| `DELETE /api/sessions/:id/messages/:messageId` | — | `{status: 'cancelled', localId}` \| `{status: 'invoked', message}` \| `{status: 'busy', localId}` (отмена; `busy` = нативная доставка/удаление не разрешены) |
| `POST /api/sessions/:id/messages/:messageId/steer` | — | `{status: 'steered', localId}` \| `{status: 'invoked', message}` \| `{status: 'failed', error, localId}` |
| `POST /api/sessions/:id/messages/:messageId/retry` | — | `{status: 'retried', localId}` \| `{status: 'already-queued', localId}` \| `{status: 'retry-unavailable', localId}` \| `{status: 'invoked', message}` \| `{status: 'not-found'}` — только явный повтор; никогда не автоматическое воспроизведение |
| `POST /api/sessions/:id/messages/queued-state` | `{localIds: string[]}` (≤ 1000, без дубликатов) | `{queuedLocalIds: string[], indeterminateLocalIds: string[], invokedLocalMessages: [{localId, invokedAt}]}` — ресинхронизация после переподключения; сохраняйте неопределённые строки без автоматического воспроизведения |

Хаб проставляет `sentFrom: 'webapp'` для сообщений, отправленных через REST, на стороне сервера; в теле запроса такого поля нет.

### Разрешения

Источник: `hub/src/web/routes/permissions.ts`. Ожидающие запросы — **не сообщения**: они живут в `session.agentState.requests` (с ключом по id запроса) и переходят в `agentState.completedRequests` при разрешении — схемы `AgentStateRequestSchema` / `AgentStateCompletedRequestSchema` в `shared/src/schemas.ts`.

Завершённые запросы общих сессий Codex могут иметь `status: 'resolved'`: нативное
завершение известно, но победитель/ответ — нет. Отрисовывайте нейтральный статус, а не
«Одобрено» или предполагаемый выбор. Успешный HTTP-ответ approve лишь отправил
кандидата. `canceled` может вместо этого означать отзыв после разрыва транспорта.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `POST /api/sessions/:id/permissions/:requestId/approve` | `{mode?, allowTools?: string[], decision?, answers?}` | `{ok: true}` |
| `POST /api/sessions/:id/permissions/:requestId/deny` | `{decision?}` | `{ok: true}` |

- `decision`: `'approved' | 'approved_for_session' | 'denied' | 'abort'`.
- `mode`: необязательно переключить режим разрешений при одобрении; валидируется по flavor сессии.
- `answers` имеет **два формата**, соответствующих запрашивающему инструменту: плоский `Record<string, string[]>` (AskUserQuestion) или вложенный `Record<string, {answers: string[]}>` (request_user_input). Оба маршрута возвращают 404 `Request not found`, если id сейчас не ожидает, и 409 `session_inactive`, когда сессия неактивна.

### Конфигурация сессии — режим / модель / усилие (по flavor)

Источник: `hub/src/web/routes/sessions.ts`; гейты flavor в `shared/src/modes.ts` (`getPermissionModesForFlavor`) и `shared/src/flavors.ts` (`supportsModelChange`, `supportsEffort`). Вызовы не того flavor возвращают 400; некоторые дополнительно отклоняются с 409, когда сессия под управлением терминала (`agentState.controlledByUser === true`).

| Метод и путь | Запрос | Применяется к |
|---|---|---|
| `POST /api/sessions/:id/permission-mode` | `{mode: PermissionMode}` | Все flavor кроме `pi` и `dsh` (наборы, допускаемые для flavor, в `modes.ts`) |
| `POST /api/sessions/:id/model` | `{model: string \| {provider, modelId} \| null}` | Flavor с `supportsModelChange` (кроме `dsh`); только удалённо для codex/cursor/grok |
| `POST /api/sessions/:id/effort` | `{effort: string \| null}` | claude, grok, pi (`supportsEffort`) |
| `POST /api/sessions/:id/model-reasoning-effort` | `{modelReasoningEffort: string \| null}` | codex, opencode (только удалённо) |
| `POST /api/sessions/:id/service-tier` | `{serviceTier: 'fast' \| 'standard'}` | codex (только удалённо) |
| `POST /api/sessions/:id/collaboration-mode` | `{mode: 'default' \| 'plan'}` | codex (только удалённо) |
| `POST /api/sessions/:id/copilot-agent-mode` | `{mode}` | copilot (только удалённо) |

`metadata.capabilities.concurrentClients === true`: игнорируйте устаревший гейт
ввода/настроек `agentState.controlledByUser`. У общих keepalive нет режима
владения. `/switch` возвращает HTTP 409 с
`code: 'control_mode_not_applicable'`; не предлагайте перехват. Ограничения
конфигурации Codex «только удалённо» выше к таким сессиям не применяются.
Общий Codex отклоняет `safe-yolo`, хотя он остаётся в исторической схеме
режимов разрешений Codex; не предлагайте его для параллельных сессий.

Общий `/clear` не имеет глобального изменения `supersededBySessionId`; клиенты, кроме
вызывающего, остаются в исходном обсуждении. Fork может вернуть уже привязанного общего
потомка; хаб не должен запускать второй движок. Используйте объявленные возможности
истории: общий Codex сейчас поддерживает fork, но не rewind на месте.

Выполнение плана общего Codex: `POST /api/sessions/:id/codex/plan/implement`
с `{planId}` возвращает `{ok: true}` после принятия нативной очереди. Используйте
текущий `agentState.codexPlanProposalId`, чтобы сопоставить id вызова инструмента
предложения из транскрипта; `null` отзывает действия, не удаляя содержимое. CLI
проверяет последний завершённый ход в режиме Plan, переключается на Default и ставит
в очередь `Implement the plan.` со стабильным id отправки. Повтор принятого
действия не ставит его в очередь снова. Это отдельно от разрешений инструментов.
Ошибки включают HTTP 409 (`stale_plan` / `unavailable`), 502 (`failed`) и 503
(`indeterminate`); тела ошибок имеют `{ok: false, code, error}`. Не отправляйте
автоматически повторно после неподтверждённого результата. «Continue planning» —
это локальное действие фокуса поля ввода, оно не отправляет нативное одобрение или сообщение.

Маршруты конфигурации из таблицы выше отвечают `{ok: true}`; сбои применения возвращают 409 с сообщением. **Каталоги** моделей/усилий (обёрнуты в RPC; все возвращают `{success, ...} \| {success: false, error}`):

| Метод и путь | Примечания |
|---|---|
| `GET /api/sessions/:id/codex-models`, `/opencode-models`, `/cursor-models`, `/grok-models`, `/copilot-models`, `/kimi-models`, `/pi-models` | Активная сессия соответствующего flavor; иначе 400 |
| `GET /api/sessions/:id/opencode-reasoning-effort-options`, `/grok-reasoning-effort-options` | Тот же шаблон |
| `GET /api/machines/:id/agy-models`, `/pi-models`, `/codex-models`, `/cursor-models` | Уровень машины (пикеры до запуска). `agy-models` принимает `?refresh=true`, чтобы пропустить кешированный каталог машины, и может ответить `success: true` с рекомендательной `error` (см. [Ошибки](./errors.ru.md#эндпоинты-в-обёртке-rpc)) |
| `GET /api/machines/:id/opencode-models?cwd=`, `/grok-models?cwd=`, `/copilot-models?cwd=`, `/kimi-models?cwd=` | Query `cwd` обязателен (400 без него) |

### Машины и запуск

Источник: `hub/src/web/routes/machines.ts`; схемы `SpawnSessionRequestSchema`, `MachineListDirectoryRequestSchema`, `MachinePathsExistsRequestSchema`, `RenameMachineRequestSchema` (`shared/src/apiTypes.ts`), `MachineSchema` (`shared/src/schemas.ts`).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/machines` | — | `{machines: Machine[]}` (машины онлайн в пространстве имён вызывающего) |
| `PATCH /api/machines/:id` | `{displayName}` (обрезается; ≤ 64 символов; пустое возвращает к hostname) | `{ok: true}` |
| `GET /api/machines/:id/agent-availability` | — | `{agents: {agent, available, reason?: 'not_found'\|'invalid_configuration'}[]}`; 409 `runner_upgrade_required` на старых раннерах |
| `POST /api/machines/:id/spawn` | `{directory, agent?, model?, effort?, modelReasoningEffort?, yolo?, permissionMode?, sessionType?: 'simple'\|'worktree', worktreeName?, serviceTier?, collaborationMode?, copilotAgentMode?, startingMode?: 'remote'\|'pty'}` | `{type: 'success', sessionId}` \| `{type: 'error', message, code?, agent?}` (agy принимает только `remote`) |
| `POST /api/machines/:id/list-directory` | `{path, includeHidden?}` | `{success, entries?: (DirectoryEntry & {isGitRepo?})[], error?}` |
| `POST /api/machines/:id/paths/exists` | `{paths: string[]}` (≤ 1000) | `{exists: Record<string, boolean>, outsideWorkspaceRoots?: string[]}` |
| `POST /api/machines/:id/restart-runner` | `{}` | `{message}`; ошибки несут `code: 'machine_not_found' \| 'machine_offline'` |

Обратите внимание: ответ spawn различается по `type`, а не по HTTP-статусу — неудачный
spawn всё равно HTTP 200. Стабильные коды сбоя spawn:
`agent_unavailable`, `runner_upgrade_required` и
`outside_workspace_roots`. Клиенты должны запрашивать доступность агентов при выборе
машины и использовать этот результат для построения формы. Раннер выполняет
авторитетную проверку доступности в рамках запуска, покрывая изменения
после запроса на уровне формы без дублирующего клиентского RPC.
Проверка доступности охватывает только исполняемые файлы и статическую конфигурацию раннера;
она не запускает агента и не проверяет состояние аккаунта/входа.

Листинг каталогов и запуск используют одну и ту же политику корней рабочего пространства.
Без `metadata.workspaceRoots` пути не ограничены сверх прав файловой системы
аккаунта раннера; `metadata.homeDir` — лишь предложенное место старта.
Явные корни ограничивают обе операции, после канонического разрешения симлинков.
Листинги классифицируют допустимые симлинки-каталоги как каталоги и опускают ссылки,
чьи цели выходят за настроенные корни. Записи с точкой в начале требуют
`includeHidden: true`. Клиенты автодополнения могут предлагать известные корни рабочего
пространства из метаданных, пока пользователь вводит префикс, не показывая
выходящий за границы родительский каталог корня.

### Git и файлы (обёрнуты в RPC)

Источник: `hub/src/web/routes/git.ts`. Эндпоинты Git возвращают **сырой вывод команды** — `GitCommandResponse` `{success, stdout?, stderr?, exitCode?, error?}` — и клиент сам разбирает `stdout` (эталонные парсеры: `web/src/lib/gitParsers.ts`).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/sessions/:id/git-status` | — | `GitCommandResponse` (сырой stdout `git status`) |
| `GET /api/sessions/:id/git-diff-numstat` | Query: `staged=true\|false` | `GitCommandResponse` (сырой stdout `git diff --numstat`) |
| `GET /api/sessions/:id/git-diff-file` | Query: `path` (обязателен), `staged?` | `GitCommandResponse` (сырой unified diff) |
| `GET /api/sessions/:id/file` | Query: `path` (обязателен) | `{success, content?, size?, modified?, error?}` — `content` в **base64** (декодируйте перед отображением; веб-эталон: `web/src/routes/sessions/file.tsx`) |
| `GET /api/sessions/:id/files` | Query: `query?`, `limit?` (1–500, по умолчанию 200) | `{success, files: [{fileName, filePath, fullPath, fileType: 'file', size?, modified?}]}` (поиск на базе ripgrep) |
| `GET /api/sessions/:id/directory` | Query: `path?` (пусто = корень сессии) | `{success, entries?: [{name, type: 'file'\|'directory'\|'other', size?, modified?}], error?}` |

Когда у сессии ещё нет `metadata.path`, эти маршруты возвращают HTTP 200 `{success: false, error: 'Session path not available'}`.

### Сгенерированные изображения

Источник: `hub/src/web/routes/git.ts` (тот же файл).

| Метод и путь | Ответ |
|---|---|
| `GET /api/sessions/:id/generated-images/:imageId` | **Сырые байты** с `Content-Type`, `Content-Disposition`, `ETag: "<imageId>"`, `Cache-Control: private, max-age=31536000, immutable`; `404` JSON, если нет |

Id изображения — неизменяемый отпечаток содержимого, поэтому он же служит ETag: отправьте `If-None-Match`, и хаб ответит `304` *без* round-trip к CLI. Кешируйте агрессивно (iOS: URLCache учитывает это автоматически; Android: кеш OkHttp).

### Загрузки (вложения сообщений)

Источник: `hub/src/web/routes/sessions.ts` (`UploadFileRequestSchema`).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `POST /api/sessions/:id/upload` | JSON `{filename, content, mimeType}` — `content` в **base64**; лимит декодированного размера 50 МБ → `413` | `{success, path?, error?}` — передайте полученные метаданные в `attachments` при отправке сообщения |
| `POST /api/sessions/:id/upload/delete` | `{path}` | `{success, error?}` |

Загрузки — JSON+base64, **не** multipart. Обе требуют активной сессии.

### Заметки (Scratchlist)

Источник: `hub/src/web/routes/sessions.ts` (раздел scratchlist); схемы `ScratchlistEntryCreateRequestSchema`, `ScratchlistEntryUpdateRequestSchema`, лимиты `SCRATCHLIST_MAX_ENTRIES = 200`, `SCRATCHLIST_MAX_TEXT_LENGTH = 10000` (`shared/src/apiTypes.ts`).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/sessions/:id/scratchlist` | — | `{entries: ScratchlistEntry[]}` (`{entryId, text, createdAt, updatedAt, attachments[]}`) |
| `POST /api/sessions/:id/scratchlist` | `{text, entryId?, createdAt?, attachments?}` (текст ≤ 10 000; нужен текст или вложения) | `201 {entry}`; `200 {entry}`, когда `entryId` уже существует (идемпотентный повтор); `409 code: 'scratchlist_at_cap'` при 200 записях |
| `PUT /api/sessions/:id/scratchlist/:entryId` | `{text?, attachments?}` (хотя бы одно) | `{entry}` |
| `DELETE /api/sessions/:id/scratchlist/:entryId` | — | `{ok: true}` |
| `GET /api/sessions/:id/scratchlist/limits` | — | `{limits}` (бюджеты размера/числа/байтов вложений) |
| `POST /api/sessions/:id/scratchlist/upload` | JSON `{filename, content (base64), mimeType}` | `{success, attachment}`; `413 code: 'scratchlist_attachment_too_large'` |
| `GET /api/sessions/:id/scratchlist/attachments/:attachmentId` | — | **Сырые байты** (`Content-Type` из сохранённых метаданных) |
| `DELETE /api/sessions/:id/scratchlist/attachments/:attachmentId` | — | `{ok: true}`; `409 code: 'scratchlist_attachment_in_use'`, пока на неё ссылается запись |

Мутации увеличивают `scratchlistUpdatedAt` в SSE-патче сессии — используйте его как триггер перезапроса, а не как данные.

### Голосовая диктовка (единственный multipart-эндпоинт)

Источник: `hub/src/web/routes/voice.ts`.

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/voice/transcription/providers` | — | `{providers: [{id, label, modes}]}` — только провайдеры, чьи ключи настроены на хабе |
| `POST /api/voice/transcription` | `multipart/form-data`: `file` (аудио, ≤ 25 МБ, `audio/*` или webm/mp4), `provider` (`openai`\|`elevenlabs`\|`deepgram`\|`groq`\|`openai-compatible`), `mode` = `standard`, `language?` (в духе BCP-47, ≤ 35 символов) | `{text, language?}`; `413` тело слишком большое, `400` неверное поле |

Нативные приложения сейчас используют только стандартную транскрипцию. Диктовка в реальном
времени, токены голосового ассистента и WebSocket-прокси используются веб-интерфейсом голоса;
см. [Другие интерфейсы хаба](#другие-интерфейсы-хаба).

### Использование и хранилище (только владелец)

Источник: `hub/src/web/routes/usage.ts`, `hub/src/web/routes/storage.ts`. Оба дают `403`, если пространство имён не `default` ([Auth → Пространства имён](./auth.ru.md#пространства-имён)).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `GET /api/usage/summary` | Query: `range=7d\|30d\|all` (по умолчанию 7d), `timeZone` (IANA, валидируется) | `UsageSummaryResponse` `{range, totals, daily[], byAgent[], byModel[], updatedAt}` |
| `GET /api/storage/sqlite` | — | `{path, databaseBytes, walBytes, shmBytes, totalBytes}` |

### Устройства (push Android / iOS)

Источник: `hub/src/web/routes/devices.ts`; полный контракт push в [`native-companion-contract.md`](../native-companion-contract.ru.md).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `POST /api/devices/register` | `{token, platform: 'phone'\|'wear'\|'ios', deviceId, pushKey?}` (deviceId: любой стабильный id установки 1–128 символов) | `{ok: true}` (upsert) |
| `DELETE /api/devices/register` | `{token}` | `{ok: true}` |

`pushKey` — base64 ровно из 32 байт. Он обязателен для iOS; регистрации phone
могут его не указывать для прямого FCM, но доставка через Android-реле требует
его, и текущее Android-приложение его передаёт. Переданные ключи phone валидируются;
Wear игнорирует поле. Неверные тела регистрации возвращают 400. Upsert выполняется
по ключу `(namespace, deviceId, platform)`. Значение протокола `wear` не означает,
что приложение Wear OS входит в этот репозиторий.

### Видимость

Источник: `hub/src/web/routes/events.ts` (`POST /visibility`).

| Метод и путь | Запрос | Ответ |
|---|---|---|
| `POST /api/visibility` | `{subscriptionId, visibility: 'visible'\|'hidden'}` | `{ok: true}`; `404`, когда подписка SSE исчезла |

`subscriptionId` приходит из события SSE `connection-changed` ([SSE](./sse.ru.md)). Сообщайте о переходах переднего плана/фона, чтобы хаб мог подавлять избыточные push-уведомления, пока приложение видимо подключено.

### Настройки хаба (чтение)

Источник: `hub/src/web/routes/hubSettings.ts`.

| Метод и путь | Ответ |
|---|---|
| `GET /api/hub-settings` | `{sessionSummaryContract: boolean, sessionSummaryInChat: boolean}` — читается из любого пространства имён |

### SSE

`GET /api/events` — канал реального времени: параметры подписки, рукопожатие возобновления и политика переподключения описаны в [SSE](./sse.ru.md). Его поведение gzip отличается от JSON-эндпоинтов (потоковое сжатие со сбросом на каждое событие), и это тоже описано там.

## Другие интерфейсы хаба

Эти интерфейсы есть на хабе, но не предоставляются текущими нативными
приложениями. Это инвентаризация функций, а не запрет по версии протокола. Ограничения
по типу клиента и авторизация владельца по-прежнему применяются; плоскость CLI ниже
внутренняя, и клиенты никогда не должны её использовать.

| Область | Пути | Текущее использование или ограничение |
|---------|------|---------------------------------------|
| Импорт Codex Desktop | `/api/codex/*` (`hub/src/web/routes/codexDesktop.ts`) | Инструменты импорта с десктопа |
| Импорт сессий Pi | `/api/pi/*`, `/api/sessions/:id/pi-*` (`hub/src/web/routes/piSessions.ts`, `sessions.ts`) | Инструменты импорта (каталог `pi-models` выше — единственное исключение) |
| Граф работ | `/api/work-graph/*` (`hub/src/web/routes/workGraph.ts`) | Функция только для веба |
| Web Push | `/api/push/*` (`hub/src/web/routes/push.ts`) | Browser Push API; нативные приложения используют `/api/devices/register` (контракт push Android/iOS) |
| Запись настроек хаба | `PUT /api/hub-settings` | Администрирование хаба только владельцем |
| Telegram | `POST /api/bind` | Только привязка Telegram Mini App |
| Веб-голос | `/api/voice/token`, `/voices`, `/backend`, `/gemini-token`, `/qwen-token`, `/qwen-ws`, `/gemini-ws`, `/transcription/realtime-token`, `/telemetry`, эндпоинты учётных данных | Ассистент/диктовка в реальном времени и администрирование провайдеров; нативные приложения используют стандартную диктовку |
| Обслуживание Cursor | `/api/sessions/:id/migrate-to-acp`, `/cursor-chat-store` | Миграция десктопного хранилища |
| Экспорт сессии | `GET /api/sessions/:id/export` | Экспорт всей сессии через веб; отдельно от экспорта файла полнотекстового просмотра Android |
| **Плоскость CLI** | `/cli/*` (`hub/src/web/routes/cli.ts`) | **Запрещено для клиентов** — внутренний интерфейс CLI↔хаб; аутентифицируется сырым токеном доступа вместо JWT и обходит клиентский middleware. Никогда не вызывайте его из клиента и никогда не отправляйте токен доступа как bearer где-либо, кроме JSON-тела `POST /api/auth` |

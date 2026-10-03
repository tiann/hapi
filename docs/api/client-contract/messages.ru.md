# Дерево декодирования сообщений

**Аудитория:** разработчики нативных клиентов HAPI (iOS / Android). Эта страница описывает, как декодировать `DecryptedMessage.content` в отображаемую структуру чата. Это самая большая поверхность портирования — эталонный конвейер `web/src/chat/` (~4600 строк); эта страница — его контракт на уровне проводного протокола. Смежные страницы: [pagination](./pagination.ru.md) (как приходят сообщения), [sse](./sse.ru.md) (живая доставка).

Источник истины: `shared/src/schemas.ts` (`DecryptedMessageSchema`), `shared/src/messages.ts` (помощники конверта), `web/src/chat/normalize.ts`, `web/src/chat/normalizeUser.ts`, `web/src/chat/normalizeAgent.ts`, `web/src/chat/types.ts`, `hub/src/store/contentCodec.ts`.

---

## Проводная форма

```ts
type DecryptedMessage = {
  id: string                  // server uuid (optimistic rows: == localId until echoed)
  seq: number | null          // per-session insert counter
  localId: string | null      // client-generated id for optimistic reconciliation
  content: unknown            // the role-wrapped envelope — everything below
  createdAt: number           // hub receive time (epoch ms)
  invokedAt?: number | null   // when the agent consumed it (null = still queued)
  scheduledAt?: number | null // future-scheduled sends
  deliveryState?: 'indeterminate' // steer dispatched, outcome unproven; explicit retry/cancel required
}
```

`content` намеренно имеет тип `unknown` на проводе. **Декодирование должно быть тотальным**:
никогда не падайте на незнакомом содержимом. Используйте строковые запасные варианты для
неизвестных конвертов и следуйте приведённым ниже правилам пропуска/валидации для
известных транспортных записей (см. [Правила запасного варианта](#правила-запасного-варианта)).

---

## Конверт

`content` — конверт с обёрткой роли:

```ts
{ role: 'user' | 'agent', content: <payload>, meta?: unknown }
```

Алгоритм разворачивания (`unwrapRoleWrappedRecordEnvelope`, `shared/src/messages.ts`) — запись подходит, когда у неё есть строковый `role` и ключ `content`; если сам `content` не подходит, проверяйте по порядку:

1. `content.message`
2. `content.data.message`
3. `content.payload.message`

Конверт не найден ⇒ отрисуйте **весь** `content` как строковый текст агента. `role`, отличный от `user`/`agent`, ⇒ преобразуйте `record.content` в строку как текст агента.

### `meta`

Непрозрачная запись; передавайте её дальше. Известные ключи:

| Ключ | Значения | Значение |
|---|---|---|
| `sentFrom` | `'webapp'`, `'telegram-bot'`, `'cli'`, … | Источник сообщения пользователя. **`'cli'` помечает трафик эха CLI**: текст пользователя/ассистента, содержащий теги `<command-name>`, `<command-args>`, `<command-message>` или `<local-command-stdout>`, отрисовывается как моноширинный блок *cli-output*, а не как пузырь чата, а блок `<command-name>` сливается со своим продолжением `<local-command-stdout>` (`web/src/chat/reducerCliOutput.ts`). |
| `deliveryMode` | `'queue'` \| `'steer'` | Устойчивое намерение доставки пользовательской отправки (см. [pagination](./pagination.ru.md#ограничения-отправки)). Отсутствует = `queue`. |

---

## Дерево декодирования

```
DecryptedMessage.content
└─ unwrap envelope → { role, content: payload, meta? }
   ├─ role: 'user'
   │   ├─ payload is string                → user text
   │   ├─ payload {type:'text', text, attachments?} → user text (+ attachments)
   │   └─ anything else                    → user text (stringified payload)
   └─ role: 'agent' — dispatch on payload.type
       ├─ 'codex'   → generic agent family        (payload.data.type dispatch)
       ├─ 'output'  → Claude SDK passthrough + agy (payload.data.type dispatch)
       ├─ 'event'   → AgentEvent union             (payload.data)
       └─ unknown   → agent text (stringified payload)
```

---

## Payload с `role: 'user'`

Эталон: `web/src/chat/normalizeUser.ts`.

| Payload | Результат |
|---|---|
| «голая» `string` | текст пользователя |
| `{type:'text', text: string, attachments?: AttachmentMetadata[]}` | текст пользователя с вложениями. Каждое вложение принимается только когда присутствуют `id`, `filename`, `mimeType` (строки), `size` (число), `path` (строка); необязательный `previewUrl`. Неверные записи пропускаются, пустой результат означает «нет вложений». |
| что-либо иное | текст пользователя = строковый payload (**никогда не отбрасывайте**) |

---

## `role: 'agent'` — семейство `'codex'`

`payload.type === 'codex'` (`AGENT_MESSAGE_PAYLOAD_TYPE`, `shared/src/modes.ts:8`) — это **общий конверт агента**, используемый flavor без Claude SDK (codex, gemini, cursor, copilot, grok, opencode, pi, kimi; agy использует семейство `'output'` ниже). Диспетчеризация по `payload.data.type` (`web/src/chat/normalizeAgent.ts`):

| `data.type` | Поля payload | Отрисовывается как |
|---|---|---|
| `message` | `message: string`, `id?` (id потока), `streamSnapshot?` | Текст агента. Если текст — «голый» JSON-объект с маркерами ревью (`findings` / `overall_correctness` / `overall_explanation`), вместо этого разберите его как блок **codex review** — если только это не снимок потока Pi (`streamSnapshot: true` или `id`, совпадающий с `/^pi-.+-turn-\d+-message-\d+-text-\d+$/`), который всегда является обычным текстом. |
| `reasoning` | `message: string`, `id?` | Блок рассуждений (thinking). |
| `error` | `message: string` | Строка события ошибки. |
| `tool-call` | `callId`, `name?`, `input?`, `description?`, `nativeTitle?/title?`, `nativeKind?/kind?`, `progress?` | Открыть карточку инструмента с ключом `callId`. |
| `tool-call-result` | `callId`, `output`, `is_error?` | Завершить карточку инструмента с тем же `callId`. |
| `generated-image` | `imageId`/`image_id`, `fileName`/`file_name`, `mimeType`/`mime_type`, `id?`, `source?` | Встроенное сгенерированное изображение (загружать через REST-эндпоинт изображений). Нет `imageId` ⇒ отбросить. |
| `context_compacted` | `trigger?`, `preTokens`/`pre_tokens` | Строка события `compact`. |
| `compact-summary` | `summary`, `tokensBefore?`, `estimatedTokensAfter?` | Строка события `compact-summary`. |
| `token_count` | `info: {last \| total \| …}`, `thread_id?`, `scope?` | Образец использования (событие). Предпочитайте `info.last*` вместо `info.total*`; `context_tokens` откатывается к `input_tokens`; `modelContextWindow` → `context_window`. Неразбираемое использование ⇒ отбросить. |
| `thread_goal_updated` | `goal {threadId, objective, status, tokenBudget?, tokensUsed?, timeUsedSeconds?, createdAt?, updatedAt?}`, `threadId?`, `turnId?` | Событие `thread-goal-updated`. `status` ∈ `active\|paused\|budgetLimited\|usageLimited\|blocked\|complete`; неверная цель ⇒ отбросить. |
| `thread_goal_cleared` | `threadId?` | Событие `thread-goal-cleared`. |
| `plan` | `entries`/`items`/`steps`: список шагов | Синтетическая завершённая пара инструментов `update_plan` (flavor cursor). Шаги принимают `step\|content\|text\|title\|description` + `status\|state` (нормализуется к `pending\|in_progress\|completed`). Пустой план ⇒ отбросить. |
| `plan_update` | `plan`/`update`/`items`/`steps` | То же, flavor codex. |
| `agent-run-start` / `agent-run-update` / `agent-run-trace` | payload запуска | Строки событий фонового запуска агента (окно отдельное, см. [pagination](./pagination.ru.md#клиентское-окно-нормативная-рекомендация)). |
| *что-либо иное* | — | **Молча отбросить** (`normalize.ts`: неизвестное содержимое codex возвращает `null`, а не строковый пузырь). |

Пары полей snake_case/camelCase выше принимаются обе — всегда проверяйте обе.

---

## `role: 'agent'` — семейство `'output'` (сквозная передача Claude SDK)

`payload.data` — запись лога Claude Code SDK, переданная дословно. Поля уровня конверта у `data`: `uuid`, `parentUuid`, `isSidechain?`, `parentToolUseId?`, `timestamp?` (часы машины выполнения в ISO-8601 — разберите в epoch ms, при сбое используйте `createdAt`), и флаги ниже.

**Фильтры пропуска — вычисляются первыми** (`isSkippableAgentContent` / `isClaudeChatVisibleMessage`):

- `data.isMeta` или `data.isCompactSummary` истинны ⇒ скрыто.
- `data.type === 'rate_limit_event'` или `'tool_progress'` ⇒ скрыто.
- `data.type === 'system'` с `subtype`, **не** входящим в `{api_error, turn_duration, microcompact_boundary, compact_boundary, away_summary}` ⇒ скрыто.
- Пустой `away_summary` / пустой `agy_message` ⇒ скрыто.

Затем диспетчеризация по `data.type`:

### `assistant`

`data.message` = `{model?, content, usage?}`. `content` — строка (⇒ один текстовый блок) или массив блоков:

| Блок | Поля | Отрисовывается как |
|---|---|---|
| `text` | `text` | текст агента |
| `thinking` | `thinking` | рассуждения |
| `tool_use` | `id`, `name`, `input` | открытие карточки инструмента (соглашение `description`: `input.description`, когда есть) |

Прочие типы блоков игнорируются. `message.usage` несёт `input_tokens`, `output_tokens`, `cache_creation_input_tokens?`, `cache_read_input_tokens?`, `service_tier?`, `context_window?`.

### `user`

Несмотря на имя, они приходят по пути агента (результаты инструментов и системно внедрённые ходы). Случаи `data.message.content`:

| Случай | Отрисовывается как |
|---|---|
| массив с блоками `tool_result` `{tool_use_id, content, is_error?, permissions?}` | завершение карточки инструмента. Предпочитайте `data.toolUseResult` уровня записи вместо `content` блока, когда он есть. `permissions` = `{date, result:'approved'\|'denied', mode?, allowedTools?, decision?}` — слейте в состояние разрешений карточки инструмента. |
| строковый content (любой), либо sidechain-массив текста | **маркер sidechain** `{prompt}` — промпты субагентов и системно внедрённые ходы; группируйте под карточкой родительского инструмента Task по `parentToolUseId` (запасной вариант: точное совпадение промпта). |
| не-sidechain массив, *целиком* из блоков `text` | настоящее сообщение пользователя, которое CLI обернул как output ⇒ отрисовывайте в полосе **пользователя**. |
| блоки `text` вперемешку с результатами инструментов | текстовые блоки агента. |

### Подтипы `system` → строки событий

| `subtype` | Поля | Событие |
|---|---|---|
| `api_error` | `retryAttempt`, `maxRetries`, `error` | `api-error` |
| `turn_duration` | `durationMs`, `messageId?` | `turn-duration {durationMs, targetMessageId?}` |
| `microcompact_boundary` | `microcompactMetadata {trigger, preTokens, tokensSaved}` | `microcompact` |
| `compact_boundary` | `compactMetadata {trigger, preTokens}` | `compact` |
| `away_summary` | `content: string` | `recap {text}` |

### `summary`

`data.summary: string` ⇒ блок содержимого «сводка разговора».

### agy (Antigravity) — тоже в семействе `'output'`

| `data.type` | Отрисовывается как |
|---|---|
| `agy_message` | Текст агента (`data.content`, `data.model?` на ход). Пусто ⇒ пропустить. Текст, начинающийся с `Inside the task-NNN log` ⇒ компактный чип `AgyTaskLog` (синтетическая завершённая пара инструментов). Отражённые сырые результаты задач (трейлер `[Message] timestamp=…`) удаляются из текста. |
| `agy_tool_action` | Синтетическая **завершённая** пара инструментов (tool-call + tool-result с тем же id — предпочитайте `data.toolUseId`, откатываясь к id сообщения). `name === 'SYSTEM_MESSAGE'` ⇒ карточка фоновой задачи `AgyAsyncTask`; `name === 'ERROR_MESSAGE'` ⇒ карточка `AgyError` (`is_error: true`); иначе сопоставьте имена инструментов agy каноническим (`run_command`→Bash, `view_file`→Read, `write_to_file`→Write, `replace_file_content`→Edit, `grep_search`→Grep, `list_dir`→LS) и переведите ключи аргументов (`CommandLine`→`command`, `TargetFile`→`file_path`, …), удаляя преамбулы/трейлеры результатов agy. Точные правила удаления см. в `normalizeAgent.ts`. |

### Неизвестные типы `'output'`

Видимый `data.type`, не сопоставленный выше ⇒ запасной вариант со строковым текстом агента (в отличие от семейства codex, которое отбрасывает).

---

## `role: 'agent'` — семейство `'event'`

`payload.data` — один `AgentEvent` (`web/src/chat/types.ts`, строки 17–36). Объединение **открытое** — последний член это `{type: string} & Record<string, unknown>`; терпите неизвестные типы (рисуйте обобщённо или игнорируйте, никогда не падайте).

| `type` | Поля |
|---|---|
| `switch` | `mode: 'local' \| 'remote'` |
| `message` | `message: string` |
| `error` | `message: string` |
| `title-changed` | `title: string` |
| `limit-reached` | `endsAt: number`, `limitType: string` |
| `limit-warning` | `utilization: number` (0–1), `endsAt`, `limitType` |
| `ready` | — |
| `api-error` | `retryAttempt`, `maxRetries`, `error: unknown` |
| `turn-duration` | `durationMs`, `targetMessageId?` |
| `microcompact` | `trigger`, `preTokens`, `tokensSaved` |
| `compact` | `trigger`, `preTokens` |
| `compact-summary` | `summary`, `tokensBefore?`, `estimatedTokensAfter?` |
| `recap` | `text` |
| `thread-goal-updated` | `goal: ThreadGoal`, `threadId?`, `turnId?` |
| `thread-goal-cleared` | `threadId?` |
| `abort-restore` | `text` |
| *(catch-all)* | `{type: string, …}` |

Несколько строк событий также синтезируются двумя другими семействами (подтипы system, `context_compacted`, `token-count`, `agent-run-*`) — рендерер должен обрабатывать их единообразно. Примечание: строки `message` семейства `event`, чей текст является статусной строкой `Goal …`, фильтруются **хабом** при приёме и из REST-страниц (`isRedundantGoalStatusEventContent`, `shared/src/messages.ts`); клиентам не нужно особой обработки.

---

## Правила запасного варианта

| Ситуация | Поведение |
|---|---|
| Нет разворачиваемого конверта | строковый весь `content` как текст агента |
| `role` не `user`/`agent` | строковый `record.content` как текст агента |
| Payload пользователя не распознан | строковый как текст пользователя |
| Семейство `'codex'`, неизвестный `data.type` | **отбросить** (не возвращать ничего) |
| Семейство `'output'`, скрыт фильтрами пропуска | **отбросить** |
| Семейство `'output'`, видимый, но неизвестный `data.type` | строковый как текст агента |
| Семейство `'event'`, у `data` нет строкового `type` | строковый как текст агента |

«Строковый» = стабильная JSON-сериализация (веб: `safeStringify`), отрисованная как
обычный текст. У известных типов событий также есть перечисленные выше правила
валидации/пропуска пустого содержимого (например, изображение без ID или неразбираемое
использование). Эталонными являются золотые фикстуры и нормализатор; не превращайте эти
транспортные записи в запасные пузыри чата.

---

## Маркер усечения

При приёме хаб обрезает голову+хвост строк длиннее `64 * 1024`
**единиц UTF-16** (`String.length`, а не байт) внутри содержимого роли агента
(`hub/src/store/contentCodec.ts`): первые `48 * 1024` единиц +
`\n…[hapi: truncated N chars]…\n` + последние `12 * 1024` единиц. Содержимое роли
пользователя никогда не усекается (оно доставляется CLI дословно). Операция
идемпотентна и применяется глубоко (массивы/объекты).

Клиенты должны отрисовывать усечённые строки как есть (распознавание маркера
`…[hapi: truncated N chars]…` — необязательная полировка), не должны считать результаты
инструментов полными и никогда не должны спотыкаться о маркер.

---

## Запросы разрешений — НЕ сообщения

Ожидающие одобрения инструментов никогда не появляются в потоке сообщений. Они живут в объекте сессии (`shared/src/schemas.ts`):

```ts
session.agentState = {
  requests?:          Record<requestId, { tool: string, toolCallId?: string, arguments: unknown, createdAt?: number | null }>
  completedRequests?: Record<requestId, {
    tool, toolCallId?: string, arguments, createdAt?, completedAt?,
    status: 'canceled' | 'denied' | 'approved' | 'resolved',
    reason?, mode?, allowTools?: string[],
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    answers?: Record<string, string[]>                     // flat    (AskUserQuestion)
            | Record<string, { answers: string[] }>        // nested  (request_user_input)
  }>
}
```

Обновления `agentState` приходят как версионированный SSE-патч — применяйте его под гейтом версии, описанным в [sse.md](./sse.ru.md#алгоритм-версионированного-патча). Отрисовывайте ожидающие `requests` как карточки одобрения, вставленные в чат (веб-редьюсер привязывает их к соответствующему `tool_use`, когда он есть); при разрешении запись переходит в `completedRequests`, чьи `status`/`answers` дополняют состояние разрешений карточки инструмента. Решайте через `POST /api/sessions/:id/permissions/:requestId/approve` (`{mode?, allowTools?, decision?, answers?}`) или `…/deny` (`{decision?}`) — см. [rest.ru.md](./rest.ru.md). Бейджи списка сессий приходят предвычисленными в `SessionSummary.pendingRequestsCount` / `pendingRequests` (≤ 5 записей).

`resolved` означает, что нативное завершение известно, но победивший ответ/решение —
нет. Отрисовывайте нейтрально; никогда не выводите одобрение и не заполняйте ответы из
неподтверждённого локального черновика.

Сопоставляйте разрешение с транскриптом по **`entry.toolCallId ?? requestId`**,
но всегда отправляйте одобрение/отклонение по **`requestId`**. Запросы Claude в локальном
режиме используют независимые одноразовые id ответов, поэтому устаревшие ответы не могут
ответить на более поздний запрос. То же правило идентичности применяется к
синтезированным карточкам и завершённым запросам. Новый ожидающий ответ имеет приоритет
над старым завершением для этого инструмента; завершение для того же id ответа имеет
приоритет над его ожидающей записью.

В локальном режиме отправка веб-ответа удаляет доступную для действия ожидающую запись;
она не обязана немедленно создавать завершение. Только нативный результат Claude
подтверждает, какой ответ победил в гонке терминала/веба. Истечение удалённого ожидания
также удаляет ожидающую запись без одобрения или отклонения нативного промпта.

---

## Золотые фикстуры

Золотые фикстуры в `shared/fixtures/chat/` — исполняемая форма этого раздела: входные
образцы `DecryptedMessage` в паре с канонической декодированной проекцией, сгенерированные
из веб-конвейера. Реализация нативного декодирования верна, когда воспроизводит их в
точности — когда фикстуры и эта страница расходятся, побеждают фикстуры.

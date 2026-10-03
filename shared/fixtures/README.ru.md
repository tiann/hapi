# Золотые фикстуры протокола

Машинно-сгенерированные фикстуры соответствия для клиентского протокола HAPI. Источник
истины — **веб-реализация**: каждое значение `expected*` в
каждом файле получается прогоном реальной веб-реализации по вручную написанным входным
данным провода, затем применением нормативной проекции, которую документирует каждый набор
ниже. Нативные клиенты (iOS `HapiProtocol`, Android
`:core:protocol`) портируют ту же логику и должны воспроизводить ожидания
из входных данных в точности.

Три набора:

| Набор | Фиксирует | Источник истины в вебе |
|-------|-----------|------------------------|
| `chat/` | конвейер декодирования/отрисовки сообщений (normalize → reduce → group) | `web/src/chat/` |
| `sse/` | применение версионированного патча `session-updated` | `applySessionDetailPatch` в `web/src/lib/sessionPatch.ts` |
| `pagination/` | окно сообщений: курсоры постраничного просмотра, сбросы эпохи, оптимистичные отправки, обрезки | `web/src/lib/message-window-store.ts` + `web/src/lib/messages.ts` |

Никогда не редактируйте JSON вручную — правьте определения кейсов в
`web/scripts/fixtures/` (`cases/`, `sse/cases.ts`, `pagination/cases.ts`) и
перегенерируйте.

## Структура

```
shared/fixtures/
├── VERSION                  # текущий fixtureVersion (одно целое + \n)
├── chat/<name>.json         # один фикстур на кейс
├── sse/<name>.json
├── pagination/<name>.json
├── catalogs/modes.json      # справочные таблицы (см. «Каталоги» ниже)
└── README.md
```

## Как использовать (все наборы)

- **iOS** (`ios/`, цель тестов SPM): определите выгрузку репозитория от расположения самого
  тестового файла и загружайте каждый `<suite>/*.json`, например
  `URL(fileURLWithPath: #filePath)` → подъём до корня пакета →
  `../../shared/fixtures`. Декодируйте входы, запустите портированную реализацию,
  спроецируйте и сравните с сохранёнными ожиданиями.
- **Android** (`android/`, JVM-тесты `:core:protocol`): передайте каталог через
  Gradle — `tasks.withType<Test> { systemProperty("hapi.fixtures.dir",
  rootDir.resolve("../shared/fixtures")) }` — и читайте его через
  `System.getProperty("hapi.fixtures.dir")` в тесте.
- Итерируйте **все** файлы в каталоге набора (падайте на нуле файлов), чтобы новые
  фикстуры подхватывались без изменений на нативной стороне.

### Планка приёмки

Точное совпадение по нормативной проекции: сериализуйте ваш вычисленный вывод и
сохранённое ожидание фикстуры в **канонический JSON** (рекурсивно отсортированные
ключи объектов; числа как JSON-числа; без различий `undefined`/отсутствующих ключей)
и сравните на равенство. Порядок полей в файлах уже канонический
(отсортированные ключи, отступ 4 пробела, LF, завершающий перевод строки), поэтому структурное
глубокое сравнение с сортировкой ключей эквивалентно.

### Политика fixtureVersion

`fixtureVersion` (отражён в `VERSION`, общий для всех наборов) увеличивается, когда
схема документа или нормативная проекция меняет форму. Нативные наборы должны
**громко падать, когда версия на диске новее поддерживаемой** (не пропускать молча), и
могут терпеть более старые версии только если явно их реализуют. Аддитивные новые *файлы* фикстур
и новые кейсы провода версию не увеличивают.

---

# Набор чата (`chat/`)

Прогоняет реальный веб-конвейер (`normalizeDecryptedMessage` → `reduceChatBlocks`
→ `buildVisibleChatBlocks`) по сообщениям провода, затем проецирует.

## Схема документа (`fixtureVersion: 1`)

```jsonc
{
    "fixtureVersion": 1,
    "name": "claude-assistant-text",        // совпадает с именем файла
    "description": "…",
    "input": {
        "messages": [ /* DecryptedMessage[] ровно так, как их возвращает GET /sessions/:id/messages */ ],
        "agentState": null,                 // session.agentState (запросы разрешений) или null
        "options": { "hasMoreMessages": false }  // за `messages` есть более старая история
    },
    "expected": {
        "blocks": [ /* спроецированные ChatBlock[] (до группировки инструментов) */ ],
        "hasReadyEvent": false,
        "latestUsage": null,                // или { inputTokens, outputTokens, contextSize, contextWindow }
        "visibleBlocks": [ /* спроецированные блоки после группировки инструментов */ ]
    }
}
```

Для каждой фикстуры сравнение приёмки покрывает `blocks`, `hasReadyEvent`,
`latestUsage` и `visibleBlocks`.

## Нормативный контракт полей

Проекция сохраняет **структуру + семантику** и отбрасывает веб-представление и
вспомогательные детали. Всё, чего нет ниже, намеренно НЕ является частью
контракта — нативные приложения могут выводить свои эквиваленты, но не должны ожидать их в
фикстурах. Реализация: `web/scripts/fixtures/projection.ts` (держите в синхроне
с этим списком).

Необязательные поля присутствуют, только когда несут значение; `invokedAt`
опускается, когда null. `localId` всегда присутствует (nullable) у видов блоков,
которые его несут.

### Каждый блок

`kind`, `id`, `createdAt`, `invokedAt?`

### По видам

| kind | нормативные поля |
|------|------------------|
| `user-text` | `localId`, `text`, `attachments?` — каждый `{ id, filename, mimeType, size, path }` |
| `agent-text` | `localId`, `text` |
| `agent-reasoning` | `localId`, `text` |
| `cli-output` | `localId`, `text`, `source` (`'user' \| 'assistant'`) |
| `codex-review` | `localId`, `review` (дословный нормализованный объект review) |
| `generated-image` | `localId`, `imageId`, `fileName`, `mimeType` |
| `agent-event` | `event` — нормализованный объект AgentEvent дословно (`type` + типизированные поля payload) |
| `tool-call` | `localId`, `tool`, `children?` (рекурсивно спроецированные; опускается, когда пусто) |
| `tool-group` (только visibleBlocks) | `firstToolId`, `lastToolId`, `tools` (спроецированные блоки `tool-call` по порядку; членство + порядок + количество) |

### Объект `tool`

`{ id, name, state, input?, result?, permission? }`

- `state`: `'pending' | 'running' | 'completed' | 'error'`
- `input`: дословное значение провода (может быть `null`, когда виден только результат)
- `result`: дословное значение провода, присутствует, как только пришёл результат/прогресс —
  включая маркеры усечения хаба (`…[hapi: truncated N chars]…`) байт в байт
- `permission?`: `{ status, mode?, decision?, allowedTools?, answers?, reason? }`
  — `status`: `'pending' | 'approved' | 'denied' | 'canceled'`

### Верхний уровень

- `hasReadyEvent`: boolean (событие `ready` потребляется, никогда не является блоком)
- `latestUsage`: `null` или `{ inputTokens, outputTokens, contextSize, contextWindow }`
  (`contextWindow` nullable; `contextSize` уже включает токены кеша)

### Отброшено (веб-представление / вспомогательное — не в фикстурах)

Уровень блока: `meta`, `usage` (на блок), `model`, `durationMs`, `status`
(состояние оптимистичной отправки), `originalText`, `streamId`, `uuid`/`parentUUID`,
`agentTimestamp`. Уровень инструмента: `createdAt`/`startedAt`/`completedAt`/
`execStartedAt`/`execCompletedAt` (тайминги), `description`, `nativeTitle`,
`nativeKind`, `progress`. Уровень разрешения: `id`, `date`, `createdAt`,
`completedAt`. Вложения: `previewUrl`. Сгенерированное изображение: `source`.
Группа инструментов: `defaultOpen`, `historyState`, `needsOlderHistory`,
`activityTitle`, `presentationMode`, `summary`. Верхний уровень: `latestGoal`,
`latestUsage.cacheCreation`/`cacheRead`/`model`/`timestamp`.

---

# Набор патчей сессии SSE (`sse/`)

Фиксирует алгоритм версионированного патча для событий `session-updated`, несущих
`SessionPatch` (контракт: `docs/api/client-contract/sse.md` (англ.), «Алгоритм
версионированного патча»). Ожидания вычисляются реальным веб-фолдом —
`applySessionDetailPatch` в `web/src/lib/sessionPatch.ts`.

## Схема документа (`fixtureVersion: 1`)

```jsonc
{
    "fixtureVersion": 1,
    "name": "metadata-newer-version-applied",   // совпадает с именем файла
    "description": "…",
    "initialSession": { /* полный Session, кешированный до первого патча */ },
    "patches": [ /* payload SessionPatch в порядке прихода */ ],
    "expectedPatchResults": [ "applied" | "unchanged", … ],  // выровнено с patches
    "expectedSession": { /* Session после свёртки всех патчей */ }
}
```

## Контракт воспроизведения

Сверните по `patches` по порядку:

```
next = applySessionDetailPatch(session, patch)   // ваш порт
results[i] = next == null ? "unchanged" : "applied"
session = next ?? session
```

Сравните `results` с `expectedPatchResults`, а итоговую сессию —
с `expectedSession` (равенство канонического JSON). `unchanged` нормативно:
это означает, что вызов сообщил «ничего не изменилось — сохранить прежнюю
идентичность объекта» (обёртка с гейтом версии, keep-alive `activeAt` меньше минуты,
no-op присваивание). Порт, применяющий устаревшую обёртку или считающий
keep-alive изменением, падает на вердикте, даже когда итоговая сессия
случайно совпадает.

Оба входа хранятся **нормализованными по схеме**: `initialSession` — вывод разбора
`SessionSchema`, а каждый патч — вывод разбора строгой
`SessionPatchSchema` (применены значения по умолчанию zod, например `TodoItem.priority`), поэтому
потребители декодируют JSON дословно — повторный прогон схемы не нужен. Генератор
валидирует каждый написанный патч по схеме провода, а веб-самопроверка перевалидирует
при каждом запуске тестов, поэтому фикстуры не могут разойтись с
`shared/src/schemas.ts`.

Намеренно зафиксированное поведение (см. отдельные описания):

- обёртки с версией (`metadata`/`agentState`/`todos`/`teamState`) применяются только
  когда `version` **строго больше** кешированной отметки; равные и
  более старые версии отбрасываются независимо от значения; отсутствующие отметки `todosUpdatedAt`/
  `teamStateUpdatedAt` считаются 0
- обёртка `teamState` со `value: null` очищает поле (отсутствует в
  `expectedSession`) и всё равно сохраняет отметку
- `updatedAt` макс-монотонен; только более старый `updatedAt` — это `unchanged`
- плоские поля работают по принципу «побеждает последняя запись»; ключ `serviceTier`, явно присутствующий как
  `null`, очищает его
- `activeTurnStartedAt` **не применяется** путём патча (поведение веба:
  нет ветки присваивания) — патч, несущий только его, — `unchanged`
- патч, чьё единственное эффективное изменение — дельта `activeAt` < 60 с, —
  `unchanged`, и кешированный `activeAt` **не** двигается
- `scratchlistUpdatedAt` — только триггер перезапроса: `unchanged`, без мутации
  сессии

---

# Набор пагинации (`pagination/`)

Фиксирует хранилище окна сообщений: запросы постраничного просмотра, которые оно должно выдавать, обработку
сброса эпохи, согласование оптимистичной отправки, жизненный цикл строк очереди и обрезку окна
(контракт: `docs/api/client-contract/pagination.md` (англ.)). Ожидания
записаны из реального веб-хранилища (`web/src/lib/message-window-store.ts`),
управляемого скриптованным ApiClient.

## Схема документа (`fixtureVersion: 1`)

```jsonc
{
    "fixtureVersion": 1,
    "name": "older-page-epoch-mismatch-resets",   // совпадает с именем файла
    "description": "…",
    "ops": [ /* скрипт операций, по порядку; см. ниже */ ],
    "expectedState": { /* итоговая проекция окна, см. ниже */ }
}
```

## Операции

Воспроизводите каждую операцию строго последовательно против вашего портированного хранилища. Операции, обращающиеся
к серверу, несут `responses` — скриптованные ответы `GET /messages`, потребляемые FIFO, —
и машинно записанные `expectedRequests`: точные объекты запросов, которые отправило
веб-хранилище (`limit` только для страницы latest; `beforeAt`+`beforeSeq`+
`limit` для старых страниц; `afterAt`+`afterSeq`+`untilAt`+`untilSeq`+`epoch`+
`limit` для догона хвоста, где `untilAt`/`untilSeq` равны `null` в первом
запросе цикла). Ваш порт должен выдавать те же запросы в том же порядке и
потребить каждый скриптованный ответ.

| `op` | Операция хранилища (имя в вебе) | Примечания |
|------|---------------------------------|------------|
| `sync-tail` | `syncTailMessages` | Полная синхронизация хвоста; страница latest, когда нет пригодного курсора, иначе цикл after-курсора. |
| `fetch-older` | `fetchOlderMessages` | Одна старая страница. `expectedOutcome` — `{kind:'applied', hasMore, addedRenderableCount}` или `{kind:'stopped', reason}`. При несовпадении эпохи хранилище выполняет внутреннюю синхронизацию хвоста — её запрос/ответ принадлежат этой же операции, а исход — `stopped`/`epoch-reset`. |
| `sse-messages` | `ingestIncomingMessages` | Доставка SSE `message-received` (также продвигает новейший курсор, когда эпоха кеширована — даже за строки, которые конвейер скрывает). |
| `append-optimistic` | `appendOptimisticMessage` | Локальная оптимистичная строка (`id === localId`). **Не** продвигает новейший курсор. |
| `update-status` | `updateMessageStatus` | Переход состояния отправки клиента по `localId`. |
| `messages-consumed` | `markMessagesConsumed` | Событие SSE: проставить `invokedAt`, переключить статус на `sent` (пропуская `failed`), пересортировать по позиции; никогда не продвигает новейший курсор. |
| `message-cancelled` | `removeOptimisticMessage` | Событие SSE / удаление оптимистичным DELETE; совпадает по `localId` **или** `id`; идемпотентно. |
| `cancel-invoked` | remove + append | DELETE ответил `{"status":"invoked"}`: удалить по `localId`, затем поглотить возвращённое `message` со статусом клиента `sent` (харнесс добавляет статус). |
| `set-view-mode` | `setMessageViewMode` | Повторный вход в `tail` обрезает до видимого окна и после переполнения истории форсирует сброс latest. |
| `queued-state` | reconcile round trip | Собрать кандидатов (строки пользователя с `invokedAt === null`, закреплённые в `expectedCandidates`, в порядке окна), применить записи `invoked` как `messages-consumed`, затем отбросить кандидатов, которых нет ни в `queuedLocalIds`, ни в `invoked`. |

## Проекция `expectedState` (нормативная)

```jsonc
{
    "messages": [ { "id", "localId", "seq", "createdAt",
                    "invokedAt"?,     // трёхсостояние провода: отсутствует / null / число
                    "scheduledAt"?,   // трёхсостояние провода
                    "status"?,        // состояние отправки клиента, когда присутствует
                    "queued": bool,   // строка пользователя ∧ invokedAt === null ∧ status ≠ 'failed'
                    "optimistic": bool } ],   // localId ∧ id === localId
    "hasMore": bool,                  // есть более старая история (флаг сервера ∨ обрезка)
    "epoch": number | null,
    "viewMode": "tail" | "history",
    "olderCursor": { "at", "seq" } | null,   // позиция следующего before-запроса
    "newestCursor": { "at", "seq" } | null   // позиция следующего after-запроса
}
```

Порядок `messages` нормативен (порядок позиций: `at = invokedAt ?? createdAt`,
при равенстве — по `seq`). Курсоры — составные позиции постраничного просмотра хранилища (веб-внутренние
имена `oldestPosition*` / `newestPosition*`); всё остальное, что веб-внутреннее (счётчики
рендера/версий, throttling уведомлений, сохранение), намеренно НЕ является частью
контракта.

Замечания о детерминизме: единственные чтения стенных часов в веб-хранилище управляют throttling
уведомлений и никогда не касаются этой проекции, поэтому инъекция времени не нужна —
воспроизведения точны. Фикстуры держат каждую пару позиций различной (без совпадений `(at, seq)`),
поэтому веб-тай-брейк по id (`localeCompare`) никогда не решает порядок;
нативные порты всё же должны разрешать полные совпадения сравнением id в ASCII.

---

# Каталоги

`catalogs/` хранит справочные таблицы, сгенерированные из модулей `shared/src` (не
из чат-конвейера) тем же генератором, с той же канонической
сериализацией и гейтом дрейфа. Никогда не редактируйте их вручную.

- **`catalogs/modes.json`** — сгенерирован из `shared/src/modes.ts`
  (`web/scripts/fixtures/modesCatalog.ts` импортирует модуль напрямую, как
  чат-конвейер):
  - `permissionModesByFlavor`: для каждой записи `AGENT_FLAVORS` — режимы разрешений,
    предлагаемые для этого flavor **в порядке предложения**, каждый как
    `{ mode, label, tone }` (`tone`: `'neutral' | 'info' | 'warning' |
    'danger'`). Пустой массив означает, что flavor не предоставляет переключение разрешений
    во время выполнения (например, `pi`).
  - `codexCollaborationModes`: ось совместной работы только для codex как
    пары `{ mode, label }`.

  Нативные приложения портируют эту таблицу (id режимов, порядок, метки, тона) и должны сравнивать
  свой порт с файлом в тестах так же, как чат-фикстуры:
  равенство канонического JSON.

---

# Перегенерация и гейт дрейфа

```bash
bun run gen:fixtures        # из корня репозитория (запускает web/scripts/generate-fixtures.ts)
```

Вывод байтово детерминирован (каноническая сериализация), поэтому `git status` после
перегенерации — это сигнал дрейфа: когда `web/src/chat/**`,
`web/src/lib/sessionPatch.ts`, `web/src/lib/message-window-store.ts` или
`web/src/lib/messages.ts` меняют поведение, перегенерированные фикстуры отличаются,
дифф коммитится, а нативные наборы соответствия краснеют, пока порты
не догонят. Веб-самопроверки (все в `bun run test:web`) перепрогоняют каждый
сохранённый вход против живой реализации и падают на любом расхождении с
сохранёнными ожиданиями или с канонической сериализацией:

- `web/src/chat/fixtures.test.ts` — набор chat (также пересобирает
  `catalogs/modes.json` из `shared/src/modes.ts` и сравнивает)
- `web/src/lib/sessionPatch.fixtures.test.ts` — набор sse
- `web/src/lib/message-window-store.fixtures.test.ts` — набор pagination

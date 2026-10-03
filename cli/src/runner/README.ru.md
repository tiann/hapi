# HAPI CLI Runner: поток управления и жизненный цикл

Runner — постоянный фоновый процесс, который запускает сессии HAPI из веба/с телефона
и управляет ими. После обновления CLI он может перезапуститься на
новом бинарнике; он не скачивает и не устанавливает обновления.

Пути к исходникам ниже относительны `cli/`, если не указан другой пакет.

## 1. Жизненный цикл runner

### Запуск runner

Команда: `hapi runner start`

Поток управления:
1. `src/commands/runner.ts` обрабатывает `runner start`, сначала останавливая существующий runner, чтобы новые флаги/окружение вступили в силу
2. Запускает отсоединённый `runner start-sync`, пробрасывая настроенные корни рабочего пространства
3. Новый процесс вызывает `startRunner()` из `src/runner/run.ts`
4. `startRunner()` выполняет запуск:
   - Настраивает promise и обработчики завершения (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
   - Проверка версии: `isRunnerRunningCurrentlyInstalledHappyVersion()` сравнивает mtime бинарника CLI
   - При несовпадении версии: вызывает `stopRunner()`, чтобы убить старый runner, прежде чем продолжать
   - Если работает та же версия: выходит с «Runner already running»
   - Захват блокировки: `acquireRunnerLock()` создаёт эксклюзивный lock-файл, предотвращая несколько runner
   - Настройка прямого подключения: `authAndSetupMachineIfNeeded()` гарантирует, что `CLI_API_TOKEN` задан и `machineId` существует
   - HTTP-сервер: запускает Fastify на случайном порту для локального управления CLI (list, stop, spawn)
   - Сохранение состояния: пишет PID, версию, HTTP-порт, mtime в runner.state.json
   - WebSocket: устанавливает постоянное соединение с бэкендом через `ApiMachineClient`
   - Регистрация RPC: предоставляет обработчики `spawn-happy-session`, `stop-session`, `stop-runner`
   - Цикл heartbeat: каждые 60 с (или `HAPI_RUNNER_HEARTBEAT_INTERVAL`) проверяет обновления версии, вычищает мёртвые сессии, проверяет владение PID
5. Ожидает promise завершения, который разрешается, когда:
   - Получен сигнал ОС (SIGINT/SIGTERM) — источник: `os-signal`
   - Вызван HTTP-эндпоинт `/stop` — источник: `hapi-cli`
   - Вызван RPC `stop-runner` — источник: `hapi-app`
   - Возникло необработанное исключение — источник: `exception`
6. При завершении `cleanupAndShutdown()` выполняет:
   - Очищает интервал heartbeat
   - Обновляет состояние runner на «shutting-down» в бэкенде с источником завершения
   - Отключает WebSocket
   - Останавливает HTTP-сервер
   - Удаляет runner.state.json
   - Освобождает lock-файл
   - Завершает процесс

### Определение версии и автообновление

Runner обнаруживает изменение бинарника CLI (например, после `npm update -g @twsxtd/hapi`):
1. При запуске записывает `startedWithCliMtimeMs` (время изменения файла бинарника CLI)
2. Heartbeat сравнивает текущий mtime CLI с записанным через `getInstalledCliMtimeMs()`
3. Воспроизводит исходные аргументы runner (включая корни рабочего пространства), помечая замену как авторизованного потомка передачи
4. Освобождает блокировку и ждёт до 30 секунд другой живой PID runner в файле состояния
5. При подтверждении старый runner выходит. При сбое он пытается снова захватить блокировку и остаётся онлайн для поздней попытки; он выходит, если блокировку держит другой процесс

`HAPI_DISABLE_VERSION_HANDOFF=1` отключает эту автоматическую замену, но не
остальной heartbeat. Супервизор переднего плана должен запускать
`hapi runner start-sync`; объявляйте `HAPI_RUNNER_SUPERVISED=1` только если он
перезапустит процесс после выхода.

### Система heartbeat

Каждые 60 секунд (настраивается через `HAPI_RUNNER_HEARTBEAT_INTERVAL`):
1. **Защита**: пропускает, если предыдущий heartbeat ещё выполняется (предотвращает параллельные heartbeat)
2. **Вычистка сессий**: проверяет каждый отслеживаемый PID через `isProcessAlive(pid)`, удаляет мёртвые сессии
3. **Проверка версии**: сравнивает mtime бинарника CLI, запускает самоперезапуск при изменении
4. **Владение PID**: проверяет, что runner всё ещё владеет файлом состояния, само-завершается, если его перехватил другой runner
5. **Обновление состояния**: пишет метку `lastHeartbeat` в runner.state.json

### Остановка runner

Команда: `hapi runner stop`

Это останавливает runner, а не его отсоединённые сессии агентов. Используйте `stop-session`,
чтобы остановить отдельную сессию, или `doctor clean` для более широкой очистки процессов.

Поток управления:
1. `stopRunner()` в `controlClient.ts` читает runner.state.json и проверяет, что PID всё ещё принадлежит runner HAPI, прежде чем связываться с ним или сигналить ему
2. Пытается корректно завершить через HTTP POST на `/stop`
3. Runner получает запрос, запускает завершение с источником `hapi-cli`
4. `cleanupAndShutdown()` выполняет:
   - Обновляет статус бэкенда на «shutting-down»
   - Закрывает соединение WebSocket
   - Останавливает HTTP-сервер
   - Удаляет runner.state.json
   - Освобождает lock-файл
5. Если HTTP не удался, откатывается к `killProcess(pid, true)` (использует `taskkill /T /F` в Windows)

## 2. Поддержка нескольких агентов

Runner поддерживает [текущий каталог агентов](../../../docs/guide/agents.md) (англ.).
Если запрос spawn опускает `agent`, его запасной вариант всё ещё Claude; это
отдельно от интерактивного пикера `hapi`, который ждёт вашего выбора,
а не запускает Claude неявно.
Примеры аутентификации агентов:

| Агент | Команда | Окружение токена |
|-------|---------|------------------|
| `claude` | `hapi claude` | Существующий вход агента или переданный `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | `hapi codex` | Существующий Codex home; переданный токен получает временный `CODEX_HOME` с `auth.json` и копией пользовательского `config.toml` |
| `grok` | `hapi grok` | Вход Grok CLI или `XAI_API_KEY` |
| `opencode` | `hapi opencode` | Конфигурация OpenCode (без инъекции токена) |

### Аутентификация токеном

При запуске сессии с токеном:
- **Claude**: задаёт переменную окружения `CLAUDE_CODE_OAUTH_TOKEN`
- **Codex**: создаёт временный каталог в `os.tmpdir()/hapi-codex-*`, копирует пользовательский `config.toml`, когда он есть, пишет токен в `auth.json` и задаёт `CODEX_HOME`. Копируется только файл конфигурации, чтобы настройки MCP пользователя выжили без копирования постороннего состояния Codex; скопированная конфигурация очищается при выходе потомка или сбое запуска. Команды MCP менеджеров пакетов Windows проксируются путём лаунчера Codex; перечисленные `env_vars` остаются источником внешних учётных данных MCP.
- **Grok Build**: без инъекции токена; полагается на вход Grok CLI или `XAI_API_KEY` в окружении runner
- **OpenCode**: без инъекции токена; полагается на собственную конфигурацию OpenCode

## 3. Управление сессиями

### Сессии, запущенные runner (удалённо)

Инициируются мобильным приложением через RPC бэкенда:
1. Бэкенд пересылает RPC `spawn-happy-session` runner через WebSocket
2. `ApiMachineClient` вызывает обработчик `spawnSession()`
3. `spawnSession()`:
   - Проверяет доступность агента и границы корней рабочего пространства, затем валидирует/создаёт каталог
   - Настраивает окружение токена конкретного агента
   - Запускает отсоединённый процесс HAPI с `--hapi-starting-mode remote --started-by runner`
   - Добавляет в карту `pidToTrackedSession`
   - Ждёт webhook старта сессии (15 секунд по умолчанию; `HAPI_RUNNER_WEBHOOK_TIMEOUT_MS` переопределяет)
4. Новый процесс HAPI:
   - Создаёт сессию с бэкендом, получает `happySessionId`
   - Вызывает `notifyRunnerSessionStarted()` для POST на `/session-started` runner
5. Runner обновляет отслеживание `happySessionId`, разрешает ожидающего
6. RPC возвращает информацию о сессии мобильному приложению

### Сессии, запущенные из терминала

Пользователь запускает агента из терминала:
1. Bootstrap сессии регистрируется в хабе; runner для использования терминала не требуется
2. Процесс HAPI вызывает `notifyRunnerSessionStarted()`, если может дотянуться до локального управляющего сервера runner
3. Runner получает webhook, создаёт `TrackedSession` с `startedBy: 'hapi directly - likely by user from terminal'`
4. Сессия отслеживается для мониторинга здоровья

### Одобрение создания каталога

При запуске сессии обработка каталога:
1. Проверить существование каталога через `fs.access()`
2. Если отсутствует и `approvedNewDirectoryCreation = false`: возвращает `requestToApproveDirectoryCreation` (HTTP 409)
3. Если отсутствует и одобрено: создаёт каталог через `fs.mkdir({ recursive: true })`
4. Обработка ошибок создания каталога:
   - `EACCES`: доступ запрещён
   - `ENOTDIR`: по пути существует файл
   - `ENOSPC`: диск заполнен
   - `EROFS`: файловая система только для чтения

### Завершение сессии

Через RPC `stop-session` или HTTP `/stop-session`:
1. `stopSession()` находит сессию, включая сохранённые записи процесса возобновления
2. Останавливает её дерево процессов и проверяет выход; общий Codex использует остановку в области корня, чтобы не убивать соседние разговоры
3. Возвращает `stopped`, `already_gone` или `still_alive`; неопределённость не сообщается как успешное завершение

## 4. HTTP-сервер управления (Fastify)

Локальный HTTP-сервер на Fastify с `fastify-type-provider-zod` для типобезопасной валидации запросов/ответов.

**Хост:** 127.0.0.1 (только localhost)
**Порт:** динамический (назначается системой)

### Эндпоинты

#### POST `/session-started`
Webhook сессии — сообщает о себе после создания.

**Запрос:**
```json
{ "sessionId": "string", "metadata": { ... } }
```
**Ответ (200):**
```json
{ "status": "ok" }
```

#### POST `/list`
Возвращает все отслеживаемые сессии.

**Ответ (200):**
```json
{
  "children": [
    { "startedBy": "runner", "happySessionId": "uuid", "pid": 12345 }
  ]
}
```

#### POST `/stop-session`
Завершает конкретную сессию.

**Запрос:**
```json
{ "sessionId": "string" }
```
**Ответ (200):**
```json
{ "status": "stopped" }
```

`status` — `stopped`, `already_gone` или `still_alive`.

#### POST `/spawn-session`
Создаёт новую сессию.

**Запрос:**
```json
{ "directory": "/path/to/dir", "sessionId": "optional-uuid" }
```
**Ответ (200) — успех:**
```json
{
  "success": true,
  "sessionId": "uuid",
  "approvedNewDirectoryCreation": true
}
```
**Ответ (409) — требуется одобрение:**
```json
{
  "success": false,
  "requiresUserApproval": true,
  "actionRequired": "CREATE_DIRECTORY",
  "directory": "/path/to/dir"
}
```
**Ответ (500) — ошибка:**
```json
{ "success": false, "error": "Error message" }
```

#### POST `/stop`
Корректное завершение runner.

**Ответ (200):**
```json
{ "status": "stopping" }
```

## 5. Сохранение состояния

### runner.state.json
```json
{
  "pid": 12345,
  "httpPort": 50097,
  "startTime": "8/24/2025, 6:46:22 PM",
  "startedWithCliVersion": "0.9.0-6",
  "startedWithCliMtimeMs": 1724531182000,
  "lastHeartbeat": "8/24/2025, 6:47:22 PM",
  "runnerLogPath": "/path/to/runner.log"
}
```

### Lock-файл
- Создаётся с флагом O_EXCL для атомарного захвата
- Содержит PID для отладки
- Предотвращает несколько экземпляров runner
- Очищается при корректном завершении

## 6. Связь по WebSocket

`ApiMachineClient` обрабатывает двунаправленную связь:

**Runner → сервер:**
- `machine-alive` — heartbeat каждые 20 секунд
- `machine-update-metadata` — изменения статической информации о машине
- `machine-update-state` — изменения статуса runner

**Сервер → runner:**
- `rpc-request` с методами:
  - `spawn-happy-session` — запустить новую сессию
  - `stop-session` — остановить сессию по ID
  - `stop-runner` — запросить завершение

Payload приложения — обычный JSON, аутентифицируемый `CLI_API_TOKEN`.
Защита транспорта зависит от URL хаба: используйте HTTPS для удалённого доступа;
встроенное сетевое реле защищает трафик через WireGuard + TLS.

## 7. Обнаружение и очистка процессов

### Команда doctor

`hapi doctor` использует `ps-list` для поиска процессов HAPI:
- Production: совпадает с `hapi` / `hapi.exe`
- Development: совпадает с `src/index.ts` (запуск через `bun`)
- Классифицирует по аргументам команды: runner, runner-spawned, user-session, doctor

### Очистка сбежавших процессов

`hapi doctor clean`:
1. `findRunawayHappyProcesses()` выбирает категории процессов runner и runner-spawned (не только доказанные сироты); используйте осторожно
2. `killRunawayHappyProcesses()`:
   - Отправляет SIGTERM
   - Ждёт 1 секунду
   - Отправляет SIGKILL, если всё ещё жив

## 8. Интеграционное тестирование

### Тестовое окружение

- Запустите `bun run test:cli:integration` из корня репозитория (отдельный последовательный проект Vitest)
- Глобальная настройка запускает изолированный хаб на свободном loopback-порту с временным home/базой и сгенерированным токеном
- Ни `.env.integration-test`, ни запущенный пользовательский хаб не требуются
- Реальными отсоединёнными деревьями процессов владеет и очищает тестовый харнесс; стресс-покрытие включается опционально через `HAPI_RUN_STRESS_TESTS=true`

### Ключевые тестовые сценарии
- Список, запуск и остановка сессий
- Отслеживание webhook внешней сессии
- Корректное завершение SIGTERM/SIGKILL
- Предотвращение нескольких runner
- Обнаружение несовпадения версий
- Поток одобрения создания каталога
- Стресс-тесты параллельных сессий

---

# Архитектура синхронизации машин — разделённые метаданные и состояние runner

> Замечание о прямом подключении: «хаб» — это `hapi-hub`, payload — обычный JSON (без base64/шифрования),
> а аутентификация использует `CLI_API_TOKEN` (REST `Authorization: Bearer ...` + Socket.IO `handshake.auth.token`).

## Структура данных (аналогично metadata + agentState сессии)

Упрощённые фрагменты; полные схемы провода живут в `shared/src/schemas.ts`.

```typescript
// Static machine information (rarely changes)
interface MachineMetadata {
  host: string;              // hostname
  platform: string;          // darwin, linux, win32
  happyCliVersion: string;
  homeDir: string;
  happyHomeDir: string;
  happyLibDir: string;       // runtime path
}

// Dynamic runner state (frequently updated)
interface RunnerState {
  status: 'running' | 'shutting-down' | 'offline';
  pid?: number;
  httpPort?: number;
  startedAt?: number;
  shutdownRequestedAt?: number;
  shutdownSource?: 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception';
}
```

## 1. Фаза запуска CLI

Аутентификация/bootstrap гарантирует наличие ID машины в settings. Bootstrap сессии
также создаёт/загружает эту машину на хабе с её метаданными;
runner поставляет живое состояние runner, heartbeat и RPC в области машины.

## 2. Запуск runner — начальная регистрация

### REST-запрос: `POST /cli/machines`
```json
{
  "id": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "happyCliVersion": "1.0.0",
    "homeDir": "/Users/john",
    "happyHomeDir": "/Users/john/.hapi",
    "happyLibDir": "/usr/local/lib/node_modules/hapi"
  },
  "runnerState": {
    "status": "running",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567
  }
}
```

### Ответ сервера:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "happyCliVersion": "..." },
    "metadataVersion": 1,
    "runnerState": { "status": "running", "pid": 12345 },
    "runnerStateVersion": 1,
    "active": true,
    "activeAt": 1703001234567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001234567
  }
}
```

## 3. Соединение WebSocket и обновления в реальном времени

### Рукопожатие соединения:
```javascript
io(`${botUrl}/cli`, {
  auth: {
    token: "CLI_API_TOKEN",
    clientType: "machine-scoped",
    machineId: "machine-uuid-123"
  },
  path: "/socket.io/",
  transports: ["websocket"]
})
```

### Heartbeat (каждые 20 с):
```json
// Client -> Server
socket.emit('machine-alive', {
  "machineId": "machine-uuid-123",
  "time": 1703001234567
})
```

## 4. Обновления состояния runner (через WebSocket)

### Когда статус runner меняется:
```json
// Client -> Server
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123",
  "runnerState": {
    "status": "shutting-down",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567,
    "shutdownRequestedAt": 1703001244567,
    "shutdownSource": "hapi-app"
  },
  "expectedVersion": 1
}, callback)

// Server -> Client (callback)
// Success:
{
  "result": "success",
  "version": 2,
  "runnerState": { "status": "shutting-down" }
}

// Version mismatch:
{
  "result": "version-mismatch",
  "version": 3,
  "runnerState": { "status": "running" }
}
```

### Обновление метаданных машины (редко):
```json
// Client -> Server
socket.emit('machine-update-metadata', {
  "machineId": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "happyCliVersion": "1.0.1",
    "homeDir": "/Users/john",
    "happyHomeDir": "/Users/john/.hapi"
  },
  "expectedVersion": 1
}, callback)
```

## 5. RPC-вызовы Mini App (через hapi-hub)

Telegram Mini App вызывает REST-эндпоинты на `hapi-hub` (например, `POST /api/machines/:id/spawn`).
`hapi-hub` затем пересылает эти запросы runner через Socket.IO `rpc-request` в пространстве имён `/cli`.

Именование RPC-методов (в области машины) использует префикс `${machineId}:`, например:
- `${machineId}:spawn-happy-session`

## 6. Широковещательные сообщения сервера клиентам

Примеры Socket.IO ниже — для подписчиков CLI-машины. Веб/нативные
клиенты вместо этого получают `machine-updated` через SSE и перезапрашивают `/api/machines`,
когда у события нет данных машины. Не подавайте конверт `update` CLI
напрямую в SSE-декодер нативного клиента.

### Когда состояние runner меняется:
```json
// Server -> CLI machine subscribers
socket.emit('update', {
  "id": "update-id-xyz",
  "seq": 456,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "runnerState": {
      "value": { "status": "shutting-down" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

### Когда меняются метаданные:
```json
socket.emit('update', {
  "id": "update-id-abc",
  "seq": 457,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "metadata": {
      "value": { "host": "MacBook-Pro.local" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

## 7. GET статуса машины (REST)

### Запрос: `GET /cli/machines/machine-uuid-123`
```http
Authorization: Bearer <CLI_API_TOKEN>
```

### Ответ:
```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "happyCliVersion": "..." },
    "metadataVersion": 2,
    "runnerState": { "status": "running", "pid": 12345 },
    "runnerStateVersion": 3,
    "active": true,
    "activeAt": 1703001244567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001244567
  }
}
```

## Ключевые проектные решения

1. **Разделение ответственности**:
   - `metadata`: статическая информация о машине (host, платформа, версии)
   - `runnerState`: динамическое состояние выполнения (статус, pid, порты)

2. **Независимое версионирование**:
   - `metadataVersion`: для обновлений метаданных машины
   - `runnerStateVersion`: для обновлений состояния runner
   - Позволяет параллельные обновления без конфликтов

3. **Безопасность**: обычный JSON на уровне приложения; удалённый транспорт использует HTTPS или зашифрованное сетевое реле. Аутентификация CLI — `CLI_API_TOKEN`

4. **События обновления**: широковещательные сообщения сервера используют тот же шаблон, что и сессии:
   - `t: 'update-machine'` с необязательными полями metadata и/или runnerState
   - Клиенты получают обновления только для изменившихся полей

5. **Шаблон RPC**: методы RPC в области машины с префиксом machineId (как у сессий)

---

# Операционные заметки

- Обычное завершение удаляет `runner.state.json`; его отсутствие не доказывает, что runner никогда не запускался. Историю завершений смотрите в логах.
- Отслеживание resume-spawn сохраняется отдельно в `runner.state.json.resume-processes.json`, с проверками поколений процессов перед восстановлением или завершением. Это не полный инвентарь каждого процесса, запущенного из терминала.
- Локальный управляющий сервер привязан к `127.0.0.1` на случайном порту. У него нет слоя удалённой аутентификации; не выставляйте его через публичный прокси.

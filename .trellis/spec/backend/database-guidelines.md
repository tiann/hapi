# 数据库规范

> 本项目中的数据库模式与约定。

---

## 概述

HAPI Hub 使用 **SQLite** 与 Bun 原生 SQLite 驱动。数据库层遵循清晰的分层架构，包含：

- **WAL 模式**，提升并发能力
- **Strict mode**，确保类型安全
- **启用外键**
- **版本化更新**，用于乐观并发控制
- **双层模式**：Store 类（CRUD）+ 业务逻辑函数

**关键特征**：
- 单个启用 WAL 的 SQLite 数据库文件
- 基于 namespace 的多租户隔离
- 使用 version 字段实现乐观锁
- 类型安全的查询结果
- 带版本跟踪的 schema 迁移

---

## 数据库配置

### 初始化（`store/index.ts`）

```typescript
export class Store {
    constructor(dbPath: string) {
        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })

        // 启用 WAL 模式以提升并发能力
        this.db.exec('PRAGMA journal_mode = WAL')

        // NORMAL 同步模式（在安全与性能之间折中）
        this.db.exec('PRAGMA synchronous = NORMAL')

        // 启用外键约束
        this.db.exec('PRAGMA foreign_keys = ON')

        // 锁竞争时最多等待 5 秒
        this.db.exec('PRAGMA busy_timeout = 5000')

        this.initSchema()
    }
}
```

**关键设置**：
- `journal_mode = WAL` - 使用预写日志以支持并发读取
- `synchronous = NORMAL` - 平衡安全性与性能
- `foreign_keys = ON` - 强制保证引用完整性
- `busy_timeout = 5000` - 锁竞争失败前等待 5 秒
- `strict: true` - 类型安全模式（Bun SQLite 特性）

---

## Schema 设计

### 表结构

```sql
-- sessions 表
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    tag TEXT,
    namespace TEXT NOT NULL DEFAULT 'default',
    machine_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata TEXT,                    -- JSON blob
    metadata_version INTEGER DEFAULT 1,
    agent_state TEXT,                 -- JSON blob
    agent_state_version INTEGER DEFAULT 1,
    todos TEXT,                       -- JSON blob
    todos_updated_at INTEGER,
    active INTEGER DEFAULT 0,         -- Boolean (0/1)
    active_at INTEGER,
    seq INTEGER DEFAULT 0             -- 用于同步的序号
);

CREATE INDEX idx_sessions_tag ON sessions(tag);
CREATE INDEX idx_sessions_tag_namespace ON sessions(tag, namespace);
```

**约定**：
- 主键：`TEXT`（UUID）
- 时间戳：`INTEGER`（Unix 毫秒）
- 布尔值：`INTEGER`（0/1）
- JSON 数据：`TEXT`，并配套 `_version` 字段实现乐观锁
- Namespace：`TEXT NOT NULL`，用于多租户
- Sequence：`INTEGER`，用于同步顺序

### 外键

```sql
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    local_id TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

**始终使用**：
- 关系字段要有 `FOREIGN KEY` 约束
- 依赖数据使用 `ON DELETE CASCADE`
- 在外键列上建立索引

### 命名约定

- **表**：`snake_case`、复数形式（如 `sessions`、`push_subscriptions`）
- **列**：`snake_case`（如 `created_at`、`session_id`）
- **索引**：`idx_<table>_<columns>`（如 `idx_sessions_tag_namespace`）
- **ID**：实体使用 `TEXT` UUID 主键，查找表使用 `INTEGER AUTOINCREMENT`

---

## 双层模式

### 第 1 层：Store 类（CRUD）

Store 类是提供类型化 API 的薄封装：

```typescript
// store/sessionStore.ts
export class SessionStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): StoredSession {
        return getOrCreateSession(this.db, tag, metadata, agentState, namespace)
    }

    updateSessionMetadata(
        id: string,
        metadata: unknown,
        expectedVersion: number,
        namespace: string,
        options?: { touchUpdatedAt?: boolean }
    ): VersionedUpdateResult<unknown | null> {
        return updateSessionMetadata(this.db, id, metadata, expectedVersion, namespace, options)
    }

    getSession(id: string): StoredSession | null {
        return getSession(this.db, id)
    }

    deleteSession(id: string, namespace: string): boolean {
        return deleteSession(this.db, id, namespace)
    }
}
```

**模式说明**：Store 类委托纯函数实现逻辑，并提供类型安全 API。

### 第 2 层：业务逻辑函数

业务逻辑函数中包含实际 SQL：

```typescript
// store/sessions.ts
export function getOrCreateSession(
    db: Database,
    tag: string,
    metadata: unknown,
    agentState: unknown,
    namespace: string
): StoredSession {
    // 1. 检查是否已存在
    const existing = db.prepare(
        'SELECT * FROM sessions WHERE tag = ? AND namespace = ? ORDER BY created_at DESC LIMIT 1'
    ).get(tag, namespace) as DbSessionRow | undefined

    if (existing) {
        return toStoredSession(existing)
    }

    // 2. 创建新记录
    const id = randomUUID()
    const now = Date.now()

    db.prepare(`
        INSERT INTO sessions (id, tag, namespace, created_at, updated_at, metadata, ...)
        VALUES (@id, @tag, @namespace, @created_at, @updated_at, @metadata, ...)
    `).run({ id, tag, namespace, created_at: now, updated_at: now, metadata: JSON.stringify(metadata) })

    // 3. 再查出并返回
    const row = getSession(db, id)
    if (!row) throw new Error('Failed to create session')
    return row
}
```

**为什么要双层**：
- Store 类提供稳定、类型化的 API
- 业务逻辑函数是纯函数，更易测试
- 测试中更容易 mock 数据库
- 职责边界清晰

---

## 乐观锁

### 版本化更新

并发更新时，使用版本字段：

```typescript
// store/versionedUpdates.ts
export function updateVersionedField<T>(args: VersionedUpdateArgs<T>): VersionedUpdateResult<T> {
    // 带版本检查地尝试更新
    const result = args.db.prepare(
        `UPDATE ${args.table}
         SET ${args.field} = @field_value,
             ${args.versionField} = ${args.versionField} + 1
         WHERE id = @id AND namespace = @namespace AND ${args.versionField} = @expectedVersion`
    ).run({ id: args.id, namespace: args.namespace, expectedVersion: args.expectedVersion, field_value: args.encode(args.value) })

    if (result.changes === 1) {
        return { result: 'success', version: args.expectedVersion + 1, value: args.value }
    }

    // 版本冲突 - 读取当前状态
    const current = args.db.prepare(
        `SELECT ${args.field} AS field_value, ${args.versionField} AS version
         FROM ${args.table} WHERE id = ? AND namespace = ?`
    ).get(args.id, args.namespace) as { field_value: string | null; version: number } | undefined

    if (!current) {
        return { result: 'error' }
    }

    return { result: 'version-mismatch', version: current.version, value: args.decode(current.field_value) }
}
```

**结果类型**：
- `{ result: 'success', version: number, value: T }` - 更新成功
- `{ result: 'version-mismatch', version: number, value: T }` - 冲突，返回当前值
- `{ result: 'error' }` - 行不存在或数据库错误

---

## 查询模式

### Prepared Statements

始终使用预编译语句（不要字符串拼接）：

```typescript
// Good - 参数化查询
const row = db.prepare(
    'SELECT * FROM sessions WHERE id = ? AND namespace = ?'
).get(id, namespace) as DbSessionRow | undefined

// Bad - 存在 SQL 注入风险
const row = db.query(`SELECT * FROM sessions WHERE id = '${id}'`)
```

### 命名参数

复杂查询使用命名参数：

```typescript
db.prepare(`
    INSERT INTO sessions (id, tag, namespace, created_at, updated_at, metadata)
    VALUES (@id, @tag, @namespace, @created_at, @updated_at, @metadata)
`).run({
    id: randomUUID(),
    tag,
    namespace,
    created_at: Date.now(),
    updated_at: Date.now(),
    metadata: JSON.stringify(metadata)
})
```

### 类型安全的结果

始终用 `Db*Row` 类型标注查询结果：

```typescript
// 定义数据库行类型（snake_case，与数据库列保持一致）
type DbSessionRow = {
    id: string
    tag: string | null
    namespace: string
    created_at: number
    metadata: string | null
    metadata_version: number
    active: number  // SQLite 布尔值（0/1）
}

// 类型断言
const row = db.prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as DbSessionRow | undefined

// 转为领域类型（camelCase）
function toStoredSession(row: DbSessionRow): StoredSession {
    return {
        id: row.id,
        tag: row.tag,
        namespace: row.namespace,
        createdAt: row.created_at,
        metadata: safeJsonParse(row.metadata),
        metadataVersion: row.metadata_version,
        active: row.active === 1  // 将 0/1 转为 boolean
    }
}
```

---

## JSON 存储

### 存储 JSON

```typescript
// 序列化（处理 null）
const value = data === null || data === undefined ? null : JSON.stringify(data)
db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(value, id)
```

### 解析 JSON（`store/json.ts`）

```typescript
export function safeJsonParse(value: string | null): unknown {
    if (value === null) return null
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}
```

**始终使用 `safeJsonParse`** —— 能优雅处理 `null` 与解析错误。

---

## Schema 迁移

### 版本跟踪

```typescript
const SCHEMA_VERSION = 3

private initSchema(): void {
    const currentVersion = this.getUserVersion()

    if (currentVersion === 0) {
        this.createSchema()
        this.setUserVersion(SCHEMA_VERSION)
        return
    }

    // 顺序迁移
    if (currentVersion === 1 && SCHEMA_VERSION >= 2) {
        this.migrateFromV1ToV2()
        if (SCHEMA_VERSION === 2) {
            this.setUserVersion(SCHEMA_VERSION)
            return
        }
    }

    if (currentVersion <= 2 && SCHEMA_VERSION === 3) {
        this.migrateFromV2ToV3()
        this.setUserVersion(SCHEMA_VERSION)
        return
    }

    if (currentVersion !== SCHEMA_VERSION) {
        throw this.buildSchemaMismatchError(currentVersion)
    }
}
```

### 迁移模式

```typescript
private migrateFromV2ToV3(): void {
    this.db.exec(`
        ALTER TABLE sessions ADD COLUMN todos TEXT;
        ALTER TABLE sessions ADD COLUMN todos_updated_at INTEGER;
    `)
}
```

**规则**：
- 每次迁移都要递增 `SCHEMA_VERSION`
- 每个版本跳转只对应一个迁移函数
- 迁移是单向的（不回滚）
- `ALTER TABLE ADD COLUMN` 配合 `DEFAULT` 以保证向后兼容

---

## 多租户（Namespaces）

所有查询都必须按 `namespace` 过滤：

```typescript
// 读取 - 始终按 namespace 过滤
const sessions = db.prepare(
    'SELECT * FROM sessions WHERE namespace = ?'
).all(namespace) as DbSessionRow[]

// 写入 - 始终包含 namespace 检查
db.prepare(
    'UPDATE sessions SET metadata = @metadata WHERE id = @id AND namespace = @namespace'
).run({ metadata, id, namespace })

// 删除 - 始终包含 namespace 检查
db.prepare(
    'DELETE FROM sessions WHERE id = ? AND namespace = ?'
).run(id, namespace)
```

**原因**：防止不同用户之间发生数据泄漏。

---

## 常见错误

- ❌ 不使用预编译语句（存在 SQL 注入风险）
- ❌ 在查询中做字符串拼接
- ❌ 不为查询结果标注类型（隐式 `any`）
- ❌ 忘记在查询中加 `namespace` 过滤
- ❌ 不处理 JSON 解析错误（应使用 `safeJsonParse`）
- ❌ 并发修改时不使用版本化更新
- ❌ 高频查询列缺少索引
- ❌ 对依赖数据不使用 `ON DELETE CASCADE`
- ❌ 将时间戳存为字符串而不是整数
- ❌ 修改 schema 后忘记递增 `SCHEMA_VERSION`
- ❌ 未启用外键（`PRAGMA foreign_keys = ON`）

---

## 最佳实践

- ✅ 始终使用带参数的预编译语句
- ✅ 显式定义所有 `Db*Row` 类型（snake_case）
- ✅ 在 `toStored*` 函数中把数据库行转换为领域类型（camelCase）
- ✅ 并发修改使用版本化更新
- ✅ 所有查询都按 `namespace` 过滤
- ✅ JSON 列读取使用 `safeJsonParse`
- ✅ 为高频查询列建立索引
- ✅ 使用带 `ON DELETE CASCADE` 的外键
- ✅ 时间戳使用整数（Unix 毫秒）
- ✅ 保持迁移顺序化、单向化

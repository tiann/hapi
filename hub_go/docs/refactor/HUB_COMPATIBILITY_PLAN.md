# HAPI Hub 重构兼容性保障计划

## 概述

确保 Go 重构的 Hub 与现有 Bun 系统完全兼容，包括：
- HTTP API 契约兼容
- Socket.IO 协议与事件兼容（Engine.IO 握手、ACK、重连）
- SSE 事件兼容
- 数据库格式兼容
- CLI 客户端兼容
- 错误码/错误体结构兼容

---

## 前置约束（无缝迁移硬规则）

1. Go Hub 必须实现 Socket.IO 协议兼容层，禁止自定义 WebSocket/二进制帧。
2. JSON 请求/响应体字段、事件名、字段可选性、默认值必须与现有 Bun Hub 一致。
3. 错误响应结构（HTTP 状态码 + JSON 字段）必须一致。
4. 数据库 schema 仅允许向前兼容新增字段/索引，禁止破坏性迁移。
5. 并行运行时遵循“单写主”策略（Bun Hub 写、Go Hub 只读或反向亦可）。

---

## 一、契约定义 (Contract Definitions)

**基线文档**
- `docs/refactor/HUB_CONTRACT_BASELINE.md`

### 1.1 HTTP API 契约

**契约来源要求**
- 以现有 Bun Hub 运行时响应为准，禁止主观重写字段。
- 通过录制器/探针收集真实响应（成功 + 错误路径），生成契约基线。

```typescript
// hub_go/test/contracts/http-contracts.ts

export interface HttpContract {
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  request?: {
    body?: Record<string, unknown>
    query?: Record<string, string>
    headers?: Record<string, string>
  }
  response: {
    status: number
    body: Record<string, unknown>
  }
}

export const httpContracts: HttpContract[] = [
  // Auth
  {
    path: '/api/auth',
    method: 'POST',
    request: { body: { initData: 'string' } },
    response: { status: 200, body: { token: 'string', user: {} } }
  },
  // Sessions
  {
    path: '/api/sessions',
    method: 'GET',
    response: { status: 200, body: { sessions: [] } }
  },
  {
    path: '/api/sessions/:id',
    method: 'GET',
    response: { status: 200, body: { session: {} } }
  },
  {
    path: '/api/sessions/:id/messages',
    method: 'GET',
    request: { query: { limit: '10', beforeSeq: '0' } },
    response: { status: 200, body: { messages: [], page: {} } }
  },
  {
    path: '/api/sessions/:id/messages',
    method: 'POST',
    request: { body: { text: 'string', attachments: [] } },
    response: { status: 200, body: { ok: true } }
  },
  // Errors (示例，需由运行时录制补齐)
  {
    path: '/api/sessions/:id',
    method: 'GET',
    response: { status: 404, body: { error: 'not_found', message: 'string' } }
  },
  // Machines
  {
    path: '/api/machines',
    method: 'GET',
    response: { status: 200, body: { machines: [] } }
  },
  // SSE Events
  {
    path: '/api/events',
    method: 'GET',
    request: { query: { all: 'true', sessionId: 'string' } },
    response: { status: 200, body: null } // SSE stream
  }
]
```

### 1.2 Socket.IO 事件契约

**契约范围**
- Engine.IO 握手参数、ping/pong 间隔、升级策略
- Socket.IO namespace、event 名称、ACK 回调参数与顺序
- 重连与断线事件语义

```typescript
// hub_go/test/contracts/socket-contracts.ts

export interface SocketEventContract {
  namespace: '/cli' | '/terminal'
  direction: 'client->server' | 'server->client'
  event: string
  payload: Record<string, unknown>
  callback?: boolean
  callbackShape?: Record<string, unknown>
}

export const socketContracts: SocketEventContract[] = [
  // CLI Namespace - Client to Server
  {
    namespace: '/cli',
    direction: 'client->server',
    event: 'message',
    payload: {
      sid: 'string',
      message: {},
      localId: 'string?'
    }
  },
  {
    namespace: '/cli',
    direction: 'client->server',
    event: 'session-alive',
    payload: {
      sid: 'string',
      time: 'number',
      thinking: 'boolean',
      mode: 'string?',
      permissionMode: 'string?',
      modelMode: 'string?'
    },
    callback: true,
    callbackShape: { ok: 'boolean' }
  },
  // CLI Namespace - Server to Client
  {
    namespace: '/cli',
    direction: 'server->client',
    event: 'update',
    payload: {
      id: 'string',
      seq: 'number',
      body: {},
      createdAt: 'string'
    }
  },
  // Terminal Namespace - Client to Server
  {
    namespace: '/terminal',
    direction: 'client->server',
    event: 'terminal:create',
    payload: {
      sessionId: 'string',
      terminalId: 'string',
      cols: 'number',
      rows: 'number'
    }
  },
  {
    namespace: '/terminal',
    direction: 'client->server',
    event: 'terminal:write',
    payload: {
      sessionId: 'string',
      terminalId: 'string',
      data: 'string'
    }
  },
  // Terminal Namespace - Server to Client
  {
    namespace: '/terminal',
    direction: 'server->client',
    event: 'terminal:output',
    payload: {
      sessionId: 'string',
      terminalId: 'string',
      data: 'string'
    }
  }
]
```

### 1.3 SSE 事件契约

```typescript
// hub_go/test/contracts/sse-contracts.ts

export interface SSEEventContract {
  type: string
  fields: Record<string, { type: string; optional: boolean }>
}

export const sseContracts: SSEEventContract[] = [
  {
    type: 'session-added',
    fields: {
      namespace: { type: 'string', optional: true },
      sessionId: { type: 'string', optional: false },
      data: { type: 'object', optional: true }
    }
  },
  {
    type: 'session-updated',
    fields: {
      namespace: { type: 'string', optional: true },
      sessionId: { type: 'string', optional: false },
      data: { type: 'object', optional: true }
    }
  },
  {
    type: 'message-received',
    fields: {
      namespace: { type: 'string', optional: true },
      sessionId: { type: 'string', optional: false },
      message: {
        type: 'object',
        optional: false,
        fields: {
          id: { type: 'string', optional: false },
          seq: { type: 'number', optional: false },
          content: { type: 'object', optional: false },
          createdAt: { type: 'string', optional: false }
        }
      }
    }
  },
  {
    type: 'connection-changed',
    fields: {
      namespace: { type: 'string', optional: true },
      data: {
        type: 'object',
        optional: false,
        fields: {
          status: { type: 'string', optional: false },
          subscriptionId: { type: 'string', optional: true }
        }
      }
    }
  }
]
```

---

## 二、测试框架

### 2.1 HTTP 兼容性测试

```typescript
// hub_go/test/contracts/http-contracts.ts
// contracts are validated by a runner that hits real Bun/Go servers
```

### 2.2 Socket.IO 事件兼容性测试

```typescript
// scripts/test-socket-compatibility.ts

import { io } from "socket.io-client"

async function testSessionAlive(url: string) {
  const socket = io(url + "/cli", { transports: ["websocket", "polling"] })
  await new Promise((resolve) => socket.on("connect", resolve))

  const ack = await new Promise((resolve) => {
    socket.emit("session-alive", {
      sid: "session-123",
      time: 1234567890,
      thinking: false,
      mode: "command",
      permissionMode: "ask",
      modelMode: "claude"
    }, resolve)
  })

  if (!ack?.ok) throw new Error("ACK mismatch")
  socket.close()
}
```

### 2.3 SSE 事件测试

```typescript
// hub_go/test/contracts/sse-contracts.ts
// sse contracts validated by streaming /api/events and matching event types
```

### 2.4 契约执行器（脚手架）

```
hub_go/test/contracts/http-contracts.ts
hub_go/test/contracts/socket-contracts.ts
hub_go/test/contracts/sse-contracts.ts
hub/scripts/contracts/record-http.ts
hub/scripts/contracts/record-sse.ts
```

说明：这些文件是契约基线，执行器负责对比 Bun 与 Go 的实际响应/事件。

---

## 三、并行运行验证工具

**并行运行规则**
- 同一时间仅允许一个 Hub 写数据库（单写主），另一个只读。
- 镜像流量仅用于对比响应，不允许双写造成状态分叉。

### 3.1 Traffic Mirroring 工具

```go
// cmd/mirror/main.go

package main

import (
  "bytes"
  "fmt"
  "io"
  "log"
  "net/http"
  "sync"
)

type MirroredRequest struct {
  Timestamp string            `json:"timestamp"`
  Method    string            `json:"method"`
  Path      string            `json:"path"`
  Headers   map[string]string `json:"headers"`
  Body      string            `json:"body"`
}

type TrafficMirror struct {
  sourceURL   string
  targetURL   string
  results     []MirrorResult
  mu          sync.Mutex
}

type MirrorResult struct {
  Request     MirroredRequest `json:"request"`
  SourceResp  int              `json:"sourceResponse"`
  TargetResp  int              `json:"targetResponse"`
  Match       bool             `json:"match"`
  LatencyDiff int64            `json:"latencyDiffMs"`
}

func (m *TrafficMirror) start() error {
  // HTTP 请求镜像
  go func() {
    for req := range m.httpRequests {
      go m.compareHTTP(req)
    }
  }()

  // Socket.IO 消息镜像：使用 Node + socket.io-client 作为独立工具
  return nil
}

func (m *TrafficMirror) compareHTTP(req MirroredRequest) {
  // 发送到两个服务器
  sourceResp := m.sendTo(req, m.sourceURL)
  targetResp := m.sendTo(req, m.targetURL)

  result := MirrorResult{
    Request:     req,
    SourceResp:  sourceResp.status,
    TargetResp:  targetResp.status,
    Match:       sourceResp.status == targetResp.status,
    LatencyDiff: sourceResp.latency - targetResp.latency,
  }

  m.mu.Lock()
  m.results = append(m.results, result)
  m.mu.Unlock()

  if !result.Match {
    log.Printf("MISMATCH: %s %s - Source: %d, Target: %d",
      req.Method, req.Path, sourceResp.status, targetResp.status)
  }
}

type HTTPResponse struct {
  status   int
  latency  int64
  body     string
  headers  map[string]string
}

func (m *TrafficMirror) sendTo(req MirroredRequest, url string) HTTPResponse {
  // 实现 HTTP 请求发送和响应收集
  // ...
  return HTTPResponse{}
}
```

### 3.2 兼容性测试脚本

```bash
#!/bin/bash
# scripts/compatibility-test.sh

set -e

# 配置
BUN_PORT=3006
GO_PORT=3007
BUN_URL="http://localhost:$BUN_PORT"
GO_URL="http://localhost:$GO_PORT"

echo "=== HAPI Hub 兼容性测试 ==="

# 1. 启动 Bun Hub
echo "[1/4] 启动 Bun Hub..."
bun run hub/src/index.ts --port $BUN_PORT &
BUN_PID=$!
sleep 3

# 2. 启动 Go Hub
echo "[2/4] 启动 Go Hub..."
go run cmd/server/main.go --port $GO_PORT &
GO_PID=$!
sleep 3

# 3. 运行 API 兼容性测试
echo "[3/4] 运行 API 兼容性测试..."
go test -v ./test/compatibility/... -run TestHTTPCompatibility

# 4. 运行 Socket.IO 兼容性测试
echo "[4/4] 运行 Socket.IO 兼容性测试..."
node scripts/test-socket-compatibility.ts --bun $BUN_URL --go $GO_URL

# 清理
kill $BUN_PID $GO_PID 2>/dev/null || true

echo "=== 测试完成 ==="
```

---

## 四、回归测试套件

### 4.1 端到端测试

```typescript
// hub/test/e2e/scenarios.ts

export const e2eScenarios = [
  {
    name: "完整会话流程",
    steps: [
      // 1. 用户认证
      { action: "POST /api/auth", payload: { initData: "..." }, expect: { status: 200 } },
      // 2. 获取会话列表
      { action: "GET /api/sessions", expect: { status: 200, bodyContains: { sessions: [] } } },
      // 3. 创建会话
      { action: "POST /api/machines/:id/spawn", payload: { directory: "/tmp" }, expect: { status: 200 } },
      // 4. 发送消息
      { action: "POST /api/sessions/:id/messages", payload: { text: "hello" }, expect: { status: 200 } },
      // 5. 接收消息 (SSE)
      { action: "SSE /api/events?sessionId=:id", expect: { eventType: "message-received" } }
    ]
  },
  {
    name: "终端交互流程",
    steps: [
      // 1. 连接终端命名空间
      { action: "Socket connect", namespace: "/terminal", expect: { connected: true } },
      // 2. 创建终端
      { action: "Socket emit: terminal:create", payload: { sessionId: "...", cols: 80, rows: 24 }, expect: { event: "terminal:ready" } },
      // 3. 写入数据
      { action: "Socket emit: terminal:write", payload: { data: "ls\n" }, expect: { event: "terminal:output" } },
      // 4. 关闭终端
      { action: "Socket emit: terminal:close", expect: { event: "terminal:exit" } }
    ]
  }
]
```

### 4.2 数据完整性测试

```go
// test/compatibility/data_integrity_test.go

package compatibility

import (
  "encoding/json"
  "testing"
  "time"

  "github.com/stretchr/testify/assert"
  "github.com/stretchr/testify/require"
)

func TestDataIntegrity(t *testing.T) {
  // 测试场景：
  // 1. Bun Hub 创建会话
  // 2. Go Hub 读取相同会话
  // 3. 验证数据一致性
}
```

---

## 五、自动化验证流程

### 5.1 CI/CD Pipeline

```yaml
# .github/workflows/compatibility.yml

name: Compatibility Tests

on:
  push:
    branches: [main, go-refactor]
  pull_request:
    branches: [main]

jobs:
  compatibility-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest

      - name: Build Bun Hub
        run: bun run build:hub

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.21'

      - name: Build Go Hub
        run: go build -o bin/go-hub ./cmd/server

      - name: Run Compatibility Tests
        run: |
          echo "=== Starting both servers ==="
          bun run hub/src/index.ts --port 3006 &
          BUN_PID=$!
          sleep 3

          go run ./cmd/server/main.go --port 3007 &
          GO_PID=$!
          sleep 3

          echo "=== Running API Tests ==="
          go test -v ./test/compatibility/... -count=1

          echo "=== Running Socket.IO Tests ==="
          node scripts/test-socket-compatibility.ts --port 3007

          kill $BUN_PID $GO_PID 2>/dev/null || true
```

---

## 六、监控与告警

### 6.1 兼容性指标

```go
// internal/metrics/compatibility.go

package metrics

type CompatibilityMetrics struct {
  TotalRequests    int64 `json:"totalRequests"`
  MatchingResponses int64 `json:"matchingResponses"`
  Mismatches        int64 `json:"mismatches"`
  SuccessRate       float64 `json:"successRate"`
}

func (m *CompatibilityMetrics) Record(result MirrorResult) {
  m.TotalRequests++
  if result.Match {
    m.MatchingResponses++
  } else {
    m.Mismatches++
  }
  m.SuccessRate = float64(m.MatchingResponses) / float64(m.TotalRequests) * 100
}
```

### 6.2 告警规则

| 指标 | 阈值 | 告警级别 |
|------|------|---------|
| 成功率 | < 99.9% | Warning |
| 成功率 | < 99% | Error |
| 平均延迟差 | > 100ms | Warning |
| 平均延迟差 | > 500ms | Error |

---

## 七、回滚策略

### 7.1 快速回滚

```bash
#!/bin/bash
# scripts/rollback.sh

CURRENT_VERSION=$(cat VERSION)
PREVIOUS_VERSION=$(git describe --tags --abbrev=0 HEAD~1)

echo "Rolling back from $CURRENT_VERSION to $PREVIOUS_VERSION"

# 停止当前服务
pkill -f "go-hub" || true
pkill -f "bun.*hub" || true

# 切换到之前版本
git checkout $PREVIOUS_VERSION

# 重新部署
if [ -f "bin/bun-hub" ]; then
  ./bin/bun-hub &
else
  bun run hub/src/index.ts &
fi

echo "Rolled back to $PREVIOUS_VERSION"
```

### 7.2 数据回滚

```go
// migrations/rollback.go

func Rollback(db *sql.DB, targetVersion int) error {
  // 从当前版本回滚到目标版本
  // 每个迁移支持 undo 操作
}
```

---

## 八、检查清单

### 重构前检查
- [ ] API 契约文档完整
- [ ] Socket.IO 事件契约完整
- [ ] SSE 事件契约完整
- [ ] 数据库 schema 文档完整
- [ ] 测试用例覆盖所有 API 端点

### 重构中检查
- [ ] 每个 API 端点都有对应的契约测试
- [ ] 每个 Socket.IO 事件都有对应的契约测试
- [ ] 并行运行验证通过
- [ ] 端到端测试通过

### 重构后检查
- [ ] CI/CD 通过
- [ ] 兼容性测试套件通过
- [ ] 性能指标达标
- [ ] 监控告警配置完成
- [ ] 回滚脚本测试通过

---

## 九、持续验证

### 9.1 生产环境监控

```go
// internal/middleware/compatibility_check.go

func CompatibilityCheckMiddleware(next http.Handler) http.Handler {
  return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    // 在响应头中添加兼容性标记
    w.Header().Set("X-Compatible-With", "hapi-go-v1.0")
    next.ServeHTTP(w, r)
  })
}
```

### 9.2 客户端适配检测

```typescript
// web/src/hooks/useServerCompatibility.ts

export function useServerCompatibility() {
  const checkCompatibility = async () => {
    const response = await fetch('/api/health')
    const compatible = response.headers.get('X-Compatible-With')?.startsWith('hapi-go')

    if (!compatible) {
      console.warn('Server may not be compatible with Go version')
    }

    return compatible
  }

  return { checkCompatibility }
}
```

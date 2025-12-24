# Loading 元素精简优化计划

## 一、当前 Loading 元素汇总

| 位置 | 文件 | 当前样式 | 展示时机 |
|------|------|----------|----------|
| 同步横幅 | `SyncingBanner.tsx` | 顶部固定横幅 + 旋转符号 | `isSyncing && isOnline` |
| 权限按钮 | `PermissionFooter.tsx:66-73` | SVG SpinnerIcon | `loading` 状态 |
| 认证加载 | `App.tsx:132-146` | 纯文本 "Loading…" / "Authorizing…" | `isAuthSourceLoading` / `isAuthLoading` |
| 会话加载 | `router.tsx:100-106` | 纯文本 "Loading session…" | `!session` |
| 消息加载 | `HappyThread.tsx:235-258` | 纯文本 "Loading..." + 按钮文本 | `isLoadingMessages` / `isLoadingMoreMessages` |
| Git 状态 | `files.tsx:313-318` | 纯文本 "Loading Git status..." / "Loading files..." | `gitLoading` / `searchResults.isLoading` |
| 文件内容 | `file.tsx:231-232` | 纯文本 "Loading file..." | `diffQuery.isLoading \|\| fileQuery.isLoading` |
| 登录按钮 | `LoginPrompt.tsx:77` | 按钮文本 "Signing in..." | `isLoading` |
| 创建会话 | `NewSession.tsx:119-122, 216` | "Loading machines..." / "Creating..." | `isPending` |
| 问卷提交 | `AskUserQuestionFooter.tsx:385` | 按钮文本 "Submitting…" | `loading` |

## 二、问题

1. **样式不统一** - 纯文本 vs SpinnerIcon vs 旋转符号
2. **SpinnerIcon 无法复用** - 定义在 PermissionFooter 内部
3. **省略号不一致** - "..." vs "…"

## 三、精简方案

**核心原则：Spinner 做基础元件，LoadingState 负责语义化加载**

### 创建唯一的 Spinner 组件（可访问性就绪）

```tsx
// web/src/components/Spinner.tsx
export function Spinner({
    size = 'md',
    className,
    label = 'Loading',
}: {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string
}) {
    const sizeClasses = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }
    return (
        <svg
            className={cn(sizeClasses[size], 'animate-spin text-[var(--app-hint)]', className)}
            viewBox="0 0 24 24"
            fill="none"
            role="status"
            aria-label={label}
        >
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.75" />
        </svg>
    )
}
```

### 新增 LoadingState（Spinner + 可选文案）

```tsx
// web/src/components/LoadingState.tsx
export function LoadingState({
    label = 'Loading…',
    className,
    spinnerSize = 'md',
}: {
    label?: string
    className?: string
    spinnerSize?: 'sm' | 'md' | 'lg'
}) {
    return (
        <div className={cn('inline-flex items-center gap-2 text-[var(--app-hint)]', className)} role="status" aria-live="polite">
            <Spinner size={spinnerSize} label={label} />
            <span>{label}</span>
        </div>
    )
}
```

### SyncingBanner 处理

**方案：不改，避免打扰用户**
- 保留顶部横幅与 `useSyncingState` 逻辑
- 若需要统一视觉，仅替换内部图标为新 `Spinner`

## 四、实施步骤

### Step 1: 创建 Spinner 组件（可访问性）
- [ ] 创建 `web/src/components/Spinner.tsx`，包含 `role="status"` 与 `aria-label`

### Step 2: 新增 LoadingState 组件
- [ ] 创建 `web/src/components/LoadingState.tsx`
- [ ] 统一使用 `Loading…`（省略号用 `…`）

### Step 3: 替换加载场景（保留语义）
- [ ] `App.tsx` - 认证相关使用 `<LoadingState label="Authorizing…" />`
- [ ] `router.tsx` - 会话加载使用 `<LoadingState label="Loading session…" />`
- [ ] `HappyThread.tsx` - 消息加载用 `<LoadingState label="Loading…" />`
- [ ] `files.tsx` - Git/文件列表加载用 `<LoadingState label="Loading files…" />`
- [ ] `file.tsx` - 文件内容加载用 `<LoadingState label="Loading file…" />`
- [ ] `PermissionFooter.tsx` - 使用新 `Spinner`，删除内部 `SpinnerIcon`

### Step 4: 按钮加载保持可读标签
- [ ] `LoginPrompt.tsx` / `NewSession.tsx` / `AskUserQuestionFooter.tsx` - 保留文字，旁边加 `Spinner size="sm"`
- [ ] 按钮添加 `aria-busy`，避免替换成纯图标

### Step 5: 列表/内容区优先 Skeleton 或占位
- [ ] `HappyThread.tsx` - 消息列表加载改为 skeleton/placeholder
- [ ] `files.tsx` - 文件列表加载改为 skeleton/placeholder
- [ ] `file.tsx` - 文件内容加载改为 skeleton/placeholder

### Step 6: SyncingBanner
- [ ] 保留 `SyncingBanner.tsx`
- [ ] 可选：内部图标替换为新 `Spinner`，不改交互与布局

## 五、关键文件

**新建：**
- `web/src/components/Spinner.tsx`
- `web/src/components/LoadingState.tsx`

**修改：**
- `web/src/App.tsx`
- `web/src/router.tsx`
- `web/src/components/AssistantChat/HappyThread.tsx`
- `web/src/routes/sessions/files.tsx`
- `web/src/routes/sessions/file.tsx`
- `web/src/components/ToolCard/PermissionFooter.tsx`
- `web/src/components/LoginPrompt.tsx`
- `web/src/components/NewSession.tsx`
- `web/src/components/ToolCard/AskUserQuestionFooter.tsx`
- `web/src/components/SyncingBanner.tsx`

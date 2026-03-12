# 组件规范

> 本项目中组件的构建方式。

---

## 概述

HAPI Web 使用 React 19 与 TypeScript。组件遵循函数式模式，具备清晰的 props 类型、使用 Tailwind CSS 进行样式处理，并内建可访问性支持。组件应保持小而专注，便于组合。

**关键库**：
- React 19 + hooks
- TanStack Router 用于路由
- `@assistant-ui/react` 用于 AI 聊天基元
- Tailwind CSS v4 用于样式
- class-variance-authority（CVA）用于变体样式
- 通过 `cn()` 工具使用 `clsx` + `tailwind-merge`

---

## 组件结构

### 标准组件模式

```typescript
// components/Spinner.tsx
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

type SpinnerProps = {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string | null
}

export function Spinner({
    size = 'md',
    className,
    label
}: SpinnerProps) {
    const { t } = useTranslation()
    // ...
    return <svg ...>...</svg>
}
```

关键点：
1. 使用具名函数导出（不要 default）
2. Props 类型在本地使用 `type` 定义
3. 在函数参数解构中提供默认值
4. 使用 `cn()` 处理条件 className 合并
5. 所有面向用户的文本都使用 `useTranslation()`

### Context Provider 模式

功能级上下文使用 Provider 组件 + 类型化 hook：

```typescript
// components/AssistantChat/context.tsx
export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    disabled: boolean
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    return <HappyChatContext.Provider value={props.value}>{props.children}</HappyChatContext.Provider>
}

// 当 context 缺失时必须抛错，绝不返回 undefined
export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useContext(HappyChatContext)
    if (!ctx) throw new Error('HappyChatContext is missing')
    return ctx
}
```

### 带变体的 UI 基元（CVA 模式）

对于可复用 UI 基元，使用 class-variance-authority：

```typescript
// components/ui/button.tsx
import { cva, type VariantProps } from 'class-variance-authority'

const buttonVariants = cva(
    'inline-flex items-center justify-center ...', // 基础 class
    {
        variants: {
            variant: {
                default: 'bg-[var(--app-button)] text-[var(--app-button-text)]',
                secondary: '...',
            },
            size: { default: 'h-9 px-4 py-2', sm: 'h-8 ...' }
        },
        defaultVariants: { variant: 'default', size: 'default' }
    }
)

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : 'button'
        return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    }
)
Button.displayName = 'Button'
```

---

## Props 约定

### 类型定义

- 组件 props 使用 `type`，不要使用 `interface`
- props 类型命名为 `<ComponentName>Props`
- props 类型与组件定义放在同一文件中

```typescript
// 推荐
type SpinnerProps = {
    size?: 'sm' | 'md' | 'lg'
    className?: string
    label?: string | null
}

// 不推荐 - 简单 props 不要使用 interface
interface SpinnerProps {
    size?: string
}
```

### 可选与必选

- 当 props 具有合理默认值时，用 `?` 标记为可选
- 默认值始终放在解构参数中，而不是单独变量里
- 对于“有意为空”的场景，显式使用 `null`（例如 `label?: string | null`）

```typescript
// 推荐 - 在解构中给默认值
function Spinner({ size = 'md', className, label }: SpinnerProps) {}

// 不推荐 - 在其他地方补默认值
function Spinner(props: SpinnerProps) {
    const size = props.size ?? 'md'  // 不要这样做
}
```

### Children

- children 使用 `ReactNode` 类型
- 名称始终使用 `children`

```typescript
type MyComponentProps = {
    children: ReactNode
    className?: string
}
```

### 事件处理器

- 事件处理 props 统一使用 `on` 前缀（例如 `onRetry`、`onLoadMore`）
- 类型要尽量精确，不要笼统写成 `() => void`

```typescript
type ThreadProps = {
    onLoadMore: () => Promise<unknown>  // 推荐 - 返回类型明确
    onRetryMessage?: (localId: string) => void  // 推荐 - 参数类型明确
}
```

---

## 样式模式

### 主题颜色使用 CSS Variables

所有主题相关颜色都应使用 CSS 自定义属性，不要写死颜色值：

```typescript
// 推荐 - 使用 CSS 变量
'bg-[var(--app-button)] text-[var(--app-button-text)]'
'bg-[var(--app-secondary-bg)]'
'text-[var(--app-fg)]'
'border-[var(--app-border)]'

// 不推荐 - 写死颜色，无法响应主题变化
'bg-blue-500 text-white'
```

可用 CSS 变量：
- `--app-bg` - 主背景
- `--app-fg` - 主前景/正文文本
- `--app-secondary-bg` - 次级背景
- `--app-subtle-bg` - 弱化背景（用于 hover 等状态）
- `--app-button` - 按钮背景
- `--app-button-text` - 按钮文字
- `--app-border` - 边框颜色
- `--app-link` - 链接/强调色
- `--app-hint` - 提示/弱化文字

### `cn()` 工具

组合 className 时始终使用 `cn()`：

```typescript
import { cn } from '@/lib/utils'

// 推荐
<div className={cn('base-classes', condition && 'conditional-class', className)} />

// 不推荐 - 直接拼接字符串
<div className={`base-classes ${condition ? 'conditional-class' : ''} ${className}`} />
```

### 响应式与条件类名

```typescript
// 条件 class
<div className={cn(
    'base px-3 py-2',
    isActive && 'bg-[var(--app-subtle-bg)]',
    isDisabled && 'opacity-50 pointer-events-none'
)} />
```

---

## 可访问性

### 必需模式

1. **加载态**：Spinner 使用 `role="status"` 与 `aria-label`
2. **隐藏的装饰内容**：使用 `aria-hidden="true"`
3. **仅供屏幕阅读器的文本**：使用 `sr-only` Tailwind class
4. **可交互元素**：确保所有可点击元素都支持键盘访问

```typescript
// Spinner 可访问性（来自 Spinner.tsx）
const accessibilityProps = effectiveLabel === null
    ? { 'aria-hidden': true }
    : { role: 'status', 'aria-label': effectiveLabel }
```

```typescript
// Skeleton 加载中的屏幕阅读器文本
<span className="sr-only">{t('misc.loadingMessages')}</span>
```

```typescript
// Button 加载状态
<Button aria-busy={isLoadingMoreMessages}>...</Button>
```

### 翻译

所有面向用户的文本都必须通过 `useTranslation()`：

```typescript
// 推荐
const { t } = useTranslation()
return <span>{t('misc.loading')}</span>

// 不推荐 - 写死字符串
return <span>Loading...</span>
```

---

## 场景：长内容自动折叠（仅 UI 层契约）

### 1. 范围 / 触发条件
- 触发条件：消息 / 工具 / CLI 内容可能长到超出可读范围，降低聊天可用性。
- 范围：仅前端渲染层（`web/src/components/*`），不涉及 reducer / protocol / API 变更。

### 2. 签名

```typescript
// web/src/lib/contentLimits.ts
export const LONG_CONTENT_COLLAPSE_THRESHOLD = 1000

export function shouldAutoCollapseContent(
  text: string,
  threshold: number = LONG_CONTENT_COLLAPSE_THRESHOLD
): boolean
```

```typescript
// web/src/components/LongContentCollapse.tsx
export function LongContentCollapse(props: {
  text: string
  children: ReactNode
  className?: string
  threshold?: number
}): JSX.Element
```

### 3. 契约
- 折叠规则：`text.length > threshold` 时默认折叠。
- 边界规则：`text.length === threshold` 时不折叠。
- 交互契约：
  - 折叠状态：`aria-expanded="false"`
  - 展开状态：`aria-expanded="true"`
- i18n 契约（不得写死面向用户的标签）：
  - `content.collapse.openWithHidden`
  - `content.collapse.close`

### 4. 校验与错误矩阵
- i18n key 缺失 -> 回退到 `I18nProvider` 中的英文 key 解析路径。
- 未传 `threshold` -> 使用默认值 `LONG_CONTENT_COLLAPSE_THRESHOLD`。
- 空文本（`""`）-> 永不折叠。

### 5. 良好 / 基线 / 反例
- Good：`CodeBlock`、`MarkdownRenderer`、`CliOutputBlock` 中的长文本都以一致的切换行为折叠。
- Base：文本恰好 1000 字符时直接渲染，不显示折叠按钮。
- Bad：组件里写死标签，或每个视图自定义不同 threshold，导致 UX 不一致。

### 6. 必需测试
- 组件测试必须覆盖：
  1. 边界情况（`=== threshold`）下无 toggle 按钮，
  2. 超阈值情况（`> threshold`）默认折叠，
  3. 点击 toggle 后 `aria-expanded` 从 false 变为 true。
- 对 i18n 敏感的断言，应从 locale keys 读取标签，而不是复制写死文本。

### 7. 错误示例 vs 正确示例

```tsx
// Wrong: 写死标签（破坏 i18n 一致性）
<span>展开长消息（已隐藏部分）</span>
```

```tsx
// Correct: 使用翻译标签
const { t } = useTranslation()
<span>{t('content.collapse.openWithHidden')}</span>
```

---

## 场景：行导航与操作按钮冲突（触屏 + 指针）

### 1. 范围 / 触发条件
- 触发条件：一个可选中的列表行内部又嵌套了操作按钮（rename/archive/delete/more）。
- 范围：前端交互层（`web/src/components/*`），涉及共享的 press/click hooks。

### 2. 签名

```typescript
// 行级导航
onSelect: (sessionId: string) => void

// 内嵌操作按钮
onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
```

```typescript
// 绑定在操作区域 / 操作按钮上的 guard handlers
const preventRowSelectHandlers = {
  onPointerDownCapture: handleActionPointerDownCapture,
  onMouseDownCapture: handleActionPointerDownCapture,
  onTouchStartCapture: handleActionPointerDownCapture,
  onTouchEndCapture: handleActionPointerDownCapture,
}
```

### 3. 契约
- 点击操作按钮时**绝不能**触发行导航。
- 点击行主体区域时仍然必须触发行导航。
- 在触屏设备上，guard 逻辑必须同时覆盖 Touch Events 与 Pointer/Mouse Events。
- 如果行上使用了 long-press hook，那么内嵌操作区域必须在 capture 阶段设置 guard flag。

### 4. 校验与错误矩阵
- 桌面端鼠标点击操作按钮 -> 只打开操作弹窗 / 菜单。
- 移动端轻触操作按钮 -> 只打开操作弹窗 / 菜单。
- 轻触行的非操作区域 -> 跳转到详情页。
- 长按行的非操作区域 -> 打开行级上下文菜单。
- 在操作区域上长按 / 轻触 -> 不得打开行级上下文菜单，也不得触发导航。

### 5. 良好 / 基线 / 反例
- Good：操作按钮同时使用 `e.stopPropagation()` 与 pointer/mouse/touch 的 capture handlers。
- Base：只有从非操作区域点击时才触发行导航。
- Bad：只在按钮上通过 `onClick` 做 stopPropagation，而行监听的是 `onTouchStart/onTouchEnd`；结果移动端轻触仍然发生导航。

### 6. 必需测试
- 组件交互测试应覆盖：
  1. 点击/轻触操作按钮不会调用 `onSelect`，
  2. 点击/轻触行主体会调用 `onSelect`，
  3. touch 事件路径不会绕过行/操作区隔离逻辑。

### 7. 错误示例 vs 正确示例

```tsx
// Wrong: 只阻止 click 冒泡，但 touch 路径仍会触发行级 handler
<button onClick={(e) => { e.stopPropagation(); setDeleteOpen(true) }} />
```

```tsx
// Correct: 阻止 click 冒泡 + 为 touch/pointer/mouse 添加 capture guards
<button
  onClick={(e) => {
    e.stopPropagation()
    setDeleteOpen(true)
  }}
  onPointerDownCapture={handleActionPointerDownCapture}
  onMouseDownCapture={handleActionPointerDownCapture}
  onTouchStartCapture={handleActionPointerDownCapture}
  onTouchEndCapture={handleActionPointerDownCapture}
/>
```

---

## 本地子组件

对于只在单个文件内使用的子组件，应定义在同文件内，并位于主导出组件之前：

```typescript
// 推荐 - 本地辅助组件与主组件放在同一文件
function NewMessagesIndicator(props: { count: number; onClick: () => void }) {
    if (props.count === 0) return null
    return <button onClick={props.onClick}>...</button>
}

function MessageSkeleton() {
    return <div className="space-y-3 animate-pulse">...</div>
}

// 主导出组件
export function HappyThread(props: HappyThreadProps) {
    return (
        // 使用本地子组件
        <NewMessagesIndicator ... />
    )
}
```

---

## 常见错误

- ❌ 对 props 使用 `interface` 而不是 `type`
- ❌ 使用写死颜色而不是 CSS 变量
- ❌ 留下未翻译的面向用户字符串
- ❌ 在加载态/交互元素上缺少 `aria-*` 属性
- ❌ 使用 `default export`（应使用具名导出）
- ❌ 直接在组件体中编写业务逻辑（应抽到 hooks）
- ❌ 使用相对导入而不是 `@/` 别名
- ❌ 直接修改 props
- ❌ 在 props 定义中使用 `any`

# session-terminal-panel Widget

会话终端面板组件，显示 xterm.js 终端。

## 功能

- xterm.js 终端集成
- 自动适配容器大小
- 主题颜色适配
- 字体加载和刷新
- Web 链接支持

## 依赖

- `@xterm/xterm` - 终端模拟器
- `@xterm/addon-fit` - 自适应插件
- `@xterm/addon-web-links` - 链接插件
- `@xterm/addon-canvas` - Canvas 渲染

## 使用

```tsx
import { SessionTerminalPanel } from '@/widgets/session-terminal-panel'

<SessionTerminalPanel
  onMount={(terminal) => {
    terminal.write('Hello, terminal!\r\n')
  }}
  onResize={(cols, rows) => {
    console.log(`Terminal resized to ${cols}x${rows}`)
  }}
/>
```

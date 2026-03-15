# switch-language

## 职责

切换应用界面语言，包括：
- 显示语言选择器
- 切换语言
- 保存语言偏好
- 更新界面文本

## 依赖

### shared
- `shared/lib` - i18n 工具、本地存储
- `shared/ui` - Dropdown 等组件

## 目录结构

```
switch-language/
├── ui/
│   └── LanguageSwitcher.tsx     # 语言切换器
└── index.ts                     # 公共导出
```

## 迁移来源

- `web/src/components/LanguageSwitcher.tsx` - 语言切换器组件

## 使用示例

```tsx
import { LanguageSwitcher } from '@/features/switch-language'

function Header() {
  return (
    <header>
      <Logo />
      <LanguageSwitcher />
    </header>
  )
}
```

## 注意事项

- 语言偏好需要持久化到本地存储
- 切换后立即生效
- 支持键盘导航（Escape 关闭）
- 点击外部区域关闭下拉菜单

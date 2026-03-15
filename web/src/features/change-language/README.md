# change-language Feature

> 切换界面语言功能

## 功能说明

提供界面语言切换功能，支持：
- 多语言选择（英文、简体中文）
- 语言状态持久化
- 下拉菜单选择器

## 依赖

- `@/lib/use-translation` - 国际化翻译

## 使用示例

```tsx
import { LanguageSwitcher } from '@/features/change-language'

function Header() {
  return (
    <div>
      <LanguageSwitcher />
    </div>
  )
}
```

## 组件

### LanguageSwitcher

语言切换器组件，显示当前语言并提供下拉菜单选择。

**Props**: 无

**行为**:
- 点击按钮显示语言列表
- 选择语言后自动切换并关闭菜单
- 点击外部或按 ESC 关闭菜单
- 当前语言显示勾选标记

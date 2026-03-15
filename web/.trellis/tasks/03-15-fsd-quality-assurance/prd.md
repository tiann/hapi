# brainstorm: FSD 迁移质量保障与并发子任务拆分

## Goal

通过系统化的质量保障流程，确保 FSD 架构迁移的代码质量、功能完整性和可维护性。利用并发子任务加速质量检查过程，包括功能对比、单元测试覆盖、代码审查和文档更新。

## What I already know

### 架构迁移状态
- **已完成层级**：shared → entities → features → widgets → pages → processes → app
- **代码统计**：
  - shared 层：~24 个文件（包含 2 个测试文件）
  - entities 层：~77 个文件（6 个实体）
  - features 层：~19 个文件（9 个功能）
  - widgets 层：~15 个文件（7 个组件）
  - pages 层：~9 个文件（4 个页面）
  - processes 层：~10 个文件（2 个流程）
  - app 层：~4 个文件
- **现有测试**：20 个测试文件（大部分在旧代码中，FSD 层级测试覆盖率低）
- **类型检查**：TypeScript 编译通过 ✅

### 主人的原始需求
- 基于模块设计任务拆分
- 功能对比
- 单元测试覆盖
- 基于小模块的代码 review
- 尽量多的拆分出不同的并发子任务

## Assumptions (temporary)

- 用户希望最大化并发度以加速质量保障流程
- 质量保障的主要目标是确保 FSD 迁移没有引入回归
- 测试覆盖主要关注单元测试，集成测试和 E2E 测试可能不在范围内
- 代码 review 主要关注架构合规性和代码质量

## Open Questions

1. **测试策略偏好**：
   - 只需要单元测试覆盖？
   - 还是需要集成测试 + E2E 测试？
   - 目标覆盖率是多少？（70%? 80%? 90%?）

2. **功能对比维度**：
   - 新旧架构的 API 兼容性对比？
   - 功能完整性对比？
   - 性能对比？
   - 还是全部都要？

3. **代码 Review 重点**：
   - FSD 架构合规性检查？
   - 代码质量（复杂度、可读性）？
   - 性能优化建议？
   - 安全性审查？

4. **优先级排序**：
   - 是否所有层级都需要同等深度的质量保障？
   - 是否有特定的层级或模块是高风险区域？

## Requirements (evolving)

### 必需项
- [ ] 为每个 FSD 层级创建测试覆盖计划
- [ ] 执行功能对比验证（新旧架构行为一致性）
- [ ] 进行代码 review（架构合规性 + 代码质量）
- [ ] 更新相关文档

### 待确认项
- [ ] 测试覆盖率目标
- [ ] 功能对比的具体维度
- [ ] 代码 review 的关注点
- [ ] 是否需要性能基准测试

## Acceptance Criteria (evolving)

- [ ] 所有 FSD 层级有明确的测试计划
- [ ] 核心功能测试覆盖率达到目标值
- [ ] 功能对比通过（无回归）
- [ ] 代码 review 问题已解决
- [ ] 文档已更新
- [ ] TypeScript 类型检查通过
- [ ] 所有测试通过

## Definition of Done (team quality bar)

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes
- Rollout/rollback considered if risky
- Code review completed and approved
- Architecture compliance verified

## Out of Scope (explicit)

- E2E 测试（除非明确要求）
- 性能优化（除非发现重大问题）
- 新功能开发
- 重构现有代码（除非发现严重问题）

## Technical Notes

### FSD 层级统计
```
shared/     - 24 文件 (2 测试)
entities/   - 77 文件 (1 测试)
features/   - 19 文件 (0 测试)
widgets/    - 15 文件 (0 测试)
pages/      - 9 文件  (0 测试)
processes/  - 10 文件 (0 测试)
app/        - 4 文件  (0 测试)
```

### 测试覆盖率分析
- 现有测试主要集中在旧代码（components/, hooks/, lib/）
- FSD 新层级测试覆盖率接近 0%
- 需要为新层级补充测试

### 并发任务设计思路
基于 FSD 层级独立性，可以按层级拆分并发任务：
1. 每个层级可以独立进行测试编写
2. 功能对比可以按层级并行执行
3. 代码 review 可以按模块并发进行

### 潜在风险
- 测试编写工作量可能较大
- 功能对比需要访问旧代码作为基准
- 代码 review 可能发现需要重构的问题

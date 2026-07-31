# AGENTS.md — AI 协作约束

## 何时必须查阅 openspec/
- 任何涉及地图底图、坐标系统、照片导入/存储、播放逻辑的行为变更
- 评估改动是否影响既有能力（capability）的对外行为

## 工作流
1. 新需求或改动 → 在 `openspec/changes/<change-id>/` 起草 proposal
2. proposal 中声明影响哪些 capability（新建或修改）
3. 为每个 capability 写 delta spec（`## ADDED/MODIFIED/REMOVED Requirements`）
4. 复杂改动补 `design.md`；拆 `tasks.md` 跟踪实现
5. 实现完成后对照 spec 验收；通过后归档并回写 `openspec/specs/`

## 输出约束
- spec 只描述对外可观察行为，不写内部函数名/库选择
- Requirement 用 SHALL/MUST；Scenario 用 `#### Scenario:` + WHEN/THEN
- 纯重构/工具/文档类无行为变更的改动，在 `.openspec.yaml` 设 `skip_specs: true`
- 不要为通过校验而虚构 requirement

## 当前正式规范位置
- `openspec/specs/<capability>/spec.md` 为单一事实来源
- `openspec/changes/` 仅为进行中变更，归档后内容合并回 `specs/`

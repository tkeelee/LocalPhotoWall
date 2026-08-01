## Purpose
定义照片导入与数据库加载过程中的重复哈希处理策略。当遇到已存在的哈希时，后载入的数据 SHALL 覆盖前值，使更正后的数据（如重新解析的 EXIF、更新的缩略图）能够生效。这与"加载多个数据库遇到重复哈希时后载入数据优先"的工程约束一致。

## ADDED Requirements

### Requirement: 重复哈希后载入覆盖
导入照片或加载数据库时，若照片哈希已存在于当前 `hashSet`，系统 SHALL 不跳过，而以 `UPDATE photos SET 全字段 WHERE hash=?` 用后载入值覆盖前值。系统 SHALL 统计被覆盖的数量并归入 `updated` 字段（不再使用 `skipped` 字段）。

#### Scenario: 导入时遇到重复哈希覆盖
- **WHEN** 用户导入的照片哈希已存在
- **THEN** 系统用新值覆盖数据库中原记录的全字段，统计为 updated

#### Scenario: 加载数据库时遇到重复哈希覆盖
- **WHEN** 用户加载的数据库文件中某哈希已存在于内存
- **THEN** 系统用后载入数据库的值覆盖前值，统计为 updated

### Requirement: 导入结果提示文案
导入/加载完成后的 Toast 提示 SHALL 明确区分「新增」与「覆盖」：提示文案 SHALL 包含「X 张哈希重复已覆盖（后载入为准）」与「实际导入 X 张、覆盖 Y 张」字样，让用户感知覆盖行为。

#### Scenario: 有覆盖时提示覆盖数量
- **WHEN** 导入/加载完成且 `updated > 0`
- **THEN** Toast 文案包含「X 张哈希重复已覆盖（后载入为准）」与「实际导入 X 张、覆盖 Y 张」

#### Scenario: 无覆盖时不提示覆盖
- **WHEN** 导入/加载完成且 `updated == 0`
- **THEN** Toast 文案不包含覆盖相关字样，仅提示新增与无 GPS 数量

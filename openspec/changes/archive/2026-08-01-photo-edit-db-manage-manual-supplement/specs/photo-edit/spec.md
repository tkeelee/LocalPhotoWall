## Purpose
允许用户在大图查看器内修正单张照片的文件名与照片路径，保存后即时持久化到数据库文件，无需额外的保存操作。其余字段（经纬度、拍摄时间、尺寸）为只读，保证 EXIF 数据真实性。

## ADDED Requirements

### Requirement: 查看器内编辑入口
系统 SHALL 在大图查看器 frame 内、删除按钮左侧提供编辑按钮，按钮 SHALL 为纯图标（铅笔 SVG，无文字）。按钮点击 SHALL 仅将 `#viewerMeta` 替换为内联编辑表单，不关闭大图查看器。按钮点击事件 SHALL 阻止冒泡，避免触发查看器的关闭逻辑。

#### Scenario: 查看器内显示编辑按钮
- **WHEN** 用户打开某张照片的大图查看器
- **THEN** 查看器 frame 内、删除按钮左侧显示一个铅笔图标编辑按钮

#### Scenario: 点击编辑按钮打开内联表单
- **WHEN** 用户点击编辑按钮
- **THEN** `#viewerMeta` 区域被替换为编辑表单，大图查看器保持打开

### Requirement: 可编辑字段范围
编辑表单 SHALL 仅允许编辑「文件名」与「照片路径」两个字段。经纬度、拍摄时间、尺寸字段 SHALL 以只读形式展示，不可修改。

#### Scenario: 表单展示可编辑与只读字段
- **WHEN** 编辑表单打开
- **THEN** 文件名、照片路径为可编辑输入框；经纬度、拍摄时间、尺寸为只读展示

### Requirement: 编辑保存与即时持久化
用户在编辑表单点击「保存」时，系统 SHALL 校验文件名非空，若文件名与路径均未修改 SHALL 提示无修改并恢复只读视图。有修改时系统 SHALL 通过 `UPDATE photos SET name=?, path=? WHERE hash=?` 更新数据库、同步内存 `photos` 数组对应项、立即将变更持久化到数据库文件（无需用户额外触发保存）、刷新查看器元信息为只读视图、显示保存成功提示。

#### Scenario: 文件名为空时拒绝保存
- **WHEN** 用户清空文件名后点击「保存」
- **THEN** 系统提示文件名不能为空，不执行保存

#### Scenario: 无修改时提示并恢复
- **WHEN** 用户未修改任何字段即点击「保存」
- **THEN** 系统提示无修改，恢复只读元信息视图

#### Scenario: 保存后写盘并刷新视图
- **WHEN** 用户修改文件名或路径后点击「保存」
- **THEN** 数据库记录更新、内存同步、变更写入数据库文件、查看器恢复只读视图并显示新值、显示保存成功提示

### Requirement: 取消编辑
用户在编辑表单点击「取消」时，系统 SHALL 放弃所有修改，将 `#viewerMeta` 重新渲染为只读元信息视图，不写入数据库。

#### Scenario: 取消放弃修改
- **WHEN** 用户在编辑表单点击「取消」
- **THEN** 修改被丢弃，`#viewerMeta` 恢复为只读视图，显示原始值

### Requirement: 查看器 hover 延迟关闭
鼠标离开照片缩略图、查看器 frame、`#viewerMeta` 任一元素时，系统 SHALL 启动 220ms 延迟关闭计时器，而非立即关闭。鼠标进入查看器 frame 或 `#viewerMeta` 时 SHALL 取消该计时器。点击查看器 frame 或 `#viewerMeta` 内部 SHALL 不触发 dismiss。关闭查看器时 SHALL 清理未触发的计时器。

#### Scenario: 鼠标离开启动延迟关闭
- **WHEN** 鼠标离开缩略图且未进入查看器 frame/`#viewerMeta`
- **THEN** 220ms 后查看器关闭

#### Scenario: 鼠标进入查看器取消关闭
- **WHEN** 鼠标离开缩略图后在 220ms 内进入查看器 frame 或 `#viewerMeta`
- **THEN** 关闭计时器被取消，查看器保持打开

#### Scenario: 点击查看器内部不关闭
- **WHEN** 用户点击查看器 frame 或 `#viewerMeta` 内的任意元素
- **THEN** 查看器不关闭

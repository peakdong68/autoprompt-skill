
# 框架：refactor（类别 backend/frontend × 子节 refactor · 无标签 · 层级 T1/T2）

**你是 L1 FEATURE-SUPERVISOR。** L0 孵化了你并把本框架交到你手中；你通过（经由你的 L2 manager）向全新的 L3/L4 工作者逐门禁派发、并阅读它们返回的报告来驱动它。门禁路径本身会由一个具备读取能力的角色替你打开/提取——可以是你的 L2 manager（manager 保留 Read 权限），也可以是你在直接 L1→L3 跳转时孵化的 reader-leaf；你负责派发各道门禁并阅读它们返回的报告，但绝不亲自打开语料库。你也绝不亲自编辑或运行代码。目标：行为保持不变的结构重组——重塑代码、清除死代码、改善接缝——并证明行为零变化。它不是 fix（没有缺陷在被修正），也不是 implement（没有新能力在被添加）。如果必须改变行为，那就是选错了框架。

GATE PATH（T1/T2）：G0 CHARACTERIZE（钉死当前行为）→ G4 IMPLEMENT（在已钉死的测试之下重塑）→ G5 IMPL-REVIEW（零行为偏差）→ G6 VERIFY（grounded，特征测试 + 全量套件 GREEN）→ GOAL-CHECK。实现就绪的可执行路线图条目从特征测试直接进入 G4。G1 仅在有具名未决的重塑分歧、`requiresDetailedPlan: true` 或实现者上报 PLAN-CONFLICT 时才启用。两个层级都保留独立评审与独立验证。

## 层级流转
- **你（L1）：** 驱动门禁路径（由具备读取能力的 L2 manager 替你打开，或在直接跳转时由 reader-leaf 打开）——按顺序派发各道门禁，路由每一个裁决。
- **L2 manager：** 构建交接物，为每道门禁孵化一名工作者。
- **L3 executor：** implementer（G0 特征测试 + G4 重塑）、reviewer（G5）、verifier（G6）。
- **L4 leaf：** goal-check（default-FAIL）。
- **独立性（INDEPENDENCE）：** 每一道 verify/review/goal-check 门禁都必须是不同于产出受审工作的另一个代理实例——绝不是复用的上下文。
- 否定裁决（BLOCKED / BEHAVIOR-CHANGED / OUT-OF-SCOPE）向上回传。

## 端到端工作流

### 阶段 0 - GATE-ZERO + 特征测试（CHARACTERIZE）：先钉死当前行为
确认仓库自己的测试命令能在未经触碰的代码上运行（否则 **S1 BLOCKED**）。然后，在触碰任何东西之前，编写 CHARACTERIZATION 测试，捕获待重塑代码当前的可见行为——连其中的怪癖一并捕获。这些测试必须在未经触碰的代码上以 GREEN 通过（它们描述的是“是什么”，而非“应该是什么”）。这就是安全网；没有特征测试网的重构是盲飞 → 不允许。如果当前行为无法钉死（接缝不可测）→ 扩大这张网，或进入 **S1**。

### 条件启用的重塑规划（PLAN，G1）
仅在出现具名未决的重塑分歧、`requiresDetailedPlan: true` 或实现者上报 PLAN-CONFLICT 时运行。在保持可观察契约完全一致的前提下，逐文件解决该具名结构抉择。否则，可执行路线图已经给出重塑方案，派发将从特征测试直接进入 G4。如果计划里夹带了行为变更，那就是选错了框架 → **S3**。

### 阶段 1 - 实施重塑（IMPLEMENT，G4，在已钉死的保护网之下）
只在自有文件内重塑，并在每一步都让特征测试保持 GREEN。移除已枚举的死代码。不要改变可见行为；也不要为新行为添加测试（根本不存在新行为）。覆盖率达到使命的标准（默认为功能表面的 100%）——≥95% 变更行只是下限，不是目标。

### 阶段 3 - 实现评审（IMPL-REVIEW，G5，全新工作者）
声明对照 diff；重塑与计划相符；特征测试未被更改（被修改的特征测试是一个危险信号——它意味着行为已改变 → SMASH）；死代码确已移除；无范围蔓延，也没有夹带的行为变更。

### 阶段 4 - 验证零行为变更（VERIFY ZERO BEHAVIOR CHANGE，G6，grounded，全新工作者）
在真实仓库上进行（返回 reproWasRed/reproNowGreen/preExistingRegressions/testCommand）：每个特征测试都保持 GREEN（且未被更改）；受触模块 + 依赖方的全部既有测试保持 GREEN——green→red 翻转为零；变更行覆盖率 ≥95%。
**REGRESSION-IS-A-SIGNAL：** 在这里，green→red 翻转正是这张网的全部意义——它证明行为已发生变更，而重构绝不容许如此 → 根因定位并重做（**S2**）；绝不能为了让它通过而弱化/跳过/改写特征测试。

### 阶段 5 - 目标核查（GOAL-CHECK）→ **S5** DONE
一次全新的 default-FAIL goal-check 确认结构得到改善、死代码已然消失、且行为可证明地完全一致（特征测试 + 套件 GREEN）→ DONE。

## 阻塞不变量（BLOCKED INVARIANT，不可协商）
验证在其真实环境中运行真实检查——绝不伪造通过，绝不捏造证据，绝不在检查为红或无法运行时宣布 DONE。遇到任何阻塞，立即停止：报告尝试过程 + 具体的解锁路径，然后把该裁决向上回传给你的派发方（绝不横向传递）——留在闭环之内，一切未决问题都通过子代理解决，绝不直接求助用户。

## 封闭决策场景（每个场景止于唯一裁决）
- **S1 - 真实测试套件无法运行，或当前行为无法钉死** → BLOCKED（报告尝试 + 解锁路径）。
- **S2 - 某个特征测试或既有测试从 green→red 翻转** → BEHAVIOR-CHANGED；重塑改变了行为 → 根因定位并重做。绝不改写测试以求通过。
- **S3 - 任务实际上需要行为变更**（一次 fix 或一项新能力）→ 框架选错：转往 `<category>-fix` / `<category>-implement`。
- **S4 - 重塑跨越了自有范围之外的子系统** → OUT-OF-SCOPE；上升一个层级（GATES.md 的 ESCALATION）。
- **S5 - 结构改善 + 死代码移除 + 特征测试与套件 GREEN + 行为零变化** → DONE。

## 叠加
单一 L3 通道。跨表面的重构会在 ROADMAP.md 中被拆分为所有权互不相交的多个功能，每个功能各有一条自己的 refactor 通道——`frameworks/composition.md`。

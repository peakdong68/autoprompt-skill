
# 框架地图（把一个功能路由到它的工作流）

**从获批的可执行 `ROADMAP.md` 出发，**对每个功能的 category/tag/tier 把 SELECTOR（§3）走上一遍（first-match-wins），最终落在恰好一个具名框架上；记录 `FRAMEWORK: <leaf>`。**L0 孵化本次运行唯一的 ap-feature-coordinator（L1）——每次运行仅一个，拥有全部功能——并把路线图功能集连同每个框架名交给它。对于多功能切片，coordinator 为每个功能扇出一个 L2 ap-manager；对于单个有界功能，它自行构建交接物并直接派发 L3 executor（manager 是可选的）。无论派发者是谁——manager 还是 coordinator——都由它打开该功能的叶子规格并驱动它**（把其中的门禁派发给 L3/L4 工作者）。这些叶子规格就是端到端工作流，由唯一 coordinator 之下的该功能派发者驱动。

一个框架 = 一个 CATEGORY × 一个 SUB-SECTION + 默认 tag 和 tier。它指明派发者要遵循的端到端工作流 + 封闭的 if/else 场景，包括其声明的 `GATE PATH`（形状决定哪些门禁会运行；tier 始终是深度上限）。每个叶子规格都带有一行明确的 `GATE PATH:`；下面的清单与之逐一对应，因此本文档兼作路由表。三扇前门覆盖路线图的全部七个 category（见 PLAYBOOKS.md）：**backend** = `backend`/`data`/`integration`/`infra`；**frontend** = `frontend`；**plan** = `plan`/`docs`——另有与 category 无关的 `apply` 前门，服务于完全规定好的机械性变更。

---

## 1. 14 个叶子（每个 → `frameworks/` 下各自的规格文件）

**（APPLY）——与 category 无关、完全规定好的机械性变更**
- `apply` —— 要做什么（WHAT）已完全明确（冻结规格、“把 X 改名为 Y”、脚手架、配置、依赖升级）：应用它，证明绿灯。无 tag，T0/T1。GATE PATH：`APPLY → DIFF-REVIEW → VERIFY-GREEN`（无 plan 门禁、无 fresh-verify、无陪审员——PROPORTIONAL-GATES 最小路径）。

**（A）backend** —— server / data / integration / infra
- `backend-fix` —— 损坏的行为：复现红灯、根因定位、证明绿灯。`debug`，T1/T2。**携带 BLOCKED 不变量。** GATE PATH：`G1 PLAN → G3.5 DEPTH-LOCK → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → GOAL-CHECK`（T2 增加一名陪审员）。
- `backend-implement` —— 新增/修改一个有界能力，并附带测试。无 tag，T2。GATE PATH：`G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → G7 SIGN-OFF → GOAL-CHECK`；仅在 `requiresDetailedPlan`、存在未决设计分歧或 `PLAN-CONFLICT` 时前置 G1。
- `backend-build` —— 从零开始的全新组件 + 接线。无 tag（若接入外部系统则为 `external-target` 叠加层），T2/T3。GATE PATH：`G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → G7 SIGN-OFF → GOAL-CHECK`；仅在 `requiresDetailedPlan`、存在未决设计分歧或 `PLAN-CONFLICT` 时前置 G1（T3 增加 SCOPE-AND-ROADMAP + 3 名陪审员）。

**（B）frontend** —— 任何人机接触的 UI / 客户端 / CLI 表面
- `frontend-fix` —— 损坏的 UI 行为：复现红灯、证明绿灯。`debug`，T1/T2。GATE PATH：`G1 PLAN → G3.5 DEPTH-LOCK → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY → GOAL-CHECK`（T2 增加一名陪审员）。
- `frontend-implement` —— 一个有界的 UI 部件 + 测试 + 可用性检查。`user-facing`，T2。GATE PATH：`G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(+usability) → G7 SIGN-OFF → GOAL-CHECK`；仅在 `requiresDetailedPlan`、存在未决设计分歧或 `PLAN-CONFLICT` 时前置 G1。
- `frontend-build` —— 全新的 UI 表面/流程。`user-facing`，T2/T3。GATE PATH：`G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(+usability) → G7 SIGN-OFF → GOAL-CHECK`；仅在 `requiresDetailedPlan`、存在未决设计分歧或 `PLAN-CONFLICT` 时前置 G1（T3 增加 SCOPE-AND-ROADMAP + 3 名陪审员）。
- `frontend-review` —— 多画像的实地站点评审：N 个画像访问正在运行的应用，逐步截图，把缺陷/视觉/UX/文案/参与度方面的发现汇入一份去重后的工件；P0/P1 问题作为 fix 通道回流。`user-facing`，T1/T2/T3。GATE PATH：`G0 SURFACE-PROBE → G1 PLAN(personas) → PERSONA-FANOUT(live visits + screenshots) → DEDUPE → G6 REVIEW-VERIFY → ROUTE-FIXES → GOAL-CHECK`。无浏览器时降级为带 UNVERIFIED-VISUALLY 标注的静态走查——绝不伪造截图。
- `polish` —— 对既有可用表面做视觉/文案/细节打磨（间距、状态、微文案、响应式）。`polish`，T1/T2。GATE PATH：`G1 PLAN(inventory) → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(+rendered) → G7 SIGN-OFF(polish gate) → GOAL-CHECK`；T1 省略 G7 但保留 G5/G6。与 `frontend-review` 的发现配套。

**（C）plan** —— spec/design/research/docs（不拥有生产代码）
- `plan-scope` —— 使命 → 按依赖排序的功能路线图。无 tag，T2/T3。GATE PATH：有界范围为 `AUTHOR → REVIEW + FRESH-VERIFY → DONE`；多表面范围在 author 与 assurance 之间恰好加入两个并发的 scout。
- `plan-research` —— 通过真实的带凭证研究（research-with-receipts）找到/定义一个 UNKNOWN 目标。`research`，T2。GATE PATH：`FRAME + DIVIDE → RESEARCH per theme → SYNTHESIZE → FRESH-VERIFY → DONE`。
- `plan-design` —— 为一个 KNOWN 目标作架构决策（构建阶段的蓝图）。无 tag，T2。GATE PATH：`FRAME → ENUMERATE options → DECIDE + BLUEPRINT → FRESH-VERIFY → DONE`。
- `docs` —— 文档交付物（README/API 文档/指南）：受众分析 + 对照代码的准确性验证 + 一个能运行的示例。无 tag，T0/T1/T2。GATE PATH：`G4 WRITE → G5 DOC-REVIEW → G6 ACCURACY-VERIFY(against code + example runs) → GOAL-CHECK`；T1/T2 前置 G1 受众规划。

**（REFACTOR）——保持行为不变的结构重组（backend 或 frontend）**
- `refactor` —— 先特征测试，再重塑 + 死代码清除，证明行为零变化。无 tag，T1/T2。GATE PATH：`G0 CHARACTERIZE → G1 PLAN(reshape) → G4 IMPLEMENT → G5 IMPL-REVIEW → G6 VERIFY(zero delta) → GOAL-CHECK`；两个层级都保留独立评审与独立验证。

---

## 2. 叠加（多表面任务）

跨表面的任务会在 ROADMAP.md 中被拆分为所有权互不相交的功能；selector 按功能逐一运行，每个功能作为唯一 ap-feature-coordinator 之下的一个同级 L2 ap-manager 运行（WIDE 模式下并行，TOKENSAVER 模式下为一波 ≤6 的小规模），每个 manager 以 L3/L4 工作的方式驱动其框架的门禁。完整机制 + 场景见 `frameworks/composition.md`。

---

## 3. SELECTOR（封闭树，FIRST MATCH WINS，无判断环节）

```
SELECT-FRAMEWORK(task):

STEP 0 - APPLY front door (fully-specified mechanical change), first:
  0a. the mission LITERALLY carries an exact diff OR an explicit command/edit list
      (frozen patch, "rename X to Y everywhere", scaffold emission, config change,
      dep bump) AND no design decision remains. No such artifact in hand => apply
      is INELIGIBLE; fall through to STEP 1 (never self-declare "spec complete") -> apply

STEP 1 - CATEGORY (front-door surface), first match wins:
  1a. OUTPUT is a spec/plan/roadmap/research finding/architecture decision/
      documentation AND no production code changes              -> plan
  1b. elif it touches a HUMAN-FACING surface (UI, web/client screen,
      a CLI command a person types)                             -> frontend
  1c. else (server logic, data, integration, infra - DEFAULT)   -> backend

STEP 2 - SUB-SECTION, first match wins:
  if plan:
    2a. target is UNKNOWN, must be discovered/researched         -> plan-research
    2b. elif a known target needs an architecture decision       -> plan-design
    2c. elif the output is DOCUMENTATION (README/API docs/guide)  -> docs
    2d. else (scope into features - DEFAULT)                      -> plan-scope
  if backend OR frontend:
    2e. behavior-preserving RESTRUCTURING (no behavior change)    -> refactor
    2f. elif something is BROKEN / behaves wrong / a test is red  -> <category>-fix
    2g. elif (frontend) a multi-persona LIVE REVIEW of a running
        surface (needs a runnable surface signal)                -> frontend-review
    2h. elif (frontend) a visual/copy/detail POLISH pass          -> polish
    2i. elif building a WHOLE NEW component/surface from scratch  -> <category>-build
    2j. else (change one bounded piece - DEFAULT build arm)       -> <category>-implement

If STEP 0 / STEP 1 / STEP 2 do not produce a CONFIDENT match (category ∧ sub-section),
the selector returns `FRAMEWORK: MISS` and routes to the GENERATOR (`frameworks/generation.md`).
There is NO silent default - a non-matching task NEVER lands on backend-implement.
A `frontend-review` with no runnable-surface signal is NOT a confident review match - it
falls to `frontend-fix` (if broken) or `frontend-implement`, deterministically, never a
faked live review. **This prose tree (§3) is the SINGLE SOURCE OF TRUTH for routing** -
walk it by hand, first-match-wins; the former `workflow/framework-selector.js`
has been removed, so never defer routing to it. A confident branch ends at a seeded leaf; a
non-confident task returns MISS and routes to the GENERATOR (`frameworks/generation.md`).
```

闭合性（Closure）：闭合性覆盖 SELECT ∪ GENERATE 全体。每条被路由到的叶子都存在；每个预置（seeded）叶子都可达；有把握的分支终止于某个叶子；没有把握的任务返回 MISS 并转往 GENERATE（绝不会悄悄落入 backend-implement）；真正包含两块内容的任务会被分解后再叠加（§2）。

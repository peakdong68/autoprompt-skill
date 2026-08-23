
# 框架如何组合（COMPOSE）（叠加并同时运行）

**你是 PARENT。**当一个任务跨越多个功能面时，你可以按照本篇同时运行多个框架。它不新增任何调度器/门禁/层级——它复用既有的 L2→L3 兄弟拆分、每条 L3 的扇出纪律（BILLIONAIRE 模式下无数值上限）、TOKENSAVER/BILLIONAIRE 两种模式，以及全局运行预算（只按名称引用，绝不复述）。

## 两种模式
- **水平叠加（HORIZONTAL STACK）——N 个框架，同时运行。**跨越互斥功能面的任务被拆分为 N 个所有权互斥的子任务；README §3 选择器对每个子任务各运行一次 → 得到 N 个框架，每个成为一条兄弟 L3 轨道。
  WIDE 以并行方式运行它们（每条 L3 无数值上限，受 MAX_CONCURRENT 约束）；
  TOKENSAVER 则以 ≤6 的较小波次运行。
- **垂直层（VERTICAL LAYER）——一条轨道 + 一个叠加层。**单一轨道的主框架可以携带一个 playbook 标签叠加层（`debug`/`research`/`user-facing`/`polish`/
  `external-target`——绝不是类别）。叠加层只重塑其标签对应的门禁（多数标签作用于 G1/G6；`polish` 作用于 **G7**）。当 polish 就是整个任务时，`polish` 这一轮也可以是独立的叶子（`frameworks/polish.md`）；作为叠加层时，它把该叶子的 G7 签核（SIGN-OFF）门禁施加到另一条轨道之上。运行的还是同样的门禁，同样只有一条轨道。

## 算法（由你——PARENT——来执行，零主观判断）
1. **分解（DECOMPOSE）**：把任务从可执行的 `ROADMAP.md` 分解为原子子任务，
   每个子任务拥有单一的自有文件集合，且任何文件不出现在两个集合中。只剩一个子任务 → **S5**。
2. **选择（SELECT）**：对每个子任务各运行一次 README §3 → 得到一个 STACK = `(framework, owned-file-set)` 列表。返回 `FRAMEWORK: MISS`（没有可信的种子匹配）的子任务路由到生成器（GENERATOR）（`frameworks/generation.md`，
   HRN-1→HRN-4）：新颖的子功能面会叠加一个生成的（GENERATED）`gen-<axis-signature>` 兄弟
   叶子——绝不会悄无声息地落到 backend-implement 上。处于封闭的 5 个 playbook 标签之外的横切关注点（CONCERN）则由一个小型 `gen-overlay-<concern>` 处理（一个只重塑 G1/G6/G7 的垂直层，经 `validateOverlay` 校验），而不是新建一个类别轨道。
3. **检查互斥性（CHECK DISJOINTNESS）**：两两文件集合的交集都必须为空。任何重叠 → **S1**。
4. **挂载（MOUNT）**：L2 管理者为每一行各构建一个 L2→L3 交接单，并将其逐条作为兄弟轨道派发（任务书原文 + nonce + 该框架）。超出预算 → **S4**。

## 不变量（确定性）
两个框架只有在自有文件集合互斥（DISJOINT）时才能叠加（STACK）。交集为空
→ 挂载。存在重叠 → 由 L2 管理者重新拆分；若无法拆成互斥，它们就是
一个特性/一条轨道，而不是两条。绝不允许对共享文件并行写入（WRITE）。

## 实战示例
- **水平——“修复后端缺陷并同时打磨落地页”：**分解 →
  A=`src/api/orders.py`（→ `backend-fix`）、B=`web/landing/*`（→ `frontend-implement`
  + `polish` 叠加层，`frameworks/polish.md`）。互斥 → 两条兄弟轨道；在 BILLIONAIRE 下并行。
- **垂直——“构建一个新的落地页流程，并打磨到位”：**单一自有文件集合 → 一条
  轨道 = `frontend-build` + `polish` 叠加层（叠加层加入 `frameworks/polish.md`
  的 G7 评判循环）。是一条轨道，不是一次叠加。

## 封闭场景（每个场景 → 唯一动作）
- **S1 - 两个框架共享一个文件** → 由 L2 重新拆分至互斥，否则坍缩（COLLAPSE）为
  一条轨道。绝不允许对共享文件并行写入。
- **S2 - 某个“子任务”实际上是两个** → 先进一步分解，再做选择。
- **S3 - 某个叠加层其实是类别（CATEGORY）而非标签** → 拒绝；把它作为自己的
  兄弟轨道路由出去（类别就是轨道，绝不是垂直层）。
- **S4 - 叠加超出全局运行预算**（GATES.md 的 “RUN-GLOBAL SUBAGENT
  BUDGET”；max-concurrent 基准值为 200）→ 把超出的部分排队/串行化；绝不在
  上限之外孵化。
- **S5 - 只有一个子任务（退化情形）** → 不叠加；仅一条 L3 轨道（垂直叠加层
  仍可适用）。
- **S6 - 两条轨道之间存在门禁顺序依赖** → 按该依赖边串行化；只有相互独立的轨道才并行运行。

## 对齐（只点名引用，不复述）
GATES.md 的 “FAN-OUT IS THE EXCEPTION”（组合是 MANAGER 派发兄弟轨道，
绝不是 L3 自行孵化）+ “RUN-GLOBAL SUBAGENT BUDGET”；MODES.md 的 Axis 1/2 +
max-concurrent；PLAYBOOKS.md 的 L2→L3 拆分 + playbook 标签；README §3。

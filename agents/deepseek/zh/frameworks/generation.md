
# GENERATOR 生成器（为每个任务定制框架——普遍适用）

当 README §3 的 SELECTOR 返回 `FRAMEWORK: MISS` 时——即该任务的形状没有任何一个预置叶子能自信地匹配——循环并不会降级落到 `backend-implement` 上。它会为这个确切的任务形状生成（GENERATE）一个定制框架。本文件就是 ap-framework-generator 所遵循的算法＋面向角色的契约。

## 1. 轴（AXES）——在三个正交维度上对任务分类（HRN-4 第 1 步）

`classifyAxes(task)` 把任意任务投影到：

- **deliverableKind**: `code-change` | `new-build` | `data-pipeline` | `infra-apply` | `ml-eval` | `research` | `docs` | `perf` | `migration`
- **acceptanceKind**: `unit-coverage` | `test-set-flip` | `metric-threshold` | `dry-run-diff` | `receipts`
- **targetLocus**: `in-repo` | `external-system`

任务中显式给出的轴字段优先；否则从预置信号（`isBroken`/`isNewComponent`/`category`）推断各轴。失败即关闭（fail-closed）：null/垃圾任务 → 全部为 `unknown`。

确定性的 **axis-signature**（`axisSignature(axes)`）是 kebab 式 slug `<deliverable>-<acceptance>-<locus>`（例如 `ml-eval-metricthreshold-in-repo`）。它就是所生成叶子的名称 NAME（`gen-<signature>`）。

## 2. 门禁库（GATE-LIBRARY）——组合出门禁序列（HRN-4 第 2 步）

`composeGateSequence(axes)` 从门禁库 GATE-LIBRARY 中取用门禁，并用与轴匹配的验证门禁替换掉那个无意义的验证门禁：

| acceptanceKind | 验证门禁 |
|---|---|
| unit-coverage / test-set-flip | `unit-coverage-verify` |
| metric-threshold | `metric-threshold-verify` |
| dry-run-diff | `apply-dry-run` |
| receipts | `receipts-verify` |

当任务形状需要时，deliverable 还会追加一道额外门禁：`data-pipeline` → `idempotent-replay`；`infra-apply` → `apply-dry-run`；`perf` → `measure-first-baseline`。序列总是以 `plan-verify`/`fresh-verify`/`implement` 开场，并以 `goal-check`/`sign-off` 收尾。

## 3. 生成的叶子模板——`gen-<axis-signature>.md`（HRN-4 第 3–4 步）

`generateFramework(task)` 按 S1–S5 的叶子形态输出一个叶子描述符（DESCRIPTOR）：

- `name`: `gen-<axis-signature>`
- `gates`: 组合出的门禁序列（§2）
- `invariant`: BLOCKED 不变量，逐字照录（见下文）
- `scenarios`: S1..S5，每条否定裁决向上回流，恰好一个终态 DONE（S5）
- `execharnessRef`: `execharness-<signature>.json`（双侧门禁，HRN-2）
- `acceptance`: 任务的验收要求，回写进 `failToPass`（HRN-8）

### BLOCKED 不变量（不容妥协）——在每个生成的叶子中逐字保留

与每个预置叶子所携带的那段约 5 行文本完全相同（逐字节一致），因此对校验器而言，生成的叶子与预置叶子无从区分：

> 验证必须在其真实环境中运行真实检查——绝不伪造通过（PASS），绝不编造证据，绝不在检查报红或无法运行时宣告 DONE。遇到任何阻塞时，立即停止（STOP），报告尝试过程＋具体的解除阻塞路径，然后把该裁决向上（UP）回传给你的派发者（绝不横向旁路）——留在闭环之内，通过子代理解决每一个悬而未决的问题，绝不把问题抛给用户。

## 4. 驱动之前先校验（VALIDATE）（HRN-5 —— 默认 FAIL）

`validateGeneratedFramework(leaf)` 是一名全新的、默认 FAIL 的评审员。只有下列条件全部成立，叶子才算健全（SOUND）；任何一条被违反 → 返回 `{ok:false, reasons}`，且该叶子绝不会被驱动执行：

- (a) 每道门禁 ∈ GATE_LIBRARY（不得出现未映射的门禁）
- (b) 恰好一个终态 DONE 场景；每个否定场景都向上回流
- (c) BLOCKED 不变量逐字存在
- (d) 非空的验收集合（双侧门禁必须有可翻转的东西）

FAIL 时生成器重新铸造一次（仅此一次）；第二次 FAIL 则升级为 OUT-OF-SCOPE。

## 5. 设计上就是一次性（没有晋升注册表）

生成的叶子对于铸造它的那个任务而言是一次性（ONE-OFF）的——先经校验（§4），再驱动执行，然后丢弃。这里刻意不设晋升注册表（promotion registry）：如果完全相同的 MISS 形状再次出现，就直接重新生成（GENERATE）一次（由 axis-signature 出发，成本低且确定性强）。只有当真实世界中确实观察到某个 MISS 反复出现之后，才会构建持久的已晋升叶子注册表——在那之前它是尚未启用的机器部件，而它的缺位并不是一次无声的兜底放行（INV-13）：遇到 MISS 仍然会铸造并校验一个全新叶子，绝不会降级落到 `backend-implement`。

## 6. 完整示例——一个 ML/评估（eval）任务

任务："把推荐系统在留出集上的 F1 提升到 >= 0.85。"没有任何预置叶子适配。

- `classifyAxes` → `{deliverable:'ml-eval', acceptance:'metric-threshold', locus:'in-repo}`
- `axisSignature` → `ml-eval-metricthreshold-in-repo`
- `generateFramework` → `gen-ml-eval-metricthreshold-in-repo`，其门禁序列带有 `metric-threshold-verify`（而非无意义的 `unit-coverage-verify`），绑定 `execharness-ml-eval-metricthreshold-in-repo.json`，并把"留出集上 F1 >= 0.85"回写进 `failToPass`。
- `validateGeneratedFramework` 判定 PASS → 该叶子可以驱动执行。它是一次性的；后续运行中出现相同形状时，直接重新生成（GENERATE）即可（没有晋升注册表）。

## 对齐关系（指个方向即可，不再复述）

README §3 SELECTOR（MISS → 到这里；路由的唯一事实来源）；composition.md（将生成的同级叶子堆叠起来）；GATES.md TIER CONTRACTS（每个层级对应的门禁）。

# 门禁契约

`SKILL.md` 是权威依据。本文件为 DeepSeek Harness 定义简明的路线图优先（roadmap-first）门禁契约。

## 1. 运行时与治理

新运行采用有用优先（useful-first）。没有单独的 intake 往返、强制 preflight 代理、scope-map 或全任务优先简报。

只有当受信任的启动证明其提供方/运行时、CLI 版本、权限配置、选择器、代理定义哈希、casting 哈希、effort 状态/来源以及 RUN/READ/WRITE 结果全部与实际启动相匹配时，才可以跳过能力探测。否则，第一位路线图作者必须先在一个一次性草稿路径上验证 RUN、READ 和 WRITE，然后再继续进行仓库检查。失败会在进入实现之前硬停止。preflight 角色仅用于诊断/恢复。

新运行的治理结构恰好是：

1. `PROMPTS.txt` —— 精确的只追加提示词块；
2. `ROADMAP.md` —— 权威的可执行范围、分解与计划；
3. `GATELOG.md` —— 只追加的状态流转、来源、裁决、哈希、耗时、假设、升级原因与恢复前沿。

不得创建仅用于治理的 `BRIEF.md`、`AGENTS.md`、`bucketlist.md`、`PLAN.md`、`COVERAGE.md`、`BACKLOG.md`、`ANCHOR.md`、`intake.md`、`scope-map.md`、按角度拆分的 scope 文件或等价物。实质性的实现、测试、评审与验证证据仍然有效。旧格式仅在恢复已有运行时可读；绝不为新运行生成或扩展它们。矛盾的混合治理一律失败关闭（fail closed）。

治理文件位于任务目标仓库之外的运行治理根目录：`PROMPTS.txt`、`ROADMAP.md` 与 `GATELOG.md` 绝不写入目标工作树，也绝不出现在其 diff 中。

第一位路线图作者将精确任务存储到 `PROMPTS.txt` 中。此后每个简报都以这个经过验证的任务指针开头：

```text
MISSION POINTER: read the exact prompt ledger before acting; stop if its hash or byte length differs.
path=<PROMPTS.txt> hash=sha256:<64 hex> bytes=<UTF-8 byte length> nonce=<RUN-NONCE>
```

执行者在行动前验证路径、哈希、字节长度与 nonce。随后只提供角色、目标、负责边界、依赖关系、验收标准、经哈希的路线图/证据指针、输出契约/路径以及真实的模型/effort 状态。不要粘贴任务原文、对话记录、完整路线图、教条或先前的对抗性推理。指针缺失或不匹配即为 `INVALID-BRIEF`；不得猜测或继续。

每道门禁都使用全新上下文，并在汇报前写入实质性证据。否定裁决同样要写入证据。任何门禁作者都不得评审或验证自己的工作。

## 2. 路线图门禁

Scope 阶段产出唯一权威的 `ROADMAP.md`。

- **bounded：** 一位路线图作者，随后独立的评审者与盲测新鲜验证者并发执行 —— **3 个智能体，2 轮**；
- **multi-surface：** **恰好 5 个智能体，3 轮**；保留完整的作者路线图与证据，恰好增加两名互补侦察员，然后由独立评审者与盲测新鲜验证者并发执行，不再冗余地派出普通综合调度；
- **unusually-large：** 只有在 `GATELOG.md` 中记录了具体理由时，才允许超出 6 智能体的常规 scope 预算。

只有需要当前外部事实时才运行外部研究。被否决时，保留已接受的证据，只修复点名的缺陷；不要重启已接受的 scope 工作。

`ROADMAP.md` 必须包含：

- 任务指针/哈希与运行 nonce；
- scope 概况及任何升级理由；
- 仓库情报与框架/工具决策；
- 稳定的条目 id、category、可选 tag、tier 与 framework；
- 负责边界、依赖关系、启动分组和一条集成通道；
- 实现步骤、正向验收标准、不愉快路径（unhappy paths）与测试优先步骤；
- 真实验证命令与 `>=95%` 的变更行/触及模块覆盖率要求；
- `requiresDetailedPlan: true|false`，为 true 时附上理由。

空路线图、无效 DAG、所有权重叠、缺失框架或测试以及能力检查失败都是硬性失败。

路线图评审者返回 `SMASH | PASS`。盲测新鲜验证者只看到已验证的任务指针与路线图，重新核查现实，返回 `REJECT | APPROVE`。两者并发运行且互不消费对方的推理。只有在父级汇合处满足 `review=PASS AND fresh=APPROVE` 时才冻结路线图；否则修复点名的缺陷并重复这对评审。

派发前使用机器可读语法记录每个获批条目：

```text
[at HH:MM DD.MM.YYYY] FEATURE-META <FID> tier=<T0|T1|T2|T3> framework=<leaf> issues=<N> [tag=<playbook>]
```

## 3. 门禁路由

获批的路线图就是默认的实现契约。就绪条目直接派发到 G4。仅当条目属于 debug/depth-lock 工作、存在点名的未决设计分叉、设置了 `requiresDetailedPlan: true`，或实现阶段返回 `PLAN-CONFLICT` 时，才加入 G1。

| 路由 | 门禁路径 |
|---|---|
| 可直接实现的路线图条目 | G4 → {G5 ‖ G6} → 可选 G7 → G8 → GOAL-CHECK |
| 有条件详细规划 | G1 → {G2 ‖ G3} → G4 → {G5 ‖ G6} → 可选 G7 → G8 → GOAL-CHECK |
| **T1** debug/depth-lock | G1 → {G2 ‖ G3} → G3.5 → G4 → {G5 ‖ G6} → G8 → GOAL-CHECK |

层级描述的是深度上限与风险，而不是强制的全流水线。框架可以省略不必要的门禁，但不得移除严格 TDD、独立实现评审、运行时验证、覆盖率下限、debug 工作的 depth-lock 或 GOAL-CHECK。

彼此无交集的就绪条目在所选并发度与运行时任务上限内一起启动，遵循 spawn-all-then-collect：先发出一个就绪组的所有 spawn，再收集任何报告 —— 并行后台派发是默认形态；只有声明的真实依赖才允许串行化。不要为了填满容量、复制所有权或递归拆分单个分析型工作而 spawn 智能体。

每次派发都是 collect-then-stop：收集到最终报告后立即显式停止该智能体；处于驻留可恢复状态的智能体仍然是存活智能体，会占用上限。绝不让已完成的智能体为可能的后续工作闲置等待。

对派发的等待是有界的：`INVALID-DISPATCH` 是向上循环的终态派发失败，绝不是无限等待。未收集的裁决会阻塞 DONE。持有未收集派发时结束回合即视为失败，而非暂停。

在每个 scope 上，独立于作者的验证都是强制的：独立验证下限绝不随扇出宽度坍缩 —— 即使零扇出的 bounded 通道也必须以独立评审与验证收尾。验证必须真正行使分级预言机（oracle）目标：验证者针对候选 diff 点名并运行真实的 fail-to-pass 测试或 oracle 测试；只运行补丁前套件或路线图一致性检查属于 NOT-VERIFIED，绝不算 PASS。把红色测试解释为“记录了缺陷行为”而加以驳回，需要由未参与该变更的智能体独立裁定；作者本人绝不能独自驳回红色测试。并发盲测保障智能体之间不共享裁决通道：任何一方在自己报告裁决之前，都不得读取载有对方裁决的台账行。

## G1：规划（PLAN）

G1 是条件性的，绝不是默认往返。规划者阅读真实工件并撰写 `<artifacts>/<FID>-plan-vN.md`，涵盖成功标准、逐文件变更、不愉快路径、测试优先、真实系统验证、风险以及 `>=95%` 覆盖率论证。它不编写生产代码。

`PLAN-CONFLICT` 携带冲突内容与已展开的证据返回此处。不得悄悄偏离路线图。

## G2：规划评审（PLAN REVIEW）

一位不同于规划者的评审者对照已验证的任务、路线图条目、真实仓库、不愉快路径、测试策略与范围检查详细计划。裁决：

```text
SMASH - numbered, evidence-backed reasons
PASS - every criterion is covered
```

G2 与 G3 并发运行。它绝不读取 G3 的裁决。

## G3：新鲜验证（FRESH VERIFY）

一位不同于规划者与 G2 评审者的盲测验证者收到已验证的任务指针与提议的详细计划，但不收到任何评审推理。它阅读真实工件并返回：

```text
REJECT - numbered mission, reality, or test gaps
APPROVE - the plan is complete and executable
```

对于 debug 工作，基于问题文本和 D4 对抗性复现来锚定独立的重新推导。拒绝那种用所提议补丁自身机制措辞的分层式复现。

G3 与 G2 并发运行且绝不冻结计划。只有当 `G2=PASS AND G3=APPROVE` 时，父级才冻结实质性计划证据；任何否定结果都退回 G1。

## G3.5：深度锁定（DEPTH-LOCK）

对每个 debug 条目而言，G3.5 都是强制且默认 FAIL 的。一位全新的深度探测者依次看到已验证任务、问题文本、真实代码，最后才看到所提议的修复层。它在不知道所提议层的前提下推导 D1–D5：

```text
D1 HOME FUNCTION - file:function where the behavior is decided, with why.
D2 WHOLE-CONTRACT INPUT-CLASS TABLE - every input, parameter, branch, and invariant; provenance must be issue-derived.
D3 DEEPEST CAUSE - the single deepest file:function that fixes all D2 classes; identify shallower symptom layers.
D4 ADVERSARIAL HIDDEN-ORACLE REPRO - issue-derived behavior test, not patch-mechanism-shaped, captured RED on unpatched code.
D5 DEPTH-LOCK VERDICT - PASS only when frozen fix LAYER == D3 deepest cause AND D4 is RED unpatched; otherwise REJECT - depth-miss.
```

撰写 `<artifacts>/<FID>-depth-lock.md`，包含 D1–D5 及捕获到的 D4 输出。使用以下格式记录结果：

```text
[at HH:MM DD.MM.YYYY] <FID> G3.5 DEPTH-LOCK (ap-depth-prober): PASS - artifact <FID>-depth-lock.md tag=debug fixlayer=<file:function>
```

`REJECT - depth-miss` 退回 G1。绝不在错误层的计划上实现。修复 LAYER 必须等于 D3 最深成因，且 D4 必须是在未打补丁代码上真实捕获的红色基线。

## G4：实现（IMPLEMENT）

实现者按照路线图条目或已批准的 G1 计划，使用严格 TDD：

1. 先写出正确行为测试；
2. 运行它并捕获预期失败；
3. 实现最小变更；
4. 在绿色状态下重构；
5. 运行被触及模块及其直接依赖方；
6. 证明 `>=95%` 的变更行与触及模块覆盖率。

使用真实的运行器与系统。集成测试中不得 mock 被测系统或数据库。显式处理不愉快路径。如果契约本身有误，以 `PLAN-CONFLICT` 停止，而不是临场发挥。

撰写 `<artifacts>/<FID>-impl-vN.md`，记录变更文件、测试、真实输出、覆盖率与偏差。只有在 TDD 红色与绿色证据存在之后才记录 G4。

## G5：实现评审（IMPLEMENTATION REVIEW）

一位未实现该条目的评审者检查任务/路线图覆盖、主张与 diff 的对应、正确性、不愉快路径、测试质量、覆盖率证据、死代码与范围蔓延。裁决为 `SMASH | PASS`，每项失败都要附 file:line 证据。撰写 `<artifacts>/<FID>-impl-review-vN.md`。

G5 与 G6 并发运行，因为二者消费的都是 G4 的 diff，而不是彼此的裁决。SMASH 退回 G4；若契约本身有误则退回 G1。

## G6：验证（VERIFY）

一位不同于实现者与 G5 评审者的验证者通过实际运行来证明行为。撰写 `<artifacts>/<FID>-verify-vN.md`，包含精确命令与捕获输出，覆盖：

- 变更后的目标行为；
- 对于 debug 工作，问题衍生的 D4 复现在补丁前为 RED、补丁后为 GREEN；
- 被触及模块及直接依赖方的既有测试，零 green-to-red 回归；
- 对抗性不愉快路径输入；
- 变更行与触及模块的 `coveragePercent >= 95`。

裁决为 `VERIFIED | FAILED`。没有捕获运行器输出的装饰性裁决、缺少红转绿证据的 debug 修复、任何 green-to-red 回归，或覆盖率低于 95，均为 `FAILED`。FAILED 退回 G4。

G6 与 G5 并发运行。只有当 `G5=PASS AND G6=VERIFIED` 时才推进。并发执行绝不允许自我评审。

## G7：签核（SIGN-OFF）

仅当路线图或所选框架要求独立风险签核时才运行 G7。陪审员是全新的、独立于 G1–G6 的，并且并发运行。每人看到已验证的任务指针、路线图条目、diff 与经哈希的证据指针，但看不到先前的对抗性推理。

每位陪审员默认 FAIL，返回 `PASS | FAIL` 并附已展开的证据。要求的席位必须一致通过。P0/P1 失败不能被仲裁成 PASS。

## G8：记录（SCRIBE）

记录员不做任何评估，也不编辑生产代码。它将门禁流转、角色、精确模型/effort 状态、工件哈希、裁决、耗时与前沿追加到 `GATELOG.md`。它可以写入或更新该门禁点名的实质性证据，但不创建额外的治理台账。

G8 不提交、不推送。本次运行不授权任何 git、发布、部署、花钱、配额或破坏性操作。

## 清扫（SWEEP)

实现通道汇合后，一位全新的清扫者从已验证的指针出发重新推导任务与路线图覆盖情况，检查被触及的邻近区域，并以严重程度排序报告发现，附 file:line 证据。它不得信任先前裁决，也不得重复已经关闭的发现。

未关闭的发现按最低的正确门禁作为路线图条目重新进入：局部实现缺陷走 G4；debug/depth-lock、未决设计问题或真正的计划冲突走 G1。复用有效证据。

## 目标检查（GOAL-CHECK）

一位全新的、对抗性的、默认 FAIL 的目标检查者看到已验证的任务与证据指针，看不到先前推理。DONE 要求同时满足：

- 每个提示词块与路线图条目都在已展开的证据上交付；
- 零未关闭发现，且无静默降级严重级别；
- 存在可用的入口点和真实的端到端演练；
- 零个既有的 green-to-red 回归；
- 变更行与触及模块覆盖率 `>=95%`；
- 对于 debug 工作，问题衍生的 D4 红转绿证明，且修复 LAYER 等于 D3 最深成因；
- `PROMPTS.txt`、`ROADMAP.md`、`GATELOG.md` 与实质性证据校验成功；
- 零个存活子智能体 —— 每个 spawn 出的智能体都已停止，无遗留驻留。

裁决为 `DONE | NOT-DONE`。NOT-DONE 须点名每一项未达标条目，并按上述门禁规则将其送回。仲裁不能豁免能力失败、阻塞、覆盖率、depth-lock 或真实验证。

## 4. GATELOG 文法

门禁行只追加且机器可读：

```text
[at HH:MM DD.MM.YYYY] <FID> G1 PLAN (ap-planner): <PASS|SMASH> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G2 PLAN REVIEW (ap-reviewer): <PASS|SMASH> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G3 FRESH VERIFY (ap-fresh-verifier): <APPROVE|REJECT> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G4 IMPLEMENT (ap-implementer): <PASS|PLAN-CONFLICT> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G5 IMPLEMENTATION REVIEW (ap-reviewer): <PASS|SMASH> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G6 VERIFY (ap-verifier): <VERIFIED|FAILED> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G7 SIGN-OFF (ap-juror): <PASS|FAIL> - artifact <path>
[at HH:MM DD.MM.YYYY] <FID> G8 SCRIBE (ap-scribe): logged - frontier=<state>
[at HH:MM DD.MM.YYYY] <FID> GOAL-CHECK (ap-goal-checker): <DONE|NOT-DONE> - artifact <path>
```

G3.5 与 FEATURE-META 形式必须严格保持上文定义的原样。旧式行仍可解析，但绝不成为新写入的模板。

## 5. 恢复、DeepSeek Harness 配置与权限

恢复必须是显式的：只有显式的 `resume` 指令或监督者重启才能恢复一次运行。恢复上下文只读取 `GATELOG.md` 尾部 —— 最后的前沿行及其任务指针/哈希、nonce、最后接受的门禁与未关闭条目 id —— 校验指针哈希，并用紧凑的指针简报派发开放前沿。由执行者（而非恢复上下文）去阅读 `ROADMAP.md`、`PROMPTS.txt` 与实质性证据。临时、空、畸形或哈希不匹配的工件一律视为不存在。重新验证最后接受的前沿并幂等地继续。旧式台账可以提供前沿信息，但只是只读兼容输入。

DeepSeek Harness 的智能体选择是 `inherited-only`：生成的角色不带模型覆盖，继承所选父模型。模型与 effort 绝不改变门禁或并发度。

effort 一律记录为 `inherited-only`；省略任何 effort 字段，绝不声称应用了某个请求的或最大的 effort。

Web 会话请选择 Autoprompt 代理预设。无头（headless）运行时，通过 `--patch` 传入已安装的 `headless.patch.yml`。每个角色工具都会拒绝白名单之外的角色工具，并使用不超过四层的深度上限。运行时嵌套限制是上限，绝不是 spawn 目标。

未经用户明确授权，不得 commit、push、publish、deploy、花钱、删除用户数据、force-push、hard reset 或清理工作树。只有监督者授予重启与恢复权限。

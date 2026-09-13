# scope 阶段的收敛预算按"返修循环"计量

**状态（Status）**: accepted

Autoprompt 的 scope 阶段原本同时受三个限制器约束：一个从未被读取的固定轮数声明（`sequentialRounds` 2/3/4）、真正生效的 `MAX_SCOPE_CYCLES = 2`，以及墙钟预算（软 60 秒 / 硬 300 秒）。我们以**唯一一条预算**取代它们：每个档位最多 N 次完整的**返修循环**（一次返修波次 + 一次复检波次，成对计数），起步取值 `MAX_REPAIR_CYCLES = 1`。之所以不限制总轮数，是因为 `总轮数 = 结构轮(2/3/4) + 2 × 返修循环`，而结构轮各档本就不同——把上限压在总轮数上，会把档位差异自动翻译成返修机会的差异（统一上限 5 时 bounded 有 3 次返修空间，`unusually-large` 为 0）。之所以不设阶段时间预算，是因为墙钟**不可自审**：模型无法感知跨子代理调用累计的秒数，时间预算必须由外部测量者实现（脚本 + 宿主）；而轮数由派发者自己就能数清。

## 备选方案（Considered Options）

1. **统一总轮数上限（如 5 轮）** — 否决。结构轮各档不同（2 / 3 / 4），上限压在总量上等于反向配置纠错机会：`unusually-large` 结构轮已占 4，第 5 轮返修之后没有轮次复检，会以"未经验证的已修改路线图"收场，直接违反"保证轮是批准的定义"。
2. **保留墙钟预算，与轮数并存** — 否决。时间不可自审，必须有外部测量者（claude 侧现为 `phase-budget.js` + `supervisor.sh` 心跳；deepseek 预设 schema 根本没有时间字段，唯一预算旋钮是 `maxDepth`），凭空落地就是一个没人调用的脚本，与 `sequentialRounds` 同类死代码。且两个限制器并存会导致"先撞哪一个取决于机器"，恰好抵消轮数的确定性收益。
3. **按档位分档上限（bounded 4 / multi-surface 5 / unusually-large 6）** — 不必要。返修维度统一之后，档位差异已由结构轮自然体现；分档只是把同一件事写三遍。
4. **保留 `MAX_SCOPE_CYCLES` 并叠加新上限** — 否决。multi-surface 今天的最坏值恰为 5 波，正好用满 `MAX_SCOPE_CYCLES = 2` 的额度，叠加会让新上限永不生效，重演"声明了但从不触发"。

## 后果（Consequences）

正面：scope 阶段只剩一个预算；返修机会对所有档位相等；预算以**成对**循环为单位，因此**结构上不可能出现"改完未验"的终态**——不需要"剩余轮数不足时不许返修"这类补丁规则，它是被结构消灭的，不是靠纪律约束的；不需要写任何脚本。

负面：总时长失去绝对上限（= 结构轮 + 2R 波 × 单波耗时）。**活跃性兜底**（某一波卡死不能永远卡）必须由运行时提供，且**不属于编排策略**；若运行时没有，挂死的波次会永久悬停，因为轮数计数器根本不会前进。

总量对照（`总轮数 = 结构轮 + 2R`）：

| MAX_REPAIR_CYCLES | bounded | multi-surface | unusually-large |
|---|---:|---:|---:|
| **1**（起步） | 4 | 5 | 6 |
| 2 | 6 | 7 | 8 |
| 今天（`MAX_SCOPE_CYCLES = 2`） | 4 | 5 | 7（含一轮空转） |

取值理由：`R = 1` 恰好等价于把今天的实际行为正名，**零行为变化**，风险最低；`R = 2` 才是真正多给一次纠错机会。`R` 的最终取值应由实测分布决定——门控已在打印实际的 agents / rounds / elapsedMs，先收集真实分布再调，不靠拍值。

连带清理：删除死声明 `sequentialRounds`；`unusually-large` 的综合者波次改为**仅在确有新侦察证据时**运行（今天每个循环都重跑，无证据时为空转）。

## 未决（实施顺序）

本决定的落点横跨三处：`agents/claude/workflow/autoprompt-gate.js`（唯一被消费的编排代码，手工维护、非生成产物）、`agents/contracts/**` 与 `scripts/generate-provider-contracts.cjs`（各 provider 界面上散文的来源），以及 7 个 provider 面的生成产物。当前 `agents/deepseek/**` 领先于 `agents/contracts/**`（48 个产物 stale），重新生成会回退 deepseek 面的既有修复——因此实施前必须先决定 contracts 与 deepseek 的回灌方向。

## 追加：评审收敛条款（引入外部 Review Convergence 策略之后）

一份外部 Review Convergence 策略（Plan Review 与 Implementation Review 各有独立 5 次 review-fix 循环上限、分开计数、不结转；到达上限即停止自治评审并交回所属阶段或决策权威；**到达上限不等于通过**）被作为**新实质证据**引入——按该策略自身的规则"不得在没有新实质证据时重开已接受的裁决"，重开本决定的数值讨论是正当的。它带来两件事。

**一、补齐了本决定缺失的"出口条款"。** 原决定只有上限、没有出口，上限因此在实践中是空的：用尽预算的 agent 手里没有指令，只会做两件坏事之一——无限返修（把上限架空），或放行一份薄路线图（让流程看起来完成）。现已补入三组条款，且它们互补、不可拆开：

1. **出口**：预算用尽而仍有实质发现时，停止自治评审并把未解决项交回所属阶段或决策权威；到达上限绝不等于通过。
2. **聚焦**：后续轮次只追未解决的实质发现、自身修复引入的回归、或此前无法合理提出的新实质问题。
3. **不得阻塞**：不得在没有新实质证据时重开已接受的裁决，也不得因风格偏好、可选改进、推测性担忧或无关问题阻塞进度。

**二、数值不采纳参考的 5。** `MAX_REPAIR_CYCLES` 保持 **1**。

| 来源 | 值 | 对象 |
|---|---:|---|
| 外部 Review Convergence 策略 | 5 | Plan Review / Implementation Review |
| 本仓 gate 既有 | 3 | `PLAN_ATTEMPT_BUDGET` / `IMPL_ATTEMPT_BUDGET` |
| **本决定** | **1** | scope 阶段返修循环 |

理由：

- **语境不同，不可直接换算。** 本仓 scope 阶段的墙钟预算有明确来源（`phase-budget.js` 头部原文引用 *"scope supervisor often takes 30min or more … hella time consuming"*）。按 `总轮数 = 结构轮 + 2R`：R=1 → 4/5/6，R=2 → 6/7/8，R=3 → 8/9/10，**R=5 → 12/13/14**——取 5 等于把当初治好的"scope 拖太久"重新装回来。
- **无证据支持提高。** 没有任何数据说明"1 次返修经常不够"。
- **提高上限治不了病因。** 路线图被反复否决通常源于使命欠定义、档位分错或验收标准执行不一致，更多轮次不会收敛——这也正是参考自己设"5 次后交回决策权威"的前提。

**scope 的上限可以小于 build 的 3**，依据是**边际收益**而非单位成本：改计划虽比改代码便宜，但一份反复被拒的路线图更可能卡在定义/范围层面，第二次之后每轮收敛概率急剧下降；边际收益递减更陡的一侧，上限就该更小。这处与仓库自有 3 的不一致是有意的。

**提升触发条件**：当实测数据显示"仍留有可修复实质发现却已升级"的运行，或返修循环用尽率持续偏高时，把 `MAX_REPAIR_CYCLES` 提到 2。取值由本仓数据决定，不由外部参考决定。

**传播范围**：本轮仅落 `agents/deepseek/` 的 16 个文件（中英正文 + 2 个镜像）；`agents/claude/workflow/autoprompt-gate.js`、`agents/contracts/**` 与其余 7 个 provider 面未改。

## 追加：在 DeepSeek Harness 下的强制机制（脚本 + hook，不用 workflow）

前文把预算写进了散文，但那个面**没有任何机器兜底**：`agents/deepseek/` 零代码，DSH 预设 schema 的唯一预算旋钮是 `maxDepth`，DSH 运行时也不提供阶段级时间/轮数预算。因此本决定追加一个强制点。

**裁决：用 DSH 的 command hook 承载一个脚本；不引入 `dsh-tool-workflow`。**

理由：

- 标准 DSH 预设装了 `@deepseek-ai/dsh-tool-workflow` + `dsh-workflow-worker-thread`，而 autoprompt 的 deepseek 预设**故意没有**。改用 workflow 意味着**新增两个插件依赖**，并且 workflow 的 `agent(prompt, opts)` 直接按 provider/model 起子代理，**不经过那 25 个 `ap_*` 角色工具**——于是 25 个人格与 `toolFilter.deny` 围栏全部变成惰性配置。那 25 个人格正是这个 skill 的产品本体。
- workflow 是前台单脚本、`return` 结构化结果，会丢掉**三文件治理 + `GATELOG.md` 前沿 + `--patch` RESUME**；RESUME 是长任务里活下来的命脉。
- 需要强制的只有两条，而 hook 都能做，不需要把编排权整体搬进代码。

**代码只承担它能判断的两条；判断类的规则继续留在散文：**

| 规则 | 承载 |
|---|---|
| scope 阶段返修预算（`MAX_REPAIR_CYCLES = 1`） | **代码**：`PreToolUse` 拒绝越额返修派发 |
| 返修必须复检（成对性） | **代码**：`Stop` 阻断未复检的停止（**自限一次**） |
| 只追未解决/回归/此前无法提出的发现 | 散文（判断） |
| 不得因风格/可选/推测/无关阻塞 | 散文（判断） |
| 出口：到顶交回所属阶段或决策权威 | 散文（判断 + 产品决策） |

**接线链（每一环都有验证）**：`agent-preset/hooks/{hooks.json,scope-convergence-guard.cjs}` → 列入 `scripts/runtime-payload.cjs` 的 deepseek payload → `runtime-payload --install` 校验哈希并落盘 → `install.sh`/`install.ps1` 的 deepseek 白名单把它们复制到 `<DSH_HOME>/.agent-presets/autoprompt/hooks/` → 预设用 `!!js new URL('hooks/...', baseUrl)` 解析（`baseUrl` = 组合文件目录，与既有 `skills/` 同一锚点）→ `hooks.json` 用 `${CLAUDE_PLUGIN_ROOT}` 指向 guard。

**耐久性**：hooks 插件行同时写进了 `scripts/generate-provider-contracts.cjs` 的 `renderDeepSeekPreset` 与 `renderDeepSeekHeadlessPatch`（deepseek 专用渲染函数，不影响其他 provider），并断言**生成器输出与仓库中的手写块逐字一致**（EOL 归一化后）——所以重新生成不会丢掉接线。

**验证证据**：guard 9 项单元测试全通过（预算、成对性、自限、中继不耗预算、阶段休眠、失败开路、按会话隔离）；真实 stdin→stdout 冒烟测试按预期给出 deny/无决定并写出正确状态；用临时 `DSH_HOME` 走通 `--install`（53 文件含 hooks）与预设解析断言（`WIRING OK`）。

**已知限制**：① 判定基于工具名，所以只有具名返修作者（`ap_scoper`/`ap_synthesizer`）消耗预算，由其他角色执行的返修**不会**被计数（失败开路，绝不误拒）；② 若 scope 工作在没有 scope-entry 派发的情况下开始，guard 保持休眠；③ `dsh-hooks-claude-code` 未实现 Stop 的连续阻断上限，故成对性规则必须自限——已实现（pending 标志被阻断消费一次）；④ **未跑真实安装**，以免改动你机器上其他 provider 的配置根。

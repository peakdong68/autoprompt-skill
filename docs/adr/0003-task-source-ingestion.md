# 任务源摄取：自然语言引用完成任务文档的哈希绑定入账

**状态（Status）**: proposed（已按评审意见两轮修订：① 接口由参数式 `SOURCE=` 改为**自然语言引用**；② 引用形态扩展为 **A–D 四类**：自然语言指定 / `@` 提及 / 显式指令 / 目录定稿文档；③ **两处格式已由决策者定稿**——溯源头与目录定稿标记，见 §格式定稿）

`/autoprompt <mission>` 的 mission 是唯一输入，而 `ap-goal-checker` **只从台账文本**重新推导每一条 ask：验收条件若全在外部文档（Proposal、交接文档、issue）里，台账就只剩一个指针字符串，ask 无从推导 → `prompt=gap` 强制 NOT-DONE，或整轮变成形式验收。手工把范围与验收条件粘进 mission 可行但漂移、冗长、体验差；三段式交接（planning → autoprompt → verify）在源文档改版时会静默失配。

**裁决**：操作者**只说人话**，引用可以来自四类形态（下表）；**摄取**由第一作者完成：识别被引用/被指定的任务文档、读取原文、与短意图一起**原子写入** `PROMPTS.txt`，并**由它自己**记录 `sha256` / `bytes` 溯源头。台账因此自含全部权威文本，外部文档降级为证据；`goal-check` 仍只从台账推 ask，但台账里现在真的有 ask。

**语法的位置从"操作者输入"移到"agent 写入的台账元数据"**：机器可读性由 agent 负责，操作者不写任何参数。

## 引用形态（A–D）

| 形态 | 例 | 平台事实 | 识别 |
|---|---|---|---|
| **A 自然语言指定** | `按照 docs/adr/0003-task-source-ingestion.md 的决策执行` | 纯文本 | 线索词 + 路径 → 摄取 |
| **B `@` 提及** | `@docs/proposal.md`、`@"docs/my file.md"`、`@docs/proposals/` | **DSH 一等公民**：`dsh-file-reference` 在输入开头或空白后识别 `@path`；**只把提及文本插入 prompt，从不读取、也不附加文件内容**；目录候选带尾斜杠 | 视为显式引用；**仍须摄取**（`@` 本身不解决台账自含） |
| **C 显式指令** | `SOURCE: path=… [sha256=…] [bytes=…]` | 可选形态，供 CI / supervisor 交接**冻结文档并预提交哈希** | 摄取；只给 `path` 时哈希由作者计算 |
| **D 目录定稿文档** | `@docs/proposals/` 或 `SOURCE: dir=…` | 目录提及带尾斜杠 | **只认显式定稿标记**（frontmatter 字段或固定文件名）；**禁止** mtime / "最新文件"启发式 |

```text
/autoprompt 按 @docs/proposals/ 里的定稿文档执行，只动 agents/deepseek/**
```

```text
=== PROMPT 1 ===
按 @docs/proposals/ 里的定稿文档执行，只动 agents/deepseek/**
SOURCE path=docs/proposals/handoff.md root=repo form=dir-marker bytes=4213 hash=sha256:<64 hex>
<该文档逐字节原文>
```

## 格式定稿（frozen）

两处格式一次定死：它们被第一作者写、被 `ap-goal-checker` / `ap-scribe` / `ap-re-anchor` 解析，三处各写各的账本就不可解析。权威样例已写入 `agents/deepseek/SKILL.md` §6「Ingested task source (frozen format)」。

**一、溯源头**

```text
SOURCE path=<path as referenced> root=<repo|cwd|governance> form=<designated|implicit-single|directive|dir-marker> bytes=<UTF-8 byte count> hash=sha256:<64 hex>
```

| 决定 | 内容 | 理由 |
|---|---|---|
| 标签 | `SOURCE` | 短且唯一 |
| 字段与顺序 | 固定：`path → root → form → bytes → hash` | 定位 → 基准 → 分类 → 边界 → 完整性；固定顺序才能被三处无歧义解析 |
| `path` | 保留 mission 中的原形（`@"…"` 去引号；目录形态**展开为每个文件一行**） | 人类能把台账行对回自己写的那句话 |
| `root` | `repo` / `cwd` / `governance` 之一 | 同一相对路径在不同 cwd 下含义不同，基准必须显式 |
| `form` | `designated` / `implicit-single` / `directive` / `dir-marker` | "识别是判断"，判断必须可审计 |
| `bytes` | 被摄取文本的 UTF-8 字节数 | **兼作边界**：紧随其后 n 字节即该源，因此**不写结束分隔符** |
| `hash` | 被摄取字节的 sha256 | 台账与外部世界唯一的完整性链条；漂移可检测 |
| 不收录 | `captured=`（墙钟）、逐块 `nonce` | 时间线已由 `GATELOG.md` 承担；nonce 已由台账前缀哈希与 MISSION POINTER 承担，重复只增加长度 |
| 覆盖 | 逐字节一致；禁止重排换行或 CRLF↔LF 转换 | Windows 下最易踩；任何转码都使哈希必然不符 |
| 版本 | 格式属台账 `version` 边界，改动即升版，旧账本 fail-closed | 沿用既有的 "version boundary" 机制 |

**二、目录形态的定稿标记**

| 决定 | 内容 |
|---|---|
| 主标记 | frontmatter `autoprompt-source: true`（任意文件名） |
| 回退 | 仅当主标记命中 **0** 个时，取目录内名为 `HANDOFF.md` 的**唯一**文件（大小写不敏感） |
| 深度 | 只扫一层，不递归 |
| 数量 | 必须**恰好一个**命中；0 个或多个 → 歧义，走 ADR-0002 路径（attended 问一次 / unattended 记录并停） |
| 禁止 | mtime / "最新文件" / glob 启发式（集合不确定、不可复现、隐式扩大 ask 面） |

理由：frontmatter 是**内容承载**的标记——改名不失效，且能被 planning 阶段作为"定稿"这一个显式动作写下；固定文件名只在无法携带 frontmatter 时兜底，且仅在主标记为空时启用，保证同一目录的解析结果唯一。

## 识别规则

| 情形 | 处理 | 台账记录 |
|---|---|---|
| 带线索词的指定（形态 A） | 摄取 | `designated` |
| **唯一**文档引用、无线索词（A/B/C/D 任一） | 视为**隐式指定**，摄取 | `implicit-single` |
| **多个**文档引用、无线索词 | **歧义：不摄取**，返回上游；L0 按 **ADR-0002** 处置（attended 问一次 / unattended 记录并停） | `ambiguous` + 候选清单 |
| 目录（形态 D）内定稿标记为 0 个或 >1 个 | 同上歧义路径 | `ambiguous` + 目录清单 |
| 指定文档不可读、`sha256`/`bytes` 不符 | `INVALID-SOURCE`，报告并停止；**不得**降级继续（与 `INVALID-BRIEF` 同纪律） | 硬停 |
| 仅顺带提及（"参考 X 的代码风格"）、且另有明确指定 | 不摄取，只作证据指针 | `skipped` + 理由 |
| 无任何文档引用 | 不摄取，短意图本身即 mission（现行为） | — |

**禁止的形态**：URL（远端内容可变，哈希绑定失去意义）、glob（集合隐式扩大 ask 面）、二进制 / 图片（不能充当 ask 来源，可作证据指针）、mtime / "最新文件"启发式（不确定集合 + 不可复现）。

识别是**判断**而非解析器：因此要求第一作者在台账里记录**摄取清单与未摄取清单**（形态、路径、哈希、字节数、顺序、跳过理由），让判断可审计。

## 多份与顺序

- 允许 N 份被引用的任务源，**各自成块**；块号按在 mission 中出现的**顺序**，哈希各自绑定；
- **摄取不做语义合并**：矛盾留给 scope/plan 阶段按既有机制处理（`PLAN-CONFLICT`、reviewer / fresh-verifier），摄取阶段只如实入账并记清单；
- 仍**建议**合并为一份定稿交接文档；被摄取总量建议 ≤ 32 KB（台账会被每个 worker 读取，成本按角色数放大）。

## 为什么"宁停不多摄"

多摄的代价是**静默有毒**：把仅作上下文的文档变成 `goal-check` 的 ask 来源 → 制造从未打算承担的验收义务（false obligation），且无人会报错；少摄的代价是被 `INVALID-SOURCE` / 歧义路径**显式挡住**。因此规则偏向"**停下问**"，而不是"尽量多读"——`@` 不改变这一点，因为它只是纯文本提及。

## 其余规则

1. **执行者与时点**：由第一作者（`ap-scoper`，既有职责就是"接收确切 mission 并原子创建 `PROMPTS.txt`"）在**写台账的同一次原子操作**内完成识别、校验、摄取。零新增 agent、零新增阶段。
2. **权威边界**：摄取后**台账文本 = 权威**（短意图 + 摄取块求并集）；外部文件仅作证据。`goal-check` 从台账文本（含摄取块）重推 ask，可在解释差异时读外部源，但**不得**以外部队本为判定依据。
3. **指针类型不变**：MISSION POINTER 仍只指向 `PROMPTS.txt`（path / sha256 / bytes / nonce）；不新增指针类型、不新增治理文件（仍是三文件）。
4. **追加式修订**：源文档改版或纠偏一律追加新 `=== PROMPT N ===` 块，**不得重写**已写入的块。漂移可检测：源改了而台账未追加 → 复算哈希不符，显式暴露。
5. **跨面复核**：内部只做台账前缀哈希自校验；**源哈希 ↔ 台账记录哈希**的比对放在外部（supervisor / CI / verify 阶段）。
6. **体积**：不做硬上限（无机器兜底时硬上限只是散文），只做上述建议与台账记录。

## 备选方案（Considered Options）

1. **维持现状：手工粘贴自足 mission** — 降级为兼容路径（保留，但不再推荐）。
2. **mission 只放指针，`goal-check` 直接读外部文档** — 否决。**权威出逃**：台账不再是唯一事实源；外部文件运行中可变且无哈希可察觉。
3. **要求操作者输入参数式 `SOURCE: path=… sha256=… bytes=…`**（首版接口）— **否决**。把机器可读性推给操作者，反人类；哈希本可由作者摄取时计算。降级为可选的 CI 形态（形态 C）。
4. **运行期抓取 issue URL** — 否决。远端可变；正确形态是外部先固化成本地快照。
5. **新增治理文件（`SOURCE.md` / `BRIEF.md`）** — 否决。破坏三文件与单源假设。
6. **复活独立 intake 阶段** — 否决。`ap-intake` 是遗留兼容角色；摄取并入"第一作者原子写台账"。
7. **目录按 mtime / "最新文件"自动摄取** — 否决。集合不确定、不可复现，且哈希绑定失去意义。
8. **glob 批量摄取** — 否决。集合会随工作树隐式变化，等于隐式扩大 ask 面（正是"宁停不多摄"要禁止的方向）。
9. **把 `@` 当结构化附件直接入账** — 不适用。按 `dsh-file-reference` 契约，`@` 只插入**纯文本提及**、不读取内容；摄取仍是唯一能进台账的路径。
10. **硬编码关键词解析器** — 否决为本决定前提。识别是判断，交给第一作者并在台账留痕；若实测误判率偏高，再考虑收窄线索甚至上 hook。

## 后果（Consequences）

正面：**默认零参数**；四类引用形态共用一套识别与记录规则；与 DSH 的 `@` 一等公民契合（操作者直觉即可）；"宁停不多摄"保证 ask 面只含**被指定**内容；单文件级可追溯（`sha256` + `bytes` 各自绑定），verify 可对齐；完全向后兼容（不写引用时行为不变）。

负面：多个引用而无指定线索时会**停下**（体验代价换正确性）；形态 D 依赖标记约定（需定稿标记字段名）；台账变大（成本 × 角色数）；摄取保真度本轮内无法自证（需外部复核）；ask 面扩大使覆盖率压力上升——这是**期望**后果，不是回归。

## 落点（改动清单）

| 文件 | 改动 |
|---|---|
| `agents/deepseek/SKILL.md` §6（Compact pointer briefs） | ✅ **格式已冻结**（见 §格式定稿，已写入「Ingested task source (frozen format)」小节）；机制文字（四类引用形态、识别规则表、`INVALID-SOURCE`）待实施 |
| `agents/deepseek/GATES.md`（mission pointer / 早期门控段） | "exact mission" 扩写为 "exact mission + 摄取块"，给出块格式与样例 |
| `agents/deepseek/MODES.md`（accepted directives 列表） | 明确**默认零参数**；`mode=`/`max_subs=` 被剥离、`SOURCE=` 可选；摄取不需操作者参数 |
| `agents/deepseek/agents/ap-scoper.md` | 识别四类形态 → 校验/计算哈希 → **同一次原子写**内摄取 → 清单留痕；歧义向上传递；不可读即硬停 |
| `agents/deepseek/agents/ap-goal-checker.md` | ask 推导源 = 台账文本（含摄取块）；外部源仅作解释用证据 |
| `agents/deepseek/agents/{ap-scribe,ap-re-anchor}.md` | 账本记录与前沿重建包含摄取块、哈希与摄取清单；追加式修订 |
| `agents/deepseek/README.md` | 一句操作者说明：自然语言或 `@` 引用即可；目录形态需定稿标记；多引用时请指明主源 |
| `agents/deepseek/zh/**` | 以上镜像同步 |

不改预设组合、不改 hooks、不新增治理文件、不动 `agents/contracts/**` 与其他 provider 面。

## 范围外（明确不解决）

- 二进制 / 图片、URL、glob：不做（见禁止形态）。
- 机器强制识别与保真校验（hook）：未来增强，不在本决定。
- 值守模式判定：见 ADR-0002。预算（时间 / 轮数）：见 ADR-0001。

## 未决（实施顺序）

1. **摄取机制本身尚未实施**：格式已在 `agents/deepseek/SKILL.md` §6 冻结（可被三处引用），但 `GATES.md`、`MODES.md`、`agents/ap-scoper.md`、`agents/ap-goal-checker.md`、`agents/ap-scribe.md`、`agents/ap-re-anchor.md`、`README.md` 与 zh 镜像的落点仍待实施——待 ADR-0002 / 本决定被接受后统一进行。
2. **识别误判的兜底**：先观察真实运行里漏摄 / 多摄 / 误判歧义的分布，再决定是否收窄线索或加校验 hook；不预先上机器强制。
3. **与 ADR-0001 §未决 同一处受阻**：`agents/deepseek/**` 领先 `agents/contracts/**`（48 个产物 stale），重新生成会回退 deepseek 面的既有修复；本轮只落 deepseek 面，实施前需先决定回灌方向。

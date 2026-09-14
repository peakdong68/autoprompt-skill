# 值守模式按"能否获得回答"判定，不按"谁启动"判定

**状态（Status）**: proposed（已按 ADR-0003 的交互需求修订：提问模型由"唯一一次并发提问"泛化为**多提问点共用一次判定**，并引入判定的**粘性**与**重新点亮**）

`agents/deepseek/MODES.md` §Chooser and attendance 与 `SKILL.md` §1 把行为挂在**启动上下文**上：有人值守（attended）会话在碰仓库/工具之前问一次并发档位；**supervisor-launched unattended run** 绝不提问，缺省 `tokensaver` + `agents=off` 并把假设记入 `GATELOG.md`；显式 operator control 确定性覆盖默认。这个判据在 Claude 面有载体（`supervisor.sh` + `phase-budget.js` 心跳），在 **`agents/deepseek/**` 这一面没有**：该面零代码，预设 schema 里没有时间/轮数字段、唯一预算旋钮是 `maxDepth`（见 ADR-0001），没有启动器 flag、没有环境变量通道，唯一输入是 mission 文本。于是"启动者是谁"变成模型必须猜的**外部事实**——判据不可操作，而误判代价是不对称的：误判为有人会阻塞在无人应答的提问上；误判为无人只是采用默认档位并留痕，且随时可被显式控制覆盖。

**裁决**：把判据从"谁启动的"改为"**能否在本次会话内获得回答**"，并保留一个可选的显式前置指令。

1. **预答（保留，推荐，但不强制）**：mission 里的 `mode=tokensaver|wide|billionaire|custom`、`max_subs=N` 仍是 accepted directives，写了就按它；缺省时才走第 2 条。与 ADR-0003 的"默认零参数"同一口径：**不写任何指令也是一等公民**。
2. **能力测试 + 安全降级**：L0 发起提问，只按**结果**判定——拿到回答 = attended；**工具缺失 / 无 answerer / 被 fail-closed 拒绝** = unattended，采用 `tokensaver` + `agents=off`，把假设**连同降级依据**（哪个信号导致）记入 `GATELOG.md`，继续推进，绝不阻塞。
3. **可选强制**：接受 `run-mode=unattended`（对称地 `run-mode=attended`）作为显式 directive（归入 MODES.md 已有的 explicit operator control 范畴）；显式值覆盖一切推断与默认。

设计原则：**能观测的就不判定**——把值守问题降级成"一次可以失败的工具调用 + 一行日志"，而不是一道必须先验答对的分类题。

## 提问点与判定生命周期（与 ADR-0003 的接口）

**唯一提问者**：只有 L0 面向用户提问；worker 遇到用户自有依赖时**向上传递请求**（既有条款：worker 报告 `userRequired`，从不直接问用户）。

**提问点**（三处，共用同一次判定）：

| # | 提问点 | 可否被预答跳过 |
|---|---|---|
| 1 | 并发档位 knob | 可（`mode=` / `max_subs=`） |
| 2 | 用户自有依赖：凭据、产品方向、花钱/配额、不可逆或破坏性动作 | 不可（只能记录或提问） |
| 3 | **任务源歧义**：mission 里判断不出哪份文档是任务权威（ADR-0003） | 不可 |

**判定的建立与粘性**：在本次 run 内，**首次真实提问的结果即判定**，并**粘住整轮**——askability 是会话属性，不是问题属性。后续提问点复用该判定，不重复试探。

**判定未建立时的默认**：若预答使首次提问从未发生（提问点 1 被跳过且 2、3 都未触发），判定尚未建立；此期间一律按 **unattended 的保守默认**推进（默认档位 + 记录），**首次真实提问**再建立判定——一旦得到回答即刻转为 attended，不回溯也不重开已记录的决定。

**重新点亮**：**steering 或 operator control 到达 = 活人证据**，立即把判定置为 attended（可观测，不靠推断）。

**硬停与值守模式无关**：`INVALID-SOURCE`（ADR-0003）与 `INVALID-BRIEF` 属**完整性硬停**，不因 unattended 而降级为"记录后继续"；值班模式只决定"问还是记"，不决定"能不能放行"。

## 备选方案（Considered Options）

1. **维持 "supervisor-launched" 判据** — 否决。该判据在本面没有载体（无启动器、无 schema 字段），只能靠模型推断 mission 语气；同一句 `/autoprompt <mission>` 在 Web 人类会话与 CI 里完全等价，输入不携带区别。
2. **给激活信封加 `RUN-MODE` 字段** — 降级为可选增强，不作为本决定前提。信封由 L0 自己写入，而 L0 恰是不知道模式的那一方；一个自述字段解决不了外部事实的获取问题。
3. **环境变量或启动 flag（如 `AUTOPROMPT_UNATTENDED=1`）** — 否决（在本面不可用）。DSH 侧没有面向预设的 flag 通道（只有 mission 文本），预设 schema 也没有对应字段；要落地必须先改运行时插件，超出 `agents/deepseek/**` 的范围。
4. **把判定绑死在单一提问点（并发 knob 那一次）** — 否决。ADR-0003 引入任务源歧义、既有条款已有用户自有依赖，判定必须是**会话级**的；绑在单点上会导致"预答了 `mode=` 就等于放弃后续所有提问能力"。
5. **每次提问都重新探测值守模式** — 否决。同一会话内 askability 不会逐题变化；重复探测只会把一次可失败调用放大成多次，并让记录口径分裂。
6. **`headless` ⇒ unattended 的结构推断** — 采纳为**次要启发式**，不作唯一判据。headless 无交互后续，天然无人；而 Web 会话中人也可能离开，此时提问本就拿不到回答，第 2 条会自然降级，无需单独规则。
7. **一律按 unattended（永不提问）** — 否决。会让本应由用户拥有的决策（凭据、产品方向、花钱/配额、不可逆操作）静默降级为"记录后继续"，与"只有 L0 能问用户自有决策"的既有条款冲突。
8. **一律按 attended（总是提问）** — 否决。headless / CI 场景必然卡死，或触发 fail-closed 形成等价卡顿。

## 后果（Consequences）

正面：不需要先验分类；行为可观测、可复现（一次工具调用 + 一行台账）；**一次判定服务全部提问点**，因此 ADR-0003 的任务源歧义出口有明确依据；Web 与 headless 共用同一套规则；零 schema 改动、零新增脚本；显式控制仍具最高权威。

负面：有人值守时多付一次可能失败的提问（成本约等于一次工具调用，且 fail-closed 很快）；"attended 但人暂时离开"会退化为 unattended——可接受，因为台账留痕、后续 steering 既是补答通道也是**重新点亮**信号；判定粘性意味着首次探测结果影响整轮（以"未建立时按保守默认"与"steering 可重新点亮"两条限制其副作用）。

判定信号（按可靠性）：

| 信号 | 判为 | 性质 |
|---|---|---|
| 显式 `run-mode=` 或 `mode=` / `max_subs=` 预答 | 按声明 | 确定性（operator control 最高权威） |
| 提问**成功获得回答** | attended（并粘住） | 观测 |
| 提问失败：工具缺失 / 无 answerer / fail-closed | unattended（并粘住） | 观测 |
| **steering / operator control 到达** | attended（重新点亮） | 观测 |
| 判定未建立（首次提问尚未发生） | 保守按 unattended 推进 | 缺省规则 |
| `--profile headless` | unattended | 结构启发式（次要） |
| 权限绕过 flag | — | **禁止**据此推断（MODES.md 已明文） |

## 落点（改动清单）

| 文件 | 改动 |
|---|---|
| `agents/deepseek/MODES.md` §Chooser and attendance | 判据改写为"能否获得回答"；补判定粘性、未建立时的保守默认、steering 重新点亮、降级记录要求；accepted directives 增列 `run-mode=`；明确**默认零参数** |
| `agents/deepseek/SKILL.md` §1 | 与上同一段保持一致（现为 supervisor 措辞），并注明提问点三处共用一次判定 |
| `agents/deepseek/agents/ap-scoper.md` | 与 ADR-0003 的接口：任务源歧义**不自行猜测**，向上传递；由 L0 依本决定处置 |
| `agents/deepseek/README.md` | 可选：一句操作者说明（预答可省去提问；steering 随时可答） |
| `agents/deepseek/zh/**` | 以上镜像按需同步 |

不引入 schema 字段、不加启动器脚本、不改运行时插件；`agents/contracts/**` 与其他 provider 面不在本轮范围（回灌方向未决，见 ADR-0001 §未决）。

## 范围外（明确不解决）

- **任务源摄取与交接**：见 **ADR-0003**（自然语言引用 + 哈希绑定入账）。本决定只提供其"歧义时问一次"所需的判定机制，不涉及摄取本身。
- **任何预算机制**（时间/轮数）属 ADR-0001，本决定不涉及。

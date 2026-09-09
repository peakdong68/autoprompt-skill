# Autoprompt source

All eleven harnesses project the same v2 routes, 32 physical roles (seven active roles and 25 inactive compatibility aliases), checks, modes, playbooks, and 18 frameworks. Generated source parity and runtime admission are separate: current provider capability evidence determines whether a run can start.

## Provider packages

| Package | Private entry | Native internal roles | Frameworks |
|---|---|---|---|
| [Claude Code](claude/) | [SKILL.md](claude/SKILL.md) | [32 Markdown profiles](claude/agents/) | [18 procedures](claude/frameworks/) |
| [Codex](codex/) | [SKILL.md](codex/SKILL.md) | [32 TOML profiles](codex/agents/) | [18 procedures](codex/frameworks/) |
| [OpenCode](opencode/) | [SKILL.md](opencode/SKILL.md) | [32 permission-scoped profiles](opencode/agents/) | [18 procedures](opencode/frameworks/) |
| [Kilo](kilo/) | [SKILL.md](kilo/SKILL.md) | [32 permission-scoped profiles](kilo/agents/) | [18 procedures](kilo/frameworks/) |
| [VS Code](vscode/) | [SKILL.md](vscode/SKILL.md) | [32 private `.agent.md` profiles](vscode/agents/) | [18 procedures](vscode/frameworks/) |
| [Prime Agent](prime/) | [SKILL.md](prime/skills/autoprompt/SKILL.md) | [32 private persona prompts](prime/personas/) | [18 procedures](prime/prompts/frameworks/) |
| [Oh My Pi](omp/) | [SKILL.md](omp/SKILL.md) | [32 Markdown task profiles](omp/agents/) | [18 procedures](omp/frameworks/) |
| [DeepSeek Harness](deepseek/) | [SKILL.md](deepseek/SKILL.md) | [32 fixed-persona profiles](deepseek/agents/) | [18 procedures](deepseek/frameworks/) |
| [Hermes Agent](hermes/) | [SKILL.md](hermes/SKILL.md) | [32 private prompts](hermes/agents/) | [18 procedures](hermes/frameworks/) |
| [Grok Build](grok/) | [SKILL.md](grok/SKILL.md) | [32 private prompts](grok/agents/) | [18 procedures](grok/frameworks/) |
| [Reasonix](reasonix/) | [SKILL.md](reasonix/SKILL.md) | [32 manual subagent profiles](reasonix/skills/) | [18 procedures](reasonix/frameworks/) |

The public installation surface is one manual launcher per selected harness. Full entry instructions and all internal profiles belong in the private bundle. Loading source text or naming a role does not create or resume a run.

```text
autoprompt activate PROVIDER --target <absolute-project> -- <request>
```

## Work structures

There is no default route. DIRECT and LIGHT do not require coordinators or managers. ROADMAP can use the run coordinator and work-group manager only when the canonical policy admits them. The run owner retains route selection and the final response; the controller enforces physical launches, assignment ownership, independent checking, and recovery.

The nine additional native projections route every permitted child assignment through the controller. Their read-only profiles omit write and shell tools. Executable checking requires a separately admitted isolated transport. Leaves and compatibility aliases cannot dispatch; aliases remain read-only redirects and cannot take new v2 work.

Native visibility flags, tool lists, prompt rules, installation checks, and fixture tests do not establish full runtime conformance. Missing required capability evidence must block admission without an unrestricted native fallback. See the [provider capability contract](contracts/providers.json) and each package's README for the source/runtime boundary.

The generation check validates the final translated route examples and every framework check graph against the canonical hashes. Native YAML serialization is tested separately, including DeepSeek's embedded fixed personas. OMP profiles disable prewalk and advisor handoffs and omit the task tool: its parser can infer unrestricted spawning from that tool even when an empty child list is present.

## Source of truth

- [Product](contracts/product.json), [routes](contracts/routes.json), [state machine](contracts/state-machine.json), [roles](contracts/roles.json), [checks](contracts/gates.json), [providers](contracts/providers.json), and [plain language](contracts/plain-language.json) are the seven authoritative v2 contracts.
- [Physical role policy](codex/agents/role-policy.json) defines exact parent/child edges, modes, schemas, resources, and compatibility restrictions.
- [Package registry](../scripts/install/codex-package-registry.json) locates canonical instruction sources and framework route mappings.
- [Generator](../scripts/generate-provider-contracts.cjs) exposes `renderCodexOutputs()`, `renderReasonixOutputs()`, and `renderHarnessV2Outputs(provider, root)`. Normal generation opens all eleven projections without promoting runtime admission.
- [Manifests](manifests/) pin installable payloads and are regenerated separately after source changes.

```text
node scripts/generate-provider-contracts.cjs --check
node scripts/generate-provider-contracts.cjs --opencode-only --check
node --test tests/source/provider-generation.test.cjs tests/source/harness-v2-generation.test.cjs
node scripts/runtime-payload.cjs --check
```

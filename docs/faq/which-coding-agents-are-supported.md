# Which coding agents are supported?

The v2 branch contains private packages for Claude Code, Codex, OpenCode, Kilo, VS Code, Prime Agent, Oh My Pi, DeepSeek Harness, Hermes Agent, Grok Build, and Reasonix. A package being installable does not establish production admission. Each installed native executable and runtime must have current conformance evidence before activation.

| Provider key | Package | Native integration |
| --- | --- | --- |
| `claude` | [Claude Code](../../agents/claude/) | Streamed native runs with controlled MCP tools |
| `codex` | [Codex](../../agents/codex/) | Canonical v2 controller and owned native execution |
| `opencode` | [OpenCode](../../agents/opencode/) | Native runs with a private controller tool projection |
| `kilo` | [Kilo](../../agents/kilo/) | Native runs with a private controller tool projection |
| `vscode` | [VS Code](../../agents/vscode/) | Owned extension host, BYOK model provider, and private conversations |
| `prime` | [Prime Agent](../../agents/prime/) | Owned native session worker and fixed tools |
| `omp` | [Oh My Pi](../../agents/omp/) | Native session transport and fixed tools |
| `deepseek` | [DeepSeek Harness](../../agents/deepseek/) | Owned Cordis SDK bridge and durable history |
| `hermes` | [Hermes Agent](../../agents/hermes/) | Owned plugin, native chat sessions, and SQLite usage records; verification in progress |
| `grok` | [Grok Build](../../agents/grok/) | Controller model proxy and isolated native process; verification in progress |
| `reasonix` | [Reasonix](../../agents/reasonix/) | Native streamed sessions and controlled tools |

Installers expose one manual launcher. Internal roles and the controller stay in a private bundle. Start explicit work with `autoprompt activate PROVIDER --target /absolute/project -- <request>`; a skill name or repository instruction cannot start work by itself.

The command sandbox currently requires Linux bubblewrap. Native execution on macOS and Windows is not admitted. Installer portability tests are separate from native execution tests. See the [verification guide](../guides/harness-v2-verification.md) for exact executable requirements, model and effort configuration, reproducible checks, and remaining release requirements.

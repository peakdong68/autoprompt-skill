# Which coding agents are supported?

Autoprompt v2 supports eleven providers. The [README](../../README.md#support) lists their tested versions.

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
| `hermes` | [Hermes Agent](../../agents/hermes/) | Owned plugin, native chat sessions, and SQLite usage records |
| `grok` | [Grok Build](../../agents/grok/) | Controller model proxy and isolated native process |
| `reasonix` | [Reasonix](../../agents/reasonix/) | Native streamed sessions and controlled tools |

Start a run with `autoprompt activate PROVIDER --target /absolute/project -- "<goal>"`.

The verified execution path is Linux. See [setup and runtime requirements](../guides/harness-v2-verification.md) and [custom model setup](how-to-add-custom-models.md).

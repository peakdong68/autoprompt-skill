# How do I add custom models?

Custom `agents=` routing is available in Claude Code and Codex. Reasonix v2 provides explicit model/effort configuration and measured-registry selection; production activation remains gated on independent provider conformance. OpenCode, Kilo, and VS Code inherit the active model. Prime Agent, Oh My Pi, and DeepSeek Harness inherit the selected parent model.

Create a registry whose names match the values used in `agents=`:

```json
[
  {
    "name": "Strong",
    "provider": "router",
    "modelString": "provider/model-strong",
    "baseUrl": "http://localhost:20128/v1",
    "apiKeyEnv": "AUTOPROMPT_ROUTER_TOKEN",
    "effortHint": "high"
  }
]
```

`name`, `provider`, and `modelString` are required. `baseUrl`, `apiKeyEnv`, and `effortHint` are optional. Store only an environment variable name in `apiKeyEnv`, never a secret.

Claude Code accepts up to three selected models from one endpoint-compatible pool. Codex accepts up to five models available through its active provider. The selectors are:

| Selector | Result |
|---|---|
| `agents=off` | Inherit the current model. |
| `agents=Strong,Fast` | Use the named models in that order. |
| `agents=auto` | Rank the registry by `effortHint`. |
| `agents=auto:Strong,Fast` | Rank only the named entries. |

For the registry schema and launch details, see the [Claude model schema](../../agents/claude/autoprompt-models.schema.md) and [multi-provider guide](../guides/9router-multi-provider-setup.md).

## Reasonix v2

Use `autoprompt configure reasonix --agents provider/model --effort high` for one model. Use `--agents off` to inherit the configured Reasonix default. `--agents auto --model-map /absolute/registry.json` and explicit comma-separated lists require a fresh `reasonix-model-registry.v1` receipt with measured price, latency, capabilities, and success metadata. Supported effort values are `low`, `medium`, `high`, and `max`. Model selection does not change the task route.

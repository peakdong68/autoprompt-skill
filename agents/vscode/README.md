# VS Code v2 package

This generated package projects the canonical v2 routes, role policy, checks, modes, procedures, and framework instructions. Codex and Reasonix use the same canonical base.

- [Entry](SKILL.md): explicit activation and route instructions.
- [Internal roles](agents/): 32 physical profiles, including inactive compatibility aliases.
- [Frameworks](frameworks/): 18 compiled procedure projections.
- [Role policy](role-policy.json): exact parents, allowed children, resources, modes, authority, and alias restrictions.
- [Native projection](native-projection.json): private profile paths and provider tool mapping.

```bash
autoprompt activate vscode --target <absolute-project> -- <request>
```

The installer must expose only one public manual launcher. Full instructions and internal profiles remain in the immutable private bundle and are loaded only for a validated explicit activation.

All physical child launches belong to the external controller. Coordinators return only permitted assignments; leaves and retired aliases cannot dispatch. DIRECT and LIGHT have no mandatory coordinator. Model and effort settings are resolved before launch and do not select the task route.

Read-only native profiles omit production write and shell tools. Executable checking requires a separately admitted isolated-checking transport. Native tool restrictions alone do not prove filesystem isolation, resource ownership, identity, continuation, cancellation, usage accounting, or result capture.

Generation parity is not runtime conformance. The provider capability registry and current independent evidence govern runtime admission. Missing required capabilities produce PROVIDER_UNSUPPORTED; there is no unverified fallback advertised as full v2.

Private VS Code profiles disable user and model invocation and have empty native child lists. The production transport runs an isolated extension host and an owned BYOK language-model provider with fixed controller tools, exact provider usage receipts, and durable private conversations. These conversations are separate from built-in Chat histories. A graphical session (or an explicitly configured headless display) is required; recursive-subagent editor settings are not an admission check.

Configure the owned connection in `models.json` under the provider root, with `model`, `baseUrl`, and `apiKeyEnv` (`OPENROUTER_API_KEY` or `OPENAI_API_KEY`). The key stays in the named environment variable. Optional `reasoningEffort`, `maxTokens`, `maxSteps`, and `timeoutMs` bound the native session.

Native format reference: [VS Code documentation](https://code.visualstudio.com/docs/agent-customization/custom-agents).

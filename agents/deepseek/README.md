# DeepSeek Harness package

This package targets DeepSeek Harness 0.1.0-rc.7.

## What ships

| Path | What it is |
|---|---|
| `SKILL.md` | L0 conductor prompt |
| `agents/` | 25 generated role definitions |
| `frameworks/` | 18 task and gate workflows |
| `GATES.md`, `MODES.md`, `PLAYBOOKS.md` | execution contracts |
| `README.md`, `VERSION` | this file and the package version |
| `zh/` | Chinese translations of the docs and role definitions |
| `agent-preset/agent.cordis.yml` | the agent preset: 25 `dsh-tool-subagent` role tools plus the fixed tool set |
| `agent-preset/preset.yml` | preset discovery metadata |
| `agent-preset/hooks/` | the scope-convergence guard (see below) |
| `headless.patch.yml` | `--patch` composition for headless runs |

Select the Autoprompt agent preset for Web sessions. For headless runs, pass the installed `headless.patch.yml` with `--patch`. Each role tool denies non-allowlisted role tools and uses a depth ceiling of four.

Every role inherits the selected parent model. Custom `agents=` model routing is not available.

## Install layout

`agent-preset/` flattens into the preset directory; the rest of the package lands under `skills/autoprompt/`:

```text
<DSH_HOME>/.agent-presets/autoprompt/
  agent.cordis.yml       <- agent-preset/agent.cordis.yml
  preset.yml             <- agent-preset/preset.yml
  hooks/                 <- agent-preset/hooks/
  skills/autoprompt/     <- SKILL.md, GATES.md, MODES.md, PLAYBOOKS.md, README.md,
                            VERSION, headless.patch.yml, agents/, frameworks/
```

The bridge reads `configPath` once at process startup, so restart the harness after changing anything here.

## Scope-convergence guard

The scope phase has a single convergence budget: **one complete repair cycle** - a repair round plus its re-verification - and rounds are otherwise not preset. Only two of those rules can be decided by code; the rest are judgement and live in the personas. This guard enforces the two:

1. **Budget** - a repair dispatch beyond `MAX_REPAIR_CYCLES` is denied by `PreToolUse` with a model-visible reason.
2. **Pairing** - a `Stop` that follows an un-re-verified repair is blocked once, forcing the reviewer and blind fresh verifier to run. A repair that is never re-verified is not an APPROVED roadmap.

| File | Role |
|---|---|
| `hooks/hooks.json` | runs the guard on `PreToolUse` (matcher `ap_.*`) and on `Stop` |
| `hooks/scope-convergence-guard.cjs` | the guard itself |

The preset resolves both relative to its own directory - the same anchor `skills/` already uses - so the wiring survives relocation:

```yaml
- id: hooks-scope-convergence
  name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('hooks/hooks.json', baseUrl))"
    pluginRoot: !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('hooks', baseUrl))"
```

`headless.patch.yml` carries the same row, but anchors at the payload root, so its expressions read `agent-preset/hooks/...`.

### How it decides

Detection is by dispatched tool name, so it never depends on the model labelling its own briefs:

- the scope phase **opens** at the first `ap_scope_coordinator` / `ap_scoper` dispatch;
- **assurance** is the `ap_reviewer` / `ap_fresh_verifier` pair;
- a **repair** is a dispatch of a roadmap-authoring role (`ap_scoper`, `ap_synthesizer`) after an assurance round has occurred;
- the phase **closes** at the first `ap_feature_coordinator` dispatch, after which the guard is dormant.

Per-session state lives in the temp directory, never in the target repository: `%TEMP%/autoprompt-scope-guard/<session>.json`, overridable with `AUTOPROMPT_SCOPE_GUARD_DIR`.

### Known limitations

- Only the named repair authors consume the budget, so a repair performed by another role goes uncounted. The guard fails open and never denies by mistake.
- If scope work begins without any scope-entry dispatch, the guard stays idle.
- The bridge implements no consecutive-block cap for `Stop`, so the pairing rule self-limits: one repair can be blocked at most once.
- A guard that cannot read or parse its config logs a warning and runs nothing; the session still starts.

### Verify it

```sh
G=hooks/scope-convergence-guard.cjs
echo '{"hook_event_name":"PreToolUse","session_id":"t","tool_name":"ap_scoper"}'   | node "$G"
echo '{"hook_event_name":"PreToolUse","session_id":"t","tool_name":"ap_reviewer"}' | node "$G"
echo '{"hook_event_name":"PreToolUse","session_id":"t","tool_name":"ap_scoper"}'   | node "$G"
echo '{"hook_event_name":"Stop","session_id":"t"}'                                 | node "$G"
```

The first three print nothing (only the third opens a repair). The `Stop` prints `hookSpecificOutput.permissionDecision: "deny"`. Repeating the `Stop` prints nothing again, and a fourth `ap_scoper` dispatch prints the spent-budget denial.

## Convergence wording

The scope-phase statements agree across `SKILL.md` section 3, `MODES.md`, `GATES.md`, `PLAYBOOKS.md`, `frameworks/plan-scope.md`, and the `ap-scope-coordinator` and `ap-manager` roles: a clean pass costs 3 agents for bounded scope and 5 for multi-surface; convergence is bounded by one complete repair cycle rather than a fixed round count; and the assurance round - independent review plus blind fresh verification - is never dropped, merged, or deferred to fit that budget.

## Note on generation

`README.md` is normally emitted by `scripts/generate-provider-contracts.cjs`. This copy is maintained by hand, like the rest of this package, which currently leads the generator; regenerating the preset would drop the `hooks-scope-convergence` row unless the generator carries it too.

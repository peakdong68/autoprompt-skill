# Reasonix v2 package

This adapter projects the same version 2 routes, role policy, checks, and recovery contracts as Codex into Reasonix 1.30.0 native profiles.

- `SKILL.md`: explicit entry and coordinator instructions
- `skills/`: 32 native manual profiles, including compatibility aliases
- `frameworks/`: the canonical task and check workflows
- `workflow/`: native transport and external controller integration
- `GATES.md`, `MODES.md`, and `PLAYBOOKS.md`: compiled v2 contracts

```bash
autoprompt activate reasonix --target <absolute-project-path> -- <request>
```

Internal profiles are installed in a private bundle and become available only to an explicit activation. Installation and source tests do not constitute live provider conformance.

Production activation currently refuses with `PROVIDER_UNSUPPORTED`: this release has no independent signed Reasonix conformance attestation. This is the same required-capability admission policy used by v2. Do not replace the missing record with self-issued evidence.

Configure model inheritance with `autoprompt configure reasonix --agents off`, one model with `--agents provider/model --effort high`, or measured automatic selection with `--agents auto --model-map <reasonix-registry.json>`. Explicit lists use the same measured registry. Model selection never changes the task route.

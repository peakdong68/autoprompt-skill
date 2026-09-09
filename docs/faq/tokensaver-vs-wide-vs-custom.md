# Run controls

| Control | Effect |
|---|---|
| `--concurrency tokensaver` | Runs at most six subagents at once; the default. |
| `--concurrency wide` | Starts ready, independent work up to the host limit. |
| `--concurrency custom --max-subs N` | Limits simultaneous subagents to `N`. |
| `path=auto` or omitted | Chooses a work route for the task. |
| `path=direct` | Starts focused work without a separate plan. |
| `path=light` | Makes a short plan before starting work. |
| `path=roadmap` | Plans dependent work before execution. |

Pass controls after `--`, before the quoted request. Use automatic route selection with custom concurrency:

```bash
autoprompt activate codex -- --concurrency custom --max-subs 4 "fix the registration race"
autoprompt activate codex -- path=light "add retries and test the edge cases"
```

The same controls apply to all eleven providers. A concurrency limit is a ceiling, not a target; small jobs may use fewer agents. Every route includes independent verification.

Configure models separately with `autoprompt configure PROVIDER --agents MODEL`, or use `--agents off` to inherit the configured model. Automatic selection and model lists require a measured model registry. See [custom models](how-to-add-custom-models.md) and [work paths](work-paths.md).

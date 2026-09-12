# Connect a router to Autoprompt v2

A router can expose models from several upstream providers through one endpoint. Configure the router and verify its model identifiers with the native harness before configuring Autoprompt. The endpoint must speak the protocol expected by that harness: a Chat Completions endpoint alone is not an Anthropic Messages endpoint.

This guide replaces the v1 shell-supervisor and Opus/Sonnet/Haiku alias-casting instructions. Those commands are not the v2 activation path.

## Configure the native connection

For Claude Code, the controlled adapter reads `ANTHROPIC_BASE_URL` and the supported private native credential environment, including `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. Set the base URL to the router's actual Anthropic-compatible endpoint. Keep the credential outside the repository.

Other providers have their own connection formats and protocol requirements. OpenCode and Kilo use their private provider/model configuration; an explicit reasoning variant for a custom model must declare the matching `reasoningEffort`. Prime and Oh My Pi use their model registries. Use the [verification guide](harness-v2-verification.md) for adapter restrictions and evidence requirements.

Autoprompt does not create router aliases or infer compatibility from an endpoint URL. The exact configured model identifier must exist upstream, and the requested effort must be supported by both the model and native adapter.

## Select and activate

After installation and connection setup, select an exact model:

```sh
autoprompt configure claude --agents router-model-id --effort low
autoprompt doctor claude --strict
```

For a custom installation, add the same `--root /absolute/provider-config` to each command. Multiple models and automatic routing require a fresh measured receipt; see [custom model configuration](../faq/how-to-add-custom-models.md).

Once the installed runtime and native executable have the required conformance admission, launch through the public command:

```sh
autoprompt activate claude --target /absolute/project -- \
  "fix the smallest failing test and verify the result"
```

An installer or doctor result alone is not admission. `PROVIDER_UNSUPPORTED` means the runtime cannot establish the required capability evidence; use the documented independent review and import process rather than changing trust records to suppress the error.

Verify a real run using its owned tool receipts, native session identity, exact model and effort, usage records, and checker outcome. Router telemetry can corroborate upstream routing. Keep private session histories and credentials out of published reports.

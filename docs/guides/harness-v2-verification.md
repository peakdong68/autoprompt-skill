# Version 2 harness verification

This branch ports the reviewed Codex version 2 contracts to Claude Code,
OpenCode, Kilo, VS Code, Prime Agent, Oh My Pi, DeepSeek Harness, Hermes Agent, Grok Build and Reasonix.
Generated prompts, a successful installation, and a successful native transport
test are separate evidence levels. None alone proves an end-to-end autonomous
run, a filesystem sandbox, or safe cancellation of every child process.

## Install and inspect a private package

From this checkout, with Node.js 20 or newer:

```sh
node bin/autoprompt.cjs install opencode --root /absolute/provider-config
node bin/autoprompt.cjs doctor opencode --strict --root /absolute/provider-config
node bin/autoprompt.cjs configure opencode --agents off --root /absolute/provider-config
```

Replace `opencode` with the intended provider. Codex and Reasonix retain their
provider-specific packaging and activation helpers. The other nine share the
private v2 package lifecycle. `--root` is the provider configuration root, not a
directory in the target repository. The installer preserves unrelated settings,
refuses changes to files it does not own, and quarantines byte-matched v1 files
before replacing them. Finish or cancel resumable work before updating or
uninstalling its runtime.

Prime v1 package migration also retires the exact managed entries from
`settings.json`, so quarantined code is not left registered. Other packages,
comments, byte-order marks, line endings, permissions and unrelated settings
are preserved. The install result reports `legacySettingsBackup`, a private
copy of the original settings. A failed installation restores both registration
and package bytes; uninstall does not reactivate retired v1 code.

Only an explicit launcher is public. Claude, VS Code, Prime, DeepSeek, Hermes and Grok use a
manual skill. OpenCode and Kilo use a manual command, and Oh My Pi uses a prompt.
Private role files are not copied into global agent discovery. VS Code defaults
to the personal `~/.copilot` root; it does not put the private bundle in the
workspace. Windows and provider-specific environment overrides are resolved by
the same packaging helper used by the interactive installer.

```sh
node bin/autoprompt.cjs activate opencode --root /absolute/provider-config \
  --target /absolute/project -- "repair the defect and run its regression test"
```

Arguments after `--` are the exact request. Do not interpolate a request into a
shell script. A resumed run must preserve its request, target, executable,
package, model configuration and original deadline.

## Admission is not an installer check

**The non-Codex v2 production ports are not yet admitted for general use.**
The release trust records shipped on this branch do not yet contain completed
release review records for the new adapters. Activation returns
`PROVIDER_UNSUPPORTED` rather than quietly falling back to Codex, v1 prompts,
unrestricted native agents, or an unverified execution boundary.

There are two distinct admission policies. Independent signed conformance uses
an external, provider-scoped Ed25519 authority. The separate
`reviewed-local-release-v1` policy uses a maintainer-authenticated release whose
review record binds the exact installed runtime, native executable and portable
dependency closure, platform, eleven named native capability tests, reviewed
live evidence, and expiry. This record does not claim an independent signature.

A reviewed release still runs the actual installed native CLI through all
eleven controller-owned capability tests before each activation or resume.
The tests use a private deterministic model endpoint, so this stage does not
spend provider credits. Their observations bind a fresh random challenge to the
activation, generation, target, request, connection, complete local dependency
identity, payload, and enforcement proof. Existing invalid, expired, or
mismatched trust cannot fall back to this policy. A successful local canary
authorizes only its exact activation; it cannot be replayed for another run.

Canary time counts against the activation deadline. The batch also has a
twelve-minute ceiling and cannot outlive its release approval. Native startup
cost varies: the current full OMP capability suite takes approximately nine
minutes before mission work begins. Choose an activation TTL that covers both
the canary and the requested work. Expired authority stops and drains the
owned test processes.

Portable identity requires identical native dependency bytes under logical
installation paths. Hermes normalizes verified installation references in Python
launcher shebangs, editable metadata, `.pth` entries, and their matching `RECORD`
hashes. Two fresh Python venvs with the same pinned dependency set and separate editable
Hermes source installations produced the same portable identity; their raw
identities remained different. Editable/package symlinks refuse admission, and
required OS Python links bind their lexical path, resolved target, and bytes.
All other runtime bytes remain bound, and activation and continuation retain
exact local hashes.
Native CLI or dependency updates require another matching review; installation
success alone is not an admission claim.

The owned adapters now use fixed controller tools, durable tool receipts,
private native session storage, and the shared process owner. Real native tests
exercise candidate write denial, private scratch writes, command results,
token accounting, continuation and cancellation. Prime uses its owned session
worker and disables implicit child spawning. DeepSeek uses an owned Cordis SDK
bridge and the SDK's persisted-history continuation. Reasonix has passed real
read-only candidate and writable scratch tests, including targets under `/tmp`.

Native provider requests pass through a reservation-private quota endpoint.
Each request reserves a durable input/output allowance before upstream bytes
are sent. Exact provider usage settles that allowance once; native terminal
usage must reconcile with the owned receipts. Cancellation preserves an
already-complete usage receipt, while an incomplete response charges its
admitted upper bound and closes the request channel. The default scheduler
accounting ceiling does not disable these per-request reservations.

This boundary requires an explicit supported provider connection and bounded
text/function requests. Remote conversation references, hosted tools,
multimodal inputs and unreviewed routing options are refused before upstream
transmission. Reasonix defaults to a 4,096-token output cap and preserves an
explicit valid cap within the child allowance. Hermes caps output at 4,096
tokens or a smaller configured allowance. Prime and OMP preserve the native
`max_tokens` or `max_completion_tokens` field and lower it to the controller and
model ceiling. If the native SDK omits both fields, an explicit selected-model
`compat.maxTokensField` is required; the adapter does not guess a wire dialect.
Prime, OMP and Grok bind their native
structured output to a strict closed `{canonicalJson:string}` wire envelope.
The controller validates that envelope, decodes its one JSON value, and then
applies the unchanged exact canonical output schema; a failed native schema
hook, prose, or a contradictory inner result cannot bypass the host check.

Slow supported JSON and SSE responses can emit protocol-neutral whitespace or
comments while the quota endpoint waits for accounting. Model text and tool
calls remain buffered until the complete response validates and usage settles.
Later keepalives require upstream progress; they do not extend the upstream
idle deadline or conceal a stalled provider.

VS Code runs an isolated extension host with an owned BYOK language-model
provider. Exact usage travels through provider receipts and its conversations
have private durable identities, separate from built-in VS Code Chat histories.
The owned connection requires a graphical session or a headless display.

Command execution currently requires **Linux with working bubblewrap and
process ownership through `/proc`**. macOS and Windows native execution is not
verified or enabled by these adapters. Installer portability is separate:
POSIX and PowerShell installer lifecycles are tested on Linux; macOS path and
shell selection tests are fixtures. On macOS the CLI discovers installed
Homebrew Bash at `/opt/homebrew/bin/bash` or `/usr/local/bin/bash`; otherwise
install Bash 4.3 or newer. These checks do not substitute for native macOS or
Windows runs.

The macOS refusal is deliberate and occurs before a worker process is launched:
the shared command boundary has only a Linux bubblewrap backend, and the POSIX
process owner requires a provider-supplied durable reservation-recovery
implementation when `/proc` is unavailable. It must not fall back to a PID-only
cleanup check. The Codex executable resolver does recognize the official macOS
arm64 and x64 packages, and the installer uses portable temporary directories;
those installation paths are not evidence that a command-capable runtime is
safe. Windows has a separate Job Object process-owner implementation, but the
non-Codex shared v2 harnesses still require the shared command-boundary proof.
Codex performs a separate native sandbox preflight; its archived Windows canary
observed loopback networking and refused activation. Windows also lacks the
descriptor-anchored filesystem primitive needed for strict runtime snapshots.
Native tests on the corresponding host must prove candidate write denial,
no-loopback networking, descendant cleanup after cancellation and restart, and
worker/resume/checker accounting before either platform is enabled.

Model inheritance (`--agents off`) and an explicit model pin are configuration
operations, not proof that a runtime can execute. Automatic or multi-model
selection requires a measured registry. Unverified native effort mappings are
rejected, not silently ignored. Claude forwards `low`, `medium`, `high`, `xhigh`
and `max` with its native `--effort` option. OpenCode and Kilo forward the same
canonical values with `--variant`, but a variant is model-specific. For a custom
OpenAI-compatible provider, the selected model must declare
`variants.<effort>.reasoningEffort` with the same value; otherwise the launcher
refuses the request instead of letting the CLI ignore it. Prime Agent and Oh My
Pi forward `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max` with
`--thinking`; the selected model must advertise reasoning-effort support.
DeepSeek explicitly supports `off`, `low`, `high` and `max`. Its implicit
canonical routing policy maps `medium` to native `high` and `xhigh` to native
`max`, records both `policyEffort` and `nativeEffort`, and ranks the measured
registry using that native value. An explicit DeepSeek `medium` or `xhigh`
request remains invalid. The owned VS Code connection forwards `none`,
`minimal`, `low`, `medium`, `high` or `xhigh`; the selected model must also
support the value.

Grok Build accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and
`max`. An omitted effort uses the adapter's explicit `none` default, including
native compaction requests. The unverified `ultra` spelling is rejected before
launch. Hermes accepts the same values plus its native `ultra` level. For an
OpenRouter connection, Hermes maps `ultra` to wire `max` and `none` to disabled
reasoning; the controller preserves that exact mapping through its local quota
relay. Each upstream model must support the resulting effort.

Codex's controlled BYOK catalog includes `z-ai/glm-5.3-flash` and
`openai/gpt-5.6-luna` at `low` effort. Its adapter uses a conservative 32,768-token context limit and a
4,096-token output limit, and applies those limits to the cumulative quota
proxy. The exact model identifier reaches the provider; it is not an alias for
a built-in Codex model. A model pin being accepted by configuration does not
mean every model is admitted by the controlled native catalog.

Registry effort evidence uses the canonical `low` through `max` vocabulary. A
native-only value such as `off` is therefore valid for one explicitly pinned
model but cannot be used as a measured multi-model routing constraint. Only the
documented DeepSeek implicit policy mapping above substitutes a native value;
explicit user effort is never changed.

## Reproduce evidence

```sh
node scripts/generate-provider-contracts.cjs --check
node scripts/runtime-payload.cjs --check
npm run test:harness-v2
npm run test:reasonix
```

The harness suite includes all eleven installer lifecycles, packed npm artifact
checks, exact mission forwarding, missing-provider refusal, role projections,
and diagnostic truthfulness. Native tests skip when their explicitly selected
binary is unavailable. A skipped test is not a pass for that provider.

Actual-binary tests use a deterministic localhost model service. The provider
executable, file tools, session storage and event encoder are real; no paid model
service or user credentials are used. Supply an absolute executable path:

```sh
AUTOPROMPT_CLAUDE_TEST_CLI=/absolute/claude \
  node --test --test-name-pattern="claude native" tests/source/harness-v2-native.test.cjs
AUTOPROMPT_OPENCODE_TEST_CLI=/absolute/opencode \
  node --test --test-name-pattern="opencode native" tests/source/harness-v2-native.test.cjs
AUTOPROMPT_KILO_TEST_CLI=/absolute/kilo \
  node --test --test-name-pattern="kilo native" tests/source/harness-v2-native.test.cjs
AUTOPROMPT_REASONIX_TEST_CLI=/absolute/reasonix \
  node --test tests/source/reasonix-native.test.cjs
```

For a durable local diagnostic from the checkout:

```sh
node scripts/harness-v2-conformance.cjs --provider reasonix \
  --executable reasonix=/absolute/reasonix --native-tests \
  --output /absolute/new-evidence-directory
```

The output directory must be new. It contains bounded stdout/stderr captures,
executable hashes, exact versions, test counts and a JSON report. Help probes
only establish an advertised command interface. Tests with injected processes
are marked as such. These commands never generate, install or grant production
admission. Keep local reports and private session histories out of source
control and out of published artifacts.

## Local admission after independent review

An installed runtime has an executable path in its identity, so a shipped
record cannot pre-approve arbitrary local executable paths. The public command
can create a review request from an actual-binary diagnostic and an externally
reviewed live-conformance report:

```sh
autoprompt admission request opencode --root /absolute/provider-config \
  --executable /absolute/opencode --report /absolute/evidence/report.json \
  --live-report /absolute/reviewed-live-report.json \
  --output /absolute/opencode-admission-request.json
```

The live report is a reviewer-owned JSON document with
`schemaVersion: "harness-v2-reviewed-live-conformance.v1"`, the exact runtime
and native-report hashes, a passed status, every required capability, reviewer
issuer and review ID, and at least one hashed live-run evidence item. It is not
created by the diagnostic command. A conformance authority then reviews that
request and signs an Ed25519 `live-conformance-suite` attestation whose
`providerAdmissionSha256` is the request digest. The authority must be
provider-scoped, independent of activation, and must not use an activation
issuer. Project-maintained review is acceptable when that separation is real;
the software cannot prove that two key holders are different people.

The user explicitly imports the returned signed `evidence.json` and
`trusted-public-keys.json`; no activation command installs trust material:

```sh
autoprompt admission import opencode --root /absolute/provider-config \
  --executable /absolute/opencode --report /absolute/evidence/report.json \
  --live-report /absolute/reviewed-live-report.json \
  --request /absolute/opencode-admission-request.json \
  --evidence /absolute/signed-evidence.json \
  --keys /absolute/reviewer-public-keys.json
```

Import verifies the exact current bundle and executable, the report bindings,
the signature, and the authority scope before placing the certificate under the
private provider root. Activation reopens those files and its enforcement
boundary rechecks their hashes, signature, request digest and runtime identity.
This is local, explicit provenance; it is not a claim that the empty shipped
release records contain general support evidence.

## Verification scope

The interactive installer preserves a locally built npm artifact when the public
release is older. A registry or tarball installation does not automatically
switch to a same-version GitHub main build. Automatic GitHub revision refreshes
apply only after a GitHub installation has been explicitly selected and its
revision recorded. Explicit update commands remain available.

Generation proves contract projection, not host behavior. Lifecycle tests prove
installation and rollback, not model quality. Localhost native tests prove the
specific native tool, usage and continuation behavior they exercise, not an
independent live-model run. Linux testing does not establish Windows or macOS
sandbox behavior. Use a fully admitted release for production work until every
required capability has evidence for the installed executable and runtime.

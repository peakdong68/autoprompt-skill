# Version 2 harness verification

This branch ports the reviewed Codex version 2 contracts to Claude Code,
OpenCode, Kilo, VS Code, Prime Agent, Oh My Pi, DeepSeek Harness and Reasonix.
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
provider-specific packaging and activation helpers. The other seven share the
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

Only an explicit launcher is public. Claude, VS Code, Prime and DeepSeek use a
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
The release trust records shipped on this branch do not contain independent
signed live-conformance evidence for the new adapters. Activation returns
`PROVIDER_UNSUPPORTED` rather than quietly falling back to Codex, v1 prompts,
unrestricted native agents, or an unverified execution boundary.

The owned adapters now use fixed controller tools, durable tool receipts,
private native session storage, and the shared process owner. Real native tests
exercise candidate write denial, private scratch writes, command results,
token accounting, continuation and cancellation. Prime uses its owned session
worker and disables implicit child spawning. DeepSeek uses an owned Cordis SDK
bridge and the SDK's persisted-history continuation. Reasonix has passed real
read-only candidate and writable scratch tests, including targets under `/tmp`.

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

The harness suite includes all seven installer lifecycles, packed npm artifact
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

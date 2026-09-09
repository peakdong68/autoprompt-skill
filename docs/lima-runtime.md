# Configured Linux runtimes

The Lima runtime is an explicit macOS-to-Linux activation path. It never picks
an existing VM, copies a host home directory, or forwards an agent socket. The
only writable host mount is the target supplied to setup. Controller state,
credentials, native clients, and the model connection remain on the guest's
private ext4 disk.

Prepare a private import directory before setup. `toolchain` is the complete
official Linux Node `node-v22.23.2-linux-x64` or `node-v22.23.2-linux-arm64`
directory. `native` is a self-contained Linux closure made by the selected
provider's official installer, with its executable at `bin/<provider-command>`
or `node_modules/.bin/<provider-command>`. Do not use a host binary, a source
tree, a symlink to a host path, or a wrapper that names its original install
directory. Setup copies the two closures and verifies their portable content
and mode digest in the guest; the pinned Node and provider `--version` must run
there before setup is recorded.

OMP has a public closure preparer for its Bun-backed native installation. Run
it on Linux against the exact OMP tree installed by the official installer. It
copies that tree to a new private directory, binds the internal `omp` and Bun
entrypoints and their ELF architecture, then starts OMP in a Bubblewrap mount
namespace that omits the original source tree. The optional tar is suitable
for the WSL `--native-archive` input; retain its printed SHA-256 with the
archive.

```sh
autoprompt runtime closure prepare omp \
  --source /private/omp-installed \
  --bun /private/bun-linux-x64-baseline/bun \
  --output /private/imports/omp-linux-x64 \
  --archive /private/imports/omp-linux-x64.tar \
  --arch x86_64
```

Use the resulting directory as Lima's `--native` input or move the resulting
tar and its digest to Windows for WSL setup. The command refuses wrappers,
external links, a mismatched Bun architecture, and a closure that only works
while its original installation remains visible.

`--connection` is the selected provider's normal native connection file. JSON
providers use their existing `models.json`, `opencode.json`, or `kilo.json`
schema; Prime and OMP use their normal model registry; Reasonix uses its normal
`config.toml`. A Codex connection file is exactly
`{"schemaVersion":1,"provider":"codex"}`. A connection that has no documented
base-URL environment variable must contain the exact endpoint in its reviewed
native connection field. `--credential` is a private JSON object with exactly
the selected provider and its allowed API-key environment names. It is never
placed on an argv, exported target, status response, or log. `--model-selection`
is optional for the harness providers and Reasonix and must be the exact output
schema written by their public `configure` command.

For example, after installing a provider's Linux native closure through its
official installer and creating private connection and credential files:

```sh
autoprompt runtime vm setup \
  --root /private/autoprompt-lima \
  --target /Users/<user>/project \
  --provider codex \
  --endpoint http://127.0.0.1:17888/v1 \
  --connection /private/codex-connection.json \
  --credential /private/codex-credentials.json \
  --toolchain /private/imports/node-v22.23.2-linux-x64 \
  --native /private/imports/codex \
  --lima /private/lima/bin/limactl \
  --archive /private/autoprompt-skill.tgz \
  --vm-type qemu \
  --qemu-root /private/qemu-runtime \
  --arch x86_64
```

Activate only through the recorded descriptor:

```sh
autoprompt activate codex --vm-root /private/autoprompt-lima --ttl 1800 -- <mission>
```

On macOS, a QEMU start receives a 30-minute readiness limit only when
`kern.hv_support` reports that Hypervisor.framework is unavailable. This covers
nested TCG startup; VZ and accelerated QEMU use Lima's default readiness limit.

`runtime vm status` reports the configured VM binding. `runtime vm cancel` takes
the exact request ID emitted by activation. A cancellation acknowledgement means
only that cancellation was requested; it becomes terminal only after the guest
returns a checksummed terminal record and `ProcessOwner` proves its owned groups
are drained.

## Dedicated WSL2 runtime

On Windows, `runtime wsl` imports a dedicated WSL2 distribution from a rootfs
archive whose SHA-256 digest you provide. It disables WSL automount and Windows
interop, keeps controller state on the distribution's ext4 filesystem, and
mounts only the configured Windows target at `/home/autoprompt/target`. The
Linux Node and provider closures are archive inputs because Windows filesystems
cannot preserve all Linux executable and symlink metadata. Each archive is
bound to an explicit SHA-256 digest, extracted with traversal and escaping-link
checks, and verified again with the same portable tree digest used by Lima.

Run setup from Windows with the supported `wsl.exe`, a verified Ubuntu rootfs,
and Linux closures matching the selected guest architecture:

```powershell
autoprompt runtime wsl setup `
  --root C:\Private\autoprompt-wsl `
  --target C:\src\project `
  --provider deepseek `
  --endpoint https://gateway.example.invalid/v1 `
  --connection C:\Private\models.json `
  --credential C:\Private\credentials.json `
  --toolchain-archive C:\Private\node-v22.23.2-linux-x64.tar.xz `
  --toolchain-sha256 <64-lowercase-hex> `
  --native-archive C:\Private\deepseek-native.tar.gz `
  --native-sha256 <64-lowercase-hex> `
  --wsl "C:\Program Files\WSL\wsl.exe" `
  --rootfs C:\Private\ubuntu-rootfs.tar.xz `
  --rootfs-sha256 <64-lowercase-hex> `
  --archive C:\Private\autoprompt-skill.tgz `
  --arch x86_64
```

Use `autoprompt activate deepseek --wsl-root C:\Private\autoprompt-wsl --
<mission>` for activation. `runtime wsl status`, `runtime wsl exec`, and
`runtime wsl cancel` use the same guest lifecycle receipts as Lima. Setup does
not use an existing distribution, `/mnt/c`, Windows PATH injection, or a shared
home directory.

For the VS Code owned OpenAI-compatible adapter, set
`"supportsStructuredOutput": true` in its private connection file only after
that exact endpoint/model has passed the native structured-output canary. The
adapter then sends a strict `response_format: json_schema` canonical envelope;
without this explicit capability it keeps controller-side validation and does
not claim the endpoint supports structured output.

For VS Code, fresh Lima guests install the Electron display libraries, `xauth`,
and `Xvfb`. An activation starts an authenticated Xvfb only as a non-detached
child of that lifecycle worker, with a request-private Xauthority and runtime
directory below the guest controller root. The guest never forwards a host
`DISPLAY`; terminal completion and cancellation stop the owned display before
the lifecycle receipt is emitted.

## Hermes Linux native closure

Hermes installed in a virtual environment is often an editable installation:
its launcher can point at a host Python and its package finder can point at a
checkout. Do not pass that venv directly as `--native`; copying or rewriting
the launcher does not make those dependencies portable.

Build a new closure on Linux from the reviewed Hermes venv and its matching
source tree. The helper copies the CPython executable and standard library,
Hermes site packages, and Hermes source into the new root. It excludes editable
finder metadata, rejects credential-shaped files, writes no provider credentials
or Hermes home, and runs a Bubblewrap witness in which the original venv and
source tree are hidden.

```sh
node scripts/hermes-runtime-closure.cjs prepare \
  --root /private/imports/hermes-linux-x64 \
  --venv /private/build/hermes-venv \
  --source /private/build/hermes-source \
  --python /usr/bin/python3 \
  --arch x86_64 \
  --archive /private/imports/hermes-linux-x64.tar
```

The result contains `.autoprompt-hermes-linux-closure.json`, which binds the
architecture, CPython SOABI, source digest, entrypoints, and every copied byte.
Verify it before use:

```sh
node scripts/hermes-runtime-closure.cjs verify \
  --root /private/imports/hermes-linux-x64
```

Use the closure directory as Lima's `--native` for `--provider hermes`. For
WSL, use the emitted tar file as `--native-archive` and its printed SHA-256 as
`--native-sha256`. The guest must match the closure's Linux architecture and
CPython ABI; prepare a separate closure after any Hermes source, interpreter,
or dependency change and review that new identity before activating it. The
closure holds no API key: supply Hermes credentials only through the private
connection and credential records used by runtime setup.

#!/usr/bin/env bash
set -euo pipefail

# Apple ships Bash 3.2, which cannot run the supported release bootstrap. When
# this script is started by that system shell, hand it to the Homebrew Bash
# without changing PATH for the installation itself. Keep this block Bash 3.2
# compatible: it executes before any Bash 4-only syntax is parsed or used.
if [[ "$(uname -s 2>/dev/null || true)" == 'Darwin' ]] &&
   (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
  autoprompt_modern_bash=''
  for autoprompt_bash_candidate in /opt/homebrew/bin/bash /usr/local/bin/bash; do
    if [[ -x "$autoprompt_bash_candidate" ]] &&
       "$autoprompt_bash_candidate" -c '(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) ))' >/dev/null 2>&1; then
      autoprompt_modern_bash="$autoprompt_bash_candidate"
      break
    fi
  done
  if [[ -z "$autoprompt_modern_bash" ]] && command -v brew >/dev/null 2>&1; then
    autoprompt_bash_prefix="$(brew --prefix bash 2>/dev/null || true)"
    autoprompt_bash_candidate="$autoprompt_bash_prefix/bin/bash"
    if [[ -x "$autoprompt_bash_candidate" ]] &&
       "$autoprompt_bash_candidate" -c '(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) ))' >/dev/null 2>&1; then
      autoprompt_modern_bash="$autoprompt_bash_candidate"
    fi
  fi
  if [[ -n "$autoprompt_modern_bash" ]]; then
    exec "$autoprompt_modern_bash" "$0" "$@"
  fi
  printf 'Error: Bash 4.3 or newer is required on macOS. Install it with: brew install bash\n' >&2
  exit 1
fi

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Node.js 20 or newer is required: https://nodejs.org/en/download'
command -v npm >/dev/null 2>&1 || fail 'npm is required: https://nodejs.org/en/download'
resolve_python() {
  local candidate
  local -a candidates=()
  if [[ -n "${AUTOPROMPT_PYTHON:-}" ]]; then
    candidates+=("$AUTOPROMPT_PYTHON")
  else
    candidates+=(python3 python)
  fi
  for candidate in "${candidates[@]}"; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if "$candidate" -c 'import sys, yaml; assert sys.version_info >= (3, 11)' >/dev/null 2>&1; then
      AUTOPROMPT_RELEASE_PYTHON="$candidate"
      return 0
    fi
  done
  fail 'Python 3.11 or newer with PyYAML is required: https://www.python.org/downloads/'
}

resolve_python

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail 'Could not read the Node.js version.'
(( node_major >= 20 )) || fail "Node.js 20 or newer is required. Found $(node --version)."

(( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) )) || \
  fail "Bash 4.3 or newer is required. Found ${BASH_VERSION}."

# The selected interpreter was already verified above. Preserve its exact
# spelling so macOS installations that expose only python3 do not reintroduce
# a bare-python dependency later in this bootstrap.
"$AUTOPROMPT_RELEASE_PYTHON" -c 'import sys, yaml; assert sys.version_info >= (3, 11)' >/dev/null 2>&1 || \
  fail 'Python 3.11 or newer with PyYAML is required. Run: python3 -m pip install PyYAML'

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
shopt -s nullglob
bundled=("$script_directory"/autoprompt-skill-*.tgz)
shopt -u nullglob
(( ${#bundled[@]} <= 1 )) || fail 'The release kit contains more than one npm archive.'
package='autoprompt-skill'
if (( ${#bundled[@]} == 1 )); then
  package="${bundled[0]}"
fi

printf 'Installing Autoprompt skill from %s\n' "$package"
npm install --global --ignore-scripts --no-audit --no-fund "$package"

# Another npm prefix may provide an older autoprompt earlier on PATH. Resolve
# the package installed by this npm invocation and run its exact entrypoint.
global_modules="$(npm root --global)" || fail 'Could not resolve the installed npm package root.'
installed_cli="$global_modules/autoprompt-skill/bin/autoprompt.cjs"
[[ -f "$installed_cli" ]] || fail "Installed Autoprompt entrypoint is missing: $installed_cli"
installed_version="$(node "$installed_cli" version)" || fail 'The newly installed Autoprompt entrypoint failed.'
printf 'Installed Autoprompt skill %s.\n' "$installed_version"
if [[ "${AUTOPROMPT_NO_LAUNCH:-0}" != '1' && -t 0 && -t 1 ]]; then
  exec node "$installed_cli"
fi
printf 'Open this provider installer with: node %q\n' "$installed_cli"

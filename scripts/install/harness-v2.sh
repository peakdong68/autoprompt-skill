#!/usr/bin/env bash
# Private v2 package routing shared by the public POSIX entrypoints.
is_harness_v2() {
  case "$1" in claude|opencode|kilo|vscode|prime|omp|deepseek) return 0 ;; *) return 1 ;; esac
}
harness_v2_root() {
  node -e 'process.stdout.write(require(process.argv[1]).resolveRoot(process.argv[2]))' \
    "$REPO_ROOT/scripts/harness-v2-package.cjs" "$1"
}
install_harness_v2_lifecycle() {
  local client="$1" destination
  if ! destination="$(harness_v2_root "$client")"; then
    RESULT_ROWS+=("RESULT=FAIL client=$client stage=root"); ANY_FAIL=1; return 1
  fi
  if node "$REPO_ROOT/scripts/harness-v2-package.cjs" install "$client" --root "$destination"; then
    RESULT_ROWS+=("RESULT=PASS client=$client dest=$destination format=private-v2")
  else
    RESULT_ROWS+=("RESULT=FAIL client=$client stage=lifecycle"); ANY_FAIL=1; return 1
  fi
}
uninstall_harness_v2_lifecycle() {
  local client="$1" destination
  if ! destination="$(harness_v2_root "$client")"; then
    RESULT_ROWS+=("RESULT=FAIL client=$client code=1"); UNINSTALL_EXIT_CODE=1; return 1
  fi
  if node "$REPO_ROOT/scripts/harness-v2-package.cjs" uninstall "$client" --root "$destination"; then
    RESULT_ROWS+=("RESULT=OK client=$client removed=private-v2")
  else
    RESULT_ROWS+=("RESULT=FAIL client=$client code=1"); UNINSTALL_EXIT_CODE=1; return 1
  fi
}
probe_harness_v2() {
  local client="$1" root detected=no installed=no verifies=no version=- reason=not-installed extras=missing det
  if ! root="$(harness_v2_root "$client")"; then
    printf 'no no no version=- reason=invalid-root extras=missing'; return 0
  fi
  if det="$(detect_client "$client" 2>/dev/null)"; then detected=yes; version="${det##*version=}"; fi
  if [ -e "$root/.autoprompt-$client-v2.json" ] || [ -L "$root/.autoprompt-$client-v2.json" ]; then
    installed=yes
    if node "$REPO_ROOT/scripts/harness-v2-package.cjs" doctor "$client" --root "$root" >/dev/null 2>&1; then verifies=yes; reason=-; extras=complete
    else reason=payload-invalid; fi
  fi
  printf '%s %s %s version=%s reason=%s extras=%s activation=attestation-required' "$detected" "$installed" "$verifies" "$version" "$reason" "$extras"
}

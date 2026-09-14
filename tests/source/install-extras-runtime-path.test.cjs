#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')

const { resolveBash: findBash } = require('../helpers/resolve-bash.cjs')

test('POSIX payload staging returns a private physical directory with an aliased TMPDIR', {
  skip: process.platform === 'win32',
}, t => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-stage-path-')))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const physical = path.join(sandbox, 'physical')
  const alias = path.join(sandbox, 'alias')
  fs.mkdirSync(physical, { mode: 0o700 })
  fs.symlinkSync(physical, alias)
  const completed = childProcess.spawnSync(findBash(), ['-c',
    '. scripts/install/lib/install-lib.sh; _autoprompt_physical_temp_directory'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, TMPDIR: alias },
  })
  assert.equal(completed.status, 0, completed.stderr)
  const stage = completed.stdout
  // BSD mktemp may select Darwin's per-user temporary directory instead of
  // TMPDIR. The created directory must be physical and private in either case.
  t.after(() => {
    try { fs.rmdirSync(stage) } catch (error) { if (error.code !== 'ENOENT') throw error }
  })
  assert.equal(fs.realpathSync(stage), stage)
  assert.equal(fs.lstatSync(stage).isDirectory(), true)
  assert.equal(fs.statSync(stage).mode & 0o777, 0o700)
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true)
})

test('POSIX extras preparation resolves the runtime helper from the repository root', () => {
  const bash = findBash()
  assert.ok(bash, 'bash is required to test install-lib.sh')

  const script = `
set -u
. scripts/install/lib/install-lib.sh
root=''
native=''
tool=''
_extras_prepare_install \
  claude "$(pwd -P)/agents/claude" \
  "$(pwd -P)/.test-home/.claude/skills/autoprompt" '' \
  root native tool
expected="$(pwd -P)/scripts/runtime-payload.cjs"
[ "$tool" = "$expected" ] || {
  printf 'expected=%s actual=%s\\n' "$expected" "$tool" >&2
  exit 1
}
printf '%s\\n' "$tool"
`
  const completed = childProcess.spawnSync(bash, ['-c', script], {
    cwd: ROOT,
    encoding: 'utf8',
  })

  assert.equal(completed.status, 0, completed.stderr)
  assert.match(completed.stdout.replace(/\\/g, '/'), /\/scripts\/runtime-payload\.cjs\s*$/)
})

test('PowerShell extras preparation resolves the runtime helper from the repository root', t => {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  const probe = childProcess.spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], {
    encoding: 'utf8',
  })
  if (probe.status !== 0) {
    t.skip(`${shell} is not available`)
    return
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-extras-path-'))
  try {
    const script = `
$ErrorActionPreference = 'Stop'
. (Join-Path $env:AUTOPROMPT_TEST_ROOT 'scripts/install/lib/install-lib.ps1')
$source = Join-Path $env:AUTOPROMPT_TEST_ROOT 'agents/claude'
$skill = Join-Path $env:AUTOPROMPT_TEST_HOME '.claude/skills/autoprompt'
$context = Get-ExtrasInstallContext -Name 'claude' -SrcDir $source ` +
      `-SkillDest $skill -AgentsDest '' -ConfigRoot $env:AUTOPROMPT_TEST_HOME
if ($context.Code -ne 0) { exit $context.Code }
$expected = [IO.Path]::GetFullPath(
  (Join-Path $env:AUTOPROMPT_TEST_ROOT 'scripts/runtime-payload.cjs')
)
$actual = [IO.Path]::GetFullPath($context.Tool)
if ($actual -cne $expected) {
  [Console]::Error.WriteLine("expected=$expected actual=$actual")
  exit 1
}
[Console]::Out.WriteLine($actual)
`
    const completed = childProcess.spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTOPROMPT_TEST_HOME: temporaryRoot,
          AUTOPROMPT_TEST_ROOT: ROOT,
        },
      },
    )

    assert.equal(completed.status, 0, completed.stderr)
    assert.equal(path.normalize(completed.stdout.trim()), path.join(ROOT, 'scripts', 'runtime-payload.cjs'))
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

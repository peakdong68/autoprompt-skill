'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { resolveBash } = require('../helpers/resolve-bash.cjs')
const bash = resolveBash()
const library = path.resolve(__dirname, '../../scripts/install/lib/install-lib.sh')
const releaseInstaller = path.resolve(__dirname, '../../scripts/release/install.sh')

test('Bash resolver finds per-user Git Bash and never falls back to the Windows WSL stub', () => {
  const expected = 'C:\\Users\\Example User\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
  const options = { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Example User\\AppData\\Local', PATH: 'C:\\Windows\\System32' },
    exists: candidate => candidate === expected, spawnSync: () => ({ status: 0, stdout: 'GNU bash, version 5.2.0' }) }
  assert.equal(resolveBash(options), expected)
  assert.equal(resolveBash({ ...options, exists: () => false }), null)
})

test('Bash resolver refuses old macOS Bash and selects an installed modern Bash', () => {
  assert.equal(resolveBash({ platform: 'darwin', env: { PATH: '/bin' }, exists: () => true,
    spawnSync: candidate => ({ status: 0, stdout: `GNU bash, version ${candidate === '/usr/local/bin/bash' ? '5.2' : '3.2'}` }) }), '/usr/local/bin/bash')
})

test('POSIX installer resolves Python 3 without a bare python and supports a spaced override', {
  skip: !bash || process.platform === 'win32',
}, t => {
  const interpreter = cp.spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(interpreter.status, 0)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt python resolver '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.symlinkSync(interpreter.stdout.trim(), path.join(root, 'python3'))
  const spaced = path.join(root, 'custom python 3')
  fs.symlinkSync(interpreter.stdout.trim(), spaced)
  const script = 'source "$1"; python -c "import sys; print(sys.version_info.major)"; python -c "print(42)"'
  for (const override of [undefined, spaced]) {
    const env = { ...process.env, PATH: root }
    delete env.AUTOPROMPT_PYTHON
    if (override) env.AUTOPROMPT_PYTHON = override
    const result = cp.spawnSync(bash, ['-c', script, 'resolver-test', library], { env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '3\n42\n')
  }
  const invalid = cp.spawnSync(bash, ['-c', 'source "$1"; python -c "print(42)"', 'resolver-test', library],
    { env: { ...process.env, PATH: root, AUTOPROMPT_PYTHON: path.join(root, 'missing') }, encoding: 'utf8', timeout: 10000 })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /requires Python 3/)
})

test('release installer uses the newly installed CLI despite an older competing PATH command', {
  skip: !bash || process.platform === 'win32',
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt release python3 '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin'), modules = path.join(root, 'new prefix', 'lib', 'node_modules')
  const cli = path.join(modules, 'autoprompt-skill', 'bin', 'autoprompt.cjs')
  const staleMarker = path.join(root, 'stale-called')
  fs.mkdirSync(bin)
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, "console.log('2.0.0-fresh-fixture')\n")
  const writeExecutable = (name, source) => fs.writeFileSync(path.join(bin, name), `#!${bash}\n${source}\n`, { mode: 0o755 })
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  writeExecutable('npm', 'if [ "$1" = root ]; then printf "%s\\n" "$AUTOPROMPT_TEST_GLOBAL_MODULES"; fi')
  writeExecutable('python3', 'exit 0')
  writeExecutable('autoprompt', 'printf stale > "$AUTOPROMPT_TEST_STALE_MARKER"; printf "0.0.1-stale\\n"')
  const result = cp.spawnSync(bash, [releaseInstaller], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, AUTOPROMPT_NO_LAUNCH: '1',
      AUTOPROMPT_TEST_GLOBAL_MODULES: modules, AUTOPROMPT_TEST_STALE_MARKER: staleMarker },
    encoding: 'utf8', timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Installed Autoprompt skill 2\.0\.0-fresh-fixture/)
  assert.equal(fs.existsSync(staleMarker), false, 'the old PATH command must never be used')
})

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const hasPowerShell = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0
const psLiteral = value => `'${value.replaceAll("'", "''")}'`
test('PowerShell release installer uses the newly installed CLI despite a competing command', {
  skip: !hasPowerShell,
}, t => {
  const python = cp.spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-c', 'import sys, yaml; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(python.status, 0, python.stderr)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt release powershell '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const modules = path.join(root, 'new prefix', 'node_modules')
  const cli = path.join(modules, 'autoprompt-skill', 'bin', 'autoprompt.cjs')
  const staleMarker = path.join(root, 'stale-called')
  fs.mkdirSync(path.dirname(cli), { recursive: true })
  fs.writeFileSync(cli, "console.log('2.0.0-fresh-fixture')\n")
  const script = [
    `function global:npm { $global:LASTEXITCODE=0; if ($args[0] -eq 'root') { ${psLiteral(modules)} } }`,
    `function global:autoprompt { Set-Content -LiteralPath ${psLiteral(staleMarker)} -Value stale; '0.0.1-stale' }`,
    `& ${psLiteral(path.resolve(__dirname, '../../scripts/release/install.ps1'))} -NoLaunch`,
  ].join('\n')
  const result = cp.spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
      AUTOPROMPT_PYTHON: python.stdout.trim() }, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Installed Autoprompt skill 2\.0\.0-fresh-fixture/)
  assert.equal(fs.existsSync(staleMarker), false)
})

// Optional real Bash 3.2 execution, not a version-response mock. This checks
// Apple's shell language boundary on Linux; it is not a native macOS claim.
test('release bootstrap reexecutes real Bash 3.2 through a spaced Homebrew prefix', {
  skip: !process.env.AUTOPROMPT_TEST_BASH32 || process.platform !== 'linux',
}, t => {
  const oldBash = process.env.AUTOPROMPT_TEST_BASH32
  const version = cp.spawnSync(oldBash, ['--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  assert.match(version.stdout, /version 3\.2\./)
  const python = cp.spawnSync('python3', ['-c', 'import sys, yaml; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(python.status, 0, python.stderr)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt old bash '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin'), prefix = path.join(root, 'brew prefix')
  const kit = path.join(root, 'release kit'), log = path.join(root, 'npm-arguments')
  for (const directory of [bin, path.join(prefix, 'bin'), kit]) fs.mkdirSync(directory, { recursive: true })
  const executable = (name, source) => fs.writeFileSync(path.join(bin, name), `#!${bash}\n${source}\n`, { mode: 0o755 })
  executable('uname', 'printf "Darwin\\n"')
  executable('brew', 'printf "%s\\n" "$AUTOPROMPT_TEST_BREW_PREFIX"')
  executable('npm', 'if [ "$1" = root ]; then printf "%s\\n" "$AUTOPROMPT_TEST_GLOBAL_MODULES"; else printf "%s\\n" "$@" > "$AUTOPROMPT_TEST_NPM_LOG"; fi')
  fs.symlinkSync(bash, path.join(prefix, 'bin', 'bash'))
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.symlinkSync(python.stdout.trim(), path.join(bin, 'python3'))
  fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'))
  const installer = path.join(kit, 'install.sh'), archive = path.join(kit, 'autoprompt-skill-2.0.0-beta.1.tgz')
  fs.copyFileSync(releaseInstaller, installer)
  fs.writeFileSync(archive, 'archive-selection fixture; npm is a recorder')
  const modules = path.join(root, 'global modules'), cli = path.join(modules, 'autoprompt-skill/bin/autoprompt.cjs')
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, "console.log('2.0.0-fixture')\n")
  const env = { ...process.env, PATH: bin, AUTOPROMPT_NO_LAUNCH: '1',
    AUTOPROMPT_TEST_GLOBAL_MODULES: modules, AUTOPROMPT_TEST_BREW_PREFIX: prefix, AUTOPROMPT_TEST_NPM_LOG: log }
  delete env.AUTOPROMPT_PYTHON
  const result = cp.spawnSync(oldBash, [installer], { env, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
    ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', archive])
  fs.unlinkSync(log)
  const invalid = cp.spawnSync(oldBash, [installer], {
    env: { ...env, AUTOPROMPT_PYTHON: path.join(root, 'missing interpreter') }, encoding: 'utf8', timeout: 15000,
  })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /Python 3\.11/)
  assert.equal(fs.existsSync(log), false, 'invalid explicit interpreter must fail before npm runs')
})

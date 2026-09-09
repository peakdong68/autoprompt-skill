#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const RELEASE_POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const HAS_RELEASE_POWERSHELL = process.platform === 'win32' || childProcess.spawnSync(
  RELEASE_POWERSHELL,
  ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
  { stdio: 'ignore', windowsHide: true },
).status === 0

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

test('generated release notes contain no unsupported numeric benchmark claim', {
  skip: !HAS_RELEASE_POWERSHELL,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-release-notes-'))
  const output = path.join(sandbox, 'release output')
  fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'unrelated-working-directory', version: '9.9.9' }))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const result = childProcess.spawnSync(RELEASE_POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts', 'build-release-assets.ps1'), '-OutputDirectory', output], {
    cwd: sandbox, encoding: 'utf8', timeout: 120000, windowsHide: true,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const version = JSON.parse(read('package.json')).version
  assert.equal(fs.existsSync(path.join(output, `autoprompt-skill-${version}.tgz`)), true)
  assert.equal(fs.existsSync(path.join(output, 'unrelated-working-directory-9.9.9.tgz')), false)
  // Downloaded standalone scripts must select the built version even when
  // npm's latest tag points elsewhere. Exercise the generated files with a
  // recording npm boundary; no registry/global install occurs in this test.
  const bootstrapRoot = path.join(sandbox, 'standalone downloads')
  const modules = path.join(sandbox, 'global modules')
  const installedCli = path.join(modules, 'autoprompt-skill/bin/autoprompt.cjs')
  const npmLog = path.join(sandbox, 'npm-install.json')
  fs.mkdirSync(bootstrapRoot); fs.mkdirSync(path.dirname(installedCli), { recursive: true })
  fs.writeFileSync(installedCli, `console.log(${JSON.stringify(version)})\n`)
  for (const extension of ['sh', 'ps1']) fs.copyFileSync(path.join(output, `autoprompt-install.${extension}`), path.join(bootstrapRoot, `install.${extension}`))
  const psLiteral = value => `'${value.replaceAll("'", "''")}'`
  const python = childProcess.spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys, yaml; print(sys.executable)'], { encoding: 'utf8' })
  assert.equal(python.status, 0, python.stderr)
  const psScript = [
    `function global:npm { $global:LASTEXITCODE=0; if ($args[0] -eq 'root') { ${psLiteral(modules)} } else { ConvertTo-Json -InputObject @($args) -Compress | Set-Content -LiteralPath ${psLiteral(npmLog)} } }`,
    `& ${psLiteral(path.join(bootstrapRoot, 'install.ps1'))} -NoLaunch`,
  ].join('\n')
  const bootstrapEnv = { ...process.env, AUTOPROMPT_PYTHON: python.stdout.trim(), PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` }
  const psRun = childProcess.spawnSync(RELEASE_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', psScript], { env: bootstrapEnv, encoding: 'utf8', timeout: 15000 })
  assert.equal(psRun.status, 0, psRun.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(npmLog, 'utf8').replace(/^\uFEFF/, '')), ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `autoprompt-skill@${version}`])
  if (process.platform !== 'win32') {
    const bin = path.join(sandbox, 'bootstrap bin'); fs.mkdirSync(bin)
    fs.symlinkSync(process.execPath, path.join(bin, 'node'))
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = root ]; then printf "%s\\n" "$AUTOPROMPT_TEST_GLOBAL_MODULES"; else printf "%s\\n" "$@" > "$AUTOPROMPT_TEST_NPM_LOG"; fi\n', { mode: 0o755 })
    const shellRun = childProcess.spawnSync(require('../helpers/resolve-bash.cjs').resolveBash(), [path.join(bootstrapRoot, 'install.sh')], {
      env: { ...bootstrapEnv, PATH: `${bin}:${bootstrapEnv.PATH}`, AUTOPROMPT_NO_LAUNCH: '1', AUTOPROMPT_TEST_GLOBAL_MODULES: modules, AUTOPROMPT_TEST_NPM_LOG: npmLog }, encoding: 'utf8', timeout: 15000,
    })
    assert.equal(shellRun.status, 0, shellRun.stderr)
    assert.deepEqual(fs.readFileSync(npmLog, 'utf8').trim().split('\n'), ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `autoprompt-skill@${version}`])
  }
  const notes = fs.readFileSync(path.join(output, 'RELEASE_NOTES.md'), 'utf8')
  assert.match(notes, /Benchmark claims remain withheld until a preregistered run has complete independently verifiable evidence/)
  assert.doesNotMatch(notes, /45% fewer|29 failures fell to 16|\+14\.61|cuts failures by/i)
})


test('release asset builder preserves unrelated output files before any cleanup', {
  skip: !HAS_RELEASE_POWERSHELL,
}, t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt release preserve '))
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const marker = path.join(output, 'important.txt')
  fs.writeFileSync(marker, 'preserve me')
  const result = childProcess.spawnSync(RELEASE_POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts', 'build-release-assets.ps1'), '-OutputDirectory', output],
    { cwd: os.tmpdir(), encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /unrelated file or directory/)
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve me')
  assert.deepEqual(fs.readdirSync(output), ['important.txt'])
})

test('release asset builder refuses a missing bundled dependency before replacing prior assets', {
  skip: !HAS_RELEASE_POWERSHELL,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-release-bundled-preflight-'))
  const scripts = path.join(root, 'scripts')
  const output = path.join(root, 'release output')
  const prior = path.join(output, 'autoprompt-skill-2.0.0-beta.1.tgz')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(scripts, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts', 'build-release-assets.ps1'), path.join(scripts, 'build-release-assets.ps1'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'autoprompt-skill', version: '2.0.0-beta.1', bundleDependencies: ['yaml'],
  }))
  fs.mkdirSync(output); fs.writeFileSync(prior, 'retain this prior asset')
  const result = childProcess.spawnSync(RELEASE_POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-File', path.join(scripts, 'build-release-assets.ps1'), '-OutputDirectory', output,
  ], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /Bundled dependency yaml is missing from node_modules/)
  assert.equal(fs.readFileSync(prior, 'utf8'), 'retain this prior asset')
})

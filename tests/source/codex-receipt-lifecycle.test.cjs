#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..', '..')
const LIBRARY_PS1 = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.ps1')
const LIBRARY_SH = path.join(ROOT, 'scripts', 'install', 'lib', 'install-lib.sh')
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const BASH = require('../helpers/resolve-bash.cjs').resolveBash()
const HAS_POWERSHELL = childProcess.spawnSync(
  POWERSHELL,
  ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
).status === 0
const HAS_BASH = Boolean(BASH)

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function serializeHashManifest(entries) {
  const rows = entries.map(([file, hash], index) =>
    `    ${JSON.stringify(file)}: ${JSON.stringify(hash)}${index + 1 < entries.length ? ',' : ''}`)
  return `{\n${rows.join('\n')}\n}\n`
}

function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function shellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function bashPath(value) {
  return value.replaceAll('\\', '/').replace(
    /^([A-Za-z]):/,
    (_, drive) => `/${drive.toLowerCase()}`,
  )
}

function createReceiptFixture(prefix, drift = true, fingerprinted = true) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(sandbox, 'codex-root')
  const managed = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const manifest = path.join(root, '.autoprompt-install-hashes.json')
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  const installed = Buffer.from('installed Codex payload\n')
  fs.mkdirSync(path.dirname(managed), { recursive: true })
  fs.writeFileSync(managed, installed)
  fs.writeFileSync(manifest, fingerprinted
    ? `{\n    ${JSON.stringify(managed)}: "${sha256(installed)}"\n}\n`
    : '{\n}\n')
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'receipt-lifecycle-test',
    backup: null,
    files: [managed, manifest],
    createdDirectories: [],
    ompManaged: false,
    ompDetachedRoot: null,
    configEdits: [],
  }, null, 2)}\n`)
  if (drift) fs.appendFileSync(managed, 'user-owned drift\n')
  return { sandbox, root, managed, manifest, receipt }
}

function createCodexBundleReceiptFixture(prefix, manifestIndex, shared = false) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(sandbox, 'codex-root')
  const manifest = path.join(root, '.autoprompt-install-hashes.json')
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  const bundle = path.join(root, '.autoprompt-private', 'bundles',
    'codex-v2.0.0-0123456789abcdef')
  const runtimeManifest = path.join(bundle, 'skills', 'autoprompt', '.autoprompt-runtime-manifest.json')
  const pristine = path.join(bundle, 'scripts', 'local-only-safety.cjs')
  const drifted = path.join(bundle, 'scripts', 'drifted-safety.cjs')
  const other = path.join(root, 'other-provider', 'receipt-owned.txt')
  const owned = new Map([
    [runtimeManifest, Buffer.from('{"runtime":"fixture"}\n')],
    [pristine, Buffer.from('pristine bundle payload\n')],
    [drifted, Buffer.from('original driftable bundle payload\n')],
  ])
  for (const [file, bytes] of owned) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }
  fs.appendFileSync(drifted, 'user-owned drift\n')
  fs.writeFileSync(manifest, serializeHashManifest([...owned].map(([file, bytes]) => [file, sha256(bytes)])))
  const files = [...owned.keys()]
  files.splice(manifestIndex, 0, manifest)
  if (shared) {
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(other, 'other provider owns this receipt entry\n')
    files.push(other)
  }
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'codex-bundle-order-test',
    backup: null,
    files,
    createdDirectories: [],
    ompManaged: false,
    ompDetachedRoot: null,
    configEdits: [],
  }, null, 2)}\n`)
  return { sandbox, root, manifest, receipt, runtimeManifest, pristine, drifted, other }
}

function createUpdateFixture(prefix, transform = value => value) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(sandbox, 'codex-root')
  const current = path.join(root, 'skills', 'autoprompt', 'SKILL.md')
  const retiredClean = path.join(root, 'skills', 'autoprompt', 'obsolete', 'stale.txt')
  const retiredDrift = path.join(root, 'skills', 'autoprompt', 'retired-drift.txt')
  const manifest = path.join(root, '.autoprompt-install-hashes.json')
  const receipt = path.join(root, '.autoprompt-install-receipt.json')
  const bytes = new Map([
    [current, Buffer.from('current generation\n')],
    [retiredClean, Buffer.from('retired clean generation\n')],
    [retiredDrift, Buffer.from('retired drift generation\n')],
  ])
  for (const [file, content] of bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  fs.appendFileSync(retiredDrift, 'user drift survives update\n')
  const files = [...bytes.keys()].map(transform)
  fs.writeFileSync(manifest, serializeHashManifest(
    [...bytes].map(([file, content]) => [transform(file), sha256(content)]),
  ))
  fs.writeFileSync(receipt, `${JSON.stringify({
    nonce: 'receipt-update-test', backup: null, files,
    createdDirectories: [], ompManaged: false, ompDetachedRoot: null, configEdits: [],
  }, null, 2)}\n`)
  return {
    sandbox, root, current, retiredClean, retiredDrift, manifest, receipt,
    owned: files,
  }
}

function assertRelinquished(fixture, completed, expectedRetained) {
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, new RegExp(`retained=${expectedRetained}`))
  assert.equal(fs.existsSync(fixture.managed), expectedRetained === 1)
  if (expectedRetained === 1) {
    assert.match(fs.readFileSync(fixture.managed, 'utf8'), /installed Codex payload/)
    assert.match(completed.stdout, /ownership=relinquished/)
  }
  assert.equal(fs.existsSync(fixture.manifest), false)
  assert.equal(fs.existsSync(fixture.receipt), false)
}

test('PowerShell Codex uninstall preserves drift and relinquishes receipt ownership', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = createReceiptFixture('autoprompt-codex-receipt-ps-')
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const command = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$code = Uninstall-Client -ConfigRoot ${psLiteral(fixture.root)} -Name 'codex'`,
    'exit $code',
  ].join('; ')
  const completed = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', timeout: 30000 })
  assertRelinquished(fixture, completed, 1)
})

test('PowerShell Codex uninstall keeps manifest fingerprints across receipt order and retains only drift', {
  skip: !HAS_POWERSHELL,
}, t => {
  for (const [name, manifestIndex, shared] of [
    ['manifest-first', 0, false],
    ['manifest-middle', 2, false],
    ['shared-provider', 0, true],
  ]) {
    const fixture = createCodexBundleReceiptFixture(`autoprompt-codex-bundle-${name}-`, manifestIndex, shared)
    t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
    const command = [
      `. ${psLiteral(LIBRARY_PS1)}`,
      `$code = Uninstall-Client -ConfigRoot ${psLiteral(fixture.root)} -Name 'codex'`,
      'exit $code',
    ].join('; ')
    const completed = childProcess.spawnSync(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8', timeout: 30000 })
    assert.equal(completed.status, 0, `${name}\n${completed.stdout}\n${completed.stderr}`)
    assert.equal(fs.existsSync(fixture.runtimeManifest), false, `${name}: runtime manifest should be removed`)
    assert.equal(fs.existsSync(fixture.pristine), false, `${name}: pristine bundle byte should be removed`)
    assert.equal(fs.existsSync(fixture.drifted), true, `${name}: drifted bundle byte should be retained`)
    assert.match(fs.readFileSync(fixture.drifted, 'utf8'), /user-owned drift/)
    assert.match(completed.stdout, new RegExp(`uninstall-retained=${fixture.drifted.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} reason=hash-drift ownership=relinquished`))
    assert.doesNotMatch(completed.stdout, /reason=unfingerprinted/)
    assert.equal(fs.existsSync(fixture.manifest), shared, `${name}: global manifest scoped retention differs`)
    assert.equal(fs.existsSync(fixture.receipt), shared, `${name}: receipt scoped retention differs`)
    assert.equal(fs.existsSync(fixture.other), shared, `${name}: other provider file scoped retention differs`)
    if (shared) {
      assert.deepEqual(JSON.parse(fs.readFileSync(fixture.receipt, 'utf8')).files,
        [fixture.other, fixture.manifest])
    }
  }
})

test('PowerShell Codex receipt readers split canonical LF documents and retain strict grammar rejection', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = createReceiptFixture('autoprompt-codex-receipt-grammar-', false)
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const original = new Map([fixture.manifest, fixture.receipt].map(file => [file, fs.readFileSync(file)]))
  const mutations = [
    ['canonical', value => value, true],
    ['crlf', value => value.replaceAll('\n', '\r\n'), false],
    ['missing-final-lf', value => value.slice(0, -1), false],
    ['extra-final-lf', value => value + '\n', false],
    ['nul', value => value.replace('{', '{\0'), false],
    ['interior-blank', value => value.replace('{\n', '{\n\n'), false],
    ['extra-document', value => value + '{}\n', false],
  ]
  for (const [name, mutate, accepted] of mutations) {
    for (const [file, bytes] of original) fs.writeFileSync(file, mutate(bytes.toString('utf8')))
    const before = new Map([...original.keys()].map(file => [file, fs.readFileSync(file)]))
    const command = [
      `. ${psLiteral(LIBRARY_PS1)}`,
      `$root = ${psLiteral(fixture.root)}`,
      "try { $entries = Read-IdemManifestEntries -ConfigRoot $root; $manifestOk = $entries.Count -eq 1 } catch { $manifestOk = $false }",
      '$receiptResult = Read-UninstallReceipt -ConfigRoot $root',
      "$receiptOk = $receiptResult -is [hashtable] -and $receiptResult.Nonce -ceq 'receipt-lifecycle-test'",
      `if ($manifestOk -ne $${accepted} -or $receiptOk -ne $${accepted}) { throw 'unexpected grammar admission: ${name}' }`,
    ].join('; ')
    const completed = childProcess.spawnSync(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
    ], { encoding: 'utf8', timeout: 30000 })
    assert.equal(completed.status, 0, `${name}\n${completed.stdout}\n${completed.stderr}`)
    for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, 'parsing must not rewrite receipt evidence')
    assert.equal(fs.readFileSync(fixture.managed, 'utf8'), 'installed Codex payload\n')
  }
})

test('Git Bash Codex uninstall preserves drift and relinquishes receipt ownership', {
  skip: !HAS_BASH,
}, t => {
  const fixture = createReceiptFixture('autoprompt-codex-receipt-sh-')
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const command = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `uninstall_client ${shellLiteral(bashPath(fixture.root))} codex`,
  ].join('; ')
  const completed = childProcess.spawnSync(BASH, ['-lc', command], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assertRelinquished(fixture, completed, 1)
})

test('Codex uninstall removes pristine receipt-owned bytes in both installer ports', {
  skip: !HAS_POWERSHELL || !HAS_BASH,
}, t => {
  const powershellFixture = createReceiptFixture('autoprompt-codex-pristine-ps-', false)
  const bashFixture = createReceiptFixture('autoprompt-codex-pristine-sh-', false)
  t.after(() => {
    fs.rmSync(powershellFixture.sandbox, { recursive: true, force: true })
    fs.rmSync(bashFixture.sandbox, { recursive: true, force: true })
  })
  const psCommand = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$code = Uninstall-Client -ConfigRoot ${psLiteral(powershellFixture.root)} -Name 'codex'`,
    'exit $code',
  ].join('; ')
  const psCompleted = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
  ], { encoding: 'utf8', timeout: 30000 })
  assertRelinquished(powershellFixture, psCompleted, 0)

  const shCommand = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `uninstall_client ${shellLiteral(bashPath(bashFixture.root))} codex`,
  ].join('; ')
  const shCompleted = childProcess.spawnSync(BASH, ['-lc', shCommand], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assertRelinquished(bashFixture, shCompleted, 0)
})

test('Codex uninstall preserves unfingerprinted receipt bytes in both installer ports', {
  skip: !HAS_POWERSHELL || !HAS_BASH,
}, t => {
  const powershellFixture = createReceiptFixture('autoprompt-codex-unfingerprinted-ps-', false, false)
  const bashFixture = createReceiptFixture('autoprompt-codex-unfingerprinted-sh-', false, false)
  t.after(() => {
    fs.rmSync(powershellFixture.sandbox, { recursive: true, force: true })
    fs.rmSync(bashFixture.sandbox, { recursive: true, force: true })
  })
  const psCommand = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$code = Uninstall-Client -ConfigRoot ${psLiteral(powershellFixture.root)} -Name 'codex'`,
    'exit $code',
  ].join('; ')
  const psCompleted = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand,
  ], { encoding: 'utf8', timeout: 30000 })
  assertRelinquished(powershellFixture, psCompleted, 1)
  assert.match(psCompleted.stdout, /reason=unfingerprinted/)

  const shCommand = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `uninstall_client ${shellLiteral(bashPath(bashFixture.root))} codex`,
  ].join('; ')
  const shCompleted = childProcess.spawnSync(BASH, ['-lc', shCommand], {
    encoding: 'utf8',
    timeout: 30000,
  })
  assertRelinquished(bashFixture, shCompleted, 1)
  assert.match(shCompleted.stdout, /reason=unfingerprinted/)
})

test('PowerShell Codex update reconciliation prunes clean prior-only bytes and relinquishes drift', {
  skip: !HAS_POWERSHELL,
}, t => {
  const fixture = createUpdateFixture('autoprompt-codex-update-ps-')
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const command = [
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$script:AutopromptReceiptFiles = @(${fixture.owned.map(psLiteral).join(', ')})`,
    `$code = Invoke-IdemRetiredCodexReconciliation -ConfigRoot ${psLiteral(fixture.root)} -CurrentTargets @(${psLiteral(fixture.current)})`,
    'Write-Output ("result-code=$code owned=" + ($script:AutopromptReceiptFiles -join "|"))',
    'exit $code',
  ].join('; ')
  const completed = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', timeout: 30000 })
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, /update-pruned=.*obsolete.*stale\.txt reason=prior-only/)
  assert.match(completed.stdout, /update-retained=.*retired-drift\.txt reason=hash-drift ownership=relinquished/)
  assert.match(completed.stdout, /result-code=0 owned=.*SKILL\.md/)
  assert.doesNotMatch(completed.stdout, /owned=.*retired-drift\.txt/)
  assert.equal(fs.existsSync(fixture.retiredClean), false)
  assert.match(fs.readFileSync(fixture.retiredDrift, 'utf8'), /user drift survives update/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fixture.manifest, 'utf8'))), [fixture.current])
})

test('Git Bash Codex update reconciliation prunes clean prior-only bytes and relinquishes drift', {
  skip: !HAS_BASH,
}, t => {
  const fixture = createUpdateFixture('autoprompt-codex-update-sh-', bashPath)
  t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
  const current = bashPath(fixture.current)
  const command = [
    `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
    `AUTOPROMPT_RECEIPT_FILES=(${fixture.owned.map(shellLiteral).join(' ')})`,
    `current_targets=(${shellLiteral(current)})`,
    `_idem_reconcile_retired_codex_files ${shellLiteral(bashPath(fixture.root))} current_targets`,
    'code=$?',
    'printf "result-code=%s owned=%s\\n" "$code" "${AUTOPROMPT_RECEIPT_FILES[*]}"',
    'exit "$code"',
  ].join('; ')
  const completed = childProcess.spawnSync(BASH, ['-lc', command], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}`)
  assert.match(completed.stdout, /update-pruned=.*obsolete.*stale\.txt reason=prior-only/)
  assert.match(completed.stdout, /update-retained=.*retired-drift\.txt reason=hash-drift ownership=relinquished/)
  assert.match(completed.stdout, /result-code=0 owned=.*SKILL\.md/)
  assert.doesNotMatch(completed.stdout, /owned=.*retired-drift\.txt/)
  assert.equal(fs.existsSync(fixture.retiredClean), false)
  assert.match(fs.readFileSync(fixture.retiredDrift, 'utf8'), /user drift survives update/)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fixture.manifest, 'utf8'))), [current])
})

test('Codex receipt writers embed prior-manifest and per-file hashes accepted by strict parsers', {
  skip: !HAS_POWERSHELL || !HAS_BASH,
}, t => {
  const priorDigest = 'a'.repeat(64)
  for (const port of ['powershell', 'bash']) {
    const fixture = createReceiptFixture(`autoprompt-codex-bound-receipt-${port}-`, false)
    t.after(() => fs.rmSync(fixture.sandbox, { recursive: true, force: true }))
    const completed = port === 'powershell'
      ? childProcess.spawnSync(POWERSHELL, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', [
            `. ${psLiteral(LIBRARY_PS1)}`,
            `$script:AutopromptReceiptPriorManifestSha256 = '${priorDigest}'`,
            `$code = Write-Receipt -ConfigRoot ${psLiteral(fixture.root)} -Nonce bound -Files @(${psLiteral(fixture.managed)},${psLiteral(fixture.manifest)})`,
            'if ($code -ne 0) { exit $code }',
            `$code = Uninstall-Client -ConfigRoot ${psLiteral(fixture.root)} -Name codex`,
            'exit $code',
          ].join('; '),
        ], { encoding: 'utf8', timeout: 30000 })
      : childProcess.spawnSync(BASH, ['-lc', [
          `source ${shellLiteral(bashPath(LIBRARY_SH))}`,
          `AUTOPROMPT_RECEIPT_FILES=(${shellLiteral(bashPath(fixture.managed))} ${shellLiteral(bashPath(fixture.manifest))})`,
          `AUTOPROMPT_RECEIPT_PRIOR_MANIFEST_SHA256=${priorDigest}`,
          `write_receipt ${shellLiteral(bashPath(fixture.root))} bound none >/dev/null`,
          `uninstall_client ${shellLiteral(bashPath(fixture.root))} codex`,
        ].join('; ')], { encoding: 'utf8', timeout: 30000 })
    assert.equal(completed.status, 0, `${port}\n${completed.stdout}\n${completed.stderr}`)
    assert.equal(fs.existsSync(fixture.receipt), false)
  }
})

test('PowerShell receipt writer reads one strict manifest for many files and retains malformed-manifest refusal', {
  skip: !HAS_POWERSHELL,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-receipt-index-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const root = path.join(sandbox, 'root')
  const files = Array.from({ length: 80 }, (_, index) => path.join(root, 'skills', `file-${index}.txt`))
  const badManifest = `{\n    "dup": "${'a'.repeat(64)}",\n    "dup": "${'b'.repeat(64)}"\n}\n`
  for (const [index, file] of files.entries()) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `payload ${index}\n`) }
  const manifest = path.join(root, '.autoprompt-install-hashes.json')
  fs.writeFileSync(manifest, serializeHashManifest(files.map(file => [file, sha256(fs.readFileSync(file))])))
  const psFiles = files.map((file, index) => index % 2 ? psLiteral(path.relative(root, file)) : psLiteral(file)).join(',')
  const expectedHashes = files.map((file, index) => `${index % 2 ? path.relative(root, file) : file}=${sha256(fs.readFileSync(file))}`)
  const command = [
    '$ErrorActionPreference = "Stop"',
    `. ${psLiteral(LIBRARY_PS1)}`,
    '$script:manifestReads = 0; $script:originalManifestReader = (Get-Command Read-IdemManifestEntries -CommandType Function).ScriptBlock',
    'function Read-IdemManifestEntries { param([string]$ConfigRoot) $script:manifestReads++; & $script:originalManifestReader @PSBoundParameters }',
    `$files = @(${psFiles})`,
    `$code = Write-Receipt -ConfigRoot ${psLiteral(root)} -Nonce indexed -Files $files; if ($code -ne 0) { exit $code }`,
    'if ($script:manifestReads -ne 1) { throw "manifest reads=$script:manifestReads" }',
    `$receipt = Get-Content -LiteralPath ${psLiteral(path.join(root, '.autoprompt-install-receipt.json'))} -Raw | ConvertFrom-Json`,
    `$expected = @(${expectedHashes.map(psLiteral).join(',')})`,
    'if (@($receipt.fileSha256).Count -ne $expected.Count) { throw "receipt hash count differs" }; for ($i = 0; $i -lt $expected.Count; $i++) { if ([string]$receipt.fileSha256[$i] -cne [string]$expected[$i]) { throw "receipt hash differs at index $i" } }',
    `$before = [IO.File]::ReadAllBytes(${psLiteral(path.join(root, '.autoprompt-install-receipt.json'))})`,
    `$bad = ${psLiteral(badManifest)}`,
    `[IO.File]::WriteAllText(${psLiteral(manifest)}, $bad, (New-Object Text.UTF8Encoding($false)))`,
    'try { Write-Receipt -ConfigRoot ' + psLiteral(root) + ' -Nonce malformed -Files $files | Out-Null; throw "accepted malformed manifest" } catch { if ($_.Exception.Message -eq "accepted malformed manifest") { throw } }',
    `$after = [IO.File]::ReadAllBytes(${psLiteral(path.join(root, '.autoprompt-install-receipt.json'))}); if ([Convert]::ToBase64String($before) -cne [Convert]::ToBase64String($after)) { throw 'receipt changed after malformed manifest' }`,
  ].join('; ')
  const result = childProcess.spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('PowerShell receipt arrays normalize each candidate once while retaining duplicate rules', {
  skip: !HAS_POWERSHELL,
}, t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-receipt-array-index-'))
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
  const values = Array.from({ length: 80 }, (_, index) => path.join(sandbox, 'files', `entry-${index}.txt`))
  const psArray = (member, entries) => [
    `  "${member}": [`,
    ...entries.map((entry, index) => `    ${JSON.stringify(entry)}${index + 1 < entries.length ? ',' : ''}`),
    '  ],',
  ].map(psLiteral).join(',')
  const canonical = path.join(sandbox, 'files', 'identity.txt')
  const alternate = `${path.dirname(canonical)}${path.sep}nested${path.sep}..${path.sep}${path.basename(canonical)}`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `. ${psLiteral(LIBRARY_PS1)}`,
    `$values = @(${psArray('files', values)})`,
    '$script:normalizations = 0; $script:realNormalizer = (Get-Command Get-IdemNormalizedPath -CommandType Function).ScriptBlock',
    'function Get-IdemNormalizedPath { param([string]$Path) $script:normalizations++; & $script:realNormalizer @PSBoundParameters }',
    "$parsed = Read-ReceiptStringArray -Lines $values -Index 0 -Member 'files' -Suffix ','",
    `if ($parsed.Values.Count -ne ${values.length} -or $script:normalizations -ne ${values.length}) { throw "linear normalization failed count=$($script:normalizations)" }`,
    `$identity = @(${psArray('files', [canonical, alternate])})`,
    "$identityFailure = ''; try { Read-ReceiptStringArray -Lines $identity -Index 0 -Member 'files' -Suffix ',' | Out-Null } catch { $identityFailure = $_.Exception.Message }; if ($identityFailure -cne 'duplicate receipt path identity') { throw \"identity duplicate result=$identityFailure\" }",
    `$exact = @(${psArray('files', ['', ''])})`,
    "$exactFailure = ''; try { Read-ReceiptStringArray -Lines $exact -Index 0 -Member 'files' -Suffix ',' | Out-Null } catch { $exactFailure = $_.Exception.Message }; if ($exactFailure -cne 'duplicate receipt path spelling') { throw \"exact duplicate result=$exactFailure\" }",
    `$hashBindings = @(${psArray('fileSha256', [`${canonical}=${'a'.repeat(64)}`, `${canonical}=${'b'.repeat(64)}`])})`,
    "$hashParsed = Read-ReceiptStringArray -Lines $hashBindings -Index 0 -Member 'fileSha256' -Suffix ','",
    "if ($hashParsed.Values.Count -ne 2) { throw 'fileSha256 values were reinterpreted' }",
  ].join('; ')
  const result = childProcess.spawnSync(POWERSHELL, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

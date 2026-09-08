'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const diagnostic = require('../../scripts/harness-v2-conformance.cjs')
const native = require('../../scripts/harness-v2-native.cjs')

function summary(overrides = {}) {
  return { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides }
}
function tap(cases, totals = summary({ tests: cases.length, pass: cases.length })) {
  return ['TAP version 13', ...cases.map((name, index) => `ok ${index + 1} - ${name}`),
    ...Object.entries(totals).map(([key, value]) => `# ${key} ${value}`), ''].join('\n')
}

test('native diagnostic selects only registered actual-binary suites and exact case names', () => {
  assert.deepEqual(Object.keys(diagnostic.NATIVE_SUITES).sort(), ['claude', 'deepseek', 'kilo', 'omp', 'opencode', 'prime', 'reasonix', 'vscode'])
  for (const provider of Object.keys(diagnostic.PROVIDERS)) {
    const plan = diagnostic.nativeTestPlan(provider)
    if (!Object.hasOwn(diagnostic.NATIVE_SUITES, provider)) { assert.equal(plan, null); continue }
    assert.ok(fs.existsSync(plan.file))
    assert.ok(plan.argv.includes('--test-reporter=tap'))
    assert.equal(plan.executableEnvironmentKey, `AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`)
    const pattern = new RegExp(plan.argv[plan.argv.indexOf('--test-name-pattern') + 1])
    for (const name of plan.cases) {
      assert.equal(pattern.test(name), true)
      assert.equal(pattern.test(`unrelated ${name}`), false)
      assert.equal(pattern.test(`${name} extra`), false)
    }
    if (provider !== 'reasonix') for (const other of ['claude', 'opencode', 'kilo'].filter(id => id !== provider)) {
      assert.equal(pattern.test(diagnostic.NATIVE_SUITES[other].cases[0]), false)
    }
  }
  assert.equal(diagnostic.nativeTestPlan('__proto__'), null)
  assert.equal(diagnostic.nativeTestPlan('constructor'), null)
})

test('native diagnostic completion requires observed named passes, not just success totals', () => {
  const names = diagnostic.NATIVE_SUITES.claude.cases
  const good = diagnostic.selectedCaseSummary(tap(names), names)
  assert.equal(diagnostic.suiteCompleted({ ok: true }, summary(), good), true)
  // Older Node versions may count the two unselected provider cases as skipped.
  assert.equal(diagnostic.suiteCompleted({ ok: true }, summary({ tests: 3, skipped: 2 }), good), true)
  for (const text of [tap([]), tap(['an unrelated passing test']),
    tap(names).replace(' - ', ' - unrelated '),
    tap(names).replace(names[0], `${names[0]} # SKIP no selected native binary`),
    tap(names).replace(names[0], `${names[0]} # TODO not implemented`),
    tap(names).replace('ok 1', 'not ok 1'),
    `${tap(names)}ok 2 - ${names[0]}\n`]) {
    assert.equal(diagnostic.suiteCompleted({ ok: true }, summary(), diagnostic.selectedCaseSummary(text, names)), false)
  }
  for (const counts of [summary({ tests: 0, pass: 0 }), summary({ pass: 2 }), summary({ fail: 1 }),
    summary({ cancelled: 1 }), summary({ skipped: -1 }), summary({ todo: 1 }), { tests: 1, pass: 1 }]) {
    assert.equal(diagnostic.suiteCompleted({ ok: true }, counts, good), false)
  }
  assert.equal(diagnostic.suiteCompleted({ ok: false }, summary(), good), false)
})

test('TAP case matching treats punctuation literally and rejects duplicate observations', () => {
  const names = ['native [file].read (exact) + session?']
  assert.deepEqual(diagnostic.selectedCaseSummary(tap(names), names), [{ name: names[0], status: 'passed' }])
  assert.equal(diagnostic.selectedCaseSummary(`ok 1 - ${names[0]}\nok 2 - ${names[0]}\n`, names)[0].status, 'ambiguous')
})

for (const provider of ['claude', 'opencode', 'kilo', 'prime', 'omp', 'deepseek', 'vscode']) {
  test(`${provider} diagnostic launches its native suite with an isolated selected executable`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `harness-diagnostic-${provider}-`))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const calls = []
    const selectedExecutable = path.join(root, 'diagnostic-fixture')
    fs.writeFileSync(selectedExecutable, 'injected diagnostic process fixture', { mode: 0o700 })
    const report = diagnostic.run({ providers: [provider], executables: { [provider]: selectedExecutable },
      env: { PATH: process.env.PATH, OPENAI_API_KEY: 'must-not-reach-test', NODE_OPTIONS: '--require untrusted' },
      output: path.join(root, 'evidence'), nativeTests: true,
      // Inject only process results to test diagnostic routing. This is not a
      // substitute for the actual-binary suites registered above.
      spawnSync(executable, argv, options) {
        calls.push({ executable, argv, options })
        if (argv[0] === '--version') return { status: 0, stdout: `${provider} 9.9.9\n` }
        if (argv.includes('--help')) return { status: 0, stdout: native.descriptor(provider).flags.join(' ') }
        assert.equal(argv[0], '--test')
        return { status: 0, stdout: tap(diagnostic.NATIVE_SUITES[provider].cases) }
      } })
    const selected = report.providers[0]
    assert.equal(selected.nativeTests.status, 'supported')
    assert.equal(report.evidenceKind, 'injected-process-tests')
    assert.equal(selected.liveModelConformance.status, 'not-tested')
    assert.equal(report.admissionGranted, false)
    assert.equal(selected.admissionGranted, false)
    assert.ok(Object.values(selected.capabilities).every(item => item.status === 'unknown'))
    const executed = calls.filter(call => call.argv[0] === '--test')
    assert.equal(executed.length, 1)
    assert.equal(executed[0].executable, process.execPath)
    assert.equal(executed[0].options.shell, false)
    const env = executed[0].options.env
    assert.equal(env[`AUTOPROMPT_${provider.toUpperCase()}_TEST_CLI`], selectedExecutable)
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.ok(env.AUTOPROMPT_NATIVE_TEST_EVIDENCE_ROOT.startsWith(path.join(root, 'evidence', provider)))
    for (const other of ['claude', 'opencode', 'kilo'].filter(id => id !== provider)) {
      assert.equal(env[`AUTOPROMPT_${other.toUpperCase()}_TEST_CLI`], undefined)
    }
  })
}

for (const change of ['replacement', 'removal']) {
  test(`native diagnostic rejects executable ${change} during the selected tests`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-diagnostic-binding-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const executable = path.join(root, 'fixture')
    fs.writeFileSync(executable, 'original executable fixture', { mode: 0o700 })
    const report = diagnostic.run({ providers: ['claude'], executables: { claude: executable },
      output: path.join(root, 'evidence'), nativeTests: true,
      spawnSync(file, argv) {
        if (argv[0] === '--version') return { status: 0, stdout: 'claude 2.1.263\n' }
        if (argv.includes('--help')) return { status: 0, stdout: native.descriptor('claude').flags.join(' ') }
        assert.equal(argv[0], '--test')
        if (change === 'replacement') fs.writeFileSync(executable, 'changed executable fixture')
        else fs.unlinkSync(executable)
        return { status: 0, stdout: tap(diagnostic.NATIVE_SUITES.claude.cases) }
      } })
    assert.equal(report.providers[0].executable.status, 'unsupported')
    assert.equal(report.providers[0].nativeTests.status, 'unknown')
    assert.equal(report.admissionGranted, false)
  })
}

test('harness discovery includes this diagnostic regression suite exactly once', () => {
  const files = require('../../scripts/run-harness-v2-source-tests.cjs').discoverTests()
  assert.equal(files.filter(file => path.resolve(file) === __filename).length, 1)
})

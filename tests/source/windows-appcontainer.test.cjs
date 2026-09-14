'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateLaunch, parseResult, createWindowsAppContainerLauncher } = require('../../agents/codex/workflow/windows-appcontainer.js')
const launch = () => ({ profileName: 'Autoprompt_' + 'a'.repeat(32), profileSid: 'S-1-15-2-1-2-3-4-5-6-7', executable: 'C:\\runtime\\node.exe', executableSha256: 'b'.repeat(64),
  arguments: ['--preserve-symlinks', '--preserve-symlinks-main', 'C:\\runtime\\entry.cjs'], cwd: 'C:\\task', environment: ['SystemRoot=C:\\Windows'], timeoutMs: 1000, outputLimit: 1024, cancellationPath: 'C:\\controller\\cancel' })
const result = () => ({ schemaVersion: 1, status: 'COMPLETED', result: { RootPid: 12, ExitCode: 0, ObservedJobMembers: 2, LauncherSessionId: 1, AppContainerSid: launch().profileSid,
  StdoutBase64: Buffer.from('done').toString('base64'), StderrBase64: '', RootImageMatches: true, Drained: true, TimedOut: false, OutputLimit: false, Cancelled: false } })
test('AppContainer launch requires bounded controller identity and explicit executable binding', () => {
  assert.equal(validateLaunch(launch()).schemaVersion, 1)
  for (const value of [{ ...launch(), profileName: 'arbitrary' }, { ...launch(), executableSha256: '' }, { ...launch(), timeoutMs: 300001 }, { ...launch(), outputLimit: 1048577 }, { ...launch(), arguments: ['x\0y'] }, { ...launch(), callerHandles: [] }]) assert.throws(() => validateLaunch(value), { code: 'WINDOWS_LAUNCH_INVALID' })
})
test('AppContainer result cannot claim completion without exact SID, image and process drain', () => {
  const parsed = parseResult(JSON.stringify(result()), launch())
  assert.equal(parsed.drained, true); assert.equal(parsed.stdout.toString(), 'done')
  for (const changes of [{ Drained: false }, { RootImageMatches: false }, { AppContainerSid: 'S-1-15-2-7-6-5-4-3-2-1' }, { RootPid: 0 }, { ObservedJobMembers: 1025 }, { ExitCode: -1 }]) {
    const wire = result(); Object.assign(wire.result, changes)
    assert.throws(() => parseResult(JSON.stringify(wire), launch()), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  }
})
test('AppContainer output remains canonical and bounded after native execution', () => {
  for (const output of ['ZA', '!invalid!', Buffer.alloc(1025).toString('base64')]) {
    const wire = result(); wire.result.StdoutBase64 = output
    assert.throws(() => parseResult(JSON.stringify(wire), launch()), { code: 'WINDOWS_LAUNCH_PROTOCOL' })
  }
  assert.throws(() => parseResult(JSON.stringify({ schemaVersion: 1, status: 'REFUSED', code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' }), launch()), { code: 'APPCONTAINER_CLEANUP_UNCONFIRMED' })
})
test('AppContainer runtime is never advertised on other operating systems', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => createWindowsAppContainerLauncher(), { code: 'COMMAND_SANDBOX_UNSUPPORTED' })
})

'use strict'
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { awaitActivationChild } = require('../../scripts/codex-configure.cjs')
const { runSignalOwnedSupervisor } = require('../../agents/codex/workflow/phase-budget.js')
const { ProcessOwner, createPosixProcessAdapter, prepareProcessLaunchEnvironment } = require('../../agents/codex/workflow/process-owner.js')

test('Codex launcher forwards repeated termination and waits for actual supervisor drain', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', `let closing=false;process.on('SIGTERM',()=>{if(closing)return;closing=true;setTimeout(()=>{process.stdout.write('drained\\n');process.exit(0)},150)});process.stdout.write('ready\\n');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const signals = new EventEmitter()
  const done = awaitActivationChild(child, signals)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  try {
    await once(child.stdout, 'data')
    signals.emit('SIGTERM');signals.emit('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 35))
    signals.emit('SIGTERM')
    assert.equal(child.exitCode, null)
    assert.deepEqual(await done, { status: 0, signal: null })
    assert.match(output, /drained/)
    assert.equal(signals.listenerCount('SIGTERM'), 0)
    assert.equal(signals.listenerCount('SIGINT'), 0)
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
})

test('Codex supervisor keeps cancellation owned until asynchronous usage drain completes', async () => {
  const signals = new EventEmitter()
  let endStart, finishDrain, cancellations = 0, usage = 0
  const started = new Promise(resolve => { endStart = resolve })
  const drained = new Promise(resolve => { finishDrain = resolve })
  const runtime = {
    start: () => started,
    cancel: async () => { cancellations++; endStart({ outcome: 'FAILED' }); await drained; usage += 7; return { outcome: 'CANCELLED' } },
  }
  let settled = false
  const done = runSignalOwnedSupervisor(runtime, signals).then(value => { settled = true; return value })
  signals.emit('SIGTERM');signals.emit('SIGTERM')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(signals.listenerCount('SIGTERM'), 1)
  signals.emit('SIGINT')
  finishDrain()
  assert.deepEqual(await done, { outcome: 'CANCELLED' })
  assert.equal(cancellations, 1)
  assert.equal(usage, 7)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('Codex supervisor hard activation expiry cancels a held start independently of mission time', {
  timeout: 5000,
}, async () => {
  const signals = new EventEmitter()
  let started = false
  let cancelReason = null
  const runtime = {
    options: { activationExpiresAt: new Date(Date.now() + 40).toISOString() },
    start: async () => {
      started = true
      return new Promise(() => {})
    },
    cancel: async reason => {
      cancelReason = reason
      return { outcome: 'CANCELLED', reason, processTreeDrained: true }
    },
  }
  const result = await runSignalOwnedSupervisor(runtime, signals)
  assert.equal(started, true)
  assert.deepEqual(result, {
    outcome: 'CANCELLED',
    reason: 'activation authorization expired',
    processTreeDrained: true,
  })
  assert.equal(cancelReason, 'activation authorization expired')
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('Codex supervisor never starts work after an already expired activation', async () => {
  const signals = new EventEmitter()
  let starts = 0
  const runtime = {
    options: { activationExpiresAt: new Date(Date.now() - 1000).toISOString() },
    start: async () => { starts += 1; return { outcome: 'DONE' } },
    cancel: async reason => ({ outcome: 'CANCELLED', reason }),
  }
  const result = await runSignalOwnedSupervisor(runtime, signals)
  assert.equal(starts, 0)
  assert.deepEqual(result, { outcome: 'CANCELLED', reason: 'activation authorization expired' })
})

test('signal-owned supervisor settles from cancellation after a native request stops without reporting completion', {
  skip: process.platform === 'win32', timeout: 10000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoprompt-signal-owned-native-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const marker = path.join(directory, 'native-ready')
  const adapter = createPosixProcessAdapter()
  const owner = new ProcessOwner({
    adapter,
    registryPath: path.join(directory, 'processes.json'),
    pollMs: 10,
    controlBinding: { activationId: 'signal-owned-native', generationId: 1 },
  })
  const signals = new EventEmitter()
  let announceStart
  const entered = new Promise(resolve => { announceStart = resolve })
  const reservationId = 'signal-owned-native:generation:1:DIRECT:hung-request'
  const runtime = {
    async start() {
      await owner.launch({
        executable: process.execPath,
        argv: ['-e', `const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`, marker],
        cwd: directory,
        env: prepareProcessLaunchEnvironment(adapter, reservationId, process.env),
        reservationId,
        sessionId: 'hung-request',
        targetKey: 'target',
        stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', forWork: true,
      })
      while (!fs.existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 10))
      announceStart()
      return new Promise(() => {})
    },
    async cancel() {
      await owner.assertDrained()
      return { outcome: 'CANCELLED', processTreeDrained: true }
    },
  }
  const done = runSignalOwnedSupervisor(runtime, signals)
  await entered
  signals.emit('SIGTERM')
  assert.deepEqual(await done, { outcome: 'CANCELLED', processTreeDrained: true })
  assert.deepEqual(owner.ownershipIdentities(), [])
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

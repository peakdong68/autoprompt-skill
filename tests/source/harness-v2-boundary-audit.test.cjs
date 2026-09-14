'use strict'

// Actual filesystem and Node tool-server tests. No AI CLI or model service runs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const test = require('node:test')
const boundary = require('../../scripts/harness-v2-tool-boundary.cjs')

function fixture(t, readOnly = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-boundary-audit-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'target'), scratch = path.join(root, 'scratch'), control = path.join(root, 'control')
  for (const dir of [target, scratch, control]) fs.mkdirSync(dir, { mode: 0o700 })
  const policy = { schemaVersion: 1, provider: 'claude', activationId: 'audit-activation', sessionId: 'audit-child',
    reservationId: 'audit-reservation', readOnly, targetPath: target, scratchPath: scratch,
    readableRoots: [target, scratch], writableRoots: [readOnly ? scratch : target], nestedDispatch: false,
    commandBoundary: true, externalWrites: false }
  return { root, target, scratch, control, policy }
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const denied = code => ({ code })

for (const readOnly of [false, true]) {
  test(`${readOnly ? 'checker' : 'worker'} actual tools preserve exact text, read ranges and literal search`, async t => {
    const f = fixture(t, readOnly)
    const file = path.join(readOnly ? f.scratch : f.target, 'text.txt')
    const text = 'first\nUnicode 雪 and literal .*\nlast\n'
    const written = await boundary.executeTool(f.policy, 'write', { path: file, content: text })
    assert.equal(written.status, 'completed'); assert.equal(fs.readFileSync(file, 'utf8'), text)
    const result = await boundary.executeTool(f.policy, 'read', { path: file, startLine: 2, lineCount: 1 })
    assert.equal(result.output, 'Unicode 雪 and literal .*')
    assert.equal(result.outputSha256, boundary.sha256(result.output))
    const searched = await boundary.executeTool(f.policy, 'search', { path: path.dirname(file), text: '.*' })
    assert.deepEqual(JSON.parse(searched.output).map(match => [match.line, match.text]), [[2, 'Unicode 雪 and literal .*']])
    await boundary.executeTool(f.policy, 'edit', { path: file, oldText: 'Unicode 雪', newText: 'Revised 雪' })
    assert.equal(fs.readFileSync(file, 'utf8'), text.replace('Unicode 雪', 'Revised 雪'))
    assert.ok((await boundary.executeTool(f.policy, 'list', { path: path.dirname(file) })).output.includes('text.txt'))
  })
}

test('checker denies actual candidate mutation while its disjoint scratch stays usable', async t => {
  const f = fixture(t, true), file = path.join(f.target, 'candidate.txt')
  write(file, 'exact candidate')
  for (const [name, args] of [['write', { path: file, content: 'wrong' }], ['edit', { path: file, oldText: 'exact', newText: 'wrong' }]]) {
    await assert.rejects(boundary.executeTool(f.policy, name, args), denied('TOOL_PATH_DENIED'))
    assert.equal(fs.readFileSync(file, 'utf8'), 'exact candidate')
  }
  assert.throws(() => boundary.validatePolicy({ ...f.policy, writableRoots: [f.target] }), denied('TOOL_POLICY_INVALID'))
  await boundary.executeTool(f.policy, 'write', { path: path.join(f.scratch, 'check.txt'), content: 'checker evidence' })
  assert.equal(fs.readFileSync(path.join(f.scratch, 'check.txt'), 'utf8'), 'checker evidence')
})

test('tool reads and writes reject traversal, adjacent prefixes and controller state', async t => {
  const f = fixture(t), outside = path.join(f.root, 'target-other')
  fs.mkdirSync(outside); write(path.join(outside, 'secret'), 'outside')
  write(path.join(f.control, 'private'), 'controller state')
  for (const file of ['../target-other/secret', path.join(outside, 'secret'), path.join(f.control, 'private')]) {
    await assert.rejects(boundary.executeTool(f.policy, 'read', { path: file }), denied('TOOL_PATH_DENIED'))
    await assert.rejects(boundary.executeTool(f.policy, 'write', { path: file, content: 'changed' }), denied('TOOL_PATH_DENIED'))
  }
  assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'outside')
  assert.equal(fs.readFileSync(path.join(f.control, 'private'), 'utf8'), 'controller state')
  assert.throws(() => boundary.validatePolicy({ ...f.policy, readableRoots: [f.root] }), denied('TOOL_POLICY_INVALID'))
})

test('file tools cannot mutate repository safety metadata', async t => {
  const f = fixture(t), file = path.join(f.target, '.git', 'config')
  write(file, 'owned by controller')
  await assert.rejects(boundary.executeTool(f.policy, 'write', { path: file, content: 'changed' }), denied('TOOL_PATH_DENIED'))
  await assert.rejects(boundary.executeTool(f.policy, 'edit', { path: file, oldText: 'controller', newText: 'worker' }), denied('TOOL_PATH_DENIED'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned by controller')
})

test('linked resources never become a read or write escape', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'), link = path.join(f.target, 'linked')
  write(outside, 'outside bytes'); fs.symlinkSync(outside, link)
  const hard = path.join(f.target, 'hard-linked'); fs.linkSync(outside, hard)
  for (const file of [link, hard]) {
    await assert.rejects(boundary.executeTool(f.policy, 'read', { path: file }), denied('TOOL_PATH_DENIED'))
    await assert.rejects(boundary.executeTool(f.policy, 'write', { path: file, content: 'changed' }), denied('TOOL_PATH_DENIED'))
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside bytes')
})

test('ambiguous edits, invalid UTF-8 and malformed tool arguments are not accepted', async t => {
  const f = fixture(t), file = path.join(f.target, 'ambiguous')
  write(file, 'repeat repeat')
  await assert.rejects(boundary.executeTool(f.policy, 'edit', { path: file, oldText: 'repeat', newText: 'one' }), denied('TOOL_EDIT_AMBIGUOUS'))
  assert.equal(fs.readFileSync(file, 'utf8'), 'repeat repeat')
  await boundary.executeTool(f.policy, 'edit', { path: file, oldText: 'repeat', newText: 'one', replaceAll: true })
  assert.equal(fs.readFileSync(file, 'utf8'), 'one one')
  write(file, Buffer.from([0xff, 0xfe]))
  await assert.rejects(boundary.executeTool(f.policy, 'read', { path: file }), denied('TOOL_ARGUMENTS_INVALID'))
  for (const [name, args, code] of [['task', {}, 'TOOL_DENIED'], ['read', { path: file, startLine: 0 }, 'TOOL_ARGUMENTS_INVALID'],
    ['read', { path: file, unexpected: true }, 'TOOL_ARGUMENTS_INVALID'], ['write', { path: file }, 'TOOL_ARGUMENTS_INVALID']]) {
    await assert.rejects(boundary.executeTool(f.policy, name, args), denied(code))
  }
})

test('an already-cancelled tool has no filesystem side effect', async t => {
  const f = fixture(t), file = path.join(f.target, 'never-created'), controller = new AbortController()
  controller.abort()
  await assert.rejects(boundary.executeTool(f.policy, 'write', { path: file, content: 'wrong' }, { signal: controller.signal }), denied('TOOL_CANCELLED'))
  assert.equal(fs.existsSync(file), false)
})

test('private tool policy and receipt chain bind exact assigned resources', async t => {
  const f = fixture(t), prepared = boundary.prepareBoundary({ provider: 'claude', root: f.control, policy: f.policy })
  assert.ok(fs.existsSync(prepared.serverSpec.args[0]), 'the installed tool-server module must exist')
  assert.equal(boundary.loadBoundary(prepared.policyPath, prepared.policySha256).policy.targetPath, f.target)
  const args = { path: f.target }, startedAt = new Date().toISOString()
  const result = await boundary.executeTool(f.policy, 'list', args)
  const first = boundary.appendReceipt(prepared, 'list', args, result, startedAt)
  const second = boundary.appendReceipt(prepared, 'list', args, result, startedAt)
  assert.equal(second.previous, first.hash)
  assert.deepEqual(boundary.readReceipts(prepared), [first, second])
  fs.appendFileSync(prepared.receiptPath, '{unfinished')
  assert.throws(() => boundary.readReceipts(prepared), denied('TOOL_RECEIPT_INVALID'))
  fs.appendFileSync(prepared.policyPath, ' ')
  assert.throws(() => boundary.loadBoundary(prepared.policyPath, prepared.policySha256), denied('TOOL_POLICY_INVALID'))
})

async function startPeer(t, prepared) {
  const child = cp.spawn(process.execPath, prepared.serverSpec.args, { env: prepared.serverSpec.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  let buffer = '', stderr = '', id = 0, ended = false
  const pending = new Map()
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true; for (const item of pending.values()) item.reject(new Error(`Tool server closed (${code}/${signal}): ${stderr}`)); pending.clear(); resolve({ code, signal })
  }))
  child.on('error', error => { for (const item of pending.values()) item.reject(error); pending.clear() })
  child.stderr.on('data', data => { stderr += data })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', text => {
    buffer += text
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      let response
      try { response = JSON.parse(line) } catch (error) { for (const item of pending.values()) item.reject(error); pending.clear(); child.kill(); return }
      const item = pending.get(response.id)
      if (item) { pending.delete(response.id); item.resolve(response) }
    }
  })
  child.stdin.on('error', error => { for (const item of pending.values()) item.reject(error); pending.clear() })
  t.after(async () => {
    child.stdin.end()
    const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL') }, 1000)
    await closed; clearTimeout(timer)
  })
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (ended) { reject(new Error('tool server is closed')); return }
    const key = ++id; pending.set(key, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`)
  })
  return { request, notify, closed }
}

test('actual Node stdio tool server initializes, denies candidate writes and commits its evidence', { timeout: 10000 }, async t => {
  const f = fixture(t, true), candidate = path.join(f.target, 'candidate.txt')
  write(candidate, 'candidate stays exact')
  const prepared = boundary.prepareBoundary({ provider: 'claude', root: f.control, policy: f.policy })
  const peer = await startPeer(t, prepared)
  const premature = await peer.request('tools/list')
  assert.equal(premature.error.code, -32002)
  const initialized = await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'boundary-audit', version: '1' } })
  assert.equal(initialized.result.protocolVersion, '2024-11-05')
  peer.notify('notifications/initialized')
  assert.deepEqual((await peer.request('tools/list')).result.tools.map(tool => tool.name), boundary.TOOLS.map(tool => tool.name))
  const read = await peer.request('tools/call', { name: 'read', arguments: { path: candidate } })
  assert.equal(read.result.structuredContent.output, 'candidate stays exact')
  assert.equal(read.result.isError, false)
  const deniedWrite = await peer.request('tools/call', { name: 'write', arguments: { path: candidate, content: 'changed' } })
  assert.equal(deniedWrite.result.isError, true)
  assert.equal(deniedWrite.result.structuredContent.code, 'TOOL_PATH_DENIED')
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'candidate stays exact')
  const scratch = path.join(f.scratch, 'evidence.txt')
  const accepted = await peer.request('tools/call', { name: 'write', arguments: { path: scratch, content: 'independent evidence' } })
  assert.equal(accepted.result.isError, false)
  assert.equal(fs.readFileSync(scratch, 'utf8'), 'independent evidence')
  const records = boundary.readReceipts(prepared)
  assert.equal(records.length, 3)
  assert.deepEqual(records.map(item => item.status), ['completed', 'failed', 'completed'])
  assert.equal(accepted.result._meta['autoprompt/receipt'], records[2].hash)
  assert.equal(accepted.result._meta['autoprompt/policy'], prepared.policySha256)
})

test('actual OS command boundary allows owned writes but denies checker and metadata writes', { timeout: 20000 }, async t => {
  const availability = await boundary.probeCommandSandbox()
  if (!availability.supported) { t.skip(`Required OS sandbox unavailable: ${availability.reason || availability.code}`); return }
  const f = fixture(t), candidate = path.join(f.target, 'candidate.txt'), metadata = path.join(f.target, '.git', 'config')
  write(candidate, 'candidate'); write(metadata, 'controller metadata')
  const command = script => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
  const writerFile = path.join(f.target, 'owned.txt')
  const writer = await boundary.executeTool(f.policy, 'bash', {
    command: command(`require('node:fs').writeFileSync(${JSON.stringify(writerFile)}, 'owned write'); process.stdout.write('writer completed')`), timeoutMs: 5000,
  })
  assert.equal(writer.status, 'completed', writer.stderr); assert.equal(writer.exitCode, 0)
  assert.equal(writer.stdout, 'writer completed'); assert.equal(writer.outputSha256, boundary.sha256(Buffer.from(writer.outputBase64, 'base64')))
  assert.equal(fs.readFileSync(writerFile, 'utf8'), 'owned write')
  const readonly = { ...f.policy, readOnly: true, writableRoots: [f.scratch] }
  const candidateDenied = await boundary.executeTool(readonly, 'bash', {
    command: command(`try { require('node:fs').writeFileSync(${JSON.stringify(candidate)}, 'wrong'); process.exit(9) } catch (error) { if (!['EROFS','EACCES','EPERM'].includes(error.code)) throw error; process.stdout.write('checker denied') }`), timeoutMs: 5000,
  })
  assert.equal(candidateDenied.status, 'completed', candidateDenied.stderr)
  assert.equal(candidateDenied.stdout, 'checker denied'); assert.equal(fs.readFileSync(candidate, 'utf8'), 'candidate')
  const metadataDenied = await boundary.executeTool(f.policy, 'bash', {
    command: command(`try { require('node:fs').writeFileSync(${JSON.stringify(metadata)}, 'wrong'); process.exit(9) } catch (error) { if (!['EROFS','EACCES','EPERM'].includes(error.code)) throw error; process.stdout.write('metadata denied') }`), timeoutMs: 5000,
  })
  assert.equal(metadataDenied.status, 'completed', metadataDenied.stderr)
  assert.equal(metadataDenied.stdout, 'metadata denied'); assert.equal(fs.readFileSync(metadata, 'utf8'), 'controller metadata')
  const privateFile = path.join(f.control, 'not-mounted'); write(privateFile, 'private controller bytes')
  const hidden = await boundary.executeTool(f.policy, 'bash', {
    command: command(`if (require('node:fs').existsSync(${JSON.stringify(privateFile)})) process.exit(9); process.stdout.write('private state absent')`), timeoutMs: 5000,
  })
  assert.equal(hidden.status, 'completed', hidden.stderr); assert.equal(hidden.stdout, 'private state absent')
})

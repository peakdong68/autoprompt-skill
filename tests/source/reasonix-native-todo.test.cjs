'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { ReasonixEventStream } = require('../../agents/reasonix/workflow/transport.js')
const { validateNativeTodoWrite } = require('../../agents/reasonix/workflow/native.js')

const todos = [{ content:'Write first file', status:'completed', step_id:'one' }, { content:'Write second file', status:'in_progress', activeForm:'Writing second file', level:1, step_id:'two' }]
const ack = 'Todos updated: 2 total — 1 completed, 1 in progress, 0 pending.'
const event = (kind, tool) => JSON.stringify({ kind, tool })

test('zero-tool Reasonix reservations reject native bookkeeping and controller dispatch', () => {
  for (const name of ['todo_write', 'use_capability']) {
    const stream = new ReasonixEventStream({ providerToolCallLimit: 0 })
    assert.throws(() => stream.push(event('tool_dispatch', { id: 'forbidden', name, args: JSON.stringify({ todos }), readOnly: true })), { code: 'ROLE_POLICY_DENIED' })
  }
})

test('native todo validator accepts the direct bounded checklist and rejects malformed identities', () => {
  assert.deepEqual(validateNativeTodoWrite({ todos }), { todos })
  for (const value of [
    { todos:[{ content:'x', status:'bad' }] },
    { todos:[{ content:'x', status:'in_progress' }, { content:'y', status:'in_progress' }] },
    { todos:[{ content:'x', status:'pending', step_id:'same' }, { content:'y', status:'completed', step_id:'same' }] },
    { todos:[{ content:'x', status:'pending', level:2 }] },
  ]) assert.throws(() => validateNativeTodoWrite(value), { code:'TOOL_POLICY_DENIED' })
})

test('native todo acknowledgement is direct, counted once, and never receipt-backed', () => {
  const calls = [], stream = new ReasonixEventStream({ continuationId:'session', onToolCallObserved:value => calls.push(value) })
  stream.push(event('tool_dispatch', { id:'todo-1', name:'todo_write', args:JSON.stringify({ todos }), readOnly:true }))
  stream.push(event('tool_result', { id:'todo-1', name:'todo_write', args:JSON.stringify({ todos }), readOnly:true, output:ack }))
  assert.equal(calls.length, 1)
  assert.equal(stream.receiptVerifier, null)
  assert.throws(() => stream.push(event('tool_result', { id:'todo-1', name:'todo_write', args:JSON.stringify({ todos }), readOnly:true, output:ack })), { code:'TRANSPORT_INVALID' })
})

test('native todo rejects changed arguments, writable binding, and mismatched acknowledgement counts', () => {
  for (const result of [
    { args:{ todos:[{ content:'other', status:'pending' }] }, readOnly:true, output:ack },
    { args:{ todos }, readOnly:false, output:ack },
    { args:{ todos }, readOnly:true, output:'Todos updated: 2 total — 2 completed, 0 in progress, 0 pending.' },
  ]) {
    const stream = new ReasonixEventStream()
    stream.push(event('tool_dispatch', { id:'todo', name:'todo_write', args:JSON.stringify({ todos }), readOnly:true }))
    assert.throws(() => stream.push(event('tool_result', { id:'todo', name:'todo_write', args:JSON.stringify(result.args), readOnly:result.readOnly, output:result.output })), /Reasonix|Native|tool/i)
  }
})

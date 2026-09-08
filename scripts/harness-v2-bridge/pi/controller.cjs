'use strict'

// Trusted extension code only: never load a module, command backend, or policy
// from model arguments. Native startup must also disable automatic extensions.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const boundary = require('../../harness-v2-tool-boundary.cjs')
const NAMES = Object.freeze(boundary.TOOLS.map(tool => `autoprompt_owned_${tool.name}`))
const fail = (code, message) => { throw new boundary.BoundaryError(code, message) }

function privateState(state, paths = []) {
  for (const file of [state.root, ...paths.filter(Boolean)]) {
    const real = boundary.physical(file, { missingLeaf: true })
    if (state.policy.readableRoots.some(root => boundary.within(root, real) || boundary.within(real, root))) {
      fail('TOOL_POLICY_INVALID', 'Native controller state must be disjoint from task roots')
    }
  }
}

function openController(provider, environment = process.env) {
  const policyPath = environment.AUTOPROMPT_TOOL_POLICY
  const digest = environment.AUTOPROMPT_TOOL_POLICY_SHA256
  if (!policyPath || !path.isAbsolute(policyPath)) fail('TOOL_POLICY_INVALID', 'Private tool policy path is required')
  const state = boundary.loadBoundary(policyPath, digest)
  if (state.policy.provider !== provider) fail('TOOL_POLICY_INVALID', 'Tool policy provider mismatch')
  privateState(state)
  const lockPath = path.join(state.root, 'server.lock')
  const lockBytes = JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), policySha256: digest })
  const fd = fs.openSync(lockPath, 'wx', 0o600)
  try { fs.writeFileSync(fd, lockBytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  let chain = Promise.resolve(), closing = false, closePromise
  const pending = new Set()
  function check() {
    const current = boundary.loadBoundary(policyPath, digest)
    privateState(current)
    boundary.physical(lockPath)
    if (fs.readFileSync(lockPath, 'utf8') !== lockBytes) fail('TOOL_POLICY_INVALID', 'Controller ownership changed')
    boundary.readReceipts(current)
    return current
  }
  function close() {
    if (closePromise) return closePromise
    closing = true
    for (const item of pending) item.abort()
    closePromise = chain.then(() => {
      try {
        boundary.physical(lockPath)
        if (fs.readFileSync(lockPath, 'utf8') === lockBytes) fs.unlinkSync(lockPath)
      } catch { /* Preserve changed or stale ownership for controller inspection. */ }
    })
    return closePromise
  }
  function execute(name, input, signal) {
    if (closing) return Promise.reject(new boundary.BoundaryError('TOOL_CLOSED', 'Controller is closing'))
    if (!NAMES.includes(name)) return Promise.reject(new boundary.BoundaryError('TOOL_DENIED', 'Only controller tools are available'))
    if (pending.size >= 64) return Promise.reject(new boundary.BoundaryError('TOOL_QUEUE_LIMIT', 'Controller tool queue is full'))
    // Snapshot before enqueue: later native middleware cannot mutate a queued call.
    let args
    try { args = JSON.parse(boundary.canonicalJson(input)) } catch { return Promise.reject(new boundary.BoundaryError('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be JSON')) }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    pending.add(controller)
    const job = chain.then(async () => {
      const startedAt = new Date().toISOString(), tool = name.slice('autoprompt_owned_'.length)
      let actualResult
      try {
        const current = check()
        actualResult = await boundary.executeTool(current.policy, tool, args, { signal: controller.signal })
      } catch (error) {
        // Do not echo host paths/stack traces from filesystem errors into context.
        const code = error instanceof boundary.BoundaryError ? error.code : 'TOOL_FAILED'
        const output = `${code}: ${error instanceof boundary.BoundaryError ? error.message : 'Controller tool execution failed'}`
        actualResult = { tool, status: 'failed', exitCode: null, output, outputSha256: boundary.sha256(output), code }
      }
      try {
        check()
        const receipt = boundary.appendReceipt(state, tool, args, actualResult, startedAt)
        return { content: [{ type: 'text', text: JSON.stringify(actualResult) }],
          details: { actualResult, receiptSha256: receipt.hash, policySha256: digest },
          isError: actualResult.status !== 'completed' }
      } catch {
        closing = true
        for (const item of pending) item.abort()
        fail('TOOL_RECEIPT_INVALID', 'Controller execution evidence could not be committed')
      }
    }).finally(() => { pending.delete(controller); signal?.removeEventListener('abort', cancel) })
    // A failed call never poisons cleanup, nor allows a queued mutation to run.
    chain = job.catch(() => {})
    return job
  }
  return { execute, close, check, state, get closing() { return closing } }
}

// Translate only the controller's fixed schemas using each host's native schema
// builder. Prime supplies TypeBox; OMP supplies its injected compatibility API.
function parameters(Type, schema) {
  const properties = {}
  for (const [key, spec] of Object.entries(schema.properties)) {
    let value
    if (spec.type === 'string') value = Type.String()
    else if (spec.type === 'boolean') value = Type.Boolean()
    else if (spec.type === 'integer') value = Type.Integer({ minimum: spec.minimum, ...(spec.maximum ? { maximum: spec.maximum } : {}) })
    else fail('TOOL_POLICY_INVALID', 'Unsupported controller schema')
    properties[key] = schema.required.includes(key) ? value : Type.Optional(value)
  }
  return Type.Object(properties, { additionalProperties: false })
}

function install(pi, provider, Type, environment = process.env) {
  let controller, ready = false, context, activation, stopped = false
  const close = async () => {
    stopped = true
    ready = false
    if (controller) await controller.close()
  }
  const stop = async ctx => {
    ready = false
    try { await pi.setActiveTools([]) } catch {}
    await close()
    // abort may wait for the very tool that invoked stop; never await that cycle.
    try { ctx?.abort()?.catch?.(() => {}) } catch {}
    try { ctx?.shutdown() } catch {}
  }
  const exactTools = () => {
    const active = pi.getActiveTools()
    return active.length === NAMES.length && active.every(name => NAMES.includes(name))
  }
  const activate = (_event, ctx) => {
    context = ctx
    if (activation) return activation
    activation = (async () => {
      try {
        if (stopped) fail('TOOL_CLOSED', 'Controller is closed')
        // Native turn notifications can overlap streaming tool dispatch. Do not
        // transiently disable a healthy surface on every notification.
        if (ready && controller && !controller.closing && exactTools()) {
          privateState(controller.check(), [ctx.cwd, ctx.sessionManager?.getSessionFile?.(), environment.HOME])
          return
        }
        ready = false
        await pi.setActiveTools([])
        if (stopped) fail('TOOL_CLOSED', 'Controller is closed')
        if (!controller) controller = openController(provider, environment)
        if (controller.closing) fail('TOOL_CLOSED', 'Controller is closed')
        privateState(controller.check(), [ctx.cwd, ctx.sessionManager?.getSessionFile?.(), environment.HOME])
        await pi.setActiveTools([...NAMES])
        if (stopped || controller.closing) fail('TOOL_CLOSED', 'Controller closed during native activation')
        if (!exactTools()) fail('TOOL_DENIED', 'Native tool activation did not honor the fixed surface')
        ready = true
      } catch (error) { await stop(ctx); throw error }
    })()
    const pending = activation
    pending.finally(() => { if (activation === pending) activation = undefined }).catch(() => {})
    return pending
  }
  pi.on('tool_call', async event => {
    try { if (activation) await activation } catch { /* A failed activation stays closed. */ }
    if (!ready || controller?.closing || !NAMES.includes(event.toolName)) {
      return { block: true, reason: 'TOOL_DENIED: Only the assigned controller tools are available' }
    }
  })
  pi.on('tool_result', async (event, ctx) => {
    if (!NAMES.includes(event.toolName) || !event.details?.actualResult) return
    const { actualResult, receiptSha256 } = event.details
    try {
      const receipts = boundary.readReceipts(controller.state)
      const receipt = receipts.find(item => item.hash === receiptSha256)
      if (!receipt || receipt.tool !== event.toolName.slice('autoprompt_owned_'.length) ||
          receipt.resultSha256 !== boundary.sha256(boundary.canonicalJson(actualResult))) {
        fail('TOOL_RECEIPT_INVALID', 'Native tool result does not match committed evidence')
      }
    } catch {
      await stop(ctx)
      fail('TOOL_RECEIPT_INVALID', 'Native tool result does not match committed evidence')
    }
    // Prime ignores isError returned by execute. The native result hook carries
    // the error flag while preserving the committed JSON, including denials.
    return { content: [{ type: 'text', text: JSON.stringify(actualResult) }],
      details: event.details, isError: actualResult.status !== 'completed' }
  })
  for (const tool of boundary.TOOLS) pi.registerTool({
    name: `autoprompt_owned_${tool.name}`, label: `Controller ${tool.name}`,
    description: tool.description, parameters: parameters(Type, tool.inputSchema),
    // OMP keeps these tools immediate and visible; Prime ignores extra metadata.
    hidden: false, defaultInactive: false, deferrable: false, loadMode: 'essential',
    async execute(_id, args, signal) {
      if (activation) await activation
      if (!ready || !controller) fail('TOOL_DENIED', 'Controller session is not ready')
      try { return await controller.execute(`autoprompt_owned_${tool.name}`, args, signal) }
      catch (error) {
        if (controller.closing) await stop(context)
        throw error
      }
    },
  })
  pi.on('session_start', activate)
  pi.on('before_agent_start', activate)
  pi.on('turn_start', activate)
  // A reservation owns exactly one native history. Resume uses another process.
  for (const event of ['session_before_switch', 'session_before_branch', 'session_before_tree']) {
    pi.on(event, async () => ({ cancel: true }))
  }
  pi.on('session_shutdown', close)
  const denied = async () => ({ result: { output: 'TOOL_DENIED: Native execution is disabled', exitCode: 1, cancelled: false, truncated: false } })
  pi.on('user_bash', denied)
  if (provider === 'omp') pi.on('user_python', denied)
  // Native hosts own process termination; we synchronously cancel outstanding
  // work on signals and keep the lock until the serialized journal has drained.
  const signals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
    process.exitCode = signal === 'SIGTERM' ? 143 : 130
    void stop(context)
  }]))
  for (const [signal, handler] of signals) process.on(signal, handler)
  pi.on('session_shutdown', async () => {
    await close()
    for (const [signal, handler] of signals) process.removeListener(signal, handler)
  })
  return { close, get controller() { return controller } }
}
module.exports = { NAMES, privateState, openController, parameters, install }

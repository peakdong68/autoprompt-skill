'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  CONTROLLED_CAPABILITIES, CONTROLLED_PROXY, CONTROLLED_SERVER, CONTROLLED_TOOLS, ReasonixError, inside, nativeUsage, parseTerminal, privateDirectory, readBound, renderConfig, renderCredentials, sha256, writePrivate,
} = require('./native.js')
const core = require('../../codex/workflow/phase-budget.js')
const { validateJsonSchema } = require('../../codex/workflow/json-schema-validator.js')
const { TOOLS, canonicalJson } = require('../../../scripts/harness-v2-tool-boundary.cjs')

function controlledInvocation(name, args) {
  const index = CONTROLLED_CAPABILITIES.indexOf(args.capability_id)
  if (name !== CONTROLLED_PROXY || args.action !== 'call' || index === -1 ||
      Object.keys(args).some(key => !['action', 'capability_id', 'arguments'].includes(key)) ||
      !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments)) {
    throw new ReasonixError('ROLE_POLICY_DENIED', 'Only exact calls to the six controller-owned MCP capabilities are permitted')
  }
  return { name: CONTROLLED_TOOLS[index], args: args.arguments }
}

function controlledOutput(tool) {
  if (!tool.err) return tool.output
  // Native v1.30 wraps an MCP isError result twice. Accept only its exact
  // envelope, then verify the unchanged inner result against the private
  // journal. Never search for a JSON-looking substring or discard suffixes.
  const prefix = 'plugin tool reported error: '
  if (typeof tool.err !== 'string' || !tool.err.startsWith(prefix)) {
    throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native failure has no complete controller result')
  }
  const output = tool.err.slice(prefix.length)
  if (tool.output !== `error: ${tool.err}\n${output}`) {
    throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native failure changed the controller result envelope')
  }
  return output
}

function verifyControlledReceipt(verifier, ...args) {
  // The real server may append the next completed call while the native
  // observer reads the journal. Retry only a refused unstable snapshot; every
  // attempt still runs the unchanged policy, chain, argument and result checks.
  // Truncated, mismatched, replayed or persistently changing data still fails.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return verifier.verify(...args) } catch (error) {
      if (attempt === 2 || error.code !== 'PAYLOAD_INVALID' || error.message !== 'File changed while reading') throw error
    }
  }
}

// Normalize the native wire protocol at the provider boundary. The reviewed
// controller continues to own result schemas, checks, accounting, and recovery.
class ReasonixEventStream {
  constructor(record = {}) {
    this.record = record
    this.accumulator = core.createCodexJsonlAccumulator(record)
    this.hash = require('node:crypto').createHash('sha256')
    this.usage = { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 }
    this.activeTools = new Set()
    this.toolDispatches = new Map()
    this.completedTools = new Set()
    this.receiptVerifier = record.toolBoundary
      ? new (require('../../../scripts/harness-v2-controlled-tools.cjs').ReceiptVerifier)('reasonix', record.toolBoundary) : null
    this.result = null
    this.sawUsage = false
    this.toolCount = record.priorToolCallCount || 0
  }

  emit(event) { this.accumulator.push(JSON.stringify(event)) }

  push(line) {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new ReasonixError('TRANSPORT_LIMIT_EXCEEDED', 'Reasonix event exceeds the capture limit')
    let event
    try { event = JSON.parse(line) } catch { throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix emitted invalid JSON') }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix event must be an object')
    this.hash.update(`${line}\n`)
    this.record.onTransportActivity?.()
    this.record.onEvent?.(event, line)
    if (this.result) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix emitted data after its terminal result')
    if (event.kind === 'usage') {
      const delta = nativeUsage(event.usage || {})
      for (const key of Object.keys(this.usage)) {
        this.usage[key] += delta[key]
        if (!Number.isSafeInteger(this.usage[key])) throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Native token total exceeds exact integer accounting')
      }
      this.sawUsage = true
      if (typeof this.record.onUsageDelta === 'function') {
        const verdict = this.record.onUsageDelta(delta, { ...this.usage })
        if (!verdict || verdict.continue !== true) {
          const error = new ReasonixError('BUDGET_EXHAUSTED', 'Scheduler denied continued Reasonix token usage')
          error.usage = { ...this.usage }
          throw error
        }
      }
    }
    if (event.kind === 'tool_dispatch' || event.kind === 'tool_result') {
      const tool = event.tool || {}
      if (typeof tool.id !== 'string' || !tool.id) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix tool event has no identity')
      if (event.kind === 'tool_dispatch' && tool.partial === true) {
        if (this.receiptVerifier && tool.name !== CONTROLLED_PROXY) throw new ReasonixError('ROLE_POLICY_DENIED', 'Native builtins and direct tool dispatch are disabled')
        return event
      }
      const refreshed = event.kind === 'tool_dispatch' && tool.refreshed === true
      if (refreshed && !this.receiptVerifier) return event
      const start = event.kind === 'tool_dispatch' && !refreshed
      let args
      try { args = JSON.parse(tool.args || '{}') } catch { throw new ReasonixError('TRANSPORT_INVALID', 'Native tool arguments are invalid') }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ReasonixError('TRANSPORT_INVALID', 'Native tool arguments must be an object')
      if (start) {
        if (this.activeTools.has(tool.id) || this.completedTools.has(tool.id)) throw new ReasonixError('TRANSPORT_INVALID', 'Duplicate native tool dispatch')
        const invocation = this.receiptVerifier ? controlledInvocation(tool.name, args) : { name: tool.name, args }
        this.activeTools.add(tool.id)
        this.toolDispatches.set(tool.id, { name: tool.name, args, invocation })
        this.record.onToolCallObserved?.({ attemptedCount: ++this.toolCount, continuationId: this.record.continuationId || null, itemIdHash: sha256(tool.id), itemType: tool.name, observedPhase: 'started' })
      } else if (!this.activeTools.has(tool.id)) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native tool result has no matching dispatch')
      }
      const dispatched = this.toolDispatches.get(tool.id)
      if (!start && (dispatched.name !== tool.name ||
          canonicalJson(dispatched.args) !== canonicalJson(args))) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native tool result changed the dispatched identity or arguments')
      }
      const invocation = dispatched.invocation
      if (this.receiptVerifier &&
          (tool.resolvedName !== undefined && tool.resolvedName !== invocation.name ||
           tool.capabilityId !== undefined && tool.capabilityId !== dispatched.args.capability_id)) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native capability resolution changed the controller-owned target')
      }
      if (refreshed) return event
      const name = this.receiptVerifier ? invocation.name.slice(`mcp__${CONTROLLED_SERVER}__`.length) : invocation.name
      const shell = name === 'bash'
      let output = tool.output || '', exitCode = tool.execution?.exitCode, failed = Boolean(tool.err)
      if (!start) {
        if (tool.truncated === true || tool.background === true) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native tool output was truncated or detached')
        if (this.receiptVerifier) {
          const verified = verifyControlledReceipt(this.receiptVerifier, invocation.name, invocation.args, controlledOutput(tool), failed)
          if (shell && verified.command !== invocation.args.command) throw new ReasonixError('TOOL_RECEIPT_INVALID', 'Controlled command changed after dispatch')
          output = verified.output; exitCode = verified.exitCode; failed = verified.status === 'failed'
        }
        if (shell && (!failed || this.receiptVerifier) && !Number.isSafeInteger(exitCode)) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native command must finish in the foreground with complete captured output')
        this.completedTools.add(tool.id)
        this.activeTools.delete(tool.id)
        this.toolDispatches.delete(tool.id)
      }
      const write = this.receiptVerifier ? ['write', 'edit'].includes(name) : !tool.readOnly
      const item = {
        id: tool.id, type: shell ? 'command_execution' : write ? 'file_change' : 'mcp_tool_call',
        status: start ? 'in_progress' : failed ? 'failed' : 'completed',
        ...(shell ? {
          command: invocation.args.command || '',
          ...(Number.isSafeInteger(exitCode) ? { exit_code: exitCode } : {}),
          aggregated_output: output,
        } : {}),
      }
      this.emit({ type: start ? 'item.started' : 'item.completed', item })
      if (!start && write && !failed && !this.record.readOnly) this.record.onFirstProductSignal?.({ kind: 'PRODUCT_EDIT', evidenceHash: sha256(line) })
    }
    if (event.type === 'result') {
      if (this.activeTools.size || !this.sawUsage || event.is_error || event.subtype !== 'success') {
        throw new ReasonixError('CHILD_RUNTIME_FAILURE', 'Reasonix did not finish with settled tools, exact usage, and a successful terminal result', { subtype: event.subtype, activeTools: this.activeTools.size })
      }
      if (typeof event.session_id !== 'string' || !event.session_id) throw new ReasonixError('SESSION_ID_MISSING', 'Reasonix terminal result has no session identity')
      if (this.record.continuationId && this.record.continuationId !== event.session_id) throw new ReasonixError('SESSION_ID_MISMATCH', 'Reasonix resumed a different session')
      const finalUsage = event.usage
      if (!finalUsage || finalUsage.input_tokens !== this.usage.noncachedInput + this.usage.cachedInput || finalUsage.output_tokens !== this.usage.output || finalUsage.cache_read_input_tokens !== this.usage.cachedInput) throw new ReasonixError('PROVIDER_USAGE_UNKNOWN', 'Native final usage differs from the observed request ledger')
      const output = parseTerminal(event.result)
      this.emit({ type: 'thread.started', thread_id: event.session_id })
      this.record.onSessionIdentified?.(event.session_id, { event, raw: line, occurredAt: new Date().toISOString() })
      this.emit({ type: 'item.completed', item: { id: 'reasonix-terminal', type: 'agent_message', text: JSON.stringify(output) } })
      this.emit({ type: 'turn.completed', usage: {
        input_tokens: this.usage.noncachedInput + this.usage.cachedInput,
        cached_input_tokens: this.usage.cachedInput,
        output_tokens: this.usage.output, reasoning_output_tokens: this.usage.reasoning,
      } })
      this.result = output
    }
    return event
  }

  finish() {
    if (!this.result) throw new ReasonixError('CHILD_RESULT_MISSING', 'Reasonix exited without its structured terminal result')
    return { ...this.accumulator.snapshot(), rawOutputHash: this.hash.digest('hex'),
      ...(this.receiptVerifier ? { toolReceiptHashes: this.receiptVerifier.finish() } : {}) }
  }
}

function nativeContextRoot(nativeRoot, record, targetPath) {
  if (!record.continuationId) return path.join(nativeRoot, sha256(record.sessionId))
  const saved = JSON.parse(readBound(path.join(nativeRoot, 'contexts', `${sha256(record.continuationId)}.json`)))
  if (saved.sessionId !== record.continuationId || saved.providerRole !== record.providerRole ||
      saved.targetPath !== targetPath || !/^[a-f0-9]{64}$/.test(saved.rootKey || '')) {
    throw new ReasonixError('SESSION_ID_MISMATCH', 'Continuation differs from its original native role or workspace')
  }
  return path.join(nativeRoot, saved.rootKey)
}

function persistNativeContext(nativeRoot, sessionRoot, record, targetPath, sessionId) {
  const file = path.join(nativeRoot, 'contexts', `${sha256(sessionId)}.json`)
  const saved = { sessionId, providerRole: record.providerRole, targetPath, rootKey: path.basename(sessionRoot) }
  if (fs.existsSync(file)) {
    if (JSON.stringify(JSON.parse(readBound(file))) !== JSON.stringify(saved)) throw new ReasonixError('SESSION_ID_MISMATCH', 'Native session identity was already bound to another assignment')
  } else writePrivate(file, JSON.stringify(saved))
}

function prepareReasonixBoundary({ nativeRoot, launchRoot, record, targetPath, scratchPath, readOnly, checkerScratch }) {
  const boundary = require('../../../scripts/harness-v2-tool-boundary.cjs')
  const candidate = checkerScratch ? path.resolve(checkerScratch.frozenCandidateRoot) : targetPath
  // Controller state must not be available even through read-only file tools.
  const privateRoot = boundary.physical(nativeRoot)
  for (const root of [candidate, scratchPath]) {
    const physicalRoot = boundary.physical(root)
    if (inside(physicalRoot, privateRoot) || (inside(privateRoot, physicalRoot) && root !== scratchPath)) {
      throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix task roots overlap protected controller state')
    }
  }
  const toolRoot = path.join(launchRoot, 'tools')
  privateDirectory(toolRoot)
  return boundary.prepareBoundary({ provider: 'reasonix', root: toolRoot, policy: {
    schemaVersion: 1, activationId: record.activationId, sessionId: record.sessionId, reservationId: record.reservationId,
    readOnly, targetPath: candidate, scratchPath,
    readableRoots: [candidate, scratchPath], writableRoots: readOnly ? [scratchPath] : [candidate, scratchPath],
    nestedDispatch: false, commandBoundary: true, externalWrites: false,
  } })
}

class ReasonixExecAdapter {
  constructor(options = {}) {
    if (!options.runner?.run || !options.runner?.stop || !options.nativeRoot || !options.connection || !options.executableBinding) {
      throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix transport requires an owned runner, native root, connection, and bound executable')
    }
    Object.assign(this, options)
  }

  async launch(record) {
    const mission = core.validateCanonicalMissionLaunch(record)
    // Native continuation keeps its context, while each physical process has
    // a reservation-scoped identity in the controller's ownership registry.
    const processSessionId = `native-reasonix-${sha256(JSON.stringify([record.sessionId, record.reservationId]))}`
    const binding = this.executableBinding
    if (sha256(readBound(binding.path)) !== binding.sha256) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix executable changed after activation')
    const execution = record.physicalExecutionPolicy
    if (!execution || execution.logicalRole !== record.logicalRole || execution.providerRole !== record.providerRole || execution.physicalRole !== record.physicalRole || !['read-only', 'workspace-write'].includes(execution.sandboxMode)) {
      throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix dispatch has no exact physical role policy')
    }
    const targetPath = path.resolve(record.workingDirectory || record.cwd || this.targetPath)
    const readOnly = execution.sandboxMode === 'read-only'
    const sessionRoot = nativeContextRoot(this.nativeRoot, record, targetPath)
    const launchRoot = path.join(sessionRoot, sha256(record.reservationId))
    const checkerScratch = record.checkerScratchBoundary ? this.checkerScratchVerifier?.(record) : null
    if (record.checkerScratchBoundary && !checkerScratch) throw new ReasonixError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'Missing authenticated checker scratch boundary')
    const scratchPath = checkerScratch ? targetPath : path.join(launchRoot, 'scratch')
    if (record.externalLocalBoundary || record.externalOperation) throw new ReasonixError('EXTERNAL_WRITE_BOUNDARY_UNAVAILABLE', 'Reasonix controlled tools support only the assigned candidate and checker scratch')
    const cwd = path.join(sessionRoot, 'cwd')
    privateDirectory(scratchPath)
    privateDirectory(cwd)
    const toolBoundary = prepareReasonixBoundary({ nativeRoot: this.nativeRoot, launchRoot, record, targetPath, scratchPath, readOnly, checkerScratch })
    const schema = core.codexProviderCanonicalOutputSchema(record, JSON.parse(readBound(this.outputSchemaResolver(record)).toString('utf8')))
    const prompt = this.rolePrompt(record.providerRole)
    const systemPrompt = [prompt, '',
      'The external controller owns all dispatch and finalization. Do not start another agent or load skills. Run commands in the foreground and wait for their exit status; do not background commands.',
      `Use only ${CONTROLLED_PROXY} with action="call", one exact capability_id below, and the tool input in arguments. Do not call direct MCP names, native tools, ask, discovery actions, or other capabilities.`,
      JSON.stringify(TOOLS.map(tool => ({ capability_id: `mcp-tool:${CONTROLLED_SERVER}/${tool.name}`, description: tool.description, arguments_schema: tool.inputSchema }))),
      `The exact workspace for this assignment is ${JSON.stringify(targetPath)}. Use absolute paths or explicitly change the command working directory to this workspace.`,
      `Private temporary check files belong only in ${JSON.stringify(scratchPath)}.`,
      ...core.codexPrivateWorkspaceProjection(record, record.canonicalTargetPath || this.targetPath, targetPath),
      ...core.codexExplicitExternalLocalProjection(record, record.canonicalTargetPath || this.targetPath),
      ...core.codexCheckerScratchProjection(record, record.canonicalTargetPath || this.targetPath, targetPath, checkerScratch),
      'Return exactly one JSON object, without a Markdown fence, conforming to this result schema:',
      JSON.stringify(schema),
    ].join('\n')
    const home = path.join(launchRoot, 'home')
    writePrivate(path.join(home, 'config.toml'), renderConfig({ connection: this.connection, systemPrompt, targetPath, scratchPath, readOnly, checkerScratch: Boolean(checkerScratch), toolBoundary }))
    const argv = ['run', '--permission-mode', 'dontAsk', '--allowed-tools', CONTROLLED_TOOLS.join(','), '--output-format', 'stream-json', '--dir', cwd, '--max-steps', '100']
    if (record.assignment?.model) argv.push('--model', record.assignment.model)
    if (record.assignment?.effort) argv.push('--effort', record.assignment.effort)
    if (record.continuationId) argv.push('--resume', record.continuationId)
    const stream = new ReasonixEventStream({ ...record, toolBoundary, readOnly, onSessionIdentified: (sessionId, evidence) => {
      persistNativeContext(this.nativeRoot, sessionRoot, record, targetPath, sessionId)
      record.onSessionIdentified?.(sessionId, evidence)
    } })
    let streamError
    let stopPromise
    const stop = error => {
      if (streamError) return
      streamError = error
      stopPromise = Promise.resolve().then(() => this.runner.stop({ sessionId: processSessionId, reason: error.code || 'CHILD_RUNTIME_FAILURE', terminalStatus: 'FAILED' }))
      stopPromise.catch(() => {})
    }
    const input = JSON.stringify({
      mission, missionBinding: record.missionBinding,
      dispatch: core.modelVisibleDispatch(record.dispatch, { canonicalAssignment: Boolean(record.canonicalAssignment), canonicalMission: mission, missionBinding: record.missionBinding }),
      assignment: record.canonicalAssignment,
    })
    const environment = { ...record.environment, ...this.credentialEnvironment,
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
      XDG_STATE_HOME: path.join(sessionRoot, 'xdg-state'), XDG_CACHE_HOME: path.join(sessionRoot, 'xdg-cache'),
      REASONIX_HOME: home, REASONIX_STATE_HOME: path.join(sessionRoot, 'state'), REASONIX_CACHE_HOME: path.join(sessionRoot, 'cache') }
    writePrivate(path.join(home, '.env'), renderCredentials(this.connection, environment))
    const signal = record.signal || record.abortSignal
    const abort = () => stop(new ReasonixError('CHILD_CANCELLED', 'Reasonix execution was aborted'))
    if (signal?.aborted) throw new ReasonixError('CHILD_CANCELLED', 'Reasonix execution was aborted before launch')
    signal?.addEventListener('abort', abort, { once: true })
    let result
    try { result = await this.runner.run({
      executable: binding.path, argv, cwd, env: environment, stdin: input, shell: false,
      sessionId: processSessionId, reservationId: record.reservationId,
      onTransportActivity: record.onTransportActivity,
      onStdoutLine: line => {
        if (streamError) return
        try { stream.push(line) } catch (error) { stop(error) }
      },
    }) } catch (error) { stop(error) } finally { signal?.removeEventListener('abort', abort) }
    if (stopPromise) {
      let stopped
      try { stopped = await stopPromise } catch (error) {
        if (error && typeof error === 'object' && !error.cause) error.cause = streamError
        throw error
      }
      if (stopped?.drained !== true) throw new ReasonixError('PROCESS_DRAIN_TIMEOUT', 'Reasonix cancellation did not drain its owned process group')
    }
    if (streamError) throw streamError
    if (result?.processOwned !== true || result.exactArgv !== true || result.drained !== true) {
      throw new ReasonixError('PROCESS_DRAIN_TIMEOUT', 'Reasonix child did not prove owned process completion and descendant drain')
    }
    if (result.status !== 0 || result.signal) {
      throw new ReasonixError('CHILD_RUNTIME_FAILURE', 'Reasonix process failed or was cancelled after producing output', { status: result.status, signal: result.signal || null })
    }
    require('../../../scripts/harness-v2-controlled-tools.cjs').assertStopped(toolBoundary)
    const parsed = stream.finish()
    const validation = validateJsonSchema(schema, parsed.output)
    if (!validation.valid) throw new ReasonixError('CHILD_RESULT_INVALID', 'Reasonix result does not match its canonical schema', { errors: validation.errors })
    const output = core.checkerResultBoundToCommandExecutionEvidence(parsed.output, parsed, record)
    const assembled = {
      ...output, candidateHash: record.candidateHash || output.candidateHash || null,
      contextId: parsed.sessionId, transportEvidence: core.codexTransportEvidence(parsed),
      toolReceiptHashes: parsed.toolReceiptHashes,
      usage: parsed.usage, usageStreamed: typeof record.onUsageDelta === 'function',
      evidenceHashes: output.evidenceHashes || [],
      recommendation: output.recommendation || (record.logicalRole === 'route-analyst' ? output : null), completionRequested: true,
    }
    const final = record.normalizeTerminalResult ? record.normalizeTerminalResult(assembled) : assembled
    record.onTerminalResult?.(final, { rawOutputHash: parsed.rawOutputHash, eventStreamHash: parsed.eventStreamHash, sessionId: parsed.sessionId })
    return final
  }
}

module.exports = { ReasonixEventStream, ReasonixExecAdapter, nativeContextRoot, persistNativeContext, prepareReasonixBoundary }

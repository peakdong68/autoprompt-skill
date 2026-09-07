'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  ReasonixError, nativeUsage, parseTerminal, privateDirectory, readBound, renderConfig, sha256, writePrivate,
} = require('./native.js')
const core = require('../../codex/workflow/phase-budget.js')
const { validateJsonSchema } = require('../../codex/workflow/json-schema-validator.js')

// Normalize the native wire protocol at the provider boundary. The reviewed
// controller continues to own result schemas, checks, accounting, and recovery.
class ReasonixEventStream {
  constructor(record = {}) {
    this.record = record
    this.accumulator = core.createCodexJsonlAccumulator(record)
    this.hash = require('node:crypto').createHash('sha256')
    this.usage = { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 }
    this.activeTools = new Set()
    this.result = null
    this.sawUsage = false
    this.toolCount = record.priorToolCallCount || 0
  }

  emit(event) { this.accumulator.push(JSON.stringify(event)) }

  push(line) {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new ReasonixError('TRANSPORT_LIMIT_EXCEEDED', 'Reasonix event exceeds the capture limit')
    let event
    try { event = JSON.parse(line) } catch { throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix emitted invalid JSON') }
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
      this.record.onUsageDelta?.(delta, { ...this.usage })
    }
    if (event.kind === 'tool_dispatch' || event.kind === 'tool_result') {
      const tool = event.tool || {}
      if (typeof tool.id !== 'string' || !tool.id) throw new ReasonixError('TRANSPORT_INVALID', 'Reasonix tool event has no identity')
      if (event.kind === 'tool_dispatch' && (tool.partial === true || tool.refreshed === true)) return event
      const start = event.kind === 'tool_dispatch'
      if (start) {
        if (this.activeTools.has(tool.id)) throw new ReasonixError('TRANSPORT_INVALID', 'Duplicate native tool dispatch')
        this.activeTools.add(tool.id)
        this.record.onToolCallObserved?.({ attemptedCount: ++this.toolCount, continuationId: this.record.continuationId || null, itemIdHash: sha256(tool.id), itemType: tool.name, observedPhase: 'started' })
      } else if (!this.activeTools.delete(tool.id)) {
        throw new ReasonixError('TRANSPORT_INVALID', 'Native tool result has no matching dispatch')
      }
      let args
      try { args = JSON.parse(tool.args || '{}') } catch { throw new ReasonixError('TRANSPORT_INVALID', 'Native tool arguments are invalid') }
      const shell = tool.name === 'bash'
      if (!start && (tool.truncated === true || (shell && !tool.err && !Number.isSafeInteger(tool.execution?.exitCode)))) throw new ReasonixError('TOOL_OUTPUT_INCOMPLETE', 'Native command must finish in the foreground with complete captured output')
      const item = {
        id: tool.id, type: shell ? 'command_execution' : tool.readOnly ? 'mcp_tool_call' : 'file_change',
        status: start ? 'in_progress' : tool.err ? 'failed' : 'completed',
        ...(shell ? {
          command: args.command || '',
          ...(Number.isSafeInteger(tool.execution?.exitCode) ? { exit_code: tool.execution.exitCode } : {}),
          aggregated_output: tool.output || '',
        } : {}),
      }
      this.emit({ type: start ? 'item.started' : 'item.completed', item })
      if (!start && !tool.readOnly && !tool.err) this.record.onFirstProductSignal?.({ kind: 'PRODUCT_EDIT', evidenceHash: sha256(line) })
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
    return { ...this.accumulator.snapshot(), rawOutputHash: this.hash.digest('hex') }
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

class ReasonixExecAdapter {
  constructor(options = {}) {
    if (!options.runner?.run || !options.nativeRoot || !options.connection || !options.executableBinding) {
      throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix transport requires an owned runner, native root, connection, and bound executable')
    }
    Object.assign(this, options)
  }

  async launch(record) {
    const mission = core.validateCanonicalMissionLaunch(record)
    const binding = this.executableBinding
    if (sha256(readBound(binding.path)) !== binding.sha256) throw new ReasonixError('PROVIDER_UNSUPPORTED', 'Reasonix executable changed after activation')
    const execution = record.physicalExecutionPolicy
    if (!execution || execution.logicalRole !== record.logicalRole || execution.providerRole !== record.providerRole || execution.physicalRole !== record.physicalRole || !['read-only', 'workspace-write'].includes(execution.sandboxMode)) {
      throw new ReasonixError('ROLE_POLICY_DENIED', 'Reasonix dispatch has no exact physical role policy')
    }
    if (record.externalOperation && (typeof record.beforeExternalWrite !== 'function' || this.runner.supportsExternalWriteBoundary !== true)) throw new ReasonixError('EXTERNAL_WRITE_BOUNDARY_UNAVAILABLE', 'Reasonix external operations require a verified effect adapter')
    const targetPath = path.resolve(record.workingDirectory || record.cwd || this.targetPath)
    const readOnly = execution.sandboxMode === 'read-only'
    const sessionRoot = nativeContextRoot(this.nativeRoot, record, targetPath)
    const launchRoot = path.join(sessionRoot, sha256(record.reservationId))
    const checkerScratch = record.checkerScratchBoundary ? this.checkerScratchVerifier?.(record) : null
    if (record.checkerScratchBoundary && !checkerScratch) throw new ReasonixError('CHECKER_SCRATCH_BOUNDARY_INVALID', 'Missing authenticated checker scratch boundary')
    const scratchPath = checkerScratch ? targetPath : path.join(launchRoot, 'scratch')
    const external = record.externalLocalBoundary ? core.validateExplicitExternalLocalBoundary(record.externalLocalBoundary, record.canonicalAssignment, record.canonicalTargetPath || this.targetPath) : null
    const cwd = path.join(sessionRoot, 'cwd')
    privateDirectory(scratchPath)
    privateDirectory(cwd)
    const schema = core.codexProviderCanonicalOutputSchema(record, JSON.parse(readBound(this.outputSchemaResolver(record)).toString('utf8')))
    const prompt = this.rolePrompt(record.providerRole)
    const systemPrompt = [prompt, '',
      'The external controller owns all dispatch and finalization. Do not start another agent or load skills. Run commands in the foreground and wait for their exit status; do not background commands.',
      `The exact workspace for this assignment is ${JSON.stringify(targetPath)}. Use absolute paths or explicitly change the command working directory to this workspace.`,
      `Private temporary check files belong only in ${JSON.stringify(scratchPath)}.`,
      ...core.codexPrivateWorkspaceProjection(record, record.canonicalTargetPath || this.targetPath, targetPath),
      ...core.codexExplicitExternalLocalProjection(record, record.canonicalTargetPath || this.targetPath),
      ...core.codexCheckerScratchProjection(record, record.canonicalTargetPath || this.targetPath, targetPath, checkerScratch),
      'Return exactly one JSON object, without a Markdown fence, conforming to this result schema:',
      JSON.stringify(schema),
    ].join('\n')
    const home = path.join(launchRoot, 'home')
    writePrivate(path.join(home, 'config.toml'), renderConfig({ connection: this.connection, systemPrompt, targetPath, scratchPath, readOnly, checkerScratch: Boolean(checkerScratch), writableRoots: external?.writableRoots || [] }))
    const argv = ['run', '--permission-mode', 'auto', '--output-format', 'stream-json', '--dir', cwd, '--max-steps', '100']
    if (record.assignment?.model) argv.push('--model', record.assignment.model)
    if (record.assignment?.effort) argv.push('--effort', record.assignment.effort)
    if (record.continuationId) argv.push('--resume', record.continuationId)
    const stream = new ReasonixEventStream({ ...record, onSessionIdentified: (sessionId, evidence) => {
      persistNativeContext(this.nativeRoot, sessionRoot, record, targetPath, sessionId)
      record.onSessionIdentified?.(sessionId, evidence)
    } })
    let streamError
    let stopPromise
    const input = JSON.stringify({
      mission, missionBinding: record.missionBinding,
      dispatch: core.modelVisibleDispatch(record.dispatch, { canonicalAssignment: Boolean(record.canonicalAssignment), canonicalMission: mission, missionBinding: record.missionBinding }),
      assignment: record.canonicalAssignment,
    })
    const environment = { ...record.environment, ...this.credentialEnvironment,
      REASONIX_HOME: home, REASONIX_STATE_HOME: path.join(sessionRoot, 'state'), REASONIX_CACHE_HOME: path.join(sessionRoot, 'cache') }
    const result = await this.runner.run({
      executable: binding.path, argv, cwd, env: environment, stdin: input, shell: false,
      sessionId: record.sessionId, reservationId: record.reservationId,
      onTransportActivity: record.onTransportActivity,
      ...(record.externalOperation ? { beforeExternalWrite: record.beforeExternalWrite } : {}),
      onStdoutLine: line => {
        if (streamError) return
        try { stream.push(line) } catch (error) {
          streamError = error
          stopPromise = this.runner.stop({ sessionId: record.sessionId, reason: error.code, terminalStatus: 'FAILED' })
          stopPromise.catch(() => {})
        }
      },
    })
    if (stopPromise) await stopPromise
    if (streamError) throw streamError
    if (result.processOwned !== true || result.exactArgv !== true || result.drained !== true) {
      throw new ReasonixError('PROCESS_DRAIN_TIMEOUT', 'Reasonix child did not prove owned process completion and descendant drain')
    }
    const parsed = stream.finish()
    const validation = validateJsonSchema(schema, parsed.output)
    if (!validation.valid) throw new ReasonixError('CHILD_RESULT_INVALID', 'Reasonix result does not match its canonical schema', { errors: validation.errors })
    const output = core.checkerResultBoundToCommandExecutionEvidence(parsed.output, parsed, record)
    const assembled = {
      ...output, candidateHash: record.candidateHash || output.candidateHash || null,
      contextId: parsed.sessionId, transportEvidence: core.codexTransportEvidence(parsed),
      usage: parsed.usage, usageStreamed: typeof record.onUsageDelta === 'function',
      evidenceHashes: output.evidenceHashes || [],
      recommendation: output.recommendation || (record.logicalRole === 'route-analyst' ? output : null), completionRequested: true,
    }
    const final = record.normalizeTerminalResult ? record.normalizeTerminalResult(assembled) : assembled
    record.onTerminalResult?.(final, { rawOutputHash: parsed.rawOutputHash, eventStreamHash: parsed.eventStreamHash, sessionId: parsed.sessionId })
    return final
  }
}

module.exports = { ReasonixEventStream, ReasonixExecAdapter, nativeContextRoot, persistNativeContext }

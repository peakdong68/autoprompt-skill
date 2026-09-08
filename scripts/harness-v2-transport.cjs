'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const native = require('./harness-v2-native.cjs')
const controlled = require('./harness-v2-controlled-tools.cjs')
const boundary = require('./harness-v2-tool-boundary.cjs')
const core = require('../agents/codex/workflow/phase-budget.js')
const { validateJsonSchema } = require('../agents/codex/workflow/json-schema-validator.js')
const { fail, descriptor, readBound, sha256, privateDirectory, writePrivate } = native
const integer = value => Number.isSafeInteger(value) && value >= 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value)
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'find', 'ls', 'search'])
const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'apply_patch', 'notebookedit'])
function exactUsage(provider, usage) {
  if (!object(usage) || usage.estimated === true || usage.isEstimated === true || usage.source === 'estimated') fail('PROVIDER_USAGE_UNKNOWN', 'Native usage is missing or estimated')
  let input, cached, write, output, reasoning
  if (provider === 'claude') {
    input = usage.input_tokens; cached = usage.cache_read_input_tokens; write = usage.cache_creation_input_tokens; output = usage.output_tokens
    const details = usage.output_tokens_details?.thinking_tokens
    if (details !== undefined && usage.reasoning_output_tokens !== undefined && details !== usage.reasoning_output_tokens) fail('PROVIDER_USAGE_UNKNOWN', 'Claude reasoning usage fields disagree')
    reasoning = usage.reasoning_output_tokens ?? details ?? 0
  } else if (['opencode', 'kilo'].includes(provider)) {
    // Native session tokens store visible output and reasoning separately.
    // getUsage subtracts reasoning from the provider's inclusive output count.
    input = usage.input; cached = usage.cache?.read; write = usage.cache?.write; reasoning = usage.reasoning
    if (!integer(usage.output)) fail('PROVIDER_USAGE_UNKNOWN', 'Native visible output usage is missing or inexact')
    output = usage.output + reasoning
    if (usage.total !== undefined && (!integer(usage.total) || usage.total !== input + cached + write + output)) fail('PROVIDER_USAGE_UNKNOWN', 'Native usage total differs from its disjoint categories')
  } else if (provider === 'deepseek') {
    input = usage.inputTokens; output = usage.outputTokens; cached = usage.cacheReadTokens ?? 0
    write = usage.cacheWriteTokens ?? 0; reasoning = usage.reasoningTokens ?? 0
    if (!integer(usage.totalTokens) || usage.totalTokens !== input + cached + write + output) fail('PROVIDER_USAGE_UNKNOWN', 'DeepSeek usage total differs from its categories')
  } else if (['prime', 'omp', 'vscode'].includes(provider)) {
    input = usage.input; cached = usage.cacheRead; write = usage.cacheWrite; output = usage.output
    reasoning = usage.reasoning === undefined ? 0 : usage.reasoning
    if (!integer(usage.totalTokens) || usage.totalTokens !== input + cached + write + output) fail('PROVIDER_USAGE_UNKNOWN', 'Native usage total differs from its categories')
  } else fail('PROVIDER_USAGE_UNKNOWN', 'Provider has no supported billed-usage interface')
  if (![input, cached, write, output, reasoning].every(integer) || !integer(input + write) || reasoning > output) fail('PROVIDER_USAGE_UNKNOWN', 'Native usage categories are missing, inexact, or inconsistent')
  return { noncachedInput: input + write, cachedInput: cached, output, reasoning }
}
function terminalObject(text) {
  if (object(text)) return text
  try { const result = JSON.parse(text); if (object(result)) return result } catch {}
  fail('CHILD_RESULT_INVALID', 'Native terminal output must contain exactly one JSON object')
}
function textBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) fail('TRANSPORT_INVALID', 'Native content must be text or content blocks')
  return content.filter(block => block.type === 'text').map(block => {
    if (typeof block.text !== 'string') fail('TRANSPORT_INVALID', 'Invalid native text block')
    return block.text
  }).join('')
}
function piMessageIdentity(message) {
  if (!object(message)) fail('TRANSPORT_INVALID', 'Native turn has no message identity')
  const comparable = { ...message }
  // OMP decorates message_end with its local completion timestamp but emits the
  // original API message in turn_end/agent_end. It is not model content, request
  // identity, or usage; every other field must remain exactly equivalent.
  if (Object.hasOwn(comparable, 'completedAt')) {
    if (!Number.isSafeInteger(comparable.completedAt) || comparable.completedAt < 0) fail('TRANSPORT_INVALID', 'Invalid native completion timestamp')
    delete comparable.completedAt
  }
  return boundary.canonicalJson(comparable)
}
class HarnessEventStream {
  constructor(provider, record = {}) {
    this.provider = provider; this.protocol = descriptor(provider).protocol; this.record = record
    if (!this.protocol) fail('PROVIDER_UNSUPPORTED', 'Native provider has no admitted event stream', { provider, blockers: descriptor(provider).blockers })
    this.accumulator = core.createCodexJsonlAccumulator(record)
    this.hash = crypto.createHash('sha256'); this.bytes = 0; this.events = 0
    this.usage = { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 }
    this.usageByRequest = new Map(); this.activeTools = new Map(); this.completedTools = new Set()
    this.receiptVerifier = record.toolBoundary ? new controlled.ReceiptVerifier(provider, record.toolBoundary) : null
    this.claudeMessages = new Map(); this.claudeCurrent = null
    this.toolCount = record.priorToolCallCount || 0; this.sessionId = null; this.finalText = ''; this.terminal = null; this.lastMessage = null; this.activeStep = null
  }
  emit(event) { this.accumulator.push(JSON.stringify(event)) }
  session(id, event, raw) {
    if (!identity(id)) fail('SESSION_ID_MISSING', 'Native event has no exact session identity')
    if (this.sessionId && this.sessionId !== id || this.record.continuationId && this.record.continuationId !== id) fail('SESSION_ID_MISMATCH', 'Native session differs from the bound continuation')
    if (!this.sessionId) {
      this.sessionId = id; this.emit({ type: 'thread.started', thread_id: id })
      this.record.onSessionIdentified?.(id, { event, raw, occurredAt: new Date().toISOString() })
    }
  }
  account(id, usage, snapshot = false) {
    if (!identity(id)) fail('PROVIDER_USAGE_UNKNOWN', 'Native usage has no request identity')
    const next = exactUsage(this.provider, usage)
    const old = this.usageByRequest.get(id)
    if (old && !snapshot) fail('PROVIDER_USAGE_UNKNOWN', 'Duplicate native request usage')
    const delta = {}
    for (const key of Object.keys(next)) {
      delta[key] = next[key] - (old?.[key] || 0)
      if (!integer(delta[key]) || !integer(this.usage[key] + delta[key])) fail('PROVIDER_USAGE_UNKNOWN', 'Native usage regressed or overflowed')
      this.usage[key] += delta[key]
    }
    this.usageByRequest.set(id, next)
    if (Object.values(delta).some(value => value > 0) && typeof this.record.onUsageDelta === 'function') {
      const verdict = this.record.onUsageDelta(delta, { ...this.usage })
      if (!verdict || verdict.continue !== true) {
        const error = new native.HarnessError('BUDGET_EXHAUSTED', 'Scheduler denied continued native token usage')
        error.usage = { ...this.usage }
        throw error
      }
    }
  }
  startTool(id, name, args, observedPhase = 'started') {
    if (!identity(id) || typeof name !== 'string' || !object(args) || this.activeTools.has(id) || this.completedTools.has(id)) fail('TRANSPORT_INVALID', 'Invalid or duplicate native tool identity')
    const ownedName = this.receiptVerifier ? controlled.decodeToolName(this.provider, name) : null
    if (this.receiptVerifier && !ownedName) fail('ROLE_POLICY_DENIED', 'Native built-ins and foreign tools are disabled for this controlled assignment')
    const lower = ownedName || name.toLowerCase()
    const shell = lower === 'bash'
    const write = WRITE_TOOLS.has(lower)
    if (!READ_TOOLS.has(lower) && !write && !shell) fail('ROLE_POLICY_DENIED', `Native tool is outside the controller allowlist: ${name}`)
    // The fixed server independently permits checker scratch writes but never
    // candidate writes. Its hash-bound execution receipt is checked below.
    if (this.record.readOnly && write && !ownedName) fail('ROLE_POLICY_DENIED', 'Read-only native role attempted a write tool')
    if (shell && this.record.commandBoundary !== true) fail('ROLE_POLICY_DENIED', 'Native shell requires a controller-owned command boundary')
    if (shell && (typeof args.command !== 'string' || !args.command)) fail('TRANSPORT_INVALID', 'Native shell has no exact command')
    const item = { id, type: shell ? 'command_execution' : write ? 'file_change' : 'mcp_tool_call', status: 'in_progress', ...(shell ? { command: args.command } : {}) }
    this.activeTools.set(id, { item, name, args, shell, write, ownedName })
    this.record.onToolCallObserved?.({ attemptedCount: ++this.toolCount, continuationId: this.sessionId, itemIdHash: sha256(id), itemType: name, observedPhase })
    this.emit({ type: 'item.started', item })
  }
  finishTool(id, output, { error = false, exitCode, truncated = false, background = false, statusUncertain = false } = {}) {
    const tool = this.activeTools.get(id)
    if (!tool) fail('TRANSPORT_INVALID', 'Native tool result has no matching call')
    if (tool.ownedName) {
      if (truncated || background) fail('TOOL_OUTPUT_INCOMPLETE', 'Native harness changed or detached a controlled tool result')
      const result = this.receiptVerifier.verify(tool.name, tool.args, output, statusUncertain ? undefined : error)
      output = result.output; exitCode = result.exitCode; error = result.status !== 'completed'
      if (tool.shell && result.command !== tool.args.command) fail('TOOL_RECEIPT_INVALID', 'Controlled command differs from its native call')
      if (this.record.readOnly && tool.write && result.code === 'TOOL_PATH_DENIED') fail('ROLE_POLICY_DENIED', 'Read-only native role attempted to mutate its candidate')
    }
    if (typeof output !== 'string' || truncated || background || tool.shell && !Number.isSafeInteger(exitCode)) fail('TOOL_OUTPUT_INCOMPLETE', 'Native tool result lacks complete foreground output and exit evidence')
    this.activeTools.delete(id); this.completedTools.add(id)
    const item = { ...tool.item, status: error ? 'failed' : 'completed', ...(tool.shell ? { aggregated_output: output, exit_code: exitCode } : { result: output }) }
    this.emit({ type: 'item.completed', item })
    if (tool.write && !error) this.record.onFirstProductSignal?.({ kind: 'PRODUCT_EDIT', evidenceHash: sha256(JSON.stringify(item)) })
  }
  complete(text) {
    if (this.activeTools.size || this.activeStep || !this.usageByRequest.size || !this.sessionId) fail('CHILD_RESULT_MISSING', 'Native terminal lacks settled tools, exact usage, or session identity')
    this.terminal = terminalObject(text)
  }
  push(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 8 * 1024 * 1024 || (this.bytes += Buffer.byteLength(raw)) > 256 * 1024 * 1024 || ++this.events > 100000) fail('TRANSPORT_LIMIT_EXCEEDED', 'Native stream exceeds capture limits')
    let event
    try { event = JSON.parse(raw) } catch { fail('TRANSPORT_INVALID', 'Native CLI emitted invalid JSON') }
    if (!object(event) || typeof event.type !== 'string') fail('TRANSPORT_INVALID', 'Native event has no type')
    this.hash.update(`${raw}\n`); this.record.onTransportActivity?.(); this.record.onEvent?.(event, raw)
    if (this.terminal) fail('TRANSPORT_INVALID', 'Native CLI emitted data after its terminal result')
    if (this.protocol === 'claude-json') this.claude(event, raw)
    else if (this.protocol === 'opencode-json') this.opencode(event, raw)
    else if (this.protocol === 'vscode-owned-json') this.vscode(event, raw)
    else if (this.protocol === 'deepseek-json') this.deepseek(event, raw)
    else this.pi(event, raw)
    return event
  }
  claude(e, raw) {
    if (e.parent_tool_use_id) fail('ROLE_POLICY_DENIED', 'Native subagent execution is forbidden')
    if (e.session_id) this.session(e.session_id, e, raw)
    if (e.type === 'system' && e.subtype === 'init') { this.session(e.session_id, e, raw); return }
    if (e.type === 'system' && e.subtype === 'status' && (e.status === 'requesting' || e.status === null)) return
    // Native Claude emits thinking progress separately from billed usage.
    // Preserve it in the event journal but charge only the final receipt.
    if (e.type === 'system' && e.subtype === 'thinking_tokens') return
    if (e.type === 'stream_event') { this.claudeStream(e.event); return }
    if (e.type === 'assistant') {
      const m = e.message
      if (!object(m) || m.role !== 'assistant' || !identity(m.id) || !Array.isArray(m.content)) fail('TRANSPORT_INVALID', 'Invalid Claude assistant message')
      if (e.error || m.stop_reason === 'max_tokens' || m.stop_reason === 'refusal') fail('CHILD_RUNTIME_FAILURE', 'Claude assistant stopped without completion')
      const streamed = this.claudeMessages.get(m.id)
      // Claude can expose only provisional usage on streamed events. Its final
      // result receipt is the authoritative aggregate: do not turn a null
      // provisional cache counter into a zero, and do not debit an incomplete
      // request before that receipt can reconcile the whole session.
      if (!streamed || !streamed.snapshots.has(JSON.stringify(m.usage))) {
        fail('PROVIDER_USAGE_UNKNOWN', 'Claude assistant snapshot has no matching streamed request usage')
      }
      for (const block of m.content) {
        if (block.type === 'tool_use') this.startTool(block.id, block.name, block.input)
        else if (!['text', 'thinking', 'redacted_thinking'].includes(block.type)) fail('TRANSPORT_INVALID', 'Unknown Claude content block')
      }
      return
    }
    if (e.type === 'user') {
      if (!Array.isArray(e.message?.content)) fail('TRANSPORT_INVALID', 'Invalid Claude tool result message')
      for (const block of e.message.content) {
        if (block.type !== 'tool_result') fail('TRANSPORT_INVALID', 'Unexpected Claude user content')
        const info = e.tool_use_result || {}
        this.finishTool(block.tool_use_id, textBlocks(block.content), { error: block.is_error === true, exitCode: info.exitCode, truncated: info.truncated === true, background: Boolean(info.backgroundTaskId) })
      }
      return
    }
    if (e.type === 'result') {
      this.session(e.session_id, e, raw)
      if (e.subtype !== 'success' || e.is_error !== false || this.claudeCurrent ||
          [...this.claudeMessages.values()].some(message => !message.stopped) || e.subagent_stats?.spawned > 0) fail('CHILD_RUNTIME_FAILURE', 'Claude terminal is not successful or has unaccounted native work')
      const total = exactUsage(this.provider, e.usage)
      // Complete streamed request snapshots are useful corroboration, but
      // OpenRouter may leave some snapshots provisional. Compare every
      // complete snapshot against the aggregate and require equality only
      // when the stream completed every request's accounting.
      const streamed = { noncachedInput: 0, cachedInput: 0, output: 0, reasoning: 0 }
      let completeSnapshots = 0
      for (const message of this.claudeMessages.values()) {
        try {
          const usage = exactUsage(this.provider, message.usage)
          for (const key of Object.keys(streamed)) streamed[key] += usage[key]
          completeSnapshots++
        } catch (error) {
          if (error.code !== 'PROVIDER_USAGE_UNKNOWN') throw error
        }
      }
      if (Object.keys(total).some(key => streamed[key] > total[key]) ||
          completeSnapshots === this.claudeMessages.size && Object.keys(total).some(key => streamed[key] !== total[key])) {
        fail('PROVIDER_USAGE_UNKNOWN', 'Claude streamed usage contradicts the authoritative result receipt')
      }
      this.account(`claude-result:${this.sessionId}`, e.usage)
      if (Object.keys(total).some(key => total[key] !== this.usage[key])) fail('PROVIDER_USAGE_UNKNOWN', 'Claude terminal usage differs from the authoritative receipt')
      this.complete(e.structured_output || e.result); return
    }
    fail('TRANSPORT_INVALID', `Unsupported Claude event: ${e.type}/${e.subtype || ''}`)
  }
  claudeStream(event) {
    if (!object(event) || typeof event.type !== 'string') fail('TRANSPORT_INVALID', 'Claude stream event has no type')
    if (event.type === 'message_start') {
      const message = event.message
      if (this.claudeCurrent || !object(message) || message.role !== 'assistant' ||
          !identity(message.id) || this.claudeMessages.has(message.id)) fail('TRANSPORT_INVALID', 'Overlapping or duplicate Claude request identity')
      const state = { id: message.id, usage: { ...message.usage }, snapshots: new Set(), blocks: new Map(), stopReason: null, stopped: false }
      if (!object(state.usage)) fail('PROVIDER_USAGE_UNKNOWN', 'Claude streamed request has no usage snapshot')
      state.snapshots.add(JSON.stringify(state.usage))
      this.claudeMessages.set(state.id, state); this.claudeCurrent = state
      return
    }
    const state = this.claudeCurrent
    if (!state) fail('TRANSPORT_INVALID', 'Claude stream event is outside an active request')
    if (event.type === 'message_delta') {
      if (!object(event.usage) || !object(event.delta)) fail('PROVIDER_USAGE_UNKNOWN', 'Claude message delta lacks exact usage')
      const merged = { ...state.usage, ...event.usage }
      state.usage = merged; state.snapshots.add(JSON.stringify(merged))
      if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) state.stopReason = event.delta.stop_reason
      return
    }
    if (event.type === 'message_stop') {
      if (![...state.blocks.values()].every(block => block.stopped) || !['end_turn', 'tool_use', 'stop_sequence'].includes(state.stopReason)) {
        fail('CHILD_RUNTIME_FAILURE', 'Claude request ended with unfinished blocks or without a successful stop reason')
      }
      this.finalText = [...state.blocks.values()].filter(block => block.type === 'text').map(block => block.text).join('')
      state.stopped = true; this.claudeCurrent = null
      return
    }
    if (!integer(event.index)) fail('TRANSPORT_INVALID', 'Claude content block has no exact index')
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (state.blocks.has(event.index) || !object(block) || !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type)) {
        fail('TRANSPORT_INVALID', 'Invalid or duplicate Claude content block')
      }
      state.blocks.set(event.index, { ...block, text: block.type === 'text' ? block.text : '', stopped: false })
      return
    }
    const block = state.blocks.get(event.index)
    if (!block || block.stopped) fail('TRANSPORT_INVALID', 'Claude content block is not active')
    if (event.type === 'content_block_stop') { block.stopped = true; return }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (!object(delta) || !['text_delta', 'input_json_delta', 'thinking_delta', 'signature_delta'].includes(delta.type)) fail('TRANSPORT_INVALID', 'Unknown Claude content delta')
      if (delta.type === 'text_delta') {
        if (block.type !== 'text' || typeof delta.text !== 'string') fail('TRANSPORT_INVALID', 'Claude text delta does not match its block')
        block.text += delta.text
      }
      return
    }
    fail('TRANSPORT_INVALID', `Unsupported Claude stream event: ${event.type}`)
  }
  opencode(e, raw) {
    this.session(e.sessionID, e, raw)
    if (e.type === 'error') fail('CHILD_RUNTIME_FAILURE', 'Native session error')
    const p = e.part
    if (!object(p) || p.sessionID !== this.sessionId || !identity(p.id) || !identity(p.messageID)) fail('TRANSPORT_INVALID', 'Native part is not bound to this session/message')
    if (e.type === 'step_start' && p.type === 'step-start') {
      if (this.activeStep) fail('TRANSPORT_INVALID', 'Overlapping native steps')
      this.activeStep = p.messageID; this.finalText = ''; return
    }
    if (!this.activeStep || p.messageID !== this.activeStep) fail('TRANSPORT_INVALID', 'Native event is outside its active step')
    if (e.type === 'text' && p.type === 'text') {
      if (typeof p.text !== 'string' || !Number.isFinite(p.time?.end) || p.synthetic || p.ignored) fail('TRANSPORT_INVALID', 'Native text has no completed provider evidence')
      this.finalText += p.text; return
    }
    if (e.type === 'reasoning' && p.type === 'reasoning') return
    if (e.type === 'tool_use' && p.type === 'tool') {
      const s = p.state
      if (!s || !['completed', 'error'].includes(s.status) || !Number.isFinite(s.time?.start) || !Number.isFinite(s.time?.end) || s.time.end < s.time.start) fail('TOOL_OUTPUT_INCOMPLETE', 'Native tool lacks a settled execution interval')
      // CLI publishes completed tool parts only. Record this honestly as a
      // completed observation, not a real-time pre-execution admission.
      this.startTool(p.callID, p.tool, s.input, 'completed')
      this.finishTool(p.callID, s.status === 'error' ? s.error : s.output, { error: s.status === 'error', statusUncertain: s.status !== 'error', exitCode: s.metadata?.exit, truncated: s.metadata?.truncated === true || s.time.compacted !== undefined, background: Boolean(s.metadata?.background) })
      return
    }
    if (e.type === 'step_finish' && p.type === 'step-finish') {
      this.account(p.id, p.tokens); this.activeStep = null
      if (p.reason === 'stop') this.complete(this.finalText)
      else if (p.reason !== 'tool-calls') fail('CHILD_RUNTIME_FAILURE', `Native step ended with ${p.reason}`)
      return
    }
    fail('TRANSPORT_INVALID', `Unsupported native CLI event: ${e.type}`)
  }
  deepseek(frame, raw) {
    if (frame.type !== 'deepseek' || !object(frame.params)) fail('TRANSPORT_INVALID', 'Invalid owned DeepSeek frame')
    const params = frame.params
    this.session(params.sessionId, frame, raw)
    if (frame.method === 'session.status') {
      if (params.status === 'running') return
      if (params.status === 'idle' && this.deepseekTurnEnded) { this.complete(this.finalText); return }
      fail('TRANSPORT_INVALID', 'DeepSeek status did not settle a completed turn')
    }
    if (frame.method !== 'session.event') fail('ROLE_POLICY_DENIED', 'DeepSeek nested execution is forbidden')
    const e = params.event, d = e?.data
    if (!object(e) || !object(d) || !integer(e.seq) || this.deepseekSeq !== undefined && e.seq !== this.deepseekSeq + 1) fail('TRANSPORT_INVALID', 'DeepSeek event sequence is incomplete')
    this.deepseekSeq = e.seq
    if (e.type === 'turn/start') {
      if (this.turnStarted || !integer(d.turn)) fail('TRANSPORT_INVALID', 'DeepSeek turn overlaps')
      this.turnStarted = d.turn; return
    }
    if (e.type === 'step/start') {
      if (!this.turnStarted || d.turn !== this.turnStarted || this.activeStep || !integer(d.step)) fail('TRANSPORT_INVALID', 'DeepSeek step overlaps')
      this.activeStep = `${d.turn}:${d.step}`; this.finalText = ''; return
    }
    if (e.type === 'assistant/chunk') {
      if (this.activeStep !== `${d.turn}:${d.step}`) fail('TRANSPORT_INVALID', 'DeepSeek chunk is outside its step')
      if (d.chunk?.type === 'usage') this.account(this.activeStep, d.chunk.usage, this.usageByRequest.has(this.activeStep))
      return
    }
    if (e.type === 'assistant/message') {
      if (this.activeStep !== `${d.turn}:${d.step}` || d.interrupted || d.message?.role !== 'assistant') fail('CHILD_RUNTIME_FAILURE', 'DeepSeek assistant message is incomplete')
      const observed = this.usageByRequest.get(this.activeStep), final = exactUsage('deepseek', d.usage)
      if (!observed || Object.keys(final).some(key => final[key] !== observed[key])) fail('PROVIDER_USAGE_UNKNOWN', 'DeepSeek assembled usage differs from its native stream')
      this.finalText = textBlocks(d.message.content); return
    }
    if (e.type === 'tool/call') {
      if (this.activeStep !== `${d.turn}:${d.step}`) fail('TRANSPORT_INVALID', 'DeepSeek tool is outside its step')
      let args; try { args = JSON.parse(d.arguments) } catch { fail('TRANSPORT_INVALID', 'DeepSeek tool arguments are invalid JSON') }
      this.startTool(d.callId, d.name, args); return
    }
    if (e.type === 'tool/result') {
      const block = d.message?.content?.[0]
      if (this.activeStep !== `${d.turn}:${d.step}` || d.message?.content?.length !== 1 || block?.type !== 'tool-result') fail('TRANSPORT_INVALID', 'DeepSeek tool result is incomplete')
      this.finishTool(block.toolCallId, textBlocks(block.content), { error: Boolean(d.error || block.isError), statusUncertain: !d.error && !block.isError }); return
    }
    if (e.type === 'step/end') {
      if (this.activeStep !== `${d.turn}:${d.step}` || this.activeTools.size || !this.usageByRequest.has(this.activeStep)) fail('TRANSPORT_INVALID', 'DeepSeek step did not settle tools and usage')
      this.activeStep = null; return
    }
    if (e.type === 'turn/end') {
      if (d.turn !== this.turnStarted || d.reason?.kind !== 'completed' || this.activeStep) fail('CHILD_RUNTIME_FAILURE', 'DeepSeek turn did not complete')
      this.turnStarted = false; this.deepseekTurnEnded = true; return
    }
    if (['agent/inbox/spliced', 'user/message', 'session/title', 'request/header', 'request/context'].includes(e.type)) return
    fail('TRANSPORT_INVALID', `Unsupported DeepSeek event: ${e.type}`)
  }
  vscode(e, raw) {
    if (e.type === 'owned.session') { if (e.contextKind !== 'autoprompt-extension') fail('SESSION_ID_MISMATCH', 'VS Code session is not owned by this extension'); this.session(e.sessionId, e, raw); return }
    if (e.type === 'owned.usage') { this.account(e.requestId, e.usage); return }
    if (e.type === 'owned.tool.start') { this.startTool(e.id, e.name, e.args); return }
    if (e.type === 'owned.tool.end') { this.finishTool(e.id, e.output, { error: e.error }); return }
    if (e.type === 'owned.result') { this.complete(e.output); return }
    if (e.type === 'owned.error') fail(e.code || 'CHILD_RUNTIME_FAILURE', 'Owned VS Code session failed', { message: e.message })
    fail('TRANSPORT_INVALID', 'Unknown owned VS Code event')
  }
  pi(e, raw) {
    if (e.type === 'session') { this.session(e.id, e, raw); return }
    if (!this.sessionId) fail('SESSION_ID_MISSING', 'Native events preceded the session header')
    if (e.type === 'agent_start') { if (this.agentStarted) fail('TRANSPORT_INVALID', 'Duplicate native agent start'); this.agentStarted = true; return }
    if (!this.agentStarted) fail('TRANSPORT_INVALID', 'Native event preceded agent start')
    if (e.type === 'turn_start') { if (this.turnStarted) fail('TRANSPORT_INVALID', 'Overlapping native turns'); this.turnStarted = true; this.lastMessage = null; return }
    if (e.type === 'message_start') { if (!object(e.message)) fail('TRANSPORT_INVALID', 'Missing native message'); return }
    if (e.type === 'message_update') {
      if (!object(e.assistantMessageEvent) || !['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done'].includes(e.assistantMessageEvent.type)) fail('TRANSPORT_INVALID', 'Unknown or failed native message update')
      return
    }
    if (e.type === 'message_end') {
      const m = e.message
      if (!object(m)) fail('TRANSPORT_INVALID', 'Missing native completed message')
      if (m.role === 'assistant') {
        if (!this.turnStarted || !['stop', 'toolUse'].includes(m.stopReason)) fail('CHILD_RUNTIME_FAILURE', 'Native assistant stopped without successful evidence')
        this.messageNumber = (this.messageNumber || 0) + 1
        const key = `message-${this.messageNumber}`
        this.account(key, m.usage); this.lastMessage = m; this.finalText = textBlocks(m.content)
      } else if (!['user', 'toolResult'].includes(m.role)) fail('TRANSPORT_INVALID', 'Unknown native message role')
      return
    }
    if (e.type === 'tool_execution_start') { this.startTool(e.toolCallId, e.toolName, e.args); return }
    if (e.type === 'tool_execution_update' || e.type === 'tool_stream_update') {
      if (!this.activeTools.has(e.toolCallId)) fail('TRANSPORT_INVALID', 'Native tool update without matching dispatch')
      return
    }
    if (e.type === 'tool_execution_end') {
      const r = e.result
      this.finishTool(e.toolCallId, textBlocks(r?.content), { error: e.isError === true, exitCode: r?.details?.exitCode, truncated: Boolean(r?.details?.truncation) || r?.details?.truncated === true, background: Boolean(r?.details?.backgrounded || r?.details?.backgroundTaskId) }); return
    }
    if (e.type === 'turn_end') {
      if (!this.turnStarted || !this.lastMessage || piMessageIdentity(e.message) !== piMessageIdentity(this.lastMessage) || this.activeTools.size) fail('TRANSPORT_INVALID', 'Native turn did not settle the observed message and tools')
      this.turnStarted = false; return
    }
    if (e.type === 'agent_end') {
      if (this.turnStarted || !this.lastMessage || this.lastMessage.stopReason !== 'stop' || !Array.isArray(e.messages)) fail('CHILD_RESULT_MISSING', 'Native agent ended without a complete final turn')
      const last = [...e.messages].reverse().find(m => m.role === 'assistant')
      if (piMessageIdentity(last) !== piMessageIdentity(this.lastMessage)) fail('TRANSPORT_INVALID', 'Native agent terminal differs from its streamed message')
      this.complete(this.finalText); return
    }
    // Compaction, retry, queue changes and advisor events need separate usage
    // and ownership accounting. Never silently discard them as progress.
    fail('TRANSPORT_INVALID', `Unsupported native lifecycle event: ${e.type}`)
  }
  finish() {
    if (!this.terminal || this.activeTools.size || this.activeStep) fail('CHILD_RESULT_MISSING', 'Native process exited without a successful settled terminal')
    const toolReceiptHashes = this.receiptVerifier?.finish()
    this.emit({ type: 'item.completed', item: { id: `${this.provider}-terminal`, type: 'agent_message', text: JSON.stringify(this.terminal) } })
    this.emit({ type: 'turn.completed', usage: { input_tokens: this.usage.noncachedInput + this.usage.cachedInput, cached_input_tokens: this.usage.cachedInput, output_tokens: this.usage.output, reasoning_output_tokens: this.usage.reasoning } })
    return { ...this.accumulator.snapshot(), rawOutputHash: this.hash.copy().digest('hex'), ...(toolReceiptHashes ? { toolReceiptHashes } : {}) }
  }
}
function contextRoot(nativeRoot, provider, record, targetPath) {
  if (!record.continuationId) return path.join(nativeRoot, provider, sha256(record.sessionId))
  if (!identity(record.continuationId)) fail('SESSION_ID_MISMATCH', 'Invalid native continuation identity')
  let saved
  try { saved = JSON.parse(readBound(path.join(nativeRoot, 'contexts', `${sha256(record.continuationId)}.json`))) } catch { fail('SESSION_ID_MISMATCH', 'Native continuation has no private context binding') }
  if (saved.provider !== provider || saved.sessionId !== record.continuationId || saved.providerRole !== record.providerRole || saved.targetPath !== targetPath || !/^[a-f0-9]{64}$/.test(saved.rootKey)) fail('SESSION_ID_MISMATCH', 'Native continuation differs from its provider, role, or workspace')
  return path.join(nativeRoot, provider, saved.rootKey)
}
function persistContext(nativeRoot, sessionRoot, provider, record, targetPath, sessionId) {
  const file = path.join(nativeRoot, 'contexts', `${sha256(sessionId)}.json`)
  const saved = { sessionId, provider, providerRole: record.providerRole, targetPath, rootKey: path.basename(sessionRoot) }
  if (fs.existsSync(file)) {
    if (JSON.stringify(JSON.parse(readBound(file))) !== JSON.stringify(saved)) fail('SESSION_ID_MISMATCH', 'Native session is already bound to a different assignment')
  } else writePrivate(file, JSON.stringify(saved))
}
class HarnessExecAdapter {
  constructor(options = {}) {
    descriptor(options.provider)
    if (!options.runner?.run || !options.runner?.stop || !options.nativeRoot || !options.executableBinding || !(options.connection || options.config) || typeof options.rolePrompt !== 'function' || typeof options.outputSchemaResolver !== 'function') fail('PROVIDER_UNSUPPORTED', 'Native transport requires an owned runner, binding, configuration, role prompt, and schema resolver')
    Object.assign(this, options); this.connection = options.connection || options.config
  }
  async launch(record) {
    const d = descriptor(this.provider)
    if (d.blockers.length) fail('PROVIDER_UNSUPPORTED', 'Provider has unresolved native transport capabilities', { provider: this.provider, blockers: d.blockers })
    const mission = core.validateCanonicalMissionLaunch(record)
    const binding = this.executableBinding
    if (binding.provider !== this.provider || native.executableSha256(binding.path) !== binding.sha256) fail('PROVIDER_IDENTITY_MISMATCH', 'Native executable differs from its activation binding')
    if (binding.runtimeIdentity && JSON.stringify(native.runtimeDependencyIdentity(binding.path, record.environment || process.env)) !== JSON.stringify(binding.runtimeIdentity)) fail('PROVIDER_IDENTITY_MISMATCH', 'Native runtime dependencies changed after activation')
    const execution = record.physicalExecutionPolicy
    if (!execution || execution.logicalRole !== record.logicalRole || execution.providerRole !== record.providerRole || execution.physicalRole !== record.physicalRole || !['read-only', 'workspace-write'].includes(execution.sandboxMode)) fail('ROLE_POLICY_DENIED', 'Native dispatch lacks an exact physical role policy')
    if (record.externalOperation) fail('EXTERNAL_WRITE_BOUNDARY_UNAVAILABLE', 'Native adapters do not admit external effects')
    // A boolean on a supplied runner is not enforcement. Use the shared real
    // process owner and the fixed private tool server, whose commands execute
    // in an independently probed OS sandbox and whose receipts are reopened.
    if (!controlled.PROVIDERS.includes(this.provider) || !(this.runner instanceof core.OwnedCodexProxyRunner)) {
      fail('NATIVE_EXECUTION_BOUNDARY_UNAVAILABLE', 'Native execution requires the owned process runner and a controlled tool projection')
    }
    const sandbox = await boundary.probeCommandSandbox()
    if (!sandbox.supported) fail('NATIVE_EXECUTION_BOUNDARY_UNAVAILABLE', 'The controller command sandbox is unavailable', sandbox)
    const targetPath = path.resolve(record.workingDirectory || record.cwd || this.targetPath)
    const readOnly = execution.sandboxMode === 'read-only'
    const sessionRoot = contextRoot(this.nativeRoot, this.provider, record, targetPath)
    const launchRoot = path.join(sessionRoot, sha256(record.reservationId))
    const cwd = path.join(sessionRoot, 'cwd'); privateDirectory(cwd)
    const checkerScratch = record.checkerScratchBoundary ? this.checkerScratchVerifier?.(record) : null
    if (record.checkerScratchBoundary && !checkerScratch) fail('CHECKER_SCRATCH_BOUNDARY_INVALID', 'Native checker scratch boundary is not authenticated')
    const scratchPath = checkerScratch ? targetPath : path.join(launchRoot, 'scratch'); privateDirectory(scratchPath)
    const candidatePath = checkerScratch ? path.resolve(checkerScratch.frozenCandidateRoot) : targetPath
    if (checkerScratch && path.resolve(checkerScratch.writableScratchRoot) !== scratchPath) fail('CHECKER_SCRATCH_BOUNDARY_INVALID', 'Native checker scratch differs from its authenticated working directory')
    if (record.logicalRole === 'independent-checker' && (!readOnly || execution.canDispatch !== false ||
        !execution.resourceSets || !Array.isArray(execution.resourceSets.write) ||
        !Array.isArray(execution.resourceSets.exclusive) || execution.resourceSets.write.length || execution.resourceSets.exclusive.length)) {
      fail('CHECKER_READ_ONLY_POLICY_REQUIRED', 'Native independent checking requires a read-only, closed role policy')
    }
    const toolRoot = path.join(launchRoot, 'tool-control')
    privateDirectory(toolRoot)
    const toolBoundary = boundary.prepareBoundary({ provider: this.provider, root: toolRoot,
      policy: { sessionId: record.sessionId, reservationId: record.reservationId, readOnly,
        targetPath: candidatePath, scratchPath, readableRoots: [candidatePath, scratchPath],
        writableRoots: readOnly ? [scratchPath] : [candidatePath, scratchPath],
        nestedDispatch: false, commandBoundary: true, externalWrites: false } })
    const schema = core.codexProviderCanonicalOutputSchema(record, JSON.parse(readBound(this.outputSchemaResolver(record))))
    const prompt = [this.rolePrompt(record.providerRole), 'The external controller owns dispatch and finalization. Do not load skills, start agents, or run background commands.', `Assignment workspace: ${JSON.stringify(targetPath)}. Use absolute paths.`, `Private scratch: ${JSON.stringify(scratchPath)}.`, ...core.codexPrivateWorkspaceProjection(record, record.canonicalTargetPath || this.targetPath, targetPath), ...core.codexExplicitExternalLocalProjection(record, record.canonicalTargetPath || this.targetPath), ...core.codexCheckerScratchProjection(record, record.canonicalTargetPath || this.targetPath, targetPath, checkerScratch), 'Return one JSON object conforming to this schema:', JSON.stringify(schema)].join('\n')
    const input = JSON.stringify({ mission, missionBinding: record.missionBinding, dispatch: core.modelVisibleDispatch(record.dispatch, { canonicalAssignment: Boolean(record.canonicalAssignment), canonicalMission: mission, missionBinding: record.missionBinding }), assignment: record.canonicalAssignment })
    const commandBoundary = true
    const spec = native.createLaunch({ provider: this.provider, executable: binding.path, home: path.join(launchRoot, 'home'), sessionRoot, cwd, targetPath: candidatePath, readOnly, commandBoundary, toolBoundary, prompt, input, continuationId: record.continuationId, connection: this.connection, credentials: this.credentialEnvironment, environment: record.environment, model: record.assignment?.model, effort: record.assignment?.effort })
    // Native configuration isolation discards inherited control-looking fields.
    // Recreate the owner's reservation marker from its trusted adapter only
    // after the complete child environment has been projected.
    spec.env = require('../agents/codex/workflow/process-owner.js').prepareProcessLaunchEnvironment(
      this.runner.processOwner.adapter, record.reservationId, spec.env)
    // Native conversation identity survives a resume; physical process/session
    // ownership never does. Bind the latter to this exact fresh reservation.
    const processSessionId = `native-${this.provider}-${sha256(JSON.stringify([record.sessionId, record.reservationId]))}`
    const stream = new HarnessEventStream(this.provider, { ...record, readOnly, commandBoundary, toolBoundary, onSessionIdentified: (id, evidence) => { persistContext(this.nativeRoot, sessionRoot, this.provider, record, targetPath, id); record.onSessionIdentified?.(id, evidence) } })
    let streamError, stopPromise
    const stop = error => {
      if (streamError) return
      streamError = error
      stopPromise = Promise.resolve().then(() => this.runner.stop({ sessionId: processSessionId, reason: error.code || 'CHILD_RUNTIME_FAILURE', terminalStatus: 'FAILED' }))
      stopPromise.catch(() => {})
    }
    const signal = record.signal || record.abortSignal
    const abort = () => stop(new native.HarnessError('CHILD_CANCELLED', 'Native execution was aborted'))
    if (signal?.aborted) throw new native.HarnessError('CHILD_CANCELLED', 'Native execution was aborted before launch')
    signal?.addEventListener('abort', abort, { once: true })
    let result
    try {
      result = await this.runner.run({ ...spec, executable: binding.path, sessionId: processSessionId, reservationId: record.reservationId, onTransportActivity: record.onTransportActivity, onStdoutLine: line => { if (!streamError) try { if (this.provider === 'vscode') { const marker = line.indexOf('AUTOPROMPT_EVENT '); if (marker < 0) return; line = line.slice(marker + 'AUTOPROMPT_EVENT '.length) } stream.push(line) } catch (error) { stop(error) } } })
    } catch (error) { stop(error) } finally { signal?.removeEventListener('abort', abort) }
    if (stopPromise) {
      const stopped = await stopPromise
      if (stopped?.drained !== true) fail('PROCESS_DRAIN_TIMEOUT', 'Native cancellation did not drain its owned process group')
    }
    if (streamError) throw streamError
    if (result?.processOwned !== true || result.exactArgv !== true || result.drained !== true) fail('PROCESS_DRAIN_TIMEOUT', 'Native child lacks owned process completion and descendant drain')
    controlled.assertStopped(toolBoundary)
    if ((result.exitCode ?? result.status) !== 0 || result.exitCode !== undefined && result.status !== undefined && result.exitCode !== result.status || result.signal || result.aborted) fail('CHILD_RUNTIME_FAILURE', 'Native child exited unsuccessfully', { exitCode: result.exitCode, signal: result.signal })
    const parsed = stream.finish()
    const validation = validateJsonSchema(schema, parsed.output)
    if (!validation.valid) fail('CHILD_RESULT_INVALID', 'Native result does not match the canonical schema', { errors: validation.errors })
    const output = core.checkerResultBoundToCommandExecutionEvidence(parsed.output, parsed, record)
    const assembled = { ...output, candidateHash: record.candidateHash || output.candidateHash || null, contextId: parsed.sessionId, transportEvidence: core.codexTransportEvidence(parsed),
      toolBoundaryEvidence: { policySha256: toolBoundary.policySha256, receiptHashes: parsed.toolReceiptHashes },
      usage: parsed.usage, usageStreamed: typeof record.onUsageDelta === 'function', evidenceHashes: output.evidenceHashes || [], recommendation: output.recommendation || (record.logicalRole === 'route-analyst' ? output : null), completionRequested: true }
    const final = record.normalizeTerminalResult ? record.normalizeTerminalResult(assembled) : assembled
    record.onTerminalResult?.(final, { rawOutputHash: parsed.rawOutputHash, eventStreamHash: parsed.eventStreamHash, sessionId: parsed.sessionId })
    return final
  }
}
module.exports = { HarnessExecAdapter, HarnessEventStream, exactUsage, terminalObject, contextRoot, persistContext }

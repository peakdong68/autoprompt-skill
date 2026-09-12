'use strict'
const assert=require('node:assert/strict'),test=require('node:test')
const {createRequestQuota}=require('../../scripts/harness-v2-request-quota.cjs')
function record(limit=10000){const starts=[],settles=[],unknown=[];return {providerTokenLimit:limit,priorLeaseModelTokens:0,onUsageDelta(){},onProviderRequestStarted:e=>starts.push(e),onProviderRequestSettled:e=>settles.push(e),onUnknownProviderSpend:e=>unknown.push(e),starts,settles,unknown}}
const body=(messages,max_tokens=100)=>({model:'m',stream:true,messages,max_tokens})
const admit=(quota,value,cumulative={noncachedInput:0,cachedInput:0,output:0})=>quota.admit({rawBody:JSON.stringify(value),body:value,cumulative})
test('request quota denies an unaffordable first request before provider handoff',()=>{const r=record(20),q=createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'});assert.throws(()=>admit(q,body([{role:'user',content:'x'}],10)),{code:'CHILD_TOKEN_LIMIT_EXHAUSTED'});assert.deepEqual(r.starts,[])})
test('request quota clamps output and binds a durable pending envelope for default nonfinite workers',()=>{const r={...record(1000),finiteTokenBudget:false};const q=createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'});const a=admit(q,body([{role:'user',content:'x'}],999));assert.ok(a.body.max_tokens<999);assert.equal(a.evidence.maximumUnaccountedTokens,1000);assert.equal(a.providerEvidence,a.evidence);assert.equal(r.starts.length,1);const settled=q.settle(a,{noncachedInput:1,cachedInput:0,output:1});assert.equal(settled.providerEvidence,a.evidence);assert.equal(r.settles[0].disposition,'ACCOUNTED')})
test('request quota requires every durable accounting hook before admission',()=>{const r=record();delete r.onUnknownProviderSpend;assert.throws(()=>createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'}),{code:'PROVIDER_UNSUPPORTED'})})
test('request quota accepts an exact raw-byte bound when a relay retains parsed input separately',()=>{const r=record(2000),q=createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'}),value=body([{role:'user',content:'x'}],20),a=q.admit({rawBytes:333,body:value,cumulative:{noncachedInput:0,cachedInput:0,output:0}});assert.equal(a.inputTokens,333+128);assert.equal(typeof a.rawBody,'string')})
test('request quota rejects an exact output that exceeds its admitted cap after debit',()=>{const r=record(1000),q=createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'}),a=admit(q,body([{role:'user',content:'x'}],999));assert.throws(()=>q.settle(a,{noncachedInput:1,cachedInput:0,output:a.snapshot.cappedOutput+1}),{code:'CODEX_CHILD_QUOTA_BOUND_VIOLATED'});q.unknown({code:'OVER_CAP'});assert.equal(r.unknown.length,1)})
test('request quota admits bounded text and native tool history only',()=>{
  const r=record(4000), chat=createRequestQuota({record:r,protocol:'chat-completions',maxOutputField:'max_tokens'})
  assert.throws(()=>admit(chat,{model:'m',stream:true,max_tokens:1,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.invalid/x'}}]}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  assert.throws(()=>admit(chat,{model:'m',stream:true,max_tokens:1,n:2,messages:[{role:'user',content:'x'}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  assert.throws(()=>admit(chat,{model:'m',stream:true,max_tokens:1,messages:[{role:'user',content:[{type:'text',text:'x',image_url:{url:'https://example.invalid/x'}}]}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  assert.throws(()=>admit(chat,{model:'m',stream:true,max_tokens:1,tools:[{type:'web_search'}],messages:[{role:'user',content:'x'}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  const ownedTool=admit(chat,{model:'m',stream:true,max_tokens:1,tools:[{type:'function',function:{name:'owned',parameters:{type:'object'}}}],messages:[{role:'user',content:'x'}]})
  chat.settle(ownedTool,{noncachedInput:1,cachedInput:0,output:0})
  const tool=admit(chat,{model:'m',stream:true,max_tokens:1,messages:[{role:'assistant',content:null,tool_calls:[{id:'call-1',type:'function',function:{name:'owned',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'ok'}]})
  chat.settle(tool,{noncachedInput:1,cachedInput:0,output:0})
  const responses=createRequestQuota({record:record(4000),protocol:'responses',maxOutputField:'max_output_tokens',itemField:'input'})
  assert.throws(()=>admit(responses,{model:'m',max_output_tokens:1,previous_response_id:'remote',input:[{type:'message',role:'user',content:[{type:'input_text',text:'x'}]}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  assert.throws(()=>admit(responses,{model:'m',max_output_tokens:1,prompt:{id:'server-template'},input:[{type:'message',role:'user',content:[{type:'input_text',text:'x'}]}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  assert.throws(()=>admit(responses,{model:'m',max_output_tokens:1,plugins:[{id:'server-plugin'}],input:[{type:'message',role:'user',content:[{type:'input_text',text:'x'}]}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  const anthropic=createRequestQuota({record:record(4000),protocol:'anthropic-messages',maxOutputField:'max_tokens'})
  assert.throws(()=>admit(anthropic,{model:'m',max_tokens:1,mcp_servers:[{url:'https://example.invalid'}],messages:[{role:'user',content:'x'}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  const admitted=admit(anthropic,{model:'m',max_tokens:1,messages:[{role:'assistant',content:[{type:'tool_use',id:'use-1',name:'owned',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'use-1',content:'ok'}]}]})
  assert.ok(admitted)
})
test('request quota accepts only bounded Claude replay thinking with its signature',()=>{
  const quota=createRequestQuota({record:record(4000),protocol:'anthropic-messages',maxOutputField:'max_tokens'})
  const replay={role:'assistant',content:[{type:'thinking',thinking:'bounded private reasoning',signature:''}]}
  const admitted=admit(quota,{model:'fixture',stream:true,max_tokens:2,messages:[replay,{role:'user',content:'continue'}]})
  quota.settle(admitted,{noncachedInput:1,cachedInput:0,output:0})
  for (const block of [
    {type:'thinking',thinking:'x'},
    {type:'thinking',thinking:'x',signature:'s'},
    {type:'thinking',thinking:'x',signature:'',data:'opaque'},
    {type:'thinking',thinking:'x',signature:1},
    {type:'redacted_thinking',data:'opaque'},
    {type:'image',source:{type:'base64'}},
  ]) {
    assert.throws(()=>admit(createRequestQuota({record:record(4000),protocol:'anthropic-messages',maxOutputField:'max_tokens'}),
      {model:'fixture',stream:true,max_tokens:1,messages:[{role:'assistant',content:[block]}]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  }
})
test('request quota accepts only the reviewed top-level wire fields for each protocol',()=>{
  const message=[{role:'user',content:'x'}]
  const chat=createRequestQuota({record:record(4000),protocol:'chat-completions',maxOutputField:'max_tokens'})
  const admitted=admit(chat,{model:'fixture',stream:true,stream_options:{include_usage:true},messages:[{role:'user',content:[{type:'text',text:'x',cache_control:{type:'ephemeral',ttl:'5m'}}]}],max_tokens:2,
    tools:[{type:'function',function:{name:'owned',parameters:{type:'object'}}}],tool_choice:'auto',parallel_tool_calls:false,
    response_format:{type:'json_object'},reasoning_effort:'low',temperature:0,top_p:1,stop:['END'],seed:1,
    frequency_penalty:0,presence_penalty:0,logprobs:false,top_logprobs:0,top_k:40,min_p:0.1,repetition_penalty:1.1,store:false,user:'controller',service_tier:'default'})
  chat.settle(admitted,{noncachedInput:1,cachedInput:0,output:0})
  for (const field of ['provider','options','extra_body','models','fallback','web_search_options','plugins','modalities']) {
    assert.throws(()=>admit(chat,{model:'fixture',stream:true,messages:message,max_tokens:1,[field]:{unexpected:true}}),error=>error.code === 'PROVIDER_USAGE_UNKNOWN' && error.details?.field === field,field)
  }
  assert.throws(()=>admit(chat,{messages:message,stream:true,max_tokens:1}),{code:'PROVIDER_USAGE_UNKNOWN'})
  const nonstream=admit(chat,{model:'fixture',messages:message,stream:false,max_tokens:1,reasoning:{effort:'low'},thinking:{type:'disabled'}})
  chat.settle(nonstream,{noncachedInput:1,cachedInput:0,output:0})
  assert.throws(()=>admit(chat,{model:'fixture',stream:true,stream_options:{include_usage:true,provider_hint:'x'},messages:message,max_tokens:1}),{code:'PROVIDER_USAGE_UNKNOWN'})
  const responses=createRequestQuota({record:record(4000),protocol:'responses',maxOutputField:'max_output_tokens',itemField:'input'})
  const response=admit(responses,{model:'fixture',stream:true,stream_options:{include_obfuscation:false},input:[{role:'developer',content:'controller prompt'},{type:'message',role:'user',content:[{type:'input_text',text:'x'}]}],max_output_tokens:2,
    tools:[{type:'function',name:'owned',parameters:{type:'object'}}],tool_choice:'auto',parallel_tool_calls:false,response_format:{type:'json_object'},reasoning:{effort:'low'},temperature:0,top_p:1,top_logprobs:0,store:false,prompt_cache_key:'controller-key',prompt_cache_retention:'24h',service_tier:'default'})
  responses.settle(response,{noncachedInput:1,cachedInput:0,output:0})
  assert.throws(()=>admit(responses,{model:'fixture',stream:true,input:[{type:'message',role:'user',content:[{type:'input_text',text:'x'}]}],max_output_tokens:1,include:['web_search_call.action.sources']}),{code:'PROVIDER_USAGE_UNKNOWN'})
  const anthropic=createRequestQuota({record:record(4000),protocol:'anthropic-messages',maxOutputField:'max_tokens'})
  const claude=admit(anthropic,{model:'fixture',stream:true,messages:message,max_tokens:2,system:[{type:'text',text:'text',cache_control:{type:'ephemeral',ttl:'5m'}}],thinking:{type:'disabled'},output_config:{effort:'low'},temperature:0,top_p:1,top_k:1,stop_sequences:['END'],metadata:{user_id:'controller'},context_management:{edits:[{type:'clear_thinking_20251015',keep:'all'}]}})
  anthropic.settle(claude,{noncachedInput:1,cachedInput:0,output:0})
  assert.throws(()=>admit(anthropic,{model:'fixture',stream:true,messages:message,max_tokens:1,mcp_servers:[]}),{code:'PROVIDER_USAGE_UNKNOWN'})
  assert.throws(()=>admit(anthropic,{model:'fixture',stream:true,messages:message,max_tokens:1,context_management:{edits:[{type:'compaction',compact_threshold:1}]}}),error=>error.code === 'PROVIDER_USAGE_UNKNOWN' && error.details?.field === 'context_management')
})
test('request quota uses exact settled input for a prefix follow-up and closes after unknown spend',()=>{const r=record(2000),q=createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'}),first=body([{role:'user',content:'x'}],20);const a=admit(q,first);q.settle(a,{noncachedInput:7,cachedInput:3,output:1});const second=body([{role:'user',content:'x'},{role:'assistant',content:'y'}],20);const b=admit(q,second,{noncachedInput:7,cachedInput:3,output:1});assert.equal(b.inputTokens,10+Buffer.byteLength(JSON.stringify([{role:'assistant',content:'y'}]))+128);q.unknown({code:'NETWORK'});assert.equal(r.unknown.length,1);assert.throws(()=>admit(q,second,{noncachedInput:7,cachedInput:3,output:1}),{code:'CHILD_TOKEN_LIMIT_EXHAUSTED'})})

test('request quota remains closed when durable unknown-spend recording throws',()=>{const r=record(2000);r.onUnknownProviderSpend=()=>{throw Object.assign(new Error('durable store failed'),{code:'STORE_FAILED'})};const q=createRequestQuota({record:r,protocol:'chat',maxOutputField:'max_tokens'}),value=body([{role:'user',content:'x'}],20);const a=admit(q,value);assert.throws(()=>q.unknown({code:'NETWORK'}),{code:'STORE_FAILED'});assert.throws(()=>admit(q,value),{code:'CHILD_TOKEN_LIMIT_EXHAUSTED'})})
test('Grok direct quota freezes its exact model before every reservation, including continuations',()=>{
  const r=record(4000), options={record:r,protocol:'grok-chat-completions',maxOutputField:'max_tokens',expectedModel:'openai/gpt-5.6-luna'}
  const q=createRequestQuota(options); options.expectedModel='different-provider/different-model'
  assert.throws(()=>admit(q,{...body([{role:'user',content:'x'}],20),model:'different-provider/different-model'}),{code:'PROVIDER_REQUEST_DENIED'})
  assert.deepEqual(r.starts,[])
  const first=admit(q,{...body([{role:'user',content:'x'}],20),model:'openai/gpt-5.6-luna'});q.settle(first,{noncachedInput:1,cachedInput:0,output:1})
  assert.throws(()=>admit(q,{...body([{role:'user',content:'x'},{role:'assistant',content:'y'}],20),model:'different-provider/different-model'},{noncachedInput:1,cachedInput:0,output:1}),{code:'PROVIDER_REQUEST_DENIED'})
  assert.equal(r.starts.length,1)
})

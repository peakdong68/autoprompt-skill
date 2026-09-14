'use strict'

const assert = require('node:assert/strict')
const cp = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// These are authority-routing tests with an explicit API double. Native
// publication, lineage, and crash recovery are tested in the OS guest suites.
for (const platform of ['darwin', 'win32']) {
  test(`${platform} native intent routing preserves canonical agreement and rejects changed bytes`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-intent-routing-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.mkdirSync(path.join(root, 'runtime'))
    const input = { runId: 'native-intent-routing', activationId: 'native-intent-activation', generation: 1,
      missionHash: 'a'.repeat(64), requestEnvelopeHash: 'b'.repeat(64), workspaceEpoch: 1,
      outcome: 'DONE', route: 'DIRECT', reason: 'checked', deliverableManifest: [], checkHashes: [],
      terminalEnvelope: { status: 'DONE' }, unblockPath: null }
    const script = `
      const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
      const api=require(${JSON.stringify(path.resolve(__dirname, '../../agents/codex/workflow/run-record.js'))});
      const root=${JSON.stringify(root)},input=${JSON.stringify(input)},shim=Object.create(fs);
      let publishes=0,recoveries=0;
      const mutations={assertRecordParent:p=>assert.ok(fs.statSync(path.dirname(p)).isDirectory()),
        recoverRecordPublication:()=>{recoveries++;return[]},
        publishRecordExclusive:(p,b)=>{publishes++;fs.writeFileSync(p,b,{flag:'wx',mode:0o600})}};
      const capture={captureFileBytes:p=>{const content=fs.readFileSync(p);return{content,bytes:content.length,hash:crypto.createHash('sha256').update(content).digest('hex')}}};
      shim.${platform === 'darwin' ? 'darwinCapture' : 'windowsCapture'}=capture;
      shim.${platform === 'darwin' ? 'darwinMutations' : 'windowsMutations'}=mutations;
      const authority=api.createTerminalFinalizationIntentAuthority(root,{fsImpl:shim,expectedRunId:input.runId});
      assert.throws(()=>authority.read(),{code:'TERMINAL_FINALIZATION_INTENT_REQUIRED'});
      const first=authority.createOrVerify(input);
      assert.deepEqual(authority.createOrVerify(input),first);
      assert.deepEqual(authority.read(),first);
      assert.throws(()=>authority.createOrVerify({...input,reason:'conflicting'}),{code:'TERMINAL_FINALIZATION_INTENT_CONFLICT'});
      const bytes=fs.readFileSync(authority.intentPath);
      fs.writeFileSync(authority.intentPath,Buffer.concat([bytes,Buffer.from(' ')]));
      assert.throws(()=>authority.read(),{code:'TERMINAL_FINALIZATION_INTENT_INVALID'});
      fs.writeFileSync(authority.intentPath,bytes);
      mutations.recoverRecordPublication=()=>['../foreign'];
      assert.throws(()=>authority.createOrVerify(input),{code:'RUN_RECORD_UNSAFE'});
      assert.equal(publishes,3);assert.equal(recoveries,3);
    `
    const result = cp.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
  })
}

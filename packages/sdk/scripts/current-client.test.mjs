import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'
import * as v from 'viem'
import { planPoolV3Spend } from '../dist/coin-selection.js'

const require = createRequire(import.meta.url), address = n => v.toHex(n, { size: 20 }), hash = n => v.toHex(n, { size: 32 })
function fixture(existingStorage) {
  const values = existingStorage ?? new Map(), storage = { get length() { return values.size }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k, x) => values.set(k, x), removeItem: k => values.delete(k) }
  const control = { mode: '', executions: 0, fee: 500n, quotes: [] }
  const profile = { version: 4, origin: 'https://parly.fi', chainId: 42431, settlementDomain: 42431n, assets: [1,2,3].map(assetId => ({ assetId, pool: address(30 + assetId), token: address(20 + assetId) })) }
  const state = id => ({ version: 4, ownerAddress: address(1), poolAddress: address(30 + id), assetId: id, total: 1000000n, notes: [{ commitment: hash(id), nullifierHash: hash(10 + id), amount: 1000000n, leafIndex: 0 }], history: { notes: [] } })
  const execution = {
    readPoolV4ProtocolFee: async () => control.fee,
    previewPoolV4BrowserExecution: async a => ({ totalNeededFromNotes: a.outputs.reduce((s,o)=>s+o.amount,control.fee), inputCount: a.sourceNotes.length, totalPrivateBalanceUsed: 1000000n, changeAfterExecution: 1000000n - a.outputs.reduce((s,o)=>s+o.amount,control.fee) }),
    executePoolV4SelfRelay: async a => { control.executions++; await a.onPrepared({ nullifierHashes: a.sourceNotes.map(n=>n.nullifierHash), transaction: {data:'0x1234'} }); if(control.mode==='uncertain') throw Object.assign(Error('uncertain'),{submissionUncertain:true}); return {hash:hash(90),nullifierHashes:a.sourceNotes.map(n=>n.nullifierHash)} },
    readPoolV4BrowserSettlement: async () => 'pending'
  }
  const payout = {
    quotePayoutV7: async a => { control.quotes.push(a); return {version:7,quoteSessionId:hash(99),assetId:a.assetId,sourcePool:a.sourcePool,inputCount:a.inputCount,children:a.outputs.map(o=>({intent:{destinationAmountOut:control.mode==='bad-destination'?1n:o.destinationChainId===2?o.amountOut/10000n:o.amountOut*10n**12n}}))} },
    authorizePayoutV7: async a => { await a.onPrepared({manifestHash:hash(100),sourceNullifierHashes:a.sourceNotes.map(n=>n.nullifierHash)}); if(control.mode==='uncertain') throw Object.assign(Error('uncertain'),{submissionUncertain:true}); return {capsule:{manifestHash:hash(100)},children:[]} }
  }
  const imports = {
    viem: {...v,createPublicClient:()=>({request:async()=>null}),createWalletClient:()=>({sendTransaction:async()=>hash(90)})},
    '@parly/crypto-utils/receiving-profile-v4': {assertReceivingProfileV4:()=>{}},
    '@parly/shared-types': {buildRecoveryAuthMessage:c=>{ assert.match(c.assetPoolIdentity,/Tempo launch pool set: USDC.e/); return 'fixed existing wallet recovery context' }},
    './coin-selection.js': {planPoolV3Spend}, './recovery-keys.js': {deriveRecoveryKeypair:async()=>({publicKeyB64:'PUBLIC',privateKeyB64:'PRIVATE_NOT_FOR_OUTPUT'})},
    './current-node-transport.js': {createCurrentNodeFetch:()=>fetch}, './note-crypto.js': {}, './current-prover-v4.js': {createReceivingProverV4:()=>async()=>{}},
    './current-recovery-v4.js': {recoverNotesForAssetV4:async a=>{ if(control.mode==='unavailable') throw Error('UNAVAILABLE'); return state(a.assetId) }},
    './current-execution-v4.js': execution, './current-payout-v7.js': payout
  }
  const module={exports:{}}, source=readFileSync(new URL('../src/current.ts',import.meta.url),'utf8').replaceAll('import.meta.url',JSON.stringify(import.meta.url))
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
  new Function('require','module','exports',js)(name=>imports[name]??require(name),module,module.exports)
  const config={privateKeyHex:hash(7),tempoRpcUrl:'https://rpc.invalid',tempoLzEid:40439,profile,keyEnvironment:'mainnet',origin:profile.origin,deployments:{1:{},2:{},3:{}},ponderGraphqlUrl:'https://indexer.invalid',proofAssetsBasePath:'.',webApiBaseUrl:profile.origin,recovery:{officialOrigin:profile.origin,usdcPool:address(40),usdtPool:address(41),verifierAddress:address(42)},relayRewardPolicy:{address:address(43),codeHash:hash(43)},payoutV7:{adapter:address(44),executor:address(45),adapterHash:hash(44),executorHash:hash(45)},storage,destinationRoutes:[{chainId:1,token:address(50),decimals:18},{chainId:2,token:address(51),decimals:2}],selectedRelayer:{executionAddress:address(60)}}
  return {sdk:new module.exports.CurrentParlySDK(config),Class:module.exports.CurrentParlySDK,config,values,control}
}
test('facade recovers all admitted assets with redacted summaries and rejects unavailable/foreign pools', async()=>{
  const f=fixture()
  for(const assetId of [1,2,3]) { const balance=await f.sdk.getPrivateBalance({assetId,poolAddress:address(30+assetId)}); assert.equal(balance.poolVersion,4); assert.equal(balance.totalPrivateBalanceBaseUnits,'1000000'); assert.doesNotMatch(JSON.stringify(balance),/PRIVATE|rho|privateKey|spendScalar/) }
  await assert.rejects(()=>f.sdk.getPrivateBalance({assetId:3,poolAddress:address(31)}),/not admitted/)
  f.control.mode='unavailable'; await assert.rejects(()=>f.sdk.getPrivateBalance({assetId:1,poolAddress:address(31)}),/UNAVAILABLE/)
  assert.throws(()=>new f.Class({...f.config,origin:'https://foreign.invalid'}),/origin/)
})
test('fee-aware single/batch preflight uses actual fees and rejects cross-chain EID or rounding',async()=>{
  const f=fixture(),args={assetId:3,poolAddress:address(33)}
  const ready=await f.sdk.preparePrivateSend({...args,amount:'0.1'});assert.equal(ready.kind,'ready');assert.equal(ready.finalFeesBaseUnits,'500')
  const batch=await f.sdk.preparePrivateBatchSend({...args,outputs:[{destination:address(8),amount:'0.1',destinationEid:40439},{destination:address(9),amount:'0.2',destinationEid:40439}]});assert.equal(batch.requestedAmountBaseUnits,'300000')
  await assert.rejects(()=>f.sdk.preparePrivateSend({...args,amount:'0.0000001'}),/six/)
  await assert.rejects(()=>f.sdk.preparePrivateBatchSend({...args,outputs:[{destination:address(8),amount:'0.1',destinationEid:40101}]}),/same-chain/)
})
test('uncertain self submission retains nullifier locks across restart and never resubmits',async()=>{
  const f=fixture(),args={assetId:1,poolAddress:address(31),destination:address(8),amount:'0.1',destinationEid:40439};f.control.mode='uncertain'
  await assert.rejects(()=>f.sdk.sendShieldedPayment(args),e=>e.submissionUncertain===true)
  assert.equal(f.values.size,1)
  const restarted=fixture(f.values);await assert.rejects(()=>restarted.sdk.sendShieldedPayment(args),/not ready/);assert.equal(restarted.control.executions,0)
})
test('destination precision is explicit and uncertain V7 authorization locks notes across restart',async()=>{
  const f=fixture();f.control.mode='uncertain'
  await assert.rejects(()=>f.sdk.sendCrossChainShieldedPayment({assetId:2,poolAddress:address(32),destinationChainId:1,destinationToken:address(50),destinationRecipient:address(8),amount:'0.123456'}),e=>e.submissionUncertain===true)
  assert.equal(f.control.quotes[0].outputs[0].amountOut,123456n)
  assert.equal(f.values.size,1)
  const restarted=fixture(f.values);await assert.rejects(()=>restarted.sdk.quotePayoutV7({assetId:2,poolAddress:address(32),outputs:[]}),/unavailable/)
  await assert.rejects(()=>f.sdk.sendCrossChainShieldedPayment({assetId:1,poolAddress:address(31),destinationChainId:3,destinationToken:address(50),destinationRecipient:address(8),amount:'1'}),/precision/)
})


test('V7 source six-decimal amounts bind exact eighteen and lower-precision destination units',async()=>{
  const f=fixture()
  await f.sdk.quotePayoutV7({assetId:1,poolAddress:address(31),outputs:[{destinationChainId:1,destinationToken:address(50),destinationRecipient:address(8),amountOut:1000000n}]})
  assert.equal(f.control.quotes[0].outputs[0].amountOut,1000000n)
  await f.sdk.quotePayoutV7({assetId:1,poolAddress:address(31),outputs:[{destinationChainId:2,destinationToken:address(51),destinationRecipient:address(8),amountOut:1230000n}]})
  await assert.rejects(()=>f.sdk.quotePayoutV7({assetId:1,poolAddress:address(31),outputs:[{destinationChainId:2,destinationToken:address(51),destinationRecipient:address(8),amountOut:1230001n}]}),/represented exactly/)
  f.control.mode='bad-destination'
  await assert.rejects(()=>f.sdk.quotePayoutV7({assetId:1,poolAddress:address(31),outputs:[{destinationChainId:1,destinationToken:address(50),destinationRecipient:address(8),amountOut:1000000n}]}),/quoted destination/)
})

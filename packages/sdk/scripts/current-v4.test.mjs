import assert from 'node:assert/strict'
import test from 'node:test'
import { createReceivingProverV4, RECEIVING_V4_ARTIFACTS, receivingArtifactNameV4 } from '../dist/current-prover-v4.js'
import { recoverNotesForAssetV4 } from '../dist/current-recovery-v4.js'
import * as execution from '../dist/current-execution-v4.js'
import * as payout from '../dist/current-payout-v7.js'
import { spawnSync } from 'node:child_process'

test('current SDK exposes real recovery, single/batch spend and V7 lifecycle entry points', () => {
  for (const name of ['previewPoolV4BrowserExecution', 'preparePoolV4BrowserExecution', 'executePoolV4SelfRelay', 'executePoolV4PrivateRelay', 'readPoolV4BrowserSettlement']) assert.equal(typeof execution[name], 'function', name)
  for (const name of ['quotePayoutV7', 'authorizePayoutV7', 'readPayoutV7Status', 'claimPayoutV7Refund', 'recoverPayoutV7Capsules']) assert.equal(typeof payout[name], 'function', name)
})

test('proof reader enforces pinned artifact hashes before invoking the prover', async () => {
  const reads = []
  const prove = createReceivingProverV4({ readArtifact: async name => { reads.push(name); return new Uint8Array([1]) } })
  await assert.rejects(() => prove('spend', {}), /verification failed/)
  assert.deepEqual(reads, [receivingArtifactNameV4('spend', 'wasm')])
  assert.equal(RECEIVING_V4_ARTIFACTS.spend.nPublic, 60)
})

test('unavailable recovery never becomes a zero balance or legacy fallback', async () => {
  let reads = 0
  await assert.rejects(() => recoverNotesForAssetV4({ profile: {}, origin: 'https://parly.fi', isCurrent: () => true, rpc: async () => { reads++; throw Error('offline') } }))
  assert.equal(reads, 0)
})

test('proof setup is explicit and verifies already-installed pinned files without downloads', () => {
  const script = new URL('./sync-proof-assets.mjs', import.meta.url)
  const verified = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1')], { encoding: 'utf8' })
  if (verified.status === 0) assert.match(verified.stdout, /Verified receiving_v4_spend_/)
  else assert.match(verified.stderr, /Missing pinned Spend60 asset/)
  const invalid = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--automatic'], { encoding: 'utf8' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /explicitly --download/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createCurrentNodeFetch } from '../dist/current-node-transport.js'

test('Node API transport sends the pinned Origin and forbids redirects, cookies and cross-origin requests',async()=>{
  let requests=0
  const fetcher=createCurrentNodeFetch('https://parly.fi',async request=>{requests++;assert.ok(request instanceof Request);assert.equal(request.headers.get('Origin'),'https://parly.fi');assert.equal(request.headers.get('authorization'),'Bearer synthetic-capability');assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');assert.equal(await request.text(),'{"version":7}');return Response.json({ok:true})})
  assert.equal((await (await fetcher('https://parly.fi/api/phase3/payout-v7/quote',{method:'POST',headers:{Origin:'https://foreign.invalid',authorization:'Bearer synthetic-capability'},body:'{"version":7}'})).json()).ok,true)
  await assert.rejects(()=>fetcher('https://foreign.invalid/api/status'),/pinned origin/)
  await assert.rejects(()=>fetcher('https://user:pass@parly.fi/api/status'),/pinned origin/)
  await assert.rejects(()=>fetcher('/api/status',{method:'POST',body:'x'.repeat(1048577)}),/too large/)
  assert.equal(requests,1)
})
test('Node transport surfaces redirect/network failure without retrying a V7 POST',async()=>{
  let requests=0
  const fetcher=createCurrentNodeFetch('https://parly.fi',async()=>{requests++;throw Error('redirect refused')})
  await assert.rejects(()=>fetcher('/api/phase3/payout-v7/accept',{method:'POST',body:'{}'}),/redirect refused/)
  assert.equal(requests,1)
})

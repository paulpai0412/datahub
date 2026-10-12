import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../extensions/datahub-agent/pi-web/package.json',import.meta.url));
const {createJiti}=require('jiti'),jiti=createJiti(import.meta.url);
const {default:register}=await jiti.import(new URL('../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts',import.meta.url).pathname);
const sid='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000111',sourceUrn='urn:li:dataHubIngestionSource:fixture';
function fixture({active=true,failure=false}={}){
 const hooks=new Map(),tools=new Map(),reads=[],entries=[
  {type:'custom',customType:'datahub-semantic.intent/1',id:'intent',data:{action:'start_maintenance',requestId:id,sourceUrn,sessionId:sid,retryAllowed:false}},
  {type:'custom',customType:'datahub-semantic.unconfirmed/1',id:'error',data:{action:'start_maintenance',requestId:id,error:'semantic_publication_not_authorized',reconciliation:{requestId:id},retryAllowed:false}},
 ];
 const pi={on:(name,fn)=>hooks.set(name,fn),registerTool:t=>tools.set(t.name,t),getActiveTools:()=>active?['datahub_semantic']:[],appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),sendMessage:()=>{throw Error('no automatic continuation')}};
 register(pi);
 const ctx={mode:'rpc',sessionManager:{getBranch:()=>entries,getSessionId:()=>sid},signal:new AbortController().signal,
  ui:{notify:()=>{},input:async(_title,raw)=>{const r=JSON.parse(raw);reads.push(r);if(failure)throw Error('offline read failure');
   if(r.action==='list_sources')return JSON.stringify({format:'datahub-semantic.preview/1',publicationAuthorized:false,action:r.action,requestId:r.requestId,sources:[{urn:sourceUrn,reviewPolicy:{canPrepareReview:true,humanApprovalRequired:true}}]});
   if(r.action==='reconcile_maintenance_start')return JSON.stringify({format:'datahub-semantic.start-reconciliation/1',action:r.action,requestId:r.requestId,originalRequestId:id,sourceUrn,status:'NO_CURRENT_RECORDS',records:{task:{status:'NOT_FOUND'},run:{status:'NOT_FOUND'}},currentPolicy:{canPrepareReview:true,humanApprovalRequired:true},effect:'NOT_PROVEN',retryAllowed:false,readOnly:true,publicationAuthorized:false});
   throw Error('unexpected effect/read');}},abort:()=>{throw Error('read freshness does not abort or recover original effects')}};
 return{hooks,tools,ctx,reads,entries};
}
test('next accepted prompt receives fresh policy and original read-only reconciliation, never repeats the start',async()=>{
 const f=fixture(),old=structuredClone(f.entries);
 assert(f.hooks.has('before_agent_start'),'freshness must occur BEFORE the first model response, not another prompt suggestion');
 const r=await f.hooks.get('before_agent_start')({prompt:'continue semantic work'},f.ctx);
 assert.equal(r.message.customType,'datahub-semantic.start-status/1');
 const facts=JSON.parse(r.message.content);assert.equal(facts.observations[0].status,'CURRENT_READ',JSON.stringify(facts));assert.equal(facts.observations[0].currentPolicy.canPrepareReview,true);
 assert.equal(facts.observations[0].reconciliation.effect,'NOT_PROVEN');
 assert.deepEqual(f.reads.map(r=>r.action),['list_sources','reconcile_maintenance_start']);
 assert.equal(f.reads[1].originalRequestId,id);assert.equal(f.reads[1].sourceUrn,sourceUrn);
 assert.deepEqual(f.entries,old,'read-only refresh neither rewrites old uncertainty nor invents a confirmed outcome');
 assert.equal(facts.retryAllowed,false);assert.equal(facts.continuationAuthorized,false);
 await assert.rejects(f.tools.get('datahub_semantic').execute('unbound',{action:'read_maintenance'},undefined,undefined,f.ctx),/root_required/,'fresh facts do not bind or arm a plan');
});
test('inactive tool, foreign-session intent and ordinary no-uncertainty prompts do not gain capabilities or trigger reads',async()=>{
 for(const kind of ['inactive','foreign','ordinary']){const f=fixture({active:kind!=='inactive'});if(kind==='foreign')f.entries[0].data.sessionId='foreign';if(kind==='ordinary')f.entries.length=0;
  assert(f.hooks.has('before_agent_start'));assert.equal(await f.hooks.get('before_agent_start')({prompt:'hello'},f.ctx),undefined);assert.deepEqual(f.reads,[])}
});
test('read failure is an explicit current evidence gap, never a fresh write grant or zero-effect result',async()=>{
 const f=fixture({failure:true});assert(f.hooks.has('before_agent_start'));
 const r=await f.hooks.get('before_agent_start')({prompt:'continue'},f.ctx);const facts=JSON.parse(r.message.content);
 assert.equal(facts.observations[0].status,'READ_UNAVAILABLE');assert.equal(facts.observations[0].effect,'NOT_PROVEN');
 assert.equal(facts.retryAllowed,false);assert.equal(facts.continuationAuthorized,false);assert.deepEqual(f.reads.map(r=>r.action),['list_sources']);
});

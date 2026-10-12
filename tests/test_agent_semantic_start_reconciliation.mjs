// Source/Task/Run seam: synthetic native API only; no credentials or real effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { semanticCatalogFixture } from './fixtures/semantic-catalog-fixture.mjs';
import { sourceUrn } from './fixtures/semantic-fixture.mjs';
const originalRequestId='00000000-0000-4000-8000-000000000111';
const input=()=>({action:'reconcile_maintenance_start',requestId:randomUUID(),sourceUrn,originalRequestId});

test('source refusal retains exact original start locators, without input-correction or replay authority',async()=>{
 const f=semanticCatalogFixture();f.context.sources[0].semanticPublicationApproved=false;
 let error;try{await f.call({action:'start_maintenance',requestId:originalRequestId,sessionId:f.sessionId,uiRequestId:'fixture-ui',sourceUrn})}catch(e){error=e}
 assert.equal(error.message,'semantic_publication_not_authorized');
 assert.equal(error.inputRejection,undefined);assert.equal(error.reconciliation.retryAllowed,false);
 assert.equal(error.reconciliation.maintenanceRunUrn,`urn:li:dataProcessInstance:semantic-${f.context.actor.key}-${originalRequestId}`);
 assert.equal(error.reconciliation.taskUrn,`urn:li:dataJob:(urn:li:dataFlow:(pi,ekop-agent-${f.context.actor.key},DEV),semantic-${f.context.actor.key}-${originalRequestId})`);
 assert.equal(f.writes.recordWrites,0);assert.equal(f.writes.targetWrites,0);
});

test('original start reconciliation reads CURRENT source policy and both exact records; absence is not historic zero-effect proof',async()=>{
 const f=semanticCatalogFixture();const r=await f.call(input());
 assert.equal(r.format,'datahub-semantic.start-reconciliation/1');assert.equal(r.status,'NO_CURRENT_RECORDS');
 assert.equal(r.originalRequestId,originalRequestId);assert.equal(r.sourceUrn,sourceUrn);
 assert.equal(r.currentPolicy.canPrepareReview,true);assert.equal(r.currentPolicy.humanApprovalRequired,true);
 assert.equal(r.effect,'NOT_PROVEN');assert.equal(r.retryAllowed,false);assert.equal(r.publicationAuthorized,false);
 assert.equal(r.records.task.status,'NOT_FOUND');assert.equal(r.records.run.status,'NOT_FOUND');
 assert.equal(f.writes.recordWrites,0);assert.equal(f.writes.targetWrites,0);
 f.context.sources[0].semanticPublicationApproved=false;
 assert.equal((await f.call(input())).currentPolicy.canPrepareReview,false,'revocation visible even while exact diagnostic reads remain allowed');
});

test('saved plan reconciliation returns the ORIGINAL Root and current state without arming, rewriting or publishing',async()=>{
 const f=semanticCatalogFixture();f.writes.pending={action:'start_maintenance',requestId:originalRequestId,sourceUrn,sessionId:f.sessionId};
 const plan=await f.call({...f.writes.pending,uiRequestId:'fixture-ui'});const before=structuredClone([...f.journal.entries()]);const count=f.writes.recordWrites;
 const r=await f.call(input());assert.equal(r.status,'SAVED_PLAN');assert.equal(r.maintenanceRunUrn,plan.maintenanceRunUrn);
 assert.equal(r.state,'DRAFT');assert.equal(r.foregroundPreparation,false);assert.equal(r.retryAllowed,false);
 assert.deepEqual([...f.journal.entries()],before);assert.equal(f.writes.recordWrites,count);assert.equal(f.writes.targetWrites,0);
});

test('reconciliation does not conceal scope/ACL/input errors or select caller-supplied arbitrary records',async()=>{
 const f=semanticCatalogFixture();
 await assert.rejects(f.call({...input(),originalRequestId:'not-a-uuid'}));
 await assert.rejects(f.call({...input(),taskUrn:'urn:li:dataJob:foreign'}));
 await assert.rejects(f.call({...input(),sourceUrn:'urn:li:dataHubIngestionSource:foreign'}));
 const originalFetch=f.context.fetchImpl;
 f.context.fetchImpl=async(url,options)=>String(url).includes('/openapi/v3/entity/datajob/batchGet')
   ? new Response('{}',{status:403}) : originalFetch(url,options);
 await assert.rejects(f.call(input()),/unavailable/,'native read rejection is never treated as an absent record');
 assert.equal(f.writes.recordWrites,0);assert.equal(f.writes.targetWrites,0);
});

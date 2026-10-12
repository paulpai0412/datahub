// Public pinned SDK lifecycle, synthetic provider/Host, isolated disposable HOME.
import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';
import{mkdtemp,mkdir,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const require=createRequire(new URL('../extensions/datahub-agent/pi-web/package.json',import.meta.url));const{createJiti}=require('jiti'),jiti=createJiti(new URL('../extensions/datahub-agent/pi-web/package.json',import.meta.url).href);
const sdk=await jiti.import('@earendil-works/pi-coding-agent'),ai=await jiti.import('@earendil-works/pi-ai');
const{default:register}=await jiti.import(new URL('../extensions/datahub-agent/pi-web/lib/datahub-semantic-extension.ts',import.meta.url).pathname);
const sourceUrn='urn:li:dataHubIngestionSource:fixture',originalRequestId='00000000-0000-4000-8000-000000000111';
test('actual SDK places current policy/reconciliation BEFORE first model invocation, including reload, without write replay',async t=>{
 const root=await mkdtemp(join(tmpdir(),'semantic-start-public-sdk-'));t.after(()=>rm(root,{recursive:true,force:true}));const agentDir=join(root,'agent');await mkdir(agentDir);
 const requests=[],contexts=[];
 const services=await sdk.createAgentSessionServices({cwd:root,agentDir,settingsManager:sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}}),resourceLoaderOptions:{noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>{
  register(pi);pi.registerProvider('start-fixture',{api:'start-fixture-api',baseUrl:'http://invalid.invalid',apiKey:'offline-fixture',models:[{id:'offline',name:'Offline fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096}],streamSimple(model,context){
   contexts.push({messages:structuredClone(context.messages),systemPrompt:context.systemPrompt});const stream=ai.createAssistantMessageEventStream();queueMicrotask(()=>{const message={role:'assistant',content:[{type:'text',text:'Current policy read; original non-replayable operation retained.'}],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end()});return stream;
  }})}]}});
 const model=services.modelRuntime.getModel('start-fixture','offline');assert(model);const sm=sdk.SessionManager.inMemory(root);
 const{session}=await sdk.createAgentSessionFromServices({services,sessionManager:sm,model,tools:['datahub_semantic']});t.after(()=>session.dispose());
 await session.bindExtensions({mode:'rpc',uiContext:{notify:()=>{},input:async(_title,raw)=>{const r=JSON.parse(raw);requests.push(r);
  if(r.action==='list_sources')return JSON.stringify({format:'datahub-semantic.preview/1',action:r.action,requestId:r.requestId,publicationAuthorized:false,sources:[{urn:sourceUrn,reviewPolicy:{canPrepareReview:true,humanApprovalRequired:true}}]});
  assert.equal(r.action,'reconcile_maintenance_start');assert.equal(r.originalRequestId,originalRequestId);
  return JSON.stringify({format:'datahub-semantic.start-reconciliation/1',action:r.action,requestId:r.requestId,originalRequestId,sourceUrn,status:'NO_CURRENT_RECORDS',currentPolicy:{canPrepareReview:true},records:{task:{status:'NOT_FOUND'},run:{status:'NOT_FOUND'}},effect:'NOT_PROVEN',retryAllowed:false,readOnly:true,publicationAuthorized:false});
 }}});session.setActiveToolsByName(['datahub_semantic']);
 sm.appendCustomEntry('datahub-semantic.intent/1',{action:'start_maintenance',requestId:originalRequestId,sourceUrn,sessionId:session.sessionId,retryAllowed:false});
 sm.appendCustomEntry('datahub-semantic.unconfirmed/1',{action:'start_maintenance',requestId:originalRequestId,error:'semantic_publication_not_authorized',reconciliation:{requestId:originalRequestId},retryAllowed:false});
 const old=structuredClone(sm.getEntries());await session.prompt('Read current Source status; do not repeat the original operation.');
 assert.equal(contexts.length,1,JSON.stringify({requests,messages:session.messages}));assert.deepEqual(requests.map(r=>r.action),['list_sources','reconcile_maintenance_start']);
 const providerText=contexts[0].messages.map(m=>typeof m.content==='string'?m.content:(m.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')).join('\n');
 assert(providerText.includes('"canPrepareReview":true'),'fresh facts must reach actual first provider context');
 assert(JSON.stringify(contexts[0].messages).includes('NOT_PROVEN'));assert.deepEqual(sm.getEntries().slice(0,old.length),old);
 await session.reload();session.setActiveToolsByName(['datahub_semantic']);await session.prompt('Again only read; history does not arm a draft.');
 assert.equal(contexts.length,2);assert.deepEqual(requests.map(r=>r.action),['list_sources','reconcile_maintenance_start','list_sources','reconcile_maintenance_start']);
 assert.equal(session.pendingMessageCount,0);assert.deepEqual(sm.getEntries().slice(0,old.length),old);
});

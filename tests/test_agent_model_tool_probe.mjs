// Real pinned SDK and owning RPC boundary; fixture provider never calls a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const app=new URL('../extensions/datahub-agent/pi-web/',import.meta.url);
const require=createRequire(new URL('package.json',app));
const jiti=require('jiti').createJiti(new URL('package.json',app).href);
const sdk=await jiti.import('@earendil-works/pi-coding-agent');
const {AssistantMessageEventStream}=await jiti.import('@earendil-works/pi-ai');
const {default:catalog}=await jiti.import(new URL('lib/datahub-catalog-extension.ts',app).pathname);
const {default:semantic}=await jiti.import(new URL('lib/datahub-semantic-extension.ts',app).pathname);
const {probeModelTools,isModelToolProbeRunning}=await jiti.import(new URL('lib/model-tool-probe.ts',app).pathname);
const {AgentSessionWrapper}=await jiti.import(new URL('lib/rpc-manager.ts',app).pathname);
const selected=['datahub_catalog','datahub_semantic'];
async function fixture(t,toolNames=selected){
 const root=await mkdtemp(join(tmpdir(),'model-tool-probe-'));t.after(()=>rm(root,{recursive:true,force:true}));const agentDir=join(root,'agent');await mkdir(agentDir);
 const services=await sdk.createAgentSessionServices({cwd:root,agentDir,settingsManager:sdk.SettingsManager.inMemory({}),resourceLoaderOptions:{noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,extensionFactories:[catalog,semantic]}});
 const model=services.modelRuntime.getModel('openai-codex','gpt-5.6-luna');assert(model);
 const {session}=await sdk.createAgentSessionFromServices({services,sessionManager:sdk.SessionManager.inMemory(root),model,thinkingLevel:'medium',tools:toolNames});t.after(()=>session.dispose());
 await session.bindExtensions({mode:'rpc'});session.setActiveToolsByName(toolNames);
 let executions=0,invocations=0;const previousTools=session.agent.state.tools;
 session.agent.state.tools=previousTools.map(tool=>({...tool,execute:async()=>{executions++;throw new Error('no tool may run');}}));
 function responder({hold=false,fail=false}={}){
  session.agent.streamFunction=async(m,context,options)=>{
   invocations++;assert.equal(m,session.agent.state.model);assert.equal(options.reasoning,'medium');assert.equal(options.sessionId,session.sessionId);assert.equal(options.maxRetries,0);
   assert.deepEqual(context.tools.map(tool=>tool.name).sort(),toolNames.slice().sort());assert(context.tools.every(tool=>!('execute' in tool)));
   assert.equal(context.systemPrompt,session.agent.state.systemPrompt);
   await options.onPayload({model:m.id,instructions:context.systemPrompt,tools:context.tools.map(({name,description,parameters})=>({type:'function',name,description,parameters})),tool_choice:'auto'},m);
   if(fail)throw new Error('fixture uncertain provider failure');
   if(hold)await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});
   const response={role:'assistant',content:[{type:'toolCall',id:'fixture-call',name:'datahub_semantic',arguments:{action:'start_maintenance',sourceUrn:'urn:li:dataHubIngestionSource:fixture'}}],api:m.api,provider:m.provider,model:m.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:options.signal.aborted?'aborted':'toolUse',timestamp:Date.now()};
   const stream=new AssistantMessageEventStream();stream.push({type:'done',reason:response.stopReason,message:response});stream.end(response);return stream;
  };
 }
 return{session,responder,counts:()=>({executions,invocations})};
}
test('actual tool descriptors reach one provider response, including a requested WRITE, with ZERO executions and unchanged original history',async t=>{
 const f=await fixture(t);f.responder();const before=JSON.stringify(f.session.agent.state.messages),entries=f.session.sessionManager.getEntries().map(e=>JSON.stringify(e));
 const result=await probeModelTools(f.session,f.session.sessionId);
 assert.equal(result.status,'toolUse');assert.deepEqual(result.toolCalls,[{name:'datahub_semantic',action:'start_maintenance'}]);assert.deepEqual(f.counts(),{executions:0,invocations:1});assert.equal(result.nativeWrites,0);assert.equal(result.retryAllowed,false);
 assert.deepEqual(result.payload.tools.map(t=>t.name).sort(),selected.slice().sort());assert(result.payload.tools.every(t=>/^[a-f0-9]{64}$/.test(t.schemaSHA256)));
 assert.equal(JSON.stringify(f.session.agent.state.messages),before);assert.deepEqual(f.session.sessionManager.getEntries().slice(0,entries.length).map(e=>JSON.stringify(e)),entries);
 assert.equal(f.session.sessionManager.getEntries().filter(e=>e.type==='custom'&&e.customType==='pi-web:model-tool-probe/1').length,2);
 await assert.rejects(()=>probeModelTools(f.session,f.session.sessionId),/already_consumed_no_replay/);assert.equal(f.counts().invocations,1);
 await f.session.reload();await assert.rejects(()=>probeModelTools(f.session,f.session.sessionId),/already_consumed_no_replay/);
});
test('foreign session, inactive tools and queued work reject before provider or journal changes',async t=>{
 const f=await fixture(t);f.responder();const before=f.session.sessionManager.getEntries().length;
 await assert.rejects(()=>probeModelTools(f.session,'foreign-session'),/session_mismatch/);assert.equal(f.session.sessionManager.getEntries().length,before);
 const other=await fixture(t,['datahub_catalog']);other.responder();await assert.rejects(()=>probeModelTools(other.session,other.session.sessionId),/requires_actual_semantic_governance_tools/);assert.equal(other.counts().invocations,0);
 await f.session.steer('queued fixture, never dispatch');assert(f.session.pendingMessageCount>0);
 await assert.rejects(()=>probeModelTools(f.session,f.session.sessionId),/probe_busy/);assert.equal(f.session.sessionManager.getEntries().length,before);
 assert.equal(f.counts().invocations,0);
});
test('provider failure consumes once without any replay or tool execution',async t=>{
 const f=await fixture(t);f.responder({fail:true});await assert.rejects(()=>probeModelTools(f.session,f.session.sessionId),/uncertain provider/);assert.equal(isModelToolProbeRunning(f.session),false);
 await assert.rejects(()=>probeModelTools(f.session,f.session.sessionId),/already_consumed/);assert.deepEqual(f.counts(),{executions:0,invocations:1});
});
test('owning RPC reports busy, rejects a concurrent prompt/model/tools change and allows abort without tools executing',async t=>{
 const f=await fixture(t);const wrapper=new AgentSessionWrapper(f.session,{selectedToolNames:selected});t.after(()=>wrapper.shutdown());await wrapper.waitUntilReady();f.responder({hold:true});
 const pending=wrapper.send({type:'diagnose_model_tools',expectedSessionId:f.session.sessionId});
 while(!isModelToolProbeRunning(f.session))await new Promise(resolve=>setImmediate(resolve));
 assert.equal(wrapper.isRunning(),true);assert.equal((await wrapper.send({type:'get_state'})).isPromptRunning,true);
 for(const type of ['prompt','set_model','set_tools','diagnose_model_tools'])await assert.rejects(()=>wrapper.send({type,message:'must not execute',expectedSessionId:f.session.sessionId}),/probe_busy/);
 await wrapper.send({type:'abort'});const result=await pending;assert.equal(result.status,'aborted');assert.deepEqual(f.counts(),{executions:0,invocations:1});assert.equal(wrapper.isRunning(),false);
});

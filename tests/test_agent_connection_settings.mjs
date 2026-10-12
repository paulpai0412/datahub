import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, readdir, stat, writeFile } from "node:fs/promises";
import { connectionSettingsFixture } from "./fixtures/connection-settings-fixture.mjs";
import { createSourceSettingsStore } from "../extensions/datahub-agent/integration/source-settings.mjs";
import { queryBindings, readQuerySecret, applyQueryBindings } from "../extensions/datahub-agent/integration/query-source.mjs";
async function fixture(t){const f=await connectionSettingsFixture();t.after(()=>rm(f.dir,{recursive:true,force:true}));return f}

test("admin saves a protected immutable SQL connection and returns neither password nor secret path; readback/reload usable",async t=>{
 const f=await fixture(t),input=await f.input(),saved=await f.call(input);assert.equal(saved.status,"SAVED_AND_ACTIVE");assert.equal(f.active.length,1);
 const disk=JSON.parse(await readFile(f.path));assert.deepEqual(disk.preserved,f.initial.preserved);assert(!JSON.stringify(disk).includes(input.connection.password));
 const secret=await readQuerySecret(disk.queryConnections[0].connectionPath);assert.equal(secret.password,input.connection.password);assert.equal(secret.database,"Warehouse");assert.equal(secret.cafile,"/etc/ssl/certs/ca-certificates.crt");assert.equal((await stat(disk.queryConnections[0].connectionPath)).mode&0o777,0o600);
 const list=await f.call({action:"list"}),detail=await f.call({action:"inspect",id:input.id});assert.equal(detail.connection.passwordConfigured,true);assert(!JSON.stringify([saved,list,detail]).includes(input.connection.password));assert(!JSON.stringify([saved,list,detail]).includes("connectionPath"));assert(!JSON.stringify(detail).includes("cafile"));assert.equal(queryBindings(disk.queryConnections).length,1);assert.equal(f.tests,0);
});
test("blank password preserves existing secret; rotate creates new path and old secret bytes survive",async t=>{
 const f=await fixture(t),first=await f.input();await f.call(first);const binding=f.active[0],old=await readFile(binding.connectionPath);
 const update=await f.input();update.datasetUrn="";update.connection.password="";update.connection.tls="retain";await f.call(update);assert.notEqual(f.active[0],binding);assert.notEqual(f.active[0].connectionPath,binding.connectionPath);assert.equal((await readQuerySecret(f.active[0].connectionPath)).password,first.connection.password);assert.deepEqual(await readFile(binding.connectionPath),old);
 const rotate=await f.input();rotate.connection.password="ROTATED_FIXTURE";await f.call(rotate);assert.equal((await readQuerySecret(f.active[0].connectionPath)).password,"ROTATED_FIXTURE");
});
test("disable and reenable update runtime bindings without losing saved connection or semantic policy",async t=>{
 const f=await fixture(t),input=await f.input();await f.call(input);const p=f.active[0].connectionPath;
 await f.call({action:"set_enabled",revision:(await f.store.current()).revision,id:input.id,enabled:false});assert.equal(f.active.length,0);assert.equal((await f.call({action:"list"})).connections[0].enabled,false);
 await f.call({action:"set_enabled",revision:(await f.store.current()).revision,id:input.id,enabled:true});assert.equal(f.active.length,1);assert.equal(f.active[0].connectionPath,p);
});
test("shared source and connection writers preserve each other, reject stale revisions, and preserve unchanged binding identity",async t=>{
 const f=await fixture(t),sources=await createSourceSettingsStore(f.path,undefined,f.store),before=await sources.current();await f.call(await f.input());const binding=f.active[0];
 const policy={urn:"urn:li:dataHubIngestionSource:11111111-1111-4111-8111-111111111111",cliVersion:"1.7.0.9",recipeSha256:"a".repeat(64)};
 await assert.rejects(sources.save(before.revision,f.actor.key,policy,async()=>{}),/version_conflict/);
 await sources.save((await sources.current()).revision,f.actor.key,policy,async()=>{});assert.equal(f.active[0],binding);
 const updated=await f.input();updated.connection.password="NEW_FIXTURE_PASSWORD";await f.call(updated);assert.deepEqual((await sources.current()).policies[f.actor.key],[policy]);
});
test("ordinary user, forged actor, stale external changes and invalid fields cannot save or probe",async t=>{
 const f=await fixture(t),input=await f.input(),raw=await readFile(f.path);f.setAdmin(false);await assert.rejects(f.call(input),/admin_required/);f.setAdmin(true);
 await assert.rejects(f.call(input,{...f.context,actor:{...f.actor,urn:"urn:li:corpuser:forged"}}),/admin_required/);
 for(const extra of ["actor","connectionPath","sql","enabled"])await assert.rejects(f.call({...input,[extra]:"forged"}),/invalid_request/);
 f.setVisible(false);await assert.rejects(f.call(input),/metadata_denied/);f.setVisible(true);assert.deepEqual(await readFile(f.path),raw);assert.equal(f.tests,0);
 await writeFile(f.path,JSON.stringify({...f.initial,external:true}));await assert.rejects(f.call(input),/configuration_changed/);
});
test("duplicate locator and invalid credential input fail before writing secret files; source test is explicit and not a permissions claim",async t=>{
 const f=await fixture(t),input=await f.input();for(const patch of [{host:"http://169.254.169.254/"},{port:0},{database:"other"},{tls:"insecure"},{password:""},{cafile:"/private/key"}])await assert.rejects(f.call({...input,connection:{...input.connection,...patch}}),/invalid_connection|password_required/);
 assert.deepEqual(await readdir(f.dir),["operator.json"]);
 const tested=await f.call({...input,action:"test"});assert.equal(tested.status,"CONNECTED");assert.equal(tested.selectPermissionsVerified,false);assert.equal(f.tests,1);assert.equal(f.active.length,0);
 await f.call(input);await assert.rejects(f.call(await f.input("second")),/duplicate_binding/);assert.equal((await readdir(f.dir+"/query-credentials")).length,1);
});
test("concurrent source/connection writes have one winner, without clobbering unrelated state",async t=>{
 const f=await fixture(t),input=await f.input();const results=await Promise.allSettled([f.call(input),f.call({...input,id:"second"})]);assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(f.active.length,1);assert.deepEqual(JSON.parse(await readFile(f.path)).preserved,f.initial.preserved);
});
test("binding apply preserves other queries but removes disabled and rotated identities",()=>{
 const b={id:"a",tenant:"fixture",platform:"mssql",platformInstanceUrn:null,environment:"PROD",database:"warehouse",datasetPrefix:"",connectionPath:"/protected/a"};const active=queryBindings([b]);const first=active[0];applyQueryBindings(active,[b,{...b,id:"b",database:"other"}]);assert.equal(active[0],first);applyQueryBindings(active,[{...b,connectionPath:"/protected/b"}]);assert.notEqual(active[0],first);applyQueryBindings(active,[{...b,enabled:false}]);assert.equal(active.length,0);
});

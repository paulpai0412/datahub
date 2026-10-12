import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorConfigStore } from "../../extensions/datahub-agent/integration/operator-config.mjs";
import { createConnectionSettingsHost } from "../../extensions/datahub-agent/integration/connection-settings.mjs";
import { queryBindings, applyQueryBindings } from "../../extensions/datahub-agent/integration/query-source.mjs";
import { ingestionPolicies } from "../../extensions/datahub-agent/integration/ingestion-policy.mjs";
export async function connectionSettingsFixture() {
  const dir = await mkdtemp(join(tmpdir(), "datahub-connections-")), path = join(dir,"operator.json");
  const actor = { urn:"urn:li:corpuser:fixture-admin",key:"a".repeat(48),tenant:"fixture" };
  const urn="urn:li:dataset:(urn:li:dataPlatform:mssql,warehouse.dbo.orders,PROD)";
  const initial={connectionSettingsEnabled:true,sourceSettingsEnabled:true,queryConnections:[],queryGrafana:{orgId:2},ingestionSourcesByActor:{},preserved:{value:"keep"}};
  await writeFile(path,JSON.stringify(initial),{mode:0o600});let admin=true,visible=true,tests=0;
  const active=[],store=await createOperatorConfigStore(path,c=>{queryBindings(c.queryConnections);ingestionPolicies(c.ingestionSourcesByActor)},c=>applyQueryBindings(active,c.queryConnections));
  const context={actor,cookieHeader:"PLAY_SESSION=fixture; actor=fixture",signal:new AbortController().signal,assertActive(){}};
  const fetchImpl=async(_url,options)=>{const q=JSON.parse(options.body).query;
    const data=q.includes("platformPrivileges")?{me:{corpUser:{urn:actor.urn},platformPrivileges:{managePolicies:admin,manageIngestion:admin}}}:{search:{total:1,searchResults:[{entity:{urn,name:"warehouse.dbo.orders"}}]}};
    return new Response(JSON.stringify({data}));};
  const readMetadata=async(urns)=>{if(!visible||urns[0]!==urn)throw new Error("fixture_metadata_denied");return {snapshots:[{urn,platform:"mssql",platformInstanceUrn:null,environment:"PROD",qualifiedName:"warehouse.dbo.orders"}]}};
  const run=async(payload)=>{tests++;if(payload.operation!=="test_connection")throw new Error("unexpected operation");return {status:"CONNECTED",selectPermissionsVerified:false}};
  const host=createConnectionSettingsHost({store,tenant:actor.tenant,frontendOrigin:"http://fixture.invalid",fetchImpl,readMetadata,run});
  return {dir,path,initial,actor,urn,store,active,context,host,fetchImpl,readMetadata,run,get tests(){return tests},setAdmin:v=>{admin=v},setVisible:v=>{visible=v},call:(body,ctx=context)=>host(JSON.stringify(body),ctx),
    async input(id="warehouse-query"){const state=await store.current();return {action:"save",id,existing:state.config.queryConnections.some(b=>b.id===id),revision:state.revision,datasetUrn:urn,connection:{host:"db.fixture.invalid",port:1433,username:"readonly",password:"FIXTURE_PASSWORD_NEVER_RETURN",database:"Warehouse",tls:"system"}}}};
}

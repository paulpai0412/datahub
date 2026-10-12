import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createSourceSettingsStore, createSourceSettingsHost } from "../../extensions/datahub-agent/integration/source-settings.mjs";

export async function sourceSettingsFixture(count = 91) {
  const actor = { key: "a".repeat(48), urn: "urn:li:corpuser:admin", tenant: "fixture" };
  const urn = "urn:li:dataHubIngestionSource:11111111-1111-4111-8111-111111111111";
  const protectedUrn = "urn:li:dataHubIngestionSource:22222222-2222-4222-8222-222222222222";
  const recipe = JSON.stringify({ source: { type: "mssql", config: { database: "AdventureWorks2019", password: "${FIXTURE_SECRET_NAME}" } }, sink: { type: "datahub-rest", config: { token: "${FIXTURE_TOKEN_NAME}" } } });
  const datasets = Array.from({ length: count }, (_, i) => `urn:li:dataset:(urn:li:dataPlatform:mssql,adventureworks2019.production.table_${i},PROD)`);
  const dir = await mkdtemp(join(tmpdir(), "datahub-source-settings-")), path = join(dir, "operator.json");
  const agentUrn = "urn:li:aiAgent:fixture-configured-agent";
  const protectedPolicy = { semanticAgentUrn: agentUrn, semanticAuditAudience: "EXISTING_TASK_RUN_ACL", urn: protectedUrn, cliVersion: "1.7.0.9", recipeSha256: "b".repeat(64), taskDatasets: ["urn:li:dataset:(urn:li:dataPlatform:mssql,salesdatamart.dm.fact,PROD)"], semanticModelContextApproved: true };
  const initial = { sourceSettingsEnabled: true, tenant: "fixture", runtimeImageId: "fixture-image", unchanged: { nested: "operator-only" }, ingestionSourcesByActor: { [actor.key]: [protectedPolicy], ["b".repeat(48)]: [protectedPolicy] } };
  await writeFile(path, JSON.stringify(initial, null, 2) + "\n", { mode: 0o600 });
  let applied, privileges = true, version = "5", calls = [], removed = new Set(), denied = new Set(), foreign = new Set();
  const store = await createSourceSettingsStore(path, (policies) => {
    applied ??= new Map(); applied.clear();
    for (const [key, value] of policies) applied.set(key, value);
  });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url: String(url), body });
    let result;
    if (String(url).includes("graphql")) {
      if (body.query.includes(" me ")) result = { data: { me: { corpUser: { urn: actor.urn }, platformPrivileges: { manageIngestion: true, managePolicies: privileges } } } };
      else if (body.query.includes("getGrantedPrivileges")) result = { data: { getGrantedPrivileges: { privileges: denied.has(body.variables.input.resourceSpec.resourceUrn) ? [] : ["VIEW_ENTITY_PAGE"] } } };
      else if (body.query.includes("listIngestionSources")) result = { data: { listIngestionSources: { start: body.variables.input.start, count: 2, total: 2, ingestionSources: [{ urn, name: "AdventureWorks <script>", type: "mssql", latestSuccessfulExecution: { urn: "urn:li:dataHubExecutionRequest:fixture" } }, { urn: protectedUrn, name: "Protected", type: "mssql" }] } } };
      else if (body.query.includes("search(")) { const { start, count: size } = body.variables.input; result = { data: { search: { start, count: size, total: datasets.length, searchResults: datasets.slice(start, start + size).map((urn) => ({ entity: { urn } })) } } }; }
      else throw Error("fixture unexpected query");
    } else {
      const target = body[0].urn;
      if (target.startsWith("urn:li:dataHubIngestionSource:")) result = [{ urn: target, dataHubIngestionSourceInfo: { systemMetadata: { version }, value: { name: "AdventureWorks <script>", type: "mssql", config: { recipe, version: "1.7.0.9" } } } }];
      else result = [{ urn: target, datasetKey: { value: { platform: "urn:li:dataPlatform:mssql", name: target, origin: "PROD" }, systemMetadata: { version: "1" } }, datasetProperties: { value: { name: target }, systemMetadata: { version: "1" } }, status: { value: { removed: removed.has(target) }, systemMetadata: { version: "1" } }, schemaMetadata: { value: { fields: [{ fieldPath: "id" }] }, systemMetadata: { pipelineName: foreign.has(target) ? protectedUrn : urn, runId: "historic-successful-run", version: "1" } } }];
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const host = createSourceSettingsHost({ store, frontendOrigin: "http://fixture.invalid", fetchImpl });
  const context = { actor, cookieHeader: "PLAY_SESSION=synthetic; actor=synthetic", assertActive() {} };
  return { actor, agentUrn, urn, protectedUrn, recipe, datasets, dir, path, store, initial, protectedPolicy, calls, removed, denied, foreign,
    call: (request, ctx = context) => host(JSON.stringify(request), ctx),
    setPrivileges: (value) => { privileges = value; }, setVersion: (value) => { version = value; }, get applied() { return applied; },
    hashRecipe: createHash("sha256").update(recipe).digest("hex"), context, fetchImpl };
}

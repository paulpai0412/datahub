// Real Chromium + product Host views/bridge; synthetic API/Pi, never live acceptance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "/home/timmypai/apps/datahub/extensions/datahub-agent/pi-web/node_modules/playwright/test.mjs";
import {
 makePublicationReview,
 canonicalPublicationJson,
} from "../extensions/datahub-agent/integration/publication-review.mjs";
import { chromium } from "/home/timmypai/apps/datahub/extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs";
import {
 makeFixedEtlReview,
 FIXED_ETL_DEFINITION_JSON,
} from "../extensions/datahub-agent/integration/fixed-etl-review.mjs";
const scripts = new Map(
 await Promise.all(
  ["task-decision.js"].map(async (name) => [
   "/" + name,
   await readFile(
    new URL("../extensions/datahub-agent/mfe/" + name, import.meta.url),
   ),
  ]),
 ),
);
const child = `<script>window.responses=[];window.ports=[];window.intent=body=>{const channel=new MessageChannel();ports.push(channel.port1);channel.port1.onmessage=e=>responses.push(JSON.parse(e.data));parent.postMessage({type:'datahub-task-decision',body:JSON.stringify(body),uiRequestId:'native-ui'},'*',[channel.port2])};</script>`;
const server = createServer((req, res) => {
 res.setHeader("cache-control", "no-store");
 if (scripts.has(req.url)) {
  res.setHeader("content-type", "text/javascript");
  res.end(scripts.get(req.url));
  return;
 }
 res.setHeader("content-type", "text/html");
 if (
  req.headers.host.startsWith("127.0.0.1") ||
  req.url.startsWith("/child") ||
  req.url === "/other"
 ) {
  res.end(child);
  return;
 }
 const port = server.address().port;
 res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Task UI fixture — not live DataHub</title>
<main id="host"><iframe id="agent" title="Fixture Pi" src="http://127.0.0.1:${port}/child"></iframe><iframe id="other" title="Wrong frame" src="http://127.0.0.1:${port}/other"></iframe></main>
<script type="module">
import {installTaskDecisionBridge} from '/task-decision.js';
window.calls=[];window.updates=[];window.versions=[];window.failPrepare=false;
const actorKey='${"a".repeat(48)}', source='urn:li:dataHubIngestionSource:fixture', dataset='urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.person,DEV)';
const frame=document.querySelector('#agent'),container=document.querySelector('#host'),origin='http://127.0.0.1:${port}';
let run={urn:'urn:li:dataProcessInstance:ekop-agent-'+actorKey+'-fixture',version:'1',value:{actor:'urn:li:corpuser:fixture',task:'urn:li:dataJob:(urn:li:dataFlow:(pi,fixture,DEV),fixture-task)',source,taskVersion:'1',sessionId:'00000000-0000-4000-8000-000000000020',decisions:[]}};
window.runUrn=run.urn;
function save(value){versions.push(structuredClone(value));run={urn:run.urn,version:String(versions.length+1),value};return structuredClone(run)}
// Test-only simulation of the internal Host compiler, not an agent/API action.
window.stagePublication=(request,publicationReview)=>save({...run.value,decisions:[...run.value.decisions,{id:request.requestId,question:request.question,choices:request.choices,requestedAt:Date.now(),publicationReview}]});
window.stageExecution=(request,executionReview)=>save({...run.value,decisions:[...run.value.decisions,{id:request.requestId,question:request.question,choices:request.choices,requestedAt:Date.now(),executionReview}]});
async function send(input,signal){
 calls.push(input);
 if(input.action==='respond_execution_review'){
   const d=structuredClone(run.value.decisions.find(d=>d.id===input.requestId));
   if(input.planDigest!==d.executionReview.planDigest||input.verdict!=='APPROVE'||input.text||input.actor)throw Error('invalid ETL consent');
   d.response={action:'RESPOND',actor:'urn:li:corpuser:fixture',respondedAt:Date.now(),executionVerdict:{purpose:'FIXED_ETL',planDigest:input.planDigest,verdict:input.verdict}};
   save({...run.value,decisions:run.value.decisions.map(v=>v.id===d.id?d:v)});return {run:structuredClone(run),decision:d};
 }

 if(input.action==='prepare_decision'){if(window.failPrepare)throw Error('workspace_no_changes');let d=run.value.decisions.find(d=>d.id===input.requestId);if(!d){d={id:input.requestId,question:input.question,choices:input.choices,requestedAt:1000};save({...run.value,decisions:[...run.value.decisions,d]})}return {run:structuredClone(run),decision:structuredClone(d)}};
 if(input.action==='respond_publication_review'){
   const d=structuredClone(run.value.decisions.find(d=>d.id===input.requestId));
   if(input.planDigest!==d.publicationReview.planDigest||!['APPROVE','REJECT'].includes(input.verdict)||input.actionValue||input.actor||input.text)throw Error('invalid typed response');
   d.response={action:'RESPOND',actor:'urn:li:corpuser:fixture',respondedAt:Date.now(),text:'Review recorded; not published.',publicationVerdict:{purpose:d.publicationReview.purpose,planDigest:input.planDigest,verdict:input.verdict}};
   save({...run.value,decisions:run.value.decisions.map(v=>v.id===d.id?d:v)});return {run:structuredClone(run),decision:d};
 }
 if(input.action==='respond_decision'){
   const d=structuredClone(run.value.decisions.find(d=>d.id===input.requestId));d.response={action:input.actionValue,actor:'urn:li:corpuser:fixture',respondedAt:2000,...(input.text?{text:input.text}:{})};
   save({...run.value,decisions:run.value.decisions.map(v=>v.id===d.id?d:v),...(input.actionValue==='DISMISS'?{closedAt:2000}:{})});
   if(input.actionValue==='DISMISS')return await new Promise((resolve,reject)=>{window.stopSignal=signal;window.finishStop=()=>resolve({run:structuredClone(run),stopObserved:true});signal.addEventListener('abort',()=>reject(Error('aborted stop')),{once:true})});
   return {run:structuredClone(run),decision:d};
 }
 if(input.action==='cancel_run')return {run:save({...run.value,closedAt:3000}),stopObserved:true};
 throw Error('unexpected fixture action');
}
window.stop=installTaskDecisionBridge({container,frame,origin,send,onUpdate:value=>updates.push(value)});
window.cleanup=()=>stop();window.ready=true;
</script>`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
const browserHome = await mkdtemp(join(tmpdir(), "datahub-task-ui-"));
try {
 browser = await chromium.launch({
  executablePath:
   process.env.DATAHUB_TEST_CHROMIUM || chromium.executablePath(),
  headless: true,
  chromiumSandbox: true,
  env: { HOME: browserHome, PATH: process.env.PATH, LANG: "C.UTF-8" },
 });
 const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
 });
 await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  return ["localhost", "127.0.0.1"].includes(url.hostname) &&
   url.port === String(server.address().port)
   ? route.continue()
   : route.abort();
 });
 const page = await context.newPage();
 const errors = [];
 page.on("pageerror", (e) => errors.push(e.message));
 await page.goto(`http://localhost:${server.address().port}/`);
 await page.waitForFunction(() => window.ready);
 const currentAgent = await (
  await page.locator("#agent").elementHandle()
 ).contentFrame();
 await currentAgent.waitForFunction(() => typeof window.intent === "function");
 const runUrn = await page.evaluate(() => window.runUrn);
 const request = {
  runUrn,
  requestId: "00000000-0000-4000-8000-000000000030",
  question: "Read lineage now?",
  choices: ["Continue", "End"],
 };
 const other = page.frames().find((f) => f.url().endsWith("/other"));
 await other.waitForFunction(() => typeof window.intent === "function");
 await other.evaluate((request) => intent(request), request);
 await page.evaluate(
  (request) =>
   window.dispatchEvent(
    new MessageEvent("message", {
     origin: "https://evil.example",
     source: document.querySelector("#agent").contentWindow,
     data: {
      type: "datahub-task-decision",
      body: JSON.stringify(request),
      uiRequestId: "native-ui",
     },
     ports: [new MessageChannel().port1],
    }),
   ),
  request,
 );
 await currentAgent.evaluate((request) => intent(request), request);
 await page.getByRole("dialog").waitFor();
 assert.equal(
  await page.evaluate(
   () => calls.filter((c) => c.action === "prepare_decision").length,
  ),
  1,
 );
 assert.equal(
  await page.evaluate(
   () => calls.filter((c) => c.action === "respond_decision").length,
  ),
  0,
 );
 assert.equal(
  await page
   .getByLabel("Decision response", { exact: true })
   .evaluate((el) => el === document.activeElement),
  true,
 );
 await page.setViewportSize({ width: 390, height: 844 });
 for (const name of ["End task", "Respond and continue"]) {
  const box = await page
   .getByRole("button", { name, exact: true })
   .boundingBox();
  assert(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390);
 }
 await page.getByRole("button", { name: "Continue", exact: true }).click();
 await page
  .getByRole("button", { name: "Respond and continue", exact: true })
  .click();
 await currentAgent.waitForFunction(() => responses.length === 1);
 assert.equal(
  await currentAgent.evaluate(() => responses[0].response.text),
  "Continue",
 );
 assert.equal(
  await page.evaluate(
   () => calls.filter((c) => c.action === "respond_decision").length,
  ),
  1,
 );
 // The same native request is still pending in this fixture: replay the stored answer, not another human write.
 await currentAgent.evaluate((request) => intent(request), request);
 await currentAgent.waitForFunction(() => responses.length === 2);
 assert.equal(await page.getByRole("dialog").count(), 0);
 assert.equal(
  await page.evaluate(
   () => calls.filter((c) => c.action === "respond_decision").length,
  ),
  1,
 );
 for (const [index, purpose] of ["LINEAGE", "SEMANTIC"].entries()) {
  const proposal = makePublicationReview({
   purpose,
   source: "urn:li:dataHubIngestionSource:fixture",
   sourceId: "fixture-code",
   snapshotSha256: "1".repeat(64),
   candidateDigest: "2".repeat(64),
   analysisVersion: "1.0.2",
   candidateIds: [`cand_${"4".repeat(24)}`],
   datasets: ["urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.person,DEV)"],
   expiresAt: Date.now() + 60000,
   changes: [
    {
     urn: "urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.person,DEV)",
     aspect: purpose === "LINEAGE" ? "datasetProperties" : "globalTags",
     expectedVersion: "1",
     valueJson: canonicalPublicationJson(
      purpose === "LINEAGE"
       ? { description: '<img src=x onerror="window.reviewXss=true">' }
       : { tags: [] },
     ),
    },
   ],
  });
  const typedRequest = {
   ...request,
   requestId: `00000000-0000-4000-8000-00000000004${index}`,
  };
  await page.evaluate(
   ({ request, proposal }) => stagePublication(request, proposal),
   { request: typedRequest, proposal },
  );
  const count = await currentAgent.evaluate(() => responses.length);
  await currentAgent.evaluate((request) => intent(request), typedRequest);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(proposal.planDigest);
  await expect(
   dialog.getByRole("button", { name: "Reject publication", exact: true }),
  ).toBeFocused();
  await expect(
   page.getByLabel("Decision response", { exact: true }),
  ).toBeHidden();
  await dialog.locator("summary").click();
  await expect(dialog.locator("pre")).toHaveText(proposal.changes[0].valueJson);
  assert.equal(await dialog.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => window.reviewXss), undefined);
  for (const name of [
   "Reject publication",
   `Approve ${purpose.toLowerCase()} metadata`,
  ]) {
   const box = await dialog
    .getByRole("button", { name, exact: true })
    .boundingBox();
   assert(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390);
  }
  if (index === 0 && process.env.DATAHUB_TEST_PUBLICATION_SCREENSHOT)
   await page.screenshot({
    path: process.env.DATAHUB_TEST_PUBLICATION_SCREENSHOT,
    fullPage: true,
   });
  const verdict = index === 0 ? "APPROVE" : "REJECT";
  await dialog
   .getByRole("button", {
    name:
     verdict === "APPROVE" ? "Approve lineage metadata" : "Reject publication",
    exact: true,
   })
   .click();
  await expect
   .poll(() => currentAgent.evaluate(() => responses.length))
   .toBe(count + 1);
  const result = await currentAgent.evaluate(() => responses.at(-1));
  assert.deepEqual(result.response.publicationVerdict, {
   purpose,
   planDigest: proposal.planDigest,
   verdict,
  });
 }
 assert.equal(
  await page.evaluate(
   () => calls.filter((c) => c.action === "respond_publication_review").length,
  ),
  2,
 );
 const executionReview = makeFixedEtlReview({
  purpose: "FIXED_ETL",
  source: "urn:li:dataHubIngestionSource:fixture",
  datasets: ["urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.person,DEV)"],
  definitionJson: FIXED_ETL_DEFINITION_JSON,
  codeSha256: "a".repeat(64),
  expiresAt: Date.now() + 600000,
 });
 const executionRequest = {
  ...request,
  requestId: "00000000-0000-4000-8000-000000000050",
  question: "Run the fixed ETL?",
 };
 await page.evaluate(({ request, review }) => stageExecution(request, review), {
  request: executionRequest,
  review: executionReview,
 });
 const beforeExecution = await currentAgent.evaluate(() => responses.length);
 await currentAgent.evaluate((request) => intent(request), executionRequest);
 const executionDialog = page.getByRole("dialog", {
  name: "Fixed ETL execution review",
 });
 await expect(executionDialog).toBeVisible();
 await expect(executionDialog).toContainText(executionReview.planDigest);
 await expect(executionDialog).toContainText(
  "no cross-table snapshot guarantee",
 );
 await expect(
  executionDialog.getByRole("button", {
   name: "Reject ETL execution",
   exact: true,
  }),
 ).toBeFocused();
 await expect(
  page.getByLabel("Decision response", { exact: true }),
 ).toBeHidden();
 for (const name of ["Approve fixed ETL", "Reject ETL execution"]) {
  const box = await executionDialog
   .getByRole("button", { name, exact: true })
   .boundingBox();
  assert(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390);
 }
 await executionDialog
  .getByRole("button", { name: "Approve fixed ETL", exact: true })
  .click();
 await expect
  .poll(() => currentAgent.evaluate(() => responses.length))
  .toBe(beforeExecution + 1);
 assert.deepEqual(
  await currentAgent.evaluate(() => responses.at(-1).response.executionVerdict),
  {
   purpose: "FIXED_ETL",
   planDigest: executionReview.planDigest,
   verdict: "APPROVE",
  },
 );
 assert.equal(
  await page.evaluate(
   () => calls.filter((c) => c.action === "respond_execution_review").length,
  ),
  1,
 );
 const failedRequest = {
  ...request,
  requestId: "00000000-0000-4000-8000-000000000030",
 };
 await page.evaluate(() => (window.failPrepare = true));
 const beforeFailed = await currentAgent.evaluate(() => responses.length);
 await currentAgent.evaluate((request) => intent(request), failedRequest);
 await currentAgent.waitForFunction(
  (count) => responses.length === count + 1,
  beforeFailed,
 );
 assert.equal(
  await currentAgent.evaluate(() => responses.at(-1).error),
  "workspace_no_changes",
 );
 await page.evaluate(() => (window.failPrepare = false));
 const second = {
  ...request,
  requestId: "00000000-0000-4000-8000-000000000031",
 };
 await currentAgent.evaluate((request) => intent(request), second);
 await page.getByRole("dialog").waitFor();
 await page.getByRole("button", { name: "End task", exact: true }).click();
 await page.waitForFunction(() => typeof finishStop === "function");
 await currentAgent.evaluate(() =>
  ports.at(-1).postMessage({ type: "cancel" }),
 );
 await page.evaluate(() => finishStop());
 await page.waitForFunction(() => updates.at(-1)?.stopObserved === true);
 assert.equal(await page.evaluate(() => stopSignal.aborted), false);
 assert.equal(await page.evaluate(() => versions.at(-1).closedAt), 2000);
 await page.evaluate(() => cleanup());
 assert.equal(await page.getByRole("dialog").count(), 0);
 assert.deepEqual(errors, []);
 console.log(
  "PASS Chromium Task Decision fixture: typed lineage approve + semantic reject with exact changes/digest and safe focus/text, dismiss/stop-unmount race, 390px controls, cleanup. Distinct fixed ETL typed approve/digest/scope/focus also verified. Synthetic Host/Pi; no SQL, live publication or model acceptance.",
 );
} finally {
 await browser?.close();
 await rm(browserHome, { recursive: true, force: true });
 server.closeAllConnections();
 await new Promise((resolve) => server.close(resolve));
}

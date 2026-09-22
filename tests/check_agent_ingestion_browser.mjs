// Real browser + shipped MFE module; synthetic API only, no DataHub credentials/data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from '../extensions/datahub-agent/pi-web/node_modules/playwright/index.mjs';

const code = await readFile(new URL('../extensions/datahub-agent/mfe/ingestion.js', import.meta.url));
const child = `<script>
window.responses=[];window.ports=[];
window.intent=(body)=>{const c=new MessageChannel();window.ports.push(c.port1);c.port1.onmessage=e=>{responses.push(JSON.parse(e.data));c.port1.close()};parent.postMessage({type:'datahub-ingestion',body:JSON.stringify(body)},'*',[c.port2]);};
</script>`;
const server = createServer((req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.url === '/bridge.js') { res.setHeader('content-type', 'text/javascript'); res.end(code); return; }
  res.setHeader('content-type', 'text/html');
  if (req.url !== '/') { res.end(child); return; }
  const port = server.address().port;
  res.end(`<!doctype html><title>Ingestion fixture — not live DataHub</title><main id="host"><iframe id="agent" src="http://127.0.0.1:${port}/child"></iframe><iframe id="other" src="http://127.0.0.1:${port}/other"></iframe></main>
<script type="module">
import {installIngestionBridge} from '/bridge.js';
window.calls=[];window.slow=false;window.fail=false;
window.stop=installIngestionBridge({container:document.querySelector('#host'),frame:document.querySelector('#agent'),origin:'http://127.0.0.1:${port}',send:async(request,signal)=>{
 calls.push(request);
 if(window.fail)throw Error('private upstream text');
 if(window.slow)await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true})});
 if(request.action==='inspect_source')return {sourceVersion:'3',name:'Fixture only',scope:{database:'Fixture',table_pattern:{allow:['^Fixture.Person$']}}};
 return {state:request.action==='get_execution'?'RUNNING':'submitted',executionUrn:'urn:li:dataHubExecutionRequest:fixture'};
}});window.ready=true;
</script>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.DATAHUB_TEST_CHROMIUM || chromium.executablePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForFunction(() => window.ready);
  const agent = page.frames().find(frame => frame.url().endsWith('/child'));
  const other = page.frames().find(frame => frame.url().endsWith('/other'));
  await agent.waitForFunction(() => typeof window.intent === 'function');
  await other.waitForFunction(() => typeof window.intent === 'function');
  const request = { requestId: '00000000-0000-4000-8000-000000000002', sourceUrn: 'urn:li:dataHubIngestionSource:00000000-0000-4000-8000-000000000001', action: 'run' };
  // Same origin, wrong actual window; and correct actual window, forged origin.
  await other.evaluate(request => window.intent(request), request);
  await page.evaluate(request => window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.example', source: document.querySelector('#agent').contentWindow, data: { type: 'datahub-ingestion', body: JSON.stringify(request) }, ports: [new MessageChannel().port1] })), request);
  await page.locator('#agent').focus();
  await agent.evaluate(request => window.intent(request), request);
  await page.getByRole('dialog').waitFor();
  assert.deepEqual(await page.evaluate(() => calls.map(x => x.action)), ['inspect_source']);
  assert.equal(await page.getByRole('button', { name: 'Do not execute' }).evaluate(el => el === document.activeElement), true);
  await page.getByRole('button', { name: 'Do not execute' }).click();
  await agent.waitForFunction(() => responses.length === 1);
  assert.equal(await agent.evaluate(() => responses[0].state), 'declined');
  assert.equal(await page.evaluate(() => calls.length), 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'agent');

  await agent.evaluate(request => window.intent({ ...request, expectedSourceVersion: 'forged' }), request);
  await page.getByRole('dialog').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['Do not execute', 'Confirm operation']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844);
  }
  if (process.env.DATAHUB_TEST_SCREENSHOT) await page.screenshot({ path: process.env.DATAHUB_TEST_SCREENSHOT });
  await page.getByRole('button', { name: 'Confirm operation' }).click();
  await agent.waitForFunction(() => responses.length === 2);
  assert.equal(await agent.evaluate(() => responses[1].state), 'submitted');
  assert.deepEqual(await page.evaluate(() => calls.map(x => x.action)), ['inspect_source', 'inspect_source', 'run']);
  assert.equal(await page.evaluate(() => calls.at(-1).expectedSourceVersion), '3');

  await agent.evaluate(request => window.intent(request), request);
  await page.getByRole('dialog').waitFor();
  await agent.evaluate(() => ports.at(-1).postMessage({ type: 'cancel' }));
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await agent.waitForFunction(() => responses.length === 3);
  assert.equal(await page.evaluate(() => calls.filter(x => x.action === 'run').length), 1);

  await page.evaluate(() => { window.slow = true; });
  await agent.evaluate(request => window.intent(request), request);
  await page.waitForFunction(() => calls.length === 5);
  await page.evaluate(() => window.stop());
  await agent.waitForFunction(() => responses.length === 4);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => calls.filter(x => x.action === 'run').length), 1);
  assert.equal(await agent.evaluate(() => JSON.stringify(responses).includes('private upstream text')), false);
  assert.deepEqual(errors, []);
  console.log('MFE Chromium fixture PASS: wrong window/origin rejected; deny, confirm with host version, caller cancel, unmount during preview; no live DataHub/Agent claim.');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

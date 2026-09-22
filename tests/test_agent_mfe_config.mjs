// Source-level official MFE consumer checks. No Docker, HTTP, login, or model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "../extensions/datahub-agent/pi-web/node_modules/typescript/lib/typescript.js";
const require = createRequire(
  new URL("../extensions/datahub-agent/pi-web/package.json", import.meta.url),
);
const yaml = require("js-yaml");

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(root + path, "utf8");
const core = "upstream/datahub/datahub-web-react/src/app/mfeframework/";
const configText = read("extensions/datahub-agent/deploy/mfe.config.yaml");
const config = yaml.load(configText);
const server = JSON.parse(
  read("extensions/datahub-agent/deploy/agent-server.example.json"),
);

// Execute the unchanged named producer/consumer bodies, not a rewritten loader.
// React, icon and hook shells are fixtures; actual browser rendering is NOT tested.
function declarations(path, names) {
  const source = ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const selected = source.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((d) =>
          names.includes(d.name.getText(source)),
        )),
  );
  assert.equal(
    selected.length,
    names.length,
    "fixed upstream consumer definitions must be found exactly once",
  );
  return selected.map((node) => node.getText(source)).join("\n");
}
const consumerSource =
  declarations(core + "mfeConfigLoader.tsx", [
    "REQUIRED_FIELDS",
    "validateMFEConfig",
    "loadMFEConfigFromYAML",
    "useDynamicRoutes",
  ]) +
  "\n" +
  declarations(core + "mfeNavBarMenuUtils.tsx", ["getMfeMenuItems"]);
const compiled = ts.transpileModule(consumerSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.React,
  },
  reportDiagnostics: true,
});
assert.deepEqual(
  compiled.diagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  ),
  [],
);
const context = vm.createContext({
  exports: {},
  yaml,
  console: { log() {}, error() {} },
  React: { createElement: (type, props) => ({ type, props }) },
  Route: "Route",
  MFEBaseConfigurablePage: "MFEBaseConfigurablePage",
  useMFEConfigFromBackend: () => config,
  getLazyIcon: (name) => name,
  NavBarMenuItemTypes: { Item: "item" },
});
vm.runInContext(compiled.outputText, context, { timeout: 1000 });
const api = context.exports;

test("official loader accepts exactly one public Agent entry matching gateway", () => {
  const parsed = api.loadMFEConfigFromYAML(configText);
  assert.equal(parsed.microFrontends.length, 1);
  assert.equal(parsed.subNavigationMode, false);
  assert.equal(parsed.topLevelMenuTitle, "Agent");
  assert.deepEqual(Object.keys(parsed.microFrontends[0]).sort(), [
    "flags",
    "id",
    "label",
    "module",
    "navIcon",
    "path",
    "remoteEntry",
  ]);
  const agent = parsed.microFrontends[0];
  assert.equal(agent.path, "/agent");
  assert.equal(agent.label, "Agent");
  assert.equal(agent.module, "datahubAgentMFE/mount");
  assert.equal(
    agent.remoteEntry,
    new URL("/mfe/remoteEntry.js", server.gatewayOrigin).href,
  );
  assert.equal(agent.flags.enabled, true);
  assert.equal(agent.flags.showInNav, true);
});

test("official navigation and route helpers produce only /mfe/agent", () => {
  const items = api.getMfeMenuItems(config);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Agent");
  assert.equal(items[0].link, "/mfe/agent");
  const routes = api.useDynamicRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].props.path, items[0].link);
  assert.equal(routes[0].props.exact, true);
  assert.equal(routes[0].props.render().props.config, config.microFrontends[0]);
});

test("official loader rejects missing module; hidden nav does not imply authorization", () => {
  const broken = structuredClone(config);
  delete broken.microFrontends[0].module;
  assert.equal(
    api.loadMFEConfigFromYAML(yaml.dump(broken)).microFrontends.length,
    0,
  );
  const hidden = structuredClone(config);
  hidden.microFrontends[0].flags.showInNav = false;
  assert.equal(api.getMfeMenuItems(hidden).length, 0);
});

test("opt-in overlay changes only frontend env and one read-only public mount", () => {
  const overlay = yaml.load(read("deploy/compose.agent.yaml"));
  assert.deepEqual(Object.keys(overlay), ["services"]);
  assert.deepEqual(Object.keys(overlay.services), ["frontend-quickstart"]);
  assert.deepEqual(overlay.services["frontend-quickstart"], {
    environment: { MFE_CONFIG_FILE_PATH: "/etc/datahub-agent/mfe.config.yaml" },
    volumes: [
      "./extensions/datahub-agent/deploy/mfe.config.yaml:/etc/datahub-agent/mfe.config.yaml:ro",
    ],
  });
  assert.ok(
    !read("scripts/compose.sh").includes("compose.agent.yaml"),
    "normal compose commands must not opt in",
  );
  assert.equal(server.datahubOrigin, "http://localhost:9002");
  assert.equal(server.gatewayOrigin, "http://localhost:9041");
  assert.deepEqual(Object.keys(server).sort(), [
    "browserAssetsDirectory",
    "cpus",
    "datahubOrigin",
    "gatewayOrigin",
    "maxRuntimes",
    "memoryMiB",
    "runtimeImageId",
    "scope",
    "tenant",
  ]);
  assert.match(server.runtimeImageId, /^sha256:[a-f0-9]{64}$/);
});

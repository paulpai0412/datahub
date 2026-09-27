import assert from "node:assert/strict";
import test from "node:test";
import { queryMetadataReader } from "../extensions/datahub-agent/integration/query-metadata.mjs";
import { CATALOG_QUERIES } from "../extensions/datahub-agent/integration/native-catalog.mjs";
import { context } from "./fixtures/query-fixture.mjs";

function reader({ platform = "mssql", environment = "TEST" } = {}) {
  return queryMetadataReader({
    frontendOrigin: "http://localhost:9002",
    fetchImpl: async (_url, options) => {
      const { query, variables } = JSON.parse(options.body);
      const data =
        query === CATALOG_QUERIES.identity
          ? { me: { corpUser: { urn: context.actor.urn } } }
          : query === CATALOG_QUERIES.privileges
            ? { getGrantedPrivileges: { privileges: ["GET_ENTITY"] } }
            : {
                entity: {
                  urn: variables.urn,
                  type: "DATASET",
                  name: "Display label is not a locator",
                  properties: { origin: environment, qualifiedName: null },
                  platform: { name: platform },
                  schemaMetadata: {
                    version: 1,
                    fields: [
                      {
                        fieldPath: "id",
                        nativeDataType: "int",
                        type: "NUMBER",
                      },
                    ],
                  },
                },
              };
      return Response.json({ data });
    },
  });
}
for (const name of [
  "instance.Demo.dbo.Orders",
  "Demo.dbo.含空白 table",
  "Demo.dbo.a%2Cb",
])
  test(`native DatasetKey keeps the exact name: ${name}`, async () => {
    const urn = `urn:li:dataset:(urn:li:dataPlatform:mssql,${name},TEST)`;
    const { snapshots } = await reader()([urn], context);
    assert.equal(snapshots[0].qualifiedName, name);
  });
for (const [label, options] of [
  ["platform", { platform: "mysql" }],
  ["environment", { environment: "PROD" }],
])
  test(`metadata ${label} mismatch cannot redirect a DatasetKey`, async () => {
    await assert.rejects(
      reader(options)(
        ["urn:li:dataset:(urn:li:dataPlatform:mssql,Demo.dbo.Orders,TEST)"],
        context,
      ),
      /query_metadata_identity_mismatch/,
    );
  });
test("malformed DatasetKey is not repaired from display properties", async () => {
  await assert.rejects(
    reader()(["urn:li:dataset:display-only"], context),
    /query_metadata_identity_mismatch/,
  );
});

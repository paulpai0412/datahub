import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
const alias = () => Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,62}$" });
const ref = () =>
  Type.Object(
    { dataset: alias(), field: Type.String({ minLength: 1, maxLength: 256 }) },
    { additionalProperties: false },
  );
const scalar = Type.Union([
  Type.String({ maxLength: 2048 }),
  Type.Number(),
  Type.Boolean(),
]);
export const queryParameters = Type.Object(
  {
    plan: Type.Object(
      {
        datasets: Type.Array(
          Type.Object(
            {
              urn: Type.String({
                pattern: "^urn:li:dataset:",
                maxLength: 1024,
              }),
              alias: alias(),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 8 },
        ),
        joins: Type.Array(
          Type.Object(
            {
              dataset: alias(),
              type: StringEnum(["inner", "left", "full"] as const),
              on: Type.Array(
                Type.Object(
                  {
                    left: ref(),
                    op: StringEnum([
                      "eq",
                      "ne",
                      "gt",
                      "gte",
                      "lt",
                      "lte",
                    ] as const),
                    right: ref(),
                  },
                  { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 16 },
              ),
            },
            { additionalProperties: false },
          ),
          { maxItems: 7 },
        ),
        select: Type.Array(
          Type.Object(
            {
              field: Type.Union([ref(), Type.Null()]),
              as: alias(),
              aggregate: Type.Optional(
                StringEnum([
                  "sum",
                  "avg",
                  "min",
                  "max",
                  "count",
                  "count_distinct",
                ] as const),
              ),
              bucket: Type.Optional(
                StringEnum(["day", "month", "year"] as const),
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 32 },
        ),
        filters: Type.Array(
          Type.Object(
            {
              field: ref(),
              op: StringEnum([
                "eq",
                "ne",
                "gt",
                "gte",
                "lt",
                "lte",
                "like",
                "in",
                "between",
                "is_null",
                "not_null",
              ] as const),
              value: Type.Optional(
                Type.Union([
                  scalar,
                  Type.Array(scalar, { minItems: 1, maxItems: 100 }),
                ]),
              ),
            },
            { additionalProperties: false },
          ),
          { maxItems: 32 },
        ),
        groupBy: Type.Array(alias(), { maxItems: 16 }),
        orderBy: Type.Array(
          Type.Object(
            { field: alias(), direction: StringEnum(["asc", "desc"] as const) },
            { additionalProperties: false },
          ),
          { maxItems: 16 },
        ),
        limit: Type.Integer({ minimum: 1, maximum: 1000 }),
      },
      { additionalProperties: false },
    ),
    chart: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 160 }),
        type: StringEnum(["table", "bar", "timeseries", "stat"] as const),
        x: Type.Optional(alias()),
        y: Type.Optional(Type.Array(alias(), { minItems: 1, maxItems: 16 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

import { createHash } from "node:crypto";
import { canonicalPublicationJson as canonical } from "./publication-review.mjs";

export const FIXED_ETL_RUNTIME = Object.freeze({
    python: "3.11.15",
    SQLAlchemy: "1.4.54",
    "python-tds": "1.17.1",
    "sqlalchemy-pytds": "0.3.5",
});

/** One case definition, not a general command/recipe execution protocol. */
export const FIXED_ETL_DEFINITION_JSON = canonical({
    format: "sales-datamart.execution-definition/1",
    operationId: "sales-datamart",
    operationVersion: "1.0.1",
    runtime: FIXED_ETL_RUNTIME,
    sourceDatabase: "AdventureWorks2019",
    targetDatabase: "SalesDatamart",
    scope: {
        scope_id: "adventureworks-local-usd-v1",
        start_date: "2011-05-31",
        end_date: "2014-06-30",
        status: 5,
        currency_scope: "CurrencyRateID IS NULL",
    },
    loginTimeoutSeconds: 5,
    dbapiTimeoutSeconds: 30,
    maxFetchedRowsPerQuery: 100000,
    maxRuntimeSeconds: 300,
    maxAddressSpaceBytes: 1073741824,
    maxCpuSeconds: 300,
    commitWaitSeconds: 30,
    concurrentWriters: 1,
    sourceConsistency:
        "multi-statement reads; no cross-table snapshot guarantee; requires an approved quiescent source window",
    writes: "Type 1 dimension and fact upserts in one target transaction; no DDL or deletion",
});

export class FixedEtlReviewError extends Error {}
const fail = (code) => {
    throw new FixedEtlReviewError(code);
};
const fields = [
    "purpose",
    "source",
    "datasets",
    "definitionJson",
    "codeSha256",
    "expiresAt",
    "planDigest",
];
const digest = (value) =>
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const urn = (value, kind) =>
    typeof value === "string" &&
    value.length <= 1024 &&
    value.startsWith(`urn:li:${kind}:`);
function shape(value, allowed) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        fail("invalid_fixed_etl_review");
}
function reviewDigest(review) {
    const { planDigest: _ignored, ...proposal } = review;
    return createHash("sha256").update(canonical(proposal)).digest("hex");
}

/** Private Host compiler output only. A model must never supply this object. */
export function makeFixedEtlReview(input) {
    shape(
        input,
        fields.filter((key) => key !== "planDigest"),
    );
    const review = structuredClone(input);
    review.planDigest = reviewDigest(review);
    return validateFixedEtlReview(review);
}
export function validateFixedEtlReview(review, now) {
    shape(review, fields);
    if (
        review.purpose !== "FIXED_ETL" ||
        !urn(review.source, "dataHubIngestionSource") ||
        review.definitionJson !== FIXED_ETL_DEFINITION_JSON ||
        !digest(review.codeSha256) ||
        !digest(review.planDigest) ||
        !Number.isSafeInteger(review.expiresAt) ||
        review.expiresAt <= 0 ||
        !Array.isArray(review.datasets) ||
        !review.datasets.length ||
        review.datasets.length > 16 ||
        review.datasets.some((value) => !urn(value, "dataset")) ||
        new Set(review.datasets).size !== review.datasets.length
    )
        fail("invalid_fixed_etl_review");
    if (reviewDigest(review) !== review.planDigest)
        fail("fixed_etl_review_digest_mismatch");
    if (
        now !== undefined &&
        (!Number.isSafeInteger(now) || now < 0 || now >= review.expiresAt)
    )
        fail("fixed_etl_review_expired");
    return structuredClone(review);
}

/** Only aggregate case receipts cross the process/record boundary. No raw SQL,
 * rows, arbitrary diagnostic strings, paths or credentials are persisted. */
export function validateFixedEtlReceipt(input, ready = false) {
    const keys = [
        "format",
        "status",
        "etl_version",
        "scope",
        "source",
        "target",
        "counts",
        "reconciliation",
        "elapsed_ms",
        "credentials_in_receipt",
        "rows_in_receipt",
        "source_observation",
        ...(ready ? [] : ["committed_at", "readback_at"]),
    ];
    shape(input, keys);
    if (Object.keys(input).length !== keys.length)
        fail("invalid_fixed_etl_receipt");
    const countKeys = [
        "source_products",
        "source_customers",
        "source_territories",
        "source_fact_rows",
        "target_fact_rows",
        "reporting_view_rows",
        "quantity",
        "orders",
    ];
    shape(input.counts, countKeys);
    shape(input.reconciliation, [
        "line_net_amount",
        "source_line_total",
        "aov",
    ]);
    shape(input.source_observation, [
        "started_at",
        "ended_at",
        "consistent_snapshot",
        "isolation",
    ]);
    const timestamp = (v) =>
        typeof v === "string" &&
        v.length <= 40 &&
        /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|\+00:00)$/.test(v) &&
        Number.isFinite(Date.parse(v));
    const observation = input.source_observation;
    if (
        input.format !== "sales-datamart.etl.receipt/1" ||
        input.etl_version !== "1.0.1" ||
        input.status !== (ready ? "VALIDATED" : "COMMITTED") ||
        canonical(input.scope) !==
            canonical(JSON.parse(FIXED_ETL_DEFINITION_JSON).scope) ||
        canonical(input.source) !==
            canonical({
                database: "AdventureWorks2019",
                mode: "read_only",
                tables: 7,
            }) ||
        canonical(input.target) !==
            canonical({
                database: "SalesDatamart",
                schemas: ["dm", "reporting"],
            }) ||
        input.credentials_in_receipt !== false ||
        input.rows_in_receipt !== false ||
        !Number.isSafeInteger(input.elapsed_ms) ||
        input.elapsed_ms < 0 ||
        input.elapsed_ms > 300000 ||
        countKeys.some(
            (key) =>
                !Number.isSafeInteger(input.counts[key]) ||
                input.counts[key] < 0,
        ) ||
        input.counts.source_fact_rows <= 0 ||
        input.counts.orders <= 0 ||
        input.counts.target_fact_rows !== input.counts.source_fact_rows ||
        input.counts.reporting_view_rows !== input.counts.source_fact_rows ||
        ["line_net_amount", "source_line_total", "aov"].some(
            (key) =>
                typeof input.reconciliation[key] !== "string" ||
                !/^\d{1,30}(?:\.\d{1,6})?$/.test(input.reconciliation[key]),
        ) ||
        !timestamp(observation.started_at) ||
        !timestamp(observation.ended_at) ||
        Date.parse(observation.ended_at) < Date.parse(observation.started_at) ||
        observation.consistent_snapshot !== false ||
        observation.isolation !==
            "driver/database default; not verified as snapshot" ||
        (!ready &&
            (!timestamp(input.committed_at) ||
                !timestamp(input.readback_at) ||
                Date.parse(input.committed_at) <
                    Date.parse(observation.ended_at) ||
                Date.parse(input.readback_at) < Date.parse(input.committed_at)))
    )
        fail("invalid_fixed_etl_receipt");
    return structuredClone(input);
}

/** Only checks stored typed consent. Does not authorize spawning or SQL commit.
 * The owning Host must recompile, authorize, CAS-admit once, and supervise the
 * fixed process. Publication and ordinary question answers never authorize ETL.
 */
export function assertFixedEtlConsent(decision, expectedReview, actorUrn, now) {
    const expected = validateFixedEtlReview(expectedReview, now);
    const stored = validateFixedEtlReview(decision.executionReview, now);
    const response = decision.response;
    const verdict = response?.executionVerdict;
    if (
        decision.publicationReview ||
        decision.publicationAttempt ||
        response?.publicationVerdict ||
        stored.planDigest !== expected.planDigest ||
        response?.actor !== actorUrn ||
        response?.action !== "RESPOND" ||
        verdict?.verdict !== "APPROVE" ||
        verdict?.purpose !== "FIXED_ETL" ||
        verdict?.planDigest !== expected.planDigest ||
        !Number.isSafeInteger(decision.requestedAt) ||
        decision.requestedAt < 0 ||
        !Number.isSafeInteger(response?.respondedAt) ||
        response.respondedAt < decision.requestedAt ||
        response.respondedAt > now ||
        response.respondedAt >= expected.expiresAt
    )
        fail("trusted_fixed_etl_consent_required");
    return {
        purpose: "FIXED_ETL",
        planDigest: expected.planDigest,
        actor: actorUrn,
        respondedAt: response.respondedAt,
        expiresAt: expected.expiresAt,
    };
}

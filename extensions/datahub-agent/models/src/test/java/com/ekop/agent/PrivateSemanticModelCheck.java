package com.ekop.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.linkedin.data.DataMap;
import com.linkedin.data.codec.JacksonDataCodec;
import com.linkedin.data.schema.RecordDataSchema;
import com.linkedin.data.schema.validation.CoercionMode;
import com.linkedin.data.schema.validation.RequiredMode;
import com.linkedin.data.schema.validation.UnrecognizedFieldMode;
import com.linkedin.data.schema.validation.ValidateDataAgainstSchema;
import com.linkedin.data.schema.validation.ValidationOptions;
import com.linkedin.data.template.RecordTemplate;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Pinned Pegasus codec checks. Not native ACL, publication or Agent evidence. */
public final class PrivateSemanticModelCheck {
  private static final JacksonDataCodec CODEC = new JacksonDataCodec();
  private static final ValidationOptions OPTIONS = new ValidationOptions(
      RequiredMode.CAN_BE_ABSENT_IF_HAS_DEFAULT, CoercionMode.NORMAL, UnrecognizedFieldMode.DISALLOW);
  private static final Set<String> ASSET_TYPES = Set.of(
      "dataset", "container", "dataFlow", "dataJob", "chart", "dashboard");

  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void valid(RecordTemplate value) {
    var result = ValidateDataAgainstSchema.validate(value, OPTIONS);
    require(result.isValid(), result.getMessages().toString());
  }

  private static void invalid(RecordTemplate value, String message) {
    require(!ValidateDataAgainstSchema.validate(value, OPTIONS).isValid(), message);
  }

  private static Set<?> urnTypes(RecordDataSchema schema, String field) {
    var annotation = (Map<?, ?>) schema.getField(field).getProperties().get("UrnValidation");
    return Set.copyOf((List<?>) annotation.get("entityTypes"));
  }

  public static void main(String[] args) throws Exception {
    var key = new EkopSemanticReviewKey(CODEC.stringToMap("{\"id\":\"opaque-fixture-task\"}"));
    valid(key);
    require(key.schema().getFields().size() == 1, "Key gained private context");
    invalid(new EkopSemanticReviewKey(new DataMap()), "Missing key accepted");
    var task = new EkopSemanticTask(CODEC.stringToMap("""
        {"actor":"urn:li:corpuser:fixture-owner","tenant":"fixture-tenant",
         "agent":"urn:li:aiAgent:fixture","source":"urn:li:dataHubIngestionSource:fixture",
         "assets":["urn:li:dataset:(urn:li:dataPlatform:mssql,fixture.table,DEV)",
                   "urn:li:container:fixture","urn:li:dataFlow:(fixture,flow,DEV)",
                   "urn:li:dataJob:(urn:li:dataFlow:(fixture,flow,DEV),job)",
                   "urn:li:chart:(fixture,chart)","urn:li:dashboard:(fixture,dashboard)"],
         "instructions":"Selected Catalog assets; not whole-source inventory or SQL permission."}
        """));
    valid(task);
    var taskReadback = new EkopSemanticTask(CODEC.stringToMap(CODEC.mapToString(task.data())));
    require(taskReadback.getAssets().size() == 6, "Catalog selection lost");
    require(taskReadback.getTenant().equals("fixture-tenant"), "Tenant lost");
    require(taskReadback.isAllowDecisions(), "Decision default lost");
    require(taskReadback.schema().getField("datasets") == null, "Non-datasets masquerade as datasets");
    require(urnTypes(task.schema(), "assets").equals(ASSET_TYPES), "Catalog type restriction changed");
    require(urnTypes(new EkopAgentTask().schema(), "datasets").equals(Set.of("dataset")),
        "Legacy Dataset scope was broadened");
    for (String field : List.of("actor", "tenant", "source", "assets")) {
      var missing = CODEC.stringToMap(CODEC.mapToString(task.data()));
      missing.remove(field);
      invalid(new EkopSemanticTask(missing), "Missing private Task binding accepted: " + field);
    }
    var run = new EkopSemanticRun(CODEC.stringToMap("""
        {"actor":"urn:li:corpuser:fixture-owner","tenant":"fixture-tenant",
         "source":"urn:li:dataHubIngestionSource:fixture",
         "task":"urn:li:ekopSemanticReview:opaque-fixture-task","taskVersion":"1",
         "sessionId":"fixture-session","decisions":[
          {"id":"decision-fixture","question":"Review exact revision","requestedAt":1}]}
        """));
    valid(run);
    require(urnTypes(run.schema(), "task").equals(Set.of("ekopSemanticReview")),
        "Private Run points to public Task type");
    require(urnTypes(new EkopAgentRun().schema(), "task").equals(Set.of("dataJob")),
        "Legacy Run binding was changed");
    require(!run.hasClosedAt() && !run.getDecisions().get(0).hasResponse(), "Invented closure/consent");
    var review = new EkopAgentPublicationReview(CODEC.stringToMap("""
        {"purpose":"SEMANTIC","source":"urn:li:dataHubIngestionSource:fixture",
         "sourceId":"fixture","snapshotSha256":"fixture-snapshot","candidateDigest":"fixture-candidate",
         "analysisVersion":"fixture-not-an-authorized-compiler","candidateIds":["fixture"],
         "datasets":[],"assets":["urn:li:chart:(fixture,chart)"],"expiresAt":1000,
         "semanticContextJson":"{\\"scope\\":\\"explicit-selection\\"}","planDigest":"fixture-digest",
         "changes":[{"urn":"urn:li:chart:(fixture,chart)","aspect":"globalTags",
                     "expectedVersion":"1","beforeValueJson":"{\\"tags\\":[]}",
                     "valueJson":"{\\"tags\\":[{\\"tag\\":\\"urn:li:tag:fixture\\"}]}"}]}
        """));
    valid(review);
    require(urnTypes(review.schema(), "assets").equals(ASSET_TYPES), "Review types changed");
    run.getDecisions().get(0).setPublicationReview(review);
    run.getDecisions().get(0).setResponse(new EkopAgentDecisionResponse(CODEC.stringToMap("""
        {"action":"RESPOND","actor":"urn:li:corpuser:fixture-owner","respondedAt":2,
         "publicationVerdict":{"purpose":"SEMANTIC","planDigest":"fixture-digest","verdict":"APPROVE"}}
        """)));
    run.getDecisions().get(0).setPublicationAttempt(new EkopAgentPublicationAttempt(CODEC.stringToMap("""
        {"attemptId":"fixture-attempt","claimedAt":3,"outcomeJson":"{\\"status\\":\\"UNKNOWN_OR_CONTEXT_CHANGED\\"}"}
        """)));
    run.setClosedAt(4L);
    valid(run);
    var readback = new EkopSemanticRun(CODEC.stringToMap(CODEC.mapToString(run.data())));
    // DataMap key ordering and boxed numeric classes are not wire semantics.
    // Compare the complete JSON trees; do not drop any fields or review content.
    var mapper = new ObjectMapper();
    var originalWire = CODEC.mapToString(run.data());
    var readbackWire = CODEC.mapToString(readback.data());
    var sameTree = mapper.readTree(originalWire).equals(mapper.readTree(readbackWire));
    System.out.println("Codec fixture: closedAt before=" + run.data().get("closedAt").getClass().getSimpleName()
        + ", after=" + readback.data().get("closedAt").getClass().getSimpleName()
        + ", sameSerializationOrder=" + originalWire.equals(readbackWire) + ", sameJsonTree=" + sameTree);
    require(sameTree, "Private review/response/attempt/closure JSON content changed");
    valid(readback);
    require(readback.getClosedAt().equals(4L), "Closure time changed");
    require(!readback.getDecisions().get(0).hasExecutionReview(), "Semantic review became ETL authorization");
    for (String field : List.of("tenant", "task", "taskVersion", "sessionId")) {
      var missing = CODEC.stringToMap(CODEC.mapToString(run.data()));
      missing.remove(field);
      invalid(new EkopSemanticRun(missing), "Missing Run binding accepted: " + field);
    }
    var wrong = CODEC.stringToMap(CODEC.mapToString(run.data()));
    wrong.put("publicationAuthorized", true);
    invalid(new EkopSemanticRun(wrong), "Invented authorization accepted");
    wrong = CODEC.stringToMap(CODEC.mapToString(task.data()));
    wrong.put("assets", "not-an-array");
    invalid(new EkopSemanticTask(wrong), "Wrong scope type accepted");
    var legacy = CODEC.stringToMap(CODEC.mapToString(review.data()));
    legacy.remove("assets");
    var legacyRead = new EkopAgentPublicationReview(legacy);
    valid(legacyRead);
    require(!legacyRead.hasAssets(), "Legacy review acquired invented Catalog scope");
    System.out.println("PASS: private key/Task/Run, six asset kinds, exact consent/attempt/closure roundtrip, required bindings, strict legacy annotations and missing/wrong/extra field negatives. Native ACL and Host admission are NOT verified by schemas.");
  }
}

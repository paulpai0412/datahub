package com.ekop.agent;

import com.linkedin.data.DataMap;
import com.linkedin.data.codec.JacksonDataCodec;
import com.linkedin.data.schema.validation.CoercionMode;
import com.linkedin.data.schema.validation.RequiredMode;
import com.linkedin.data.schema.validation.UnrecognizedFieldMode;
import com.linkedin.data.schema.validation.ValidateDataAgainstSchema;
import com.linkedin.data.schema.validation.ValidationOptions;
import com.linkedin.data.template.RecordTemplate;

/** Offline checks of actual generated models, not GMS ACL or Agent E2E evidence. */
public final class ModelRoundTripCheck {
  private static final JacksonDataCodec CODEC = new JacksonDataCodec();
  private static final ValidationOptions OPTIONS = new ValidationOptions(
      RequiredMode.CAN_BE_ABSENT_IF_HAS_DEFAULT,
      CoercionMode.NORMAL,
      UnrecognizedFieldMode.DISALLOW);

  private static void require(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  private static void valid(RecordTemplate record) {
    var result = ValidateDataAgainstSchema.validate(record, OPTIONS);
    require(result.isValid(), result.getMessages().toString());
  }

  public static void main(String[] args) throws Exception {
    var task = new EkopAgentTask(CODEC.stringToMap("""
        {"actor":"urn:li:corpuser:task-model-check",
         "agent":"urn:li:aiAgent:task-model-check",
         "source":"urn:li:dataHubIngestionSource:task-model-check",
         "datasets":["urn:li:dataset:(urn:li:dataPlatform:mssql,task-model-check.person,DEV)"],
         "instructions":"Inspect metadata and ask for user input before continuing."}
        """));
    valid(task);
    var taskReadback = new EkopAgentTask(CODEC.stringToMap(CODEC.mapToString(task.data())));
    require(taskReadback.getInstructions().equals(task.getInstructions()), "Task instructions lost");
    require(taskReadback.getDatasets().size() == 1, "Task scope lost");
    require(taskReadback.isAllowDecisions(), "Decision default not retained");

    DataMap invalidTask = CODEC.stringToMap(CODEC.mapToString(task.data()));
    invalidTask.remove("instructions");
    require(!ValidateDataAgainstSchema.validate(new EkopAgentTask(invalidTask), OPTIONS).isValid(),
        "Missing instructions accepted");

    var run = new EkopAgentRun(CODEC.stringToMap("""
        {"actor":"urn:li:corpuser:task-model-check",
         "source":"urn:li:dataHubIngestionSource:task-model-check",
         "task":"urn:li:dataJob:(urn:li:dataFlow:(pi,task-model-check,DEV),inspect)",
         "taskVersion":"3","sessionId":"native-session-check",
         "decisions":[{"id":"question-1","question":"Continue reading lineage?",
                       "choices":["Continue","End"],"requestedAt":1000}]}
        """));
    valid(run);
    require(!run.getDecisions().get(0).hasResponse(), "Pending decision became answered");
    require(!run.hasClosedAt(), "Legacy run was implicitly closed");
    require(!run.getDecisions().get(0).hasPublicationReview(), "Legacy question became a publication review");
    require(!run.getDecisions().get(0).hasPublicationAttempt(), "Legacy question acquired an attempt");
    var answer = new EkopAgentDecisionResponse(CODEC.stringToMap("""
        {"action":"RESPOND","text":"Continue",
         "actor":"urn:li:corpuser:task-model-check","respondedAt":2000}
        """));
    run.getDecisions().get(0).setResponse(answer);
    valid(run);
    var runReadback = new EkopAgentRun(CODEC.stringToMap(CODEC.mapToString(run.data())));
    require(runReadback.getTaskVersion().equals("3"), "Task revision lost");
    require(runReadback.getSessionId().equals("native-session-check"), "Session reference lost");
    require(runReadback.getDecisions().get(0).getResponse().getText().equals("Continue"),
        "Decision response lost");

    var dismiss = new EkopAgentDecisionResponse(CODEC.stringToMap("""
        {"action":"DISMISS","actor":"urn:li:corpuser:task-model-check","respondedAt":2000}
        """));
    valid(dismiss);
    run.setClosedAt(3000L);
    valid(run);
    var closedReadback = new EkopAgentRun(CODEC.stringToMap(CODEC.mapToString(run.data())));
    require(closedReadback.getClosedAt().equals(3000L), "Host closure lost");
    require(closedReadback.getDecisions().get(0).getResponse().getText().equals("Continue"),
        "Closing admission changed a historical response");
    DataMap invalidClosure = CODEC.stringToMap(CODEC.mapToString(run.data()));
    invalidClosure.put("closedAt", "not-a-time");
    require(!ValidateDataAgainstSchema.validate(new EkopAgentRun(invalidClosure), OPTIONS).isValid(),
        "Invalid closure type accepted");
    DataMap invalidAnswer = CODEC.stringToMap(CODEC.mapToString(answer.data()));
    invalidAnswer.put("action", "APPROVE_SQL");
    require(!ValidateDataAgainstSchema.validate(new EkopAgentDecisionResponse(invalidAnswer), OPTIONS).isValid(),
        "Unrecognized decision action accepted");
    require(!answer.hasPublicationVerdict(), "Ordinary response became consent");
    var proposal = new EkopAgentPublicationReview(CODEC.stringToMap("""
        {"purpose":"LINEAGE","source":"urn:li:dataHubIngestionSource:task-model-check",
         "sourceId":"fixture-code","snapshotSha256":"snapshot-fixture","candidateDigest":"candidate-fixture",
         "analysisVersion":"1.0.2","candidateIds":["candidate-1"],
         "datasets":["urn:li:dataset:(urn:li:dataPlatform:mssql,task-model-check.person,DEV)"],
         "expiresAt":10000,"planDigest":"plan-fixture",
         "changes":[{"urn":"urn:li:dataset:(urn:li:dataPlatform:mssql,task-model-check.person,DEV)",
                     "aspect":"upstreamLineage","expectedVersion":"1","valueJson":"{}"}]}
        """));
    valid(proposal);
    var verdict = new EkopAgentPublicationVerdict(CODEC.stringToMap("""
        {"purpose":"LINEAGE","planDigest":"plan-fixture","verdict":"APPROVE"}
        """));
    valid(verdict);
    run.getDecisions().get(0).setPublicationReview(proposal);
    run.getDecisions().get(0).getResponse().setPublicationVerdict(verdict);
    valid(run);
    var reviewed = new EkopAgentRun(CODEC.stringToMap(CODEC.mapToString(run.data())));
    require(reviewed.getDecisions().get(0).getPublicationReview().getChanges().size() == 1, "Exact changes lost");
    require(reviewed.getDecisions().get(0).getResponse().getPublicationVerdict().getVerdict()
        == EkopAgentPublicationVerdictValue.APPROVE, "Typed verdict lost");
    require(!reviewed.getDecisions().get(0).hasPublicationAttempt(), "Consent implicitly became admission");
    var attempt = new EkopAgentPublicationAttempt(CODEC.stringToMap("""
        {"attemptId":"00000000-0000-4000-8000-000000000001","claimedAt":2500}
        """));
    valid(attempt);
    reviewed.getDecisions().get(0).setPublicationAttempt(attempt);
    valid(reviewed);
    var admitted = new EkopAgentRun(CODEC.stringToMap(CODEC.mapToString(reviewed.data())));
    require(admitted.getDecisions().get(0).getPublicationAttempt().getAttemptId().equals(attempt.getAttemptId()),
        "Admission identity lost");
    require(admitted.getDecisions().get(0).getPublicationAttempt().getClaimedAt().equals(2500L), "Admission time lost");
    require(admitted.hasClosedAt() && admitted.getDecisions().get(0).hasResponse(), "Admission changed closure or response");
    DataMap invalidAttempt = CODEC.stringToMap(CODEC.mapToString(attempt.data()));
    invalidAttempt.remove("attemptId");
    require(!ValidateDataAgainstSchema.validate(new EkopAgentPublicationAttempt(invalidAttempt), OPTIONS).isValid(),
        "Missing attempt identity accepted");
    invalidAttempt = CODEC.stringToMap(CODEC.mapToString(attempt.data()));
    invalidAttempt.put("targetPublished", true);
    require(!ValidateDataAgainstSchema.validate(new EkopAgentPublicationAttempt(invalidAttempt), OPTIONS).isValid(),
        "Admission accepted an invented publication outcome");
    DataMap wrongPurpose = CODEC.stringToMap(CODEC.mapToString(proposal.data()));
    wrongPurpose.put("purpose", "SQL_EXECUTION");
    require(!ValidateDataAgainstSchema.validate(new EkopAgentPublicationReview(wrongPurpose), OPTIONS).isValid(),
        "SQL execution admitted as metadata purpose");
    DataMap missingChanges = CODEC.stringToMap(CODEC.mapToString(proposal.data()));
    missingChanges.remove("changes");
    require(!ValidateDataAgainstSchema.validate(new EkopAgentPublicationReview(missingChanges), OPTIONS).isValid(),
        "Missing explicit changes accepted");
    require(!runReadback.getDecisions().get(0).hasExecutionReview(), "Legacy question became ETL consent");
    require(!answer.hasExecutionVerdict(), "Ordinary answer became ETL approval");
    var executionReview = new EkopAgentExecutionReview(CODEC.stringToMap("""
        {"purpose":"FIXED_ETL","source":"urn:li:dataHubIngestionSource:task-model-check",
         "datasets":["urn:li:dataset:(urn:li:dataPlatform:mssql,task-model-check.person,DEV)"],
         "definitionJson":"{}","codeSha256":"code-fixture","expiresAt":600000,"planDigest":"etl-fixture"}
        """));
    valid(executionReview);
    runReadback.getDecisions().get(0).setExecutionReview(executionReview);
    runReadback.getDecisions().get(0).getResponse().setExecutionVerdict(
        new EkopAgentExecutionVerdict(CODEC.stringToMap("""
        {"purpose":"FIXED_ETL","planDigest":"etl-fixture","verdict":"APPROVE"}
        """)));
    var executionAttempt = new EkopAgentExecutionAttempt(CODEC.stringToMap("""
        {"attemptId":"etl-attempt-fixture","planDigest":"etl-fixture","admittedAt":3000,
         "deadlineAt":303000,"state":"UNKNOWN","finishedAt":4000,"resultJson":"{}"}
        """));
    runReadback.getDecisions().get(0).setExecutionAttempt(executionAttempt);
    valid(runReadback);
    var executionReadback = new EkopAgentRun(CODEC.stringToMap(CODEC.mapToString(runReadback.data())));
    require(executionReadback.getDecisions().get(0).getExecutionAttempt().getState()
        == EkopAgentExecutionState.UNKNOWN, "Uncertain ETL state lost");
    require(!executionReadback.getDecisions().get(0).hasPublicationReview(), "ETL became metadata consent");
    require(!proposal.hasSemanticContextJson(), "Legacy review acquired Steward evidence");
    require(!proposal.getChanges().get(0).hasBeforeValueJson(), "Legacy change acquired invented before-values");
    require(!attempt.hasOutcomeJson(), "Legacy attempt became a successful publication");
    var steward = new EkopAgentPublicationReview(CODEC.stringToMap(CODEC.mapToString(proposal.data())));
    steward.data().put("purpose", "SEMANTIC");
    steward.setSemanticContextJson("{\"fixture\":\"intent-evidence-version-guards\"}");
    steward.getChanges().get(0).setBeforeValueJson("null");
    admitted.getDecisions().get(0).setPublicationReview(steward);
    admitted.getDecisions().get(0).getPublicationAttempt().setOutcomeJson("{\"status\":\"UNKNOWN_OR_CONTEXT_CHANGED\"}");
    valid(admitted);
    var stewardReadback = new EkopAgentRun(CODEC.stringToMap(CODEC.mapToString(admitted.data())));
    require(stewardReadback.getDecisions().get(0).getPublicationReview().getSemanticContextJson().equals(steward.getSemanticContextJson()), "Steward context lost");
    require(stewardReadback.getDecisions().get(0).getPublicationReview().getChanges().get(0).getBeforeValueJson().equals("null"), "Steward before-value lost");
    require(stewardReadback.getDecisions().get(0).getPublicationAttempt().getOutcomeJson().contains("UNKNOWN_OR_CONTEXT_CHANGED"), "Uncertain publication outcome lost");
    if (args.length == 1) {
      var shapes = CODEC.stringToList(java.nio.file.Files.readString(java.nio.file.Path.of(args[0])));
      require(!shapes.isEmpty(), "No native compiler shapes supplied");
      for (var entry : shapes) {
        var shape = (DataMap) entry;
        var type = Class.forName(shape.getString("recordClass"));
        var nativeRecord = (RecordTemplate) type.getConstructor(DataMap.class).newInstance(shape.getDataMap("value"));
        valid(nativeRecord);
      }
      System.out.println("PASS: " + shapes.size() + " actual compiler outputs validated by pinned Core Pegasus schemas");
    }
    System.out.println("PASS: legacy Task/Run/Decision, publication, ETL and optional Steward context/before-values/outcome roundtrips; missing-field/purpose/action/outcome negatives; Host digest/ACL/CAS semantics are separate tests");
  }
}

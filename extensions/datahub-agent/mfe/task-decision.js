function decisionDialog(
  container,
  decision,
  run,
  signal,
  importWorkspace = false,
) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText =
      "max-width:min(720px,90vw);max-height:85dvh;overflow:auto;border:1px solid #ececec;border-radius:12px;padding:24px;background:white;color:#37352f";
    const title = document.createElement("h2");
    title.id = "datahub-task-decision-title";
    if (decision.executionReview && decision.publicationReview)
      throw new Error("mixed_decision_purpose");
    const execution = Boolean(decision.executionReview);
    const review = decision.executionReview ?? decision.publicationReview;
    title.textContent = review
      ? execution
        ? "Fixed ETL execution review"
        : `${review.purpose === "LINEAGE" ? "Lineage" : "Semantic"} publication review`
      : "Task decision";
    dialog.setAttribute("aria-labelledby", title.id);
    const question = document.createElement("p");
    question.textContent = decision.question;
    question.style.overflowWrap = "anywhere";
    const scope = document.createElement("p");
    scope.textContent = `Task: ${run.value.task}\nSource: ${run.value.source}`;
    scope.style.cssText = "overflow-wrap:anywhere;white-space:pre-wrap";
    const note = document.createElement("p");
    note.textContent = execution
      ? "This approval authorizes only the fixed ETL below: source reads and target upserts, not metadata publication or arbitrary SQL. Consent alone does not start SQL. The Host rechecks authority and code, admits once, and must obtain fresh commit permission. Stop is not proof of rollback; unknown outcomes cannot be retried automatically."
      : importWorkspace
        ? "Approve and import authorizes exactly the metadata changes below. The Host will recheck this source snapshot, permissions, ownership and versions, publish once, then read back DataHub. No ETL, source SQL, ingestion or business-relationship approval. Unknown writes are never retried automatically."
        : review
          ? "Review only this purpose, source snapshot and exact Aspect changes. This dialog records consent; it does not publish metadata or authorize SQL execution. The Host must revalidate before any write."
          : "Your response is Catalog metadata, not authorization for SQL, Join approval or writes. End task or Escape closes this Task and requests Pi stop.";
    const publication = document.createElement("section");
    if (execution) {
      if (
        review.purpose !== "FIXED_ETL" ||
        typeof review.definitionJson !== "string"
      )
        throw new Error("invalid_execution_review");
      const binding = document.createElement("p"),
        definition = document.createElement("pre");
      binding.style.cssText = definition.style.cssText =
        "white-space:pre-wrap;overflow-wrap:anywhere";
      binding.textContent = `Code SHA-256: ${review.codeSha256}\nPlan: ${review.planDigest}\nExpires: ${new Date(review.expiresAt).toISOString()}\nDatasets: ${review.datasets.join("\n")}`;
      definition.textContent = JSON.stringify(
        JSON.parse(review.definitionJson),
        null,
        2,
      );
      publication.append(binding, definition);
    } else if (review) {
      if (
        !["LINEAGE", "SEMANTIC"].includes(review.purpose) ||
        !Array.isArray(review.changes)
      )
        throw new Error("invalid_publication_review");
      const binding = document.createElement("p");
      binding.style.cssText = "overflow-wrap:anywhere;white-space:pre-wrap";
      binding.textContent = `Source ID: ${review.sourceId}\nSnapshot: ${review.snapshotSha256}\nCandidates: ${review.candidateDigest}\nPlan: ${review.planDigest}\nExpires: ${new Date(review.expiresAt).toISOString()}`;
      publication.append(binding);
      for (const change of review.changes) {
        const detail = document.createElement("details"),
          summary = document.createElement("summary"),
          value = document.createElement("pre");
        summary.textContent = `${change.urn} / ${change.aspect} (expected version ${change.expectedVersion})`;
        summary.style.overflowWrap = "anywhere";
        value.textContent = change.valueJson;
        value.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
        detail.append(summary, value);
        publication.append(detail);
      }
    }
    const answer = document.createElement("textarea");
    answer.setAttribute("aria-label", "Decision response");
    answer.maxLength = 2048;
    answer.rows = 3;
    answer.style.cssText = "width:100%;box-sizing:border-box;font:inherit";
    answer.hidden = Boolean(review);
    const choices = document.createElement("div");
    for (const choice of review ? [] : decision.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice;
      button.style.cssText =
        "min-height:44px;margin:4px;padding:8px 12px;font:inherit";
      button.onclick = () => {
        answer.value = choice;
        answer.focus();
      };
      choices.append(button);
    }
    const end = document.createElement("button"),
      respond = document.createElement("button");
    end.type = respond.type = "button";
    end.textContent = "End task";
    respond.textContent = review
      ? execution
        ? "Approve fixed ETL"
        : importWorkspace
          ? "Approve and import lineage metadata"
          : `Approve ${review.purpose === "LINEAGE" ? "lineage" : "semantic"} metadata`
      : "Respond and continue";
    const reject = document.createElement("button");
    reject.type = "button";
    reject.textContent = execution
      ? "Reject ETL execution"
      : "Reject publication";
    reject.hidden = !review;
    end.style.cssText =
      respond.style.cssText =
      reject.style.cssText =
        "min-height:44px;margin:4px;padding:8px 16px;font:inherit";
    function finish(value) {
      signal.removeEventListener("abort", disconnected);
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    }
    const disconnected = () => finish(undefined);
    end.onclick = () => finish({ actionValue: "DISMISS" });
    reject.onclick = () =>
      finish({ verdict: "REJECT", planDigest: review.planDigest });
    respond.onclick = () => {
      if (review) {
        finish({ verdict: "APPROVE", planDigest: review.planDigest });
        return;
      }
      if (!answer.value.trim()) {
        answer.focus();
        return;
      }
      finish({ actionValue: "RESPOND", text: answer.value });
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish({ actionValue: "DISMISS" });
    });
    signal.addEventListener("abort", disconnected, { once: true });
    if (signal.aborted) {
      disconnected();
      return;
    }
    dialog.append(
      title,
      scope,
      question,
      note,
      publication,
      choices,
      answer,
      end,
      reject,
      respond,
    );
    container.append(dialog);
    if (typeof dialog.showModal !== "function") {
      disconnected();
      return;
    }
    dialog.showModal();
    (review ? reject : answer).focus();
  });
}

/** Human answers are collected in the trusted parent, never in the Pi runtime. */
export function installTaskDecisionBridge({
  container,
  frame,
  origin,
  send,
  onUpdate,
}) {
  let active;
  const listener = async (event) => {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== origin ||
      ![
        "datahub-task-decision",
        "datahub-workspace-import",
        "datahub-import-readback",
      ].includes(event.data?.type)
    )
      return;
    const port = event.ports?.[0];
    if (!port) return;
    const reply = (value) => {
      port.postMessage(JSON.stringify(value));
      port.close();
    };
    if (active) {
      reply({ state: "unconfirmed", error: "task_decision_busy" });
      return;
    }
    if (
      typeof event.data.body !== "string" ||
      event.data.body.length > 8192 ||
      typeof event.data.uiRequestId !== "string"
    ) {
      reply({ state: "unconfirmed", error: "invalid_task_request" });
      return;
    }
    const abort = new AbortController();
    active = abort;
    let committing = false;
    // Native abort legitimately unmounts its dialog while Host stop/readback is
    // still running. Do not cancel that human-authorized stop through this port.
    port.onmessage = (event) => {
      if (event.data?.type === "cancel" && !committing) abort.abort();
    };
    try {
      const request = JSON.parse(event.data.body);
      const importWorkspace = event.data.type === "datahub-workspace-import";
      if (event.data.type === "datahub-import-readback") {
        if (
          !request ||
          Object.keys(request).some(
            (key) => !["action", "requestId", "runUrn"].includes(key),
          ) ||
          request.action !== "read_workspace_import"
        )
          throw new Error("invalid_task_request");
        const result = await send(request, abort.signal);
        reply({ ...result, format: "datahub-etl.import/1" });
        return;
      }
      if (
        !request ||
        Object.keys(request).some(
          (key) =>
            !(
              importWorkspace
                ? ["action", "requestId", "sessionId", "analysis"]
                : ["runUrn", "requestId", "question", "choices"]
            ).includes(key),
        )
      )
        throw new Error("invalid_task_request");
      const prepared = await send(
        {
          ...request,
          uiRequestId: event.data.uiRequestId,
          action: importWorkspace
            ? "prepare_workspace_import"
            : "prepare_decision",
        },
        abort.signal,
      );
      onUpdate?.(prepared);
      if (prepared.decision.response) {
        reply({
          response: prepared.decision.response,
          runVersion: prepared.run.version,
          ...(importWorkspace
            ? {
                format: "datahub-etl.import/1",
                requestId: request.requestId,
                runUrn: prepared.run.urn,
                publication: prepared.publication ?? null,
                publicationAuthorized: false,
                retryAllowed: false,
              }
            : {}),
        });
        return;
      }
      const answer = await decisionDialog(
        container,
        prepared.decision,
        prepared.run,
        abort.signal,
        importWorkspace,
      );
      if (!answer || abort.signal.aborted) {
        reply({
          state: "unconfirmed",
          note: "No human response committed. Reopen the native session to reconcile.",
        });
        return;
      }
      committing = true;
      const result = await send(
        {
          action: importWorkspace
            ? "respond_workspace_import"
            : answer.verdict
              ? prepared.decision.executionReview
                ? "respond_execution_review"
                : "respond_publication_review"
              : "respond_decision",
          runUrn: prepared.run.urn,
          version: prepared.run.version,
          requestId: request.requestId,
          uiRequestId: event.data.uiRequestId,
          ...answer,
        },
        abort.signal,
      );
      onUpdate?.(result);
      reply({
        response: result.decision?.response,
        runVersion: result.run.version,
        ...(importWorkspace
          ? {
              format: "datahub-etl.import/1",
              requestId: request.requestId,
              runUrn: result.run.urn,
              publication: result.publication ?? null,
              publicationAuthorized: false,
              retryAllowed: false,
            }
          : {}),
        ...(answer.actionValue === "DISMISS"
          ? { state: "closed", stopObserved: result.stopObserved }
          : {}),
      });
    } catch (error) {
      // A bounded Host rejection (for example workspace_no_changes) is
      // deterministic and must settle the native input as a tool error. Keep
      // transport/write-unknown outcomes pending so they cannot be replayed.
      const code =
        error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
          ? error.message
          : undefined;
      reply({
        state: "unconfirmed",
        ...(code ? { error: code } : {}),
        note: code
          ? "The trusted Host rejected this request; no human answer was recorded."
          : "Read the Task and native session before retrying. No prompt was resubmitted.",
      });
    } finally {
      active = undefined;
    }
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
    active?.abort();
  };
}

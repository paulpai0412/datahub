"use client";
import { useEffect, useState } from "react";
import type { BlockingExtensionUiRequest } from "@/lib/types";

type Request = Extract<BlockingExtensionUiRequest, { method: "input" }>;
export function isDataHubHostRequest(
  request: BlockingExtensionUiRequest,
): request is Request {
  return (
    request.method === "input" &&
    [
      "DataHub ingestion request",
      "DataHub task decision",
      "DataHub workspace import",
      "DataHub import readback",
      "DataHub discovery request",
    ].includes(request.title)
  );
}

export function DataHubHostBridge({
  request,
  onRespond,
}: {
  request: Request;
  onRespond: (
    request: Request,
    response: { value: string } | { cancelled: true },
  ) => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    setNotice(null);
    const decision = [
      "DataHub task decision",
      "DataHub workspace import",
    ].includes(request.title);
    if (window.parent === window) {
      onRespond(request, {
        value: JSON.stringify({ error: "datahub_host_required" }),
      });
      return;
    }
    const channel = new MessageChannel();
    let closed = false;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (closed || typeof event.data !== "string" || event.data.length > 65536)
        return;
      closed = true;
      channel.port1.close();
      if (decision) {
        let result: unknown;
        try {
          result = JSON.parse(event.data);
        } catch {
          result = null;
        }
        // Deterministic Host rejection is a tool error, not a human answer,
        // but it must still settle the native input request. Unknown outcomes
        // remain pending so a possible write is never silently retried.
        const hostError =
          result &&
          typeof result === "object" &&
          "state" in result &&
          result.state === "unconfirmed" &&
          "error" in result &&
          typeof result.error === "string" &&
          /^[a-z_]{1,80}$/.test(result.error);
        if (
          !hostError &&
          (!result ||
            typeof result !== "object" ||
            !("runVersion" in result) ||
            typeof result.runVersion !== "string" ||
            !("response" in result) ||
            !result.response ||
            typeof result.response !== "object" ||
            !("action" in result.response) ||
            result.response.action !== "RESPOND" ||
            !("text" in result.response) ||
            typeof result.response.text !== "string")
        ) {
          setNotice(
            "No confirmed human answer was received; this question is still waiting. Read the Task and reopen the native session to reconcile.",
          );
          return;
        }
      }
      onRespond(request, { value: event.data });
    };
    // Defer until committed; React StrictMode's discarded effect sends nothing.
    const timer = setTimeout(() => {
      if (closed) return;
      // Intent contains no credentials. Gateway CSP restricts ancestors; the host
      // separately validates frame/origin, its operator policy and fresh DataHub me.
      window.parent.postMessage(
        {
          type:
            request.title === "DataHub workspace import"
              ? "datahub-workspace-import"
              : request.title === "DataHub import readback"
                ? "datahub-import-readback"
                : request.title === "DataHub task decision"
                  ? "datahub-task-decision"
                  : request.title === "DataHub discovery request"
                    ? "datahub-discovery"
                    : "datahub-ingestion",
          body: request.placeholder,
          uiRequestId: request.id,
        },
        "*",
        [channel.port2],
      );
    }, 0);
    return () => {
      if (!closed) channel.port1.postMessage({ type: "cancel" });
      closed = true;
      clearTimeout(timer);
      channel.port1.close();
    };
  }, [request, onRespond]);
  return (
    <div
      style={{
        // Keep the bridge out of the chat flex row. A normal-flow status node
        // becomes a second flex item and visibly pushes the message column right.
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      <p
        role="status"
        style={{
          maxWidth: "min(620px, 100%)",
          margin: 0,
          padding: "14px 16px",
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--bg)",
          color: "var(--text-muted)",
          textAlign: "center",
          boxShadow: "0 10px 28px -14px rgba(15,23,42,0.24)",
        }}
      >
        {notice ??
          "Waiting for the trusted DataHub host. Source confirmations and Task decisions are handled outside this workspace."}
      </p>
    </div>
  );
}

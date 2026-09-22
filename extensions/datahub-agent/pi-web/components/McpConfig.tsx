"use client";

import { useEffect, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { ConfigButton } from "./SettingsUi";

type Snapshot = { config: Record<string, unknown>; revision: string };

export function McpConfig({
  sessionId,
  onReloaded,
}: {
  sessionId: string | null;
  onReloaded: () => void;
}) {
  const [saved, setSaved] = useState<Snapshot | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/mcp-config", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as Snapshot;
        setSaved(data);
        setText(JSON.stringify(data.config, null, 2));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setMessage(
            "Unable to load MCP config. Existing configuration has not been changed.",
          );
      });
    return () => controller.abort();
  }, []);

  async function save() {
    if (!saved) return;
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      setMessage("Invalid JSON. Nothing was saved.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/mcp-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config, revision: saved.revision }),
      });
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? "Config changed in another tab or editor. Copy your edits before reopening this panel; nothing was overwritten."
            : "Unable to save MCP config. Check its JSON structure and your login.",
        );
        return;
      }
      const next = (await response.json()) as Snapshot;
      setSaved(next);
      setText(JSON.stringify(next.config, null, 2));
      setMessage(
        "Saved. Reload the current session or start a new one to apply. Saving does not test server connectivity.",
      );
    } catch {
      setMessage(
        "Save response unavailable. Reopen this panel to check the saved state before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (!sessionId) return;
    setBusy(true);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded();
      setMessage(
        "Session reloaded. Use /mcp tools or /mcp reconnect <server> to inspect the adapter.",
      );
    } catch {
      setMessage(
        "Session reload failed. Saved configuration is preserved; check the session before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">MCP servers</h2>
      <p>
        Uses pi-mcp-adapter. Edit its standard mcpServers JSON; server options
        are preserved, not translated into another format.
      </p>
      <p>
        This is your runtime’s Pi-global mcp.json. Project MCP files can
        override it. Commands run inside your isolated runtime; remote
        destinations still require network approval.
      </p>
      <p>
        Do not put ingestion secrets or DataHub service/write credentials here.
        This is not the trusted Sources or approval control plane.
      </p>
      <label htmlFor="mcp-server-config">MCP server config (JSON)</label>
      <textarea
        id="mcp-server-config"
        aria-describedby="mcp-config-help"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={!saved || busy}
        spellCheck={false}
        autoComplete="off"
        style={{
          width: "100%",
          minHeight: "20rem",
          padding: 12,
          boxSizing: "border-box",
          fontFamily: "var(--font-mono)",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 8,
        }}
      />
      <p id="mcp-config-help">
        Add DataHub MCP or another MCP server using its actual command/args or
        URL. A DataHub UI/GMS URL is not itself an MCP endpoint. Set disabled:
        true to disable an entry.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <ConfigButton onClick={() => void save()} disabled={!saved || busy}>
          Save config
        </ConfigButton>
        <ConfigButton
          onClick={() => void reload()}
          disabled={!sessionId || busy}
        >
          Reload current session
        </ConfigButton>
      </div>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

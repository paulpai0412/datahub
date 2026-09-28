/** Fetch in the authenticated browsing context: a top-level navigation loses
 * the DataHub embed's partitioned cookie. Never pass that cookie to the viewer.
 */
export async function openSessionHistory(
  sessionId: string,
  title = "Full history",
): Promise<void> {
  // Reserve the window during the click, before awaiting the export. Using
  // noopener in window.open would discard the handle needed to fill the view.
  const view = window.open("", "_blank");
  if (!view) {
    window.alert(`${title}: allow pop-ups and try again.`);
    return;
  }
  view.opener = null;
  view.document.title = title;
  view.document.body.textContent = `${title}…`;
  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1`,
      { credentials: "same-origin", cache: "no-store" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "text/html") {
      throw new Error("Expected an HTML session export");
    }
    const html = await response.text();
    if (view.closed) return;
    // Only the trusted, same-origin SDK export document is rendered here, not
    // raw messages/Markdown or caller-provided HTML. Preserve its scripts/tree.
    // A complete document avoids leaking object URLs across repeated exports.
    view.document.open();
    view.document.write(html);
    view.document.close();
  } catch (error) {
    if (!view.closed) {
      view.document.body.textContent = `${title}: ${error instanceof Error ? error.message : "Export failed"}`;
    }
  }
}

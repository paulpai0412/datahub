/** Catalog metadata only; registration never grants runtime permissions. */
export function installRegistryView(container, frame) {
  const previousStyle = frame.style.cssText;
  const previousDisplay = container.style.display;
  const previousDirection = container.style.flexDirection;
  container.style.display = "flex";
  container.style.flexDirection = "column";
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Agent views");
  nav.style.cssText = "min-height:44px;display:flex;flex-wrap:wrap;flex-shrink:0;gap:4px;border-bottom:1px solid #ececec;box-sizing:border-box";
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Agent Registry");
  panel.style.cssText = "display:none;flex:1 1 0;min-height:0;overflow:auto;padding:16px;box-sizing:border-box;background:white;color:#37352f";
  frame.style.height = "auto";
  frame.style.flex = "1 1 0";
  frame.style.minHeight = "0";
  let request;
  let closed = false;
  const chat = document.createElement("button");
  const agents = document.createElement("button");
  for (const [button, label] of [[chat, "Chat"], [agents, "Agents"]]) {
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "min-height:44px;min-width:44px;max-width:100%;padding:8px 12px;overflow-wrap:anywhere;border:0;background:white;font:inherit;cursor:pointer";
    nav.append(button);
  }
  function select(registry) {
    request?.abort();
    frame.style.display = registry ? "none" : "block";
    panel.style.display = registry ? "block" : "none";
    chat.setAttribute("aria-pressed", String(!registry));
    agents.setAttribute("aria-pressed", String(registry));
    chat.style.background = registry ? "white" : "#ece9f8";
    agents.style.background = registry ? "#ece9f8" : "white";
    if (registry) void load();
  }
  function text(tag, value) {
    const element = document.createElement(tag);
    element.textContent = value;
    return element;
  }
  async function load() {
    const current = new AbortController();
    request = current;
    panel.replaceChildren(text("p", "Loading Agent Registry…"));
    try {
      // The public SDK uses v3 scroll; v2's typed mapper cannot serialize aiAgent aspects on this release.
      const response = await fetch("/openapi/v3/entity/scroll?count=20&systemMetadata=true", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entities: ["aiAgent"], aspects: ["aiAgentInfo", "aiAgentDependencies"] }),
        signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error("registry_unavailable");
      const raw = await response.text();
      if (raw.length > 1048576) throw new Error("registry_response_too_large");
      const data = JSON.parse(raw);
      if (!Array.isArray(data.entities) || data.entities.length > 20 || !Number.isSafeInteger(data.totalCount) || data.totalCount < 0)
        throw new Error("invalid_registry_response");
      const cards = [];
      for (const entity of data.entities) {
        const info = entity.aiAgentInfo?.value;
        const tools = entity.aiAgentDependencies?.value?.tools ?? [];
        if (typeof entity.urn !== "string" || !entity.urn.startsWith("urn:li:aiAgent:") || typeof info?.name !== "string" || !Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))
          throw new Error("invalid_registry_entity");
        const card = document.createElement("article");
        card.style.cssText = "border:1px solid #ececec;border-radius:12px;padding:16px;margin-top:12px;overflow-wrap:anywhere";
        card.append(text("h3", info.name.slice(0, 512)), text("code", entity.urn));
        if (typeof info.description === "string") card.append(text("p", info.description.slice(0, 4096)));
        card.append(text("p", `Metadata revision: ${entity.aiAgentInfo.systemMetadata?.version ?? "not returned"}`));
        const dependencies = text("ul", "");
        for (const tool of tools.slice(0, 100)) dependencies.append(text("li", tool));
        card.append(text("h4", `Tool dependencies (${tools.length})`), dependencies);
        if (tools.length > 100) card.append(text("p", "Only the first 100 dependencies are displayed."));
        cards.push(card);
      }
      if (closed || current.signal.aborted) return;
      panel.replaceChildren(text("h2", "Agent Registry"), text("p", "Catalog records only — not execution permissions or Cloud Agents runtime."), text("p", `Showing ${cards.length} of ${data.totalCount} agents.`), ...cards);
      // ponytail: first page is bounded to 20; add cursor navigation when the registry actually exceeds it.
      if (data.totalCount > cards.length) panel.append(text("p", "This is only the first page, not the complete registry."));
      if (!cards.length) panel.append(text("p", "No visible registered agents."));
    } catch {
      if (!closed && !current.signal.aborted) panel.replaceChildren(text("p", "Registry unavailable. Check your DataHub login and permissions, then reopen Agents."));
    }
  }
  chat.onclick = () => select(false);
  agents.onclick = () => select(true);
  container.prepend(nav);
  container.append(panel);
  select(false);
  return () => {
    closed = true;
    request?.abort();
    nav.remove();
    panel.remove();
    frame.style.cssText = previousStyle;
    container.style.display = previousDisplay;
    container.style.flexDirection = previousDirection;
  };
}

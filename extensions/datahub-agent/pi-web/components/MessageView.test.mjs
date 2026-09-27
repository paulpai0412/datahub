import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { registerHooks } from "node:module";

// Static markup assertions do not load stylesheets. Real module CSS is exercised
// by tests/check_agent_catalog_browser.mjs, including the existing panel CSS.
const cssHook = registerHooks({
  load(url, context, next) {
    if (
      url.endsWith("/DataHubCatalog.module.css") ||
      url.endsWith("/DataHubSqlCard.module.css") ||
      url.endsWith("/DataHubDashboardDraft.module.css") ||
      url.endsWith("/DataHubGrafanaPanel.module.css")
    )
      return {
        format: "module",
        source: "export default {};",
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  ThinkingBlock,
  getModelDisplayName,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitFinalAssistantBlocks } = await jiti.import(
  "@/lib/message-display",
);
cssHook.deregister();

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(
    MessageView.compare(props, {
      ...props,
      writtenFiles: [{ path: "/tmp/result.txt" }],
    }),
    false,
  );
});

test("matches response model aliases and otherwise includes the provider", () => {
  const names = {
    "gateway:claude-sonnet-5": "Sonnet 5",
    "custom-api:GLM-5.3": "GLM 5.3",
  };

  assert.equal(
    getModelDisplayName("gateway", "anthropic/claude-sonnet-5", names),
    "Sonnet 5",
  );
  assert.equal(getModelDisplayName("CUSTOM-API", "glm-5.3", names), "GLM 5.3");
  assert.equal(
    getModelDisplayName("gateway", "unknown-model", names),
    "gateway/unknown-model",
  );
});

test("previews the first thinking line and reveals the full text with the saved default", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ThinkingBlock, {
            block: {
              type: "thinking",
              thinking: "**Independent reasoning**\n\nDetailed second line.",
            },
            blockIndex: 2,
            duration: 3,
          }),
        ),
      );
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      assert.equal(
        (html.match(/>[^<]*Independent reasoning[^<]*</g) ?? []).length,
        1,
      );
      assert.equal(html.includes("Detailed second line."), expanded);
      assert.match(html, /aria-label="Thinking: /);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shows deferred thinking previews without loading the full content", () => {
  const html = renderMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Historical first line", deferred: true },
    ],
  });
  assert.match(html, />Historical first line<\/span>/);
  assert.match(html, /aria-expanded="false"/);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal(
        (html.match(/data-search-target="true"/g) ?? []).length,
        content.includes(searchBlock) ? 1 : 0,
      );
      if (content.includes(searchBlock)) {
        assert.match(
          html,
          new RegExp(
            `data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`,
          ),
        );
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage(
    {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      content: [block],
    },
    { isStreaming: true },
  );

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("SQL tool card hides raw input, model result bytes and unknown historical values", () => {
  const block = {
    type: "toolCall",
    toolCallId: "sql-1",
    toolName: "datahub_sql",
    input: { rawSql: "RAW_SQL_MUST_NOT_RENDER" },
    rawInput: '{"rawSql":"RAW_SQL_MUST_NOT_RENDER"}',
  };
  for (const result of [
    undefined,
    {
      isError: true,
      details: { points: [{ salesAmount: "999999" }] },
      content: [{ type: "text", text: "RAW_ERROR_MUST_NOT_RENDER" }],
    },
    {
      isError: false,
      details: { format: "unknown", points: [{ salesAmount: "888888" }] },
      content: [{ type: "text", text: "RAW_RESULT_MUST_NOT_RENDER" }],
    },
  ]) {
    const html = renderMessage(
      { role: "assistant", content: [block] },
      {
        toolResults: new Map(
          result
            ? [
                [
                  block.toolCallId,
                  {
                    ...result,
                    role: "toolResult",
                    toolCallId: block.toolCallId,
                  },
                ],
              ]
            : [],
        ),
      },
    );
    assert.match(html, /DataHub metadata 查詢/);
    for (const sensitive of [
      "RAW_SQL_MUST_NOT_RENDER",
      "RAW_ERROR_MUST_NOT_RENDER",
      "RAW_RESULT_MUST_NOT_RENDER",
      "999999",
      "888888",
    ])
      assert.doesNotMatch(html, new RegExp(sensitive));
  }
});

test("Grafana messages are launchers, never auto-mounted frames or raw historical numbers", () => {
  const block = {
    type: "toolCall",
    toolCallId: "grafana-1",
    toolName: "datahub_grafana",
    input: { url: "RAW_UNTRUSTED" },
  };
  const receipt = {
    format: "datahub-grafana.embed/1",
    requestId: "12345678-1234-1234-1234-123456789abc",
    displayRef: "22222222-2222-4222-8222-222222222222",
    dashboardUid: "sales-monthly-category",
    datasetUrn:
      "urn:li:dataset:(urn:li:dataPlatform:mssql,SalesDatamart.reporting.v_sales_order_line,PROD)",
    orgId: 2,
    title: "Source-only Sales",
    from: "2014-06-01",
    to: "2014-06-30",
    resultExpiresAt: Date.now() + 60_000,
    status: "SOURCE_ONLY_NOT_RECONCILED",
  };
  const render = (details) =>
    renderMessage(
      { role: "assistant", content: [block] },
      {
        toolResults: new Map([
          [
            block.toolCallId,
            {
              role: "toolResult",
              toolCallId: block.toolCallId,
              details,
              content: [{ type: "text", text: "RAW_VALUES_99999" }],
            },
          ],
        ]),
      },
    );
  const html = render(receipt);
  assert.match(html, /開啟儀表板/);
  assert.match(html, /尚未與既有 Grafana 面板對帳/);
  assert.doesNotMatch(html, /iframe|RAW_UNTRUSTED|RAW_VALUES_99999/);
  for (const invalid of [
    { ...receipt, points: [99999] },
    { ...receipt, synthetic: true },
  ])
    assert.doesNotMatch(render(invalid), /開啟儀表板|99999/);
});

test("dashboard draft renders in the message without invented numbers or leaked tool input", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  const block = {
    type: "toolCall",
    toolCallId: "dashboard-1",
    toolName: "datahub_dashboard",
    input: { rawSql: "UNTRUSTED_SQL_INPUT" },
    rawInput: "UNTRUSTED_SQL_INPUT",
  };
  const draft = {
    format: "datahub-dashboard.draft/1",
    requestId: id,
    state: "UNAPPROVED_NOT_EXECUTED",
    datasetUrn: "urn:li:dataset:(urn:li:dataPlatform:mssql,example,PROD)",
    datasetName: "Test asset",
    title: "Month order count",
    metric: "Distinct orders",
    dimension: "Order month",
    visualization: "line",
    queriedAt: "2026-09-25T00:00:00.000Z",
  };
  const withResult = (details, isError = false) =>
    renderMessage(
      { role: "assistant", content: [block] },
      {
        toolResults: new Map([
          [
            block.toolCallId,
            {
              role: "toolResult",
              toolCallId: block.toolCallId,
              content: [{ type: "text", text: "RAW_RESULT_999999" }],
              isError,
              details,
            },
          ],
        ]),
      },
    );
  const html = withResult(draft);
  assert.match(html, /DataHub 對話儀表板草稿/);
  assert.match(html, /Distinct orders/);
  assert.match(html, /未授權 · 未執行/);
  assert.match(html, /尚未建立 Grafana Dashboard/);
  for (const bad of ["UNTRUSTED_SQL_INPUT", "RAW_RESULT_999999"])
    assert.doesNotMatch(html, new RegExp(bad));
  for (const invalid of [undefined, { ...draft, values: [999999] }]) {
    const hidden = withResult(invalid);
    assert.doesNotMatch(hidden, /Distinct orders/);
    assert.doesNotMatch(hidden, /999999/);
  }
  assert.doesNotMatch(withResult(draft, true), /Distinct orders/);
});

test("Catalog pending, errors and unknown historical payloads never expose raw tool JSON", () => {
  const block = {
    type: "toolCall",
    toolCallId: "catalog-1",
    toolName: "datahub_catalog",
    input: { privateMarker: "RAW_INPUT_MUST_NOT_RENDER" },
    rawInput: '{"privateMarker":"RAW_INPUT_MUST_NOT_RENDER"}',
  };
  for (const result of [
    undefined,
    {
      details: {
        contract: "unknown",
        privateMarker: "RAW_RESULT_MUST_NOT_RENDER",
      },
      isError: false,
    },
    { details: undefined, isError: true },
  ]) {
    const html = renderMessage(
      { role: "assistant", content: [block] },
      {
        toolResults: new Map(
          result
            ? [
                [
                  block.toolCallId,
                  {
                    ...result,
                    role: "toolResult",
                    toolCallId: block.toolCallId,
                    content: [
                      {
                        type: "text",
                        text: '{"secret":"RAW_ERROR_MUST_NOT_RENDER"}',
                      },
                    ],
                  },
                ],
              ]
            : [],
        ),
      },
    );
    assert.doesNotMatch(
      html,
      /RAW_(INPUT|RESULT|ERROR)_MUST_NOT_RENDER|<pre|<code/,
    );
    assert.match(html, result ? /查詢|重新/ : /正在查詢/);
  }
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage(
    {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      content: [block],
    },
    {
      toolResults: new Map([[block.toolCallId, result]]),
      onOpenSession() {},
    },
  );

  assert.match(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="Open sub-agent session"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage(
    {
      role: "assistant",
      provider: "anthropic",
      model: "claude-test",
      content: [
        {
          ...block,
          toolCallId: "call-extension-1",
          toolName: "extension_tool",
        },
      ],
    },
    {
      toolResults: new Map(),
      onOpenSession() {},
    },
  );
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage(
    {
      role: "assistant",
      provider: "openai",
      model: "gpt-test",
      content: [{ type: "text", text: "Select this response" }],
    },
    { entryId: "assistant-entry" },
  );

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content:
      '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText(
    {
      role: "user",
      content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
    },
    "/skill:review src/main.ts",
  );

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

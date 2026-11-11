#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserController } from "./browser.js";

const browser = new BrowserController();
const server = new McpServer(
  { name: "mercury", version: "1.0.0" },
  {
    instructions:
      "Mercury browser control over WebDriver BiDi. Call browser_start before other tools. Take a snapshot to get element refs (e1, e2, ...) before clicking or filling; refs expire after navigation or DOM changes. The browser uses a dedicated automation profile, never the daily Mercury profile. Dialogs are auto-dismissed and logged.",
  },
);

const text = (value) => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const image = (shot) => ({
  content: [
    { type: "image", data: shot.data, mimeType: "image/png" },
    { type: "text", text: JSON.stringify({ bytes: shot.bytes, path: shot.path }) },
  ],
});

const fail = (error) => ({
  content: [{ type: "text", text: error?.message ?? String(error) }],
  isError: true,
});

// Serialize page operations so parallel tool calls cannot race the same tab.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function tool(name, config, fn) {
  server.registerTool(name, config, async (args) => {
    try {
      return await serial(() => fn(args));
    } catch (error) {
      return fail(error);
    }
  });
}

// Lifecycle and status tools bypass the queue so kill/close stay responsive.
function direct(name, config, fn) {
  server.registerTool(name, config, async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(error);
    }
  });
}

const tabId = z
  .string()
  .regex(/^t\d+$/)
  .optional()
  .describe("Tab id from tabs_list; defaults to the current tab.");
const ref = z.string().regex(/^e\d+$/).optional().describe("Element ref from snapshot.");
const selector = z.string().optional().describe("CSS selector, used when ref is absent.");
const waitUntil = z.enum(["load", "domcontentloaded"]).default("load");
const timeout = z.number().int().positive().max(120000).default(30000);

tool(
  "browser_start",
  {
    description:
      "Launch the dedicated Mercury instance and keep it running across calls. Uses a separate automation profile, never the daily Mercury profile. Safe to call when already running.",
    inputSchema: {
      headless: z.boolean().default(true).describe("Run without a visible window. Set false to watch."),
      url: z.string().optional().describe("Optional page to open after launch."),
    },
    annotations: { openWorldHint: true },
  },
  async ({ headless, url }) => text(await browser.start({ headless, url })),
);

direct(
  "browser_status",
  {
    description:
      "Report whether the dedicated Mercury instance is running, with PID, profile, BiDi endpoint and open tabs.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => text(await browser.status()),
);

direct(
  "browser_close",
  {
    description: "Gracefully close the dedicated Mercury instance. Profile data is preserved.",
    inputSchema: {},
    annotations: { destructiveHint: false },
  },
  async () => text(await browser.close()),
);

direct(
  "browser_kill",
  {
    description:
      "Force-kill the dedicated Mercury instance and fail pending operations. Use when close hangs or the browser is unresponsive.",
    inputSchema: {},
    annotations: { destructiveHint: true },
  },
  async () => text(await browser.kill()),
);

tool(
  "tabs_list",
  {
    description: "List open tabs with stable ids, URLs, titles and which tab is current.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => text(await browser.tabsList()),
);

tool(
  "tab_open",
  {
    description: "Open a new tab and make it current. Optionally navigate to a URL.",
    inputSchema: { url: z.string().optional() },
  },
  async ({ url }) => text(await browser.tabOpen({ url })),
);

tool(
  "tab_close",
  {
    description: "Close a tab. Defaults to the current tab.",
    inputSchema: { tabId },
  },
  async ({ tabId }) => text(await browser.tabClose({ tabId })),
);

tool(
  "tab_select",
  {
    description: "Make a tab current for subsequent operations.",
    inputSchema: { tabId: z.string().regex(/^t\d+$/).describe("Tab id from tabs_list.") },
  },
  async ({ tabId }) => text(await browser.tabSelect({ tabId })),
);

tool(
  "navigate",
  {
    description: "Navigate the current tab to a URL and wait for load.",
    inputSchema: { url: z.string(), waitUntil, timeout, tabId },
  },
  async (args) => text(await browser.navigate(args)),
);

tool(
  "reload",
  {
    description: "Reload the current tab.",
    inputSchema: { waitUntil, timeout, tabId },
  },
  async (args) => text(await browser.reload(args)),
);

tool(
  "go_back",
  {
    description:
      "Go to the previous URL tracked by this server. Uses an MCP-side history stack because Firefox BiDi history traversal is unreliable.",
    inputSchema: { timeout, tabId },
  },
  async (args) => text(await browser.goBack(args)),
);

tool(
  "go_forward",
  {
    description: "Go to the next URL tracked by this server.",
    inputSchema: { timeout, tabId },
  },
  async (args) => text(await browser.goForward(args)),
);

tool(
  "snapshot",
  {
    description:
      "Return visible interactive and text elements with refs (e1, e2, ...). Take a new snapshot after navigation or DOM changes. Use refs with click, fill, hover, select_option, upload and screenshot.",
    inputSchema: {
      maxElements: z.number().int().min(1).max(1000).default(400),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => text(await browser.snapshot(args)),
);

tool(
  "read_page",
  {
    description: "Return the current page's visible text, URL and title. Truncated to maxChars.",
    inputSchema: {
      maxChars: z.number().int().min(100).max(100000).default(20000),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => text(await browser.readPage(args)),
);

tool(
  "screenshot",
  {
    description:
      "Capture a PNG of the viewport, the full page, or one element. Returns the image to the model and optionally saves it to path.",
    inputSchema: {
      fullPage: z.boolean().default(false),
      ref,
      selector,
      path: z.string().optional().describe("Optional file path to save the PNG."),
      tabId,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => image(await browser.screenshot(args)),
);

tool(
  "evaluate",
  {
    description:
      "Evaluate a JavaScript expression in the current page and return the JSON-serializable result. Runs in page context, not Node.",
    inputSchema: { expression: z.string(), tabId },
  },
  async (args) => text(await browser.evaluate(args)),
);

tool(
  "click",
  {
    description:
      "Click an element by snapshot ref or CSS selector. Scrolls into view and uses trusted input. Right-click and double-click supported.",
    inputSchema: {
      ref,
      selector,
      button: z.enum(["left", "right", "middle"]).default("left"),
      clickCount: z.number().int().min(1).max(3).default(1),
      tabId,
    },
  },
  async (args) => text(await browser.click(args)),
);

tool(
  "hover",
  {
    description: "Move the mouse over an element by ref or selector.",
    inputSchema: { ref, selector, tabId },
  },
  async (args) => text(await browser.hover(args)),
);

tool(
  "fill",
  {
    description:
      "Clear and fill an input, textarea or contenteditable element by ref or selector. Dispatches input and change events.",
    inputSchema: { ref, selector, value: z.string(), tabId },
  },
  async (args) => text(await browser.fill(args)),
);

tool(
  "type_text",
  {
    description:
      "Type text with the keyboard. Focuses the target first when ref or selector is given; otherwise types into the active element.",
    inputSchema: {
      text: z.string(),
      ref,
      selector,
      delay: z.number().int().min(0).max(1000).default(0),
      tabId,
    },
  },
  async (args) => text(await browser.typeText(args)),
);

tool(
  "press_key",
  {
    description:
      "Press a key or combination such as Enter, Escape, Tab, Control+A. Focuses the target first when ref or selector is given.",
    inputSchema: { key: z.string(), ref, selector, tabId },
  },
  async (args) => text(await browser.pressKey(args)),
);

tool(
  "select_option",
  {
    description: "Select one or more options in a <select> by value, label or index.",
    inputSchema: { values: z.array(z.string()).min(1), ref, selector, tabId },
  },
  async (args) => text(await browser.selectOption(args)),
);

tool(
  "scroll",
  {
    description:
      "Scroll the page by pixels, or scroll an element into view when ref or selector is given.",
    inputSchema: {
      direction: z.enum(["up", "down", "left", "right"]).default("down"),
      amount: z.number().int().min(1).max(10000).default(500),
      ref,
      selector,
      tabId,
    },
  },
  async (args) => text(await browser.scroll(args)),
);

tool(
  "wait_for",
  {
    description:
      "Wait for a selector to be visible, text to appear, or the URL to contain a substring. Provide exactly one of selector, text or url.",
    inputSchema: {
      selector: z.string().optional(),
      text: z.string().optional(),
      url: z.string().optional(),
      timeout,
      tabId,
    },
  },
  async (args) => text(await browser.waitFor(args)),
);

tool(
  "logs",
  {
    description:
      "Return recent console messages, page errors, failed requests and HTTP >= 400 responses for the current tab. Optionally clear the buffer.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(100),
      clear: z.boolean().default(false),
      tabId,
    },
  },
  async (args) => text(await browser.logs(args)),
);

tool(
  "upload",
  {
    description:
      "Set files on a file input by ref or selector. Paths are read by the MCP server process.",
    inputSchema: { paths: z.array(z.string()).min(1), ref, selector, tabId },
  },
  async (args) => text(await browser.upload(args)),
);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`mercury-mcp shutting down (${signal})`);
  await browser.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("stdin end"));
process.on("uncaughtException", (error) => {
  console.error("mercury-mcp uncaught exception", error);
  shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  console.error("mercury-mcp unhandled rejection", error);
});

await server.connect(new StdioServerTransport());
console.error(`mercury-mcp ready (profile: ${browser.profile})`);

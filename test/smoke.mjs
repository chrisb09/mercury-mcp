import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const profile = mkdtempSync(join(tmpdir(), "mercury-mcp-test-"));
const httpServer = createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>smoke</title><body>
    <button id="b" onclick="window.__clicked=true">Click me</button>
    <input id="text">
    <script>console.log('page-log')</script>
  </body>`);
});
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${httpServer.address().port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  env: { ...process.env, MERCURY_MCP_PROFILE: profile },
});
const client = new Client({ name: "smoke", version: "1.0.0" });

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name}: ${result.content?.[0]?.text ?? "unknown error"}`);
  }
  return result;
};
const json = async (name, args = {}) => JSON.parse((await call(name, args)).content[0].text);

try {
  await client.connect(transport);

  const tools = await client.listTools();
  assert.ok(tools.tools.length >= 20, `expected at least 20 tools, got ${tools.tools.length}`);

  const started = await json("browser_start", { headless: true });
  assert.equal(started.running, true);
  assert.equal(started.profile, profile);

  const tab = await json("tab_open", { url: `${base}/` });
  assert.match(tab.id, /^t\d+$/);

  const tabs = await json("tabs_list");
  assert.ok(tabs.some((entry) => entry.current && entry.url.startsWith(base)));

  const snapshot = await json("snapshot");
  const button = snapshot.elements.find((element) => element.tag === "button");
  assert.ok(button, "button missing from snapshot");
  assert.match(button.name, /Click me/);

  await json("click", { ref: button.ref });
  const clicked = await json("evaluate", { expression: "window.__clicked === true" });
  assert.equal(clicked.result, true);

  await json("fill", { selector: "#text", value: "hello" });
  const value = await json("evaluate", {
    expression: "document.querySelector('#text').value",
  });
  assert.equal(value.result, "hello");

  const shot = await call("screenshot", {});
  const image = shot.content.find((content) => content.type === "image");
  assert.ok(image && image.data.length > 100, "screenshot missing");

  const logs = await json("logs", {});
  assert.ok(
    logs.entries.some((entry) => entry.text?.includes("page-log")),
    "console log missing",
  );

  const page = await json("read_page");
  assert.ok(page.text.includes("Click me"));

  await json("navigate", { url: `${base}/one` });
  const back = await json("go_back");
  assert.equal(back.navigated, true);
  assert.ok(back.url.endsWith("/"));
  const forward = await json("go_forward");
  assert.equal(forward.navigated, true);
  assert.ok(forward.url.endsWith("/one"));

  const closed = await json("browser_close");
  assert.equal(closed.running, false);

  console.log("smoke test passed");
} finally {
  await client.callTool({ name: "browser_kill", arguments: {} }).catch(() => {});
  await client.close().catch(() => {});
  httpServer.close();
  rmSync(profile, { recursive: true, force: true });
}

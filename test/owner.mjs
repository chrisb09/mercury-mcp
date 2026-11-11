import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const profile = mkdtempSync(join(tmpdir(), "mercury-mcp-owner-"));
const script = fileURLToPath(new URL("../src/index.js", import.meta.url));

function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    env: { ...process.env, MERCURY_MCP_PROFILE: profile },
  });
  const client = new Client({ name: "owner-test", version: "1.0.0" });
  return { client, transport };
}

const first = connect();
const second = connect();

try {
  await first.client.connect(first.transport);
  await second.client.connect(second.transport);

  const started = await first.client.callTool({
    name: "browser_start",
    arguments: { headless: true },
  });
  assert.equal(started.isError, undefined);

  const blocked = await second.client.callTool({
    name: "browser_start",
    arguments: { headless: true },
  });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /already in use/);

  await first.client.callTool({ name: "browser_close", arguments: {} });

  const retried = await second.client.callTool({
    name: "browser_start",
    arguments: { headless: true },
  });
  assert.equal(retried.isError, undefined);

  await second.client.callTool({ name: "browser_close", arguments: {} });
  console.log("owner test passed");
} finally {
  await first.client.callTool({ name: "browser_kill", arguments: {} }).catch(() => {});
  await second.client.callTool({ name: "browser_kill", arguments: {} }).catch(() => {});
  await first.client.close().catch(() => {});
  await second.client.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}

import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROFILE = join(homedir(), ".local/share/mercury-mcp/profile");
const PID_FILE = ".mercury-mcp.pid";
const MAX_LOGS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function serialize(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

// Runs inside the page. Must be self-contained: Puppeteer serializes its source.
function snapshotInPage(maxElements) {
  const ATTR = "data-mcp-ref";
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  const out = [];
  let n = 0;

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0" &&
      el.getAttribute("aria-hidden") !== "true"
    );
  };

  const interactive = (el) =>
    el.matches(
      'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[contenteditable="true"],[onclick]',
    );

  const walk = (el) => {
    if (out.length >= maxElements) return;
    if (el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "svg", "path", "head", "meta", "link"].includes(tag)) return;
    if (!visible(el)) return;

    const isInteractive = interactive(el);
    const hasText = Array.from(el.childNodes).some(
      (node) => node.nodeType === 3 && node.textContent.trim(),
    );

    if (isInteractive || hasText) {
      const ref = `e${++n}`;
      el.setAttribute(ATTR, ref);
      const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 100);
      const isPassword = el.type === "password";
      const name = (
        el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.querySelector("img[alt]")?.alt ||
        text ||
        (isPassword ? "" : el.value) ||
        ""
      )
        .trim()
        .slice(0, 100);
      const entry = { ref, tag, role: el.getAttribute("role") || tag, name };
      if (el.type) entry.type = el.type;
      if (!isPassword && el.value !== undefined && el.value !== "") {
        entry.value = String(el.value).slice(0, 100);
      }
      if (el.href) entry.href = String(el.href).slice(0, 200);
      if (el.disabled) entry.disabled = true;
      if (el.checked) entry.checked = true;
      if (tag === "select") {
        entry.options = Array.from(el.options)
          .slice(0, 100)
          .map((option) => ({
            value: option.value,
            label: option.textContent.trim(),
          }));
      }
      out.push(entry);
    }

    if (isInteractive) return;
    for (const child of el.children) walk(child);
  };

  if (document.body) walk(document.body);
  return out;
}

export class BrowserController {
  #browser = null;
  #tabs = new Map();
  #nextTabId = 1;
  #currentTabId = null;
  #profile;
  #headless = true;

  constructor() {
    this.#profile = process.env.MERCURY_MCP_PROFILE || DEFAULT_PROFILE;
  }

  get profile() {
    return this.#profile;
  }

  async start({ headless = true, url } = {}) {
    if (this.#browser?.connected) {
      if (url) await this.navigate({ url });
      return this.status();
    }

    await this.#cleanupOrphan();
    mkdirSync(this.#profile, { recursive: true });
    this.#headless = headless;
    this.#browser = await puppeteer.launch({
      browser: "firefox",
      executablePath: process.env.MERCURY_BIN || "/usr/lib/mercury/mercury",
      userDataDir: this.#profile,
      headless,
      // Without this, a running daily Mercury swallows the launch and no BiDi endpoint appears.
      args: ["--no-remote"],
      defaultViewport: { width: 1280, height: 800 },
      timeout: 30000,
    });
    this.#writePid();
    this.#browser.on("disconnected", () => this.#reset());
    await this.#syncTabs();
    if (url) await this.navigate({ url });
    return this.status();
  }

  async status() {
    const running = Boolean(this.#browser?.connected);
    let tabs = [];
    if (running) {
      try {
        tabs = await this.tabsList();
      } catch {
        tabs = [];
      }
    }
    return {
      running,
      connected: running,
      pid: this.#browser?.process()?.pid ?? null,
      profile: this.#profile,
      headless: this.#headless,
      endpoint: running ? this.#endpoint() : null,
      tabs,
    };
  }

  async close() {
    const browser = this.#browser;
    if (!browser) return { closed: false, running: false };
    const pid = browser.process()?.pid ?? null;
    try {
      await withTimeout(browser.close(), 5000, "browser close");
    } catch {
      try {
        browser.process()?.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.#reset();
    return { closed: true, pid, running: false };
  }

  async kill() {
    const browser = this.#browser;
    if (!browser) return { killed: false, running: false };
    const pid = browser.process()?.pid ?? null;
    try {
      browser.process()?.kill("SIGKILL");
    } catch {
      // already gone
    }
    if (pid) {
      for (let i = 0; i < 30 && existsSync(`/proc/${pid}`); i++) await sleep(100);
    }
    this.#reset();
    return { killed: true, pid, running: false };
  }

  async shutdown() {
    await this.close().catch(() => {});
  }

  async tabsList() {
    if (!this.#browser?.connected) return [];
    await this.#syncTabs();
    const out = [];
    for (const [id, tab] of this.#tabs) {
      out.push({
        id,
        current: id === this.#currentTabId,
        url: tab.page.url(),
        title: await this.#title(tab.page),
      });
    }
    return out;
  }

  async tabOpen({ url } = {}) {
    const browser = this.#requireBrowser();
    const page = await browser.newPage();
    const id = this.#register(page);
    this.#currentTabId = id;
    if (url) await this.navigate({ url, tabId: id });
    return { id, url: page.url(), title: await this.#title(page) };
  }

  async tabClose({ tabId } = {}) {
    const id = tabId ?? this.#currentTabId;
    if (!id) throw new Error("No open tab.");
    const tab = this.#tabs.get(id);
    if (!tab) throw new Error(`Unknown tab: ${id}`);
    await tab.page.close();
    this.#tabs.delete(id);
    if (this.#currentTabId === id) {
      this.#currentTabId = this.#tabs.keys().next().value ?? null;
    }
    return { closed: id, tabs: await this.tabsList() };
  }

  async tabSelect({ tabId } = {}) {
    if (!tabId) throw new Error("tabId is required");
    const tab = this.#tabs.get(tabId);
    if (!tab) throw new Error(`Unknown tab: ${tabId}`);
    this.#currentTabId = tabId;
    await tab.page.bringToFront().catch(() => {});
    return { current: tabId, url: tab.page.url(), title: await this.#title(tab.page) };
  }

  async navigate({ url, waitUntil = "load", timeout = 30000, tabId } = {}) {
    if (!url) throw new Error("url is required");
    const tab = this.#tab(tabId);
    const response = await tab.page.goto(url, { waitUntil, timeout });
    this.#pushHistory(tab, tab.page.url());
    return {
      url: tab.page.url(),
      title: await this.#title(tab.page),
      status: response?.status() ?? null,
    };
  }

  async reload({ waitUntil = "load", timeout = 30000, tabId } = {}) {
    const tab = this.#tab(tabId);
    await tab.page.reload({ waitUntil, timeout });
    return { url: tab.page.url(), title: await this.#title(tab.page) };
  }

  // Firefox BiDi history traversal hangs and poisons later navigations in this stack,
  // so back/forward use the server's own URL stack.
  async goBack({ timeout = 30000, tabId } = {}) {
    const tab = this.#tab(tabId);
    if (tab.index <= 0) {
      return { navigated: false, url: tab.page.url(), reason: "no earlier MCP-tracked entry" };
    }
    const previous = tab.index;
    tab.index -= 1;
    try {
      const response = await tab.page.goto(tab.history[tab.index], { waitUntil: "load", timeout });
      return {
        navigated: true,
        url: tab.page.url(),
        title: await this.#title(tab.page),
        status: response?.status() ?? null,
      };
    } catch (error) {
      tab.index = previous;
      throw error;
    }
  }

  async goForward({ timeout = 30000, tabId } = {}) {
    const tab = this.#tab(tabId);
    if (tab.index >= tab.history.length - 1) {
      return { navigated: false, url: tab.page.url(), reason: "no later MCP-tracked entry" };
    }
    const previous = tab.index;
    tab.index += 1;
    try {
      const response = await tab.page.goto(tab.history[tab.index], { waitUntil: "load", timeout });
      return {
        navigated: true,
        url: tab.page.url(),
        title: await this.#title(tab.page),
        status: response?.status() ?? null,
      };
    } catch (error) {
      tab.index = previous;
      throw error;
    }
  }

  async snapshot({ maxElements = 400, tabId } = {}) {
    const tab = this.#tab(tabId);
    const elements = await tab.page.evaluate(snapshotInPage, maxElements);
    return {
      url: tab.page.url(),
      title: await this.#title(tab.page),
      elements,
      truncated: elements.length >= maxElements,
    };
  }

  async readPage({ maxChars = 20000, tabId } = {}) {
    const tab = this.#tab(tabId);
    const text = await tab.page.evaluate(() => document.body?.innerText ?? "");
    return {
      url: tab.page.url(),
      title: await this.#title(tab.page),
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    };
  }

  async screenshot({ fullPage = false, ref, selector, path, tabId } = {}) {
    const tab = this.#tab(tabId);
    let data;
    if (ref || selector) {
      const el = await this.#element(tab, { ref, selector });
      data = await el.screenshot({ encoding: "base64" });
    } else {
      data = await tab.page.screenshot({ fullPage, encoding: "base64" });
    }
    if (path) writeFileSync(path, Buffer.from(data, "base64"));
    return { data, bytes: Buffer.from(data, "base64").length, path: path ?? null };
  }

  async evaluate({ expression, tabId } = {}) {
    if (!expression) throw new Error("expression is required");
    const tab = this.#tab(tabId);
    const result = await tab.page.evaluate(expression);
    return { result: serialize(result) };
  }

  async click({ ref, selector, button = "left", clickCount = 1, tabId } = {}) {
    const tab = this.#tab(tabId);
    const el = await this.#element(tab, { ref, selector });
    await el.click({ button, clickCount });
    return { clicked: true, url: tab.page.url(), title: await this.#title(tab.page) };
  }

  async hover({ ref, selector, tabId } = {}) {
    const tab = this.#tab(tabId);
    const el = await this.#element(tab, { ref, selector });
    await el.hover();
    return { hovered: true };
  }

  async fill({ ref, selector, value, tabId } = {}) {
    if (value === undefined) throw new Error("value is required");
    const tab = this.#tab(tabId);
    const sel = this.#selector({ ref, selector });
    await tab.page.locator(sel).fill(String(value));
    return { filled: true, value: String(value) };
  }

  async typeText({ text, ref, selector, delay = 0, tabId } = {}) {
    if (text === undefined) throw new Error("text is required");
    const tab = this.#tab(tabId);
    if (ref || selector) {
      await tab.page.type(this.#selector({ ref, selector }), String(text), { delay });
    } else {
      await tab.page.keyboard.type(String(text), { delay });
    }
    return { typed: String(text) };
  }

  async pressKey({ key, ref, selector, tabId } = {}) {
    if (!key) throw new Error("key is required");
    const tab = this.#tab(tabId);
    if (ref || selector) {
      const el = await this.#element(tab, { ref, selector });
      await el.focus();
    }
    await tab.page.keyboard.press(key);
    return { pressed: key };
  }

  async selectOption({ values, ref, selector, tabId } = {}) {
    if (!Array.isArray(values) || values.length === 0) throw new Error("values is required");
    const tab = this.#tab(tabId);
    const selected = await tab.page.select(
      this.#selector({ ref, selector }),
      ...values.map(String),
    );
    return { selected };
  }

  async scroll({ direction = "down", amount = 500, ref, selector, tabId } = {}) {
    const tab = this.#tab(tabId);
    if (ref || selector) {
      const el = await this.#element(tab, { ref, selector });
      await el.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }));
      return { scrolled: "element" };
    }
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await tab.page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx, dy });
    return { scrolled: { dx, dy } };
  }

  async waitFor({ selector, text, url, timeout = 30000, tabId } = {}) {
    const tab = this.#tab(tabId);
    if (selector) {
      await tab.page.waitForSelector(selector, { visible: true, timeout });
    } else if (text) {
      await tab.page.waitForFunction(
        (needle) => (document.body?.innerText ?? "").includes(needle),
        { timeout },
        text,
      );
    } else if (url) {
      await tab.page.waitForFunction(
        (needle) => location.href.includes(needle),
        { timeout },
        url,
      );
    } else {
      throw new Error("Provide selector, text or url.");
    }
    return { matched: true, url: tab.page.url(), title: await this.#title(tab.page) };
  }

  async logs({ limit = 100, clear = false, tabId } = {}) {
    const tab = this.#tab(tabId);
    const total = tab.logs.length;
    const entries = tab.logs.slice(-limit);
    if (clear) tab.logs = [];
    return { total, entries };
  }

  async upload({ paths, ref, selector, tabId } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("paths is required");
    const tab = this.#tab(tabId);
    const el = await this.#element(tab, { ref, selector });
    await el.uploadFile(...paths);
    return { uploaded: paths };
  }

  #requireBrowser() {
    if (!this.#browser?.connected) {
      throw new Error("Browser is not running. Call browser_start first.");
    }
    return this.#browser;
  }

  #tab(tabId) {
    const id = tabId ?? this.#currentTabId;
    if (!id) throw new Error("No open tab. Call tab_open first.");
    const tab = this.#tabs.get(id);
    if (!tab || tab.page.isClosed()) throw new Error(`Unknown or closed tab: ${id}`);
    return tab;
  }

  #selector({ ref, selector }) {
    if (ref) {
      if (!/^e\d+$/.test(ref)) throw new Error(`Invalid ref: ${ref}`);
      return `[data-mcp-ref="${ref}"]`;
    }
    if (selector) return selector;
    throw new Error("Provide ref or selector.");
  }

  async #element(tab, { ref, selector }) {
    const sel = this.#selector({ ref, selector });
    const handle = await tab.page.$(sel);
    if (!handle) throw new Error(`No element matches ${sel}. Take a new snapshot.`);
    return handle;
  }

  async #syncTabs() {
    if (!this.#browser?.connected) return;
    const pages = await this.#browser.pages();
    const known = new Set([...this.#tabs.values()].map((tab) => tab.page));
    for (const page of pages) {
      if (!known.has(page)) this.#register(page);
    }
    for (const [id, tab] of this.#tabs) {
      if (tab.page.isClosed() || !pages.includes(tab.page)) this.#tabs.delete(id);
    }
    if (!this.#tabs.has(this.#currentTabId)) {
      this.#currentTabId = this.#tabs.keys().next().value ?? null;
    }
  }

  #register(page) {
    const id = `t${this.#nextTabId++}`;
    const tab = { id, page, history: [], index: -1, logs: [] };
    this.#tabs.set(id, tab);
    page.setDefaultTimeout(30000);
    page.on("console", (message) => {
      this.#log(tab, { type: "console", level: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => {
      this.#log(tab, { type: "pageerror", text: error.message });
    });
    page.on("requestfailed", (request) => {
      this.#log(tab, {
        type: "requestfailed",
        url: request.url(),
        error: request.failure()?.errorText ?? "",
      });
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        this.#log(tab, { type: "http", status: response.status(), url: response.url() });
      }
    });
    page.on("dialog", async (dialog) => {
      this.#log(tab, { type: "dialog", dialogType: dialog.type(), message: dialog.message() });
      await dialog.dismiss().catch(() => {});
    });
    if (!this.#currentTabId) this.#currentTabId = id;
    return id;
  }

  #log(tab, entry) {
    tab.logs.push({ at: Date.now(), ...entry });
    if (tab.logs.length > MAX_LOGS) tab.logs.splice(0, tab.logs.length - MAX_LOGS);
  }

  #pushHistory(tab, url) {
    if (!url || url === "about:blank") return;
    if (tab.history[tab.index] === url) return;
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    tab.index = tab.history.length - 1;
  }

  async #title(page) {
    try {
      return await withTimeout(page.title(), 2000, "title");
    } catch {
      return "";
    }
  }

  #endpoint() {
    try {
      return this.#browser.wsEndpoint();
    } catch {
      return null;
    }
  }

  #writePid() {
    const browserPid = this.#browser?.process()?.pid;
    if (browserPid) {
      writeFileSync(
        join(this.#profile, PID_FILE),
        JSON.stringify({ browserPid, mcpPid: process.pid }),
      );
    }
  }

  #removePid() {
    try {
      rmSync(join(this.#profile, PID_FILE), { force: true });
    } catch {
      // best effort
    }
  }

  #reset() {
    this.#browser = null;
    this.#tabs.clear();
    this.#currentTabId = null;
    this.#removePid();
  }

  async #cleanupOrphan() {
    const pidPath = join(this.#profile, PID_FILE);
    let record = null;
    try {
      const raw = readFileSync(pidPath, "utf8").trim();
      record = raw.startsWith("{")
        ? JSON.parse(raw)
        : { browserPid: Number(raw), mcpPid: 0 };
    } catch {
      record = null;
    }

    const browserPid = Number(record?.browserPid) || 0;
    const mcpPid = Number(record?.mcpPid) || 0;

    // Another live MCP server owns this profile. Do not kill its browser.
    if (mcpPid > 0 && mcpPid !== process.pid && this.#alive(mcpPid)) {
      const cmdline = this.#cmdline(mcpPid);
      if (cmdline.includes("mercury-mcp")) {
        throw new Error(
          `Mercury automation profile is already in use by another OpenCode session (MCP PID ${mcpPid}). Close that browser or set MERCURY_MCP_PROFILE to a different path.`,
        );
      }
    }

    if (
      browserPid > 0 &&
      this.#alive(browserPid) &&
      this.#cmdline(browserPid).includes(this.#profile)
    ) {
      try {
        process.kill(browserPid, "SIGKILL");
      } catch {
        // already gone
      }
      for (let i = 0; i < 30 && existsSync(`/proc/${browserPid}`); i++) await sleep(100);
    }

    rmSync(pidPath, { force: true });
    // This profile belongs to the server alone; stale locks after a crash are safe to remove.
    rmSync(join(this.#profile, ".parentlock"), { force: true });
    rmSync(join(this.#profile, "lock"), { force: true });
  }

  #alive(pid) {
    return existsSync(`/proc/${pid}`);
  }

  #cmdline(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return "";
    }
  }
}

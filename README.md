# mercury-mcp

Local MCP server that controls a dedicated Mercury (Firefox ESR fork) instance over
WebDriver BiDi. One browser stays alive across tool calls and chat turns, and is
closed when the MCP process exits.

## Requirements

- Node.js 22+
- Mercury at `/usr/lib/mercury/mercury` (override with `MERCURY_BIN`)
- Linux (orphan cleanup reads `/proc`)

## Install

```sh
cd ~/git/mercury-mcp
npm install
npm test
```

## OpenCode

```jsonc
{
  "mcp": {
    "servers": {
      "mercury": {
        "type": "local",
        "command": [
          "/absolute/path/to/node",
          "/absolute/path/to/mercury-mcp/src/index.js"
        ],
        "environment": {
          "MERCURY_BIN": "/usr/lib/mercury/mercury"
        }
      }
    }
  }
}
```

Replace the two absolute paths with your Node binary and checkout.

The server is lazy: Mercury starts only when `browser_start` is called.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_start` | Launch headless (default) or headful; optional initial URL. |
| `browser_status` | Running state, PID, profile, BiDi endpoint, tabs. |
| `browser_close` | Graceful shutdown; profile data kept. |
| `browser_kill` | Force-kill the owned instance and fail pending calls. |
| `tabs_list` / `tab_open` / `tab_close` / `tab_select` | Tab management with stable ids (`t1`, `t2`, ...). |
| `navigate` / `reload` / `go_back` / `go_forward` | Navigation. Back/forward use an MCP-side URL stack. |
| `snapshot` | Visible interactive/text elements with refs (`e1`, `e2`, ...). |
| `read_page` | Visible page text, URL, title. |
| `screenshot` | Viewport, full page or element PNG. |
| `evaluate` | JavaScript in page context. |
| `click` / `hover` / `fill` / `type_text` / `press_key` / `select_option` / `scroll` | Interaction. |
| `wait_for` | Wait for selector, text or URL. |
| `logs` | Console, page errors, failed requests, HTTP >= 400. |
| `upload` | Set files on a file input. |

Take a fresh `snapshot` after navigation or DOM changes; refs expire.

## Profile

Default: `~/.local/share/mercury-mcp/profile`. Override with `MERCURY_MCP_PROFILE`.

This is a dedicated automation profile. It never touches your daily Mercury profile.
Delete the directory to reset logins and cookies.

The profile is single-owner. If another live OpenCode session already owns it,
`browser_start` returns an error instead of killing that browser. Set
`MERCURY_MCP_PROFILE` to a different path to run sessions side by side.

## Security

- `navigator.webdriver` is `true` in this browser. Sites can detect automation.
  Do not log into sensitive accounts.
- Page content is untrusted input. A prompt-injected page can make the agent act as
  you within this profile.
- `upload` reads arbitrary local files readable by the MCP process.
- This is not an OS sandbox.

## Limitations

- Dialogs are auto-dismissed and logged; there is no accept/prompt-text tool.
- No download handling.
- `snapshot` is a DOM heuristic, not a native accessibility tree; shadow DOM is not
  traversed.
- `go_back` / `go_forward` use an MCP-side URL stack because Firefox BiDi history
  traversal hangs in this stack.
- One browser per MCP process; all OpenCode chats in the same directory share it.
- Firefox BiDi only; no CDP.

## Development

```sh
npm test
```

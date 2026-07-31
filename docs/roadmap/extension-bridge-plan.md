# Extension Bridge — driving the user's real Chrome profile

## Why

Chrome 136+ ignores `--remote-debugging-port` when `--user-data-dir` is the default
directory, so CDP can never reach the profile the user is logged into. The current
workaround (copy the profile into `~/.openchrome/profiles/<name>` and sync cookies)
cannot carry a Google session: measured on a real profile, the copy contains
`SID`/`SAPISID`/`LOGIN_INFO`, decrypts fine, and the server invalidates the session on
the first request — YouTube renders signed out and the cookies disappear from the jar.

`chrome.debugger` is the only CDP surface that runs inside the live browser, with the
user's cookies and logins. Puppeteer already supports it through a custom transport
(`ExtensionTransport.connectTab`), which fakes the Browser/Target commands Puppeteer
needs and forwards everything else to `chrome.debugger.sendCommand`.

References:
- https://developer.chrome.com/blog/remote-debugging-port
- https://pptr.dev/guides/running-puppeteer-in-extensions
- https://developer.chrome.com/docs/extensions/reference/api/debugger

## Shape

```
MCP tools ──> SessionManager ──> puppeteer Page  (unchanged)
                                      │
                          puppeteer.connect({ transport })
                                      │
                        ExtensionBridgeTransport (Node)
                                      │  WebSocket, one per attached tab
                        service worker (MV3 extension)
                                      │
                        chrome.debugger / chrome.tabs
                                      │
                              user's real Chrome
```

The Node side keeps producing `Page` objects, so every existing tool (`read_page`,
`interact`, `computer`, `fill_form`, …) works without modification. The seam is the
same one `src/lightpanda/launcher.ts` already uses: build a `Browser`, hand it to the
session.

## Pieces

### 1. `extension/` (new, MV3)

`manifest.json`: `permissions: ["debugger", "tabs"]`, no host permissions needed —
`chrome.debugger` covers any tab the user approves.

Service worker responsibilities:
- Connect to `ws://127.0.0.1:<port>/extension` with a token from
  `src/auth/api-key-store.ts`; reconnect with backoff.
- RPCs: `attach{tabId}`, `detach{tabId}`, `sendCommand{tabId, sessionId, method, params}`,
  `tabs.query`, `tabs.create`, `tabs.update`, `tabs.remove`.
- Forward `chrome.debugger.onEvent` and `onDetach` as WS frames.

### 2. `src/extension-bridge/transport.ts` (new)

Port of puppeteer's `ExtensionTransport` (~150 lines, see
`node_modules/puppeteer-core/lib/cjs/puppeteer/cdp/ExtensionTransport.js`), with
`chrome.debugger.sendCommand` replaced by the WS RPC. It answers locally:
`Browser.getVersion`, `Target.getBrowserContexts`, `Target.setDiscoverTargets`,
`Target.setAutoAttach`, and synthesises the `tab`/`page` target pair. Everything else is
forwarded.

### 3. `src/extension-bridge/server.ts` (new)

WebSocket server (reuse the transport stack in `src/transports/`), token-authenticated,
tracking one extension connection per browser instance. Exposes
`attachTab(tabId): Promise<Browser>` — creates a transport, calls `puppeteer.connect`,
returns the browser whose single page is that tab.

### 4. SessionManager integration

- New worker kind `extension`; `tabId` is the Chrome tab id (number → string).
- `navigate` without a tabId calls `tabs.create` over the RPC instead of
  `Target.createTarget`, then attaches.
- `tabs_context` lists `chrome.tabs.query({})`, which finally answers the original
  question — the tabs the user already has open, in their real profile.
- `listUntrackedTabs()` already models "tabs Chrome has that no session owns"; the
  extension backend fills it from `tabs.query`.

## Constraints to design around

- **One tab per transport.** `chrome.debugger` attaches per tab and Puppeteer's view is
  limited to that page; parallel tabs need one transport each. Cheap (a WS multiplexed
  over one socket), but the pool must not assume a shared `Browser`.
- **No page creation through Puppeteer.** New tabs come from `chrome.tabs.create`.
- **Visible banner.** Chrome shows "… is debugging this browser" per attached tab and
  the user approves it. Not suppressible — it is the security model, and it is what
  makes this legitimate rather than a bypass.
- **Restricted domain set.** `Fetch`, `Network`, `Page`, `Runtime`, `DOM`, `Input`,
  `Target` are available; `Browser` and `SystemInfo` are not. Audit tools that touch
  browser-level domains (`oc_connection_health`, window bounds in `computer`) and give
  them an extension-backed fallback or a clear unsupported error.
- **Chrome-only.** Firefox/WebKit paths keep the launcher route.

## Order of work

1. Transport + a `scripts/` harness that attaches to one tab and runs `page.title()`.
2. Extension skeleton with `attach` + `sendCommand` only.
3. WS server with token auth, one connection.
4. `tabs.*` RPCs, then SessionManager worker kind and `tabs_context` wiring.
5. Tool audit for browser-level domains.

Steps 1–3 are the risky part and are testable end to end on their own: if
`page.title()` returns from a tab the user is logged into, the rest is plumbing.

## Not doing

- Bundling Puppeteer inside the extension. Keeping it in Node means tools stay unchanged.
- Replacing the launcher route. The extension bridge is opt-in, for when the real
  profile is required; headless/headed launching stays the default.

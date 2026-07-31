# CDP audit for the extension bridge

Which `createCDPSession()` call sites survive when the page comes from the
extension bridge instead of a launched Chrome, measured against a real tab
through the bridge (not inferred from documentation).

`page.createCDPSession()` issues `Target.attachToTarget`, which `chrome.debugger`
refuses — so every site below must reach CDP some other way, even when the
*method* it calls is perfectly supported.

## Measured domain support

Probed on a live tab; `-32601` means the method does not exist for extensions,
`-32000` means it ran and rejected the arguments.

| Works | Refused |
| --- | --- |
| `Page.captureScreenshot`, `Page.reload`, `Page.getLayoutMetrics` | `Browser.getWindowForTarget`, `Browser.setWindowBounds` |
| `Runtime.enable`, `Runtime.evaluate` | `SystemInfo.getInfo` |
| `DOM.getDocument`, `DOM.scrollIntoViewIfNeeded` | `HeapProfiler.collectGarbage` |
| `Network.enable`, `Network.getAllCookies`, `Network.emulateNetworkConditions` | `Target.getTargets` (`Not allowed`) |
| `Input.dispatchMouseEvent`, `Input.dispatchDragEvent` | `Target.createTarget`, `Target.attachToTarget` |
| `Emulation.setDeviceMetricsOverride`, `Log.enable`, `Performance.enable`, `Accessibility.enable` | |

### Console capture

`Runtime.consoleAPICalled` and `Runtime.exceptionThrown` arrive complete —
including logs from other extensions' content scripts in the same tab.

One catch: puppeteer does not issue its usual initial `Runtime.enable` over the
synthetic target, so `page.on('console')` stays silent until something enables
the domain. With an explicit `Runtime.enable` the events flow (log, warn, error,
pageerror). Tools that already enable the domain themselves are unaffected.

## Call sites

### Mechanical — the method works, only the session must change

Swap `createCDPSession()` for the page-level API, or reuse the page's existing
session. No behaviour lost.

| Site | Uses | Replacement |
| --- | --- | --- |
| `src/tools/interact.ts:486` | `Page.captureScreenshot` | `page.screenshot()` |
| `src/tools/batch-paginate.ts:190` | `Page.captureScreenshot` | `page.screenshot()` |
| `src/transports/http.ts:573` | `Page.captureScreenshot` | `page.screenshot()` |
| `src/tools/page-reload.ts:60` | `Page.reload` | `page.reload()` |
| `src/tools/network.ts:146` | `Network.emulateNetworkConditions` | `page.emulateNetworkConditions()` |
| `src/tools/console-capture.ts:277` | `Runtime.enable/disable` | `page.on('console')` |
| `src/tools/validate-page.ts:188` | `Runtime.enable/disable` | `page.on('console')` |
| `src/tools/drag-drop.ts:192` | `Input.dispatchDragEvent` | `page.mouse.drag*` |
| `src/tools/computer.ts` | `DOM.scrollIntoViewIfNeeded` | `elementHandle.scrollIntoView()` |
| `src/cdp/client.ts:1376`, `:1403`, `:1443` | `Network.getAllCookies`, `Network.setCookies` | `page.cookies()` / `page.setCookie()` |

### Structural — needs the extension tabs RPC

Target management has no CDP equivalent here; the bridge already exposes the
replacement.

| Site | Uses | Replacement |
| --- | --- | --- |
| `src/cdp/client.ts:1009` (createPage) | `Target.createTarget` | `bridge.createTab()` |
| `src/cdp/client.ts:1201`, `:1599`, `:2091` | `Target.getTargets`, target indexing | `bridge.listTabs()` |
| `src/cdp/connection-pool.ts:323` | session pooling per page | one transport per tab; the pool must not assume a shared browser |

### Unavailable — needs a guard

| Site | Uses | Behaviour to add |
| --- | --- | --- |
| `src/index.ts:845`, `src/cdp/client.ts:2146` (`triggerGC`) | `HeapProfiler.collectGarbage` | no-op on the bridge; it is an optimisation, not a feature |
| `oc_connection_health` | browser-level metrics | report extension connection state instead |
| window bounds in `computer` | `Browser.setWindowBounds` | `chrome.windows.update` RPC, or unsupported error |

## Consequence for the plan

Nine of the twelve mechanical swaps are one-line changes that also work on the
launcher path, so they can land before the bridge is wired into SessionManager
and reduce the surface that needs a bridge-specific branch. The structural group
is the actual step 4 work; the unavailable group is three guards.

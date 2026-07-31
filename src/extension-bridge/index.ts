import { ExtensionBridgeServer, DEFAULT_BRIDGE_PORT } from './server';

export { ExtensionBridgeServer, DEFAULT_BRIDGE_PORT } from './server';
export { ExtensionBridgeTransport, bridgeTargetId } from './transport';
export type { ExtensionTab } from './server';

let bridge: ExtensionBridgeServer | null = null;
let starting: Promise<ExtensionBridgeServer> | null = null;

/** Lazily start the bridge; the extension dials it and reconnects on its own. */
export async function getExtensionBridge(): Promise<ExtensionBridgeServer> {
  if (bridge) return bridge;
  if (starting) return starting;

  const port = Number(process.env.OPENCHROME_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
  const server = new ExtensionBridgeServer(port, process.env.OPENCHROME_BRIDGE_TOKEN);

  starting = server
    .start()
    .then(() => {
      bridge = server;
      return server;
    })
    .finally(() => {
      starting = null;
    });

  return starting;
}

export async function stopExtensionBridge(): Promise<void> {
  if (!bridge) return;
  const running = bridge;
  bridge = null;
  await running.stop();
}

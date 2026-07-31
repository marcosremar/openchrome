import { ExtensionBridgeServer, DEFAULT_BRIDGE_PORT } from '../src/extension-bridge/server';

const PORT = Number(process.env.OPENCHROME_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);

async function main(): Promise<void> {
  const bridge = new ExtensionBridgeServer(PORT, process.env.OPENCHROME_BRIDGE_TOKEN);
  await bridge.start();
  console.error('Waiting for the OpenChrome Bridge extension. Ctrl-C to stop.');

  const shutdown = () => {
    void bridge.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  setInterval(() => {}, 1 << 30);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

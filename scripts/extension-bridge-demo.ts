import { ExtensionBridgeServer } from '../src/extension-bridge/server';

const PORT = Number(process.env.OPENCHROME_BRIDGE_PORT ?? 9333);
const WAIT_MS = Number(process.env.OPENCHROME_BRIDGE_WAIT_MS ?? 120000);

async function main(): Promise<void> {
  const bridge = new ExtensionBridgeServer(PORT, process.env.OPENCHROME_BRIDGE_TOKEN);
  await bridge.start();

  console.error('\nLoad extension/bridge as an unpacked extension, then paste this into its options page:');
  console.error(`  ws://127.0.0.1:${PORT}?token=${bridge.token}\n`);
  console.error('Waiting for the extension to connect...');
  await bridge.waitForExtension(WAIT_MS);

  const tabs = await bridge.listTabs();
  console.error(`\n${tabs.length} tabs in the real profile:`);
  for (const tab of tabs.slice(0, 20)) {
    console.error(`  [${tab.id}] ${tab.title.slice(0, 50)} | ${tab.url.slice(0, 60)}`);
  }

  const target = tabs.find((tab) => tab.url.startsWith('http')) ?? tabs[0];
  if (!target) throw new Error('No tab to attach to');

  console.error(`\nAttaching to tab ${target.id}...`);
  const browser = await bridge.attachTab(target.id);
  const page = (await browser.pages())[0];

  console.error('url:  ', page.url());
  console.error('title:', await page.title());
  console.error('h1s:  ', await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1'))
      .map((h) => h.textContent?.trim())
      .slice(0, 3)
  ));

  await browser.disconnect();
  await bridge.stop();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

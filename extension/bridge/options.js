const input = document.getElementById('url');
const status = document.getElementById('status');

chrome.storage.local.get('bridgeUrl').then(({ bridgeUrl }) => {
  if (bridgeUrl) input.value = bridgeUrl;
});

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ bridgeUrl: input.value.trim() });
  status.textContent = 'Saved — connecting.';
});

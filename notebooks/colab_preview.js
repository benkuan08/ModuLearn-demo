// Each request has its own transfer slot, including simultaneous startup fetches.
let colabCallId = 0;
async function callColab(operation, ...args) {
  const port = window.modulearnPort;
  if (port) {
    const id = ++colabCallId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { port.removeEventListener('message', receive); reject(Error('Colab did not respond. Keep the runtime connected and check its logs.')); }, 2_500_000);
      function receive({ data }) {
        if (data.id !== id) return;
        clearTimeout(timer); port.removeEventListener('message', receive);
        if (data.error) reject(Error(data.error)); else resolve(data.value);
      }
      port.addEventListener('message', receive); port.start(); port.postMessage({ id, operation, args });
    });
  }
  const kernel = window.google?.colab?.kernel;
  if (!kernel?.invokeFunction) throw Error('Open ModuLearn from its connected Colab notebook.');
  const result = (await kernel.invokeFunction('modulearn.workspace', [operation, ...args], {}))?.data?.['application/json'];
  if (result == null) throw Error('The Colab workspace did not return a response.');
  return result;
}

function encodeColabChunk(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

// This shadows fetch only inside the embedded application. No public tunnel,
// cross-origin model access, API token, or model service is exposed to the tab.
async function fetch(path, options) {
  const url = new URL(path, 'http://127.0.0.1:3000/');
  if (url.origin !== 'http://127.0.0.1:3000') throw Error('Only the ModuLearn workspace can be requested.');
  const request = new Request(url, options);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
  const transferId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  try {
    if (body?.length) {
      for (let i = 0; i < body.length; i += colabChunkSize) await callColab('append', transferId, encodeColabChunk(body.subarray(i, i + colabChunkSize)), i === 0);
    }
    const result = await callColab('request', transferId, request.method, url.pathname + url.search, request.headers.get('Content-Type'), Boolean(body?.length));
    const bytes = new Uint8Array(result.length);
    bytes.set(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)));
    for (let i = colabChunkSize; i < bytes.length; i += colabChunkSize) {
      const chunk = await callColab('read', transferId, i);
      bytes.set(Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0)), i);
    }
    return new Response(bytes.length ? bytes : null, { status: result.status, headers: result.type ? { 'Content-Type': result.type } : {} });
  } finally {
    try { await callColab('release', transferId); } catch { /* A disconnected runtime cannot release its old slot. */ }
  }
}

"""Private Colab-to-browser relay for the existing Node website (stdlib only)."""
import base64
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

CHUNK_SIZE = 256 * 1024
MAX_BODY = 1_000_000
MAX_RESPONSE = 2_000_000
ROUTES = {'/api/status': 'GET', '/api/course': 'GET', '/api/source': 'GET',
          '/api/curriculum': 'POST', '/api/module': 'POST', '/api/question': 'POST',
          '/api/assess': 'POST', '/api/teach': 'POST'}


class WorkspacePreview:
    def __init__(self):
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.transfers = {}

    def _slot(self, transfer_id):
        if not isinstance(transfer_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{12,80}', transfer_id):
            raise ValueError('Invalid workspace request ID.')
        expired = [key for key, value in self.transfers.items() if time.monotonic() - value['updated'] > 3600]
        for key in expired:
            del self.transfers[key]
        if transfer_id not in self.transfers:
            if len(self.transfers) >= 8:
                raise ValueError('Too many pending workspace requests. Reopen the notebook preview.')
            self.transfers[transfer_id] = {'incoming': bytearray(), 'outgoing': b'', 'updated': time.monotonic()}
        self.transfers[transfer_id]['updated'] = time.monotonic()
        return self.transfers[transfer_id]

    def append_body(self, transfer_id, data, first):
        slot = self._slot(transfer_id)
        if first:
            slot['incoming'].clear()
        if not isinstance(data, str) or len(data) > 4 * ((CHUNK_SIZE + 2) // 3):
            raise ValueError('Upload chunk exceeds the transfer limit.')
        chunk = base64.b64decode(data, validate=True)
        if len(chunk) > CHUNK_SIZE or len(slot['incoming']) + len(chunk) > MAX_BODY:
            slot['incoming'].clear()
            raise ValueError('The workspace request exceeds the size limit.')
        slot['incoming'].extend(chunk)
        return {}

    def request(self, transfer_id, method, path, content_type, has_body):
        parts = urllib.parse.urlsplit(path)
        if parts.scheme or parts.netloc or parts.fragment or ROUTES.get(parts.path) != method:
            raise ValueError('Only the expected ModuLearn API route and method are allowed.')
        query = urllib.parse.parse_qs(parts.query, strict_parsing=True)
        if parts.path == '/api/source':
            if set(query) != {'id'} or len(query['id']) != 1 or not re.fullmatch(r'W\d{2}-P\d{3}', query['id'][0]):
                raise ValueError('Select a valid lecture page ID.')
        elif query:
            raise ValueError('This API route does not accept query parameters.')
        slot = self._slot(transfer_id)
        body = bytes(slot['incoming']) if has_body else None
        slot['incoming'].clear()
        if method == 'GET' and has_body:
            raise ValueError('GET requests cannot carry an answer body.')
        headers = {'Content-Type': 'application/json'} if body else {}
        if body and (not isinstance(content_type, str) or not content_type.lower().startswith('application/json')):
            raise ValueError('Submit answers as JSON.')
        request = urllib.request.Request('http://127.0.0.1:3000' + path, data=body, method=method, headers=headers)
        try:
            try:
                response = self.client.open(request, timeout=2450)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                output = response.read(MAX_RESPONSE + 1)
                if len(output) > MAX_RESPONSE:
                    raise ValueError('The workspace response exceeds the size limit.')
                slot['outgoing'] = output
                status, mime = response.code, response.headers.get('Content-Type', 'application/json')
        except (urllib.error.URLError, TimeoutError):
            slot['outgoing'] = json.dumps({'error': 'The Colab website service stopped or timed out. Check the Start ModuLearn cell; your browser draft is preserved.'}).encode()
            status, mime = 503, 'application/json'
        slot['updated'] = time.monotonic()
        return {'status': status, 'type': mime, 'length': len(slot['outgoing']), **self.response_chunk(transfer_id, 0)}

    def response_chunk(self, transfer_id, start):
        slot = self._slot(transfer_id)
        if not isinstance(start, int) or isinstance(start, bool) or not 0 <= start <= len(slot['outgoing']):
            raise ValueError('Invalid response chunk offset.')
        return {'data': base64.b64encode(slot['outgoing'][start:start + CHUNK_SIZE]).decode('ascii')}

    def release(self, transfer_id):
        self.transfers.pop(transfer_id, None)
        return {}


def preview_html(project):
    html = (project / 'index.html').read_text(encoding='utf-8')
    body = html.split('<body>', 1)[1].split('</body>', 1)[0]
    body = re.sub(r'<script\b[^>]*\bsrc=["\']app\.js["\'][^>]*>\s*</script>', '', body)
    css = (project / 'styles.css').read_text(encoding='utf-8')
    transport = (project / 'notebooks/colab_preview.js').read_text(encoding='utf-8')
    shared = re.sub(r'^export\s+', '', (project / 'course.js').read_text(encoding='utf-8'), flags=re.M)
    app = re.sub(r'^import[^\n]+from ["\']\./course\.js["\'];\r?\n', '', (project / 'app.js').read_text(encoding='utf-8'), flags=re.M)
    script = f'const colabChunkSize = {CHUNK_SIZE};\n' + transport + '\n' + shared + '\n' + app
    return '<style>' + css + '</style>' + body + '<script>(async () => {\n' + script + '\n})();</script>'


def launcher_html(project):
    page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ModuLearn</title></head><body>' + preview_html(project) + '</body></html>'
    encoded = json.dumps(page).replace('<', '\\u003c')
    return '''<button id="modulearn-open" type="button">Open ModuLearn in a new tab</button>
<p id="modulearn-status" role="status">Keep the Colab notebook and runtime connected.</p>
<script>(() => {
 const button = document.getElementById('modulearn-open');
 const status = document.getElementById('modulearn-status');
 let tab;
 button.addEventListener('click', () => {
  const kernel = window.google?.colab?.kernel;
  if (!kernel?.invokeFunction) { status.textContent = 'Connect the Colab runtime and rerun Open ModuLearn.'; return; }
  if (tab && !tab.closed) { tab.focus(); return; }
  tab = window.open('about:blank', '_blank');
  if (!tab) { status.textContent = 'Allow pop-ups for Colab, then click the button again. You can also select OPEN_IN_NOTEBOOK.'; return; }
  const channel = new MessageChannel();
  channel.port1.onmessage = async ({data: {id, operation, args}}) => {
   try {
    const reply = await kernel.invokeFunction('modulearn.workspace', [operation, ...args], {});
    const value = reply?.data?.['application/json'];
    if (value == null) throw Error('No workspace response. Check that Colab is connected.');
    channel.port1.postMessage({id, value});
   } catch (error) { channel.port1.postMessage({id, error: error?.message || String(error)}); }
  };
  tab.document.open(); tab.modulearnPort = channel.port2;
  tab.document.write(PAGE_JSON); tab.document.close();
  status.textContent = 'ModuLearn opened. Leave this notebook connected and export learning records before ending the runtime.';
 });
})();</script>'''.replace('PAGE_JSON', encoded)


def show_preview(project, in_notebook=False):
    from google.colab import output
    from IPython.display import HTML, JSON, display
    preview = WorkspacePreview()
    handlers = {'append': preview.append_body, 'request': preview.request,
                'read': preview.response_chunk, 'release': preview.release}

    def dispatch(operation, *args):
        if operation not in handlers:
            raise ValueError('Unknown workspace operation.')
        return JSON(handlers[operation](*args))

    output.register_callback('modulearn.workspace', dispatch)
    display(HTML(preview_html(project) if in_notebook else launcher_html(project)))

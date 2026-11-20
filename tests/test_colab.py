import ast
import base64
import io
import json
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from notebooks.colab_preview import CHUNK_SIZE, MAX_BODY, WorkspacePreview, launcher_html, preview_html
from notebooks.colab_runtime import ColabRuntime

ROOT = Path(__file__).resolve().parents[1]


class Response(io.BytesIO):
    def __init__(self, data, code=200):
        super().__init__(data)
        self.code = code
        self.headers = {'Content-Type': 'application/json'}


class PreviewTests(unittest.TestCase):
    def test_notebook_is_valid_python_without_outputs_or_secrets(self):
        notebook = json.loads((ROOT / 'notebooks/modulearn-colab.ipynb').read_text(encoding='utf-8'))
        self.assertEqual(notebook['nbformat'], 4)
        identifiers = [c['id'] for c in notebook['cells']]
        self.assertEqual(len(set(identifiers)), len(identifiers))
        for cell in notebook['cells']:
            if cell['cell_type'] == 'code':
                ast.parse(cell['source'], filename=cell['id'])
                self.assertEqual(cell['outputs'], [])
                self.assertIsNone(cell['execution_count'])
        text = json.dumps(notebook)
        self.assertIn('ModuLearn-demo.git', text)
        self.assertIn('google/gemma-4-E2B-it', text)
        self.assertNotIn('C:\\Users', text)
        for file in (ROOT / 'notebooks').glob('*.py'):
            ast.parse(file.read_text(encoding='utf-8'), filename=str(file))

    def test_interleaved_transfers_keep_answers_and_responses_separate(self):
        relay = WorkspacePreview()
        a, b = 'request_A_123456', 'request_B_123456'
        one = json.dumps({'answer': 'alpha' * 60000}).encode()
        two = json.dumps({'answer': 'beta'}).encode()
        relay.append_body(a, base64.b64encode(one[:CHUNK_SIZE]).decode(), True)
        relay.append_body(b, base64.b64encode(two).decode(), True)
        relay.append_body(a, base64.b64encode(one[CHUNK_SIZE:]).decode(), False)
        seen = []

        def respond(request, **_):
            seen.append((request.full_url, request.data))
            return Response(request.data)

        relay.client.open = respond
        first = relay.request(a, 'POST', '/api/assess', 'application/json', True)
        second = relay.request(b, 'POST', '/api/assess', 'application/json', True)
        restored = base64.b64decode(first['data']) + base64.b64decode(relay.response_chunk(a, CHUNK_SIZE)['data'])
        self.assertEqual(restored, one)
        self.assertEqual(base64.b64decode(second['data']), two)
        self.assertEqual(seen[0][1], one)
        self.assertEqual(seen[1][1], two)
        relay.release(a)
        self.assertNotIn(a, relay.transfers)
        self.assertIn(b, relay.transfers)

    def test_only_explicit_node_api_routes_and_source_queries_are_forwarded(self):
        relay = WorkspacePreview()
        for method, path in [('GET', 'https://example.com/api/course'), ('GET', '//example.com/api/course'),
                             ('GET', '/v1/chat/completions'), ('POST', '/api/status'),
                             ('GET', '/api/source?id=../secret'), ('GET', '/api/source?id=W01-P001&x=1'),
                             ('GET', '/api/course?url=https://example.com')]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                relay.request('request_A_123456', method, path, None, False)
        urls = []
        relay.client.open = lambda request, **_: (urls.append(request.full_url) or Response(b'{}'))
        self.assertEqual(relay.request('request_A_123456', 'GET', '/api/source?id=W01-P001', None, False)['status'], 200)
        self.assertEqual(urls, ['http://127.0.0.1:3000/api/source?id=W01-P001'])

    def test_request_limits_and_invalid_offsets_fail_without_forwarding(self):
        relay = WorkspacePreview()
        identifier = 'request_A_123456'
        chunk = base64.b64encode(b'x' * CHUNK_SIZE).decode()
        relay.append_body(identifier, chunk, True)
        relay.append_body(identifier, chunk, False)
        relay.append_body(identifier, chunk, False)
        with self.assertRaises(ValueError):
            relay.append_body(identifier, chunk, False)
        self.assertEqual(len(relay.transfers[identifier]['incoming']), 0)
        self.assertLess(MAX_BODY, CHUNK_SIZE * 4)
        with self.assertRaises(ValueError):
            relay.response_chunk(identifier, -1)

    def test_backend_errors_and_runtime_disconnect_are_visible_to_the_app(self):
        relay = WorkspacePreview()

        def limited(*_, **__):
            raise urllib.error.HTTPError('http://127.0.0.1:3000/api/course', 429, 'limited', {'Content-Type': 'application/json'}, io.BytesIO(b'{"error":"quota"}'))

        relay.client.open = limited
        result = relay.request('request_A_123456', 'GET', '/api/course', None, False)
        self.assertEqual(result['status'], 429)
        self.assertEqual(json.loads(base64.b64decode(result['data']))['error'], 'quota')
        relay.client.open = lambda *_, **__: (_ for _ in ()).throw(urllib.error.URLError('offline'))
        result = relay.request('request_B_123456', 'GET', '/api/status', None, False)
        self.assertEqual(result['status'], 503)
        self.assertIn('draft is preserved', json.loads(base64.b64decode(result['data']))['error'])

    def test_embedded_app_and_launcher_have_valid_javascript_without_module_imports(self):
        import re
        node = shutil.which('node')
        if not node:
            self.skipTest('Node is not on PATH')
        for renderer in [preview_html, launcher_html]:
            html = renderer(ROOT)
            self.assertNotIn('MODEL_SERVICE_TOKEN', html)
            self.assertNotIn("from './course.js'", html)
            scripts = re.findall(r'<script>([\s\S]*?)</script>', html)
            self.assertEqual(len(scripts), 1)
            result = subprocess.run([node, '--check'], input=scripts[0], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_hosted_runtime_requires_endpoint_and_starts_node_without_loading_weights(self):
        with tempfile.TemporaryDirectory() as directory, patch('notebooks.colab_runtime.ensure_node', return_value='/usr/bin/node'):
            runtime = ColabRuntime(ROOT, Path(directory))
            captures = []
            runtime._start = lambda command, port, path, env, name, timeout: (captures.append((command, dict(env))) or {'configured': True})
            with self.assertRaises(ValueError):
                runtime.start('hosted', hosted_url='', hosted_key='FAKE')
            runtime.start('hosted', hosted_url='https://provider.invalid/v1', hosted_key='FAKE')
            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0][0][-1], 'server.mjs')
            self.assertEqual(captures[0][1]['LLM_TIMEOUT_SECONDS'], '1200')
            self.assertEqual(captures[0][1]['LLM_API_KEY'], 'FAKE')
            self.assertFalse(any('gemma_service' in part for part in captures[0][0]))

    def test_gpu_inference_check_requires_the_correct_model_and_complete_json(self):
        with tempfile.TemporaryDirectory() as directory, patch('notebooks.colab_runtime.ensure_node', return_value='/usr/bin/node'):
            runtime = ColabRuntime(ROOT, Path(directory))
            model = 'google/gemma-4-E2B-it'
            result = {'model': model, 'choices': [{'finish_reason': 'stop', 'message': {'content': '{"ready": true}'}}]}

            class Client:
                def open(self, request, **_):
                    assert request.full_url == 'http://127.0.0.1:8100/v1/chat/completions'
                    assert request.headers['Authorization'] == 'Bearer FAKE'
                    return Response(json.dumps(result).encode())

            with patch('notebooks.colab_runtime.urllib.request.build_opener', return_value=Client()):
                runtime._check_gpu_generation('FAKE', model)
                result['choices'][0]['finish_reason'] = 'length'
                with self.assertRaises(RuntimeError):
                    runtime._check_gpu_generation('FAKE', model)

    def test_gpu_http_failure_reports_service_traceback_instead_of_hiding_it(self):
        with tempfile.TemporaryDirectory() as directory, patch('notebooks.colab_runtime.ensure_node', return_value='/usr/bin/node'):
            runtime = ColabRuntime(ROOT, Path(directory))
            (Path(directory) / 'gemma-model.log').write_text(
                'per_layer_model_projection\nAssertionError: quant_state absent\nBearer FAKE\n', encoding='utf-8')
            client = unittest.mock.Mock()
            client.open.side_effect = urllib.error.HTTPError(
                'http://127.0.0.1:8100/v1/chat/completions', 500, 'error', {}, io.BytesIO(b'Internal Server Error'))
            with patch('notebooks.colab_runtime.urllib.request.build_opener', return_value=client):
                with self.assertRaises(RuntimeError) as error:
                    runtime._check_gpu_generation('FAKE', 'google/gemma-4-E2B-it')
                self.assertIn('HTTP 500', str(error.exception))
                self.assertIn('per_layer_model_projection', str(error.exception))
                self.assertIn('AssertionError', str(error.exception))
                self.assertNotIn('FAKE', str(error.exception))



if __name__ == '__main__':
    unittest.main()

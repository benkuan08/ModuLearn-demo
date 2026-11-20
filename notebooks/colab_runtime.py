"""Colab process setup, with no model or third-party imports on import."""
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path


def local_json(url, timeout=3):
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open(url, timeout=timeout) as response:
        return json.load(response)


def ensure_node(workspace):
    candidate = shutil.which('node')
    if candidate:
        version = subprocess.check_output([candidate, '--version'], text=True).strip()
        if int(version.lstrip('v').split('.')[0]) >= 22:
            return candidate
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    if not arch or sys.platform != 'linux':
        raise RuntimeError('Automatic Node setup is for Linux Colab runtimes. Install Node 22+ on other systems.')
    base = 'https://nodejs.org/dist/latest-v22.x/'
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60) as response:
        checksums = response.read().decode('utf-8')
    match = re.search(r'^([a-f0-9]{64})\s+(node-v22\.[0-9.]+-linux-' + arch + r'\.tar\.xz)$', checksums, re.M)
    if not match:
        raise RuntimeError('Could not find the official Node 22 Linux release checksum.')
    expected, name = match.groups()
    archive = workspace / name
    digest = hashlib.sha256()
    with urllib.request.urlopen(base + name, timeout=120) as response, archive.open('wb') as stream:
        for chunk in iter(lambda: response.read(1024 * 1024), b''):
            digest.update(chunk)
            stream.write(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError('Node archive checksum mismatch; nothing was executed.')
    destination = workspace / 'node'
    destination.mkdir(exist_ok=True)
    with tarfile.open(archive) as package:
        package.extractall(destination, filter='data')
    return str(destination / name.removesuffix('.tar.xz') / 'bin/node')


class ColabRuntime:
    def __init__(self, project, workspace):
        self.project, self.workspace = Path(project).resolve(), Path(workspace).resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.services = []
        self.node = ensure_node(self.workspace)
        self.python = str(self.workspace / 'venv/bin/python')

    def install(self, mode):
        subprocess.run([self.node, '--check', 'server.mjs'], cwd=self.project, check=True)
        subprocess.run([self.node, '--test', *[str(p) for p in sorted((self.project / 'tests').glob('*.test.mjs'))]], cwd=self.project, check=True)
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_colab.py'], cwd=self.project, check=True)
        if mode == 'hosted':
            print('The website is ready. Hosted mode does not install or download a model.')
            return
        if mode != 'colab_gpu':
            raise ValueError('Choose colab_gpu or hosted mode.')
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError('Select a Colab GPU runtime first, or choose hosted mode.')
        name = torch.cuda.get_device_name(0)
        total = torch.cuda.get_device_properties(0).total_memory / 2**30
        print(f'Colab GPU: {name}, {total:.1f} GiB total memory.')
        if total < 12:
            raise RuntimeError('Select a T4 GPU runtime or choose hosted mode. This launcher uses CUDA, not TPU.')
        if not Path(self.python).is_file():
            subprocess.run([sys.executable, '-m', 'venv', '--system-site-packages', '--without-pip', str(self.workspace / 'venv')], check=True)
        subprocess.run([sys.executable, '-m', 'pip', '--python', self.python, 'install', '--no-input', '-r', str(self.project / 'notebooks/requirements-colab.txt')], check=True)
        subprocess.run([self.python, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_model_service.py'], cwd=self.project, check=True)
        print('GPU service dependencies installed. The model loads in the next cell.')

    def _start(self, command, port, ready_path, env, name, timeout):
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                raise RuntimeError(f'Port {port} is occupied. Stop the earlier runtime service before restarting.')
        logfile = self.workspace / (name + '.log')
        with logfile.open('w', encoding='utf-8') as stream:
            process = subprocess.Popen(command, cwd=self.project, env=env, stdout=stream, stderr=subprocess.STDOUT)
        self.services.append(process)
        deadline = time.monotonic() + timeout
        while process.poll() is None and time.monotonic() < deadline:
            try:
                result = local_json(f'http://127.0.0.1:{port}{ready_path}')
                print(name + ' is ready.')
                return result
            except (OSError, ValueError):
                time.sleep(1)
        details = '\n'.join(logfile.read_text(encoding='utf-8', errors='replace').splitlines()[-20:])
        raise RuntimeError(f'{name} failed to start. See {logfile}.\n{details}')

    def _check_gpu_generation(self, secret, model_id):
        payload = {'model': model_id, 'messages': [{'role': 'user', 'content': 'Return exactly this JSON object and nothing else: {"ready": true}'}],
                   'max_tokens': 128, 'stream': False, 'temperature': 0}
        request = urllib.request.Request('http://127.0.0.1:8100/v1/chat/completions',
            data=json.dumps(payload).encode(), method='POST', headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret})
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with client.open(request, timeout=180) as response:
            result = json.load(response)
        choice = result.get('choices', [{}])[0]
        match = re.search(r'\{[^{}]*\}', choice.get('message', {}).get('content', ''))
        if result.get('model') != model_id or choice.get('finish_reason') != 'stop' or not match or json.loads(match.group()).get('ready') is not True:
            raise RuntimeError('The loaded model did not complete the short JSON inference check. Check its log before opening the tutor.')
        print('Gemma completed a short JSON inference check. Course assessment quality still needs review.')

    def start(self, mode, model_id='google/gemma-4-E2B-it', revision='main', quantization='nf4',
              context_tokens=16384, hosted_url='', hosted_key='', hf_token='', compact_context=True):
        self.stop()
        env = dict(os.environ, PATH=str(Path(self.node).parent) + os.pathsep + os.environ.get('PATH', ''),
                   PYTHONUNBUFFERED='1', TOKENIZERS_PARALLELISM='false', HF_HOME=str(self.workspace / 'huggingface'))
        if hf_token:
            env['HF_TOKEN'] = hf_token
        secret = secrets.token_hex(32)
        try:
            if mode == 'colab_gpu':
                if not Path(self.python).is_file():
                    raise RuntimeError('Run the dependency installation cell before starting the GPU service.')
                # Resolve and print the revision actually used, so reruns are auditable.
                resolver = 'from huggingface_hub import HfApi; import sys; print(HfApi().model_info(sys.argv[1], revision=sys.argv[2]).sha)'
                pinned = subprocess.check_output([self.python, '-c', resolver, model_id, revision], env=env, text=True).strip()
                if not re.fullmatch(r'[a-f0-9]{40,64}', pinned):
                    raise RuntimeError('Could not resolve the model revision.')
                env.update(MODEL_SERVICE_TOKEN=secret, MODEL_ID=model_id, MODEL_REVISION=pinned,
                           MODEL_QUANTIZATION=quantization, MAX_CONTEXT_TOKENS=str(context_tokens), LLM_MODEL_REVISION=pinned)
                print(f'Loading {model_id} at {pinned}. Weights download only into this Colab runtime.')
                self._start([self.python, '-m', 'uvicorn', 'notebooks.gemma_service:app', '--host', '127.0.0.1', '--port', '8100'],
                            8100, '/health', env, 'gemma-model', 1800)
                self._check_gpu_generation(secret, model_id)
                base_url, key = 'http://127.0.0.1:8100/v1', secret
            elif mode == 'hosted':
                if not re.match(r'^https?://', hosted_url) or not hosted_key:
                    raise ValueError('Hosted mode needs HOSTED_BASE_URL and the LLM_API_KEY Colab secret.')
                base_url, key = hosted_url.rstrip('/'), hosted_key
            else:
                raise ValueError('Choose colab_gpu or hosted mode.')
            env.update(LLM_PROVIDER='openai', LLM_MODEL=model_id, LLM_BASE_URL=base_url, LLM_API_KEY=key,
                       LLM_TIMEOUT_SECONDS='1200', LLM_MAX_TOKENS='4096', LLM_JSON_MODE='false', LLM_EXTRA_BODY='{"temperature":0}',
                       LLM_COMPACT_CONTEXT=str(compact_context).lower(), LLM_DIGEST_CACHE_DIR=str(self.workspace / 'source-digests'),
                       HOST='127.0.0.1', PORT='3000')
            status = self._start([self.node, 'server.mjs'], 3000, '/api/status', env, 'modulearn-web', 60)
            if not status.get('configured'):
                raise RuntimeError('The website did not pick up the model connection.')
            print('ModuLearn is ready. Run Open ModuLearn to launch the website.')
        except BaseException:
            self.stop()
            raise

    def stop(self):
        for process in reversed(self.services):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
        self.services.clear()

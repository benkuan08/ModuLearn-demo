"""Rebuild the checked-in Colab notebook with no stored outputs or credentials."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def cell(kind, identifier, source):
    item = {'cell_type': kind, 'id': identifier, 'metadata': {}, 'source': source.strip() + '\n'}
    if kind == 'code':
        item.update(execution_count=None, outputs=[])
    return item


cells = [
    cell('markdown', 'intro', '''
# ModuLearn on Google Colab

Whole syllabus → multiple competency modules → diagnostic assessment → personal teaching path → teaching and reassessment.

This notebook runs the same website as the GitHub project. Run the **first four code cells in order**, then click **Open ModuLearn in a new tab**. Keep the notebook and runtime connected.

**Default: Colab GPU.** In **Runtime → Change runtime type**, select **L4 or A100**. The launcher requires at least 20 GiB of GPU memory; T4 is not supported for this full-syllabus configuration. It loads `google/gemma-4-12B-it` with NF4 quantization on the remote GPU. The original checkpoint downloads into Colab, not onto your computer. Quantization reduces GPU weight memory, not the original download size or long-context cache. A100 gives more context headroom. This configuration has not been validated on a live GPU by the project author.

**Alternative: hosted inference.** Select `hosted`, enter your compatible endpoint, and add an **LLM_API_KEY** in Colab's Secrets panel. Enable notebook access for that secret. Hosted mode does not need a GPU or download weights. Use an endpoint that actually serves your chosen model.

No model/provider token is stored in this notebook or exposed to the website. The private preview uses Colab callbacks rather than a public tunnel. Export learning records before disconnecting or changing browser origins.
'''),
    cell('code', 'prepare', r'''
MODEL_MODE = 'colab_gpu'  #@param ["colab_gpu", "hosted"]
MODEL_ID = 'google/gemma-4-12B-it'  #@param {type:"string"}
MODEL_REVISION = 'main'  #@param {type:"string"}
QUANTIZATION = 'nf4'  #@param ["nf4", "bf16"]
MAX_CONTEXT_TOKENS = 131072  #@param {type:"integer"}
HOSTED_BASE_URL = ''  #@param {type:"string"}
USE_HF_SECRET = False  #@param {type:"boolean"}
BRANCH = 'main'  #@param {type:"string"}

import os
import runpy
import subprocess
from pathlib import Path

repository = 'https://github.com/benkuan08/ModuLearn-demo.git'
project = Path('/content/ModuLearn-demo')
if not Path('/content').is_dir():
    raise RuntimeError('Open this notebook in Google Colab. For a local run, follow README.md.')
if globals().get('modulearn_runtime'):
    modulearn_runtime.stop()
git_env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
if (project / '.git').is_dir():
    origin = subprocess.check_output(['git', '-C', str(project), 'remote', 'get-url', 'origin'], text=True).strip()
    if origin.removesuffix('.git') != repository.removesuffix('.git'):
        raise RuntimeError('The /content/ModuLearn-demo folder belongs to another repository. Choose a different project directory.')
    subprocess.run(['git', '-C', str(project), 'pull', '--ff-only', 'origin', BRANCH], env=git_env, check=True)
elif project.exists():
    raise RuntimeError('The project folder exists without Git metadata. Rename it in Colab before cloning; no files were deleted.')
else:
    subprocess.run(['git', 'clone', '--depth', '1', '--branch', BRANCH, repository, str(project)], env=git_env, check=True)
if not (project / 'notebooks/colab_runtime.py').is_file():
    raise RuntimeError('This GitHub branch does not contain the Colab helpers yet. Push the notebook update first.')
commit = subprocess.check_output(['git', '-C', str(project), 'rev-parse', '--short', 'HEAD'], text=True).strip()
runtime_helpers = runpy.run_path(str(project / 'notebooks/colab_runtime.py'))
modulearn_runtime = runtime_helpers['ColabRuntime'](project, Path('/content/modulearn-runtime'))
print(f'ModuLearn source ready at commit {commit}. Mode: {MODEL_MODE}.')
'''),
    cell('markdown', 'install-heading', '## 2. Install and check the runtime\n\nThis checks the website and installs the model service dependencies only in GPU mode. It keeps Colab\'s CUDA-enabled PyTorch.'),
    cell('code', 'install', 'modulearn_runtime.install(MODEL_MODE)'),
    cell('markdown', 'start-heading', '''
## 3. Start ModuLearn

GPU mode resolves and prints the exact model revision, downloads/loads the checkpoint, then starts the Node website. The first run can take several minutes. Hosted mode reads `LLM_API_KEY` from Colab Secrets instead.

The website remains unavailable until its chosen model service is ready. If GPU loading fails, check the cell's message and log under `/content/modulearn-runtime`; it does not silently switch models or create a fake grade. Whole-course generation can be slow on a small GPU. Requests use a longer notebook timeout and never truncate source text to fit a context limit.
'''),
    cell('code', 'start', r'''
def colab_secret(name):
    from google.colab import userdata
    try:
        value = userdata.get(name)
    except Exception:
        raise RuntimeError(f'Add {name} in Colab Secrets and enable notebook access, then rerun this cell.') from None
    if not value:
        raise RuntimeError(f'The {name} secret is empty.')
    return value

hosted_key = colab_secret('LLM_API_KEY') if MODEL_MODE == 'hosted' else ''
hf_token = colab_secret('HF_TOKEN') if USE_HF_SECRET else ''
modulearn_runtime.start(MODEL_MODE, model_id=MODEL_ID, revision=MODEL_REVISION,
    quantization=QUANTIZATION, context_tokens=MAX_CONTEXT_TOKENS,
    hosted_url=HOSTED_BASE_URL, hosted_key=hosted_key, hf_token=hf_token)
hosted_key = hf_token = ''
'''),
    cell('markdown', 'open-heading', '''
## 4. Open ModuLearn

Run this cell, then click **Open ModuLearn in a new tab**. Allow Colab pop-ups if prompted. If the browser-tab route is unavailable, select `OPEN_IN_NOTEBOOK` and rerun this cell to use the same app inside this notebook.

Use **Organize the whole syllabus into modules**, review the proposal, then complete the course diagnostic. Your teaching path retains untested modules and updates after teaching and new assessments. Keep Colab connected while using it.
'''),
    cell('code', 'open', r'''
OPEN_IN_NOTEBOOK = False  #@param {type:"boolean"}

status = runtime_helpers['local_json']('http://127.0.0.1:3000/api/status', timeout=10)
if not status.get('configured'):
    raise RuntimeError('The model connection is not configured. Rerun Start ModuLearn first.')
preview = runpy.run_path(str(project / 'notebooks/colab_preview.py'))
preview['show_preview'](project, in_notebook=OPEN_IN_NOTEBOOK)
'''),
    cell('markdown', 'stop-heading', '## Optional: stop the services\n\nExport your learning records in the website first. Stopping releases the model GPU process and website server. This cell does nothing during Run all unless you select the checkbox.'),
    cell('code', 'stop', r'''
STOP_MODULEARN = False  #@param {type:"boolean"}
if STOP_MODULEARN:
    modulearn_runtime.stop()
    print('ModuLearn services stopped.')
'''),
]

notebook = {'nbformat': 4, 'nbformat_minor': 5, 'metadata': {
    'accelerator': 'GPU', 'colab': {'provenance': [], 'name': 'ModuLearn on Google Colab'},
    'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'},
    'language_info': {'name': 'python'}}, 'cells': cells}
target = ROOT / 'notebooks/modulearn-colab.ipynb'
target.write_text(json.dumps(notebook, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(target)

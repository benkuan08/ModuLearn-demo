# ModuLearn adaptive tutor

[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/benkuan08/ModuLearn-demo/blob/main/notebooks/modulearn-colab.ipynb)

ModuLearn follows the presentation's whole-course logic using the existing GPT-6-Astra KG and all 11 selected COMP4431 PDFs (435 pages): **whole syllabus → multiple competency modules and criteria → course-wide diagnostic → learner profile → personalized teaching path → teaching and reassessment**. There is no fixed A* walkthrough or topic-selection requirement.

The course proposal must assign every extracted source page and all 70 KG concepts to modules. Each module's criteria are then prepared from all its assigned pages before the diagnostic begins. These checks establish structural coverage; a reviewer still needs to check that the objectives and criteria faithfully cover the syllabus, including topics not present as separate KG nodes. Title and administrative pages provide context rather than skills to assess.

## Model choice and current availability

The default target is **`google/gemma-4-12B-it`**, the instruction-tuned chat variant of the linked [`google/gemma-4-12B`](https://huggingface.co/google/gemma-4-12B) base model. The website talks to an OpenAI-compatible model endpoint. That can be the private Gemma service started on a Colab GPU by the notebook, or an external hosted provider. Neither route downloads model weights to your computer.

**A model repository is not a hosted API.** As checked on 19 November 2026, [Google's Hugging Face page](https://huggingface.co/google/gemma-4-12B-it) lists no Inference Provider for this exact checkpoint. No working public serverless endpoint for it has been verified for this project. Set `LLM_BASE_URL` to a provider or managed deployment that actually serves it, and supply that provider's token. The app will not silently substitute another Gemma model. Creating a dedicated cloud deployment may have hosting charges; none has been created by this project.

If you choose an already-hosted alternative, change only the model, endpoint and token. For example, [Hugging Face Inference Providers](https://huggingface.co/inference/models?model=Qwen%2FQwen3.5-9B) lists Qwen3.5-9B; the compatible base URL is `https://router.huggingface.co/v1` with a token that has Inference Providers permission. Recheck its current availability in the provider catalog.

The included Colab notebook follows EconSpec/EconReview's remote-GPU and browser-launch pattern, using Gemma instead of its economics Qwen checkpoint/adapter. ModuLearn reuses the rubric, exact-evidence, validation, targeted-probe and recheck pattern without importing the economics adapter.

## Run in Google Colab

Open [`notebooks/modulearn-colab.ipynb`](notebooks/modulearn-colab.ipynb), or click **Open in Colab** above. The first cell clones or fast-forwards the public `benkuan08/ModuLearn-demo` repository. Run the first four code cells in order:

1. **Prepare:** choose `colab_gpu` (default) or `hosted`; clone/update the source and find or install Node 22+. Downloaded Node releases are checked against the official SHA-256 manifest.
2. **Install:** run the website and notebook checks. GPU mode installs its model dependencies in a Colab virtual environment while retaining Colab's CUDA PyTorch.
3. **Start:** GPU mode resolves the exact Gemma revision, loads `google/gemma-4-12B-it` with NF4 quantization, then starts the private model service and website. Hosted mode starts only the website and uses the `LLM_API_KEY` Colab Secret and your `HOSTED_BASE_URL`.
4. **Open:** click **Open ModuLearn in a new tab**. If the pop-up route is unavailable, select `OPEN_IN_NOTEBOOK` and rerun that cell.

For GPU mode, choose **L4 or A100** in Runtime settings. This launcher requires at least 20 GiB VRAM and does not support T4 for its full-syllabus context configuration. NF4 reduces the weight footprint, but the original checkpoint still downloads into Colab and long-context caches still need memory. An A100 provides more headroom if the L4 runs out of memory. The notebook/model service has not yet been run on a live Colab GPU in this development environment.

Hosted mode needs no GPU or model download. Put its token in Colab **Secrets**, not in a code cell. Public model downloads normally do not need a token; if access requires one, add `HF_TOKEN` to Secrets and select `USE_HF_SECRET`.

The web interface is embedded from the same HTML, CSS and JavaScript as the normal site. Its fetch calls go through a private, route-limited Colab callback relay. Request IDs isolate concurrent uploads and responses; no public tunnel or model credential is exposed to the browser. Keep the runtime connected, export learning records before ending it, and use the optional Stop cell to terminate both owned services. Stopping and rerunning is supported without killing unrelated runtime processes. The notebook contains no saved outputs or credentials.

## Run on your computer

Use Node.js 22 or newer. No npm packages are needed.

```powershell
Copy-Item .env.example .env
```

Edit `.env` to set `LLM_BASE_URL`, `LLM_API_KEY` and the exact `LLM_MODEL` your provider serves. Keep the token on the server. Then run:

```powershell
npm run check:model
npm run start:env
```

Open [ModuLearn](http://127.0.0.1:3000). `check:model` checks the provider's `/models` catalog; it does not send a generation request or prove teaching quality. A provider without that catalog can still work if its documented model ID and chat endpoint are correct.

`npm start` uses existing environment variables rather than `.env`. Without a configured endpoint and key, the app still displays its course sources and saved records, but does not fabricate model responses or grades.

## GitHub and running in the browser

From a normal PowerShell terminal, run `./Publish-GitHub.ps1` in this directory to commit and push changes to the existing public `benkuan08/ModuLearn-demo` repository. It uses Git's normal Credential Manager authentication through `git push`; it does not read credentials into a pipeline or call GitHub's repository-creation API. It never force-pushes and verifies the remote commit. If needed, first run `git credential-manager github login` and complete Git's normal browser sign-in yourself. The target repository must already exist. Pass `-Repository another-name` to choose a different existing repository.

Alternatively, upload the contents of this directory to your chosen GitHub repository root, including `notebooks`, `.devcontainer`, `.github`, `sources.json`, `astra.json` and `.env.example`. Do not upload a real `.env` or token. GitHub is the source host; the Colab notebook provides the runnable demo.

For a temporary browser workspace, open **Code → Codespaces → Create codespace**. The included development container provides Node and forwards port 3000. In its terminal, copy `.env.example` to `.env`, enter the hosted model settings, then run `npm run start:env`. Open forwarded port 3000. Keep the port private for personal use. The model runs at the inference provider; Codespaces runs only this small website server. Codespaces is a development workspace and must remain running while you use the tutor.

For a persistent deployment, use the included Dockerfile on a container host, supply the same environment variables as host secrets, and expose port 3000. The server respects `HOST` and `PORT`. GitHub Actions runs syntax and behavioral tests on push. **GitHub Pages cannot run the Node backend or protect a model token.** No deployment has been made by this project.

## How to use the tutor

1. Set your teaching style, session length and any learning priorities. Priorities influence emphasis but do not remove syllabus material.
2. Use **Organize the whole syllabus into modules**. The model receives all 435 pages and the saved KG. It proposes multiple modules, then defines each module's outcomes, node mappings, mastery criteria and practice activities. Completed preparation is saved after each module, so a failed request can be resumed.
3. Review the complete module proposal, criteria and citations before adopting it. Proposed dependencies affect the personal path only if explicitly reviewed and selected; this does not certify instructor approval.
4. Complete the course diagnostic. Each module starts with a teach-back, then targeted follow-ups and new application tasks for outcomes with sufficient conceptual evidence. The controller advances to the next required module. It preserves all previous module records.
5. Inspect the course-wide profile and generated teaching path. Whole-module skips require evidence for every criterion; partial mastery skips only the relevant activities. Untested modules remain required. Pausing early shows a clearly labeled provisional path rather than treating untested work as mastered.
6. Choose **Teach me this** for a remaining activity. Teaching responds to the identified gap and your preferred format. Use **Check my understanding on a new question** to assess learning independently. The entire course path is updated without erasing other modules' evidence or earlier lessons.

Concept questioning is bounded to two baseline probes per criterion. Application gets an initial task and one focused follow-up. Unresolved skills then stay on the teaching plan. A post-teaching check uses a new example. The course path respects explicitly reviewed module dependencies, then packs remaining activities into sessions with concept work before application within each outcome. It is a deterministic prototype scheduler rather than the full GenMentor scheduler. Raw KG `uses`/`is_a` edges are never treated as instructor-approved prerequisites. Compulsory course obligations remain in the plan.

Learning records, drafts, module preparation, the diagnostic position and archived course plans persist in this browser's local storage. **New course plan** archives the current course and all module records rather than erasing them. Earlier single-module records can still be reviewed. Export records before clearing browser data, moving to a different site origin, or closing an ephemeral Codespaces URL. There is no account or server-side learner database.

## Source grounding and refresh

`astra.json` is the original Astra export. `sources.json` includes page text, original PDF filenames, page IDs and file hashes. Whole-course planning receives all extracted pages. Preparing a module's criteria receives all pages assigned to that module, with no 28-page cap. Grading and teaching receive the pages cited by the relevant criteria. The older single-module API retains lexical/KG retrieval for compatibility, but the main interface uses the whole-course pipeline. Click a citation to inspect the exact extracted page.

Text extraction can omit diagrams and damage mathematical notation. The tutor is instructed to avoid tasks depending on unavailable figures and to withhold ambiguous judgments. Module and rubric proposals still need review; the tests do not establish model grading accuracy.

To refresh changed notes, install `pypdf` in a Python environment and run:

```text
python scripts/import_notes.py "../New notes/selected_notes"
```

The importer is optional; the checked-in source text is sufficient for normal Node operation.

## Validation

```text
npm run build
npm test
python -m unittest discover -s tests -p test_colab.py -v
```

Tests use a mock model and cover whole-syllabus input, page and concept coverage, module preparation and resume, cross-module diagnostic transitions, untested-module retention, reviewed prerequisite ordering, evidence isolation, accumulated quotations, application-only evidence, teaching, reassessment, browser persistence and API failures. Hosted-model parsing allows fenced JSON and one schema-repair request, then withholds invalid results. Truncated output is rejected. Mapping validation rejects unsupported IDs and missing criteria. These checks do not establish semantic completeness or substitute for live grading against human-reviewed answers.

Notebook checks also validate all Python cells and helper syntax, the embedded application/launcher JavaScript, concurrent chunked transfers, route restrictions, failure propagation and hosted-mode setup. These CPU checks do not validate Gemma's GPU load, memory budget, response quality, or the live Colab browser session.

Optional provider controls: `LLM_MAX_TOKENS`, `LLM_TIMEOUT_SECONDS` (90 seconds normally, 1200 in Colab GPU/hosted notebook mode), `LLM_JSON_MODE=true` if supported, and a JSON object in `LLM_EXTRA_BODY` for documented provider-specific parameters. The app has no silent model fallback. To retain the older Gemini connection, set `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` and optionally `GEMINI_MODEL`; OpenAI-compatible inference is the default.

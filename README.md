# ModuLearn adaptive tutor

[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/benkuan08/ModuLearn-demo/blob/main/notebooks/modulearn-colab.ipynb)

ModuLearn follows the presentation's whole-course logic using the existing GPT-6-Astra KG and all 11 selected COMP4431 PDFs (435 pages): **whole syllabus → multiple competency modules and criteria → course-wide diagnostic → learner profile → personalized teaching path → teaching and reassessment**. There is no fixed A* walkthrough or topic-selection requirement.

The course proposal must assign every extracted source page and all 70 KG concepts to modules. Each module's criteria are then prepared from all its assigned pages (using planning summaries for large note sets in compact mode) before the diagnostic begins. These checks establish structural coverage; a reviewer still needs to check that the objectives and criteria faithfully cover the syllabus, including topics not present as separate KG nodes. Title and administrative pages provide context rather than skills to assess.

## Model and free T4 runtime

The default is **[`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it)**, loaded with **4-bit NF4** linear weights for a free Colab **T4 GPU**. The tutor uses extracted text, so the service uses the supported `Gemma4ForCausalLM` loader and tokenizer without allocating the checkpoint's vision/audio towers. On T4, non-quantized layers and NF4 computation use FP32; a GPU with native BF16 uses BF16 for those operations. The request cap is 16,384 tokens, including the reserved output. The live T4 load, speed and teaching quality have not been verified in this development environment.

E2B denotes effective model size. Its large embedding tables remain unquantized in this loader, so the entire model does not become 4-bit or fit into a claimed 2–3 GB budget. Startup checks a real short JSON generation before opening the tutor, and each request computes only the last-token logits to reduce memory. Source mapping and exact-quotation checks remain enforced, but they do not establish grading accuracy. Review proposals and grades against the original notes. There is no silent model substitution.

The text loader explicitly maps checkpoint keys from `model.language_model.*` to `model.*`. This is required when reading the multimodal checkpoint with `Gemma4ForCausalLM` in Transformers 5.23. Missing or mismatched text weights stop startup; the tutor cannot run on silently initialized replacement weights. Without the mapping, the missing quantized projection weights trigger the first-inference `Linear4bit` assertion. If startup inference fails, the notebook includes the service traceback in its error instead of hiding it behind HTTP 500.

Implementation references: [Hugging Face Gemma 4 text loader](https://huggingface.co/docs/transformers/model_doc/gemma4#transformers.Gemma4ForCausalLM) and [bitsandbytes hardware and NF4 configuration](https://huggingface.co/docs/transformers/quantization/bitsandbytes).

All 435 pages remain in the course pipeline. Compact mode reads them in 23 bounded batches, caches generated planning summaries for retries, and asks for a whole-course module proposal using those summaries and all 70 KG concepts. Batch assignments expand to original page IDs before the full coverage check. Large module note sets also use planning summaries; grading, teaching and follow-up questions receive the original pages cited in their criteria. Summary-based planning can miss details, so structural coverage still needs a semantic review. Compact planning proposes no prerequisites; it does not infer them from lecture order.

For this small-model demonstration, each new planning summary requests only 3–5 main topics in about 500 characters, with page IDs. An empty summary or one over the 1,200-character validation limit gets one automatic brief retry. Completed valid summaries from the earlier prompt remain cached. These notes provide a coarse overview for planning; the original pages remain available for criteria, grading and teaching.

## Run in Google Colab

Open [`notebooks/modulearn-colab.ipynb`](notebooks/modulearn-colab.ipynb), or click **Open in Colab** above.

1. In **Runtime → Change runtime type**, select **T4 GPU**. TPU v5e uses a different backend and is not supported by this CUDA runner. Free GPU availability and session length vary.
2. Upload the updated project contents to the repository root, including all notebook helpers. Open the updated notebook. `USE_HF_SECRET=False` allows the public checkpoint download without a token. If Hugging Face requests authentication or you want authenticated downloads, add a read token to Colab **Secrets** as `HF_TOKEN`, enable notebook access, and set `USE_HF_SECRET=True`. A paid inference subscription is not needed.
3. Run the first four code cells in order: prepare, install, start, open. Keep `MODEL_ID=google/gemma-4-E2B-it`, `QUANTIZATION=nf4`, `MAX_CONTEXT_TOKENS=16384`, and `COMPACT_CONTEXT=True` for the T4 configuration. The original model files download into Colab, not your computer.
4. Use the tutor inside the notebook. Organize the whole syllabus, review the modules, complete the diagnostic, then inspect the teaching path. First-time course preparation takes multiple model calls. Export learning records before ending the session.

The first cell clones or fast-forwards this public repository. Uploading only the notebook will not update the runtime: include `notebooks/gemma_service.py`, `notebooks/colab_runtime.py`, `notebooks/requirements-colab.txt`, both preview helpers, and the rest of the project. Installation preserves Colab's CUDA PyTorch and installs model dependencies into a virtual environment. Startup pins and prints the exact model revision, loads the model, checks a short JSON generation, then starts the local Node backend. It fails visibly if the model cannot load or the request exceeds its context. It never silently truncates notes or grants a fake grade. Completed source summaries are cached under `/content/modulearn-runtime/source-digests`; a new Colab VM loses that cache.

The same application is embedded inside the notebook, with a private, route-limited Colab callback relay. No public tunnel or model token is exposed to the browser. The optional separate-tab preview is still available, but [Colab's free-tier rules](https://research.google.com/colaboratory/faq.html) restrict bypassing the notebook UI to interact primarily through a web UI. Keep Colab as the active interactive workspace. This is not a permanent website deployment.

**Hosted alternative:** select `hosted`, set your explicit `HOSTED_BASE_URL` and `MODEL_ID`, disable `USE_HF_SECRET` if unnecessary, and add the provider token as `LLM_API_KEY` in Colab Secrets. Hosted mode needs no GPU or model download but may require provider credits. A Hugging Face model repository URL is a download page, not a hosted inference endpoint.

The optional Stop cell terminates only services started by this notebook. Stopping and rerunning is supported without killing unrelated processes. The notebook contains no saved outputs or credentials.

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
2. Use **Organize the whole syllabus into modules**. The pipeline reads all 435 pages and the saved KG, using bounded planning summaries in compact mode. It proposes multiple modules, then defines each module's outcomes, node mappings, mastery criteria and practice activities. Completed preparation is saved after each module, so a failed request can be resumed.
3. Review the complete module proposal, criteria and citations before adopting it. Proposed dependencies affect the personal path only if explicitly reviewed and selected; this does not certify instructor approval.
4. Complete the course diagnostic. Each module starts with a teach-back, then targeted follow-ups and new application tasks for outcomes with sufficient conceptual evidence. The controller advances to the next required module. It preserves all previous module records.
5. Inspect the course-wide profile and generated teaching path. Whole-module skips require evidence for every criterion; partial mastery skips only the relevant activities. Untested modules remain required. Pausing early shows a clearly labeled provisional path rather than treating untested work as mastered.
6. Choose **Teach me this** for a remaining activity. Teaching responds to the identified gap and your preferred format. Use **Check my understanding on a new question** to assess learning independently. The entire course path is updated without erasing other modules' evidence or earlier lessons.

Concept questioning is bounded to two baseline probes per criterion. Application gets an initial task and one focused follow-up. Unresolved skills then stay on the teaching plan. A post-teaching check uses a new example. The course path respects explicitly reviewed module dependencies, then packs remaining activities into sessions with concept work before application within each outcome. It is a deterministic prototype scheduler rather than the full GenMentor scheduler. Raw KG `uses`/`is_a` edges are never treated as instructor-approved prerequisites. Compulsory course obligations remain in the plan.

Learning records, drafts, module preparation, the diagnostic position and archived course plans persist in this browser's local storage. **New course plan** archives the current course and all module records rather than erasing them. Earlier single-module records can still be reviewed. Export records before clearing browser data, moving to a different site origin, or closing an ephemeral Codespaces URL. There is no account or server-side learner database.

## Source grounding and refresh

`astra.json` is the original Astra export. `sources.json` includes page text, original PDF filenames, page IDs and file hashes. Whole-course planning processes all extracted pages. Compact mode uses generated summaries of all pages for planning; turning it off sends the original full text and requires a larger context. Preparing criteria includes all assigned pages, directly or through their planning summaries, with no 28-page retrieval cap. Grading and teaching receive the pages cited by the relevant criteria. The older single-module API retains lexical/KG retrieval for compatibility, but the main interface uses the whole-course pipeline. Click a citation to inspect the exact extracted page.

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
# Optional service checks need FastAPI/Pydantic 2 (installed in Colab's model venv):
python -m unittest discover -s tests -p test_model_service.py -v
# Optional real-library integration check, with the GPU service dependencies installed:
python tests/check_nf4_loading.py -v
```

Tests use a mock model and cover bounded source batches, summary-cache reuse, page-ID expansion, whole-syllabus input, page and concept coverage, module preparation and resume, cross-module diagnostic transitions, untested-module retention, reviewed prerequisite ordering, evidence isolation, accumulated quotations, application-only evidence, teaching, reassessment, browser persistence and API failures. Hosted-model parsing allows fenced JSON and one schema-repair request, then withholds invalid results. Truncated output is rejected. Mapping validation rejects unsupported IDs and missing criteria. These checks do not establish semantic completeness or substitute for live grading against human-reviewed answers.

Notebook checks also validate all Python cells and helper syntax, the embedded application/launcher JavaScript, concurrent chunked transfers, route restrictions, failure propagation and hosted-mode setup. These CPU checks do not validate Gemma's GPU load, memory budget, response quality, or the live Colab browser session.

The optional NF4 integration check builds a tiny local Gemma checkpoint with multimodal weight names. It reproduces the unmapped first-projection assertion, then verifies that the corrected loader reads the saved embeddings, initializes quantization state for every 4-bit layer, and produces the same generated tokens as an equivalent text checkpoint. It runs on CPU without downloading Google weights; it does not measure T4 memory or teaching quality.

Optional provider controls: `LLM_COMPACT_CONTEXT=true`, `LLM_DIGEST_CACHE_DIR`, `LLM_MAX_TOKENS`, `LLM_TIMEOUT_SECONDS` (90 seconds normally, 1200 in Colab GPU/hosted notebook mode), `LLM_JSON_MODE=true` if supported, and a JSON object in `LLM_EXTRA_BODY` for documented provider-specific parameters. The app has no silent model fallback. To retain the older Gemini connection, set `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` and optionally `GEMINI_MODEL`; OpenAI-compatible inference is the default.

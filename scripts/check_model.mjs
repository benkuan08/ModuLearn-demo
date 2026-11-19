import { modelSettings } from '../model.mjs';
const config = modelSettings();
if (!config.key || !config.baseUrl) {
  console.error('Set LLM_API_KEY and LLM_BASE_URL in .env first. No model request was made.'); process.exitCode = 1;
} else {
  try {
    const response = await fetch(config.baseUrl + '/models', { headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error(`The provider model catalog returned HTTP ${response.status}. Check its endpoint and token.`);
    const catalog = await response.json();
    const found = (catalog.data ?? []).some(m => m.id === config.model);
    if (!found) throw Error(`The provider catalog did not list ${config.model}. Confirm the exact checkpoint in its dashboard or choose a provider that serves it. No fallback or generation was attempted.`);
    console.log(`The provider catalog lists ${config.model}. This checks availability, not tutoring or grading quality.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

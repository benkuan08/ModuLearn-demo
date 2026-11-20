import { problem } from './tutor.mjs';

export function parseObject(output) {
  if (typeof output !== 'string') throw Error('Missing model output');
  const clean = output.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const start = clean.indexOf('{');
  if (start < 0) throw Error('Missing JSON object');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(clean.slice(start, i + 1));
  }
  throw Error('Incomplete JSON object');
}

function jsonSchema(schema) {
  const result = { ...schema, type: schema.type.toLowerCase() };
  if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, jsonSchema(v)]));
  if (schema.items) result.items = jsonSchema(schema.items);
  return result;
}

function matches(value, schema) {
  const type = schema.type.toLowerCase();
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'integer' && !Number.isInteger(value)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === 'array') return Array.isArray(value) && value.every(v => matches(v, schema.items));
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value)
    && schema.required.every(k => Object.hasOwn(value, k)) && Object.entries(schema.properties).every(([k, s]) => matches(value[k], s));
  return true;
}

export function modelSettings(env = process.env) {
  return { provider: env.LLM_PROVIDER || 'openai', key: env.LLM_API_KEY?.trim() || env.DEEPINFRA_API_KEY?.trim() || env.HF_TOKEN?.trim() || env.OPENAI_API_KEY?.trim(),
    baseUrl: (env.LLM_BASE_URL || env.OPENAI_BASE_URL || '').trim().replace(/\/+$/, ''),
    model: env.LLM_MODEL || 'google/gemma-4-12B-it', maxTokens: Math.max(2048, Math.min(32768, Number(env.LLM_MAX_TOKENS) || 8192)),
    timeoutMs: Math.max(30, Math.min(1800, Number(env.LLM_TIMEOUT_SECONDS) || 90)) * 1000,
    jsonMode: env.LLM_JSON_MODE === 'true', extraBody: env.LLM_EXTRA_BODY ? JSON.parse(env.LLM_EXTRA_BODY) : {} };
}

// Hosted OpenAI-compatible inference. No model weights, Python, or GPU required.
export function hostedGenerator({ key, baseUrl, model, maxTokens = 8192, timeoutMs = 90000, jsonMode = false, extraBody = {}, fetchImpl = fetch }) {
  return async (instruction, input, schema) => {
    if (!key) throw problem(503, 'Set HF_TOKEN or LLM_API_KEY on the server to use the hosted tutor. No model download is required.');
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw problem(503, 'Set LLM_BASE_URL to an OpenAI-compatible provider that serves your selected checkpoint. A model repository URL is not an inference endpoint.');
    const messages = [{ role: 'system', content: instruction + '\nReturn exactly one JSON object matching this JSON Schema. No commentary, reasoning, or code fences:\n' + JSON.stringify(jsonSchema(schema)) },
      { role: 'user', content: JSON.stringify(input) }];
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(baseUrl + '/chat/completions', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ ...extraBody, model, messages, max_tokens: maxTokens, stream: false,
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }), signal: AbortSignal.timeout(timeoutMs) });
      } catch { throw problem(502, 'The hosted model did not respond. Your answer is preserved. Try again.'); }
      if (!response.ok) {
        const errors = { 400: 'The hosted provider rejected the request. Check the model name and optional LLM_EXTRA_BODY/LLM_JSON_MODE settings.',
          401: 'The model provider rejected the server token.', 402: 'The model provider requires available inference credits.',
          403: 'The server token cannot access this model. Check inference permissions.', 404: 'This model or endpoint is unavailable. Check LLM_MODEL and LLM_BASE_URL.',
          413: 'The model context budget is too small for this course request. Check the notebook or provider settings; no input was truncated.',
          429: 'The model provider is over its rate or quota limit. Try again shortly.',
          507: 'The Colab GPU ran out of memory for this context. Check its model log and select a GPU with more memory or a hosted endpoint.' };
        throw problem(response.status === 429 ? 429 : 502, errors[response.status] ?? 'The model provider is unavailable. Your work is preserved.');
      }
      let choice;
      try { choice = (await response.json()).choices?.[0]; }
      catch { throw problem(502, 'The provider returned an unreadable response. Retry when ready.'); }
      if (choice?.finish_reason !== 'stop' || !choice.message?.content) throw problem(502, 'The model did not finish its answer. Increase LLM_MAX_TOKENS or configure the provider’s supported non-thinking mode, then retry. No assessment was recorded.');
      try {
        const result = parseObject(choice.message.content);
        if (!matches(result, schema)) throw Error('Schema mismatch');
        return result;
      } catch {
        if (attempt) throw problem(502, 'The model returned invalid JSON twice. Your answer is preserved; no grade was granted.');
        messages.push({ role: 'assistant', content: choice.message.content }, { role: 'user', content: 'Repair the previous response to match the JSON schema exactly. Return the complete JSON object only. Do not change the supplied criterion IDs or invent learner evidence.' });
      }
    }
  };
}

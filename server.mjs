import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createTutor, problem } from './tutor.mjs';
import { hostedGenerator, modelSettings } from './model.mjs';
import { createSourceDigester } from './context.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']], ['/course.js', ['course.js', 'text/javascript']],
  ['/astra.json', ['astra.json', 'application/json']],
]);

export function geminiGenerator({ key, model = 'gemini-3.8-flash', fetchImpl = fetch }) {
  return async (instruction, input, schema) => {
    if (!key) throw problem(503, 'Set GEMINI_API_KEY on the server to start the adaptive tutor. Your saved work stays available.');
    let response;
    try {
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: instruction }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, maxOutputTokens: 8000,
            ...(model === 'gemini-3.8-flash' ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}) } }),
        signal: AbortSignal.timeout(75_000),
      });
    } catch { throw problem(502, 'Gemini did not respond. Your answer and evidence are preserved. Retry when ready.'); }
    if (!response.ok) {
      const messages = { 400: 'The model could not accept the request. Check GEMINI_MODEL.', 401: 'The API key was rejected.',
        403: 'This API key cannot access the configured model.', 404: 'The configured model is unavailable. Check GEMINI_MODEL.', 429: 'Gemini is over its quota or rate limit. Try again shortly.' };
      throw problem(response.status === 429 ? 429 : 502, messages[response.status] ?? 'Gemini is unavailable. Your work is preserved.');
    }
    try {
      const candidate = (await response.json()).candidates?.[0];
      const output = candidate?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('');
      if (candidate?.finishReason !== 'STOP' || !output) throw Error();
      return JSON.parse(output);
    } catch { throw problem(502, 'The model returned incomplete output. Retry without losing your work.'); }
  };
}

async function bodyOf(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw problem(413, 'This session is too large. Export it and start a new module.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch { throw problem(400, 'Send a JSON object.'); }
}

export function createHandler({ tutor, configured, model }) {
  const actions = new Map([['/api/curriculum', tutor.buildCurriculum], ['/api/module', tutor.buildModule], ['/api/question', tutor.makeQuestion], ['/api/assess', tutor.assess], ['/api/teach', tutor.teach]]);
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  return async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/api/status') return json(response, 200, { configured, model });
      if (request.method === 'GET' && url.pathname === '/api/course') return json(response, 200, tutor.courseInfo());
      if (request.method === 'GET' && url.pathname === '/api/source') {
        const page = tutor.getSource(url.searchParams.get('id'));
        return page ? json(response, 200, page) : json(response, 404, { error: 'Source page not found.' });
      }
      if (request.method === 'POST' && actions.has(url.pathname)) {
        if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: 'Send JSON.' });
        return json(response, 200, await actions.get(url.pathname)(await bodyOf(request)));
      }
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff' });
        return response.end(await readFile(new URL(name, import.meta.url)));
      }
      return json(response, 404, { error: 'Page not found.' });
    } catch (error) {
      return json(response, error.status ?? 500, { error: error.status ? error.message : 'The tutor could not complete this request. Your saved work is unchanged.' });
    }
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const graph = JSON.parse(await readFile(new URL('astra.json', import.meta.url), 'utf8'));
  const corpus = JSON.parse(await readFile(new URL('sources.json', import.meta.url), 'utf8'));
  const settings = modelSettings();
  const useGemini = settings.provider === 'gemini';
  const key = useGemini ? process.env.GEMINI_API_KEY?.trim() : settings.key;
  const model = useGemini ? process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash' : settings.model;
  const generate = useGemini ? geminiGenerator({ key, model }) : hostedGenerator(settings);
  const digester = settings.compactContext ? createSourceDigester({ generate, cacheDir: process.env.LLM_DIGEST_CACHE_DIR,
    model: model + '@' + (process.env.LLM_MODEL_REVISION || 'provider-default') }) : undefined;
  const tutor = createTutor({ graph, corpus, generate, digester });
  http.createServer(createHandler({ tutor, configured: Boolean(key && (useGemini || settings.baseUrl)), model }))
    .listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => console.log(`ModuLearn ready at http://127.0.0.1:${process.env.PORT ?? 3000}`));
}

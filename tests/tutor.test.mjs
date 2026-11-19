import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createTutor } from '../tutor.mjs';
import { profileOf, nextAssessment, studyPlan } from '../course.js';
import { hostedGenerator, parseObject, modelSettings } from '../model.mjs';
import { createHandler } from '../server.mjs';

const graph = JSON.parse(await readFile(new URL('../astra.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(await readFile(new URL('../sources.json', import.meta.url), 'utf8'));
const module = { id: 'sample', title: 'Explain and use a neuron', rationale: 'Connect a neuron to a calculation.', conceptIds: ['n24'],
  outcomes: [{ id: 'o1', description: 'Given weights and inputs, explain the neuron and calculate its output.' }],
  criteria: [
    { id: 'meaning', title: 'Weighted input and activation', type: 'concept', outcomeId: 'o1', conceptIds: ['n24'], sources: ['W08-P007'], standard: 'Explain weighted inputs, bias and an activation function.' },
    { id: 'compute', title: 'Calculate an output', type: 'application', outcomeId: 'o1', conceptIds: ['n24'], sources: ['W08-P007'], standard: 'Calculate a weighted sum with a bias, then correctly apply the given activation.' },
  ], activities: [
    { id: 'explain', title: 'Explain neuron components', criterionIds: ['meaning'], minutes: 5 },
    { id: 'calculate', title: 'Use a neuron in a new example', criterionIds: ['compute'], minutes: 7 },
    { id: 'combined', title: 'Connect explanation to calculation', criterionIds: ['meaning', 'compute'], minutes: 8 },
  ] };
const turn = (id, kind, answer, criterionIds = [kind === 'application' ? 'compute' : 'meaning']) => ({ id, kind, question: 'Explain or calculate as requested.', criterionIds, answer });
const grade = (id, responseId, quote, status = 'met') => ({ id, status, reason: 'Demonstrated in the response.', evidence: [{ responseId, quote }] });
const concept = { ...turn('t1', 'teachback', 'Multiply inputs by weights and add bias.'), judgments: [{ id: 'meaning', status: 'insufficient', reason: 'The activation is missing.', evidence: [] }] };
const followup = { ...turn('t2', 'probe', 'Apply the activation to that sum.'), judgments: [{ id: 'meaning', status: 'met', reason: 'The two responses jointly cover the criterion.', evidence: [{ responseId: 't1', quote: concept.answer }, { responseId: 't2', quote: 'Apply the activation' }] }] };

test('all 11 selected PDFs and 435 unique pages are available; every KG citation resolves', () => {
  assert.equal(corpus.lectures.length, 11); assert.equal(corpus.pages.length, 435);
  const ids = new Set(corpus.pages.map(p => p.id)); assert.equal(ids.size, 435);
  for (const e of graph.edges) assert.ok(ids.has(e.source_id));
});
test('combined teach-back and short follow-up authorize only the conceptual practice skip', () => {
  const plan = studyPlan(module, [concept, followup], 10);
  assert.equal(plan.profile.meaning.status, 'met'); assert.equal(plan.profile.meaning.evidence.length, 2);
  assert.deepEqual(plan.skipped.map(a => a.id), ['explain']);
  assert.equal(plan.complete, false); assert.ok(plan.sessions.every(s => s.minutes <= 10));
  assert.equal(nextAssessment(module, [concept, followup]).kind, 'application');
});
test('fabricated quotes, wrong phase and cross-criterion evidence cannot authorize skipping', () => {
  const bad = { ...turn('x', 'teachback', 'I understand everything.', ['meaning']), judgments: [grade('meaning', 'x', 'invented'), grade('compute', 'x', 'I understand')] };
  const profile = profileOf(module, [bad]);
  assert.equal(profile.meaning.status, 'insufficient'); assert.equal(profile.compute.status, 'insufficient');
  assert.equal(studyPlan(module, [bad]).skipped.length, 0);
});
test('new independent application evidence completes the outcome; teaching alone does not', () => {
  const h = [concept, followup]; assert.equal(studyPlan(module, h).complete, false);
  h.push({ ...turn('t3', 'application', 'The sum is 2*3+1=7 and ReLU(7)=7.'), judgments: [grade('compute', 't3', '2*3+1=7 and ReLU(7)=7')] });
  assert.equal(studyPlan(module, h).complete, true); assert.equal(studyPlan(module, h).remaining.length, 0);
});
test('concept probe budget ends in teaching plan and blocks dependent application', () => {
  const h = [concept, turn('p1', 'probe', 'Not sure.'), turn('p2', 'probe', 'Still not sure.')];
  assert.equal(nextAssessment(module, h).kind, 'plan');
});
test('failed application receives a targeted follow-up before moving to teaching', () => {
  const h = [concept, followup, turn('a1', 'application', 'I forgot the bias.')];
  assert.equal(nextAssessment(module, h).kind, 'application');
  h.push(turn('a2', 'application', 'Still unsure.')); assert.equal(nextAssessment(module, h).kind, 'plan');
});
test('source retrieval and module generation use the selected concepts and real note text', async () => {
  let received;
  const tutor = createTutor({ graph, corpus, generate: async (_, input) => { received = input; return structuredClone(module); } });
  const result = await tutor.buildModule({ conceptIds: ['n24'], preferences: { goal: 'Understand neurons and weighted sums' } });
  assert.equal(result.title, module.title); assert.deepEqual(received.selectedConceptIds, ['n24']);
  assert.ok(received.notes.some(p => p.id === 'W08-P007')); assert.ok(received.notes.some(p => p.text.length > 100));
  const invalid = structuredClone(module); invalid.criteria[0].conceptIds = ['n15'];
  assert.throws(() => tutor.validateModule(invalid));
});
test('grading receives BOTH answers and verifies multi-response quotations', async () => {
  let received;
  const tutor = createTutor({ graph, corpus, generate: async (_, input) => { received = input; return { judgments: followup.judgments }; } });
  const result = await tutor.assess({ module, history: [concept], turn: turn('t2', 'probe', followup.answer) });
  assert.deepEqual(received.responses.map(r => r.id), ['t1', 't2']); assert.equal(result.judgments[0].status, 'met');
});
test('server downgrades an invented passing quote and rejects duplicate submissions', async () => {
  const tutor = createTutor({ graph, corpus, generate: async () => ({ judgments: [grade('meaning', 't2', 'An invented quote')] }) });
  const result = await tutor.assess({ module, history: [concept], turn: turn('t2', 'probe', 'A partial answer') });
  assert.equal(result.judgments[0].status, 'insufficient');
  await assert.rejects(tutor.assess({ module, history: [concept], turn: concept }), /already recorded/);
});
test('teaching uses gaps and preferences, without modifying the learner profile', async () => {
  let received;
  const tutor = createTutor({ graph, corpus, generate: async (_, input) => { received = input; return { title: 'Complete the neuron explanation', sections: [{ heading: 'Weighted input', text: 'Example explanation.', sources: ['W08-P007'] }, { heading: 'Activation', text: 'Another explanation.', sources: ['W08-P007'] }] }; } });
  const before = JSON.stringify([concept]);
  const lesson = await tutor.teach({ module, history: [concept], activityId: 'explain', preferences: { format: 'questions', minutes: 20 } });
  assert.equal(received.preferences.format, 'questions'); assert.equal(received.criteria[0].id, 'meaning');
  assert.deepEqual(lesson.criterionIds, ['meaning']); assert.equal(JSON.stringify([concept]), before);
});
test('post-teaching application gets a fresh question with the complete task data', async () => {
  let received;
  const tutor = createTutor({ graph, corpus, generate: async (_, input) => { received = input; return { question: 'A neuron has input 4, weight 2, bias -1 and ReLU. Calculate and explain the output.', sources: ['W08-P007'] }; } });
  const q = await tutor.makeQuestion({ module, history: [concept, followup], mode: 'recheck', criterionIds: ['compute'] });
  assert.equal(q.kind, 'application'); assert.equal(q.afterTeaching, true); assert.equal(received.afterTeaching, true);
});
test('hosted model parses fenced JSON, requests one repair, and withholds incomplete output', async () => {
  const schema = { type: 'OBJECT', properties: { question: { type: 'STRING' } }, required: ['question'] };
  assert.deepEqual(parseObject('<think>ignore {thought}</think>\n```json\n{"question":"why {this}?"}\n```'), { question: 'why {this}?' });
  const requests = [];
  const generate = hostedGenerator({ key: 'FAKE', baseUrl: 'https://provider.invalid/v1', model: 'google/gemma-4-12B-it', fetchImpl: async (_, opts) => {
    requests.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: requests.length === 1 ? 'invalid' : '{"question":"Explain your reasoning"}' } }] }) };
  } });
  assert.equal((await generate('Ask', {}, schema)).question, 'Explain your reasoning'); assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'google/gemma-4-12B-it'); assert.ok(!Object.hasOwn(requests[0], 'response_format'));
  const incomplete = hostedGenerator({ key: 'FAKE', baseUrl: 'https://provider.invalid/v1', model: 'test', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"question":"partial"}' } }] }) }) });
  await assert.rejects(incomplete('Ask', {}, schema), /did not finish/);
  await assert.rejects(hostedGenerator({})('Ask', {}, schema), /No model download/);
  assert.equal(modelSettings({}).model, 'google/gemma-4-12B-it');
});
test('HTTP routes serve sources, reject malformed input, and keep tokens private', async () => {
  const tutor = createTutor({ graph, corpus, generate: hostedGenerator({}) });
  const handler = createHandler({ tutor, configured: false, model: 'google/gemma-4-12B-it' });
  async function request(url, method = 'GET', body = '', contentType = 'application/json') {
    const req = Readable.from(body ? [Buffer.from(body)] : []); Object.assign(req, { url, method, headers: { 'content-type': contentType } });
    let status, bytes; await handler(req, { writeHead(s) { status = s; }, end(b) { bytes = b; } }); return { status, body: JSON.parse(String(bytes)) };
  }
  assert.equal((await request('/api/course')).body.pageCount, 435);
  assert.equal((await request('/api/source?id=W08-P007')).body.id, 'W08-P007');
  assert.equal((await request('/api/source?id=INVALID')).status, 404);
  assert.equal((await request('/api/module', 'POST', 'bad')).status, 400);
  assert.equal((await request('/api/module', 'POST', '{}', 'text/plain')).status, 415);
  assert.equal((await request('/api/module', 'POST', JSON.stringify({ conceptIds: ['n24'] }))).status, 503);
  assert.deepEqual(Object.keys((await request('/api/status')).body).sort(), ['configured', 'model']);
});

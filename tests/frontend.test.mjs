import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as course from '../course.js';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const graph = JSON.parse(await readFile(new URL('../astra.json', import.meta.url), 'utf8'));
const m = { id: 'module1', title: 'Neuron understanding', rationale: 'Explain and use the neuron.', conceptIds: ['n24'],
  outcomes: [{ id: 'o1', description: 'Explain a neuron and calculate its output.' }],
  criteria: [{ id: 'concept', type: 'concept', title: 'Explain', outcomeId: 'o1', conceptIds: ['n24'], sources: ['W08-P007'], standard: 'Explain the weighted sum and activation.' },
    { id: 'apply', type: 'application', title: 'Calculate', outcomeId: 'o1', conceptIds: ['n24'], sources: ['W08-P007'], standard: 'Calculate and justify the output.' }],
  activities: [{ id: 'a1', title: 'Understand a neuron', criterionIds: ['concept'], minutes: 5 }, { id: 'a2', title: 'Calculate an output', criterionIds: ['apply'], minutes: 5 }] };

async function mount(storage = new Map(), route = async () => { throw Error('Simulated network failure'); }) {
  const elements = new Map(), events = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { toggle() {} }, focus() {} }); return elements.get(id); }, addEventListener(name, callback) { events.set(name, callback); } };
  const fetch = async (url, opts) => ({ ok: true, json: async () => url === 'api/course' ? { graph, lectures: [], pageCount: 435 } : url === 'api/status' ? { configured: true, model: 'google/gemma-4-12B-it' } : route(url, JSON.parse(opts.body)) });
  const localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const app = await new AsyncFunction('document', 'window', 'fetch', 'localStorage', 'course', `const {statuses,formats,profileOf,outcomeStatus,studyPlan,coursePlan}=course;\n${source}\nreturn {state,save,render,go,advance,build,teach,run,startNew,selectModule,wholePlan};`)(document, { scrollTo() {} }, fetch, localStorage, course);
  return { ...app, events, elements, storage };
}

test('frontend renders the real setup, persists drafts, and restores module history after reload', async () => {
  const app = await mount();
  assert.match(app.elements.get('main').innerHTML, /From the whole syllabus to your teaching path/);
  assert.doesNotMatch(app.elements.get('main').innerHTML, /Start example replay/);
  app.state.module = structuredClone(m); app.state.accepted = true; app.state.step = 2;
  app.state.current = { id: 'q1', kind: 'teachback', criterionIds: ['concept'], question: 'Teach a neuron to a beginner.' };
  app.state.draft = 'An unfinished explanation'; app.save();
  const restored = await mount(app.storage);
  assert.equal(restored.state.draft, 'An unfinished explanation'); assert.equal(restored.state.current.id, 'q1');
  assert.match(restored.elements.get('main').innerHTML, /An unfinished explanation/);
  restored.startNew(); assert.equal(restored.state.module, null); assert.equal(restored.state.archives[0].module.id, 'module1');
});

test('frontend preserves the draft when assessment fails, and commits a grade before a next-question failure', async () => {
  const app = await mount(); app.state.module = structuredClone(m); app.state.accepted = true; app.state.step = 2;
  app.state.current = { id: 'q1', kind: 'teachback', criterionIds: ['concept'], question: 'Explain a neuron.' }; app.state.draft = 'A weighted sum.';
  const submit = app.events.get('submit');
  submit({ target: { id: 'answer-form' }, preventDefault() {} });
  while (app.state.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.draft, 'A weighted sum.'); assert.equal(app.state.history.length, 0);
  const graded = await mount(new Map(), async url => {
    if (url === 'api/assess') return { judgments: [{ id: 'concept', status: 'insufficient', reason: 'Missing activation.', evidence: [] }] };
    throw Error('Next question failed');
  });
  Object.assign(graded.state, { module: structuredClone(m), accepted: true, step: 2, current: app.state.current, draft: 'A weighted sum.' });
  graded.events.get('submit')({ target: { id: 'answer-form' }, preventDefault() {} });
  while (graded.state.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(graded.state.history.length, 1); assert.equal(graded.state.current, null); assert.equal(graded.state.draft, '');
  const restored = await mount(graded.storage); assert.equal(restored.state.history.length, 1);
  assert.match(restored.elements.get('main').innerHTML, /Your latest response is saved/);
});

test('every completed frontend view renders evidence and teaching without injecting model HTML', async () => {
  const app = await mount();
  Object.assign(app.state, { module: structuredClone(m), accepted: true,
    history: [{ id: 'q1', kind: 'teachback', question: 'Explain.', criterionIds: ['concept'], answer: '<script>bad</script>', judgments: [{ id: 'concept', status: 'insufficient', reason: '<b>Not yet</b>', evidence: [] }] }],
    lesson: { title: 'Learn the neuron', sections: [{ heading: 'A component', text: '<script>unsafe</script>', sources: ['W08-P007'] }], criterionIds: ['concept'], activityId: 'a1' } });
  for (const step of [1, 2, 3, 4, 5]) { app.state.step = step; app.render(); assert.ok(app.elements.get('main').innerHTML.length > 100); assert.doesNotMatch(app.elements.get('main').innerHTML, /<script>/); }
});

const outline = (id, title) => ({ id, title, rationale: 'A required course unit.', conceptIds: ['n24'], sources: ['W08-P007'], objectives: ['Explain and apply the assigned ideas.'] });
const curriculum = { id: 'course1', title: 'The whole course', rationale: 'Cover the required syllabus.', modules: [outline('module1', 'First module'), outline('module2', 'Second module')], dependencies: [], coverage: { pages: 1, concepts: 1, lectures: 1 } };

test('finishing a module advances the course diagnostic and preserves both module records on reload', async () => {
  const app = await mount(new Map(), async (url, body) => {
    assert.equal(url, 'api/question');
    return body.module.id === 'module1' ? { kind: 'plan' }
      : { id: 'second-question', kind: 'teachback', criterionIds: ['concept'], question: 'Teach the second module.' };
  });
  Object.assign(app.state, { curriculum: structuredClone(curriculum), modules: [structuredClone(m), { ...structuredClone(m), id: 'module2', title: 'Second module' }],
    module: structuredClone(m), accepted: true, diagnosing: true,
    history: [{ id: 'first-response', kind: 'teachback', question: 'Teach the first module.', criterionIds: ['concept'], answer: 'First module evidence.', judgments: [] }] });
  await app.advance();
  assert.equal(app.state.module.id, 'module2'); assert.equal(app.state.current.id, 'second-question');
  assert.equal(app.state.moduleRecords.module1.diagnosticDone, true);
  assert.equal(app.state.moduleRecords.module1.history[0].answer, 'First module evidence.');
  app.state.draft = 'A second-module draft'; app.save();
  const restored = await mount(app.storage);
  assert.equal(restored.state.moduleRecords.module1.history.length, 1); assert.equal(restored.state.draft, 'A second-module draft');
  for (const step of [0, 1, 2, 3, 4]) { restored.state.step = step; restored.render(); assert.ok(restored.elements.get('main').innerHTML.length > 100); }
  restored.state.step = 4; restored.render(); assert.match(restored.elements.get('main').innerHTML, /Second module/); assert.match(restored.elements.get('main').innerHTML, /not been tested/);
});

test('course preparation resumes after a failed module without regenerating prepared modules', async () => {
  const calls = []; let fail = true;
  const app = await mount(new Map(), async (url, body) => {
    calls.push([url, body.moduleId]);
    if (url === 'api/curriculum') return structuredClone(curriculum);
    if (body.moduleId === 'module2' && fail) throw Error('Temporary module failure');
    return { ...structuredClone(m), id: body.moduleId };
  });
  await assert.rejects(app.build(), /Temporary module failure/);
  assert.equal(app.state.modules.length, 1); assert.equal(app.state.curriculum.modules.length, 2); assert.equal(app.state.accepted, false);
  fail = false; await app.build();
  assert.equal(app.state.modules.length, 2); assert.equal(calls.filter(([url]) => url === 'api/curriculum').length, 1);
  assert.equal(calls.filter(([, id]) => id === 'module1').length, 1);
});

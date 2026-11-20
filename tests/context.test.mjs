import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceBatches, createSourceDigester } from '../context.mjs';
import { createCurriculumPlanner } from '../curriculum.mjs';

const graph = JSON.parse(await readFile(new URL('../astra.json', import.meta.url)));
const corpus = JSON.parse(await readFile(new URL('../sources.json', import.meta.url)));

test('compact planning reads every original page and expands all batch assignments', async () => {
  const seen = [], planningCalls = [];
  const digester = createSourceDigester({ generate: async (_, { notes }) => {
    seen.push(...notes);
    assert.ok(JSON.stringify(notes).length <= 9000);
    return { summary: 'Source-backed topics for these pages.' };
  } });
  const planner = createCurriculumPlanner({ graph, corpus, digester, generate: async (_, input) => {
    planningCalls.push(input);
    return { title: 'Whole course', rationale: 'A reviewable proposal based on all lectures.', dependencies: [],
      modules: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, title: `Module ${i}`, rationale: 'A coherent set of capabilities.',
        conceptIds: graph.nodes.slice(i * 18, (i + 1) * 18).map(n => n.id),
        sources: input.notes.filter((_, j) => j % 4 === i).map(n => n.id), objectives: ['Explain and apply the assigned methods.'] })) };
  } });
  const result = await planner.buildCurriculum({});
  assert.deepEqual(seen.map(p => [p.id, p.text]), corpus.pages.map(p => [p.id, p.text]));
  assert.deepEqual(result.coverage, { pages: 435, concepts: 70, lectures: 11 });
  assert.ok(result.modules.every(m => m.sources.every(id => /^W\d+-P\d+$/.test(id))));
  assert.ok(planningCalls[0].notes.length < corpus.pages.length);
});

test('an oversized page is split without losing its end or source ID', () => {
  const page = { id: 'W01-P001', text: 'A'.repeat(26000) + 'last detail' };
  const parts = sourceBatches([page]);
  assert.ok(parts.every(batch => JSON.stringify(batch).length <= 9000));
  assert.equal(parts.flat().map(n => n.text).join(''), page.text);
  assert.ok(parts.flat().every(n => n.id === page.id));
});

test('completed source summaries survive retries and model revisions invalidate their cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'modulearn-digests-'));
  const notes = [{ id: 'W01-P001', text: 'An original lecture topic.' }];
  let calls = 0;
  const generate = async () => { calls++; return { summary: 'A supported summary (W01-P001).' }; };
  try {
    await createSourceDigester({ generate, cacheDir: directory, model: 'model@one' }).summarize(notes);
    await createSourceDigester({ generate, cacheDir: directory, model: 'model@one' }).summarize(notes);
    assert.equal(calls, 1);
    await createSourceDigester({ generate, cacheDir: directory, model: 'model@two' }).summarize(notes);
    assert.equal(calls, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid summaries and unknown batch references never create an apparently complete course', async () => {
  const digester = createSourceDigester({ generate: async () => ({ summary: '' }) });
  await assert.rejects(digester.summarize([{ id: 'W01-P001', text: 'A topic' }]), /summary/);
  const planner = createCurriculumPlanner({ graph, corpus, digester: { summarize: async () => [{ id: 'batch1', sources: ['W01-P001'], text: 'A topic' }] },
    generate: async () => ({ modules: [{ sources: ['unknown'] }] }) });
  await assert.rejects(planner.buildCurriculum({}), /unknown source batch/);
});

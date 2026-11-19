import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCurriculumPlanner, validateCurriculum } from '../curriculum.mjs';
import { createTutor } from '../tutor.mjs';
import { coursePlan } from '../course.js';

const graph = JSON.parse(await readFile(new URL('../astra.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(await readFile(new URL('../sources.json', import.meta.url), 'utf8'));
function wholeCourse() {
  return { id: 'course1', title: 'COMP4431 full syllabus', rationale: 'A full-course proposal.', modules: Array.from({ length: 4 }, (_, index) => ({
    id: `m${index + 1}`, title: `Module ${index + 1}`, rationale: 'A coherent source-backed scope.',
    conceptIds: graph.nodes.slice(index * 20, index * 20 + 20).map(n => n.id),
    sources: corpus.pages.slice(index * 109, index * 109 + 109).map(p => p.id), objectives: ['Explain the assigned methods and apply them in a representative task.'],
  })), dependencies: [] };
}
const prepared = id => ({ id, title: id, outcomes: [{ id: 'o1', description: 'Explain and apply.' }],
  criteria: [{ id: 'c1', type: 'concept', outcomeId: 'o1' }, { id: 'c2', type: 'application', outcomeId: 'o1' }],
  activities: [{ id: 'a1', title: 'Understand', criterionIds: ['c1'], minutes: 5 }, { id: 'a2', title: 'Apply', criterionIds: ['c2'], minutes: 5 }] });
const mastered = module => ({ diagnosticDone: true, history: [
  { id: `${module}-explain`, kind: 'teachback', criterionIds: ['c1'], answer: 'Explanation evidence', judgments: [{ id: 'c1', status: 'met', evidence: [{ responseId: `${module}-explain`, quote: 'Explanation evidence' }] }] },
  { id: `${module}-apply`, kind: 'application', criterionIds: ['c2'], answer: 'Independent application evidence', judgments: [{ id: 'c2', status: 'met', evidence: [{ responseId: `${module}-apply`, quote: 'Independent application evidence' }] }] },
] });

test('course construction reads all 435 pages and covers all 70 concepts before diagnostics', async () => {
  let input;
  const planner = createCurriculumPlanner({ graph, corpus, generate: async (_, data) => { input = data; return wholeCourse(); } });
  const result = await planner.buildCurriculum({ preferences: { goal: 'Focus on one topic' } });
  assert.equal(input.notes.length, 435); assert.equal(input.concepts.length, 70);
  assert.deepEqual(result.coverage, { pages: 435, concepts: 70, lectures: 11 });
  assert.equal(result.modules.length, 4);
});
test('missing lecture pages or KG concepts block an incomplete course proposal', () => {
  const pagesMissing = wholeCourse(); pagesMissing.modules[0].sources.shift();
  assert.throws(() => validateCurriculum(pagesMissing, graph, corpus), /omits/);
  const nodesMissing = wholeCourse(); nodesMissing.modules[0].conceptIds.shift();
  assert.throws(() => validateCurriculum(nodesMissing, graph, corpus), /omits/);
});
test('dependency cycles are rejected and generated dependencies require explicit review', async () => {
  const plan = wholeCourse();
  plan.dependencies = [{ before: 'm2', after: 'm1', reason: 'A required earlier capability.', sources: ['W01-P001'] }];
  const planner = createCurriculumPlanner({ graph, corpus, generate: async () => plan });
  const generated = await planner.buildCurriculum({}); assert.equal(generated.dependencies[0].approved, false);
  plan.dependencies.push({ before: 'm1', after: 'm2', reason: 'Another proposed dependency.', sources: ['W01-P001'] });
  assert.throws(() => validateCurriculum(plan, graph, corpus), /cycle/);
});
test('a finished first module never removes untested modules from the course path', () => {
  const plan = wholeCourse(), modules = plan.modules.map(m => prepared(m.id));
  const result = coursePlan(plan, modules, { m1: mastered('m1') });
  assert.equal(result.skipped.length, 1); assert.equal(result.remaining.length, 3); assert.equal(result.untested, 3); assert.equal(result.complete, false);
  assert.ok(result.remaining.every(item => item.status === 'untested' && item.plan.remaining.length === 2));
});
test('module-local criterion IDs and evidence cannot grant mastery in another module', () => {
  const plan = wholeCourse(), modules = plan.modules.map(m => prepared(m.id));
  const wrong = structuredClone(mastered('m1')); wrong.history[0].judgments[0].evidence[0].quote = 'fabricated';
  const result = coursePlan(plan, modules, { m1: wrong });
  assert.equal(result.skipped.length, 0); assert.equal(result.items.find(i => i.outline.id === 'm2').plan.skipped.length, 0);
});
test('only reviewed prerequisites affect the path order', () => {
  const plan = wholeCourse(), modules = plan.modules.map(m => prepared(m.id));
  plan.dependencies = [{ before: 'm4', after: 'm1', reason: 'A reviewed capability.', approved: false }];
  assert.equal(coursePlan(plan, modules).items[0].outline.id, 'm1');
  plan.dependencies[0].approved = true;
  assert.equal(coursePlan(plan, modules).items[0].outline.id, 'm4');
});
test('the whole course is complete only with evidence for every module', () => {
  const plan = wholeCourse(), modules = plan.modules.map(m => prepared(m.id));
  const records = Object.fromEntries(plan.modules.map(m => [m.id, mastered(m.id)]));
  assert.equal(coursePlan(plan, modules, records).complete, true);
  delete records.m4; assert.equal(coursePlan(plan, modules, records).complete, false);
});
test('module detail generation receives its full assigned pages, beyond the old 28-page retrieval cap', async () => {
  const plan = wholeCourse(); let input;
  const target = plan.modules[0];
  const detail = { title: target.title, rationale: target.rationale, conceptIds: target.conceptIds,
    outcomes: [{ id: 'o1', description: 'Explain and apply the assigned methods.' }],
    criteria: ['concept', 'application'].map((type, index) => ({ id: `c${index}`, title: type, type, outcomeId: 'o1', conceptIds: target.conceptIds,
      sources: [target.sources[1]], standard: 'Demonstrate the required reasoning under the supplied task conditions.' })),
    activities: [{ id: 'a1', title: 'Demonstrate the skills', criterionIds: ['c0', 'c1'], minutes: 8 }] };
  const tutor = createTutor({ graph, corpus, generate: async (_, data) => { input = data; return detail; } });
  const result = await tutor.buildModule({ curriculum: plan, moduleId: target.id });
  assert.equal(result.id, target.id); assert.equal(input.notes.length, target.sources.length); assert.ok(input.notes.length > 28);
  assert.deepEqual(result.conceptIds, target.conceptIds);
});

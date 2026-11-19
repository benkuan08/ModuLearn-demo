// Shared, deterministic workflow rules. No fixed topic, task, or learner answer.
export const statuses = { met: 'Met', not_yet_met: 'Not yet met', insufficient: 'Insufficient evidence' };
export const formats = { examples: 'Examples and analogies', steps: 'Step-by-step explanations', questions: 'Guided questions', concise: 'Concise explanations' };

export function profileOf(module, history = []) {
  const profile = Object.fromEntries(module.criteria.map(c => [c.id, { status: 'insufficient', reason: 'No assessment evidence yet.', evidence: [] }]));
  const responses = new Map(history.map(turn => [turn.id, turn]));
  for (const turn of history) {
    for (const judgment of turn.judgments ?? []) {
      const criterion = module.criteria.find(c => c.id === judgment.id);
      if (!criterion || !turn.criterionIds.includes(criterion.id)) continue;
      const evidence = (judgment.evidence ?? []).filter(e => {
        const response = responses.get(e.responseId);
        return response && response.criterionIds.includes(criterion.id)
          && (criterion.type !== 'application' || response.kind === 'application')
          && typeof e.quote === 'string' && e.quote.trim() && response.answer.includes(e.quote);
      });
      const supported = evidence.length > 0;
      const status = Object.hasOwn(statuses, judgment.status) && (judgment.status === 'insufficient' || supported)
        ? judgment.status : 'insufficient';
      profile[criterion.id] = { ...judgment, status, evidence, turnId: turn.id };
    }
  }
  return profile;
}

export function outcomeStatus(module, profile, outcomeId) {
  const required = module.criteria.filter(c => c.outcomeId === outcomeId);
  return required.length && required.every(c => profile[c.id]?.status === 'met') ? 'met' : 'insufficient';
}

// Probe concepts before independently testing eligible application outcomes.
// Exhausted concepts stay on the teaching plan; raw KG links are not prerequisites.
export function nextAssessment(module, history, profile = profileOf(module, history)) {
  for (const criterion of module.criteria.filter(c => c.type === 'concept')) {
    if (profile[criterion.id].status === 'met') continue;
    const probes = history.filter(t => t.kind === 'probe' && t.criterionIds.includes(criterion.id));
    if (probes.length < 2 && !probes.some(t => t.afterTeaching)) {
      return { kind: 'probe', criterionIds: [criterion.id], reason: profile[criterion.id].reason };
    }
  }
  for (const outcome of module.outcomes) {
    const criteria = module.criteria.filter(c => c.outcomeId === outcome.id);
    if (criteria.some(c => c.type === 'concept' && profile[c.id].status !== 'met')) continue;
    const remaining = criteria.filter(c => c.type === 'application' && profile[c.id].status !== 'met');
    if (!remaining.length) continue;
    const attempts = history.filter(t => t.kind === 'application' && t.criterionIds.some(id => remaining.some(c => c.id === id)));
    if (attempts.length < 2 && !attempts.some(t => t.afterTeaching)) {
      return { kind: 'application', criterionIds: remaining.map(c => c.id), reason: attempts.length ? 'Clarify the missing reasoning in the previous application.' : 'Check this outcome on a new task.' };
    }
  }
  return { kind: 'plan', criterionIds: [], reason: 'Use the recorded evidence to choose what to teach next.' };
}

export function studyPlan(module, history = [], minutes = 25) {
  const profile = profileOf(module, history);
  const activities = module.activities.map(activity => ({ ...activity,
    skip: activity.criterionIds.length > 0 && activity.criterionIds.every(id => profile[id]?.status === 'met'),
    gaps: activity.criterionIds.filter(id => profile[id]?.status !== 'met'),
  }));
  const order = activity => Math.min(...activity.criterionIds.map(id => {
    const c = module.criteria.find(c => c.id === id);
    return module.outcomes.findIndex(o => o.id === c.outcomeId) * 2 + (c.type === 'application' ? 1 : 0);
  }));
  const remaining = activities.filter(a => !a.skip).sort((a, b) => order(a) - order(b));
  const budget = Math.max(10, Math.min(90, Number(minutes) || 25));
  const sessions = [];
  for (const activity of remaining) {
    let session = sessions.at(-1);
    if (!session || session.minutes + activity.minutes > budget) {
      session = { number: sessions.length + 1, minutes: 0, activities: [] };
      sessions.push(session);
    }
    session.activities.push(activity);
    session.minutes += activity.minutes;
  }
  return { profile, remaining, skipped: activities.filter(a => a.skip), sessions,
    complete: module.criteria.every(c => profile[c.id]?.status === 'met') };
}

// A course path retains EVERY required module, including modules not yet tested.
// Only explicitly reviewed dependencies affect its order.
export function coursePlan(curriculum, modules, records = {}, minutes = 25) {
  const catalog = new Map(modules.map(m => [m.id, m]));
  const required = curriculum.modules;
  const ordered = [], visiting = new Set(), done = new Set();
  function visit(outline) {
    if (visiting.has(outline.id)) throw Error('Reviewed prerequisites contain a cycle. Review the module dependencies.');
    if (done.has(outline.id)) return;
    visiting.add(outline.id);
    for (const d of (curriculum.dependencies ?? []).filter(d => d.approved === true && d.after === outline.id)) {
      const before = required.find(m => m.id === d.before);
      if (!before) throw Error('A reviewed prerequisite refers to an unknown module.');
      visit(before);
    }
    visiting.delete(outline.id); done.add(outline.id); ordered.push(outline);
  }
  required.forEach(visit);
  const items = ordered.map(outline => {
    const module = catalog.get(outline.id), record = records[outline.id] ?? {};
    const history = record.history ?? [];
    const plan = module ? studyPlan(module, history, minutes) : null;
    return { outline, module, record, plan, status: !module ? 'not_prepared' : !history.length ? 'untested' : plan.complete ? 'met' : record.diagnosticDone ? 'gaps' : 'in_progress',
      skip: Boolean(plan?.complete), prerequisites: (curriculum.dependencies ?? []).filter(d => d.approved === true && d.after === outline.id).map(d => d.before) };
  });
  const remaining = items.filter(i => !i.skip);
  return { items, remaining, skipped: items.filter(i => i.skip),
    tested: items.filter(i => i.record.diagnosticDone || i.plan?.complete).length,
    untested: items.filter(i => !i.record.history?.length).length,
    complete: items.length > 0 && remaining.length === 0,
    sessions: remaining.flatMap(item => (item.plan?.sessions ?? []).map(s => ({ ...s, moduleId: item.outline.id, moduleTitle: item.outline.title }))) };
}

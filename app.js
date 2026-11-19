import { statuses, formats, profileOf, outcomeStatus, studyPlan, coursePlan } from './course.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const storageKey = 'modulearn-adaptive-v1';
const defaults = () => ({ step: 0, preferences: { goal: '', format: 'examples', minutes: 25, obligations: '' }, conceptIds: [], module: null, accepted: false,
  history: [], current: null, lesson: null, lessons: [], draft: '', learnerQuestion: '', archives: [],
  curriculum: null, modules: [], moduleRecords: {}, diagnosticDone: false, diagnosing: false });
let saved;
try { saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
const state = { ...defaults(), ...(saved?.version === 1 ? saved.session : {}), course: null, status: null, busy: '', error: '', storageWarning: '', source: null };
const kindName = { teachback: 'Your teach-back', probe: 'Targeted follow-up', application: 'Independent application' };
const snapshot = () => Object.fromEntries(Object.keys(defaults()).map(key => [key, state[key]]));
const activeFields = ['history', 'current', 'lesson', 'lessons', 'draft', 'learnerQuestion', 'diagnosticDone'];
function syncActive() {
  if (state.module) state.moduleRecords[state.module.id] = Object.fromEntries(activeFields.map(key => [key, state[key]]));
}
function selectModule(id) {
  const module = state.modules.find(m => m.id === id);
  if (!module) throw Error('Prepare this course module before opening its assessment.');
  syncActive();
  const record = state.moduleRecords[id] ?? {};
  const fresh = defaults();
  for (const key of activeFields) state[key] = record[key] ?? fresh[key];
  state.module = module;
  state.source = null;
}
function wholePlan() { syncActive(); return coursePlan(state.curriculum, state.modules, state.moduleRecords, state.preferences.minutes); }
function save() {
  syncActive();
  try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, session: snapshot() })); state.storageWarning = ''; }
  catch { state.storageWarning = 'This browser could not save your session. Export your records before leaving this page.'; }
}
async function api(action, body) {
  const response = await fetch(`api/${action}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'The request failed. Your work is preserved.');
  return result;
}
const payload = () => ({ module: state.module, history: state.history, preferences: state.preferences });
const label = id => state.course.graph.nodes.find(n => n.id === id)?.label ?? id;
const button = (text, action, secondary = false) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-action="${esc(action)}" ${state.busy ? 'disabled' : ''}>${esc(text)}</button>`;
const sourceName = id => `Week ${Number(id.slice(1, 3))}, p. ${Number(id.slice(5))}`;
const sources = ids => [...new Set(ids)].map(id => `<button type="button" class="citation source-link" data-action="source:${esc(id)}" ${state.busy ? 'disabled' : ''}>${esc(sourceName(id))}</button>`).join(' ');
const pill = status => `<span class="pill ${esc(status)}">${esc(statuses[status] ?? statuses.insufficient)}</span>`;
const heading = (tag, title, description) => `<header class="section-head"><p class="eyebrow">${esc(tag)}</p><h1>${esc(title)}</h1><p>${esc(description)}</p></header>`;
function allowed(index) { return index === 0 || index === 1 && (state.curriculum || state.module) || index === 2 && state.accepted && state.module || [3, 4].includes(index) && (state.accepted || state.history.length) || index === 5 && state.lesson; }
function go(step) { if (!allowed(step)) return; state.step = step; state.error = ''; save(); render(); $('main').focus(); window.scrollTo(0, 0); }
function render() {
  if (!state.course) return;
  $('mode').textContent = state.status.configured ? state.status.model : 'Hosted model setup needed';
  $('mode').classList.toggle('active', state.status.configured);
  $('stages').innerHTML = ['Whole syllabus', 'Modules and criteria', 'Course diagnostic', 'Course evidence profile', 'Teaching path', 'Learn and recheck'].map((name, i) => `<button data-action="step:${i}" ${!allowed(i) || state.busy ? 'disabled' : ''} ${state.step === i ? 'aria-current="step"' : ''}><span>${String(i + 1).padStart(2, '0')}</span>${name}</button>`).join('')
    + `<div class="nav-tools">${button('Export my records', 'export', true)}${state.curriculum || state.module ? button('New course plan', 'new', true) : ''}</div>`;
  const alert = state.error || state.storageWarning;
  const sourcePanel = state.source ? `<section class="surface source-panel"><div class="split"><h2>${esc(sourceName(state.source.id))}</h2>${button('Close source', 'close-source', true)}</div><p class="muted">${esc(state.source.filename)}</p><pre>${esc(state.source.text || 'This page has no extractable text. Check the original PDF for a diagram.')}</pre></section>` : '';
  $('main').innerHTML = (alert ? `<p class="alert" role="alert">${esc(alert)}</p>` : '')
    + (state.busy ? `<p class="working" role="status">${esc(state.busy)} Your saved responses stay in place.</p>` : '') + sourcePanel
    + [setupView, moduleView, assessmentView, profileView, planView, lessonView][state.step]();
}
function setupView() {
  const { graph, lectures, pageCount } = state.course;
  return `${heading('Whole-course learning', 'From the whole syllabus to your teaching path', 'First organize all course material into competency modules. Then assess your understanding across those modules and use the evidence to decide what to teach.')}
    <section class="surface"><div class="metrics"><div><strong>${lectures.length}</strong><span>lecture PDFs</span></div><div><strong>${pageCount}</strong><span>source pages</span></div><div><strong>${graph.nodes.length}</strong><span>KG concepts to cover</span></div></div>
    ${!state.status.configured ? '<p class="alert">The syllabus is loaded. Configure the hosted model endpoint and token to design modules, assess you and generate teaching. Saved records remain available.</p>' : ''}
    ${state.curriculum ? `<p><strong>${esc(state.curriculum.title)}</strong> · ${state.curriculum.modules.length} proposed modules · ${state.modules.length} with criteria prepared.</p><div class="actions">${button(state.accepted ? 'Open my teaching path' : 'Review course modules', 'resume')}${!state.accepted && state.modules.length < state.curriculum.modules.length ? button('Continue preparing modules', 'build', true) : ''}</div>`
    : state.module ? `<p>Your earlier single-module session is preserved: <strong>${esc(state.module.title)}</strong>.</p><div class="actions">${button('Review earlier records', state.accepted ? 'step:4' : 'step:1', true)}${button('Archive it and start a whole-course plan', 'new')}</div>`
    : `<form id="setup-form"><label for="goal">Your priorities or learning goal (optional)</label><textarea id="goal" data-pref="goal" maxlength="1200" rows="3" placeholder="For example, prepare for the whole COMP4431 course, with extra help applying methods…">${esc(state.preferences.goal)}</textarea><p class="muted fine">Your priorities change emphasis. All syllabus material remains in scope.</p>
    <div class="form-grid"><label for="format">Preferred teaching style<select id="format" data-pref="format">${Object.entries(formats).map(([key, text]) => `<option value="${key}" ${state.preferences.format === key ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label><label for="minutes">Minutes per teaching session<input id="minutes" data-pref="minutes" type="number" min="10" max="90" value="${esc(state.preferences.minutes)}"></label></div>
    <label for="obligations">Compulsory course obligations to retain</label><textarea id="obligations" data-pref="obligations" rows="2" maxlength="1000">${esc(state.preferences.obligations)}</textarea><div class="actions"><button class="primary" type="submit" ${state.busy ? 'disabled' : ''}>Organize the whole syllabus into modules</button></div></form>`}</section>
    <details class="block-title"><summary>Inspect the full source corpus</summary><div class="lecture-body">${lectures.map(l => `<p><strong>Week ${l.week}</strong> · ${esc(l.filename)} · ${l.pages} pages ${sources([`W${String(l.week).padStart(2, '0')}-P001`])}</p>`).join('')}<p class="muted">All extracted pages are used when proposing the course. The KG supplies candidate concept relationships; text-only extraction can omit figures.</p></div></details>
    ${state.archives.length ? `<section class="surface block-title"><h2>Earlier course plans and modules</h2>${state.archives.map((s, i) => `<div class="plan-row"><span>${esc(s.curriculum?.title ?? s.module?.title ?? 'Saved learning records')}</span>${button('Resume', `restore:${i}`, true)}</div>`).join('')}</section>` : ''}`;
}

function moduleView() {
  if (!state.curriculum) return activeModuleView();
  const c = state.curriculum;
  return `${heading('Whole syllabus · module design', c.title, c.rationale)}<section class="surface"><p><strong>${c.modules.length} modules</strong> · ${c.coverage.pages} source pages mapped · ${c.coverage.concepts} KG concepts mapped · ${state.modules.length} modules with criteria prepared.</p>
    <p class="muted">These counts check source assignment and KG coverage. Review the objectives and criteria for semantic syllabus coverage, including topics absent as separate KG nodes. Administrative pages are context, not skills to test.</p></section>
    ${c.modules.map((outline, index) => { const m = state.modules.find(m => m.id === outline.id); return `<details class="block-title" ${index === 0 ? 'open' : ''}><summary>Module ${index + 1}: ${esc(outline.title)} ${m ? '· Criteria ready' : '· Awaiting preparation'}</summary><div class="lecture-body"><p>${esc(outline.rationale)}</p><div class="chips">${outline.conceptIds.map(id => `<span>${esc(label(id))}</span>`).join('')}</div><h3>Required scope</h3><ul>${outline.objectives.map(o => `<li>${esc(o)}</li>`).join('')}</ul>${m ? m.outcomes.map(o => `<article class="outcome"><h3>${esc(o.description)}</h3>${m.criteria.filter(k => k.outcomeId === o.id).map(k => `<div class="criterion-detail"><strong>${esc(k.title)}</strong> <span class="citation">${k.type === 'concept' ? 'Explain' : 'Apply independently'}</span><p>${esc(k.standard)}</p>${sources(k.sources)}</div>`).join('')}</article>`).join('') : '<p>Its criteria must be prepared before the course diagnostic can begin.</p>'}<details><summary>${outline.sources.length} assigned source pages</summary><div class="lecture-body">${sources(outline.sources)}</div></details></div></details>`; }).join('')}
    <section class="surface block-title"><h2>Proposed module dependencies</h2>${c.dependencies.length ? c.dependencies.map((d, index) => `<div class="criterion-detail"><label class="dependency-choice"><input type="checkbox" data-dependency="${index}" ${d.approved ? 'checked' : ''} ${state.busy ? 'disabled' : ''}>Use this dependency in my personal plan: ${esc(c.modules.find(m => m.id === d.before).title)} before ${esc(c.modules.find(m => m.id === d.after).title)}</label><p>${esc(d.reason)}</p>${sources(d.sources)}</div>`).join('') : '<p>No dependencies were proposed. The initial module order is used for planning.</p>'}<p class="muted">Suggestions are not instructor-approved prerequisites. Only dependencies you explicitly review and select affect your personal path. Compulsory course requirements still apply.</p></section>
    <div class="actions">${state.accepted ? button('Continue the course diagnostic', 'diagnose') : state.modules.length === c.modules.length ? button('Adopt course modules and begin diagnostic', 'accept') : button('Continue preparing module criteria', 'build')}</div>`;
}

function profileView() {
  if (!state.curriculum) return activeProfileView();
  const plan = wholePlan();
  return `${heading('Course-wide learner profile', 'Evidence across every module', 'Each module keeps its own responses and criteria. Untested modules have no mastery evidence and remain required.')}
    <section class="surface">${plan.items.map(item => `<div class="plan-row"><div><strong>${esc(item.outline.title)}</strong><small>${moduleState(item.status)} · ${item.record.history?.length ?? 0} responses · ${item.plan?.skipped.length ?? 0} activities supported for skipping</small></div>${button('Inspect evidence', `inspect:${item.outline.id}`, true)}</div>`).join('')}</section>
    <div class="block-title"><p class="eyebrow">Selected module · ${esc(state.module.title)}</p>${activeProfileView()}</div>
    ${state.lessons.length ? `<details class="block-title"><summary>Earlier teaching in this module (${state.lessons.length} lessons)</summary><div class="lecture-body">${state.lessons.map(l => `<article class="outcome"><h3>${esc(l.title)}</h3>${l.sections.map(s => `<p class="prose">${esc(s.text)}</p>${sources(s.sources)}`).join('')}</article>`).join('')}</div></details>` : ''}`;
}

function moduleState(status) {
  return ({ not_prepared: 'Criteria not yet prepared', untested: 'Untested', in_progress: 'Diagnostic in progress', gaps: 'Diagnostic complete · gaps remain', met: 'All required criteria met' })[status];
}

function planView() {
  if (!state.curriculum) return activePlanView();
  const plan = wholePlan(), completeDiagnostic = plan.tested === plan.items.length;
  return `${heading('Course-wide teaching path', plan.complete ? 'All course criteria have evidence' : completeDiagnostic ? 'Your teaching path from the diagnostic' : 'Provisional path · diagnostic still in progress', 'The path spans the entire syllabus. It retains untested work and removes practice only when all its required criteria have verified evidence.')}
    <section class="surface"><div class="metrics"><div><strong>${plan.tested}/${plan.items.length}</strong><span>module diagnostics complete</span></div><div><strong>${plan.remaining.length}</strong><span>modules with work remaining</span></div><div><strong>${plan.skipped.length}</strong><span>whole modules supported for skipping</span></div></div>
    ${!completeDiagnostic ? `<p class="alert">${plan.untested} modules have not been tested. Their work stays on this provisional path. Complete the course diagnostic to refine it.</p>${button('Continue the course diagnostic', 'diagnose')}` : ''}
    <h3>Course obligations to retain</h3><p class="prose">${esc(state.preferences.obligations || 'Compulsory course assessments remain required even when practice can be skipped.')}</p></section>
    ${plan.remaining.map((item, index) => `<section class="surface block-title"><h2>${index + 1}. ${esc(item.outline.title)}</h2><p class="muted">${moduleState(item.status)}</p>${item.prerequisites.length ? `<p>Reviewed earlier modules: ${item.prerequisites.map(id => esc(state.curriculum.modules.find(m => m.id === id).title)).join(', ')}</p>` : ''}
    ${!item.record.history?.length ? `<p>This module has no assessment evidence. Its required activities remain on the path.</p>${button('Assess this module', `assess:${item.outline.id}`)}` : item.plan.sessions.map(s => `<div class="outcome"><h3>Session ${s.number} · about ${s.minutes} minutes</h3>${s.activities.map(a => `<div class="plan-row"><div><strong>${esc(a.title)}</strong><small>Needs evidence: ${a.gaps.map(id => esc(item.module.criteria.find(k => k.id === id).title)).join(', ')}</small></div>${button('Teach me this', `learn:${item.module.id}:${a.id}`)}</div>`).join('')}</div>`).join('')}
    ${item.plan.skipped.length ? `<details><summary>${item.plan.skipped.length} activities supported for skipping</summary><div class="lecture-body">${item.plan.skipped.map(a => `<p>${esc(a.title)}</p>`).join('')}</div></details>` : ''}</section>`).join('')}
    <section class="surface block-title"><h2>Whole modules supported for skipping</h2>${plan.skipped.length ? plan.skipped.map(item => `<div class="plan-row"><span>${esc(item.outline.title)}</span>${button('Review mastery evidence', `inspect:${item.outline.id}`, true)}</div>`).join('') : '<p>None yet. A whole module requires sufficient evidence for every required criterion.</p>'}</section>
    <div class="actions">${button('Review course evidence', 'step:3', true)}${button('Review modules and dependencies', 'step:1', true)}</div>`;
}

function activeModuleView() {
  const m = state.module;
  return `${heading('Module design', m.title, m.rationale)}<section class="surface"><h2>Concepts in scope</h2><div class="chips">${m.conceptIds.map(id => `<span>${esc(label(id))}</span>`).join('')}</div><h2 class="block-title">Observable outcomes and mastery criteria</h2>
    ${m.outcomes.map(o => `<article class="outcome"><h3>${esc(o.description)}</h3>${m.criteria.filter(c => c.outcomeId === o.id).map(c => `<div class="criterion-detail"><p><strong>${esc(c.title)}</strong> <span class="citation">${c.type === 'concept' ? 'Explain' : 'Apply independently'}</span></p><p>${esc(c.standard)}</p><div class="chips">${c.conceptIds.map(id => `<span>${esc(label(id))}</span>`).join('')}</div>${sources(c.sources)}</div>`).join('')}</article>`).join('')}
    <p class="muted">This is a model-generated proposal for review. Check the scope, criteria and cited notes before adopting it. It does not replace instructor-approved course assessment requirements.</p>
    <div class="actions">${state.accepted ? button('Continue assessment', 'step:2') : button('Use this module and explain it', 'accept')}${!state.accepted ? button('Regenerate proposal', 'build', true) : ''}</div></section>`;
}
function assessmentView() {
  const q = state.current, profile = profileOf(state.module, state.history);
  return `${heading('Assessment', 'Show what you already understand', 'Your explanations guide the next question. Earlier answers count, so a focused follow-up can complete evidence without making you repeat everything.')}
    <div class="assessment-layout"><section class="surface">${q ? `<p class="eyebrow">${esc(kindName[q.kind])}${q.afterTeaching ? ' · After teaching' : ''}</p><h2>${esc(state.module.title)}</h2><p class="question prose">${esc(q.question)}</p>
    <form id="answer-form"><label for="answer">Your explanation or reasoning</label><textarea id="answer" rows="8" maxlength="8000" required ${state.busy ? 'disabled' : ''}>${esc(state.draft)}</textarea><p class="muted fine">If you do not know, say so. Missing evidence stays on your learning plan.</p><div class="actions"><button class="primary" type="submit" ${state.busy ? 'disabled' : ''}>Assess my answer</button>${state.history.length ? button('Pause and review my plan', 'step:4', true) : ''}</div></form>`
    : `<h2>${state.history.length ? 'Your latest response is saved' : 'Start with your own explanation'}</h2><p>The tutor will choose a follow-up, a new application task, or your learning plan from the evidence.</p>${button('Choose my next step', 'next')}`}
    ${state.history.length ? `<details class="transcript"><summary>Assessment history (${state.history.length} responses)</summary><div>${state.history.map(t => `<article><h3>${esc(kindName[t.kind])}</h3><p class="prose">${esc(t.question)}</p><blockquote>${esc(t.answer)}</blockquote>${(t.judgments ?? []).map(j => `<p>${esc(state.module.criteria.find(c => c.id === j.id)?.title)} ${pill(j.status)} ${esc(j.reason)}</p>`).join('')}</article>`).join('')}</div></details>` : ''}</section>
    <aside class="surface"><h2>Evidence so far</h2>${state.module.criteria.map(c => `<div class="criterion"><span>${esc(c.title)}</span>${pill(profile[c.id].status)}</div>`).join('')}<p class="muted fine">Reading a lesson does not grant mastery. Application needs an independent task.</p></aside></div>`;
}
function activeProfileView() {
  const m = state.module, profile = profileOf(m, state.history);
  return `${heading('Learner profile', 'Inspect the evidence behind the plan', 'Judgments retain their original learner quotations and response IDs. Your records are saved in this browser and can be exported.')}
    <div class="surface">${m.outcomes.map(o => `<div class="plan-row"><strong>${esc(o.description)}</strong>${pill(outcomeStatus(m, profile, o.id))}</div>`).join('')}</div>
    <div class="evidence-list block-title">${m.criteria.map(c => { const r = profile[c.id]; return `<article class="surface"><div class="split"><h2>${esc(c.title)}</h2>${pill(r.status)}</div><p>${esc(c.standard)}</p><p>${esc(r.reason)}</p>${r.evidence.map(e => `<blockquote>${esc(e.quote)}<small class="muted evidence-id">Response ${esc(e.responseId.slice(0, 8))}</small></blockquote>`).join('')}<div class="chips">${c.conceptIds.map(id => `<span>${esc(label(id))}</span>`).join('')}</div>${sources(c.sources)}</article>`; }).join('')}</div>
    <div class="actions">${button('Choose what to learn next', 'step:4')}</div>`;
}
function activePlanView() {
  const plan = studyPlan(state.module, state.history, state.preferences.minutes);
  return `${heading('Personal study plan', plan.complete ? 'All required criteria have evidence' : 'Learn the skills that still need evidence', 'Practice is skipped only when all its required criteria have verified learner evidence. Concept work comes before application within each outcome.')}
    <div class="surface"><div class="metrics"><div><strong>${plan.remaining.length}</strong><span>activities to learn</span></div><div><strong>${plan.skipped.length}</strong><span>activities supported for skipping</span></div><div><strong>${plan.sessions.length}</strong><span>suggested sessions</span></div></div>
    ${state.preferences.obligations ? `<h3>Course obligations to retain</h3><p class="prose">${esc(state.preferences.obligations)}</p>` : '<p class="muted">Compulsory course assessments remain required even when practice can be skipped.</p>'}</div>
    ${plan.sessions.map(session => `<section class="surface block-title"><h2>Session ${session.number} · about ${session.minutes} minutes</h2>${session.activities.map(a => `<div class="plan-row"><div><strong>${esc(a.title)}</strong><small>Needs evidence: ${a.gaps.map(id => esc(state.module.criteria.find(c => c.id === id).title)).join(', ')}</small></div>${button('Teach me this', `teach:${a.id}`)}</div>`).join('')}</section>`).join('')}
    <section class="surface block-title"><h2>Practice you can skip</h2>${plan.skipped.length ? plan.skipped.map(a => `<div class="plan-row"><span>${esc(a.title)}</span>${pill('met')}</div>`).join('') : '<p>No activity has sufficient evidence to skip yet.</p>'}</section>
    ${state.lessons.length ? `<details class="block-title"><summary>Teaching history (${state.lessons.length} lessons)</summary><div class="lecture-body">${state.lessons.map(l => `<p>${esc(l.title)} · ${esc(new Date(l.createdAt).toLocaleString())}</p>`).join('')}</div></details>` : ''}
    <div class="actions">${button('Review my evidence', 'step:3', true)}${button('Continue assessment', 'step:2', true)}</div>`;
}
function lessonView() {
  const l = state.lesson;
  return `${heading('Learn and recheck', l.title, 'This lesson responds to your assessment evidence and preferred explanation style. A new question will check what you can now do independently.')}
    <section class="surface lesson">${l.sections.map(s => `<section><h2>${esc(s.heading)}</h2><div class="prose">${esc(s.text)}</div><p>${sources(s.sources)}</p></section>`).join('')}</section>
    <section class="surface block-title"><form id="lesson-form"><label for="learner-question">Ask about this lesson</label><textarea id="learner-question" maxlength="1800" rows="3" placeholder="Tell the tutor which part still feels unclear…">${esc(state.learnerQuestion)}</textarea><div class="actions"><button class="secondary" type="submit" ${state.busy ? 'disabled' : ''}>Explain this part</button></div></form></section>
    <div class="actions">${button('Check my understanding on a new question', 'recheck')}${button('Back to my plan', 'step:4', true)}</div>`;
}

async function run(message, work) {
  if (state.busy) return;
  state.busy = message; state.error = ''; render();
  try { await work(); } catch (e) { state.error = e.message; }
  finally { state.busy = ''; save(); render(); }
}
async function advance(mode = 'next', criterionIds = []) {
  const question = await api('question', { ...payload(), mode, criterionIds });
  state.current = question.kind === 'plan' ? null : question;
  state.draft = '';
  if (question.kind === 'plan') {
    state.diagnosticDone = true; save();
    if (state.diagnosing && state.curriculum) {
      const next = state.curriculum.modules.find(m => !state.moduleRecords[m.id]?.diagnosticDone);
      if (next) {
        selectModule(next.id); save();
        if (state.current) { state.step = 2; return; }
        return advance();
      }
      state.diagnosing = false;
    }
  }
  state.step = question.kind === 'plan' ? 4 : 2; save();
}
async function build() {
  if (state.accepted) throw Error('Start a new course plan to replace its modules. Existing assessment records will be archived.');
  if (!state.curriculum) {
    state.curriculum = await api('curriculum', { preferences: state.preferences });
    state.step = 1; save();
  }
  for (const [index, outline] of state.curriculum.modules.entries()) {
    if (state.modules.some(m => m.id === outline.id)) continue;
    state.busy = `Defining outcomes and criteria for module ${index + 1} of ${state.curriculum.modules.length}: ${outline.title}…`;
    render();
    const module = await api('module', { curriculum: state.curriculum, moduleId: outline.id, preferences: state.preferences });
    state.modules.push(module); save();
  }
  if (!state.module) selectModule(state.curriculum.modules[0].id);
  state.step = 1; save();
}
async function teach(activityId, learnerQuestion = '') {
  const lesson = await api('teach', { ...payload(), activityId, learnerQuestion });
  state.diagnosing = false; state.current = null; state.draft = ''; state.lesson = lesson; state.lessons.push(lesson); state.learnerQuestion = ''; state.step = 5; save();
}
function startNew() {
  const archives = [...state.archives];
  syncActive();
  if (state.curriculum || state.module) { const { archives: _, ...session } = snapshot(); archives.push(session); }
  Object.assign(state, defaults(), { preferences: state.preferences, archives }); save(); render();
}
document.addEventListener('input', event => {
  const target = event.target;
  if (target.dataset.pref) state.preferences[target.dataset.pref] = target.type === 'number' ? Number(target.value) : target.value;
  if (target.id === 'answer') state.draft = target.value;
  if (target.id === 'learner-question') state.learnerQuestion = target.value;
  save();
});
document.addEventListener('change', event => {
  if (event.target.dataset?.dependency !== undefined && state.curriculum) {
    state.curriculum.dependencies[Number(event.target.dataset.dependency)].approved = event.target.checked;
    save(); render(); return;
  }
  if (event.target.id !== 'concepts') return;
  const ids = [...event.target.selectedOptions].map(o => o.value);
  if (ids.length > 5) { state.error = 'Choose up to five concepts so the module remains assessable.'; render(); return; }
  state.conceptIds = ids; save(); render();
});
document.addEventListener('submit', event => {
  if (!['setup-form', 'answer-form', 'lesson-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (event.target.id === 'setup-form') return run('Reading the whole syllabus and proposing its competency modules…', build);
  if (event.target.id === 'lesson-form') {
    if (!state.learnerQuestion.trim()) return;
    return run('Adapting the explanation to your question…', () => teach(state.lesson.activityId, state.learnerQuestion));
  }
  if (!state.current || !state.draft.trim()) return;
  run('Assessing your accumulated evidence, then choosing the next step…', async () => {
    const turn = { ...state.current, answer: state.draft.trim(), answeredAt: new Date().toISOString() };
    const result = await api('assess', { ...payload(), turn });
    state.history.push({ ...turn, judgments: result.judgments });
    state.current = null; state.draft = ''; save(); // Commit grading before generating the next question.
    await advance();
  });
});
document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || state.busy) return;
  if (action.startsWith('step:')) return go(Number(action.slice(5)));
  if (action === 'resume') return go(state.accepted ? 4 : 1);
  if (action === 'new') return startNew();
  if (action === 'build') return run('Preparing the course modules and their assessment criteria…', build);
  if (action === 'accept') return run('Opening the first module of your whole-course diagnostic…', async () => {
    if (state.curriculum && state.modules.length !== state.curriculum.modules.length) throw Error('Finish preparing all course modules before starting assessment.');
    state.accepted = true; state.diagnosing = true; save(); await advance();
  });
  if (action === 'diagnose') return run('Continuing your course diagnostic…', async () => {
    state.diagnosing = true;
    const next = state.curriculum.modules.find(m => !state.moduleRecords[m.id]?.diagnosticDone);
    if (!next) return go(4);
    selectModule(next.id);
    if (state.current) return go(2);
    await advance();
  });
  if (action.startsWith('inspect:')) { selectModule(action.slice(8)); return go(3); }
  if (action.startsWith('assess:')) return run('Opening this module’s diagnostic…', async () => { selectModule(action.slice(7)); state.diagnosing = true; if (state.current) return go(2); await advance(); });
  if (action.startsWith('learn:')) return run('Preparing teaching from your course profile…', async () => { const [moduleId, activityId] = action.slice(6).split(':'); selectModule(moduleId); await teach(activityId); });
  if (action === 'next') return run('Choosing a question from your current evidence…', () => advance());
  if (action.startsWith('teach:')) return run('Preparing teaching for the skills your evidence has not yet established…', () => teach(action.slice(6)));
  if (action === 'recheck') return run('Creating a different task to check understanding after teaching…', () => advance('recheck', state.lesson.criterionIds));
  if (action.startsWith('source:')) return run('Opening the original extracted note page…', async () => { state.source = await api(`source?id=${encodeURIComponent(action.slice(7))}`); });
  if (action === 'close-source') { state.source = null; return render(); }
  if (action.startsWith('restore:')) {
    const [session] = state.archives.splice(Number(action.slice(8)), 1); if (!session) return;
    const archives = state.archives;
    syncActive();
    if (state.curriculum || state.module) { const { archives: _, ...active } = snapshot(); archives.push(active); }
    Object.assign(state, defaults(), session, { archives, error: '', source: null }); save(); return render();
  }
  if (action === 'export') {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, session: snapshot() }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'modulearn-learning-records.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
try {
  [state.course, state.status] = await Promise.all([api('course'), api('status')]);
  if (!allowed(state.step)) state.step = 0;
  render();
} catch (e) { $('main').textContent = `The tutor could not load its course data. ${e.message} Start the Node server and reload this page.`; }

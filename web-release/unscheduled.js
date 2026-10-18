import { londonDay } from './work.js?v=20260924-manual-time-notes';
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const storageKey = 'blake-unscheduled-pending';
let dispose;
export function clearUnscheduled() { dispose?.(); dispose = undefined; }

export async function renderUnscheduled(host, { request, date }) {
  clearUnscheduled();
  let alive = true, jobs = [], cursor, done = false, selected = null, tasks = [], visits = [], editing = null, pending = null, accountId;
  let taskSequence = 0, entered = null;
  dispose = () => { alive = false; };
  const current = () => alive && host.isConnected;
  const clock = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  host.innerHTML = '<h1>Add unscheduled hours</h1><p class="loading">Loading jobs…</p>';
  try {
    const identity = await request('/v1/me');
    if (!current()) return;
    accountId = identity.user.id;
    if (!accountId) throw new Error('Please sign out and back in to enable unscheduled hours.');
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    pending = saved?.accountId === accountId ? saved : null;
    host.innerHTML = `<h1>Add unscheduled hours</h1><div class="card"><label>Find job<input type="search" data-search placeholder="Job number, customer or site"></label><div data-jobs></div><button class="btn secondary" data-more type="button">Load more jobs</button></div><div data-editor></div>`;
    host.querySelector('[data-search]').oninput = showJobs;
    host.querySelector('[data-more]').onclick = loadJobs;
    await loadJobs();
    if (pending && current()) {
      selected = { id: pending.jobId, reference: pending.reference, title: pending.title };
      date = pending.payload.jobDate;
      await openEditor();
    }
  } catch (error) { if (current()) host.innerHTML = `<h1>Add unscheduled hours</h1><p class="error">${esc(error.message)}</p>`; }

  async function loadJobs() {
    const more = host.querySelector('[data-more]');
    more.disabled = true;
    try {
      const page = await request('/v1/unscheduled/jobs' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
      if (!current()) return;
      jobs.push(...page.jobs.filter(job => !job.archived)); cursor = page.cursor; done = page.isDone;
      showJobs(); more.hidden = done;
    } catch (error) { if (current()) host.querySelector('[data-jobs]').textContent = error.message; }
    finally { if (current()) more.disabled = false; }
  }
  function showJobs() {
    if (!current()) return;
    const term = host.querySelector('[data-search]').value.trim().toLowerCase();
    const matches = jobs.filter(job => [job.reference, job.title, job.customer, job.site].join(' ').toLowerCase().includes(term));
    const out = host.querySelector('[data-jobs]');
    out.innerHTML = matches.length ? matches.map(job => `<button type="button" class="job" data-choice="${esc(job.id)}" ${pending ? 'disabled' : ''}><strong>${esc(job.reference)} · ${esc(job.title)}</strong><span>${esc([job.customer, job.site].filter(Boolean).join(" · "))}</span>${job.archived ? '<span class="badge">Archived</span>' : ''}</button>`).join('') : `<p>No matching jobs${done ? '.' : ' in this page. Load more jobs to continue searching.'}</p>`;
    out.querySelectorAll('[data-choice]').forEach(button => button.onclick = () => { selected = jobs.find(job => job.id === button.dataset.choice); editing = null; entered = null; openEditor(); });
  }
  async function openEditor(saved = false) {
    const seq = ++taskSequence, job = selected;
    const out = host.querySelector('[data-editor]');
    out.innerHTML = '<p class="loading">Loading cost centres…</p>';
    try {
      const [centres, entries] = await Promise.all([
        request(`/v1/unscheduled/jobs/${encodeURIComponent(job.id)}/tasks`),
        request(`/v1/unscheduled/jobs/${encodeURIComponent(job.id)}/work?date=${encodeURIComponent(date)}`),
      ]);
      if (!current() || seq !== taskSequence) return false;
      tasks = centres; visits = entries.sessions;
      showEditor();
      return true;
    } catch (error) {
      if (current() && seq === taskSequence) out.innerHTML = `<p class="error">${saved ? 'Time was saved, but recorded time could not be refreshed. Do not enter it again. ' : ''}${esc(error.message)}</p><button type="button" class="btn secondary" data-refresh>Reload recorded time</button>`;
      const retry = out.querySelector('[data-refresh]');
      if (retry) retry.onclick = () => openEditor(saved);
      return false;
    }
  }
  function showEditor(message = '') {
    const values = pending?.payload ?? entered ?? (editing ? { taskId: editing.taskId, start: clock(editing.startedAt), finish: clock(editing.stoppedAt), finishDate: londonDay(editing.stoppedAt), notes: editing.notes } : {});
    const out = host.querySelector('[data-editor]');
    out.innerHTML = `<form class="card" data-time><h2>${esc(selected.reference)} · ${esc(selected.title)}</h2><label>Work date<input name="jobDate" type="date" max="${londonDay()}" value="${esc(date)}" required></label>${tasks.length ? `<label>Cost centre<select name="taskId" required><option value="">Choose cost centre</option>${tasks.map(task => `<option value="${esc(task.id)}" ${task.id === values.taskId || tasks.length === 1 ? 'selected' : ''}>${esc(task.name)}</option>`).join('')}</select></label><div class="grid"><label>Start time<input name="start" type="time" value="${esc(values.start)}" required></label><label>End time<input name="finish" type="time" value="${esc(values.finish)}" required></label></div><label>End date<input name="finishDate" type="date" value="${esc(values.finishDate || date)}" required></label><label>Unpaid break minutes<input name="breakMinutes" type="number" min="0" max="1439" step="1" value="${values.breakMinutes ?? 0}" required></label><label>Reason / work carried out<textarea name="notes" maxlength="450" required>${esc(values.notes)}</textarea></label><button class="btn" type="submit">${pending ? 'Retry saved submission' : editing ? 'Save correction' : 'Send for office approval'}</button>` : '<p>No cost centres are available. Ask the office to add one.</p>'}<p data-message role="status" ${!pending && !message ? 'hidden' : ''} class="${pending ? 'notice' : 'success'}">${esc(pending ? 'Delivery was not confirmed. Retry the same submission to check its outcome before adding other hours.' : message)}</p></form><div class="card"><h2>Recorded time for this day</h2>${visits.length ? visits.map(visit => `<div class="visit"><h3>${esc(visit.taskName)}</h3><p>${clock(visit.startedAt)}–${visit.stoppedAt ? clock(visit.stoppedAt) : 'Running'}</p><p>${esc(visit.status)}</p>${visit.notes ? `<p class="work-summary">${esc(visit.notes)}</p>` : ''}${!visit.locked && !visit.active && !pending ? `<button type="button" class="btn secondary" data-edit="${esc(visit.id)}">Amend time</button>` : ''}</div>`).join('') : '<p>No time recorded.</p>'}</div>`;
    const form = out.querySelector('[data-time]');
    if (pending) form.querySelectorAll('input,select,textarea').forEach(field => field.disabled = true);
    form.querySelector('[name="jobDate"]').onchange = e => { date = e.target.value; editing = null; entered = null; openEditor(); };
    out.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => { editing = visits.find(visit => visit.id === button.dataset.edit); entered = null; showEditor(); });
    form.onsubmit = async e => {
      e.preventDefault();
      const button = form.querySelector('button[type="submit"]'), status = form.querySelector('[data-message]');
      if (!pending) {
        const payload = Object.fromEntries(new FormData(form));
        entered = payload;
        payload.breakMinutes = Number(payload.breakMinutes);
        payload.notes = payload.notes.trim();
        if (!payload.notes) { status.className = 'error'; status.textContent = 'Enter a reason for these hours.'; return; }
        pending = { accountId, jobId: selected.id, reference: selected.reference, title: selected.title, payload: { ...payload, key: crypto.randomUUID(), ...(editing ? { sessionId: editing.id, expectedVersion: editing.version } : {}) } };
        sessionStorage.setItem(storageKey, JSON.stringify(pending));
      }
      button.disabled = true;
      showJobs();
      status.hidden = false;
      form.querySelectorAll('input,select,textarea').forEach(field => field.disabled = true);
      status.className = 'notice'; status.textContent = 'Saving time…';
      try {
        await request(`/v1/unscheduled/jobs/${encodeURIComponent(pending.jobId)}/work/amend`, { method: 'POST', body: JSON.stringify(pending.payload) });
        sessionStorage.removeItem(storageKey); pending = null;
        if (!current() || !form.isConnected) return;
        editing = null; entered = null;
        const refreshed = await openEditor(true);
        if (current() && refreshed) showEditor('Time saved. Awaiting office approval.');
      } catch (error) {
        if (!current() || !form.isConnected) return;
        if (error.status >= 400 && error.status < 500) { entered = pending.payload; sessionStorage.removeItem(storageKey); pending = null; }
        showEditor();
        const notice = out.querySelector('[data-message]'); notice.hidden = false; notice.className = 'error'; notice.textContent = error.message + (pending ? ' Retry the saved submission; do not add it again.' : '');
      } finally { if (current()) showJobs(); }
    };
  }
}

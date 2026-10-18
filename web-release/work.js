const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const key = () => crypto.randomUUID();
export const londonDay = (value = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const clock = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const clockSeconds = value => new Intl.DateTimeFormat('en-GB', {timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(new Date(value));
const breakLabel = session => session.breakDurationMs !== undefined && session.breakDurationMs % 60000 !== 0 ? `${Math.round(session.breakDurationMs / 1000)} seconds` : `${session.breakDurationMs !== undefined ? session.breakDurationMs / 60000 : session.breakMinutes ?? 0} minutes`;
const timestamp = value => new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London' });
const duration = session => {
  const minutes = session.stoppedAt && Number.isFinite(session.actualMinutes) && session.actualMinutes > 0 ? session.actualMinutes : Math.max(session.stoppedAt ? 1 : 0, Math.round(((session.stoppedAt ? Date.parse(session.stoppedAt) : Date.now()) - Date.parse(session.startedAt)) / 60000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
let dispose;
export function clearWork() { dispose?.(); dispose = undefined; }

export function renderWork(host, { job, date, request, openVisit, openForms, timeOnly = false }) {
  clearWork();
  let work = null, completion = null, taskId = job.tasks.length === 1 ? job.tasks[0].id : '';
  let view = 'timer', editor = null, pending = null, busy = false, error = '', message = '';
  let retry = { payload: '', key: '' }, sequence = 0, disposed = false;
  let formSequence = 0;
  const available = () => !disposed && host.isConnected;
  const endpoint = suffix => `/v1/jobs/${encodeURIComponent(job.id)}/${suffix}`;
  const status = () => {
    const out = host.querySelector('[data-work-message]');
    if (out) { out.className = error ? 'error' : message ? 'success' : ''; out.textContent = error || message; }
  };
  const setBusy = value => {
    busy = value;
    const fields = host.querySelector('[data-fields]');
    if (fields) fields.disabled = value;
  };
  async function refresh() {
    const current = ++sequence;
    try {
      const [w, c] = await Promise.all([request(endpoint(`work?date=${encodeURIComponent(date)}`)), timeOnly ? Promise.resolve(null) : request(endpoint(`completions?date=${encodeURIComponent(date)}`))]);
      if (!available() || current !== sequence) return;
      work = w; completion = c; error = '';
      if (view === 'timer') renderTimer();
    } catch (e) {
      if (!available() || current !== sequence) return;
      error = e.message;
      if (view === 'timer') renderTimer(); else status();
    }
  }
  async function post(action, input, success) {
    if (busy || !available()) return;
    error = ''; message = 'Saving…'; status(); setBusy(true);
    const payload = JSON.stringify({ action, ...input });
    if (retry.payload !== payload) retry = { payload, key: key() };
    try {
      const result = await request(endpoint(action), { method: 'POST', body: JSON.stringify({ ...input, key: retry.key }) });
      if (!available()) return;
      retry = { payload: '', key: '' }; message = typeof success === 'function' ? success(result) : success;
      pending = null; editor = null; view = action.startsWith('completions/') ? 'complete' : 'timer';
      await refresh();
      if (available() && view === 'complete') renderCompletion();
    } catch (e) { if (available()) { error = e.message; message = ''; status(); } }
    finally { if (available()) setBusy(false); }
  }
  function frame(title, content) {
    host.innerHTML = `<div class="card work-card"><h2>${title}</h2><div data-work-message role="status"></div><fieldset class="work-fields" data-fields>${content}</fieldset></div>`;
    status(); setBusy(busy);
  }
  function bind(name, action) { const button = host.querySelector(`[data-work="${name}"]`); if (button) button.onclick = () => { if (!busy) action(); }; }
  function renderTimer() {
    const active = work?.active;
    const ownActive = active && active.jobId === job.id && active.jobDate === date;
    frame('Time on this job', `<p class="muted">Clock today’s work or enter actual times and unpaid breaks. Only worked minutes go to the office; approved time is locked.</p>${!work ? `<p>${error ? 'Your time entries could not be loaded.' : 'Loading time entries…'}</p>` : `
      ${active ? `<div class="notice"><p>${active.onBreak ? 'On unpaid break' : 'Work in progress'}: ${esc(active.taskName)}.</p>${active.clock ? `<button class="btn" data-work="pause-resume">${active.onBreak ? 'Resume work' : 'Start unpaid break'}</button><button class="btn" data-work="stop">Finish work</button>` : `<button class="btn secondary" data-work="amend-active">${ownActive ? 'Enter end time' : 'Open unfinished entry'}</button>`}</div>` : ''}
      ${job.tasks.length > 1 ? `<label>Which work area?<select data-task aria-label="Work area"><option value="">Choose your work area</option>${job.tasks.map(t => `<option value="${esc(t.id)}" ${t.id === taskId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
      ${!active && date === londonDay() ? `<button class="btn" data-work="start" ${!taskId || error ? 'disabled' : ''}>Start work</button>` : ''}
      <button class="btn" data-work="add" ${!taskId || active || error || work.sessions.some(s => s.legacy && s.taskId === taskId) ? 'disabled' : ''}>Add time</button>
      ${work.sessions.filter(s => !s.active).map(s => `<div class="visit"><h3>${esc(s.taskName)} · ${s.startedAt ? duration(s) : `${Math.floor(s.actualMinutes / 60)}h ${s.actualMinutes % 60}m`}</h3><p>${s.startedAt && s.stoppedAt ? `${s.clock ? clockSeconds(s.startedAt) : clock(s.startedAt)}–${s.clock ? clockSeconds(s.stoppedAt) : clock(s.stoppedAt)}${londonDay(s.stoppedAt) !== date ? ` (${londonDay(s.stoppedAt)})` : ''}` : 'Earlier entry: start and end times were not stored.'}</p>${s.breakDurationMs || s.breakMinutes ? `<p>Unpaid break: ${breakLabel(s)} · Worked: ${s.actualMinutes} minutes</p>` : ''}<p class="muted">${s.locked || s.status === 'approved' ? 'Approved by office · Locked' : s.status === 'rejected' ? 'Correction requested' : 'Awaiting office approval'}</p>${s.notes || s.amendmentReason ? `<p class="work-summary">${esc(s.notes ?? s.amendmentReason)}</p>` : ''}${!s.locked && s.status !== 'approved' ? `<button class="btn plain" data-edit="${esc(s.id)}">Amend time</button>` : ''}</div>`).join('')}
      ${timeOnly ? '' : `<div class="completion-action"><p class="muted">Saving time leaves the job open.</p><button class="btn plain" data-work="complete">${completion?.jobCompleted ? 'View completion / customer sign-off' : 'Complete job / work area'}</button></div>`}`}
      <button class="btn secondary" data-work="refresh">Refresh time entries</button>`);
    host.querySelector('[data-task]')?.addEventListener('change', e => { taskId = e.target.value; renderTimer(); });
    bind('amend-active', () => ownActive ? showAmend(active) : openVisit(active.jobId, active.jobDate));
    bind('start', () => post('work/start', {jobDate: date, taskId}, 'Work started.'));
    bind('pause-resume', () => post(active.onBreak ? 'work/resume' : 'work/pause', {sessionId: active.id, expectedVersion: active.version}, 'Clock change saved.'));
    bind('stop', () => post('work/stop', {sessionId: active.id, expectedVersion: active.version}, 'Work finished. Net time saved for office approval.'));
    bind('add', () => showAmend(null)); bind('refresh', refresh);
    bind('complete', () => { pending = null; view = 'complete'; error = ''; message = ''; renderCompletion(); });
    host.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => { if (!busy) showAmend(work.sessions.find(s => s.id === button.dataset.edit)); });
  }
  function showAmend(session) {
    if (session?.locked || session?.status === 'approved') return;
    editor = session; view = 'amend'; error = ''; message = '';
    let breakEdited = false;
    if (session) taskId = session.taskId;
    frame(session ? 'Amend work time' : 'Add time', `<form data-amend><p>${esc(job.tasks.find(t => t.id === taskId)?.name)} · ${esc(date)}</p><div class="grid"><label>Start time<input name="start" type="time" value="${session?.startedAt ? clock(session.startedAt) : ''}" required></label><label>End time<input name="finish" type="time" value="${session?.stoppedAt ? clock(session.stoppedAt) : ''}" required></label></div><label>End date<input name="finishDate" type="date" value="${session?.stoppedAt ? londonDay(session.stoppedAt) : esc(date)}" required></label>${session?.breakDurationMs ? `<p>Recorded unpaid break: ${breakLabel(session)}. It stays unchanged unless you edit this field.</p>` : ''}<label>Unpaid break minutes<input name="breakMinutes" type="number" min="0" max="1439" step="1" value="${session?.breakMinutes ?? 0}" required></label><label>Notes (optional)<textarea name="notes" maxlength="500" placeholder="Anything the office should know">${esc(session?.notes ?? session?.amendmentReason ?? '')}</textarea></label><button class="btn" type="submit">Save time</button><button class="btn secondary" type="button" data-work="cancel">Cancel</button></form>`);
    host.querySelector('[name="breakMinutes"]').addEventListener('input', () => {breakEdited = true;});
    bind('cancel', () => { view = 'timer'; error = ''; renderTimer(); });
    host.querySelector('[data-amend]').onsubmit = e => {
      e.preventDefault(); const values = Object.fromEntries(new FormData(e.target));
      post('work/amend', { jobDate: date, taskId, start: values.start, finish: values.finish, finishDate: values.finishDate, ...(!editor || breakEdited || !editor.clock ? {breakMinutes: Number(values.breakMinutes)} : {}), notes: values.notes.trim(), ...(editor ? { [editor.legacy ? 'legacyEntryId' : 'sessionId']: editor.id, expectedVersion: editor.version } : {}) }, 'Time saved for office approval.');
    };
  }
  function recordsHTML() {
    return `<div class="completion-records"><h3>Completion records</h3>${!completion.records.length ? '<p class="muted">No completion has been recorded yet.</p>' : completion.records.map(r => `<article class="visit"><h3>${r.scope === 'job' ? 'Whole job' : esc(r.taskNames.join(', '))}</h3><p class="work-summary">${esc(r.workSummary)}</p><p class="muted">${esc(r.engineerName)} · ${timestamp(r.createdAt)}</p><p><b>${r.status === 'signed' ? `Signed by ${esc(r.customerName)}` : 'Customer sign-off outstanding'}</b></p>${r.status === 'signed' ? `<p class="muted">${timestamp(r.signedAt)}</p>` : `<p>${esc(r.unavailableReason)}</p><button class="btn secondary" data-sign="${esc(r.id)}" type="button">Add customer sign-off</button>`}</article>`).join('')}</div>`;
  }
  async function showRequiredForms() {
    const out = host.querySelector('[data-required-forms]');
    if (!out || pending) return;
    const current = ++formSequence;
    out.innerHTML = '<p class="muted">Checking the forms assigned to this visit…</p>';
    try {
      const forms = await request(endpoint(`forms?date=${encodeURIComponent(date)}`));
      if (!available() || !out.isConnected || current !== formSequence) return;
      const outstanding = forms.filter(form => form.status !== 'completed');
      if (!outstanding.length) {
        out.innerHTML = forms.length ? '<p class="success">The required forms for this visit are complete.</p>' : '';
        return;
      }
      out.innerHTML = `<div class="notice"><h3>Required forms for this visit</h3><p>Complete the outstanding forms for this work before asking the customer to sign.</p>${outstanding.map((form, index) => `<button type="button" class="btn plain" data-required-form="${index}">${esc(form.name)} · ${form.status === 'unsafe' ? 'STOP recorded — view form' : 'Open form'}</button>`).join('')}<p class="muted">If a form does not apply to this work, the office needs to correct the form assigned in the schedule.</p></div>`;
      out.querySelectorAll('[data-required-form]').forEach(button => {
        button.onclick = () => { if (!busy && openForms) openForms(outstanding[Number(button.dataset.requiredForm)]); };
      });
    } catch (failure) {
      if (!available() || !out.isConnected || current !== formSequence) return;
      out.innerHTML = `<div class="notice"><p>Could not check the visit's forms: ${esc(failure.message)}</p><button type="button" class="btn plain" data-open-forms>Open Gas Safe forms</button></div>`;
      out.querySelector('[data-open-forms]').onclick = () => { if (!busy && openForms) openForms(); };
    }
  }
  function renderCompletion() {
    if (!completion) { view = 'timer'; renderTimer(); return; }
    const selected = new Set(completion.tasks.filter(t => t.assigned && !t.complete).map(t => t.id));
    const canCreate = !completion.jobCompleted && (selected.size > 0 || completion.tasks.every(t => t.complete));
    const showForm = pending || canCreate;
    frame('Complete work & sign off', `<button type="button" class="back" data-work="timer">‹ Back to work time</button>${pending ? '' : '<div data-required-forms role="status"></div>'}${showForm ? `<form data-completion>
      ${pending ? `<div class="visit"><h3>Customer sign-off outstanding</h3><p><b>${esc(pending.taskNames.join(', '))}</b></p><p class="work-summary">${esc(pending.workSummary)}</p><p class="muted">Recorded by ${esc(pending.engineerName)}</p></div>` : `
      <h3>Which work is complete?</h3>${completion.tasks.map(t => `<label class="work-choice"><input type="checkbox" data-complete-task value="${esc(t.id)}" ${t.complete || selected.has(t.id) ? 'checked' : ''} ${t.complete || !t.assigned ? 'disabled' : ''}><span>${esc(t.name)}<small>${t.complete ? 'Work complete' : t.assigned ? 'Assigned to you' : 'Other work still open'}</small></span></label>`).join('')}
      <label class="work-choice"><input type="checkbox" name="wholeJob" ${completion.tasks.length === 1 && completion.tasks[0].assigned ? 'checked' : ''}><span>This completes the whole job<small data-whole-help>Tick only when no further work is needed on the job.</small></span></label>
      <label>Completed work and any outstanding items (required)<textarea name="workSummary" maxlength="2000" required placeholder="Describe the work for the customer to check"></textarea></label>
      <label class="work-choice"><input type="checkbox" name="unavailable"><span>Customer unavailable / unable to sign</span></label>
      <div data-absence hidden><label>Why is sign-off outstanding? (required)<textarea name="unavailableReason" maxlength="500"></textarea></label><p class="muted">The work will be recorded as complete, with customer sign-off outstanding.</p></div>`}
      <div data-signature-fields><label>Customer name (required)<input name="customerName" autocomplete="name" maxlength="120" required></label><p class="consent">${esc(pending?.consentText ?? completion.consentText)}</p><label class="work-choice"><input name="consentAccepted" type="checkbox" required><span>Customer confirms the statement above (required)</span></label><p><b>Customer signature (required)</b></p><svg data-signature role="img" aria-label="Customer signature drawing area" viewBox="0 0 320 180" preserveAspectRatio="none"><text data-hint x="160" y="94" text-anchor="middle">Sign here with a finger</text><g data-strokes></g></svg><button class="btn plain" type="button" data-work="clear" disabled>Clear signature</button></div>
      <p class="muted" id="completion-help" data-completion-help role="status"></p>
      <button class="btn" type="submit" data-save-completion aria-describedby="completion-help" disabled>Save customer sign-off</button>${pending ? '<button class="btn secondary" type="button" data-work="cancel-sign">Cancel sign-off</button>' : ''}
      </form>` : `<p class="muted">${completion.jobCompleted ? 'This job is complete. Any outstanding customer signature can be added below.' : 'There are no open work areas assigned to you on this visit.'}</p>`}${recordsHTML()}`);
    bind('timer', () => { view = 'timer'; pending = null; error = ''; renderTimer(); });
    bind('cancel-sign', () => { pending = null; error = ''; renderCompletion(); });
    host.querySelectorAll('[data-sign]').forEach(button => button.onclick = () => { if (!busy) { pending = completion.records.find(r => r.id === button.dataset.sign); error = ''; message = ''; renderCompletion(); } });
    if (!pending) void showRequiredForms();
    if (!showForm) return;
    const form = host.querySelector('[data-completion]'), save = form.querySelector('[data-save-completion]');
    const field = name => form.elements.namedItem(name);
    const svg = form.querySelector('[data-signature]'), strokes = form.querySelector('[data-strokes]');
    let signature = [], pointer = null;
    const taskIds = () => [...form.querySelectorAll('[data-complete-task]:checked')].filter(t => !t.disabled).map(t => t.value);
    const absent = () => !pending && field('unavailable').checked;
    function validate() {
      const unavailable = absent();
      if (!pending) {
        const otherOpen = completion.tasks.some(t => !t.complete && !taskIds().includes(t.id));
        field('wholeJob').disabled = otherOpen;
        if (otherOpen) field('wholeJob').checked = false;
        form.querySelector('[data-whole-help]').textContent = otherOpen ? 'Other work areas must be completed first.' : 'Tick only when no further work is needed on the job.';
        form.querySelector('[data-absence]').hidden = !unavailable;
        field('unavailableReason').required = unavailable;
      }
      form.querySelector('[data-signature-fields]').hidden = unavailable;
      field('customerName').required = !unavailable; field('consentAccepted').required = !unavailable;
      save.textContent = pending ? 'Save customer sign-off' : unavailable ? (field('wholeJob').checked ? 'Complete job · sign-off outstanding' : 'Complete work area · sign-off outstanding') : field('wholeJob').checked ? 'Complete job & save sign-off' : 'Complete work area & save sign-off';
      const missing = [];
      if (!pending) {
        if (!field('workSummary').value.trim()) missing.push('description of the completed work');
        if (!taskIds().length && !field('wholeJob').checked) missing.push('work area to complete');
      }
      if (unavailable) {
        if (!field('unavailableReason').value.trim()) missing.push('reason the customer cannot sign');
      } else {
        if (!field('customerName').value.trim()) missing.push('customer name');
        if (!field('consentAccepted').checked) missing.push('customer confirmation tick');
        if (signature.flat().length < 8) missing.push('customer signature');
      }
      const help = form.querySelector('[data-completion-help]');
      help.hidden = missing.length === 0;
      help.textContent = missing.length ? `Still needed: ${missing.join('; ')}.` : '';
      save.disabled = missing.length > 0;
    }
    function paint() {
      strokes.replaceChildren();
      for (const stroke of signature) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        line.setAttribute('points', stroke.map(p => `${p.x * 320},${p.y * 180}`).join(' ')); strokes.append(line);
      }
      form.querySelector('[data-hint]').style.display = signature.length ? 'none' : '';
      form.querySelector('[data-work="clear"]').disabled = !signature.length; validate();
    }
    const point = e => { const r = svg.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
    svg.onpointerdown = e => {
      if (busy || pointer !== null || e.button !== 0 || signature.length >= 50 || signature.flat().length >= 2500) return;
      e.preventDefault(); pointer = e.pointerId; svg.setPointerCapture?.(pointer); signature.push([point(e)]); paint();
    };
    svg.onpointermove = e => {
      if (busy || pointer !== e.pointerId || signature.flat().length >= 2500) return;
      e.preventDefault(); const p = point(e), stroke = signature[signature.length - 1], previous = stroke[stroke.length - 1];
      if (Math.abs(p.x - previous.x) + Math.abs(p.y - previous.y) < 0.003) return;
      stroke.push(p); paint();
    };
    const end = e => { if (pointer === e.pointerId) { if (svg.hasPointerCapture?.(pointer)) svg.releasePointerCapture(pointer); pointer = null; } };
    svg.onpointerup = end; svg.onpointercancel = end; svg.onlostpointercapture = () => { pointer = null; };
    bind('clear', () => { signature = []; pointer = null; paint(); });
    form.oninput = validate;
    form.onchange = e => { if (e.target.name === 'unavailable') { signature = []; field('consentAccepted').checked = false; paint(); } validate(); };
    form.onsubmit = e => {
      e.preventDefault(); validate(); if (save.disabled || busy) return;
      const signed = { customerName: field('customerName').value.trim(), signature, consentAccepted: field('consentAccepted').checked };
      const input = pending ? { jobDate: date, completionId: pending.id, ...signed } : { jobDate: date, taskIds: taskIds(), wholeJob: field('wholeJob').checked, workSummary: field('workSummary').value.trim(), ...(absent() ? { unavailableReason: field('unavailableReason').value.trim() } : signed) };
      post(pending ? 'completions/sign' : 'completions/complete', input, r => `${r.jobCompleted ? 'Job complete' : 'Work area complete'}. ${r.status === 'signed' ? 'Customer sign-off saved to Blake.' : 'Customer sign-off remains outstanding in Blake.'}`);
    };
    validate();
  }
  const onVisible = () => { if (document.visibilityState === 'visible' && !busy) void refresh(); };
  const onFocus = () => { if (!busy) void refresh(); };
  document.addEventListener('visibilitychange', onVisible); window.addEventListener('focus', onFocus);
  dispose = () => { disposed = true; sequence++; document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onFocus); };
  renderTimer(); void refresh();
}

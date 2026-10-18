const acceptedTypes = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
};
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[c]));

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('This file could not be read. Please choose it again.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

export function renderFiles(host, { jobId, date, request }) {
  host.innerHTML = `<form class="card" id="fileform">
    <h2>Photo or document</h2>
    <p class="muted">Choose a photo or PDF, up to 10 MB.</p>
    <div class="upload-choices" role="group" aria-label="Choose a photo or document">
      <button type="button" class="btn secondary" data-picker="camera">Take photo</button>
      <button type="button" class="btn secondary" data-picker="photos">Photo library</button>
      <button type="button" class="btn plain" data-picker="file">Upload file</button>
    </div>
    <input id="camera" type="file" accept="image/*" capture="environment" aria-label="Take photo" hidden>
    <input id="photos" type="file" accept="image/*" aria-label="Photo library" multiple hidden>
    <input id="file" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif,.pdf" aria-label="Upload file" multiple hidden>
    <p class="file-selection muted" data-selection role="status">No photo or file selected.</p>
    <button class="btn" type="submit" disabled>Add to this job</button>
    <div id="formmsg" role="status"></div>
  </form><div id="existing" class="loading">Loading files…</div>`;

  const form = host.querySelector('#fileform');
  const message = form.querySelector('#formmsg');
  const selection = form.querySelector('[data-selection]');
  const submit = form.querySelector('[type="submit"]');
  const pickers = [...form.querySelectorAll('[data-picker]')];
  const inputs = [...form.querySelectorAll('[type="file"]')];
  const existing = host.querySelector('#existing');
  const path = `/v1/jobs/${encodeURIComponent(jobId)}/files`;
  let selected = [], busy = false, listSequence = 0;

  function showMessage(text, kind = 'success') {
    if (!form.isConnected) return;
    message.className = kind;
    message.textContent = text;
  }

  function updateSelection() {
    selection.textContent = selected.length
      ? selected.map(({ file }) => `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`).join('\n')
      : 'No photo or file selected.';
    selection.style.whiteSpace = 'pre-wrap';
    submit.disabled = busy || !selected.length;
    pickers.forEach(button => { button.disabled = busy; });
  }

  pickers.forEach(button => {
    button.onclick = () => {
      if (busy) return;
      const input = form.querySelector(`#${button.dataset.picker}`);
      // Keep the native picker in this tap's synchronous user gesture.
      // Retain the chosen File separately so cancelling keeps the selection.
      input.value = '';
      input.click();
    };
  });

  inputs.forEach(input => {
    input.onchange = () => {
      if (busy) return;
      const files = [...(input.files || [])];
      if (!files.length) return;
      if (files.length > 20) {
        showMessage('Choose up to 20 photos or files at a time.', 'error');
        return;
      }
      const batch = [];
      for (const file of files) {
        const mimeType = file.type || acceptedTypes[file.name.split('.').pop().toLowerCase()];
        if (!Object.values(acceptedTypes).includes(mimeType)) {
          showMessage('Choose a JPG, PNG, WebP, HEIC, HEIF photo or a PDF.', 'error');
          return;
        }
        if (file.size > 10 * 1024 * 1024) {
          showMessage('Choose a photo or file no larger than 10 MB.', 'error');
          return;
        }
        batch.push({ file, mimeType });
      }
      selected = batch;
      showMessage('', '');
      updateSelection();
    };
  });

  async function refreshFiles() {
    const sequence = ++listSequence;
    try {
      const list = await request(`${path}?date=${encodeURIComponent(date)}`);
      if (!existing.isConnected || sequence !== listSequence) return;
      existing.className = 'card';
      existing.innerHTML = `<h2>Files on this job</h2>${list?.length ? list.map(file => {
        const name = esc(file.fileName || file.name || 'File');
        return `<p>${file.url?.startsWith('https://')
          ? `<a href="${esc(file.url)}" target="_blank" rel="noopener">${name}</a>`
          : name}</p>`;
      }).join('') : '<p class="muted">No files yet.</p>'}`;
    } catch (error) {
      if (!existing.isConnected || sequence !== listSequence) return;
      existing.className = 'error';
      existing.textContent = error.message;
    }
  }

  form.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    if (!selected.length) {
      showMessage('Choose a photo or PDF first.', 'error');
      return;
    }
    busy = true;
    updateSelection();
    showMessage('Uploading…', 'notice');
    try {
      const count = selected.length;
      for (let index = 0; selected.length; index++) {
        const { file, mimeType } = selected[0];
        showMessage(`Uploading ${index + 1} of ${count}: ${file.name}`, 'notice');
        const base64 = await toBase64(file);
        await request(path, {
          method: 'POST',
          body: JSON.stringify({ jobDate: date, fileName: file.name, mimeType, base64 }),
        });
        selected.shift();
        if (!form.isConnected) return;
        updateSelection();
      }
      if (!form.isConnected) return;
      inputs.forEach(input => { input.value = ''; });
      showMessage(`${count} file${count === 1 ? '' : 's'} attached to this job.`);
      refreshFiles();
    } catch (error) {
      showMessage(`${error.message} ${selected.length} file${selected.length === 1 ? '' : 's'} remaining to upload.`, 'error');
      refreshFiles();
    } finally {
      busy = false;
      if (form.isConnected) updateSelection();
    }
  };

  // Choosing and uploading remain available while saved files load.
  refreshFiles();
}

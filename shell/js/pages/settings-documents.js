// Settings > My Documents: files and folders the Ulejra assistant may search. They are read and
// indexed on this computer (~/.ulejra/documents); only passages a search returns go to the model.
(function () {
  const apiBase = () =>
    window.tandemApi?.baseUrl?.() || window.__TANDEM_API_BASE__ || 'http://127.0.0.1:8765';
  const esc = window.tandemEscape.escapeHtml;
  // settings.js defines showToast as a global function.
  const toast = (message) => window.showToast?.(message);

  let pollTimer = null;

  async function call(method, path, body) {
    const res = await fetch(`${apiBase()}/integrations/ulejra/documents${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `The request failed (${res.status}).`);
    return json;
  }

  function sourceLine(source) {
    if (source.pending > 0) {
      return `Reading… ${source.ready} of ${source.documents} ready`;
    }
    const parts = [];
    if (source.kind === 'folder') {
      parts.push(`${source.ready} ${source.ready === 1 ? 'file' : 'files'} ready`);
    } else if (source.ready) {
      parts.push('Ready');
    }
    if (source.noText) {
      parts.push(`${source.noText} ${source.noText === 1 ? 'photo' : 'photos'} without text`);
    }
    if (source.errors) parts.push(`${source.errors} could not be read`);
    if (source.documents === 0) parts.push('No supported files found');
    return parts.join(' · ');
  }

  function ocrLine(status) {
    if (status.ocr) {
      const { name, done, total } = status.ocr;
      return `Reading scanned pages with text recognition: ${name}, page ${Math.min(done + 1, total)} of ${total}`;
    }
    if (status.totals.ocr > 0) {
      return `${status.totals.ocr} scanned ${status.totals.ocr === 1 ? 'PDF waits' : 'PDFs wait'} for text recognition`;
    }
    return '';
  }

  function modelLine(status) {
    const model = status.model || { state: 'idle' };
    const { chunks, embedded } = status.totals;
    if (model.state === 'loading' && model.total) {
      const pct = Math.min(100, Math.round((model.downloaded / model.total) * 100));
      return `Downloading the search model (once, about ${Math.round(model.total / 1e6)} MB): ${pct}%`;
    }
    if (model.state === 'loading') return 'Starting the search model…';
    if (model.state === 'unavailable') {
      return 'Search by meaning is not available on this computer right now; search by keywords still works.';
    }
    if (chunks > 0 && embedded < chunks) return `Preparing search by meaning: ${embedded} of ${chunks} passages`;
    if (chunks > 0) return 'Search by meaning and by keywords is ready.';
    return '';
  }

  function render(status) {
    const list = document.getElementById('documents-list');
    const empty = document.getElementById('documents-empty');
    const modelEl = document.getElementById('documents-model');
    if (!list) return;
    empty.hidden = status.sources.length > 0;
    list.innerHTML = status.sources
      .map(
        (source) => `
        <div class="field documents-item">
          <div class="field-info">
            <div class="field-label">${source.kind === 'folder' ? '📁' : '📄'} ${esc(source.name)}</div>
            <div class="field-desc documents-path" title="${esc(source.path)}">${esc(source.path)}</div>
            <div class="field-desc">${esc(sourceLine(source))}</div>
            ${source.firstError ? `<div class="field-desc documents-error">${esc(source.firstError)}</div>` : ''}
            ${
              source.kind === 'folder'
                ? `<label class="field-desc documents-photos">
                    <input type="checkbox" data-include-images="${source.id}" ${source.includeImages ? 'checked' : ''}>
                    Read photos in this folder (JPG, PNG, HEIC…) with text recognition
                  </label>`
                : ''
            }
          </div>
          <button class="btn btn-sm btn-secondary" type="button" data-remove-source="${source.id}">Remove</button>
        </div>`,
      )
      .join('');
    modelEl.textContent = [ocrLine(status), modelLine(status)].filter(Boolean).join(' · ');
    modelEl.hidden = !modelEl.textContent;

    const busy =
      status.indexing ||
      Boolean(status.ocr) ||
      status.totals.pending > 0 ||
      status.model?.state === 'loading' ||
      (status.totals.chunks > 0 && status.totals.embedded < status.totals.chunks && status.model?.state !== 'unavailable');
    clearTimeout(pollTimer);
    if (busy) pollTimer = setTimeout(load, 1500);
  }

  async function load() {
    try {
      render(await call('GET', ''));
    } catch (error) {
      const empty = document.getElementById('documents-empty');
      if (empty) {
        empty.hidden = false;
        empty.textContent = error.message;
      }
    }
  }

  async function add(kind, button) {
    button.disabled = true;
    try {
      const result = await call('POST', '/add', { kind });
      render(result);
      if (!result.canceled && result.skipped?.length) {
        toast(`${result.skipped.length} file(s) skipped: only PDF, Word, text, Markdown, CSV and JSON are supported`);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById('btn-documentsAddFiles')?.addEventListener('click', (e) => add('files', e.currentTarget));
  document.getElementById('btn-documentsAddFolder')?.addEventListener('click', (e) => add('folder', e.currentTarget));
  document.getElementById('btn-documentsRefresh')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      render(await call('POST', '/refresh'));
      toast('Checking for new and changed files');
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('documents-list')?.addEventListener('change', async (e) => {
    const box = e.target.closest('[data-include-images]');
    if (!box) return;
    box.disabled = true;
    try {
      render(await call('PATCH', `/sources/${box.dataset.includeImages}`, { includeImages: box.checked }));
      toast(box.checked ? 'Reading the photos in this folder' : 'Photos in this folder are no longer searched');
    } catch (error) {
      box.checked = !box.checked;
      toast(error.message);
    } finally {
      box.disabled = false;
    }
  });
  document.getElementById('documents-list')?.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-remove-source]');
    if (!button) return;
    button.disabled = true;
    try {
      render(await call('DELETE', `/sources/${button.dataset.removeSource}`));
      toast('Removed from My Documents (your file is not deleted)');
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  });

  load();
})();

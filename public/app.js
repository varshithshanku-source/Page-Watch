const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { monitors: [], filter: 'all', search: '', sortRecentFirst: true, activeMonitor: null, versions: [], pickerTarget: null, pickerChoice: null, toastTimer: null };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function hostname(value) {
  try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return value; }
}

function dateParts(value) {
  if (!value) return { main: 'Not yet', sub: 'Waiting for first check' };
  const date = new Date(value);
  const elapsed = Date.now() - date.getTime();
  const main = elapsed < 60000 ? 'Just now' : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)} min ago` : elapsed < 86400000 ? `${Math.floor(elapsed / 3600000)} hr ago` : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { main, sub: date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) };
}

function isToday(value) {
  if (!value) return false;
  const date = new Date(value);
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

function intervalLabel(minutes) {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function monitorStatus(monitor) {
  if (monitor.status === 'error' || monitor.status === 'blocked' || monitor.status === 'queued') return monitor.status;
  if (isToday(monitor.last_changed)) return 'changed';
  return 'ok';
}

function render() {
  $('#monitor-count').textContent = state.monitors.length;
  $('#stat-total').textContent = state.monitors.length;
  $('#stat-changes').textContent = state.monitors.filter(monitor => isToday(monitor.last_changed)).length;
  $('#stat-issues').textContent = state.monitors.filter(monitor => ['error', 'blocked'].includes(monitor.status)).length;
  const normalizedSearch = state.search.toLowerCase();
  let monitors = state.monitors.filter(monitor => {
    const status = monitorStatus(monitor);
    const matchesFilter = state.filter === 'all' || (state.filter === 'changed' && isToday(monitor.last_changed)) || (state.filter === 'issues' && ['error', 'blocked'].includes(status));
    const matchesSearch = !normalizedSearch || `${monitor.name} ${monitor.url}`.toLowerCase().includes(normalizedSearch);
    return matchesFilter && matchesSearch;
  });
  monitors.sort((a, b) => {
    const left = new Date(a.last_checked || a.created_at).getTime();
    const right = new Date(b.last_checked || b.created_at).getTime();
    return state.sortRecentFirst ? right - left : left - right;
  });
  $('#monitor-rows').innerHTML = monitors.map((monitor, index) => {
    const checked = dateParts(monitor.last_checked);
    const changed = dateParts(monitor.last_changed);
    const status = monitorStatus(monitor);
    const statusText = { ok: 'OK', changed: 'Changed', error: 'Error', blocked: 'Blocked', queued: 'Queued' }[status];
    const initial = hostname(monitor.url).slice(0, 2).toUpperCase();
    return `<tr class="monitor-row" style="animation-delay:${Math.min(index * 25, 175)}ms">
      <td><div class="page-cell"><span class="site-monogram">${escapeHtml(initial)}</span><div class="page-description"><button class="monitor-name open-history" data-id="${escapeHtml(monitor.id)}">${escapeHtml(monitor.name)}</button><div class="monitor-url">${escapeHtml(hostname(monitor.url))}</div></div></div></td>
      <td><span class="status-pill ${status}" title="${escapeHtml(monitor.last_error || '')}">${statusText}</span></td>
      <td><span class="time-main">${checked.main}</span><span class="time-sub">${checked.sub}</span></td>
      <td><span class="time-main">${monitor.last_changed ? changed.main : 'No changes yet'}</span><span class="time-sub">${monitor.last_changed ? changed.sub : `${monitor.snapshots} saved versions`}</span></td>
      <td class="interval-cell">${intervalLabel(monitor.interval_minutes)}</td>
      <td><div class="row-actions"><button class="more-button delete-monitor" data-id="${escapeHtml(monitor.id)}" title="Remove monitor" aria-label="Remove ${escapeHtml(monitor.name)}">···</button></div></td>
    </tr>`;
  }).join('');
  const noMonitors = state.monitors.length === 0;
  $('#empty-state').hidden = !noMonitors;
  $('.monitor-table').hidden = noMonitors || (monitors.length === 0);
  $('#no-results').hidden = noMonitors || monitors.length > 0;
  $$('.filter-tab').forEach(button => button.classList.toggle('selected', button.dataset.filter === state.filter));
}

async function refresh() {
  try {
    const [monitors, health] = await Promise.all([api('/api/monitors'), api('/api/health')]);
    state.monitors = monitors;
    const status = $('.top-status');
    status.innerHTML = `<span class="live-dot ${health.browser_ready ? '' : 'offline-dot'}"></span>${health.browser_ready ? 'All systems operational' : 'Browser setup required'}`;
    status.title = health.browser_error || 'Monitoring service status';
    for (const button of [$('#add-monitor'), $('#empty-add')]) {
      button.disabled = !health.browser_ready;
      button.title = health.browser_ready ? '' : health.browser_error;
    }
    render();
  } catch (error) {
    showToast(error.message);
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  document.getElementById(id).close();
}

function formatDate(value) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function showHistory(monitorId) {
  const monitor = state.monitors.find(item => item.id === monitorId);
  if (!monitor) return;
  state.activeMonitor = monitor;
  state.versions = await api(`/api/monitors/${monitorId}/snapshots`);
  $('#history-title').textContent = monitor.name;
  $('#history-url').href = monitor.url;
  $('#history-url').textContent = monitor.url;
  $('#version-count').textContent = state.versions.length;
  $('#timeline').innerHTML = state.versions.map((version, index) => `<button class="timeline-item ${index === 0 ? 'selected' : ''}" data-version="${escapeHtml(version.id)}"><span class="timeline-point"></span><span><strong>${index === 0 ? 'Latest version' : 'Content updated'}</strong><small>${formatDate(version.created_at)}</small></span></button>`).join('') || '<div class="compare-placeholder">The first saved version will appear here.</div>';
  const options = state.versions.map(version => `<option value="${escapeHtml(version.id)}">${formatDate(version.created_at)}</option>`).join('');
  $('#older-version').innerHTML = options;
  $('#newer-version').innerHTML = options;
  $('#older-version').disabled = state.versions.length < 2;
  $('#newer-version').disabled = state.versions.length < 2;
  if (state.versions.length > 1) {
    $('#older-version').value = state.versions[1].id;
    $('#newer-version').value = state.versions[0].id;
    renderComparison();
  } else {
    $('#comparison').innerHTML = '<div class="compare-placeholder">A second version will unlock comparison.</div>';
  }
  openDialog('history-dialog');
}

function renderComparison() {
  const older = state.versions.find(version => version.id === $('#older-version').value);
  const newer = state.versions.find(version => version.id === $('#newer-version').value);
  if (!older || !newer || older.id === newer.id) {
    $('#comparison').innerHTML = '<div class="compare-placeholder">Choose two different versions to compare.</div>';
    return;
  }
  const parts = Diff.diffWords(older.text, newer.text);
  let added = 0;
  let removed = 0;
  const diffHtml = parts.map(part => {
    if (part.added) { added += part.value.trim().split(/\s+/).filter(Boolean).length; return `<ins>${escapeHtml(part.value)}</ins>`; }
    if (part.removed) { removed += part.value.trim().split(/\s+/).filter(Boolean).length; return `<del>${escapeHtml(part.value)}</del>`; }
    return escapeHtml(part.value);
  }).join('');
  const oldImage = older.screenshot ? `<img src="/screenshots/${encodeURIComponent(older.screenshot)}" alt="Page screenshot from ${escapeHtml(formatDate(older.created_at))}">` : '<div class="no-image">No screenshot saved</div>';
  const newImage = newer.screenshot ? `<img src="/screenshots/${encodeURIComponent(newer.screenshot)}" alt="Page screenshot from ${escapeHtml(formatDate(newer.created_at))}">` : '<div class="no-image">No screenshot saved</div>';
  const pixelDiff = older.screenshot && newer.screenshot
    ? `<details class="visual-diff"><summary>Show highlighted pixel differences</summary><div class="visual-diff-stage"><img class="visual-old" src="/screenshots/${encodeURIComponent(older.screenshot)}" alt="Older page screenshot"><img class="visual-new" src="/screenshots/${encodeURIComponent(newer.screenshot)}" alt="Pixel differences between versions"></div><small>Bright areas mark pixels that changed.</small></details>`
    : '';
  $('#comparison').innerHTML = `<div class="change-summary"><strong>+${added} / −${removed}</strong> words changed between these versions</div><div class="text-diff">${diffHtml}</div>${pixelDiff}<div class="image-compare"><div class="image-version"><span>OLDER · ${formatDate(older.created_at)}</span>${oldImage}</div><div class="image-version"><span>NEWER · ${formatDate(newer.created_at)}</span>${newImage}</div></div>`;
}

async function startPicker(target) {
  const url = $('#monitor-form').elements.url.value.trim();
  if (!url) {
    $('#form-error').hidden = false;
    $('#form-error').textContent = 'Enter the public page URL before picking a region.';
    return;
  }
  state.pickerTarget = target;
  state.pickerChoice = null;
  $('#picker-stage').replaceChildren();
  $('#picker-error').hidden = true;
  $('#picker-selected').textContent = 'Loading page preview…';
  $('#apply-region').disabled = true;
  openDialog('picker-dialog');
  try {
    const result = await api('/api/inspect', { method: 'POST', body: JSON.stringify({ url }) });
    const image = document.createElement('img');
    image.src = `data:image/png;base64,${result.screenshot}`;
    image.alt = 'Public page screenshot with selectable regions';
    const stage = $('#picker-stage');
    stage.append(image);
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    for (const region of result.regions) {
      const overlay = document.createElement('button');
      overlay.type = 'button';
      overlay.className = 'picker-overlay';
      overlay.style.left = `${region.x / width * 100}%`;
      overlay.style.top = `${region.y / height * 100}%`;
      overlay.style.width = `${Math.max(0.2, region.width / width * 100)}%`;
      overlay.style.height = `${Math.max(0.2, region.height / height * 100)}%`;
      overlay.setAttribute('aria-label', `${region.selector} · ${region.text}`);
      overlay.title = region.selector;
      overlay.addEventListener('click', () => {
        $$('.picker-overlay', stage).forEach(item => item.classList.remove('chosen'));
        overlay.classList.add('chosen');
        state.pickerChoice = region.selector;
        $('#picker-selected').textContent = region.selector;
        $('#apply-region').disabled = false;
      });
      stage.append(overlay);
    }
    $('#picker-selected').textContent = result.regions.length ? 'Select a region in the preview.' : 'No selectable page regions found.';
  } catch (error) {
    $('#picker-error').hidden = false;
    $('#picker-error').textContent = error.message;
    $('#picker-selected').textContent = 'Could not load the page preview.';
  }
}

$('#add-monitor').addEventListener('click', () => openDialog('monitor-dialog'));
$('#empty-add').addEventListener('click', () => openDialog('monitor-dialog'));
$('#open-settings').addEventListener('click', async () => {
  try {
    const settings = await api('/api/settings');
    $('#settings-form').elements.webhooks.value = settings.webhooks;
    $('#settings-form').elements.email.value = settings.email;
    $('#email-readiness').textContent = settings.email_ready ? 'SMTP is configured' : 'Requires SMTP_URL on the server';
    openDialog('settings-dialog');
  } catch (error) { showToast(error.message); }
});
$('#policy-link').addEventListener('click', () => openDialog('policy-dialog'));
$('#refresh-button').addEventListener('click', refresh);
$('#nav-monitors').addEventListener('click', () => {
  state.filter = 'all';
  $('#current-view').textContent = 'Monitors';
  $('#page-title').textContent = 'Your watchlist';
  $('#page-subtitle').textContent = 'Quietly keeping an eye on the pages that matter.';
  render();
});
$('#nav-changes').addEventListener('click', () => {
  state.filter = 'changed';
  $('#current-view').textContent = 'Recent changes';
  $('#page-title').textContent = 'Recent changes';
  $('#page-subtitle').textContent = 'Meaningful updates found in your watchlist today.';
  render();
});
$$('.filter-tab').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; render(); }));
$('#search-input').addEventListener('input', event => { state.search = event.target.value; render(); });
$('#sort-button').addEventListener('click', () => {
  state.sortRecentFirst = !state.sortRecentFirst;
  $('#sort-button').innerHTML = `${state.sortRecentFirst ? 'Recently checked' : 'Least recently checked'} <span>⌄</span>`;
  render();
});
$('#monitor-rows').addEventListener('click', async event => {
  const open = event.target.closest('.open-history');
  if (open) {
    try { await showHistory(open.dataset.id); } catch (error) { showToast(error.message); }
    return;
  }
  const remove = event.target.closest('.delete-monitor');
  if (remove) {
    const monitor = state.monitors.find(item => item.id === remove.dataset.id);
    if (!monitor || !confirm(`Remove “${monitor.name}” and its saved versions?`)) return;
    try {
      await api(`/api/monitors/${monitor.id}`, { method: 'DELETE' });
      await refresh();
      showToast('Monitor removed.');
    } catch (error) { showToast(error.message); }
  }
});
$('#monitor-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  $('#form-error').hidden = true;
  const submit = $('button[type="submit"]', event.currentTarget);
  submit.disabled = true;
  try {
    await api('/api/monitors', { method: 'POST', body: JSON.stringify(body) });
    closeDialog('monitor-dialog');
    event.currentTarget.reset();
    await refresh();
    showToast('Page added to your watchlist.');
  } catch (error) {
    $('#form-error').hidden = false;
    $('#form-error').textContent = error.message;
  } finally { submit.disabled = false; }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  $('#settings-error').hidden = true;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) });
    closeDialog('settings-dialog');
    showToast('Alert settings saved.');
  } catch (error) {
    $('#settings-error').hidden = false;
    $('#settings-error').textContent = error.message;
  }
});
$$('[data-close]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.close)));
$$('[data-pick]').forEach(button => button.addEventListener('click', () => startPicker(button.dataset.pick)));
$('#apply-region').addEventListener('click', () => {
  if (!state.pickerChoice) return;
  $('#monitor-form').elements[state.pickerTarget].value = state.pickerChoice;
  closeDialog('picker-dialog');
});
$('#older-version').addEventListener('change', renderComparison);
$('#newer-version').addEventListener('change', renderComparison);
$('#timeline').addEventListener('click', event => {
  const item = event.target.closest('.timeline-item');
  if (!item) return;
  $$('.timeline-item').forEach(button => button.classList.toggle('selected', button === item));
  const versionIndex = state.versions.findIndex(version => version.id === item.dataset.version);
  $('#newer-version').value = item.dataset.version;
  if (versionIndex + 1 < state.versions.length) $('#older-version').value = state.versions[versionIndex + 1].id;
  renderComparison();
});

await refresh();
const selectedMonitor = new URLSearchParams(location.search).get('monitor');
if (selectedMonitor) showHistory(selectedMonitor).catch(error => showToast(error.message));
setInterval(refresh, 30000);
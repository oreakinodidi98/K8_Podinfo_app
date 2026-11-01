const fields = document.querySelectorAll('[data-field]');
const status = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const autoRefresh = document.getElementById('auto-refresh');
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshButton.disabled = true;
  try {
    const response = await fetch('/api/info', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    if (!info || typeof info !== 'object' ||
        typeof info.requestID !== 'string' || typeof info.requestTime !== 'string') {
      throw new Error('Invalid server response');
    }
    for (const field of fields) {
      const value = info[field.dataset.field];
      field.textContent = value === null || value === undefined || value === ''
        ? 'Not supplied'
        : `${value}${field.dataset.unit ? ` ${field.dataset.unit}` : ''}`;
    }
    status.dataset.state = info.podName && info.nodeName ? 'ready' : 'missing';
    status.textContent = info.podName && info.nodeName
      ? 'Connected. Showing the Pod that served this request.'
      : 'Kubernetes identity is not supplied. Deploy with the provided Downward API manifest.';
  } catch (error) {
    for (const field of fields) field.textContent = 'Unavailable';
    status.dataset.state = 'error';
    status.textContent = `Unable to load Pod information: ${error.message}. Try Refresh now.`;
    console.error('Pod information refresh failed:', error);
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', refresh);
setInterval(() => {
  if (autoRefresh.checked) refresh();
}, 5000);
refresh();

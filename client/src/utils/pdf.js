// Opens a blank tab synchronously (before the async fetch) so browsers don't treat
// the eventual window population as a blocked popup — the classic async-window.open fix.
export async function openJobPdf(api, jobId) {
  const newTab = window.open('', '_blank');
  try {
    const res = await api.get(`/jobs/${jobId}/pdf`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
    if (newTab) newTab.location = url;
    else window.open(url, '_blank'); // popup was blocked outright — try once more directly
  } catch (err) {
    if (newTab) newTab.close();
    throw err;
  }
}

// Downloads the CSV export with the caller's auth token attached (a plain <a href>
// can't carry the Authorization header, so this fetches as a blob and saves it).
export async function downloadJobsCsv(api, params) {
  const res = await api.get('/jobs/export.csv', { params, responseType: 'blob' });
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `jobs-export-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// Opens any authenticated PDF endpoint in a new tab (same popup-safe approach as
// openJobPdf). `path` is relative to the API base, e.g. '/storage/orders/123/pdf'.
export async function openPdf(api, path, params) {
  const newTab = window.open('', '_blank');
  try {
    const res = await api.get(path, { params, responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
    if (newTab) newTab.location = url;
    else window.open(url, '_blank');
  } catch (err) {
    if (newTab) newTab.close();
    // Error bodies arrive as a Blob because of responseType — surface the message.
    let message = 'Could not open the PDF';
    try { message = JSON.parse(await err.response.data.text()).error || message; } catch (e) { /* keep default */ }
    throw new Error(message);
  }
}

// Downloads any authenticated file endpoint (e.g. the Storage Centre export zip).
export async function downloadFile(api, path, fallbackName) {
  const res = await api.get(path, { responseType: 'blob' });
  const disposition = res.headers?.['content-disposition'] || '';
  const name = (disposition.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
  const url = window.URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

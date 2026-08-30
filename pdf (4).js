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

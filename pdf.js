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

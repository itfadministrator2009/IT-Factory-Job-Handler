import { forwardRef, useImperativeHandle, useRef, useState, useEffect } from 'react';
import { Paperclip, Download, Trash2, UploadCloud, X } from 'lucide-react';
import api from '../api';

// When jobId is null (creating a new job), selected files are staged locally and
// uploaded via uploadPending(newJobId) once the parent form saves and gets a real id.
// When jobId is set (editing / job detail), files upload immediately.
const AttachmentManager = forwardRef(function AttachmentManager({ jobId, initialAttachments = [] }, ref) {
  const fileInputRef = useRef(null);
  const [attachments, setAttachments] = useState(initialAttachments);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [thumbs, setThumbs] = useState({});

  useImperativeHandle(ref, () => ({
    async uploadPending(newJobId) {
      if (pendingFiles.length === 0) return;
      const formData = new FormData();
      pendingFiles.forEach((f) => formData.append('files', f));
      await api.post(`/jobs/${newJobId}/attachments`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
  }));

  // Fetch small preview thumbnails for image attachments that are already uploaded
  useEffect(() => {
    const toFetch = attachments.filter((a) => a.mime_type?.startsWith('image/') && !thumbs[a.id]);
    if (toFetch.length === 0) return;
    let cancelled = false;
    toFetch.forEach(async (a) => {
      try {
        const res = await api.get(`/attachments/${a.id}/download`, { responseType: 'blob' });
        if (cancelled) return;
        const url = window.URL.createObjectURL(res.data);
        setThumbs((prev) => ({ ...prev, [a.id]: url }));
      } catch (e) { /* thumbnail is a nice-to-have — skip silently on failure */ }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments.map((a) => a.id).join(',')]);

  async function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    if (!jobId) {
      setPendingFiles((prev) => [...prev, ...Array.from(fileList)]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    const formData = new FormData();
    Array.from(fileList).forEach((f) => formData.append('files', f));
    try {
      const { data } = await api.post(`/jobs/${jobId}/attachments`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setAttachments((prev) => [...data.attachments, ...prev]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function removePending(idx) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function deleteAttachment(attId) {
    if (!confirm('Delete this attachment?')) return;
    await api.delete(`/attachments/${attId}`);
    setAttachments((prev) => prev.filter((a) => a.id !== attId));
  }

  async function downloadAttachment(attId, name) {
    const res = await api.get(`/attachments/${attId}/download`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([res.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', name);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <div>
      <div
        className="dropzone"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
      >
        <UploadCloud size={18} style={{ marginBottom: 6 }} />
        <div>{uploading ? 'Uploading…' : 'Click to upload, or drag files here'}</div>
      </div>
      <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => handleFiles(e.target.files)} />

      {pendingFiles.length > 0 && (
        <div className="attachment-list">
          {pendingFiles.map((f, i) => (
            <div key={i} className="attachment-row">
              <div className="name">
                {f.type?.startsWith('image/')
                  ? <img className="attachment-thumb" src={URL.createObjectURL(f)} alt="" />
                  : <Paperclip size={14} />}
                {f.name}
                <span className="meta">{formatSize(f.size)} · will upload on save</span>
              </div>
              <div className="actions">
                <button type="button" className="danger" onClick={() => removePending(i)}>
                  <X size={13} style={{ verticalAlign: -2 }} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attachment-list" style={{ marginTop: pendingFiles.length ? 8 : 10 }}>
          {attachments.map((a) => (
            <div key={a.id} className="attachment-row">
              <div className="name">
                {thumbs[a.id]
                  ? <img className="attachment-thumb" src={thumbs[a.id]} alt="" />
                  : <Paperclip size={14} />}
                {a.original_name}
                <span className="meta">{formatSize(a.size)}</span>
              </div>
              <div className="actions">
                <button type="button" onClick={() => downloadAttachment(a.id, a.original_name)}>
                  <Download size={13} style={{ verticalAlign: -2 }} />
                </button>
                <button type="button" className="danger" onClick={() => deleteAttachment(a.id)}>
                  <Trash2 size={13} style={{ verticalAlign: -2 }} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default AttachmentManager;

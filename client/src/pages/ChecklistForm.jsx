import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Camera, Check, X, ExternalLink } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import GradingReference from '../checklist/GradingReference';
import {
  useChecklistConfig, MULTILINE_FIELDS, requiredItemsOf, makeModel, todayISO, photoUrl, shrinkImage, driveLink,
} from '../checklist/common';

// Fill in a new checklist (/checklist/new/:device) or edit a saved one (/checklist/edit/:id).
export default function ChecklistForm() {
  const { device: deviceParam, id } = useParams();
  const navigate = useNavigate();
  const { config, me, error: cfgError } = useChecklistConfig();
  const [entry, setEntry] = useState(null); // when editing
  const [loadError, setLoadError] = useState('');
  const deviceKey = id ? entry?.deviceKey : deviceParam;
  const device = config && deviceKey ? config.deviceTypes[deviceKey] : null;

  const [info, setInfo] = useState({});
  const [ticked, setTicked] = useState(new Set());
  const [date, setDate] = useState(todayISO());
  const [grade, setGrade] = useState('');
  const [notes, setNotes] = useState('');
  const [platform, setPlatform] = useState('');
  const [photos, setPhotos] = useState([]); // saved: { id, url }
  const [drive, setDrive] = useState([]); // older Google Drive photo ids
  const [pending, setPending] = useState([]); // new: { file, url }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [grading, setGrading] = useState(false);
  const fileRef = useRef(null);

  // Start fresh for a new checklist (iPhone/iPad: Make is always Apple).
  const resetForm = () => {
    setInfo(Object.fromEntries(device.infoFields.map((f) => [f, f === 'Make' && (deviceKey === 'iphone' || deviceKey === 'ipad') ? 'Apple' : ''])));
    setTicked(new Set()); setDate(todayISO()); setGrade(''); setNotes(''); setPlatform('');
    setPhotos([]); setDrive([]); setPending([]); setDone(null); setErr('');
  };
  useEffect(() => {
    if (id || !device) return;
    resetForm();
  }, [id, device, deviceKey]);

  // Load the entry being edited.
  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    const urls = [];
    api.get(`/checklist/entries/${id}`).then(async (r) => {
      if (!alive) return;
      const e = r.data.entry;
      setEntry(e); setInfo({ ...e.info }); setTicked(new Set(e.items)); setDate(e.date || todayISO());
      setGrade(e.grade); setNotes(e.notes); setPlatform(e.platform); setDrive(e.drivePhotoIds || []);
      setPhotos(e.photos.map((p) => ({ id: p.id, url: null })));
      for (const p of e.photos) {
        try {
          const url = await photoUrl(p.id);
          urls.push(url);
          if (alive) setPhotos((list) => list.map((x) => (x.id === p.id ? { ...x, url } : x)));
        } catch { /* leave the placeholder */ }
      }
    }).catch((e2) => setLoadError(e2.response?.data?.error || 'Could not load this checklist'));
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [id]);

  const required = useMemo(() => (device ? requiredItemsOf(device) : []), [device]);
  const doneCount = required.filter((i) => ticked.has(i)).length;
  const toggle = (item) => setTicked((s) => { const n = new Set(s); if (n.has(item)) n.delete(item); else n.add(item); return n; });

  const addFiles = async (files) => {
    const list = [...files].filter((f) => /^image\//.test(f.type));
    for (const f of list) {
      const small = await shrinkImage(f);
      setPending((p) => [...p, { file: small, url: URL.createObjectURL(small) }]);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    if (!grade) { setErr('Please select a cosmetic grade before submitting.'); return; }
    const serial = String(info['Serial Number'] || '').trim();
    if (serial) {
      try {
        const r = await api.get('/checklist/check-serial', { params: { device: deviceKey, serial, exclude: id || undefined } });
        if (r.data.duplicate && !window.confirm(`This serial number is already on entry ${r.data.assetId}. Save this one anyway?`)) return;
      } catch { /* a failed check never blocks saving */ }
    }
    const data = {
      deviceKey, date, grade, notes, platform, info, items: [...ticked],
      ...(id ? { keepPhotoIds: photos.map((p) => p.id), keepDrivePhotoIds: drive } : {}),
    };
    const fd = new FormData();
    fd.append('data', JSON.stringify(data));
    pending.forEach((p) => fd.append('photos', p.file, p.file.name));
    setBusy(true);
    try {
      const r = id ? await api.patch(`/checklist/entries/${id}`, fd) : await api.post('/checklist/entries', fd);
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      setPending([]);
      setDone({ entry: r.data.entry, salesSynced: r.data.salesSynced, edited: !!id });
      window.scrollTo(0, 0);
    } catch (e2) {
      setErr(`Could not save: ${e2.response?.data?.error || e2.message}`);
    }
    setBusy(false);
  };

  const err0 = cfgError || loadError;
  if (err0) return <Layout><div className="error-banner">{err0}</div></Layout>;
  if (!config || (id && !entry)) return <Layout><div className="panel panel-pad">Loading…</div></Layout>;
  if (!device) return <Layout><div className="error-banner">Unknown checklist type.</div><Link to="/checklist">Back to Asset Checklist</Link></Layout>;

  if (done) {
    const name = makeModel(done.entry) || 'device';
    return (
      <Layout>
        <div className="panel ck-success">
          <div className="ck-success-icon"><Check size={28} /></div>
          <h1>{done.edited ? 'Checklist updated' : 'Checklist saved'}</h1>
          <div className="ck-asset-id">{done.entry.assetId}</div>
          <p>{device.label} checklist for {name} has been {done.edited ? 'updated' : 'saved'}.
            {done.entry.salesItemId ? ' It is in Sales Manager → Inventory on Hand.' : ''}
            {done.entry.platform === 'ITF Australia' && !done.entry.salesItemId ? ' It could not be added to Sales Manager yet — use Retry in Saved History.' : ''}</p>
          <div className="ck-success-actions">
            {done.edited
              ? <button type="button" className="btn btn-accent" onClick={() => navigate(`/checklist/history?device=${deviceKey}`)}>Back to Saved History</button>
              : <button type="button" className="btn btn-accent" onClick={() => navigate('/checklist')}>Start another checklist</button>}
            {!done.edited && <button type="button" className="btn btn-ghost" onClick={() => { resetForm(); window.scrollTo(0, 0); }}>Another {device.label}</button>}
            <Link to={`/checklist/history?device=${deviceKey}`} className="btn btn-ghost">Saved History</Link>
          </div>
        </div>
      </Layout>
    );
  }

  const field = (f) => {
    const set = (v) => setInfo((p) => ({ ...p, [f]: v }));
    const fid = `ck-${f.replace(/[^a-z0-9]/gi, '')}`;
    if (f === 'Product Type') {
      return (
        <div className="field" key={f}><label htmlFor={fid}>{f}</label>
          <select id={fid} required value={info[f] || ''} onChange={(e) => set(e.target.value)}>
            <option value="">Select a product type…</option>
            {config.otherEquipmentProductTypes.map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
      );
    }
    if (MULTILINE_FIELDS.includes(f)) {
      return (
        <div className="field span-2" key={f}><label htmlFor={fid}>{f}</label>
          <textarea id={fid} rows={3} value={info[f] || ''} onChange={(e) => set(e.target.value)}
            placeholder={f === 'Ports' ? 'e.g. 2x USB-A, 1x USB-C, 1x HDMI, 1x Ethernet' : 'Any other information about this item — what it is, condition specifics, accessories included, etc.'} />
        </div>
      );
    }
    return (
      <div className="field" key={f}><label htmlFor={fid}>{f}</label>
        <input id={fid} required value={info[f] || ''} onChange={(e) => set(e.target.value)} className={f === 'Serial Number' ? 'mono-input' : undefined} />
      </div>
    );
  };

  return (
    <Layout>
      <Link to={id ? `/checklist/history?device=${deviceKey}` : '/checklist'} className="back-link"><ArrowLeft size={14} /> {id ? 'Saved History' : 'Asset Checklist'}</Link>
      <div className="page-header">
        <div>
          <h1>{device.label} Asset Checklist{id ? ` — ${entry.assetId}` : ''}</h1>
          {id && <div className="subtitle">Saved by {entry.technician || '—'}{entry.lastEditedBy ? ` · last edited by ${entry.lastEditedBy}` : ''}</div>}
        </div>
      </div>
      {device.helpNote && <div className="ck-help">{device.helpNote}</div>}
      {required.length > 0 && (
        <div className="ck-progress" aria-label={`${doneCount} of ${required.length} checked`}>
          <div className="ck-progress-track"><div className="ck-progress-fill" style={{ width: `${(doneCount / required.length) * 100}%` }} /></div>
          <span>{doneCount} / {required.length} checked</span>
        </div>
      )}
      <form onSubmit={save} className="ck-form">
        <div className="panel panel-pad">
          <h3 className="sales-form-h">Device details</h3>
          <div className="form-grid ck-grid">
            {device.infoFields.map(field)}
            <div className="field"><label>Technician</label><input readOnly className="readonly-input" value={id ? entry.technician : me} /></div>
            <div className="field"><label htmlFor="ck-date">Date</label><input id="ck-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="field"><label htmlFor="ck-platform">Platform</label>
              <select id="ck-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">Select platform…</option>
                {[...config.platformOptions, ...(platform && !config.platformOptions.includes(platform) ? [platform] : [])].map((o) => <option key={o}>{o}</option>)}
              </select>
              {platform === 'ITF Australia' && <span className="ck-field-note">{entry?.salesItemId ? 'Already in Sales Manager → Inventory on Hand.' : 'Saving adds it to Sales Manager → Inventory on Hand.'}</span>}
            </div>
          </div>
        </div>

        {device.sections.map((s) => (
          <div key={s.title} className="panel panel-pad">
            <h3 className="sales-form-h">{s.title}</h3>
            {s.items.map((item) => {
              const optional = (device.optionalItems || []).includes(item);
              return (
                <label key={item} className={`ck-item${optional ? ' optional' : ''}${ticked.has(item) ? ' on' : ''}`}>
                  <input type="checkbox" checked={ticked.has(item)} onChange={() => toggle(item)} />
                  <span>{item}{optional && <span className="ck-optional-tag">tick if applicable</span>}</span>
                </label>
              );
            })}
          </div>
        ))}

        <div className="panel panel-pad">
          <h3 className="sales-form-h">Cosmetic grade</h3>
          <select value={grade} onChange={(e) => setGrade(e.target.value)} className="ck-grade-select" required>
            <option value="" disabled>Select a grade…</option>
            {config.cosmeticGrades.map((g) => <option key={g.code} value={g.label}>{g.label}</option>)}
          </select>
          <button type="button" className="linklike ck-ref-link" onClick={() => setGrading(true)}>View grading reference</button>
        </div>

        <div className="panel panel-pad">
          <h3 className="sales-form-h">Device photos (optional)</h3>
          <p className="muted" style={{ marginTop: 0 }}>Cosmetic condition, damage, or accessories included.</p>
          <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}><Camera size={15} /> Add photos</button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <div className="ck-photos">
            {photos.map((p) => (
              <div key={p.id} className="ck-thumb">
                {p.url ? <img src={p.url} alt="" /> : <span>Loading…</span>}
                <button type="button" aria-label="Remove photo" onClick={() => setPhotos((l) => l.filter((x) => x.id !== p.id))}><X size={12} /></button>
              </div>
            ))}
            {pending.map((p, i) => (
              <div key={p.url} className="ck-thumb new">
                <img src={p.url} alt="" />
                <button type="button" aria-label="Remove photo" onClick={() => { URL.revokeObjectURL(p.url); setPending((l) => l.filter((_, j) => j !== i)); }}><X size={12} /></button>
              </div>
            ))}
            {drive.map((d) => (
              <div key={d} className="ck-thumb drive">
                <a href={driveLink(d)} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Google Drive photo</a>
                <button type="button" aria-label="Remove photo" onClick={() => setDrive((l) => l.filter((x) => x !== d))}><X size={12} /></button>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panel-pad">
          <h3 className="sales-form-h">Condition notes</h3>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional notes about this device's condition…" style={{ width: '100%' }} />
        </div>

        {err && <div className="error-banner">{err}</div>}
        <div className="sales-form-actions">
          <button type="submit" className="btn btn-accent" disabled={busy}>{busy ? 'Saving…' : id ? 'Save changes' : 'Submit checklist'}</button>
          <Link to={id ? `/checklist/history?device=${deviceKey}` : '/checklist'} className="btn btn-ghost">Cancel</Link>
        </div>
      </form>
      {grading && <GradingReference config={config} onClose={() => setGrading(false)} />}
    </Layout>
  );
}

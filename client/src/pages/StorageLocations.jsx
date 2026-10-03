import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Search } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'unclassified', label: 'Unclassified' },
  { id: 'pallet', label: 'Pallets' },
  { id: 'notPallet', label: 'Not pallets' },
];

function fmtWhen(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).length > 10 && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? 'Z' : ''));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-AU');
}

export default function StorageLocations() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [locations, setLocations] = useState(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [newLocation, setNewLocation] = useState('');
  const [newIsPallet, setNewIsPallet] = useState(true);
  const [busyKey, setBusyKey] = useState(null);
  const [error, setError] = useState('');

  function load() {
    api.get('/storage/locations-registry/overview')
      .then((res) => setLocations(res.data.locations))
      .catch((err) => setError(err.response?.data?.error || 'Could not load locations'));
  }
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { all: 0, unclassified: 0, pallet: 0, notPallet: 0 };
    (locations || []).forEach((l) => {
      c.all += 1;
      if (!l.classified) c.unclassified += 1;
      else if (l.isPallet) c.pallet += 1;
      else c.notPallet += 1;
    });
    return c;
  }, [locations]);

  const visible = useMemo(() => {
    if (!locations) return null;
    const q = query.trim().toLowerCase();
    return locations.filter((l) => {
      if (filter === 'unclassified' && l.classified) return false;
      if (filter === 'pallet' && !(l.classified && l.isPallet)) return false;
      if (filter === 'notPallet' && !(l.classified && !l.isPallet)) return false;
      if (!q) return true;
      return l.location.toLowerCase().includes(q)
        || l.clients.some((c) => c.toLowerCase().includes(q))
        || l.storageCentres.some((s) => s.toLowerCase().includes(q));
    });
  }, [locations, filter, query]);

  async function classify(location, isPallet) {
    setBusyKey(location);
    setError('');
    try {
      await api.post('/storage/locations-registry', { location, isPallet });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setBusyKey(null);
    }
  }

  async function unclassify(location) {
    if (!confirm(`Remove the classification for "${location}"? Items there are not affected.`)) return;
    setBusyKey(location);
    setError('');
    try {
      await api.delete('/storage/locations-registry', { params: { location } });
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not remove');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!newLocation.trim()) return;
    await classify(newLocation.trim(), newIsPallet);
    setNewLocation('');
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Locations</h1>
          <div className="subtitle">
            {locations ? `${counts.all} location${counts.all === 1 ? '' : 's'} · ${counts.unclassified} unclassified` : 'Loading…'}
          </div>
        </div>
      </div>

      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, maxWidth: 760 }}>
        Mark each location as a real <strong>pallet</strong> or <strong>not a pallet</strong> (a shelf, cage, floor area or placeholder).
        Locations in use on the manifest or pallet records show up here automatically.
      </p>

      <form onSubmit={handleAdd} className="panel" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="field" style={{ flex: '1 1 240px', margin: 0 }}>
          <label>Add or classify a location</label>
          <input value={newLocation} onChange={(e) => setNewLocation(e.target.value)} placeholder="e.g. Pallet 24" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Type</label>
          <select value={newIsPallet ? 'pallet' : 'not'} onChange={(e) => setNewIsPallet(e.target.value === 'pallet')}>
            <option value="pallet">Pallet</option>
            <option value="not">Not a pallet</option>
          </select>
        </div>
        <button className="btn btn-accent" type="submit" disabled={!newLocation.trim() || busyKey === newLocation.trim()}><Plus size={16} /> Save</button>
      </form>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`btn btn-sm ${filter === f.id ? 'btn-accent' : 'btn-ghost'}`} onClick={() => setFilter(f.id)}>
            {f.label} ({counts[f.id]})
          </button>
        ))}
        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search location, client, centre" style={{ paddingLeft: 30, minWidth: 240 }} />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="panel" style={{ padding: 0 }}>
        {!visible ? (
          <div className="empty-state">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state"><h3>No locations match</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Classification</th>
                  <th style={{ textAlign: 'right' }}>Items now</th>
                  <th>Clients</th>
                  <th>Storage centres</th>
                  <th>Classified</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => {
                  const busy = busyKey === l.location;
                  return (
                    <tr key={l.location}>
                      <td style={{ fontWeight: 600 }}>{l.location}</td>
                      <td>
                        <div style={{ display: 'inline-flex', gap: 4 }}>
                          <button type="button" disabled={busy} className={`btn btn-sm ${l.classified && l.isPallet ? 'btn-accent' : 'btn-ghost'}`} onClick={() => classify(l.location, true)}>Pallet</button>
                          <button type="button" disabled={busy} className={`btn btn-sm ${l.classified && !l.isPallet ? 'btn-accent' : 'btn-ghost'}`} onClick={() => classify(l.location, false)}>Not a pallet</button>
                        </div>
                        {!l.classified && <div style={{ fontSize: 11, color: 'var(--warning, #b7791f)', marginTop: 4 }}>Unclassified</div>}
                      </td>
                      <td style={{ textAlign: 'right' }} title={`${l.itemCount} item record${l.itemCount === 1 ? '' : 's'} in total`}>{l.currentItemCount}</td>
                      <td style={{ fontSize: 12 }}>{l.clients.join(', ')}</td>
                      <td style={{ fontSize: 12 }}>{l.storageCentres.join(', ')}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{l.classified ? `${l.classifiedBy || ''}${l.classifiedOn ? ` · ${fmtWhen(l.classifiedOn)}` : ''}` : ''}</td>
                      <td>
                        {isAdmin && l.classified && (
                          <button type="button" disabled={busy} className="btn btn-ghost btn-sm icon-btn" title="Remove classification" style={{ color: 'var(--danger)' }} onClick={() => unclassify(l.location)}><Trash2 size={13} /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}

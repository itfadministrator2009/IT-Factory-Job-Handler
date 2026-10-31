import { useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Gauge, Star } from 'lucide-react';
import Layout from '../components/Layout';
import GradingReference from '../checklist/GradingReference';
import { useChecklistConfig, DEVICE_ICONS, DEVICE_ORDER } from '../checklist/common';

// ITF Asset Checklist — pick which checklist to fill in.
export default function ChecklistHome() {
  const { config, error } = useChecklistConfig();
  const [grading, setGrading] = useState(false);
  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Asset Checklist</h1>
          <div className="subtitle">Choose a checklist to QA a refurbished device.</div>
        </div>
        <div className="ck-head-links">
          <Link to="/checklist/history" className="btn btn-ghost btn-sm"><History size={14} /> Saved History</Link>
          <Link to="/checklist/dashboard" className="btn btn-ghost btn-sm"><Gauge size={14} /> Dashboard</Link>
          {config && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setGrading(true)}><Star size={14} /> Grading reference</button>}
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!config ? <div className="panel panel-pad">Loading…</div> : (
        <div className="ck-choice-grid">
          {DEVICE_ORDER.filter((k) => config.deviceTypes[k]).map((k) => (
            <Link key={k} to={`/checklist/new/${k}`} className="ck-choice">
              <span className="ck-choice-icon" aria-hidden="true">{DEVICE_ICONS[k] || '📦'}</span>
              <span>{config.deviceTypes[k].label}</span>
            </Link>
          ))}
        </div>
      )}
      {grading && <GradingReference config={config} onClose={() => setGrading(false)} />}
    </Layout>
  );
}

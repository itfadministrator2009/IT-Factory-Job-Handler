import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Paperclip, Wrench, FileStack } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import AttachmentManager from '../components/AttachmentManager';
import ItemsManager from '../components/ItemsManager';

const STATUSES = ['Open', 'In Progress', 'On Hold', 'Complete', 'Collected', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const CHANNELS = ['Phone', 'Email', 'Web', 'Walk-in', 'Chat'];
const VEHICLES = [
  'Hino 2013 NSW Truck CT04CR',
  'HINO 2021 NSW Truck FNZ16E',
  'Hino 2015 VIC Truck 1SD2PS',
  'LDV 2023 NSW Van DL71BI',
  'Renault 2017 NSW Van DPH73M',
];
const CUSTOM_VEHICLE = '__custom__';

const EMPTY = {
  contact_name: '', account_name: '', email: '', phone: '',
  subject: '', description: '', status: 'Open', owner_id: '',
  product_name: '', due_date: '', scheduled_time: '', language: '', priority: '',
  channel: 'Phone', classifications: '', site_address: '', access_notes: '', customer_reference: '',
};

export default function JobForm() {
  const { id } = useParams();
  const isEdit = !!id;
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [users, setUsers] = useState([]);
  const [existingAttachments, setExistingAttachments] = useState([]);
  const [existingItems, setExistingItems] = useState([]);
  const [jobNumber, setJobNumber] = useState(null);
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const attachmentsRef = useRef(null);
  const itemsRef = useRef(null);
  const [templates, setTemplates] = useState([]);
  const [templateItems, setTemplateItems] = useState([]);
  const [templateKey, setTemplateKey] = useState('none');
  const [isCustomVehicle, setIsCustomVehicle] = useState(false);

  useEffect(() => {
    if (!isEdit) {
      api.get('/templates').then((res) => setTemplates(res.data.templates));
    }
  }, [isEdit]);

  function applyTemplate(templateId) {
    setTemplateKey(templateId || 'none');
    if (!templateId) {
      setTemplateItems([]);
      return;
    }
    const t = templates.find((tpl) => tpl.id === templateId);
    if (!t) return;
    setForm((f) => ({ ...f, ...t.fields }));
    setTemplateItems(t.items || []);
  }

  useEffect(() => {
    if (!isEdit) {
      api.get('/jobs/next-number').then((res) => setJobNumber(res.data.next));
    }
  }, [isEdit]);

  useEffect(() => {
    api.get('/users').then((res) => setUsers(res.data.users));
  }, []);

  useEffect(() => {
    if (!isEdit) return;
    api.get(`/jobs/${id}`).then((res) => {
      const j = res.data.job;
      setForm({
        contact_name: j.contact_name || '', account_name: j.account_name || '',
        email: j.email || '', phone: j.phone || '', subject: j.subject || '',
        description: j.description || '', status: j.status || 'Open',
        owner_id: j.owner_id || '', product_name: j.product_name || '',
        due_date: j.due_date || '', scheduled_time: j.scheduled_time || '', language: j.language || '',
        priority: j.priority || '', channel: j.channel || 'Phone',
        classifications: j.classifications || '', site_address: j.site_address || '',
        access_notes: j.access_notes || '', customer_reference: j.customer_reference || '',
      });
      setExistingAttachments(res.data.attachments || []);
      setExistingItems(res.data.items || []);
      setJobNumber(j.job_number);
      setIsCustomVehicle(!!j.language && !VEHICLES.includes(j.language));
      setLoading(false);
    });
  }, [id, isEdit]);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        const { data } = await api.patch(`/jobs/${id}`, form);
        navigate(`/jobs/${data.job.id}`);
      } else {
        const { data } = await api.post('/jobs', form);
        if (attachmentsRef.current) {
          await attachmentsRef.current.uploadPending(data.job.id);
        }
        if (itemsRef.current) {
          await itemsRef.current.savePending(data.job.id);
        }
        navigate(`/jobs/${data.job.id}`, { state: { justCreated: true } });
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save job');
      setSaving(false);
    }
  }

  if (loading) return <Layout><div className="empty-state">Loading…</div></Layout>;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>{isEdit ? `Edit job #${jobNumber ?? ''}` : jobNumber ? `Log new job — #${jobNumber}` : 'Log new job'}</h1>
          <div className="subtitle">
            {isEdit
              ? 'Fill in as much detail as you have — you can always update it later.'
              : 'This will be job #' + (jobNumber ?? '…') + '. Fill in as much detail as you have — you can always update it later.'}
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 28, maxWidth: 760 }}>
        {error && <div className="error-banner">{error}</div>}

        {!isEdit && templates.length > 0 && (
          <div className="field" style={{ maxWidth: 340, marginBottom: 22 }}>
            <label htmlFor="template"><FileStack size={13} style={{ verticalAlign: -2, marginRight: 4 }} />Apply a template</label>
            <select id="template" onChange={(e) => applyTemplate(e.target.value)} defaultValue="">
              <option value="">Start from scratch</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-section">
            <h3>Job Information</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="contact_name">Contact Name<span className="req">*</span></label>
                <input id="contact_name" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="account_name">Account Name</label>
                <input id="account_name" value={form.account_name} onChange={(e) => set('account_name', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="phone">Phone</label>
                <input id="phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </div>

              <div className="field span-2">
                <label htmlFor="subject">Subject<span className="req">*</span></label>
                <input id="subject" value={form.subject} onChange={(e) => set('subject', e.target.value)} required />
              </div>

              <div className="field span-2">
                <label htmlFor="description">Description</label>
                <textarea id="description" value={form.description} onChange={(e) => set('description', e.target.value)} />
              </div>

              <div className="field">
                <label htmlFor="status">Status<span className="req">*</span></label>
                <select id="status" value={form.status} onChange={(e) => set('status', e.target.value)} required>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="owner_id">Ticket Owner</label>
                <select id="owner_id" value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>

              <div className="field">
                <label htmlFor="product_name">Product Name</label>
                <input id="product_name" value={form.product_name} onChange={(e) => set('product_name', e.target.value)} />
              </div>

              <div className="field span-2">
                <label htmlFor="site_address">Site Address</label>
                <input id="site_address" value={form.site_address} onChange={(e) => set('site_address', e.target.value)} placeholder="Where the job is happening" />
              </div>

              <div className="field span-2">
                <label htmlFor="access_notes">Site Access Notes</label>
                <textarea id="access_notes" value={form.access_notes} onChange={(e) => set('access_notes', e.target.value)} placeholder="Parking, stair/lift access, entry instructions…" />
              </div>
            </div>
          </div>

          <div className="form-section">
            <h3>Additional Information</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="due_date">Date</label>
                <input id="due_date" type="date" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="scheduled_time">Time</label>
                <input id="scheduled_time" value={form.scheduled_time} onChange={(e) => set('scheduled_time', e.target.value)} placeholder="e.g. 1PM" />
              </div>

              <div className="field">
                <label htmlFor="vehicle">Vehicle</label>
                <select
                  id="vehicle"
                  value={isCustomVehicle ? CUSTOM_VEHICLE : form.language}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM_VEHICLE) {
                      setIsCustomVehicle(true);
                      set('language', '');
                    } else {
                      setIsCustomVehicle(false);
                      set('language', e.target.value);
                    }
                  }}
                >
                  <option value="">-None-</option>
                  {VEHICLES.map((v) => <option key={v} value={v}>{v}</option>)}
                  <option value={CUSTOM_VEHICLE}>Custom (enter manually)…</option>
                </select>
                {isCustomVehicle && (
                  <input
                    style={{ marginTop: 8 }}
                    value={form.language}
                    onChange={(e) => set('language', e.target.value)}
                    placeholder="Enter vehicle details"
                    autoFocus
                  />
                )}
              </div>
              <div className="field">
                <label htmlFor="priority">Priority</label>
                <select id="priority" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                  <option value="">-None-</option>
                  {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>

              <div className="field">
                <label htmlFor="channel">Channel</label>
                <select id="channel" value={form.channel} onChange={(e) => set('channel', e.target.value)}>
                  {CHANNELS.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="classifications">Classifications</label>
                <input id="classifications" value={form.classifications} onChange={(e) => set('classifications', e.target.value)} placeholder="e.g. Hardware, Billing" />
              </div>

              <div className="field span-2">
                <label htmlFor="customer_reference">Customer Reference / Notes</label>
                <input id="customer_reference" value={form.customer_reference} onChange={(e) => set('customer_reference', e.target.value)} placeholder="e.g. a PO or reference number, shown on the job sheet" />
              </div>
            </div>
          </div>

          <div className="form-section">
            <h3><Wrench size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Equipment / Items</h3>
            <ItemsManager key={templateKey} ref={itemsRef} jobId={isEdit ? id : null} initialItems={existingItems} initialPendingItems={templateItems} />
          </div>

          <div className="form-section">
            <h3><Paperclip size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Attachments</h3>
            <AttachmentManager ref={attachmentsRef} jobId={isEdit ? id : null} initialAttachments={existingAttachments} />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-accent" type="submit" disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Log job'}
            </button>
            <button className="btn btn-ghost" type="button" disabled={saving} onClick={() => navigate(isEdit ? `/jobs/${id}` : '/jobs')}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}

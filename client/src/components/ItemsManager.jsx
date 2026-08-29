import { forwardRef, useImperativeHandle, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import api from '../api';

const ItemsManager = forwardRef(function ItemsManager({ jobId, initialItems = [], initialPendingItems = [] }, ref) {
  const [items, setItems] = useState(initialItems);
  const [pending, setPending] = useState(!jobId ? initialPendingItems : []);
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState(1);
  const [reference, setReference] = useState('');

  useImperativeHandle(ref, () => ({
    async savePending(newJobId) {
      for (const item of pending) {
        // eslint-disable-next-line no-await-in-loop
        await api.post(`/jobs/${newJobId}/items`, item);
      }
    },
  }));

  function addItem() {
    if (!description.trim()) return;
    const newItem = { description: description.trim(), qty: Number(qty) || 1, reference: reference.trim() };

    if (jobId) {
      api.post(`/jobs/${jobId}/items`, newItem).then((res) => {
        setItems((prev) => [...prev, res.data.item]);
      });
    } else {
      setPending((prev) => [...prev, newItem]);
    }
    setDescription('');
    setQty(1);
    setReference('');
  }

  async function removeItem(item) {
    if (jobId) {
      await api.delete(`/jobs/${jobId}/items/${item.id}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    }
  }

  function removePending(idx) {
    setPending((prev) => prev.filter((_, i) => i !== idx));
  }

  const allRows = [...items, ...pending];

  return (
    <div>
      {allRows.length > 0 && (
        <div className="items-table">
          <div className="items-table-header">
            <span>Description</span>
            <span>Qty</span>
            <span>Reference / Serial</span>
            <span />
          </div>
          {items.map((item) => (
            <div key={item.id} className="items-table-row">
              <span>{item.description}</span>
              <span>{item.qty}</span>
              <span>{item.reference || '—'}</span>
              <button type="button" className="danger" onClick={() => removeItem(item)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {pending.map((item, i) => (
            <div key={`pending-${i}`} className="items-table-row">
              <span>{item.description}</span>
              <span>{item.qty}</span>
              <span>{item.reference || '—'}</span>
              <button type="button" className="danger" onClick={() => removePending(i)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="item-add-row">
        <input placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input type="number" min="1" placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
        <input placeholder="Reference / Serial" value={reference} onChange={(e) => setReference(e.target.value)} />
        <button type="button" className="btn btn-ghost btn-sm" onClick={addItem}>
          <Plus size={14} /> Add
        </button>
      </div>
    </div>
  );
});

export default ItemsManager;

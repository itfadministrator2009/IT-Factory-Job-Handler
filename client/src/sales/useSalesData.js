import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api';
import { makeCalc } from './calc';

// Sales Manager data shared by every page. The last copy is kept while moving
// between pages, so they open instantly, and is refreshed from the server each
// time a page opens.
const cache = { sale: null, inventory: null, settings: null };

export default function useSalesData({ sales = true, inventory = false } = {}) {
  const [state, setState] = useState(() => ({ sale: cache.sale, inventory: cache.inventory, settings: cache.settings }));
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setError('');
    try {
      const [s, i, st] = await Promise.all([
        sales ? api.get('/sales/items', { params: { kind: 'sale' } }) : null,
        inventory ? api.get('/sales/items', { params: { kind: 'inventory' } }) : null,
        api.get('/sales/settings'),
      ]);
      if (s) cache.sale = s.data.items;
      if (i) cache.inventory = i.data.items;
      cache.settings = st.data;
      setState({ sale: cache.sale, inventory: cache.inventory, settings: cache.settings });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load Sales Manager data');
    }
  }, [sales, inventory]);

  useEffect(() => { reload(); }, [reload]);

  const costs = useMemo(() => ({ labour: state.settings?.weeklyLabourCost ?? 3000, ads: state.settings?.weeklyAdsCost ?? 1000 }), [state.settings]);
  const calc = useMemo(() => makeCalc(state.sale || [], costs), [state.sale, costs]);

  // Local changes after a save, so lists update without waiting for a reload.
  const patch = useCallback((kind, fn) => {
    cache[kind] = fn(cache[kind] || []);
    setState((p) => ({ ...p, [kind]: cache[kind] }));
  }, []);

  return {
    sales: state.sale, inventory: state.inventory, settings: state.settings, isAdmin: !!state.settings?.isAdmin,
    loading: (sales && !state.sale) || (inventory && !state.inventory), error, reload, calc, patch,
  };
}

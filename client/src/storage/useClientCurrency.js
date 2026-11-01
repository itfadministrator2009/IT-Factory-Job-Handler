import { useCallback, useEffect, useState } from 'react';
import api from '../api';

// Which currency each client is charged in (from the Clients page). Loaded once
// and shared; anyone not on the list, or not set, is AUD.
let cache = null;
let loading = null;
const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

function load() {
  if (!loading) {
    loading = api.get('/storage/client-currencies')
      .then((res) => { cache = Object.fromEntries((res.data.clients || []).map((c) => [key(c.clientName), c.currency || 'AUD'])); return cache; })
      .catch(() => { loading = null; return cache || {}; });
  }
  return loading;
}

// Call after a client's currency changes so pages pick it up.
export function resetClientCurrencies() { cache = null; loading = null; }

export default function useClientCurrency() {
  const [map, setMap] = useState(cache || {});
  useEffect(() => { let on = true; load().then((m) => { if (on) setMap(m); }); return () => { on = false; }; }, []);
  return useCallback((client) => map[key(client)] || 'AUD', [map]);
}

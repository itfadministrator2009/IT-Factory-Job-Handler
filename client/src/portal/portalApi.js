import axios from 'axios';

// The Storage Centre client portal uses its own token, kept apart from the staff
// Work Desk login so a client session and a staff session never mix.
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
export const PORTAL_TOKEN_KEY = 'storage_portal_token';
export const PORTAL_CLIENT_KEY = 'storage_portal_client';

const portalApi = axios.create({ baseURL: `${API_BASE}/storage-portal` });

portalApi.interceptors.request.use((config) => {
  const token = localStorage.getItem(PORTAL_TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// An expired session or removed access sends the client back to the sign-in page.
portalApi.interceptors.response.use(
  (res) => res,
  (err) => {
    const isLogin = err.config?.url === '/login';
    if (err.response?.status === 401 && !isLogin) {
      clearPortalSession();
      if (!window.location.pathname.startsWith('/portal/login')) window.location.assign('/portal/login?expired=1');
    }
    return Promise.reject(err);
  },
);

export function getPortalClient() {
  try { return JSON.parse(localStorage.getItem(PORTAL_CLIENT_KEY) || 'null'); } catch (e) { return null; }
}

export function savePortalSession(token, client) {
  localStorage.setItem(PORTAL_TOKEN_KEY, token);
  localStorage.setItem(PORTAL_CLIENT_KEY, JSON.stringify(client));
}

export function clearPortalSession() {
  localStorage.removeItem(PORTAL_TOKEN_KEY);
  localStorage.removeItem(PORTAL_CLIENT_KEY);
}

export function hasPortalSession() {
  return !!localStorage.getItem(PORTAL_TOKEN_KEY);
}

export default portalApi;

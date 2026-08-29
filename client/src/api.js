import axios from 'axios';

// On Render, the frontend (Static Site) and backend (Web Service) are on different
// domains, so VITE_API_URL must be set explicitly — locally in client/.env, and in
// production as a build-time environment variable on the Static Site (Vite bakes
// this in at build time, not runtime, so it must be set before each deploy).
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('helpdesk_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;

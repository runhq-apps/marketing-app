/** One fetch wrapper: every call returns parsed JSON or throws an Error with the server's message. */
async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const qs = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v != null && v !== '') s.set(k, v);
  const out = s.toString();
  return out ? `?${out}` : '';
};

export const api = {
  health: () => request('/api/health'),
  providers: () => request('/api/providers'),

  overview: (params) => request(`/api/overview${qs(params)}`),

  projects: () => request('/api/projects'),
  createProject: (body) => request('/api/projects', { method: 'POST', body }),
  project: (id) => request(`/api/projects/${id}`),
  updateProject: (id, body) => request(`/api/projects/${id}`, { method: 'PATCH', body }),
  deleteProject: (id) => request(`/api/projects/${id}`, { method: 'DELETE' }),
  setStages: (id, stages) => request(`/api/projects/${id}/stages`, { method: 'POST', body: { stages } }),

  summary: (id, params) => request(`/api/projects/${id}/summary${qs(params)}`),
  funnel: (id, params) => request(`/api/projects/${id}/funnel${qs(params)}`),
  leads: (id, params) => request(`/api/projects/${id}/leads${qs(params)}`),
  lead: (id) => request(`/api/leads/${id}`),
  updateLead: (id, body) => request(`/api/leads/${id}`, { method: 'PATCH', body }),

  channels: (id) => request(`/api/projects/${id}/channels`),
  createChannel: (id, body) => request(`/api/projects/${id}/channels`, { method: 'POST', body }),
  channel: (id) => request(`/api/channels/${id}`),
  updateChannel: (id, body) => request(`/api/channels/${id}`, { method: 'PATCH', body }),
  deleteChannel: (id) => request(`/api/channels/${id}`, { method: 'DELETE' }),
  syncChannel: (id, body) => request(`/api/channels/${id}/sync`, { method: 'POST', body: body ?? {} }),
  syncProject: (id) => request(`/api/projects/${id}/sync`, { method: 'POST', body: {} }),
  channelSpend: (id, params) => request(`/api/channels/${id}/spend${qs(params)}`),
  addSpend: (id, body) => request(`/api/channels/${id}/spend`, { method: 'POST', body }),
  importCsv: (id, csv) => request(`/api/channels/${id}/import`, { method: 'POST', body: { csv } }),
  checklist: (id, code, done) => request(`/api/channels/${id}/checklist`, { method: 'POST', body: { code, done } }),

  revenue: (id, params) => request(`/api/projects/${id}/revenue${qs(params)}`),
  revenueSources: (id) => request(`/api/projects/${id}/revenue/sources`),
  connectRevenue: (id, body) => request(`/api/projects/${id}/revenue/sources`, { method: 'POST', body }),
  revenueSource: (id) => request(`/api/revenue-sources/${id}`),
  updateRevenueSource: (id, body) => request(`/api/revenue-sources/${id}`, { method: 'PATCH', body }),
  disconnectRevenue: (id) => request(`/api/revenue-sources/${id}`, { method: 'DELETE' }),
  syncRevenueSource: (id, body) => request(`/api/revenue-sources/${id}/sync`, { method: 'POST', body: body ?? {} }),
  syncRevenue: (id) => request(`/api/projects/${id}/revenue/sync`, { method: 'POST', body: {} }),
  payments: (id, params) => request(`/api/projects/${id}/payments${qs(params)}`),

  audit: (id, params) => request(`/api/projects/${id}/audit${qs(params)}`),
  runAudit: (id, body) => request(`/api/projects/${id}/audit`, { method: 'POST', body: body ?? {} }),
  scan: (id, url) => request(`/api/projects/${id}/scan`, { method: 'POST', body: { url } }),
  setFinding: (id, status) => request(`/api/findings/${id}`, { method: 'PATCH', body: { status } }),

  leadsCsvUrl: (id, params) => `/api/projects/${id}/leads.csv${qs(params)}`,
};

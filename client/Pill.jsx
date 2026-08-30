export function StatusPill({ status }) {
  const key = status.replace(/\s+/g, '');
  return <span className={`pill pill-status-${key}`}>{status}</span>;
}

export function PriorityPill({ priority }) {
  return <span className={`pill pill-priority-${priority}`}>{priority}</span>;
}

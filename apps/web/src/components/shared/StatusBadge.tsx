'use client';

const STATUS_STYLES: Record<string, string> = {
  SUCCEEDED: 'bg-success-light text-success',
  RUNNING: 'bg-blue-100 text-accent',
  QUEUED: 'bg-warning-light text-warning',
  FAILED: 'bg-danger-light text-danger',
  CANCELLED: 'bg-gray-100 text-muted-dark',
  BLOCKED: 'bg-danger-light text-danger',
  PUBLISHED: 'bg-success-light text-success',
  CERTIFIED: 'bg-blue-100 text-accent',
  VALIDATED: 'bg-purple-light text-purple',
  DRAFT: 'bg-gray-100 text-muted-dark',
  INSTALLED: 'bg-success-light text-success',
  PASS: 'bg-success-light text-success',
  FAIL: 'bg-danger-light text-danger',
  WARN: 'bg-warning-light text-warning',
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? 'bg-gray-100 text-muted-dark';
  return (
    <span className={`inline-block px-3 py-1 rounded text-xs font-semibold ${style}`}>
      {status}
    </span>
  );
}

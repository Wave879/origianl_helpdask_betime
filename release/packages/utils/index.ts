// ─── Date & Time ─────────────────────────────────────────────────────────────

export function formatDate(date: string | Date | null | undefined, locale = 'th-TH'): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

export function formatDatetime(date: string | Date | null | undefined, locale = 'th-TH'): string {
  if (!date) return '—';
  return new Date(date).toLocaleString(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatWorkHours(hours: number | null | undefined): string {
  if (hours == null) return '—';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function isoDate(date?: Date): string {
  return (date ?? new Date()).toISOString().slice(0, 10);
}

export function isExpired(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date();
}

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

// ─── Currency ────────────────────────────────────────────────────────────────

export function formatCurrency(
  amount: number | null | undefined,
  currency = 'THB',
  locale = 'th-TH',
): string {
  if (amount == null) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 0,
  }).format(amount);
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('th-TH').format(n);
}

// ─── String ──────────────────────────────────────────────────────────────────

export function truncate(str: string | null | undefined, max = 80): string {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function slugify(str: string): string {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─── Arrays & Objects ────────────────────────────────────────────────────────

export function tryParseJson<T = unknown>(value: unknown, fallback: T): T {
  try {
    if (typeof value !== 'string') return fallback;
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const k = String(item[key]);
    (acc[k] ??= []).push(item);
    return acc;
  }, {});
}

export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

// ─── File Size ───────────────────────────────────────────────────────────────

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// ─── Status Helpers ──────────────────────────────────────────────────────────

export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'default';

export function getStatusVariant(status: string): BadgeVariant {
  const s = status.toLowerCase();
  if (['active', 'approved', 'confirmed', 'completed', 'paid', 'resolved'].includes(s)) return 'success';
  if (['pending', 'draft', 'open', 'unpaid', 'in progress'].includes(s)) return 'warning';
  if (['rejected', 'expired', 'overdue', 'retired', 'cancelled', 'terminated'].includes(s)) return 'danger';
  if (['repair', 'triaged', 'assigned', 'reviewed'].includes(s)) return 'info';
  return 'default';
}

export function getRiskVariant(risk: string): BadgeVariant {
  if (risk === 'High') return 'danger';
  if (risk === 'Medium') return 'warning';
  return 'success';
}

export function getPriorityVariant(priority: string): BadgeVariant {
  if (priority === 'Critical') return 'danger';
  if (priority === 'High') return 'warning';
  if (priority === 'Medium') return 'info';
  return 'default';
}

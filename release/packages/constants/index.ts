// ─── Roles ──────────────────────────────────────────────────────────────────

export const ROLES = ['ceo', 'admin', 'manager', 'staff'] as const;

export const ROLE_LABELS: Record<string, string> = {
  ceo:     'CEO / ผู้บริหาร',
  admin:   'Admin',
  manager: 'Manager / หัวหน้า',
  staff:   'Staff / พนักงาน',
};

// ─── Projects ────────────────────────────────────────────────────────────────

export const PROJECT_STATUSES = ['Active', 'Completed', 'On Hold', 'Cancelled'] as const;
export const RISK_LEVELS = ['Low', 'Medium', 'High'] as const;
export const TASK_STATUSES = ['Open', 'In Progress', 'Completed', 'Cancelled'] as const;
export const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;

// ─── Finance ─────────────────────────────────────────────────────────────────

export const OT_STATUSES = ['Draft', 'Pending', 'Approved', 'Rejected'] as const;
export const INVOICE_STATUSES = ['Unpaid', 'Paid', 'Overdue', 'Cancelled'] as const;
export const BUDGET_CATEGORIES = ['Personnel', 'Operations', 'IT', 'Marketing', 'Other'] as const;

// ─── HR ───────────────────────────────────────────────────────────────────────

export const LEAVE_TYPES = ['annual', 'sick', 'personal', 'unpaid', 'maternity', 'other'] as const;
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const CHECKIN_LOCATIONS = ['Office', 'WFH', 'Field'] as const;

// ─── IT Support ──────────────────────────────────────────────────────────────

export const IT_ASSET_TYPES = ['Laptop', 'Desktop', 'Monitor', 'Printer', 'Network', 'Server'] as const;
export const IT_ASSET_STATUSES = ['active', 'repair', 'retired'] as const;
export const IT_CATEGORIES = ['Hardware', 'Software', 'Network', 'Email', 'Account'] as const;
export const IT_PRIORITIES = ['low', 'medium', 'high'] as const;
export const IT_REQUEST_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export const HELPDESK_STATUSES = ['open', 'triaged', 'assigned', 'resolved'] as const;

// ─── Smart Secretary ─────────────────────────────────────────────────────────

export const BOOKING_STATUSES = ['confirmed', 'cancelled', 'pending'] as const;
export const RESOURCE_TYPES = ['Equipment', 'AV', 'Other'] as const;
export const FOOD_ORDER_STATUSES = ['pending', 'ordered', 'delivered', 'cancelled'] as const;

// ─── Compliance ──────────────────────────────────────────────────────────────

export const CERT_TYPES = ['ISO', 'License', 'Training', 'Other'] as const;
export const CONTRACT_TYPES = ['Service', 'Vendor', 'Employment', 'NDA', 'Other'] as const;
export const CONTRACT_STATUSES = ['active', 'expired', 'terminated', 'draft'] as const;

// ─── Communication ───────────────────────────────────────────────────────────

export const ANNOUNCEMENT_CATEGORIES = ['General', 'HR', 'IT', 'Finance', 'Project'] as const;
export const FEEDBACK_CATEGORIES = ['General', 'IT', 'HR', 'Finance', 'Other'] as const;
export const FEEDBACK_STATUSES = ['new', 'reviewed', 'resolved'] as const;

// ─── Notifications ───────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = ['info', 'warning', 'error', 'success'] as const;

// ─── Session ─────────────────────────────────────────────────────────────────

export const SESSION_TTL_DAYS = 7;
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

// ─── Currency ────────────────────────────────────────────────────────────────

export const DEFAULT_CURRENCY = 'THB';
export const DEFAULT_FISCAL_YEAR = '2026';

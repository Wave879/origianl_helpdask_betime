// ─── Auth ───────────────────────────────────────────────────────────────────

export type Role = 'ceo' | 'admin' | 'manager' | 'staff';

export interface User {
  id: string;
  email: string;
  username: string | null;
  full_name: string | null;
  role: Role;
  department: string | null;
  avatar_url: string | null;
  is_active: number;
  must_change_password: number;
  access_mode?: 'role' | 'custom';
  access_json?: string | string[];
  access_keys?: string[];
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface SessionUser {
  user_id: string;
  email: string;
  full_name: string | null;
  role: Role;
  department: string | null;
  access_mode?: 'role' | 'custom';
  access_json?: string | string[];
  access_keys?: string[];
}

// ─── Projects & Tasks ───────────────────────────────────────────────────────

export type ProjectStatus = 'Active' | 'Completed' | 'On Hold' | 'Cancelled';
export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface Project {
  id: string;
  project_name: string;
  status: ProjectStatus;
  progress: number;
  risk_level: RiskLevel;
  deadline: string | null;
  owner: string | null;
  description: string | null;
  budget: number;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = 'Open' | 'In Progress' | 'Completed' | 'Cancelled';
export type TaskPriority = 'Low' | 'Medium' | 'High' | 'Critical';

export interface Task {
  id: string;
  task_name: string;
  project: string | null;
  assigned_to: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  deadline: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Finance ────────────────────────────────────────────────────────────────

export type OtStatus = 'Draft' | 'Pending' | 'Approved' | 'Rejected';

export interface OtClaim {
  id: string;
  employee: string;
  ot_date: string;
  ot_hours: number;
  reason: string | null;
  status: OtStatus;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

export type InvoiceStatus = 'Unpaid' | 'Paid' | 'Overdue' | 'Cancelled';

export interface Invoice {
  id: string;
  invoice_no: string | null;
  vendor: string | null;
  amount: number;
  due_date: string | null;
  status: InvoiceStatus;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BudgetItem {
  id: string;
  fiscal_year: string;
  department: string;
  category: string | null;
  item_name: string;
  planned: number;
  actual: number;
  currency: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Calendar & Meetings ────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  event_type: string;
  start_datetime: string;
  end_datetime: string | null;
  location: string | null;
  attendees: string; // JSON array string
  description: string | null;
  created_by: string | null;
  created_at: string;
}

export interface MeetingMom {
  id: string;
  project: string | null;
  meeting_date: string | null;
  attendees: string; // JSON array string
  agenda: string | null;
  decisions: string | null;
  action_items: string; // JSON array string
  ai_summary: string | null;
  created_by: string | null;
  created_at: string;
}

// ─── HR ─────────────────────────────────────────────────────────────────────

export type LeaveType = 'annual' | 'sick' | 'personal' | 'unpaid' | 'maternity' | 'other';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
  id: string;
  user_id: string;
  leave_type: LeaveType;
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string | null;
  status: LeaveStatus;
  approved_by: string | null;
  approved_at: string | null;
  attachment_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface CheckIn {
  id: string;
  user_id: string;
  check_date: string;
  check_in: string | null;
  check_out: string | null;
  work_hours: number | null;
  location: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ─── IT Support ─────────────────────────────────────────────────────────────

export type AssetType = 'Laptop' | 'Desktop' | 'Monitor' | 'Printer' | 'Network' | 'Server';
export type AssetStatus = 'active' | 'repair' | 'retired';

export interface ItAsset {
  id: string;
  asset_code: string;
  asset_name: string;
  asset_type: AssetType;
  assigned_to: string | null;
  user_id: string | null;
  department: string | null;
  serial_no: string | null;
  model: string | null;
  purchase_date: string | null;
  warranty_end: string | null;
  status: AssetStatus;
  location: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type ItRequestCategory = 'Hardware' | 'Software' | 'Network' | 'Email' | 'Account';
export type ItPriority = 'low' | 'medium' | 'high';
export type ItRequestStatus = 'open' | 'pending' | 'resolved' | 'closed';

export interface ItRequest {
  id: string;
  ticket_no: string | null;
  title: string;
  detail: string | null;
  category: ItRequestCategory;
  priority: ItPriority;
  status: ItRequestStatus;
  asset_code: string | null;
  department: string | null;
  reported_by: string | null;
  assigned_to: string | null;
  resolved_at: string | null;
  timeline: string; // JSON array string
  attachment_key: string | null;
  created_at: string;
  updated_at: string;
}

export type HelpdeskStatus = 'open' | 'triaged' | 'assigned' | 'resolved';

export interface HelpdeskTicket {
  id: string;
  title: string;
  description: string | null;
  project: string | null;
  bug_type: string | null;
  module: string | null;
  location: string | null;
  status: HelpdeskStatus;
  assigned_dev: string | null;
  created_by: string | null;
  odoo_ticket_id: string | null;
  attachment_key: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Smart Secretary ────────────────────────────────────────────────────────

export type BookingStatus = 'confirmed' | 'cancelled' | 'pending';

export interface RoomBooking {
  id: string;
  room_name: string;
  booked_by: string | null;
  start_time: string;
  end_time: string;
  attendees: number;
  purpose: string | null;
  status: BookingStatus;
  meeting_link: string | null;
  created_at: string;
}

export interface VehicleBooking {
  id: string;
  vehicle: string;
  booked_by: string | null;
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  destination: string | null;
  passengers: number;
  purpose: string | null;
  status: string;
  approved_by: string | null;
  created_at: string;
}

export interface FoodOrder {
  id: string;
  order_date: string;
  ordered_by: string | null;
  items: string; // JSON array string
  total_cost: number;
  vendor: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

// ─── Compliance ─────────────────────────────────────────────────────────────

export interface Certification {
  id: string;
  cert_name: string;
  cert_type: string;
  issued_to: string | null;
  issued_by: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  status: string;
  file_key: string | null;
  notes: string | null;
  created_at: string;
}

export interface Contract {
  id: string;
  contract_no: string | null;
  title: string;
  contract_type: string;
  party: string | null;
  contract_date: string | null;
  start_date: string | null;
  expiry_date: string | null;
  value: number;
  currency: string;
  status: string;
  file_key: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Communication ──────────────────────────────────────────────────────────

export interface Announcement {
  id: string;
  title: string;
  content: string | null;
  category: string;
  is_pinned: number;
  target_dept: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Feedback {
  id: string;
  subject: string;
  message: string | null;
  category: string;
  rating: number | null;
  submitted_by: string | null;
  is_anonymous: number;
  status: string;
  response: string | null;
  responded_by: string | null;
  created_at: string;
}

// ─── Knowledge & Notifications ──────────────────────────────────────────────

export interface KnowledgeArticle {
  id: string;
  title: string;
  content: string | null;
  category: string | null;
  tags: string;
  author: string | null;
  created_at: string;
  updated_at: string;
}

export type NotificationType = 'info' | 'warning' | 'error' | 'success';

export interface Notification {
  id: string;
  user_id: string;
  title: string | null;
  message: string;
  type: NotificationType;
  is_read: number;
  link: string | null;
  created_at: string;
}

// ─── Files ──────────────────────────────────────────────────────────────────

export interface FileRecord {
  id: string;
  r2_key: string;
  original_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  related_type: string | null;
  related_id: string | null;
  is_public: number;
  created_at: string;
}

// ─── API Responses ──────────────────────────────────────────────────────────

export interface ApiOk<T = unknown> {
  ok: true;
  data?: T;
  [key: string]: unknown;
}

export interface ApiError {
  ok: false;
  error: string;
}

export type ApiResponse<T = unknown> = ApiOk<T> | ApiError;

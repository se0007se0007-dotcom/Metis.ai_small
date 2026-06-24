/**
 * Workflow API Client — Server Persistence Operations
 *
 * Provides typed functions for workflow CRUD, version management, and publishing.
 * All requests include credentials for JWT cookie auth.
 */

// Use Next.js rewrite proxy (/api/:path* → http://localhost:4000/v1/:path*)
// This avoids CORS issues since all requests stay on the same origin.
const WF_BASE = '/api/workflows';

// ── Types ──

export interface WorkflowNodeDto {
  nodeKey: string;
  uiType: string;
  name: string;
  executionOrder: number;
  config: Record<string, any>;
  inputMapping?: Record<string, string>;
  dependsOn?: string[];
  positionX?: number;
  positionY?: number;
}

export interface WorkflowEdgeDto {
  fromNodeKey: string;
  toNodeKey: string;
  edgeType?: string;
  condition?: string;
  label?: string;
}

export interface WorkflowSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'DELETED';
  version: number;
  tags: string[];
  nodeCount: number;
  createdById: string;
  createdByName?: string;
  updatedAt: string;
  createdAt: string;
}

export interface WorkflowDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'DELETED';
  version: number;
  activeVersionId: string | null;
  tags: string[];
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
}

export interface WorkflowListResult {
  items: WorkflowSummary[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface WorkflowVersionSummary {
  id: string;
  versionNumber: number;
  label: string | null;
  createdById: string;
  createdByName?: string;
  createdAt: string;
  nodeCount: number;
}

export interface PublishResult {
  workflow: WorkflowDetail;
  version: WorkflowVersionSummary;
}

// ── Helper ──

async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  // Build CSRF header. Auth rides on the httpOnly metis_access cookie
  // (credentials: 'include'); we no longer read JWTs from localStorage.
  const authHeaders: Record<string, string> = {};
  if (typeof document !== 'undefined') {
    const csrfMatch = document.cookie.match(/(?:^|;\s*)metis_csrf=([^;]+)/);
    if (csrfMatch) authHeaders['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1]);
  }

  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const err = await response
      .json()
      .catch(() => ({ message: `Request failed: ${response.status}` }));
    throw new Error(err.message || `API 요청 실패: ${response.status}`);
  }

  // 204 No Content
  if (response.status === 204) return undefined as T;
  return response.json();
}

// ── List Workflows ──

export interface ListWorkflowsParams {
  status?: string;
  search?: string;
  tags?: string[];
  page?: number;
  limit?: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'name';
  sortOrder?: 'asc' | 'desc';
}

export async function listWorkflows(params?: ListWorkflowsParams): Promise<WorkflowListResult> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.search) searchParams.set('search', params.search);
  if (params?.tags?.length) searchParams.set('tags', params.tags.join(','));
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.sortBy) searchParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) searchParams.set('sortOrder', params.sortOrder);

  const qs = searchParams.toString();
  return apiRequest<WorkflowListResult>(`${WF_BASE}${qs ? `?${qs}` : ''}`);
}

// ── Create Workflow ──

export interface CreateWorkflowInput {
  key: string;
  name: string;
  description?: string;
  tags?: string[];
  nodes: WorkflowNodeDto[];
  edges?: WorkflowEdgeDto[];
}

export async function createWorkflow(input: CreateWorkflowInput): Promise<WorkflowDetail> {
  return apiRequest<WorkflowDetail>(WF_BASE, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

// ── Get Workflow ──

export async function getWorkflow(id: string): Promise<WorkflowDetail> {
  return apiRequest<WorkflowDetail>(`${WF_BASE}/${id}`);
}

// ── Update Workflow ──

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  tags?: string[];
  nodes?: WorkflowNodeDto[];
  edges?: WorkflowEdgeDto[];
  expectedVersion: number;
}

export async function updateWorkflow(
  id: string,
  input: UpdateWorkflowInput,
): Promise<WorkflowDetail> {
  return apiRequest<WorkflowDetail>(`${WF_BASE}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

// ── Delete Workflow ──

export async function deleteWorkflow(id: string): Promise<void> {
  return apiRequest<void>(`${WF_BASE}/${id}`, { method: 'DELETE' });
}

// ── Publish Workflow ──

export async function publishWorkflow(id: string, label?: string): Promise<PublishResult> {
  return apiRequest<PublishResult>(`${WF_BASE}/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
}

// ── Archive Workflow ──

export async function archiveWorkflow(id: string): Promise<void> {
  return apiRequest<void>(`${WF_BASE}/${id}/archive`, { method: 'POST' });
}

// ── Duplicate Workflow ──

export async function duplicateWorkflow(
  id: string,
  newKey: string,
  newName: string,
): Promise<WorkflowDetail> {
  return apiRequest<WorkflowDetail>(`${WF_BASE}/${id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ newKey, newName }),
  });
}

// ── Version History ──

export async function listVersions(workflowId: string): Promise<WorkflowVersionSummary[]> {
  return apiRequest<WorkflowVersionSummary[]>(`${WF_BASE}/${workflowId}/versions`);
}

// ── Restore Version ──

export async function restoreVersion(
  workflowId: string,
  versionId: string,
): Promise<WorkflowDetail> {
  return apiRequest<WorkflowDetail>(`${WF_BASE}/${workflowId}/versions/${versionId}/restore`, {
    method: 'POST',
  });
}

// ── Helper: Generate a URL-safe workflow key from a name ──

export function generateWorkflowKey(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  // If name is Korean-only, transliterate to a generic key
  if (!/[a-z0-9]/.test(base)) {
    return `workflow-${Date.now().toString(36)}`;
  }

  return base || `workflow-${Date.now().toString(36)}`;
}

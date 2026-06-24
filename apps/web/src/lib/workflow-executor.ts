/**
 * Workflow Executor — Frontend API Client
 *
 * Connects the workflow builder UI to the real backend pipeline engine.
 * Handles:
 *   - File upload to backend
 *   - Pipeline execution (async with SSE streaming)
 *   - Synchronous execution for quick workflows
 *   - Connector registry discovery
 *   - File download for generated documents
 */

// ── Types ──

export interface PipelineNode {
  id: string;
  type: string;
  name: string;
  order: number;
  settings: Record<string, any>;
}

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
  isArchive: boolean;
}

export interface NodeResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  success: boolean;
  output: {
    success: boolean;
    data: Record<string, any>;
    outputText: string;
    generatedFiles?: Array<{
      name: string;
      path: string;
      format: string;
      downloadUrl?: string;
    }>;
    durationMs: number;
    error?: string;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: string;
}

export interface PipelineResult {
  executionSessionId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL';
  nodeResults: NodeResult[];
  finalOutput: string;
  generatedFiles: Array<{
    name: string;
    path: string;
    format: string;
    downloadUrl?: string;
  }>;
  totalDurationMs: number;
}

export interface PipelineProgressEvent {
  type: 'node_start' | 'node_complete' | 'node_error' | 'pipeline_complete' | 'pipeline_error';
  nodeId?: string;
  nodeName?: string;
  progress: number;
  data?: any;
  error?: string;
}

export interface ConnectorMetadata {
  key: string;
  name: string;
  type: string;
  description: string;
  category: string;
  capabilities: string[];
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
}

// ── API Base URL ──

// Use Next.js rewrite proxy: /api/:path* → http://localhost:4000/v1/:path*
// Backend controller is @Controller('api/workflow-nodes') → route /v1/api/workflow-nodes
// Through rewrite: /api/api/workflow-nodes → /v1/api/workflow-nodes
const WF_API = '/api/api/workflow-nodes';

/** Build common headers with auth token and CSRF */
function buildHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

  // Auth rides on the httpOnly metis_access cookie (sent via credentials:
  // 'include'). We no longer read JWTs from localStorage.

  // CSRF token (from cookie)
  if (typeof document !== 'undefined') {
    const match = document.cookie.match(/(?:^|;\s*)metis_csrf=([^;]+)/);
    if (match) headers['X-CSRF-Token'] = decodeURIComponent(match[1]);
  }

  return headers;
}

// ── File Upload ──

/**
 * Upload a file to the backend for a specific execution session.
 */
export async function uploadFile(file: File, sessionId: string): Promise<UploadedFile> {
  const formData = new FormData();
  formData.append('file', file);

  const uploadHeaders = buildHeaders(); // no Content-Type for FormData
  const response = await fetch(`${WF_API}/upload/${sessionId}`, {
    method: 'POST',
    headers: uploadHeaders,
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: 'Upload failed' }));
    throw new Error(err.message || `파일 업로드 실패: ${response.status}`);
  }

  const result = await response.json();
  return result.file;
}

/**
 * Upload multiple files sequentially.
 */
export async function uploadFiles(
  files: File[],
  sessionId: string,
  onProgress?: (index: number, total: number) => void,
): Promise<UploadedFile[]> {
  const results: UploadedFile[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length);
    const result = await uploadFile(files[i], sessionId);
    results.push(result);
  }
  onProgress?.(files.length, files.length);
  return results;
}

// ── Pipeline Execution ──

/**
 * Execute a workflow pipeline synchronously.
 * Returns when all nodes have completed.
 * Best for short workflows (< 30 seconds).
 */
export async function executePipelineSync(
  title: string,
  nodes: PipelineNode[],
  uploadedFiles?: UploadedFile[],
): Promise<PipelineResult> {
  const response = await fetch(`${WF_API}/execute-sync`, {
    method: 'POST',
    headers: buildHeaders('application/json'),
    credentials: 'include',
    body: JSON.stringify({ title, nodes, uploadedFiles }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: 'Execution failed' }));
    throw new Error(err.message || `파이프라인 실행 실패: ${response.status}`);
  }

  return response.json();
}

/**
 * Execute a workflow pipeline asynchronously with SSE progress streaming.
 * Returns immediately with an executionId; progress events are delivered via callback.
 */
export async function executePipelineAsync(
  title: string,
  nodes: PipelineNode[],
  onProgress: (event: PipelineProgressEvent) => void,
  uploadedFiles?: UploadedFile[],
): Promise<{ executionId: string }> {
  const response = await fetch(`${WF_API}/execute`, {
    method: 'POST',
    headers: buildHeaders('application/json'),
    credentials: 'include',
    body: JSON.stringify({ title, nodes, uploadedFiles }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: 'Execution failed' }));
    throw new Error(err.message || `파이프라인 실행 실패: ${response.status}`);
  }

  const { executionId, streamUrl } = await response.json();

  // Connect to SSE stream
  // streamUrl from server is like /v1/api/workflow-nodes/stream/xxx
  // Convert to /api/... so it goes through Next.js rewrite proxy
  const proxyStreamUrl = streamUrl.startsWith('/v1/') ? '/api/' + streamUrl.slice(4) : streamUrl;
  // Send the httpOnly metis_access cookie with the SSE handshake (consistent
  // with use-event-stream.ts) so the stream is authenticated.
  const eventSource = new EventSource(proxyStreamUrl, { withCredentials: true });

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as PipelineProgressEvent;
      onProgress(data);

      if (data.type === 'pipeline_complete' || data.type === 'pipeline_error') {
        eventSource.close();
      }
    } catch (e) {
      console.error('Failed to parse SSE event:', e);
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    onProgress({
      type: 'pipeline_error',
      progress: 0,
      error: 'SSE 연결이 끊어졌습니다.',
    });
  };

  return { executionId };
}

// ── Draft Execution via Node Resolution Bridge ──

/**
 * Execute a draft workflow through the new Node Resolution → Execution Bridge pipeline.
 *
 * This is the preferred execution path when the backend is available.
 * It resolves each builder node's uiType → executionType + capability,
 * infers inputMapping between nodes, validates connector availability,
 * then executes through the real WorkflowRunner pipeline.
 *
 * Falls back to the existing SSE pipeline or local simulation if unavailable.
 */
export interface DraftExecutionResult {
  /** Full execution result from WorkflowRunner */
  execution: {
    executionSessionId: string;
    correlationId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
    nodeResults: Array<{
      nodeId: string;
      success: boolean;
      durationMs: number;
      error?: string;
    }>;
    finalState: Record<string, any>;
    totalDurationMs: number;
  };
  /** How each node was resolved (for UI display) */
  nodeResolutions: Array<{
    nodeKey: string;
    nodeName: string;
    uiType: string;
    executionType: string;
    capability: string;
    intentCategory: string;
    inputMapping: Record<string, string>;
  }>;
  /** Connector availability */
  connectorStatus: {
    allAvailable: boolean;
    missing: string[];
  };
  warnings: string[];
}

export async function executeDraftViaResolution(
  title: string,
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    order: number;
    settings: Record<string, any>;
  }>,
): Promise<DraftExecutionResult> {
  const draftNodes = nodes.map((n) => ({
    nodeKey: n.id,
    uiType: n.type,
    name: n.name,
    executionOrder: n.order,
    config: n.settings,
    dependsOn: n.settings?.dependsOn || [],
  }));

  const response = await fetch(`/api/workflows/execute-draft`, {
    method: 'POST',
    headers: buildHeaders('application/json'),
    credentials: 'include',
    body: JSON.stringify({
      title,
      nodes: draftNodes,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: 'Draft execution failed' }));
    throw new Error(err.message || `드래프트 실행 실패: ${response.status}`);
  }

  return response.json();
}

/**
 * Preview node resolution without executing.
 * Returns how each node maps to backend types and what data flow exists.
 */
export async function resolveNodesPreview(
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    order: number;
    settings: Record<string, any>;
  }>,
): Promise<{
  nodes: Array<{
    nodeKey: string;
    uiType: string;
    executionType: string;
    capability: string;
    intentCategory: string;
    riskLevel: string;
    outputKeys: string[];
    inputMapping: Record<string, string>;
  }>;
  requiredConnectors: string[];
}> {
  const draftNodes = nodes.map((n) => ({
    nodeKey: n.id,
    uiType: n.type,
    name: n.name,
    executionOrder: n.order,
    config: n.settings,
  }));

  const response = await fetch('/api/workflows/resolve-nodes', {
    method: 'POST',
    headers: buildHeaders('application/json'),
    credentials: 'include',
    body: JSON.stringify({ nodes: draftNodes }),
  });

  if (!response.ok) {
    throw new Error(`노드 해석 실패: ${response.status}`);
  }

  return response.json();
}

// ── Connector Registry ──

/**
 * Get all registered workflow node connectors from the backend.
 */
export async function getRegisteredConnectors(): Promise<{
  connectors: ConnectorMetadata[];
  totalCount: number;
}> {
  const response = await fetch(`${WF_API}/connectors`, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`커넥터 목록 조회 실패: ${response.status}`);
  }

  return response.json();
}

/**
 * Get a specific connector's metadata by key.
 */
export async function getConnector(key: string): Promise<ConnectorMetadata> {
  const response = await fetch(`${WF_API}/connectors/${key}`, {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`커넥터 조회 실패: ${response.status}`);
  }

  return response.json();
}

// ── File Download ──

/**
 * Get the download URL for a generated file.
 */
export function getDownloadUrl(sessionDir: string, fileName: string): string {
  return `${WF_API}/download/${sessionDir}/${encodeURIComponent(fileName)}`;
}

/**
 * Trigger file download in the browser.
 */
export function downloadFile(sessionDir: string, fileName: string): void {
  const url = getDownloadUrl(sessionDir, fileName);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Helper: Generate a session ID for file uploads ──

export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Helper: Convert builder nodes to pipeline nodes ──

export function builderNodesToPipelineNodes(
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    order: number;
    settings: Record<string, any>;
  }>,
): PipelineNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    name: n.name,
    order: n.order,
    settings: { ...n.settings },
  }));
}

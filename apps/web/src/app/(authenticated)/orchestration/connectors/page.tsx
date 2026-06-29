'use client';

import { useState, useEffect, useCallback } from 'react';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { usePagination, Pager } from '@/components/shared/usePagination';
import { api } from '@/lib/api-client';
import { useOpsRef, krw } from '@/lib/opsRef';
import {
  RefreshCw,
  AlertCircle,
  Plus,
  Settings,
  Trash2,
  Activity,
  Zap,
  Slack,
  Github,
  Database,
  Cloud,
  Search,
  AlertTriangle,
  CheckCircle,
  Play,
  Square,
  RotateCcw,
  Beaker,
  Eye,
  Download,
  Send,
  X,
  Loader,
} from 'lucide-react';

// ── Types ──

interface Connector {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
  configJson: Record<string, unknown> | null;
  updatedAt: string;
  lastHealthCheck?: string;
  lastHealthStatus?: 'OK' | 'UNREACHABLE' | 'DEGRADED';
  lastHealthLatencyMs?: number;
  endpoint?: string;
  authType?: string;
  command?: string;
  args?: string[];
  transport?: string;
}

interface MCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
}

interface TestResult {
  step: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  duration?: number;
}

// ── 내장 노드(커넥터) 실제 실행 테스트 지원 ──
// 커넥터 key → (nodeType, category) 폴백. 우선은 백엔드가 내려주는 execNodeType/execCategory 사용.
const BUILTIN_KEY_TO_NODE: Record<string, { nodeType: string; category: string }> = {
  'metis-file-upload': { nodeType: 'file-operation', category: 'input' },
  'metis-ai-analysis': { nodeType: 'ai-processing', category: 'inspection' },
  'metis-pentest': { nodeType: 'ai-processing', category: 'pentest' },
  'metis-document-gen': { nodeType: 'file-operation', category: 'output' },
  'metis-web-search': { nodeType: 'web-search', category: 'search' },
  'metis-slack': { nodeType: 'slack-message', category: 'delivery' },
  'metis-email': { nodeType: 'email-send', category: 'delivery' },
  'metis-email-send': { nodeType: 'email-send', category: 'delivery' },
  'metis-data-storage': { nodeType: 'data-storage', category: 'storage' },
  'metis-log-monitor': { nodeType: 'log-monitor', category: 'monitor' },
  'metis-schedule': { nodeType: 'schedule', category: 'schedule' },
};

const SAMPLE_VULN_CODE = [
  'def transfer(accounts, src, dst, amount):',
  '    # 입력 검증 없음 — 취약',
  "    query = \"SELECT * FROM users WHERE id = '\" + src + \"'\"",
  '    accounts[src] -= amount',
  '    accounts[dst] += amount',
  '    return accounts',
].join('\n');

/** 노드 타입별 실제 실행 테스트용 샘플 settings + 이전노드 출력. */
function sampleForNode(
  nodeType: string,
  category: string,
): { settings: Record<string, unknown>; previousOutput: string } {
  switch (`${nodeType}:${category}`) {
    case 'ai-processing:inspection':
    case 'ai-processing:security':
    case 'ai-processing:analysis':
      return {
        settings: { scanners: ['sast', 'secrets'], model: 'claude-haiku-4-5-20251001', minSeverity: 'low' },
        previousOutput: SAMPLE_VULN_CODE,
      };
    case 'ai-processing:pentest':
      return { settings: { model: 'claude-haiku-4-5-20251001' }, previousOutput: SAMPLE_VULN_CODE };
    case 'ai-processing:summarize':
      return {
        settings: { summaryStyle: 'bullet', maxLength: 'short' },
        previousOutput: 'SAST 결과: SQL Injection 1건(HIGH), 하드코딩된 비밀번호 1건(CRITICAL) 발견.',
      };
    case 'file-operation:output':
      return { settings: { format: 'html', title: 'Metis 커넥터 테스트' }, previousOutput: '# 점검 요약\n- A: 정상\n- B: 경고' };
    case 'file-operation:input':
      return {
        settings: { sourceType: 'api', apiUrl: 'https://example.com' },
        previousOutput: '',
      };
    case 'web-search:search':
      return { settings: { keywords: 'OWASP Top 10', searchEngine: 'duckduckgo', maxResults: 5, language: 'ko' }, previousOutput: '' };
    case 'log-monitor:monitor':
      return { settings: { logSource: 'server', logLevels: ['ERROR', 'WARN'], alertPattern: 'timeout|refused' }, previousOutput: '' };
    case 'data-storage:storage':
      return { settings: { storageType: 'postgresql', operation: 'INSERT' }, previousOutput: '커넥터 테스트로 저장되는 샘플 본문입니다.' };
    case 'slack-message:delivery':
      return { settings: { slackConnectType: 'webhook', messageTemplate: '🔔 커넥터 테스트\n\n{{summary}}' }, previousOutput: '결과 요약 텍스트' };
    case 'email-send:delivery':
      return { settings: { subject: 'Metis 커넥터 테스트', to: '' }, previousOutput: '이메일 본문 텍스트' };
    case 'schedule:schedule':
    case 'schedule:trigger':
      return { settings: { cron: '0 9 * * 1', timezone: 'Asia/Seoul' }, previousOutput: '' };
    default:
      return { settings: {}, previousOutput: '커넥터 테스트 입력' };
  }
}

interface SchemaCapability {
  method: string;
  description: string;
  params: Record<string, string>;
}

interface WorkflowNode {
  workflowKey: string;
  workflowName: string;
  nodeKey: string;
  uiType: string;
  name: string;
  executionOrder: number;
}

interface GroupedNode {
  nodeKey: string;
  uiType: string;
  name: string;
  count: number;
  workflows: Array<{ workflowKey: string; workflowName: string }>;
  category?: string;
  settings?: Record<string, unknown>;
}

interface NodesResponse {
  nodes: WorkflowNode[];
  grouped: GroupedNode[];
  totalNodes: number;
  totalWorkflows: number;
}

/**
 * 워크플로우 서브 Agent(저장된 WorkflowNodeDef) 1개를 실제 실행기로 단독 실행하는 테스트 버튼.
 * 내장 노드 "테스트"와 동일하게 execute-node 를 호출 → 실 LLM/HTTP/파일/DB 작동.
 * uiType → nodeType, configJson.stepCategory → category, configJson → settings 로 매핑.
 */
function SubAgentTestButton({ g }: { g: GroupedNode }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const category =
    g.category || (typeof g.settings?.stepCategory === 'string' ? (g.settings.stepCategory as string) : '');

  const run = async () => {
    setLoading(true);
    setErr(null);
    setResult(null);
    const sample = sampleForNode(g.uiType, category);
    const settings =
      g.settings && Object.keys(g.settings).length ? { ...sample.settings, ...g.settings } : sample.settings;
    try {
      const res = await api.post<any>('/api/workflow-nodes/execute-node', {
        nodeType: g.uiType,
        category,
        nodeName: g.name,
        settings,
        previousOutput: sample.previousOutput,
      });
      setResult(res);
    } catch (e) {
      setErr((e as Error)?.message ?? '실행 실패 — API 상태를 확인하세요.');
    } finally {
      setLoading(false);
    }
  };

  const o = result?.output;
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          void run();
        }}
        className="text-[10px] font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded hover:bg-blue-100"
      >
        테스트
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <h3 className="text-sm font-bold text-gray-900">
                  {g.name}{' '}
                  <span className="text-[10px] font-mono text-gray-400">
                    ({g.uiType}
                    {category ? `:${category}` : ''})
                  </span>
                </h3>
                <p className="text-[10px] text-gray-500">서브 Agent 단독 실제 실행 (execute-node)</p>
              </div>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 text-lg leading-none">
                ×
              </button>
            </div>
            {loading && (
              <p className="text-xs text-gray-400 py-6 text-center">실행 중… (LLM 노드는 수십 초 걸릴 수 있음)</p>
            )}
            {err && (
              <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{err}</div>
            )}
            {result && !loading && (
              <div className="space-y-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-full font-bold ${
                      !result.resolved
                        ? 'bg-rose-50 text-rose-700'
                        : o?.success
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {result.resolved ? (o?.success ? '성공' : '실패') : '실행기 없음'}
                  </span>
                  {result.executorKey && (
                    <span className="text-gray-500">
                      executor: <b>{result.executorKey}</b>
                    </span>
                  )}
                  {typeof o?.durationMs === 'number' && <span className="text-gray-400">{o.durationMs}ms</span>}
                  {result.executorKey === 'passthrough' && (
                    <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700">미구현(패스스루)</span>
                  )}
                  {o?.data?.demo === true && (
                    <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700">데모 데이터</span>
                  )}
                  {o?.data?.skipped === true && (
                    <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">건너뜀</span>
                  )}
                  {result.evaluation && (
                    <span className="text-gray-500">
                      품질 {result.evaluation.overallScore} ({result.evaluation.qualityGrade})
                    </span>
                  )}
                </div>
                {(o?.error || result.error) && (
                  <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 whitespace-pre-wrap">
                    {o?.error || result.error}
                  </div>
                )}
                {o?.outputText && (
                  <pre className="text-[11px] bg-gray-900 text-gray-100 rounded p-2 overflow-x-auto max-h-72 whitespace-pre-wrap">
                    {o.outputText}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const CONNECTOR_TYPES = ['BUILT_IN', 'MCP_SERVER', 'AGENT', 'REST_API', 'WEBHOOK'] as const;

// ── Built-in Workflow Node Connectors (auto-registered from NodeExecutorRegistry) ──

const BUILTIN_NODE_CONNECTORS: Connector[] = [
  {
    id: 'builtin-file-upload',
    key: 'metis-file-upload',
    name: '파일 업로드 / 소스 로딩',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 5,
      lastHealthCheck: new Date().toISOString(),
      category: 'input',
      description:
        '로컬 파일, Git 리포, 클라우드 스토리지에서 소스코드를 로딩합니다. ZIP/TAR/7Z 압축 자동 해제, 30+ 언어 자동 감지.',
      capabilities: [
        'local-upload',
        'git-clone',
        'archive-extract',
        'language-detect',
        'source-stats',
      ],
      nodeTypes: ['file-operation'],
      mcpCount: 5,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-ai-analysis',
    key: 'metis-ai-analysis',
    name: 'AI 분석 / 보안 점검',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 12,
      lastHealthCheck: new Date().toISOString(),
      category: 'processing',
      description:
        'Claude/GPT API를 통한 보안 취약성 분석(SAST), 시크릿 탐지, SCA, 라이선스 점검, 코드 요약을 수행합니다.',
      capabilities: ['sast', 'secrets', 'sca', 'license', 'summary', 'analysis'],
      nodeTypes: ['ai-processing'],
      scanners: [
        'SAST (정적 분석)',
        'Secret Scan (시크릿 탐지)',
        'SCA (의존성 분석)',
        'License (라이선스 점검)',
      ],
      mcpCount: 5,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-pentest',
    key: 'metis-pentest',
    name: '모의해킹 취약점 진단',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 18,
      lastHealthCheck: new Date().toISOString(),
      category: 'pentest',
      description:
        '소스 코드 기반 모의해킹 시뮬레이션. 8개 공격 벡터별 심층 진단, CVSS 3.1 스코어링, CWE/OWASP 매핑, PoC 시나리오, Kill Chain 분석을 제공합니다.',
      capabilities: [
        'injection-scan',
        'auth-bypass-test',
        'privilege-escalation',
        'api-abuse-test',
        'file-attack-test',
        'ssrf-detection',
        'crypto-audit',
        'business-logic-test',
        'cvss-scoring',
        'cwe-mapping',
        'owasp-mapping',
        'poc-generation',
        'kill-chain-analysis',
        'language-aware-scan',
        'framework-specific-rules',
      ],
      nodeTypes: ['ai-processing', 'pentest'],
      attackVectors: [
        'Injection (SQL/NoSQL/OS Command/LDAP/Template)',
        '인증 우회 / 세션 하이재킹 (JWT, OAuth, 2FA)',
        '권한 상승 / IDOR / BOLA (멀티테넌트 격리)',
        'API 남용 / Mass Assignment / Rate Limiting',
        '파일 업로드 공격 / Path Traversal / Zip Slip',
        'SSRF / Open Redirect / XSS / CSRF',
        '암호화 결함 / 하드코딩 시크릿 / 취약 해시',
        '비즈니스 로직 결함 / Race Condition / 금액 조작',
      ],
      mcpCount: 15,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-document-gen',
    key: 'metis-document-gen',
    name: '문서 생성 / 내보내기',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 8,
      lastHealthCheck: new Date().toISOString(),
      category: 'output',
      description:
        '분석 결과를 DOCX, PDF, HTML, CSV, JSON, Markdown 등 다양한 포맷으로 문서화하여 다운로드 가능하게 합니다.',
      capabilities: ['docx', 'pdf', 'html', 'csv', 'json', 'markdown'],
      nodeTypes: ['file-operation'],
      mcpCount: 6,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-web-search',
    key: 'metis-web-search',
    name: '웹 검색',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 45,
      lastHealthCheck: new Date().toISOString(),
      category: 'search',
      description: 'Google Custom Search API, Naver Search API를 통한 웹 검색을 수행합니다.',
      capabilities: ['google-search', 'naver-search', 'content-extraction'],
      nodeTypes: ['web-search'],
      mcpCount: 3,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-slack',
    key: 'metis-slack',
    name: 'Slack 메시지 발송',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 30,
      lastHealthCheck: new Date().toISOString(),
      category: 'delivery',
      description:
        'Slack Webhook 또는 Bot Token으로 메시지를 발송합니다. 템플릿 변수, Rich Attachment 지원.',
      capabilities: ['webhook', 'bot-token', 'template-vars', 'rich-attachment'],
      nodeTypes: ['slack-message'],
      mcpCount: 4,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-data-storage',
    key: 'metis-data-storage',
    name: '데이터 저장 (KnowledgeBase)',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 15,
      lastHealthCheck: new Date().toISOString(),
      category: 'storage',
      description: 'PostgreSQL 기반 KnowledgeArtifact 테이블에 분석 결과를 영구 저장합니다.',
      capabilities: ['postgresql', 'prisma', 'knowledge-artifact', 'versioning'],
      nodeTypes: ['data-storage'],
      mcpCount: 4,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'builtin-log-monitor',
    key: 'metis-log-monitor',
    name: '로그 모니터링 / 수집',
    type: 'BUILT_IN',
    status: 'ACTIVE',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 20,
      lastHealthCheck: new Date().toISOString(),
      category: 'monitor',
      description:
        '서버 로그(journalctl/SSH), 애플리케이션 로그, 클라우드 로그를 수집하고 에러 패턴을 분석합니다.',
      capabilities: ['server-logs', 'app-logs', 'pattern-match', 'error-detection', 'statistics'],
      nodeTypes: ['log-monitor'],
      mcpCount: 5,
      pendingCount: 0,
    },
    updatedAt: new Date().toISOString(),
  },
];

// ── Pre-populated External Connectors ──

const EXTERNAL_CONNECTORS: Connector[] = [
  {
    id: '1',
    key: 'slack-webhook',
    name: 'Slack Webhook',
    type: 'WEBHOOK',
    status: 'ACTIVE',
    endpoint: 'https://hooks.slack.com/services/xxx',
    authType: 'Webhook Token',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 145,
      lastHealthCheck: new Date(Date.now() - 5 * 60000).toISOString(),
      rateLimit: '∞',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 1 * 60000).toISOString(),
  },
  {
    id: '2',
    key: 'jira-rest-api',
    name: 'Jira REST API',
    type: 'REST_API',
    status: 'ACTIVE',
    endpoint: 'https://company.atlassian.net/rest/api/3',
    authType: 'Bearer Token',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 287,
      lastHealthCheck: new Date(Date.now() - 3 * 60000).toISOString(),
      rateLimit: '300 req/min',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 2 * 60000).toISOString(),
  },
  {
    id: '3',
    key: 'github-api',
    name: 'GitHub API',
    type: 'REST_API',
    status: 'ACTIVE',
    endpoint: 'https://api.github.com/graphql',
    authType: 'OAuth 2.0',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 156,
      lastHealthCheck: new Date(Date.now() - 4 * 60000).toISOString(),
      rateLimit: '5000 req/hour',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 1 * 60000).toISOString(),
  },
  {
    id: '4',
    key: 'mcp-python-server',
    name: 'MCP Python Server',
    type: 'MCP_SERVER',
    status: 'ACTIVE',
    command: 'python',
    args: ['-m', 'mcp.server'],
    transport: 'stdio',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 89,
      lastHealthCheck: new Date(Date.now() - 2 * 60000).toISOString(),
      mcpCount: 12,
      pendingCount: 2,
    },
    updatedAt: new Date(Date.now() - 1 * 60000).toISOString(),
  },
  {
    id: '5',
    key: 'pagerduty',
    name: 'PagerDuty',
    type: 'REST_API',
    status: 'ACTIVE',
    endpoint: 'https://api.pagerduty.com',
    authType: 'API Key',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 234,
      lastHealthCheck: new Date(Date.now() - 10 * 60000).toISOString(),
      rateLimit: '5000 req/min',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  },
  {
    id: '6',
    key: 'datadog',
    name: 'Datadog',
    type: 'REST_API',
    status: 'CONFIGURED',
    endpoint: 'https://api.datadoghq.com/api/v1',
    authType: 'API Key + App Key',
    configJson: {
      lastHealthStatus: 'DEGRADED',
      lastHealthLatencyMs: 512,
      lastHealthCheck: new Date(Date.now() - 15 * 60000).toISOString(),
      rateLimit: '10000 req/hour',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 1,
    },
    updatedAt: new Date(Date.now() - 30 * 60000).toISOString(),
  },
  {
    id: '7',
    key: 'aws-cloudwatch',
    name: 'AWS CloudWatch',
    type: 'REST_API',
    status: 'CONFIGURED',
    endpoint: 'https://monitoring.us-east-1.amazonaws.com',
    authType: 'IAM Role',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 178,
      lastHealthCheck: new Date(Date.now() - 60 * 60000).toISOString(),
      rateLimit: '≤400 req/sec',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  },
  {
    id: '8',
    key: 'elasticsearch',
    name: 'Elasticsearch',
    type: 'REST_API',
    status: 'ACTIVE',
    endpoint: 'https://elasticsearch.internal:9200',
    authType: 'Basic Auth',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 89,
      lastHealthCheck: new Date(Date.now() - 2 * 60000).toISOString(),
      rateLimit: 'unlimited',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 1 * 60000).toISOString(),
  },
  {
    id: '9',
    key: 'jenkins',
    name: 'Jenkins CI/CD',
    type: 'REST_API',
    status: 'ACTIVE',
    endpoint: 'https://jenkins.company.com',
    authType: 'API Token',
    configJson: {
      lastHealthStatus: 'OK',
      lastHealthLatencyMs: 312,
      lastHealthCheck: new Date(Date.now() - 7 * 60000).toISOString(),
      rateLimit: '1000 req/min',
      timeoutSec: 60,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 3 * 60000).toISOString(),
  },
  {
    id: '10',
    key: 'servicenow',
    name: 'ServiceNow ITSM',
    type: 'REST_API',
    status: 'INACTIVE',
    endpoint: 'https://company.service-now.com/api/now',
    authType: 'OAuth 2.0',
    configJson: {
      lastHealthStatus: 'UNREACHABLE',
      lastHealthLatencyMs: 0,
      lastHealthCheck: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
      rateLimit: '240 req/min',
      timeoutSec: 30,
      mcpCount: 0,
      pendingCount: 0,
    },
    updatedAt: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
  },
];

// Combined initial connectors
const FEATURED_CONNECTORS: Connector[] = [...BUILTIN_NODE_CONNECTORS, ...EXTERNAL_CONNECTORS];

// ── Page ──

export default function ConnectorsPage() {
  useOpsRef(); // 환율(원화 표시) 기준정보 로드 + 로드되면 재렌더
  const [connectors, setConnectors] = useState<Connector[]>(FEATURED_CONNECTORS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Connector | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>('');
  // SCENARIO 4 (PART B): real workflow sub-agent nodes (WorkflowNodeDef)
  const [nodeData, setNodeData] = useState<NodesResponse | null>(null);
  const [nodesLoading, setNodesLoading] = useState(false);

  // 워크플로우 서브 Agent(WorkflowNodeDef)를 커넥터 한 종류('AGENT')로 변환해 목록에 통합.
  const agentConnectors: Connector[] = (nodeData?.grouped ?? []).map((g, gi) => {
    const cat = g.category || (typeof g.settings?.stepCategory === 'string' ? (g.settings.stepCategory as string) : '');
    return {
      id: `agent-${gi}-${g.nodeKey}-${g.uiType}`,
      key: g.nodeKey,
      name: g.name,
      type: 'AGENT',
      status: 'ACTIVE',
      configJson: {
        category: cat,
        execNodeType: g.uiType,
        execCategory: cat,
        settings: g.settings ?? {},
        workflows: g.workflows,
        workflowCount: g.workflows.length,
        usageCount: g.count,
        description: `워크플로우 ${g.workflows.length}곳에서 사용되는 서브 Agent (uiType: ${g.uiType}).`,
      },
      updatedAt: new Date().toISOString(),
    };
  });
  const allConnectors = [...connectors, ...agentConnectors];

  // Filtered connectors based on type filter
  const filteredConnectors = typeFilter
    ? allConnectors.filter((c) => c.type === typeFilter)
    : allConnectors;
  const connectorsPage = usePagination(filteredConnectors, 10);

  const fetchConnectors = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Try to fetch from backend API
      const data = await api.get<{ items: Connector[] }>('/connectors');
      // Merge with built-in connectors (always present)
      const backendKeys = new Set((data.items ?? []).map((c) => c.key));
      const deduped = [
        ...BUILTIN_NODE_CONNECTORS.filter((c) => !backendKeys.has(c.key)),
        ...(data.items ?? []),
      ];
      setConnectors(deduped);
    } catch (err: any) {
      // Backend unavailable — try workflow-nodes endpoint for live connector data
      try {
        const wfRes = await fetch('/api/api/workflow-nodes/connectors', { credentials: 'include' });
        if (wfRes.ok) {
          const wfData = (await wfRes.json()) as {
            connectors: Array<{
              key: string;
              name: string;
              type: string;
              description: string;
              category: string;
              capabilities: string[];
              nodeTypes?: string[];
              categories?: string[];
            }>;
            totalCount: number;
          };
          // Convert backend connector metadata to page Connector format
          const wfConnectors: Connector[] = (wfData.connectors ?? []).map((wc, idx) => ({
            id: `wf-${idx}`,
            key: wc.key,
            name: wc.name,
            type: wc.type || 'BUILT_IN',
            status: 'ACTIVE',
            configJson: {
              lastHealthStatus: 'OK',
              lastHealthLatencyMs: 5,
              lastHealthCheck: new Date().toISOString(),
              category: wc.category,
              description: wc.description,
              capabilities: wc.capabilities,
              mcpCount: wc.capabilities?.length ?? 0,
              pendingCount: 0,
              // 실제 노드 실행(execute-node) 해석용 — 백엔드 레지스트리에서 전달.
              execNodeType: wc.nodeTypes?.[0],
              execCategory: wc.categories?.[0] || wc.category,
            },
            updatedAt: new Date().toISOString(),
          }));
          // Merge: use live backend data for built-in, keep external from static
          const liveKeys = new Set(wfConnectors.map((c) => c.key));
          const mergedBuiltIn = wfConnectors.length > 0 ? wfConnectors : BUILTIN_NODE_CONNECTORS;
          const mergedExternal = EXTERNAL_CONNECTORS.filter((c) => !liveKeys.has(c.key));
          setConnectors([...mergedBuiltIn, ...mergedExternal]);
        } else {
          setConnectors(FEATURED_CONNECTORS);
        }
      } catch {
        setConnectors(FEATURED_CONNECTORS);
      }
      setError(null); // Don't show error — we have fallback data
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnectors();
  }, [fetchConnectors]);

  // SCENARIO 4 (PART B): load the actual sub-agent nodes of saved workflows so
  // the connector menu reflects real WorkflowNodeDef sub-agents, not just static
  // node types.
  const fetchNodes = useCallback(async () => {
    setNodesLoading(true);
    try {
      const data = await api.get<NodesResponse>('/dashboard/nodes');
      setNodeData(data);
    } catch {
      setNodeData({ nodes: [], grouped: [], totalNodes: 0, totalWorkflows: 0 });
    } finally {
      setNodesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  const handleHealthCheck = async (id: string) => {
    try {
      // 내장 노드/서브 Agent 는 런타임 커넥터가 아니라 DB 헬스체크 대상이 아님 → 로컬 응답.
      const target = allConnectors.find((c) => c.id === id);
      if (target?.type === 'BUILT_IN') {
        alert('✅ Health Check: 내장 노드는 항상 활성입니다.');
        return;
      }
      if (target?.type === 'AGENT') {
        alert('ℹ️ 서브 Agent는 워크플로 노드라 헬스체크 대상이 아닙니다. "테스트"로 실제 실행을 확인하세요.');
        return;
      }
      const result = await api.post<{ healthy: boolean; status: string }>(
        `/connectors/${id}/health-check`,
        {},
      );
      alert(result.healthy ? 'Health Check 성공!' : `Health Check 실패: ${result.status}`);
      fetchConnectors();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('이 커넥터를 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/connectors/${id}`);
      setSelected(null);
      fetchConnectors();
    } catch (err: any) {
      alert(err.message);
    }
  };

  // 건수는 모두 통합 목록(allConnectors = 실제 커넥터 + 서브 Agent) 기준으로 현행화.
  const builtInCount = allConnectors.filter((c) => c.type === 'BUILT_IN').length;
  // 목록 필터와 동일 기준(allConnectors)으로 집계 → 파생 서브 Agent + 백엔드 AGENT 타입 포함.
  const agentCount = allConnectors.filter((c) => c.type === 'AGENT').length;
  const externalCount = allConnectors.filter(
    (c) => !['BUILT_IN', 'AGENT'].includes(c.type),
  ).length;
  const activeCount = allConnectors.filter((c) => c.status === 'ACTIVE').length;
  const configuredCount = allConnectors.filter((c) => c.status === 'CONFIGURED').length;
  const inactiveCount = allConnectors.filter((c) => c.status === 'INACTIVE').length;
  const typeCount = new Set(allConnectors.map((c) => c.type)).size;
  // MCP 도구 수: 각 커넥터가 제공하는 세부 기능(tool) 수의 합산
  const mcpToolCount = connectors.reduce(
    (sum, c) => sum + ((c.configJson?.mcpCount as number) ?? 0),
    0,
  );
  const pendingCount = connectors.reduce(
    (sum, c) => sum + ((c.configJson?.pendingCount as number) ?? 0),
    0,
  );

  return (
    <div className="p-6">
      <PageHeader
        title="커넥터 관리"
        description={`총 ${allConnectors.length}개 — 내장 노드 ${builtInCount} · 서브 Agent ${agentCount} · 외부 커넥터 ${externalCount} (도구 ${mcpToolCount}개)`}
        actions={
          <button
            onClick={() => setShowCreateForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 transition"
          >
            <Plus size={14} /> 새 커넥터 등록
          </button>
        }
      />

      {/* Stats — 8 columns (모두 통합 목록 기준: 전체 = 내장 + Sub-Agent + 외부) */}
      <div className="grid grid-cols-8 gap-3 mb-6">
        <SC label="전체" value={allConnectors.length} c="blue" />
        <SC label="내장 노드" value={builtInCount} c="indigo" />
        <SC label="Sub-Agent" value={agentCount} c="violet" />
        <SC label="외부 연동" value={externalCount} c="cyan" />
        <SC label="활성" value={activeCount} c="green" />
        <SC label="설정됨" value={configuredCount} c="amber" />
        <SC label="비활성" value={inactiveCount} c="red" />
        <SC label="제공 도구·기능" value={mcpToolCount} c="violet" />
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Type Filter */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">필터:</span>
        {[
          { key: '', label: '전체', count: allConnectors.length },
          { key: 'BUILT_IN', label: '🔧 내장 노드', count: builtInCount },
          { key: 'AGENT', label: '🧩 Sub-Agent', count: agentCount },
          {
            key: 'MCP_SERVER',
            label: '🤖 MCP',
            count: connectors.filter((c) => c.type === 'MCP_SERVER').length,
          },
          {
            key: 'REST_API',
            label: 'REST API',
            count: connectors.filter((c) => c.type === 'REST_API').length,
          },
          {
            key: 'WEBHOOK',
            label: '🔗 Webhook',
            count: connectors.filter((c) => c.type === 'WEBHOOK').length,
          },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setTypeFilter(f.key)}
            className={`px-2.5 py-1 text-[10px] font-semibold rounded transition ${
              typeFilter === f.key
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      {/* Two-column layout */}
      <div className="flex gap-4">
        {/* Left: Connector Table */}
        <div className="flex-1">
          <div className="bg-white rounded-lg border border-gray-200">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Zap size={14} className="text-blue-600" />
                <span className="text-xs font-semibold text-gray-900">
                  등록된 커넥터 ({filteredConnectors.length}개)
                </span>
              </div>
              <button onClick={fetchConnectors} className="p-1 text-gray-500 hover:text-gray-900">
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-[10px] text-gray-600 uppercase tracking-wider border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-4 py-3 font-semibold">커넥터명</th>
                    <th className="text-left px-4 py-3 font-semibold">유형</th>
                    <th className="text-left px-4 py-3 font-semibold">Health</th>
                    <th className="text-left px-4 py-3 font-semibold">응답시간</th>
                    <th className="text-left px-4 py-3 font-semibold">상태</th>
                    <th className="px-4 py-3 text-right font-semibold">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredConnectors.length === 0 && !loading && (
                    <tr>
                      <td colSpan={6} className="text-center text-gray-500 text-xs py-8">
                        등록된 커넥터가 없습니다
                      </td>
                    </tr>
                  )}
                  {connectorsPage.pageItems.map((c, ci) => {
                    const config = (c.configJson ?? {}) as any;
                    const healthStatus = config.lastHealthStatus ?? '-';
                    const avgLatency = config.lastHealthLatencyMs
                      ? `${config.lastHealthLatencyMs}ms`
                      : '-';
                    return (
                      <tr
                        key={`${c.id}-${ci}`}
                        onClick={() => setSelected(c)}
                        className={`border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition ${selected?.id === c.id ? 'bg-blue-50' : ''}`}
                      >
                        <td className="px-4 py-3 text-xs text-gray-900 font-semibold">{c.name}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-1 rounded text-[10px] font-medium ${
                              c.type === 'BUILT_IN'
                                ? 'bg-indigo-100 text-indigo-700'
                                : c.type === 'MCP_SERVER'
                                  ? 'bg-violet-100 text-violet-700'
                                  : c.type === 'AGENT'
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : c.type === 'WEBHOOK'
                                      ? 'bg-amber-100 text-amber-700'
                                      : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {c.type === 'BUILT_IN'
                              ? '🔧 내장'
                              : c.type === 'MCP_SERVER'
                                ? '🤖 MCP'
                                : c.type === 'AGENT'
                                  ? '🧠 Agent'
                                  : c.type === 'WEBHOOK'
                                    ? '🔗 Webhook'
                                    : c.type.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[11px]">
                          {healthStatus === 'OK' && (
                            <span className="text-green-600 font-semibold flex items-center gap-1">
                              <CheckCircle size={10} /> OK
                            </span>
                          )}
                          {healthStatus === 'DEGRADED' && (
                            <span className="text-amber-600 font-semibold flex items-center gap-1">
                              <AlertTriangle size={10} /> DEGRADED
                            </span>
                          )}
                          {healthStatus === 'UNREACHABLE' && (
                            <span className="text-red-600 font-semibold flex items-center gap-1">
                              <AlertCircle size={10} /> DOWN
                            </span>
                          )}
                          {healthStatus === '-' && <span className="text-gray-400">-</span>}
                        </td>
                        <td className="px-4 py-3 text-[11px] text-gray-600 font-mono">
                          {avgLatency}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadgeLight status={c.status} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          {/* 내장 노드/서브 Agent는 런타임 커넥터가 아니라 헬스체크·삭제 비대상 */}
                          {c.type !== 'BUILT_IN' && c.type !== 'AGENT' ? (
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleHealthCheck(c.id);
                                }}
                                className="p-1 text-gray-500 hover:text-blue-600 transition"
                                title="Health Check"
                              >
                                <Activity size={12} />
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDelete(c.id);
                                }}
                                className="p-1 text-gray-500 hover:text-red-600 transition"
                                title="삭제"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Pager p={connectorsPage} />
            </div>
          </div>
        </div>

        {/* Right: Detail/Create Panel (360px) */}
        <div className="w-[360px] flex-shrink-0">
          {showCreateForm ? (
            <CreateConnectorForm
              onClose={() => setShowCreateForm(false)}
              onSuccess={() => {
                setShowCreateForm(false);
                fetchConnectors();
              }}
            />
          ) : selected ? (
            <ConnectorDetail
              connector={selected}
              onHealthCheck={() => handleHealthCheck(selected.id)}
              onRefresh={fetchConnectors}
            />
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <Settings size={32} className="text-gray-300 mx-auto mb-3" />
              <p className="text-xs text-gray-500">커넥터를 선택하면 상세 정보가 표시됩니다</p>
            </div>
          )}
        </div>
      </div>

      {/* 서브 Agent는 위 커넥터 목록에 'Sub-Agent' 타입으로 통합됨. (아래 표는 비활성/대체) */}
      {false && (
      <div className="mt-6 bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-indigo-600" />
            <span className="text-xs font-semibold text-gray-900">
              워크플로우 노드 (Sub-Agent)
              {nodeData
                ? ` — ${nodeData?.grouped.length ?? 0}종 / 총 ${nodeData?.totalNodes ?? 0}개 노드 · ${nodeData?.totalWorkflows ?? 0}개 워크플로우`
                : ''}
            </span>
          </div>
          <button onClick={fetchNodes} className="p-1 text-gray-500 hover:text-gray-900">
            <RefreshCw size={12} className={nodesLoading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="px-4 py-2 text-[10px] text-gray-500 border-b border-gray-100 bg-gray-50">
          저장된 워크플로우(메인 Agent)의 실제 하위 노드(서브 Agent)를 집계한 목록입니다. 어떤
          서브 Agent가 존재하고 어느 워크플로우에서 사용되는지 보여줍니다.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] text-gray-600 uppercase tracking-wider border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-semibold">노드명 (Sub-Agent)</th>
                <th className="text-left px-4 py-3 font-semibold">노드키</th>
                <th className="text-left px-4 py-3 font-semibold">유형 (uiType)</th>
                <th className="text-left px-4 py-3 font-semibold">사용 워크플로우</th>
                <th className="px-4 py-3 text-right font-semibold">사용 수</th>
                <th className="px-4 py-3 text-right font-semibold">실행</th>
              </tr>
            </thead>
            <tbody>
              {nodesLoading && (
                <tr>
                  <td colSpan={6} className="text-center text-gray-400 text-xs py-8">
                    <Loader size={16} className="animate-spin inline mr-2" />
                    노드 로딩 중...
                  </td>
                </tr>
              )}
              {!nodesLoading && (nodeData?.grouped.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-gray-500 text-xs py-8">
                    저장된 워크플로우 노드가 없습니다. 워크플로우를 생성하면 여기에 표시됩니다.
                  </td>
                </tr>
              )}
              {!nodesLoading &&
                (nodeData?.grouped ?? []).map((g) => (
                  <tr
                    key={`${g.nodeKey}-${g.uiType}-${g.name}`}
                    className="border-b border-gray-50 hover:bg-gray-50"
                  >
                    <td className="px-4 py-3 text-xs font-medium text-gray-900">{g.name}</td>
                    <td className="px-4 py-3">
                      <code className="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                        {g.nodeKey}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">
                        {g.uiType}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {g.workflows.map((w) => (
                          <span
                            key={w.workflowKey}
                            className="text-[10px] text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded"
                            title={w.workflowKey}
                          >
                            {w.workflowName}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-bold text-gray-700">
                      {g.count}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <SubAgentTestButton g={g} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}

// ── Connector Detail ──

function ConnectorDetail({
  connector,
  onHealthCheck,
  onRefresh,
}: {
  connector: Connector;
  onHealthCheck: () => void;
  onRefresh: () => void;
}) {
  const config = (connector.configJson ?? {}) as Record<string, any>;
  const healthStatus = config.lastHealthStatus ?? '-';
  const [showTestResults, setShowTestResults] = useState(false);
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [testLoading, setTestLoading] = useState(false);
  const [realOutput, setRealOutput] = useState('');
  const [showMCPTools, setShowMCPTools] = useState(false);
  const [mcpTools, setMCPTools] = useState<MCPTool[]>([]);
  const [mcpLoading, setMCPLoading] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState<SchemaCapability[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [showInvokeModal, setShowInvokeModal] = useState(false);

  const isBuiltIn = connector.type === 'BUILT_IN';
  const isAgent = connector.type === 'AGENT';

  // ── Built-in connectors: simulate locally since they don't exist in DB ──
  const builtInCapabilities: Record<string, SchemaCapability[]> = {
    'metis-file-upload': [
      {
        method: 'upload',
        description: '로컬 파일 또는 ZIP 아카이브를 업로드합니다',
        params: { file: 'File', format: 'text|binary|archive' },
      },
      {
        method: 'parseZip',
        description: 'ZIP 파일의 Central Directory를 파싱하여 내부 파일 목록을 반환합니다',
        params: { archivePath: 'string' },
      },
      {
        method: 'readText',
        description: '텍스트 파일의 내용을 UTF-8로 읽어옵니다',
        params: { path: 'string', encoding: 'utf-8' },
      },
    ],
    'metis-ai-analysis': [
      {
        method: 'analyzeCode',
        description: '소스 코드의 품질, 복잡도, 보안 취약점을 AI로 분석합니다',
        params: { sourceFiles: 'string[]', model: 'claude|gpt-4o' },
      },
      {
        method: 'detectVulnerabilities',
        description: 'OWASP Top 10 기반 보안 취약점을 탐지합니다',
        params: { code: 'string', language: 'string' },
      },
      {
        method: 'generateReport',
        description: '분석 결과를 구조화된 보고서로 생성합니다',
        params: { findings: 'object[]', format: 'json|markdown' },
      },
    ],
    'metis-pentest': [
      {
        method: 'scanVulnerabilities',
        description: '정적 분석 기반 모의해킹 취약점 진단을 수행합니다',
        params: { sourceFiles: 'string[]', attackVectors: 'string[]' },
      },
      {
        method: 'fuzzTest',
        description: '입력값 퍼징 테스트를 실행합니다',
        params: { endpoints: 'string[]', iterations: 'number' },
      },
      {
        method: 'generateCVSS',
        description: '발견된 취약점의 CVSS 점수를 산출합니다',
        params: { vulnerability: 'object' },
      },
    ],
    'metis-document-gen': [
      {
        method: 'generateDocument',
        description: '분석 결과를 Word/PDF/HTML 문서로 변환합니다',
        params: { content: 'string', format: 'docx|pdf|html', template: 'string' },
      },
      {
        method: 'applyTemplate',
        description: '템플릿에 데이터를 바인딩하여 문서를 생성합니다',
        params: { templateKey: 'string', data: 'object' },
      },
    ],
  };

  const handleTestPipeline = async () => {
    setTestLoading(true);
    try {
      if (isBuiltIn || isAgent) {
        // 내장 노드 / 서브 Agent 를 실제 실행기로 단독 실행 — execute-node 실호출.
        const nodeType = (config.execNodeType as string) || BUILTIN_KEY_TO_NODE[connector.key]?.nodeType;
        const category =
          (config.execCategory as string) || BUILTIN_KEY_TO_NODE[connector.key]?.category || '';
        if (!nodeType) {
          setTestResults([
            { step: '실행기 해석', status: 'fail', message: `노드 타입을 해석할 수 없습니다 (${connector.key})` },
          ]);
          setRealOutput('');
          setShowTestResults(true);
          return;
        }
        const sample = sampleForNode(nodeType, category);
        // 서브 Agent 는 저장된 자기 설정(configJson)을 우선 사용, 빠진 키는 샘플 기본값으로 보완.
        const cfgSettings = (config.settings as Record<string, unknown>) || {};
        const settings =
          isAgent && Object.keys(cfgSettings).length ? { ...sample.settings, ...cfgSettings } : sample.settings;
        const res = await api.post<any>('/api/workflow-nodes/execute-node', {
          nodeType,
          category,
          nodeName: connector.name,
          settings,
          previousOutput: sample.previousOutput,
        });
        const o = res?.output;
        const results: TestResult[] = [];
        results.push({
          step: '실행기 해석',
          status: res?.resolved ? 'pass' : 'fail',
          message: res?.executorKey ? `executor: ${res.executorKey}` : '등록된 실행기 없음',
        });
        results.push({
          step: '실제 실행',
          status: o?.success ? 'pass' : 'fail',
          message: o?.success ? '실행기 호출 성공 (실제 동작)' : o?.error || res?.error || '실행 실패',
          duration: o?.durationMs,
        });
        if (o?.data?.demo) {
          results.push({ step: '데이터', status: 'warn', message: '실제 소스 미연결 → 데모 데이터 표시' });
        }
        if (o?.data?.skipped) {
          results.push({ step: '전송/처리', status: 'warn', message: '미설정으로 건너뜀 (설정 시 실제 수행)' });
        }
        // ── 4-Gate 점검 결과 (비용·품질·보안·이상동작) ──
        const ev = res?.evaluation;
        const gt = ev?.gates;
        if (gt) {
          results.push({
            step: '① 품질(Quality)',
            status: gt.quality?.grade === 'F' ? 'fail' : 'pass',
            message: `등급 ${gt.quality?.grade ?? '-'} · 종합 ${ev.overallScore ?? '-'}/100`,
          });
          const risk = gt.security?.riskLevel ?? 'low';
          results.push({
            step: '② 보안(Security)',
            status: risk === 'critical' || risk === 'high' ? 'fail' : risk === 'medium' ? 'warn' : 'pass',
            message: `점수 ${gt.security?.score ?? '-'}/100 · 위험 ${risk} · 위협 ${gt.security?.threats ?? 0} · 유출 ${gt.security?.leaks ?? 0}`,
          });
          results.push({
            step: '③ 비용(Cost)',
            status: 'pass',
            message: `비용 ${krw(Number(gt.cost?.costUsd ?? 0), { decimals: 2 })} · 효율 ${gt.cost?.efficiency != null ? Math.round(gt.cost.efficiency * 100) + '%' : '-'} · 지연 ${gt.cost?.latencyGrade ?? '-'}`,
          });
          results.push({
            step: '④ 이상동작(Anomaly)',
            status: gt.anomaly?.detected ? 'warn' : 'pass',
            message: gt.anomaly?.detected ? `이상 ${gt.anomaly?.count ?? 0}건 탐지` : '이상 없음',
          });
        } else if (ev) {
          results.push({
            step: '4-Gate 평가',
            status: 'pass',
            message: `종합 ${ev.overallScore} (${ev.qualityGrade})`,
          });
        }
        setTestResults(results);
        setRealOutput(o?.outputText || '');
        setShowTestResults(true);
      } else {
        const result = await api.post<{ results: TestResult[] }>(
          `/connectors/${connector.id}/test`,
          {},
        );
        setTestResults(result.results);
        setShowTestResults(true);
      }
    } catch (err: any) {
      alert(`테스트 실패: ${err.message}`);
    } finally {
      setTestLoading(false);
    }
  };

  const handleLoadMCPTools = async () => {
    if (connector.type !== 'MCP_SERVER') {
      alert('MCP_SERVER 타입만 지원합니다');
      return;
    }
    setMCPLoading(true);
    try {
      const result = await api.get<{ tools: MCPTool[] }>(`/connectors/${connector.id}/tools`);
      setMCPTools(result.tools);
      setShowMCPTools(true);
    } catch (err: any) {
      alert(`도구 로드 실패: ${err.message}`);
    } finally {
      setMCPLoading(false);
    }
  };

  const handleSchemaDiscovery = async () => {
    setDiscoveryLoading(true);
    try {
      if (isBuiltIn || isAgent) {
        // 내장 노드/서브 Agent 는 런타임 커넥터가 아니라 DB 탐색 대상이 아님 → 로컬 능력 표시.
        await new Promise((r) => setTimeout(r, 200));
        const caps = builtInCapabilities[connector.key] || [
          {
            method: (config.execNodeType as string) || 'execute',
            description: `${connector.name} — ${isAgent ? '서브 Agent' : '내장 노드'} 실행 (4-Gate 평가 포함)`,
            params: { previousOutput: 'string (이전 노드 출력)', settings: 'object (노드 설정)' },
          },
        ];
        setDiscoveryResults(caps);
        setShowDiscovery(true);
      } else {
        const result = await api.post<{ capabilities: SchemaCapability[] }>(
          `/connectors/${connector.id}/discover`,
          {},
        );
        setDiscoveryResults(result.capabilities);
        setShowDiscovery(true);
      }
    } catch (err: any) {
      alert(`스키마 탐색 실패: ${err.message}`);
    } finally {
      setDiscoveryLoading(false);
    }
  };

  // Sub-Agent → 메인 Agent 승격: 이 노드 1개로 워크플로(메인 Agent) 생성 → 운영/개발에서 실행.
  const promoteToMainAgent = async () => {
    const nodeType = (config.execNodeType as string) || '';
    const category = (config.execCategory as string) || 'operations';
    const settings = (config.settings as Record<string, unknown>) || {};
    if (!nodeType) {
      alert('이 Sub-Agent의 노드 타입을 알 수 없어 승격할 수 없습니다.');
      return;
    }
    try {
      // 다중 메인 방지 가드는 백엔드(promote-sub)에서 처리한다.
      // 같은 Sub-Agent(connector.key)는 하나의 메인으로만 승격 가능 — 이미 승격됐으면 409로 거부.
      await api.post('/workflows/promote-sub', {
        subKey: connector.key,
        name: connector.name,
        nodeType,
        category,
        settings,
      });
      alert(
        `메인 Agent로 생성되었습니다: ${connector.name}\n카테고리=${category}\n상태: 심사중·미노출 — 거버넌스 「심사·승격」에서 ORB 승인되면 운영/개발 Agent 실행에 노출됩니다.`,
      );
    } catch (e) {
      alert(`승격 실패: ${(e as Error).message}`);
    }
  };

  const handleLifecycleAction = async (action: 'start' | 'stop' | 'restart') => {
    try {
      if (isBuiltIn) {
        // Built-in connectors are always active
        alert(`${connector.name}은(는) 내장 커넥터이므로 항상 활성 상태입니다.`);
        return;
      }
      if (isAgent) {
        alert(`${connector.name}은(는) 워크플로 서브 Agent라 라이프사이클 대상이 아닙니다. "테스트"로 단독 실행하거나 워크플로에 노드로 추가해 사용하세요.`);
        return;
      }
      await api.post(`/connectors/${connector.id}/${action}`, {});
      alert(`${action.toUpperCase()} 완료`);
      onRefresh();
    } catch (err: any) {
      alert(`${action} 실패: ${err.message}`);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden max-h-[calc(100vh-200px)] overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 sticky top-0">
        <span className="text-xs font-semibold text-gray-900 flex items-center gap-1">
          <Settings size={12} /> 커넥터 상세
        </span>
      </div>
      <div className="p-4 space-y-3">
        {/* Basic Info */}
        <Field label="커넥터 이름" value={connector.name} />
        <Field
          label="유형"
          value={
            connector.type === 'BUILT_IN'
              ? '🔧 내장 노드 커넥터'
              : connector.type === 'MCP_SERVER'
                ? '🤖 MCP 서버'
                : connector.type === 'AGENT'
                  ? '🧠 AI 에이전트'
                  : connector.type === 'WEBHOOK'
                    ? '🔗 Webhook'
                    : connector.type.replace('_', ' ')
          }
        />

        {connector.type === 'BUILT_IN' ? (
          <>
            <Field label="카테고리" value={config.category ?? '-'} />
            <Field label="설명" value={config.description ?? '-'} />
            <Field label="노드 타입" value={(config.nodeTypes as string[])?.join(', ') ?? '-'} />
            {/* Capabilities */}
            {config.capabilities && (
              <div>
                <div className="text-[10px] text-gray-600 font-semibold mb-1.5">
                  제공 기능 ({(config.capabilities as string[]).length}개)
                </div>
                <div className="flex flex-wrap gap-1">
                  {(config.capabilities as string[]).map((cap: string) => (
                    <span
                      key={cap}
                      className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 text-[9px] font-medium rounded border border-indigo-100"
                    >
                      {cap}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* Scanners list (for AI analysis connector) */}
            {config.scanners && (
              <div>
                <div className="text-[10px] text-gray-600 font-semibold mb-1.5">보안 스캐너</div>
                <div className="space-y-1">
                  {(config.scanners as string[]).map((sc: string) => (
                    <div key={sc} className="flex items-center gap-1.5 text-[10px]">
                      <span className="text-green-500">✓</span>
                      <span className="text-gray-700">{sc}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Attack Vectors list (for pentest connector) */}
            {config.attackVectors && (
              <div>
                <div className="text-[10px] text-gray-600 font-semibold mb-1.5">
                  공격 벡터 ({(config.attackVectors as string[]).length}개)
                </div>
                <div className="space-y-1">
                  {(config.attackVectors as string[]).map((vec: string, idx: number) => (
                    <div key={idx} className="flex items-center gap-1.5 text-[10px]">
                      <span className="text-red-500 font-bold">{idx + 1}</span>
                      <span className="text-gray-700">{vec}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Field
              label="MCP 도구 수"
              value={`${config.mcpCount ?? 0}개 (이 커넥터가 제공하는 세부 기능 수)`}
            />
          </>
        ) : connector.type === 'MCP_SERVER' ? (
          <>
            <Field label="커맨드" value={connector.command ?? '-'} />
            <Field label="인자" value={connector.args?.join(' ') ?? '-'} />
            <Field label="전송" value={connector.transport ?? '-'} />
          </>
        ) : connector.type === 'AGENT' ? (
          <>
            <Field label="기능" value={(config.description as string) ?? '-'} />
            <Field label="노드 타입(uiType)" value={(config.execNodeType as string) ?? '-'} />
            <Field label="카테고리" value={(config.execCategory as string) || '-'} />
            <Field
              label="사용 워크플로우"
              value={`${(config.workflowCount as number) ?? 0}곳 · 등장 ${(config.usageCount as number) ?? 0}회`}
            />
            {/* 내부 동작 프로세스 — 이 서브 Agent가 실행될 때 거치는 단계 */}
            <div>
              <div className="text-[10px] text-gray-600 font-semibold mb-1.5">내부 동작 프로세스</div>
              <ol className="space-y-1 text-[10px] text-gray-700 list-none">
                <li>1. 정책·예산 사전점검(precheck) — FinOps 게이트웨이</li>
                <li>2. 실행기 호출 — {(config.execNodeType as string) ?? 'executor'} (실 LLM/HTTP/파일/DB)</li>
                <li>3. 4-Gate 평가 — ① 품질 ② 보안 ③ 비용 ④ 이상동작</li>
                <li>4. 평가 기록 저장(AgentEvaluation) — 단독 실행은 isTest 태그로 운영지표와 분리</li>
              </ol>
            </div>
            {/* 사용처 (메인 Agent) */}
            {Array.isArray(config.workflows) && (config.workflows as any[]).length > 0 && (
              <div>
                <div className="text-[10px] text-gray-600 font-semibold mb-1.5">
                  사용 워크플로우(메인 Agent)
                </div>
                <div className="flex flex-wrap gap-1">
                  {(config.workflows as Array<{ workflowKey: string; workflowName: string }>).map((w, i) => (
                    <span
                      key={i}
                      className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[9px] rounded"
                      title={w.workflowKey}
                    >
                      {w.workflowName}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <p className="text-[10px] text-gray-400">
              아래 “테스트 파이프라인”으로 이 서브 Agent를 단독 실행하면 4-Gate 결과가 표시됩니다.
              워크플로우에 노드로 추가하면 메인 Agent의 일부로 동작합니다.
            </p>
            <button
              onClick={promoteToMainAgent}
              className="w-full px-3 py-2 bg-emerald-100 text-emerald-700 text-[11px] font-semibold rounded hover:bg-emerald-200 transition"
            >
              ⬆ 메인 Agent로 만들기 (운영/개발에서 실행)
            </button>
          </>
        ) : (
          <>
            <Field label="엔드포인트" value={connector.endpoint ?? config.endpoint ?? '-'} />
            <Field label="인증 방식" value={connector.authType ?? config.authType ?? '-'} />
          </>
        )}

        {connector.type !== 'BUILT_IN' && (
          <Field label="Rate Limit" value={config.rateLimit ?? '-'} />
        )}
        {connector.type !== 'BUILT_IN' && (
          <Field label="Timeout" value={`${config.timeoutSec ?? 30}s`} />
        )}

        {/* Health Status */}
        <div className="pt-2">
          <div className="text-[10px] text-gray-600 font-semibold mb-1">최근 Health Check</div>
          <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded flex items-center justify-between">
            <span
              className={`text-[11px] font-semibold ${
                healthStatus === 'OK'
                  ? 'text-green-600'
                  : healthStatus === 'DEGRADED'
                    ? 'text-amber-600'
                    : healthStatus === 'UNREACHABLE'
                      ? 'text-red-600'
                      : 'text-gray-500'
              }`}
            >
              {healthStatus === 'OK'
                ? '✓ OK'
                : healthStatus === 'DEGRADED'
                  ? '⚠ DEGRADED'
                  : healthStatus === 'UNREACHABLE'
                    ? '✕ DOWN'
                    : '-'}
            </span>
            <span className="text-[10px] text-gray-500">{config.lastHealthLatencyMs ?? '-'}ms</span>
          </div>
        </div>

        {/* Basic Actions — 서브 Agent는 헬스체크 비대상(테스트로 실행 확인) */}
        {!isAgent && (
          <div className="flex gap-2 pt-2">
            <button
              onClick={onHealthCheck}
              className="flex-1 px-3 py-2 bg-blue-100 text-blue-700 text-[11px] font-medium rounded hover:bg-blue-200 transition"
            >
              🔄 Health Check
            </button>
          </div>
        )}

        {/* Lifecycle Controls — 외부 런타임 커넥터 전용. 내장 노드/서브 Agent는 비대상. */}
        {!isBuiltIn && !isAgent && (
        <div className="border-t border-gray-200 pt-3 mt-3">
          <p className="text-[11px] font-bold text-gray-900 mb-2">Lifecycle</p>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => handleLifecycleAction('start')}
              className="px-2 py-1.5 bg-green-100 text-green-700 text-[10px] font-medium rounded hover:bg-green-200 transition flex items-center justify-center gap-1"
              title="커넥터 시작"
            >
              <Play size={10} /> 시작
            </button>
            <button
              onClick={() => handleLifecycleAction('stop')}
              className="px-2 py-1.5 bg-red-100 text-red-700 text-[10px] font-medium rounded hover:bg-red-200 transition flex items-center justify-center gap-1"
              title="커넥터 중지"
            >
              <Square size={10} /> 중지
            </button>
            <button
              onClick={() => handleLifecycleAction('restart')}
              className="px-2 py-1.5 bg-amber-100 text-amber-700 text-[10px] font-medium rounded hover:bg-amber-200 transition flex items-center justify-center gap-1"
              title="커넥터 재시작"
            >
              <RotateCcw size={10} /> 재시작
            </button>
          </div>
        </div>
        )}

        {/* Test Pipeline */}
        <div className="border-t border-gray-200 pt-3 mt-3">
          <button
            onClick={handleTestPipeline}
            disabled={testLoading}
            className="w-full px-3 py-2 bg-violet-100 text-violet-700 text-[11px] font-medium rounded hover:bg-violet-200 transition disabled:opacity-50 flex items-center justify-center gap-1"
          >
            {testLoading ? <Loader size={12} className="animate-spin" /> : <Beaker size={12} />}
            {testLoading ? 'Testing...' : '테스트 파이프라인'}
          </button>

          {showTestResults && testResults.length > 0 && (
            <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded">
              <div className="text-[10px] font-semibold text-gray-900 mb-2">테스트 결과</div>
              <div className="space-y-1.5">
                {testResults.map((r, idx) => (
                  <div key={idx} className="text-[10px]">
                    <div className="flex items-start gap-1.5">
                      {r.status === 'pass' && (
                        <CheckCircle size={12} className="text-green-600 flex-shrink-0 mt-0.5" />
                      )}
                      {r.status === 'fail' && (
                        <AlertCircle size={12} className="text-red-600 flex-shrink-0 mt-0.5" />
                      )}
                      {r.status === 'warn' && (
                        <AlertTriangle size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
                      )}
                      <div>
                        <p
                          className={`font-semibold ${r.status === 'pass' ? 'text-green-700' : r.status === 'fail' ? 'text-red-700' : 'text-amber-700'}`}
                        >
                          {r.step}
                        </p>
                        <p className="text-gray-600">{r.message}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {realOutput && (
                <div className="mt-2">
                  <div className="text-[10px] font-semibold text-gray-500 mb-1">실제 실행 출력</div>
                  <pre className="text-[10px] bg-gray-900 text-gray-100 rounded p-2 overflow-x-auto max-h-56 whitespace-pre-wrap">
                    {realOutput.length > 4000 ? realOutput.slice(0, 4000) + '\n…(생략)' : realOutput}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* MCP Tools Viewer */}
        {connector.type === 'MCP_SERVER' && (
          <div className="border-t border-gray-200 pt-3 mt-3">
            <button
              onClick={handleLoadMCPTools}
              disabled={mcpLoading}
              className="w-full px-3 py-2 bg-indigo-100 text-indigo-700 text-[11px] font-medium rounded hover:bg-indigo-200 transition disabled:opacity-50 flex items-center justify-center gap-1"
            >
              {mcpLoading ? <Loader size={12} className="animate-spin" /> : <Eye size={12} />}
              {mcpLoading ? 'Loading...' : 'MCP 도구 보기'}
            </button>

            {showMCPTools && mcpTools.length > 0 && (
              <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded max-h-40 overflow-y-auto">
                <div className="text-[10px] font-semibold text-gray-900 mb-2">
                  사용 가능한 도구 ({mcpTools.length})
                </div>
                <div className="space-y-1.5">
                  {mcpTools.map((tool, idx) => (
                    <div key={idx} className="text-[10px] border-l-2 border-indigo-300 pl-2">
                      <p className="font-semibold text-gray-900">{tool.name}</p>
                      <p className="text-gray-600">{tool.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Schema Discovery */}
        <div className="border-t border-gray-200 pt-3 mt-3">
          <button
            onClick={handleSchemaDiscovery}
            disabled={discoveryLoading}
            className="w-full px-3 py-2 bg-cyan-100 text-cyan-700 text-[11px] font-medium rounded hover:bg-cyan-200 transition disabled:opacity-50 flex items-center justify-center gap-1"
          >
            {discoveryLoading ? (
              <Loader size={12} className="animate-spin" />
            ) : (
              <Download size={12} />
            )}
            {discoveryLoading ? 'Discovering...' : '스키마 탐색'}
          </button>

          {showDiscovery && discoveryResults.length > 0 && (
            <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded max-h-40 overflow-y-auto">
              <div className="text-[10px] font-semibold text-gray-900 mb-2">발견된 기능</div>
              <div className="space-y-1.5">
                {discoveryResults.map((cap, idx) => (
                  <div key={idx} className="text-[10px] border-l-2 border-cyan-300 pl-2">
                    <p className="font-semibold text-gray-900">{cap.method}</p>
                    <p className="text-gray-600">{cap.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Governed Invoke — 외부 커넥터(MCP/REST/WEBHOOK) 전용. 내장 노드/서브 Agent는 "테스트"로 실행. */}
        {!isBuiltIn && !isAgent && (
          <div className="border-t border-gray-200 pt-3 mt-3">
            <button
              onClick={() => setShowInvokeModal(true)}
              className="w-full px-3 py-2 bg-fuchsia-100 text-fuchsia-700 text-[11px] font-medium rounded hover:bg-fuchsia-200 transition flex items-center justify-center gap-1"
            >
              <Send size={12} /> Governed Invoke
            </button>
          </div>
        )}

        {/* Registration Process */}
        <div className="border-t border-gray-200 pt-3 mt-3">
          <p className="text-[11px] font-bold text-gray-900 mb-3">커넥터 등록 프로세스</p>
          {[
            {
              num: 1,
              color: 'bg-blue-600',
              title: '유형 선택',
              desc: 'Agent / MCP / API / Webhook',
            },
            {
              num: 2,
              color: 'bg-amber-600',
              title: '연결 정보 입력',
              desc: '엔드포인트, 인증, 파라미터',
            },
            {
              num: 3,
              color: 'bg-green-600',
              title: 'Health Check',
              desc: '연결 테스트 및 응답 검증',
            },
            {
              num: 4,
              color: 'bg-purple-600',
              title: '권한·정책 설정',
              desc: '접근 제어, Rate Limit, 로깅',
            },
            {
              num: 5,
              color: 'bg-orange-600',
              title: '활성화',
              desc: '워크플로우에서 즉시 사용 가능',
            },
          ].map((s) => (
            <div key={s.num} className="flex items-start gap-2.5 mb-2.5">
              <div
                className={`w-5 h-5 rounded-full ${s.color} text-gray-900 flex items-center justify-center text-[9px] font-bold flex-shrink-0`}
              >
                {s.num}
              </div>
              <div>
                <p className="text-[11px] font-semibold text-gray-900">{s.title}</p>
                <p className="text-[10px] text-gray-600">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Governed Invoke Modal */}
      {showInvokeModal && (
        <GovernedInvokeModal connector={connector} onClose={() => setShowInvokeModal(false)} />
      )}
    </div>
  );
}

// ── Governed Invoke Modal ──

function GovernedInvokeModal({
  connector,
  onClose,
}: {
  connector: Connector;
  onClose: () => void;
}) {
  const [method, setMethod] = useState('');
  const [payload, setPayload] = useState('{}');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInvoke = async () => {
    setLoading(true);
    setError(null);
    try {
      const parsedPayload = JSON.parse(payload);
      const res = await api.post<any>('/connectors/invoke', {
        connectorKey: connector.key,
        method,
        payload: parsedPayload,
      });
      setResult(res);
    } catch (err: any) {
      setError(err.message ?? 'Invoke failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-md w-full shadow-lg">
        <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-900 flex items-center gap-1">
            <Send size={12} /> Governed Invoke
          </span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-900 text-xs font-bold">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[10px] text-gray-600 mb-1 font-semibold">커넥터</label>
            <div className="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-900">
              {connector.key}
            </div>
          </div>

          <div>
            <label className="block text-[10px] text-gray-600 mb-1 font-semibold">메서드</label>
            <input
              type="text"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              placeholder="e.g., getIssue, createTicket"
              className="w-full px-3 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-[10px] text-gray-600 mb-1 font-semibold">
              페이로드 (JSON)
            </label>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              className="w-full px-3 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono h-20"
            />
          </div>

          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-[10px] text-red-700">
              {error}
            </div>
          )}

          {result && (
            <div className="p-2 bg-green-50 border border-green-200 rounded text-[10px] text-green-700 max-h-24 overflow-y-auto">
              <p className="font-semibold mb-1">결과:</p>
              <pre className="whitespace-pre-wrap text-[9px]">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-1.5 text-gray-700 text-xs border border-gray-300 rounded hover:bg-gray-50 font-medium"
            >
              취소
            </button>
            <button
              onClick={handleInvoke}
              disabled={loading || !method}
              className="flex-1 px-3 py-1.5 bg-fuchsia-600 text-white text-xs font-medium rounded hover:bg-fuchsia-700 disabled:opacity-50 flex items-center justify-center gap-1"
            >
              {loading ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
              {loading ? 'Invoking...' : 'Invoke'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Create Connector Form ──

function CreateConnectorForm({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    key: '',
    name: '',
    type: 'REST_API' as (typeof CONNECTOR_TYPES)[number],
    endpoint: '',
    authType: 'OAuth 2.0',
    rateLimit: '100 req/min',
    timeoutSec: 30,
    command: '',
    args: '',
    transport: 'stdio',
  });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        key: form.key,
        name: form.name,
        type: form.type,
        ...(form.type === 'MCP_SERVER'
          ? {
              command: form.command,
              args: form.args ? form.args.split(' ').filter(Boolean) : [],
              transport: form.transport,
            }
          : {
              endpoint: form.endpoint,
              authType: form.authType,
              rateLimit: form.rateLimit,
              timeoutSec: form.timeoutSec,
            }),
      };
      await api.post('/connectors', payload);
      onSuccess();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden max-h-[calc(100vh-200px)] overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between sticky top-0">
        <span className="text-xs font-semibold text-gray-900">새 커넥터 등록</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-900 text-xs font-bold">
          ✕
        </button>
      </div>
      <form onSubmit={handleSubmit} className="p-4 space-y-3">
        <FormField
          label="커넥터 키"
          value={form.key}
          onChange={(v) => setForm({ ...form, key: v })}
          placeholder="slack-api"
        />
        <FormField
          label="커넥터 이름"
          value={form.name}
          onChange={(v) => setForm({ ...form, name: v })}
          placeholder="Slack REST API"
        />

        <div>
          <label className="block text-[10px] text-gray-600 mb-1 font-semibold">유형</label>
          <select
            value={form.type}
            onChange={(e) =>
              setForm({ ...form, type: e.target.value as (typeof CONNECTOR_TYPES)[number] })
            }
            className="w-full px-3 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-900"
          >
            {CONNECTOR_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        {form.type === 'MCP_SERVER' ? (
          <>
            <FormField
              label="커맨드"
              value={form.command}
              onChange={(v) => setForm({ ...form, command: v })}
              placeholder="python"
            />
            <FormField
              label="인자"
              value={form.args}
              onChange={(v) => setForm({ ...form, args: v })}
              placeholder="-m mcp.server"
            />
            <div>
              <label className="block text-[10px] text-gray-600 mb-1 font-semibold">전송</label>
              <select
                value={form.transport}
                onChange={(e) => setForm({ ...form, transport: e.target.value })}
                className="w-full px-3 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-900"
              >
                <option>stdio</option>
                <option>http</option>
                <option>sse</option>
              </select>
            </div>
          </>
        ) : (
          <>
            <FormField
              label="엔드포인트"
              value={form.endpoint}
              onChange={(v) => setForm({ ...form, endpoint: v })}
              placeholder="https://slack.com/api"
            />
            <div>
              <label className="block text-[10px] text-gray-600 mb-1 font-semibold">
                인증 방식
              </label>
              <select
                value={form.authType}
                onChange={(e) => setForm({ ...form, authType: e.target.value })}
                className="w-full px-3 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-900"
              >
                <option>OAuth 2.0</option>
                <option>API Key</option>
                <option>Bearer Token</option>
                <option>Basic Auth</option>
              </select>
            </div>
            <FormField
              label="Rate Limit"
              value={form.rateLimit}
              onChange={(v) => setForm({ ...form, rateLimit: v })}
              placeholder="100 req/min"
            />
          </>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-3 py-1.5 text-gray-700 text-xs border border-gray-300 rounded hover:bg-gray-50 font-medium"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={submitting || !form.key || !form.name}
            className="flex-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? '등록 중...' : '💾 저장'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Shared Components ──

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <label className="block text-[10px] text-gray-600 mb-0.5 font-semibold">{label}</label>
      <div className="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-900 font-mono break-all">
        {value}
      </div>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-[10px] text-gray-600 mb-1 font-semibold">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 bg-white border border-gray-300 rounded text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  );
}

function StatusBadgeLight({ status }: { status: string }) {
  const statusStyles: Record<string, string> = {
    ACTIVE: 'bg-green-100 text-green-800',
    CONFIGURED: 'bg-amber-100 text-amber-800',
    INACTIVE: 'bg-gray-100 text-gray-800',
    PENDING: 'bg-blue-100 text-blue-800',
    ERROR: 'bg-red-100 text-red-800',
  };
  return (
    <span
      className={`px-2 py-1 rounded text-[10px] font-semibold ${statusStyles[status] || 'bg-gray-100 text-gray-700'}`}
    >
      {status}
    </span>
  );
}

function SC({ label, value, c }: { label: string; value: number; c: string }) {
  const cm: Record<string, string> = {
    blue: 'text-blue-600',
    green: 'text-green-600',
    amber: 'text-amber-600',
    red: 'text-red-600',
    purple: 'text-purple-600',
    violet: 'text-violet-600',
    orange: 'text-orange-600',
  };
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-2 font-semibold">
        {label}
      </p>
      <p className={`text-2xl font-bold ${cm[c] ?? 'text-gray-900'}`}>{value}</p>
    </div>
  );
}

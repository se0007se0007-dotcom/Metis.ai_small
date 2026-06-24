'use client';

/**
 * NodeTestPanel — 노드(sub-agent) 개별 실행 테스트 패널.
 *
 * 빌더 우하단 플로팅 버튼으로 열리는 자체완결형 모달. 11개 노드 실행기를 각각
 * 골라 settings + 이전노드 출력(샘플)을 넣고 백엔드 /execute-node 로 "실제" 실행한다.
 * (빌더의 클라이언트 시뮬레이션이 아니라 실 실행기를 호출 → 실제 LLM/HTTP/파일/DB 작동.)
 */
import { useState } from 'react';
import { api } from '@/lib/api-client';

interface NodeDef {
  key: string;
  label: string;
  nodeType: string;
  category: string;
  defaultSettings: Record<string, unknown>;
  samplePrev: string;
  note?: string;
}

const SAMPLE_CODE = [
  'def transfer(accounts, src, dst, amount):',
  '    # 입력 검증 없음 — 취약',
  "    query = \"SELECT * FROM users WHERE id = '\" + src + \"'\"",
  '    accounts[src] -= amount',
  '    accounts[dst] += amount',
  '    return accounts',
].join('\n');

const NODE_CATALOG: NodeDef[] = [
  {
    key: 'ai-analysis',
    label: 'AI 보안점검 (SAST/Secrets)',
    nodeType: 'ai-processing',
    category: 'inspection',
    defaultSettings: { scanners: ['sast', 'secrets'], model: 'claude-haiku-4-5-20251001', minSeverity: 'low' },
    samplePrev: SAMPLE_CODE,
    note: '실 LLM 호출(게이트웨이 경유). 이전 노드 출력 = 분석 대상 소스.',
  },
  {
    key: 'pentest',
    label: '모의해킹 (Pentest)',
    nodeType: 'ai-processing',
    category: 'pentest',
    defaultSettings: { model: 'claude-haiku-4-5-20251001' },
    samplePrev: SAMPLE_CODE,
    note: '소스 100자 이상 필요. 실 LLM 호출.',
  },
  {
    key: 'summarize',
    label: 'AI 요약 정리',
    nodeType: 'ai-processing',
    category: 'summarize',
    defaultSettings: { summaryStyle: 'bullet', maxLength: 'short' },
    samplePrev: 'SAST 결과: SQL Injection 1건(HIGH), 하드코딩된 비밀번호 1건(CRITICAL) 발견됨. 즉시 조치 필요.',
    note: '실 LLM 호출.',
  },
  {
    key: 'document-gen',
    label: '문서 생성 (HTML/DOCX/PDF)',
    nodeType: 'file-operation',
    category: 'output',
    defaultSettings: { format: 'html', title: 'Metis 노드 테스트 리포트' },
    samplePrev: '# 점검 요약\n- 항목 A: 정상\n- 항목 B: 경고\n\n상세 내용은 본문 참조.',
    note: '실제 파일 생성(다운로드 가능).',
  },
  {
    key: 'web-search',
    label: '웹 검색 (무키 실검색)',
    nodeType: 'web-search',
    category: 'search',
    defaultSettings: { keywords: 'OWASP Top 10', searchEngine: 'duckduckgo', maxResults: 5, language: 'ko' },
    samplePrev: '',
    note: '키 없이 DuckDuckGo·Wikipedia 실검색. 결과 없으면 데모 명시.',
  },
  {
    key: 'log-monitor',
    label: '로그 모니터링',
    nodeType: 'log-monitor',
    category: 'monitor',
    defaultSettings: { logSource: 'server', logLevels: ['ERROR', 'WARN'], alertPattern: 'timeout|refused' },
    samplePrev: '',
    note: '실 수집(journalctl 등) 실패 시 데모 샘플임을 명시.',
  },
  {
    key: 'data-storage',
    label: '데이터 저장 (PostgreSQL)',
    nodeType: 'data-storage',
    category: 'storage',
    defaultSettings: { storageType: 'postgresql', operation: 'INSERT' },
    samplePrev: '노드 테스트로 저장되는 샘플 지식 아티팩트 본문입니다.',
    note: '실제 Postgres(knowledgeArtifact) 기록.',
  },
  {
    key: 'slack',
    label: 'Slack 전송',
    nodeType: 'slack-message',
    category: 'delivery',
    defaultSettings: { slackConnectType: 'webhook', messageTemplate: '🔔 노드 테스트\n\n{{summary}}' },
    samplePrev: '워크플로 결과 요약 텍스트',
    note: 'Webhook/Token 없으면 graceful skip. 환경변수 SLACK_WEBHOOK_URL 설정 시 실제 전송.',
  },
  {
    key: 'email-send',
    label: '이메일 전송',
    nodeType: 'email-send',
    category: 'delivery',
    defaultSettings: { subject: 'Metis 노드 테스트', to: '' },
    samplePrev: '이메일 본문이 될 결과 텍스트',
    note: '수신자/SMTP 없으면 skip. 설정 시 실제 발송.',
  },
  {
    key: 'schedule',
    label: '스케줄/트리거',
    nodeType: 'schedule',
    category: 'schedule',
    defaultSettings: { cron: '0 9 * * 1', timezone: 'Asia/Seoul', scheduleLabel: '매주 월 09:00' },
    samplePrev: '',
    note: '트리거 메타(다음 실행시각) 반환.',
  },
  {
    key: 'file-upload',
    label: '소스 로딩 (API/Git/Local)',
    nodeType: 'file-operation',
    category: 'input',
    defaultSettings: { sourceType: 'api', apiUrl: 'https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore' },
    samplePrev: '',
    note: 'API URL/Git/로컬 경로에서 실제 로딩. 기본은 공개 URL 예시.',
  },
];

interface RunResult {
  resolved: boolean;
  executorKey?: string;
  displayName?: string;
  output?: {
    success: boolean;
    outputText?: string;
    data?: Record<string, unknown>;
    durationMs?: number;
    error?: string;
    generatedFiles?: Array<{ name: string; downloadUrl?: string }>;
  };
  evaluation?: { overallScore: number; qualityGrade: string } | null;
  error?: string;
}

export default function NodeTestPanel() {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const [settingsText, setSettingsText] = useState(JSON.stringify(NODE_CATALOG[0].defaultSettings, null, 2));
  const [prevText, setPrevText] = useState(NODE_CATALOG[0].samplePrev);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const def = NODE_CATALOG[idx];

  const selectNode = (i: number) => {
    setIdx(i);
    setSettingsText(JSON.stringify(NODE_CATALOG[i].defaultSettings, null, 2));
    setPrevText(NODE_CATALOG[i].samplePrev);
    setResult(null);
    setErr(null);
  };

  const run = async () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    let settings: Record<string, unknown>;
    try {
      settings = settingsText.trim() ? JSON.parse(settingsText) : {};
    } catch {
      setErr('settings JSON 형식이 올바르지 않습니다.');
      setRunning(false);
      return;
    }
    try {
      const res = await api.post<RunResult>('/api/workflow-nodes/execute-node', {
        nodeType: def.nodeType,
        category: def.category,
        nodeName: def.label,
        settings,
        previousOutput: prevText,
      });
      setResult(res);
    } catch (e) {
      setErr((e as Error)?.message ?? '실행 실패 — API 서버 상태를 확인하세요.');
    } finally {
      setRunning(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 px-4 py-2.5 rounded-full bg-blue-600 text-white text-sm font-semibold shadow-lg hover:bg-blue-700"
        title="노드(sub-agent)를 개별로 실제 실행해 봅니다"
      >
        🧪 노드 테스트
      </button>
    );
  }

  const out = result?.output;
  const ok = out?.success;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[88vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div>
            <h2 className="text-base font-bold text-gray-900">🧪 노드 개별 실행 테스트</h2>
            <p className="text-[11px] text-gray-500">각 sub-agent를 실제 실행기로 단독 실행합니다 (클라이언트 시뮬레이션 아님).</p>
          </div>
          <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-[200px_1fr] gap-0">
          {/* 노드 목록 */}
          <div className="border-r border-gray-100 p-2 space-y-1 bg-gray-50">
            {NODE_CATALOG.map((n, i) => (
              <button
                key={n.key}
                onClick={() => selectNode(i)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition ${
                  i === idx ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                {n.label}
              </button>
            ))}
          </div>

          {/* 입력 + 결과 */}
          <div className="p-4 space-y-3">
            <div className="text-[11px] text-gray-500">
              <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">{def.nodeType}:{def.category}</span>
              {def.note && <span className="ml-2">{def.note}</span>}
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">settings (JSON)</label>
              <textarea
                value={settingsText}
                onChange={(e) => setSettingsText(e.target.value)}
                rows={6}
                className="w-full text-xs font-mono border border-gray-300 rounded-lg p-2 focus:ring-2 focus:ring-blue-200 outline-none"
                spellCheck={false}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">이전 노드 출력 (샘플 입력)</label>
              <textarea
                value={prevText}
                onChange={(e) => setPrevText(e.target.value)}
                rows={4}
                className="w-full text-xs font-mono border border-gray-300 rounded-lg p-2 focus:ring-2 focus:ring-blue-200 outline-none"
                spellCheck={false}
                placeholder="(이 노드가 이전 노드 산출물을 입력으로 받는 경우 여기에 샘플을 넣으세요)"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={run}
                disabled={running}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {running ? '실행 중…' : '▶ 실제 실행'}
              </button>
              {running && <span className="text-xs text-gray-400">실행기를 호출하는 중… (LLM 노드는 수십 초 걸릴 수 있음)</span>}
            </div>

            {err && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{err}</div>}

            {result && (
              <div className="border border-gray-200 rounded-lg p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {result.resolved ? (
                    <span className={`px-2 py-0.5 rounded-full font-bold ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                      {ok ? '성공' : '실패'}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full font-bold bg-rose-50 text-rose-700">실행기 없음</span>
                  )}
                  {result.executorKey && <span className="text-gray-500">executor: <b>{result.executorKey}</b></span>}
                  {typeof out?.durationMs === 'number' && <span className="text-gray-400">{out.durationMs}ms</span>}
                  {out?.data?.demo === true && <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700">데모 데이터</span>}
                  {out?.data?.skipped === true && <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">건너뜀</span>}
                  {result.evaluation && (
                    <span className="text-gray-500">품질: <b>{result.evaluation.overallScore}</b> ({result.evaluation.qualityGrade})</span>
                  )}
                </div>

                {(result.error || out?.error) && (
                  <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 whitespace-pre-wrap">
                    {result.error || out?.error}
                  </div>
                )}

                {out?.generatedFiles && out.generatedFiles.length > 0 && (
                  <div className="text-xs text-gray-600">
                    생성 파일: {out.generatedFiles.map((f) => f.name).join(', ')}
                  </div>
                )}

                {out?.outputText && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-500 mb-1">출력</div>
                    <pre className="text-[11px] bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto max-h-72 whitespace-pre-wrap">{out.outputText}</pre>
                  </div>
                )}

                {out?.data && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-gray-500">data (raw)</summary>
                    <pre className="bg-gray-50 border border-gray-200 rounded p-2 mt-1 overflow-x-auto max-h-52">{JSON.stringify(out.data, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

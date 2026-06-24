'use client';

/**
 * 연동 설정(Ingest) 모달 — 외부 실제 Agent를 Metis에 붙이기 위한 화면.
 *  1) Ingest API Key 발급 (POST /ingest/keys) — 평문 키 1회 표시
 *  2) 발급된 키 목록 (GET /ingest/keys)
 *  3) 발급 키가 박힌 Python SDK 연결 스니펫 (복사)
 *  4) 빠른 테스트 (POST /ingest/test-run) — input/output 1건 즉시 평가
 *
 * 관리자(ADMIN)에게만 노출. TopNav에서 렌더.
 */
import { useState, useEffect, useCallback } from 'react';
import { X, KeyRound, Copy, Check, Plug, FlaskConical, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api-client';

interface IngestKey {
  id: string;
  name: string;
  prefix: string;
  env: string;
  createdAt: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

const API_BASE_FOR_SDK = (
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/v1'
).replace(/\/v1\/?$/, '');

export function IngestConnectModal({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('내 실제 Agent');
  const [issuing, setIssuing] = useState(false);
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<'key' | 'snippet' | null>(null);

  // 빠른 테스트
  const [testInput, setTestInput] = useState('환불 정책 알려줘');
  const [testOutput, setTestOutput] = useState('30일 이내 영수증 지참 시 전액 환불됩니다.');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ items: IngestKey[] }>('/ingest/keys');
      setKeys(res?.items ?? []);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '키 목록을 불러오지 못했습니다 (관리자 권한 필요)');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  // Esc 키로 닫기 (배경 클릭으로는 닫히지 않음 — 1회성 키 보호)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const revokeKey = async (id: string, name: string) => {
    if (!confirm(`"${name}" 키를 폐기할까요?\n이 키를 쓰는 Agent는 더 이상 데이터를 보낼 수 없게 됩니다.`)) return;
    setRevokingId(id);
    setError(null);
    try {
      await api.delete(`/ingest/keys/${id}`);
      await loadKeys();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '키 폐기 실패');
    } finally {
      setRevokingId(null);
    }
  };

  const issueKey = async () => {
    setIssuing(true);
    setError(null);
    setIssuedKey(null);
    try {
      const res = await api.post<{ key: string }>('/ingest/keys', { name, env: 'live' });
      setIssuedKey(res?.key ?? null);
      await loadKeys();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '키 발급 실패 (관리자 권한 필요)');
    } finally {
      setIssuing(false);
    }
  };

  const snippet = `from metis import Metis

m = Metis(
    api_key="${issuedKey ?? 'mts_live_…'}",
    base_url="${API_BASE_FOR_SDK}",
)

# 실제 Agent 함수에 그냥 씌우면 호출마다 자동 평가/거버넌스
@m.eval(agent="my-agent", task_type="qa", question_arg="q")
def my_agent(q):
    return call_my_real_llm(q)

my_agent("환불 정책 알려줘")`;

  const copy = async (text: string, which: 'key' | 'snippet') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard 미지원 무시 */
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 빠른 테스트는 실제 토큰값이 없으므로 글자 수로 근사(영문≈4자/토큰, 한글 고려해 보수적으로 2.5자/토큰)
      const estTokens = (s: string) => Math.max(1, Math.ceil((s?.length ?? 0) / 2.5));
      const res = await api.post<Record<string, unknown>>('/ingest/test-run', {
        agentName: 'quick-test',
        input: testInput,
        output: testOutput,
        model: 'gpt-4o',
        tokensIn: estTokens(testInput),
        tokensOut: estTokens(testOutput),
      });
      setTestResult(res ?? null);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '테스트 실패');
    } finally {
      setTesting(false);
    }
  };

  const eval0 =
    (testResult?.evaluation as Record<string, unknown> | undefined) ??
    (Array.isArray(testResult?.results)
      ? ((testResult!.results as Array<Record<string, unknown>>)[0]?.evaluation as
          | Record<string, unknown>
          | undefined)
      : undefined);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4">
      <div className="bg-white text-gray-900 rounded-xl w-full max-w-2xl max-h-[88vh] overflow-y-auto">
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <div className="flex items-center gap-2">
            <Plug size={18} className="text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">실제 Agent 연동 설정</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {error && (
            <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700">
              {error}
            </div>
          )}

          {/* 1. 키 발급 */}
          <section>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5 mb-2">
              <KeyRound size={15} className="text-blue-600" /> 1. Ingest API Key 발급
            </h3>
            <div className="flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="키 이름 (예: 결제봇-prod)"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
              />
              <button
                onClick={issueKey}
                disabled={issuing}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
              >
                {issuing ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
                발급
              </button>
            </div>
            {issuedKey && (
              <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-[11px] text-amber-800 font-semibold mb-1">
                  ⚠ 이 키는 지금만 표시됩니다. 안전한 곳에 보관하세요.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs font-mono break-all text-gray-900">{issuedKey}</code>
                  <button
                    onClick={() => copy(issuedKey, 'key')}
                    className="p-1.5 border border-gray-300 rounded hover:bg-white"
                    title="복사"
                  >
                    {copied === 'key' ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* 2. 발급된 키 목록 + 관리 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-gray-900">2. 발급된 키 관리</h3>
              <span className="text-[11px] text-gray-400">
                활성 {keys.filter((k) => !k.revokedAt).length} / 전체 {keys.length}
              </span>
            </div>
            {loading ? (
              <p className="text-xs text-gray-400">불러오는 중…</p>
            ) : keys.length === 0 ? (
              <p className="text-xs text-gray-400">발급된 키가 없습니다.</p>
            ) : (
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between px-3 py-2 text-xs gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`font-semibold ${k.revokedAt ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                          {k.name}
                        </span>
                        <span className="font-mono text-gray-500">{k.prefix}…</span>
                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{k.env}</span>
                        {k.revokedAt && <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-600">폐기됨</span>}
                      </div>
                      <div className="text-[10px] text-gray-400 mt-0.5">
                        발급 {new Date(k.createdAt).toLocaleDateString('ko-KR')} · 마지막 사용{' '}
                        {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('ko-KR') : '없음'}
                      </div>
                    </div>
                    {!k.revokedAt && (
                      <button
                        onClick={() => revokeKey(k.id, k.name)}
                        disabled={revokingId === k.id}
                        className="flex items-center gap-1 px-2 py-1 border border-rose-200 text-rose-600 rounded hover:bg-rose-50 disabled:opacity-50 shrink-0"
                        title="이 키 폐기(회수)"
                      >
                        {revokingId === k.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        폐기
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 3. 연결 스니펫 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-gray-900">3. 실제 Agent 연결 (Python SDK)</h3>
              <button
                onClick={() => copy(snippet, 'snippet')}
                className="flex items-center gap-1 px-2 py-1 border border-gray-300 rounded text-[11px] hover:bg-gray-50"
              >
                {copied === 'snippet' ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                복사
              </button>
            </div>
            <pre className="p-3 bg-gray-900 text-gray-100 rounded-lg text-[11px] leading-relaxed overflow-x-auto">
              {snippet}
            </pre>
            <p className="mt-1 text-[11px] text-gray-500">
              SDK 위치: <code>sdks/python/metis</code> (pip 불필요 · stdlib만). 전송 즉시 동일한 5-게이트
              평가·거버넌스를 탑니다.
            </p>
          </section>

          {/* 4. 빠른 테스트 */}
          <section>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5 mb-2">
              <FlaskConical size={15} className="text-violet-600" /> 4. 빠른 테스트 (즉시 평가)
            </h3>
            <div className="space-y-2">
              <input
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="input (질문)"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
              />
              <textarea
                value={testOutput}
                onChange={(e) => setTestOutput(e.target.value)}
                placeholder="output (Agent 응답)"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
              />
              <button
                onClick={runTest}
                disabled={testing}
                className="flex items-center gap-1.5 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-semibold hover:bg-violet-700 disabled:opacity-50"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
                평가 실행
              </button>
            </div>
            {eval0 && (
              <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-lg text-xs grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <div className="text-gray-400">품질점수</div>
                  <div className="font-bold text-gray-900">{String(eval0.overallScore ?? '—')}</div>
                </div>
                <div>
                  <div className="text-gray-400">보안위험</div>
                  <div className="font-bold text-gray-900">{String(eval0.securityRiskLevel ?? '—')}</div>
                </div>
                <div>
                  <div className="text-gray-400">이상행동</div>
                  <div className="font-bold text-gray-900">
                    {eval0.anomalyDetected === true ? '감지' : eval0.anomalyDetected === false ? '정상' : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-gray-400">예상 비용</div>
                  <div className="font-bold text-gray-900">
                    {typeof eval0.costUsd === 'number' ? `$${eval0.costUsd.toFixed(5)}` : '—'}
                  </div>
                  <div className="text-[10px] text-gray-400">
                    {typeof eval0.tokensUsed === 'number' ? `${eval0.tokensUsed.toLocaleString()} 토큰(추정)` : ''}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

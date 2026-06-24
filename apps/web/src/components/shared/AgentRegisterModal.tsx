'use client';

/**
 * Agent 빠른 등록 모달 — "Agent 실행" 카탈로그에 Agent를 쉽게 올린다.
 *
 * 두 가지 등록 방식(탭):
 *   1) 폼 등록      — 클릭 몇 번 (비개발자용)
 *   2) YAML/매니페스트 — 표준 예시 템플릿을 붙여넣거나 파일 업로드 (개발/대량/CI용)
 *
 * 실행 방식 3종(공통):
 *   - llm      : 시스템 프롬프트 + 모델 → ai-processing 노드 (Metis가 직접 실행)
 *   - external : URL + 인증 → api-call 노드 (Metis가 외부 호출)
 *   - sdk      : 외부 로컬 실행, Metis는 트레이스만 → passthrough 노드
 *
 * 흐름: POST /workflows (최소 노드 + 카테고리 태그) → POST /orb/governance-reviews (임시등록)
 *       → 거버넌스 심사·승격(ORB) 통과 시 카탈로그(실행 목록)에 노출.
 */
import { useState, useEffect } from 'react';
import { X, Bot, Globe, Plug, Loader2, CheckCircle2, ArrowRight, FileCode2, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import { useModelOptions, ModelOptionList } from '@/lib/useModelOptions';

type Mode = 'llm' | 'external' | 'sdk';
type Tab = 'form' | 'yaml';

interface AgentValues {
  name: string;
  description: string;
  category: string;
  mode: Mode;
  model: string;
  prompt: string;
  endpoint: string;
  authHeader: string;
}

const MODES: { id: Mode; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: 'llm', label: 'LLM 프롬프트형', icon: <Bot size={16} />, desc: 'Metis가 프롬프트+모델로 직접 실행' },
  { id: 'external', label: '외부 엔드포인트형', icon: <Globe size={16} />, desc: 'Metis가 외부 URL을 호출해 실행' },
  { id: 'sdk', label: 'SDK 트레이스형', icon: <Plug size={16} />, desc: '외부에서 실행, Metis는 기록만(거버넌스)' },
];

const YAML_TEMPLATE = `# ───────────────────────────────────────────────
# Metis Agent 매니페스트 (표준 예시)
#  - 값에 '#'(인라인 주석)는 쓰지 마세요.
#  - mode: llm | external | sdk
#  - category: operations | development
# ───────────────────────────────────────────────
name: 장애 로그 요약 Agent
description: 장애 로그를 핵심 3줄로 요약합니다
category: operations
mode: llm

# [mode: llm] 일 때
model: gpt-5
prompt: 너는 장애 로그를 핵심만 3줄로 요약한다.

# [mode: external] 일 때 (위 model/prompt 대신 사용)
# endpoint: https://사내/agent/run
# authHeader: Authorization: Bearer YOUR_TOKEN

# [mode: sdk] 일 때 — 등록 후 '연동 설정'에서 Ingest 키 발급
`;

const slugify = (s: string) =>
  (s || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent';

/** 표준 템플릿용 경량 YAML 파서 (평면 key: value, '#' 주석/빈줄 무시). 의존성 없음. */
function parseAgentYaml(text: string): Partial<AgentValues> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1);
    val = val.replace(/\s+#.*$/, '').trim(); // 인라인 주석 제거
    val = val.replace(/^["']|["']$/g, ''); // 따옴표 제거
    if (key) out[key] = val;
  }
  return out as Partial<AgentValues>;
}

export function AgentRegisterModal({
  defaultCategory = 'operations',
  onClose,
  onDone,
}: {
  defaultCategory?: string;
  onClose: () => void;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('form');

  // 폼 상태
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(defaultCategory);
  const [mode, setMode] = useState<Mode>('llm');
  const [model, setModel] = useState('gpt-5');
  // 모델 드롭다운은 기준정보(모델 단가)에서 — 하드코딩 제거.
  const { models: modelOptions } = useModelOptions();
  useEffect(() => {
    // 기본값이 기준정보에 없으면 첫 등록 모델로 보정.
    if (modelOptions.length > 0 && !modelOptions.some((m) => m.modelId === model)) {
      setModel(modelOptions[0].modelId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelOptions]);
  const [prompt, setPrompt] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [authHeader, setAuthHeader] = useState('');

  // YAML 상태
  const [yamlText, setYamlText] = useState(YAML_TEMPLATE);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const buildNode = (v: AgentValues) => {
    const base = { nodeKey: 'agent', executionOrder: 1, positionX: 240, positionY: 120 };
    if (v.mode === 'llm') {
      return {
        ...base,
        uiType: 'ai-processing',
        name: v.name || 'AI Agent',
        config: { mode: 'general', model: v.model || 'gpt-5', prompt: v.prompt || '입력을 처리해 답합니다.' },
      };
    }
    if (v.mode === 'external') {
      return {
        ...base,
        uiType: 'api-call',
        name: v.name || 'External Agent',
        config: { url: v.endpoint, method: 'POST', authHeader: v.authHeader || '' },
      };
    }
    return {
      ...base,
      uiType: 'passthrough',
      name: v.name || 'External SDK Agent',
      config: { external: true, runtime: 'sdk' },
    };
  };

  /** 두 탭이 공유하는 실제 등록 로직. */
  const registerAgent = async (v: AgentValues) => {
    if (!v.name.trim()) throw new Error('Agent 이름(name)이 필요합니다.');
    if (!['llm', 'external', 'sdk'].includes(v.mode)) throw new Error(`mode 값이 올바르지 않습니다: ${v.mode}`);
    if (v.mode === 'external' && !v.endpoint.trim()) throw new Error('외부 엔드포인트(endpoint)가 필요합니다.');
    const cat = v.category === 'development' ? 'development' : 'operations';
    const key = `${slugify(v.name)}-${Math.random().toString(36).slice(2, 6)}`;
    const created = await api.post<{ id: string }>('/workflows', {
      key,
      name: v.name.trim(),
      description: v.description.trim() || `${MODES.find((m) => m.id === v.mode)?.label} Agent`,
      tags: [cat, 'quick-register', `mode:${v.mode}`],
      nodes: [buildNode({ ...v, category: cat })],
      edges: [],
    });
    try {
      await api.post('/orb/governance-reviews', { workflowId: created.id });
    } catch {
      /* 워크플로우는 생성됨 — ORB 등록만 실패 시 심사 화면에서 수동 등록 가능 */
    }
    return v.name.trim();
  };

  const submitForm = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const nm = await registerAgent({ name, description, category, mode, model, prompt, endpoint, authHeader });
      setDone({ name: nm });
      onDone?.();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '등록 실패 — 입력값을 확인하세요.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitYaml = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const p = parseAgentYaml(yamlText);
      const nm = await registerAgent({
        name: p.name ?? '',
        description: p.description ?? '',
        category: p.category ?? 'operations',
        mode: (p.mode as Mode) ?? 'llm',
        model: p.model ?? 'gpt-5',
        prompt: p.prompt ?? '',
        endpoint: p.endpoint ?? '',
        authHeader: p.authHeader ?? '',
      });
      setDone({ name: nm });
      onDone?.();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? 'YAML 파싱/등록 실패 — 형식을 확인하세요.');
    } finally {
      setSubmitting(false);
    }
  };

  const onUpload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setYamlText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-[70] p-4 py-[6vh] overflow-y-auto">
      <div className="bg-white text-gray-900 rounded-xl w-full max-w-lg max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white">
          <div className="flex items-center gap-2">
            <Bot size={18} className="text-blue-600" />
            <h2 className="text-base font-bold text-gray-900">Agent 빠른 등록</h2>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <div className="p-6 text-center space-y-4">
            <CheckCircle2 size={40} className="text-emerald-500 mx-auto" />
            <div>
              <p className="text-base font-bold text-gray-900">"{done.name}" 등록 완료 — ORB 심사 대기</p>
              <p className="text-sm text-gray-500 mt-1">심사·승격이 끝나면 "Agent 실행" 목록에 노출됩니다.</p>
            </div>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => {
                  onClose();
                  router.push('/governance/orb-governance');
                }}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700"
              >
                심사·승격 화면으로 <ArrowRight size={14} />
              </button>
              <button
                onClick={() => {
                  setDone(null);
                  setName('');
                  setDescription('');
                  setPrompt('');
                  setEndpoint('');
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold hover:bg-gray-50"
              >
                계속 등록
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {/* 탭 */}
            <div className="flex gap-1 border-b border-gray-200">
              <button
                onClick={() => setTab('form')}
                className={
                  tab === 'form'
                    ? 'px-3.5 py-2 text-sm font-semibold text-blue-700 border-b-2 border-blue-600 -mb-px'
                    : 'px-3.5 py-2 text-sm text-gray-500 hover:text-gray-800 -mb-px'
                }
              >
                폼 등록
              </button>
              <button
                onClick={() => setTab('yaml')}
                className={
                  tab === 'yaml'
                    ? 'flex items-center gap-1 px-3.5 py-2 text-sm font-semibold text-blue-700 border-b-2 border-blue-600 -mb-px'
                    : 'flex items-center gap-1 px-3.5 py-2 text-sm text-gray-500 hover:text-gray-800 -mb-px'
                }
              >
                <FileCode2 size={14} /> YAML/매니페스트
              </button>
            </div>

            {error && (
              <div className="px-3 py-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700">
                {error}
              </div>
            )}

            {tab === 'form' ? (
              <>
                {/* 실행 방식 */}
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">실행 방식</label>
                  <div className="grid grid-cols-3 gap-2">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setMode(m.id)}
                        className={`flex flex-col items-start gap-1 p-2.5 rounded-lg border text-left transition ${
                          mode === m.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <span className={mode === m.id ? 'text-blue-600' : 'text-gray-500'}>{m.icon}</span>
                        <span className="text-[11px] font-semibold text-gray-900 leading-tight">{m.label}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1">{MODES.find((m) => m.id === mode)?.desc}</p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">Agent 이름</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="예: 장애 로그 요약 Agent"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">설명</label>
                  <input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="이 Agent가 하는 일"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">카테고리</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900"
                  >
                    <option value="operations">운영</option>
                    <option value="development">개발</option>
                  </select>
                </div>

                {mode === 'llm' && (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">모델</label>
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900"
                      >
                        <ModelOptionList models={modelOptions} current={model} />
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">시스템 프롬프트</label>
                      <textarea
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                        placeholder="예: 너는 장애 로그를 핵심만 3줄로 요약한다."
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
                      />
                    </div>
                  </>
                )}
                {mode === 'external' && (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">엔드포인트 URL</label>
                      <input
                        value={endpoint}
                        onChange={(e) => setEndpoint(e.target.value)}
                        placeholder="https://사내/agent/run"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">인증 헤더 (선택)</label>
                      <input
                        value={authHeader}
                        onChange={(e) => setAuthHeader(e.target.value)}
                        placeholder="Authorization: Bearer …"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900 placeholder-gray-400"
                      />
                    </div>
                  </>
                )}
                {mode === 'sdk' && (
                  <div className="px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800">
                    SDK형은 외부(로컬)에서 실행되고 Metis는 트레이스만 받습니다. 등록 후 우측 상단{' '}
                    <b>연동 설정</b>에서 이 Agent용 <b>Ingest API Key</b>를 발급해 SDK에 연결하세요.
                  </div>
                )}

                <button
                  onClick={submitForm}
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}
                  등록하고 ORB 심사 보내기
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold text-gray-700">매니페스트 (YAML)</label>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 px-2 py-1 border border-gray-300 rounded text-[11px] cursor-pointer hover:bg-gray-50">
                      <Upload size={12} /> 파일 업로드
                      <input
                        type="file"
                        accept=".yaml,.yml,.txt"
                        className="hidden"
                        onChange={(e) => onUpload(e.target.files?.[0])}
                      />
                    </label>
                    <button
                      onClick={() => setYamlText(YAML_TEMPLATE)}
                      className="px-2 py-1 border border-gray-300 rounded text-[11px] hover:bg-gray-50"
                    >
                      템플릿 채우기
                    </button>
                  </div>
                </div>
                <textarea
                  value={yamlText}
                  onChange={(e) => setYamlText(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[12px] font-mono bg-gray-900 text-gray-100 placeholder-gray-500"
                />
                <p className="text-[11px] text-gray-400">
                  표준 예시 템플릿이 기본 입력돼 있습니다. <code>name·mode·category</code>는 필수,
                  나머지는 mode에 맞춰 작성하세요.
                </p>
                <button
                  onClick={submitYaml}
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : <FileCode2 size={15} />}
                  매니페스트로 등록하고 ORB 심사 보내기
                </button>
              </>
            )}

            <p className="text-[11px] text-gray-400 text-center">
              등록 시 임시등록 → 심사·승격(ORB)을 거쳐 실행 목록에 노출됩니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

/**
 * 모델 드롭다운 공용 소스 — 기준정보(모델 단가, ModelPrice)에서 모델 목록을 가져온다.
 *
 * 모든 화면의 "모델 선택" 박스는 하드코딩 대신 이 훅/컴포넌트를 써서 관리자가
 * 「모델 단가」 화면에서 등록/활성화한 모델만 노출한다. (단일 소스 = GET /finops/model-prices)
 *
 *   const { models } = useModelOptions();
 *   <select ...><ModelOptionList models={models} /></select>
 */

import { useState, useEffect } from 'react';
import { api } from '@/lib/api-client';

export interface ModelOption {
  modelId: string;
  provider: string;
  tier?: number;
  active?: boolean;
}

/** 기준정보 조회 실패(서버 미기동 등) 시 최소 폴백 — 빈 박스 방지용. */
const FALLBACK: ModelOption[] = [
  { modelId: 'claude-sonnet-4-6', provider: 'anthropic' },
  { modelId: 'gpt-4o', provider: 'openai' },
];

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  selfhost: '사내(self-host)',
  unknown: '기타',
};

// 모듈 캐시 — 한 화면에 모델 드롭다운이 여러 개여도 호출은 1회만.
let cache: ModelOption[] | null = null;
let inflight: Promise<ModelOption[]> | null = null;

async function loadModels(): Promise<ModelOption[]> {
  if (cache) return cache;
  if (!inflight) {
    inflight = api
      .get<{ items: ModelOption[] }>('/finops/model-prices')
      .then((res) => {
        const items = (res?.items ?? []).filter((m) => m.active !== false);
        cache = items.length ? items : FALLBACK;
        return cache;
      })
      .catch(() => {
        cache = FALLBACK;
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useModelOptions(): { models: ModelOption[]; loading: boolean } {
  const [models, setModels] = useState<ModelOption[]>(cache ?? []);
  const [loading, setLoading] = useState(!cache);
  useEffect(() => {
    let alive = true;
    loadModels().then((m) => {
      if (!alive) return;
      setModels(m);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { models, loading };
}

/**
 * <select> 안에 넣는 모델 옵션 목록 — 공급자별 optgroup. 현재 값이 목록에 없으면(과거 선택)
 * 맨 위에 그 값도 함께 노출해 선택이 유지되도록 한다.
 */
/**
 * 자족형 모델 선택 <select> — 기준정보(모델 단가)에서 옵션을 채운다.
 * 각 노드 설정/등록 화면의 하드코딩 모델 박스를 이걸로 교체한다.
 */
export function ModelSelect({
  value,
  onChange,
  className,
}: {
  value?: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const { models } = useModelOptions();
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className={
        className ??
        'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500'
      }
    >
      <ModelOptionList models={models} current={value} />
    </select>
  );
}

export function ModelOptionList({
  models,
  current,
}: {
  models: ModelOption[];
  current?: string;
}) {
  const byProvider = new Map<string, ModelOption[]>();
  for (const m of models) {
    const p = m.provider || 'unknown';
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(m);
  }
  const known = new Set(models.map((m) => m.modelId));
  return (
    <>
      {current && !known.has(current) && <option value={current}>{current} (미등록)</option>}
      {Array.from(byProvider.entries()).map(([provider, list]) => (
        <optgroup key={provider} label={PROVIDER_LABEL[provider] ?? provider}>
          {list.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.modelId}
              {m.tier ? ` · T${m.tier}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

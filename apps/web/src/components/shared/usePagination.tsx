'use client';

/**
 * 공용 페이징 훅 + Pager 컴포넌트 (간소화버전 표준).
 * 모든 데이터 목록은 기본 10개만 보이고 나머지는 페이징한다.
 *
 * 사용:
 *   const p = usePagination(rows, 10);
 *   ...
 *   {p.pageItems.map(...)}
 *   <Pager p={p} />            // 표/리스트 아래
 *
 * 데이터 개수가 바뀌면(필터/검색) 자동으로 1페이지로 복귀한다.
 */
import { useMemo, useState, useEffect } from 'react';

export interface Pagination<T> {
  page: number;
  setPage: (n: number) => void;
  pageSize: number;
  total: number;
  totalPages: number;
  pageItems: T[];
  from: number; // 1-based 시작 인덱스
  to: number; // 1-based 끝 인덱스
}

export function usePagination<T>(items: T[], pageSize = 10): Pagination<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [page, setPage] = useState(1);

  // 데이터 개수가 줄어 현재 페이지가 범위를 벗어나면 보정
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  );

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return { page, setPage, pageSize, total, totalPages, pageItems, from, to };
}

/** 표/리스트 하단 페이지 네비게이션. 1페이지 이하이면 렌더하지 않음. */
export function Pager<T>({ p, className = '' }: { p: Pagination<T>; className?: string }) {
  if (p.total <= p.pageSize) return null;
  return (
    <div
      className={`flex items-center justify-between px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500 ${className}`}
    >
      <span>
        {p.from}–{p.to} / {p.total.toLocaleString()}건
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => p.setPage(Math.max(1, p.page - 1))}
          disabled={p.page === 1}
          className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50 transition"
        >
          이전
        </button>
        <span className="px-1.5 tabular-nums">
          {p.page} / {p.totalPages}
        </span>
        <button
          onClick={() => p.setPage(Math.min(p.totalPages, p.page + 1))}
          disabled={p.page >= p.totalPages}
          className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50 transition"
        >
          다음
        </button>
      </div>
    </div>
  );
}

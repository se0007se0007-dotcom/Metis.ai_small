/**
 * Web Search Executor
 *
 * Performs real web searches via external APIs:
 *   - Google Custom Search API
 *   - Naver Search API
 *   - Direct URL scraping (fallback)
 *
 * Registers as connector: metis-web-search
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
} from '../node-executor-registry';

@Injectable()
export class WebSearchExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'web-search';
  readonly displayName = '웹 검색 / 정보 수집';
  readonly handledNodeTypes = ['web-search'];
  readonly handledCategories = ['search'];

  private readonly logger = new Logger(WebSearchExecutor.name);

  constructor(
    private readonly registry: NodeExecutorRegistry,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const engine = settings.searchEngine || 'google';
    const keywords = settings.keywordTags?.join(' ') || settings.keywords || '';
    const maxResults = settings.maxResults || 10;
    const language = settings.language || 'ko';

    if (!keywords) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: '검색 키워드가 없습니다.',
      };
    }

    try {
      let results: SearchResult[];

      switch (engine) {
        case 'google':
        case 'google-news':
          results = await this.searchGoogle(
            keywords,
            maxResults,
            language,
            engine === 'google-news',
          );
          break;
        case 'naver':
          results = await this.searchNaver(keywords, maxResults);
          break;
        case 'duckduckgo':
          results = await this.keylessSearch(keywords, maxResults, language);
          break;
        default:
          results = await this.searchGoogle(keywords, maxResults, language, false);
      }

      const outputText = this.formatResults(results, keywords, engine);

      return {
        success: true,
        data: { engine, keywords, resultCount: results.length, results },
        outputText,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private async searchGoogle(
    query: string,
    maxResults: number,
    lang: string,
    newsOnly: boolean,
  ): Promise<SearchResult[]> {
    const apiKey = this.config.get('GOOGLE_SEARCH_API_KEY');
    const cx = this.config.get('GOOGLE_SEARCH_CX');

    if (!apiKey || !cx) {
      // 키 미설정 → 무키(keyless) 실검색(DuckDuckGo→Wikipedia)으로 실제 결과를 가져온다.
      this.logger.warn('Google Search API 미설정 → 무키 실검색(DuckDuckGo/Wikipedia)으로 대체');
      return this.keylessSearch(query, maxResults, lang);
    }

    const params = new URLSearchParams({
      key: apiKey,
      cx,
      q: query,
      num: String(Math.min(maxResults, 10)),
      lr: lang === 'ko' ? 'lang_ko' : '',
      ...(newsOnly ? { tbm: 'nws' } : {}),
    });

    const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    if (!response.ok) throw new Error(`Google Search API 오류: ${response.status}`);

    const data = (await response.json()) as any;
    return (data.items || []).map((item: any) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
      source: item.displayLink,
      publishedAt: item.pagemap?.metatags?.[0]?.['article:published_time'] || '',
    }));
  }

  private async searchNaver(query: string, maxResults: number): Promise<SearchResult[]> {
    const clientId = this.config.get('NAVER_CLIENT_ID');
    const clientSecret = this.config.get('NAVER_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      this.logger.warn('Naver Search API 미설정 → 무키 실검색(DuckDuckGo/Wikipedia)으로 대체');
      return this.keylessSearch(query, maxResults, 'ko');
    }

    const params = new URLSearchParams({
      query,
      display: String(Math.min(maxResults, 100)),
      sort: 'date',
    });

    const response = await fetch(`https://openapi.naver.com/v1/search/news.json?${params}`, {
      headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
    });

    if (!response.ok) throw new Error(`Naver Search API 오류: ${response.status}`);

    const data = (await response.json()) as any;
    return (data.items || []).map((item: any) => ({
      title: item.title.replace(/<[^>]*>/g, ''),
      url: item.originallink || item.link,
      snippet: item.description.replace(/<[^>]*>/g, ''),
      source: new URL(item.originallink || item.link).hostname,
      publishedAt: item.pubDate,
    }));
  }

  /**
   * 무키(keyless) 실검색 — 외부 API 키 없이도 실제 결과를 가져온다.
   * 1) DuckDuckGo Instant Answer (JSON, 무키) → 2) Wikipedia 검색(JSON, 무키) 폴백.
   * 둘 다 결과가 없을 때만 '데모/결과없음'을 명시적으로 라벨링해 반환(가짜 결과 흉내 금지).
   */
  private async keylessSearch(query: string, maxResults: number, lang: string): Promise<SearchResult[]> {
    let results: SearchResult[] = [];
    try {
      results = await this.searchDuckDuckGo(query, maxResults);
    } catch (e) {
      this.logger.warn(`DuckDuckGo 검색 실패: ${(e as Error).message}`);
    }
    if (results.length === 0) {
      try {
        results = await this.searchWikipedia(query, maxResults, lang);
      } catch (e) {
        this.logger.warn(`Wikipedia 검색 실패: ${(e as Error).message}`);
      }
    }
    if (results.length > 0) return results.slice(0, maxResults);
    // 실제 결과 없음 → 가짜 결과를 만들지 않고 '데모(결과없음)'를 명시적으로 표시.
    return [
      {
        title: `[데모 · 결과 없음] "${query}"`,
        url: '',
        snippet:
          '무키 실검색(DuckDuckGo·Wikipedia)에서 결과를 찾지 못했습니다. 더 정확한 결과가 필요하면 ' +
          'GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX 또는 NAVER_CLIENT_ID+NAVER_CLIENT_SECRET 를 설정하세요. ' +
          '(이 항목은 실제 검색 결과가 아니라 데모 안내입니다.)',
        source: 'demo',
        publishedAt: new Date().toISOString(),
      },
    ];
  }

  /** DuckDuckGo Instant Answer API (무키, JSON). Abstract + RelatedTopics 파싱. */
  private async searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', no_redirect: '1', t: 'metis' });
    const resp = await fetch(`https://api.duckduckgo.com/?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`DuckDuckGo ${resp.status}`);
    const d = (await resp.json()) as any;
    const out: SearchResult[] = [];
    if (d.AbstractText) {
      out.push({
        title: d.Heading || query,
        url: d.AbstractURL || '',
        snippet: d.AbstractText,
        source: d.AbstractSource || 'DuckDuckGo',
        publishedAt: '',
      });
    }
    const flatten = (topics: any[]): void => {
      for (const t of topics || []) {
        if (out.length >= maxResults) break;
        if (t.Topics) { flatten(t.Topics); continue; }
        if (t.Text && t.FirstURL) {
          out.push({
            title: t.Text.split(' - ')[0].slice(0, 160),
            url: t.FirstURL,
            snippet: t.Text,
            source: (() => { try { return new URL(t.FirstURL).hostname; } catch { return 'DuckDuckGo'; } })(),
            publishedAt: '',
          });
        }
      }
    };
    flatten(d.RelatedTopics);
    return out.slice(0, maxResults);
  }

  /** Wikipedia 검색 API (무키, JSON). 신뢰도 높은 폴백. */
  private async searchWikipedia(query: string, maxResults: number, lang: string): Promise<SearchResult[]> {
    const wl = lang === 'en' ? 'en' : 'ko';
    const params = new URLSearchParams({
      action: 'query', list: 'search', srsearch: query, format: 'json',
      srlimit: String(Math.min(maxResults, 20)), origin: '*',
    });
    const resp = await fetch(`https://${wl}.wikipedia.org/w/api.php?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`Wikipedia ${resp.status}`);
    const d = (await resp.json()) as any;
    return (d.query?.search || []).map((s: any) => ({
      title: s.title,
      url: `https://${wl}.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
      snippet: String(s.snippet || '').replace(/<[^>]*>/g, ''),
      source: `${wl}.wikipedia.org`,
      publishedAt: s.timestamp || '',
    }));
  }

  private formatResults(results: SearchResult[], query: string, engine: string): string {
    const lines = [
      `=== 검색 결과: "${query}" (${engine}) ===`,
      `검색 건수: ${results.length}개`,
      '',
    ];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      lines.push(`[${i + 1}] ${r.title}`);
      if (r.url) lines.push(`    URL: ${r.url}`);
      if (r.source) lines.push(`    출처: ${r.source}`);
      if (r.publishedAt) lines.push(`    일시: ${r.publishedAt}`);
      lines.push(`    ${r.snippet}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-web-search',
      name: '웹 검색 / 정보 수집',
      type: 'BUILT_IN',
      description:
        'Google·Naver(키 설정 시) 또는 무키 실검색(DuckDuckGo·Wikipedia)으로 웹에서 정보를 수집합니다. 키가 없어도 실제 검색이 동작합니다.',
      category: 'search',
      inputSchema: {
        keywords: { type: 'string' },
        searchEngine: { type: 'string', enum: ['google', 'google-news', 'naver', 'duckduckgo'] },
        maxResults: { type: 'number' },
      },
      outputSchema: {
        results: { type: 'array' },
        resultCount: { type: 'number' },
      },
      capabilities: ['google-search', 'naver-search', 'news-search', 'duckduckgo-search', 'wikipedia-search'],
    };
  }
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt: string;
}

/**
 * Professional HTML Report Template Generator
 *
 * Produces executive-dashboard-style HTML reports with:
 *   - KPI summary cards
 *   - SVG donut / bar charts
 *   - Severity-colored finding tables
 *   - Expandable detail sections
 *   - Print-friendly styling
 *
 * Zero external dependencies — pure inline CSS + SVG.
 */

// ─── Types ───────────────────────────────────────────────────────
export interface ReportData {
  title: string;
  subtitle?: string;
  projectName?: string;
  generatedAt: string;
  executionDuration?: number;
  nodeCount?: number;
  /** Raw text from AI analysis nodes (gets parsed automatically) */
  rawContent: string;
  /** Pre-parsed sections (if available) */
  sections?: ReportSection[];
  /** Explicit findings list (overrides auto-parse) */
  findings?: Finding[];
  /** Summary KPIs (overrides auto-extracted) */
  kpis?: KPI[];
}

export interface ReportSection {
  title: string;
  content: string;
  type: 'summary' | 'detail' | 'recommendation' | 'code' | 'table' | 'raw';
}

export interface Finding {
  id: string;
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category?: string;
  description: string;
  impact?: string;
  recommendation?: string;
  codeSnippet?: string;
  reference?: string;
}

export interface KPI {
  label: string;
  value: string | number;
  unit?: string;
  icon?: string;
  color?: string;
  trend?: 'up' | 'down' | 'neutral';
}

// ─── Severity Config ─────────────────────────────────────────────
export const SEVERITY_CONFIG = {
  critical: {
    label: '심각',
    color: '#DC2626',
    bg: '#FEF2F2',
    border: '#FECACA',
    icon: '🔴',
    weight: 5,
  },
  high: {
    label: '높음',
    color: '#EA580C',
    bg: '#FFF7ED',
    border: '#FED7AA',
    icon: '🟠',
    weight: 4,
  },
  medium: {
    label: '보통',
    color: '#CA8A04',
    bg: '#FEFCE8',
    border: '#FEF08A',
    icon: '🟡',
    weight: 3,
  },
  low: { label: '낮음', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE', icon: '🔵', weight: 2 },
  info: {
    label: '참고',
    color: '#6B7280',
    bg: '#F9FAFB',
    border: '#E5E7EB',
    icon: '⚪',
    weight: 1,
  },
};
const SEVERITY = {
  critical: {
    label: '심각',
    color: '#DC2626',
    bg: '#FEF2F2',
    border: '#FECACA',
    icon: '🔴',
    weight: 5,
  },
  high: {
    label: '높음',
    color: '#EA580C',
    bg: '#FFF7ED',
    border: '#FED7AA',
    icon: '🟠',
    weight: 4,
  },
  medium: {
    label: '보통',
    color: '#CA8A04',
    bg: '#FEFCE8',
    border: '#FEF08A',
    icon: '🟡',
    weight: 3,
  },
  low: { label: '낮음', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE', icon: '🔵', weight: 2 },
  info: {
    label: '참고',
    color: '#6B7280',
    bg: '#F9FAFB',
    border: '#E5E7EB',
    icon: '⚪',
    weight: 1,
  },
};

// ─── Content Parser ──────────────────────────────────────────────
export function parseAnalysisContent(raw: string): {
  sections: ReportSection[];
  findings: Finding[];
  kpis: KPI[];
} {
  const findings: Finding[] = [];
  const sections: ReportSection[] = [];
  let findingIdx = 0;

  // ── Extract findings from common AI output patterns ──
  // Pattern 1: "### 취약점명" or "## 1. 제목" style
  const findingPatterns = [
    /(?:^|\n)#{1,4}\s*(?:\d+[\.\)]\s*)?(?:취약점|발견|Finding|Issue|항목|문제)[:\s]*(.+?)(?:\n|$)/gim,
    /(?:^|\n)(?:\*\*|__)?\d+[\.\)]\s*(.+?)(?:\*\*|__)?[\s]*[\n]/g,
    /(?:^|\n)[-•]\s*\[?(심각|높음|보통|낮음|Critical|High|Medium|Low|Info)\]?\s*(.+?)(?:\n|$)/gi,
  ];

  // Try structured finding extraction
  const blocks = raw.split(/\n(?=#{1,4}\s|\d+[\.\)]\s|\*\*\d+|---)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Detect severity from block content
    const severity = detectSeverity(trimmed);
    const titleMatch =
      trimmed.match(/^#{1,4}\s*(?:\d+[\.\)]\s*)?(.+?)$/m) ||
      trimmed.match(/^\*\*(.+?)\*\*/m) ||
      trimmed.match(/^\d+[\.\)]\s*(.+?)$/m);

    if (titleMatch && (severity !== 'info' || trimmed.length > 100)) {
      findingIdx++;
      const finding: Finding = {
        id: `F-${String(findingIdx).padStart(3, '0')}`,
        title: titleMatch[1].replace(/\*\*/g, '').trim(),
        severity,
        description: extractDescription(trimmed),
        category: detectCategory(trimmed),
        impact: extractField(trimmed, ['영향', '위험', 'impact', 'risk']),
        recommendation: extractField(trimmed, [
          '권고',
          '조치',
          '대응',
          '해결',
          'recommendation',
          'remediation',
          'fix',
        ]),
        codeSnippet: extractCodeBlock(trimmed),
        reference: extractField(trimmed, ['참고', 'reference', 'CWE', 'CVE', 'OWASP']),
      };
      findings.push(finding);
    }
  }

  // ── Parse sections for the structured report body ──
  const sectionBlocks = raw.split(/\n(?=#{1,3}\s)/);
  for (const block of sectionBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const headMatch = trimmed.match(/^(#{1,3})\s*(.+?)$/m);
    if (headMatch) {
      const title = headMatch[2].replace(/\*\*/g, '').trim();
      const content = trimmed.slice(headMatch[0].length).trim();
      const type = detectSectionType(title);
      if (content.length > 5) {
        sections.push({ title, content, type });
      }
    } else if (trimmed.length > 20) {
      sections.push({ title: '', content: trimmed, type: 'raw' });
    }
  }

  // ── Build KPIs from findings ──
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) severityCounts[f.severity]++;
  const totalFindings = findings.length;
  const riskScore = Math.min(
    100,
    Math.round(
      ((severityCounts.critical * 25 +
        severityCounts.high * 15 +
        severityCounts.medium * 8 +
        severityCounts.low * 3) /
        Math.max(1, totalFindings)) *
        10,
    ),
  );

  const kpis: KPI[] = [
    { label: '총 발견 항목', value: totalFindings, icon: '🔍', color: '#3B82F6' },
    {
      label: '심각/높음',
      value: severityCounts.critical + severityCounts.high,
      icon: '🚨',
      color: '#DC2626',
    },
    {
      label: '보통/낮음',
      value: severityCounts.medium + severityCounts.low,
      icon: '⚠️',
      color: '#F59E0B',
    },
    {
      label: '위험 점수',
      value: riskScore,
      unit: '/100',
      icon: '📊',
      color: riskScore >= 70 ? '#DC2626' : riskScore >= 40 ? '#F59E0B' : '#10B981',
    },
  ];

  return { sections, findings: findings.length > 0 ? findings : autoGenerateFindings(raw), kpis };
}

function detectSeverity(text: string): Finding['severity'] {
  // First, try to extract explicit severity labels like "심각도: 높음" or "Severity: High"
  const explicitMatch =
    text.match(/심각도\s*[:：]\s*(심각|높음|보통|낮음|참고|critical|high|medium|low|info)/i) ||
    text.match(/severity\s*[:：]\s*(critical|high|medium|low|info|심각|높음|보통|낮음)/i) ||
    text.match(/\*\*심각도\s*[:：]?\s*(심각|높음|보통|낮음|참고).*?\*\*/i) ||
    text.match(/\[(심각|높음|보통|낮음|참고|Critical|High|Medium|Low|Info)\]/i);

  if (explicitMatch) {
    const label = explicitMatch[1].toLowerCase();
    if (/심각|critical/.test(label)) return 'critical';
    if (/높음|high/.test(label)) return 'high';
    if (/보통|medium/.test(label)) return 'medium';
    if (/낮음|low/.test(label)) return 'low';
    return 'info';
  }

  // Fallback: scan for parenthetical labels like "(Critical)" or "(High)"
  const parenMatch = text.match(
    /\(\s*(Critical|High|Medium|Low|Info|심각|높음|보통|낮음|참고)\s*\)/i,
  );
  if (parenMatch) {
    const label = parenMatch[1].toLowerCase();
    if (/심각|critical/.test(label)) return 'critical';
    if (/높음|high/.test(label)) return 'high';
    if (/보통|medium/.test(label)) return 'medium';
    if (/낮음|low/.test(label)) return 'low';
    return 'info';
  }

  // Last resort: loose keyword match (but exclude "심각도" as a false positive for "심각")
  const lower = text.toLowerCase();
  if (/(?<![가-힣])심각(?!도)|critical|긴급|치명/i.test(lower)) return 'critical';
  if (/(?<![가-힣])높음|high(?!er|ly|est)|위험(?!.*점수)/i.test(lower)) return 'high';
  if (/(?<![가-힣])보통|medium|중간|주의/i.test(lower)) return 'medium';
  if (/(?<![가-힣])낮음|low(?!er|est)|경미/i.test(lower)) return 'low';
  return 'info';
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/인증|auth|로그인|세션|session/i.test(lower)) return '인증/세션';
  if (/injection|인젝션|sql|xss|스크립트/i.test(lower)) return '인젝션';
  if (/암호|encrypt|cipher|crypto|해시|hash/i.test(lower)) return '암호화';
  if (/설정|config|configuration|환경/i.test(lower)) return '설정';
  if (/권한|access|authorization|acl|rbac/i.test(lower)) return '접근 제어';
  if (/api|엔드포인트|endpoint|http/i.test(lower)) return 'API 보안';
  if (/파일|file|upload|다운로드|경로/i.test(lower)) return '파일 처리';
  if (/로그|log|모니터|monitor|감사/i.test(lower)) return '로깅/모니터링';
  if (/데이터|data|개인정보|privacy|pii/i.test(lower)) return '데이터 보호';
  return '일반';
}

function detectSectionType(title: string): ReportSection['type'] {
  const lower = title.toLowerCase();
  if (/요약|summary|개요|overview|executive/i.test(lower)) return 'summary';
  if (/권고|recommendation|조치|대응|해결/i.test(lower)) return 'recommendation';
  if (/코드|code|소스|snippet/i.test(lower)) return 'code';
  return 'detail';
}

function extractDescription(block: string): string {
  const lines = block.split('\n').slice(1);
  const descLines: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (!lower) continue;
    if (
      /^(영향|위험|권고|조치|대응|해결|참고|reference|impact|recommendation|remediation|```)/i.test(
        lower,
      )
    )
      break;
    descLines.push(line.trim());
  }
  return descLines.join('\n').trim() || block.split('\n').slice(1, 4).join(' ').trim();
}

function extractField(block: string, keywords: string[]): string | undefined {
  for (const kw of keywords) {
    const regex = new RegExp(
      `(?:^|\\n)\\**\\s*${kw}[\\s:：]*\\**\\s*(.+?)(?=\\n(?:\\**\\s*(?:영향|위험|권고|조치|대응|해결|참고|코드)|#{1,4}\\s|$))`,
      'is',
    );
    const match = block.match(regex);
    if (match) return match[1].trim();
  }
  return undefined;
}

function extractCodeBlock(block: string): string | undefined {
  const codeMatch = block.match(/```[\w]*\n([\s\S]*?)```/);
  return codeMatch ? codeMatch[1].trim() : undefined;
}

function autoGenerateFindings(raw: string): Finding[] {
  // If structured parsing found nothing, create one finding per significant paragraph
  const paragraphs = raw.split(/\n\n+/).filter((p) => p.trim().length > 50);
  return paragraphs.slice(0, 20).map((p, i) => {
    const firstLine = p
      .trim()
      .split('\n')[0]
      .replace(/^[-•*#\d.\s]+/, '')
      .trim();
    return {
      id: `F-${String(i + 1).padStart(3, '0')}`,
      title: firstLine.slice(0, 80) || `항목 ${i + 1}`,
      severity: detectSeverity(p),
      category: detectCategory(p),
      description: p.trim(),
    };
  });
}

// ─── SVG Chart Generators ────────────────────────────────────────

function generateDonutChart(
  data: { label: string; value: number; color: string }[],
  size = 180,
): string {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0)
    return '<div style="text-align:center;color:#9CA3AF;padding:20px;">데이터 없음</div>';

  const cx = size / 2,
    cy = size / 2,
    r = size * 0.35,
    strokeWidth = size * 0.12;
  let currentAngle = -90;
  const paths: string[] = [];
  const legendItems: string[] = [];

  for (const d of data) {
    if (d.value === 0) continue;
    const pct = d.value / total;
    const angle = pct * 360;
    const startRad = (currentAngle * Math.PI) / 180;
    const endRad = ((currentAngle + angle) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const large = angle > 180 ? 1 : 0;

    paths.push(
      `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}" fill="none" stroke="${d.color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`,
    );
    legendItems.push(
      `<div style="display:flex;align-items:center;gap:6px;font-size:12px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${d.color};"></span>${d.label}: <strong>${d.value}</strong> (${Math.round(pct * 100)}%)</div>`,
    );
    currentAngle += angle;
  }

  return `
    <div style="display:flex;align-items:center;gap:24px;justify-content:center;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#F3F4F6" stroke-width="${strokeWidth}"/>
        ${paths.join('\n')}
        <text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="24" font-weight="bold" fill="#1F2937">${total}</text>
        <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="11" fill="#6B7280">총 항목</text>
      </svg>
      <div style="display:flex;flex-direction:column;gap:6px;">${legendItems.join('\n')}</div>
    </div>`;
}

function generateBarChart(
  data: { label: string; value: number; color: string }[],
  maxWidth = 300,
): string {
  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const bars = data
    .map(
      (d) => `
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:56px;text-align:right;font-size:11px;color:#6B7280;white-space:nowrap;">${d.label}</span>
      <div style="flex:1;background:#F3F4F6;border-radius:4px;height:22px;overflow:hidden;">
        <div style="width:${Math.max(2, (d.value / maxVal) * 100)}%;background:${d.color};height:100%;border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding-right:6px;">
          <span style="font-size:11px;color:white;font-weight:600;">${d.value}</span>
        </div>
      </div>
    </div>`,
    )
    .join('\n');

  return `<div style="max-width:${maxWidth}px;width:100%;">${bars}</div>`;
}

function generateRiskGauge(score: number, size = 120): string {
  const color = score >= 70 ? '#DC2626' : score >= 40 ? '#F59E0B' : '#10B981';
  const label = score >= 70 ? '위험' : score >= 40 ? '주의' : '양호';
  const angle = (score / 100) * 180;
  const rad = ((angle - 90) * Math.PI) / 180;
  const r = size * 0.38;
  const cx = size / 2,
    cy = size * 0.55;
  const x = cx + r * Math.cos(rad);
  const y = cy + r * Math.sin(rad);

  return `
    <svg width="${size}" height="${size * 0.7}" viewBox="0 0 ${size} ${size * 0.7}">
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="#E5E7EB" stroke-width="12" stroke-linecap="round"/>
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 ${angle > 90 ? 1 : 0} 1 ${x} ${y}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"/>
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="22" font-weight="bold" fill="${color}">${score}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="10" fill="#6B7280">${label}</text>
    </svg>`;
}

// ─── Category Distribution Horizontal Bar ─────────────────────────
function generateCategoryChart(findings: Finding[]): string {
  const catMap = new Map<string, number>();
  for (const f of findings) {
    const cat = f.category || '일반';
    catMap.set(cat, (catMap.get(cat) || 0) + 1);
  }
  const sorted = [...catMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const colors = [
    '#3B82F6',
    '#8B5CF6',
    '#EC4899',
    '#F59E0B',
    '#10B981',
    '#6366F1',
    '#14B8A6',
    '#F97316',
  ];
  return generateBarChart(
    sorted.map(([label, value], i) => ({ label, value, color: colors[i % colors.length] })),
    360,
  );
}

// ─── Main HTML Generator ─────────────────────────────────────────
export function generateDashboardHtml(data: ReportData): string {
  const parsed = parseAnalysisContent(data.rawContent);
  const findings = data.findings || parsed.findings;
  const kpis = data.kpis || parsed.kpis;
  const sections = data.sections || parsed.sections;

  const title = data.title || 'Metis.AI 분석 보고서';
  const subtitle = data.subtitle || data.projectName || '';
  const genDate = data.generatedAt;

  // Severity counts
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) sevCounts[f.severity]++;
  const riskScore = (kpis.find((k) => k.label.includes('위험 점수'))?.value as number) || 0;

  // ── Build Findings Table Rows ──
  const findingRows = findings
    .map((f, i) => {
      const sev = SEVERITY[f.severity];
      return `
      <tr class="finding-row" onclick="this.classList.toggle('expanded');this.nextElementSibling.classList.toggle('show');">
        <td style="font-weight:600;color:#374151;">${f.id}</td>
        <td>
          <span class="severity-badge" style="background:${sev.bg};color:${sev.color};border:1px solid ${sev.border};">
            ${sev.icon} ${sev.label}
          </span>
        </td>
        <td style="font-weight:500;">${escHtml(f.title)}</td>
        <td><span class="cat-tag">${escHtml(f.category || '일반')}</span></td>
        <td style="text-align:center;color:#9CA3AF;">▼</td>
      </tr>
      <tr class="detail-row">
        <td colspan="5">
          <div class="detail-content">
            <div class="detail-grid">
              <div>
                <h4>📋 설명</h4>
                <p>${escHtml(f.description).replace(/\n/g, '<br>')}</p>
              </div>
              ${f.impact ? `<div><h4>💥 영향</h4><p>${escHtml(f.impact).replace(/\n/g, '<br>')}</p></div>` : ''}
              ${f.recommendation ? `<div><h4>✅ 권고 조치</h4><p>${escHtml(f.recommendation).replace(/\n/g, '<br>')}</p></div>` : ''}
              ${f.reference ? `<div><h4>📚 참고</h4><p>${escHtml(f.reference)}</p></div>` : ''}
            </div>
            ${f.codeSnippet ? `<div class="code-block"><pre><code>${escHtml(f.codeSnippet)}</code></pre></div>` : ''}
          </div>
        </td>
      </tr>`;
    })
    .join('\n');

  // ── Build Detail Sections ──
  const detailSections = sections
    .filter((s) => s.content.length > 20)
    .map((s) => {
      const icon =
        s.type === 'summary'
          ? '📋'
          : s.type === 'recommendation'
            ? '✅'
            : s.type === 'code'
              ? '💻'
              : '📄';
      const contentHtml =
        s.type === 'code'
          ? `<pre class="code-block"><code>${escHtml(s.content)}</code></pre>`
          : `<div class="section-body">${formatMarkdownLight(s.content)}</div>`;
      return s.title
        ? `
      <div class="report-section">
        <h3>${icon} ${escHtml(s.title)}</h3>
        ${contentHtml}
      </div>`
        : '';
    })
    .join('\n');

  // ── Donut Chart Data ──
  const donutData = [
    { label: '심각 (Critical)', value: sevCounts.critical, color: SEVERITY.critical.color },
    { label: '높음 (High)', value: sevCounts.high, color: SEVERITY.high.color },
    { label: '보통 (Medium)', value: sevCounts.medium, color: SEVERITY.medium.color },
    { label: '낮음 (Low)', value: sevCounts.low, color: SEVERITY.low.color },
    { label: '참고 (Info)', value: sevCounts.info, color: SEVERITY.info.color },
  ];

  // ── Compose Full HTML ──
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
/* ── Reset & Base ────────────────────────────────── */
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',sans-serif;
  background:#F0F2F5;color:#1F2937;line-height:1.6;-webkit-font-smoothing:antialiased;}

/* ── Layout ──────────────────────────────────────── */
.report-wrapper{max-width:1200px;margin:0 auto;padding:24px;}

/* ── Header ──────────────────────────────────────── */
.report-header{background:linear-gradient(135deg,#1E3A5F 0%,#2563EB 100%);
  color:white;border-radius:16px;padding:32px 40px;margin-bottom:24px;
  position:relative;overflow:hidden;}
.report-header::after{content:'';position:absolute;top:-50%;right:-20%;
  width:400px;height:400px;border-radius:50%;
  background:rgba(255,255,255,0.05);}
.report-header h1{font-size:26px;font-weight:800;margin-bottom:4px;position:relative;z-index:1;}
.report-header .subtitle{font-size:14px;opacity:0.85;position:relative;z-index:1;}
.header-meta{display:flex;gap:24px;margin-top:16px;font-size:12px;opacity:0.75;position:relative;z-index:1;}
.header-meta span{display:flex;align-items:center;gap:4px;}

/* ── KPI Cards ───────────────────────────────────── */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px;}
.kpi-card{background:white;border-radius:12px;padding:20px 24px;
  box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #E5E7EB;
  display:flex;align-items:center;gap:16px;transition:transform 0.15s,box-shadow 0.15s;}
.kpi-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.1);}
.kpi-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;
  justify-content:center;font-size:22px;flex-shrink:0;}
.kpi-value{font-size:28px;font-weight:800;line-height:1;}
.kpi-label{font-size:12px;color:#6B7280;margin-top:2px;}
.kpi-unit{font-size:14px;font-weight:400;color:#9CA3AF;}

/* ── Dashboard Panels ────────────────────────────── */
.dashboard-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;}
@media(max-width:768px){.dashboard-grid{grid-template-columns:1fr;}}
.panel{background:white;border-radius:12px;padding:24px;
  box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #E5E7EB;}
.panel-title{font-size:15px;font-weight:700;color:#374151;margin-bottom:16px;
  display:flex;align-items:center;gap:8px;}
.panel-full{grid-column:1/-1;}

/* ── Findings Table ──────────────────────────────── */
.findings-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;}
.findings-table thead th{background:#F8FAFC;padding:10px 12px;text-align:left;
  font-weight:600;color:#6B7280;border-bottom:2px solid #E5E7EB;font-size:11px;
  text-transform:uppercase;letter-spacing:0.05em;}
.finding-row{cursor:pointer;transition:background 0.15s;}
.finding-row:hover{background:#F8FAFC;}
.finding-row td{padding:12px;border-bottom:1px solid #F3F4F6;vertical-align:middle;}
.severity-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;
  border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap;}
.cat-tag{background:#EFF6FF;color:#3B82F6;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;}
.detail-row{display:none;}
.detail-row.show{display:table-row;}
.detail-content{padding:16px 12px;background:#FAFBFC;border-radius:8px;margin:4px 0;}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media(max-width:768px){.detail-grid{grid-template-columns:1fr;}}
.detail-content h4{font-size:12px;font-weight:700;color:#4B5563;margin-bottom:6px;}
.detail-content p{font-size:13px;color:#374151;line-height:1.6;}

/* ── Code Block ──────────────────────────────────── */
.code-block{margin-top:12px;}
.code-block pre{background:#1E293B;color:#E2E8F0;padding:16px;border-radius:8px;
  overflow-x:auto;font-size:12px;line-height:1.5;}
.code-block code{font-family:'Fira Code','JetBrains Mono','D2Coding',monospace;}

/* ── Report Sections ─────────────────────────────── */
.report-section{background:white;border-radius:12px;padding:24px;
  box-shadow:0 1px 3px rgba(0,0,0,0.08);border:1px solid #E5E7EB;margin-bottom:16px;}
.report-section h3{font-size:16px;font-weight:700;color:#1F2937;margin-bottom:12px;
  padding-bottom:8px;border-bottom:2px solid #E5E7EB;}
.section-body{font-size:14px;color:#374151;line-height:1.8;}
.section-body p{margin-bottom:8px;}
.section-body ul,.section-body ol{margin:8px 0 8px 20px;}
.section-body li{margin-bottom:4px;}
.section-body strong{color:#111827;}
.section-body code{background:#F1F5F9;padding:1px 5px;border-radius:3px;font-size:12px;color:#DC2626;}

/* ── Risk Score Summary ──────────────────────────── */
.risk-summary{display:flex;align-items:center;justify-content:center;gap:32px;flex-wrap:wrap;}

/* ── Executive Summary Box ───────────────────────── */
.exec-summary{background:linear-gradient(135deg,#F0F9FF 0%,#EFF6FF 100%);
  border:1px solid #BFDBFE;border-radius:12px;padding:24px;margin-bottom:24px;}
.exec-summary h2{font-size:18px;font-weight:700;color:#1E40AF;margin-bottom:12px;
  display:flex;align-items:center;gap:8px;}
.exec-summary-content{font-size:14px;color:#1E3A5F;line-height:1.8;}

/* ── Footer ──────────────────────────────────────── */
.report-footer{text-align:center;padding:24px;color:#9CA3AF;font-size:11px;
  border-top:1px solid #E5E7EB;margin-top:32px;}

/* ── Severity Distribution Pill Row ──────────────── */
.sev-pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
.sev-pill{display:flex;align-items:center;gap:6px;padding:6px 14px;
  border-radius:24px;font-size:12px;font-weight:600;}

/* ── Print ───────────────────────────────────────── */
@media print{
  body{background:white;}
  .report-wrapper{max-width:100%;padding:12px;}
  .report-header{background:#1E3A5F !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .kpi-card,.panel,.report-section{break-inside:avoid;}
  .detail-row{display:table-row !important;}
  .finding-row td:last-child{display:none;}
  .findings-table thead th:last-child{display:none;}
}
</style>
</head>
<body>
<div class="report-wrapper">

  <!-- ═══ HEADER ═══ -->
  <div class="report-header">
    <h1>📊 ${escHtml(title)}</h1>
    ${subtitle ? `<div class="subtitle">${escHtml(subtitle)}</div>` : ''}
    <div class="header-meta">
      <span>📅 ${escHtml(genDate)}</span>
      ${data.executionDuration ? `<span>⏱ 실행 시간: ${(data.executionDuration / 1000).toFixed(1)}초</span>` : ''}
      ${data.nodeCount ? `<span>🔗 분석 노드: ${data.nodeCount}개</span>` : ''}
      <span>🤖 Metis.AI Workflow Engine</span>
    </div>
  </div>

  <!-- ═══ KPI CARDS ═══ -->
  <div class="kpi-grid">
    ${kpis
      .map(
        (k) => `
      <div class="kpi-card">
        <div class="kpi-icon" style="background:${k.color}15;">${k.icon || '📊'}</div>
        <div>
          <div class="kpi-value" style="color:${k.color};">${k.value}<span class="kpi-unit">${k.unit || ''}</span></div>
          <div class="kpi-label">${escHtml(k.label)}</div>
        </div>
      </div>`,
      )
      .join('\n')}
  </div>

  <!-- ═══ EXECUTIVE SUMMARY ═══ -->
  <div class="exec-summary">
    <h2>📋 경영진 요약 (Executive Summary)</h2>
    <div class="exec-summary-content">
      ${generateExecutiveSummary(findings, sevCounts, riskScore)}
    </div>
    <div class="sev-pills">
      ${Object.entries(sevCounts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => {
          const s = SEVERITY[k as keyof typeof SEVERITY];
          return `<span class="sev-pill" style="background:${s.bg};color:${s.color};border:1px solid ${s.border};">${s.icon} ${s.label}: ${v}건</span>`;
        })
        .join('\n')}
    </div>
  </div>

  <!-- ═══ DASHBOARD CHARTS ═══ -->
  <div class="dashboard-grid">
    <div class="panel">
      <div class="panel-title">🍩 심각도 분포</div>
      ${generateDonutChart(donutData)}
    </div>
    <div class="panel">
      <div class="panel-title">📊 위험도 게이지 & 카테고리 분포</div>
      <div class="risk-summary">
        ${generateRiskGauge(typeof riskScore === 'number' ? riskScore : 0)}
      </div>
      <div style="margin-top:16px;">
        ${generateCategoryChart(findings)}
      </div>
    </div>
  </div>

  <!-- ═══ FINDINGS TABLE ═══ -->
  <div class="panel panel-full" style="margin-bottom:24px;">
    <div class="panel-title">🔍 발견 항목 상세 (클릭하여 펼치기)</div>
    <div style="overflow-x:auto;">
      <table class="findings-table">
        <thead>
          <tr>
            <th style="width:70px;">ID</th>
            <th style="width:90px;">심각도</th>
            <th>항목명</th>
            <th style="width:100px;">카테고리</th>
            <th style="width:40px;"></th>
          </tr>
        </thead>
        <tbody>
          ${findingRows || '<tr><td colspan="5" style="text-align:center;padding:24px;color:#9CA3AF;">분석 결과가 없습니다.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>

  <!-- ═══ DETAILED SECTIONS ═══ -->
  ${detailSections}

  <!-- ═══ RECOMMENDATIONS SUMMARY ═══ -->
  ${generateRecommendationsSummary(findings)}

  <!-- ═══ FOOTER ═══ -->
  <div class="report-footer">
    <p>이 보고서는 <strong>Metis.AI</strong> AgentOps Governance Platform에 의해 자동 생성되었습니다.</p>
    <p style="margin-top:4px;">생성일시: ${escHtml(genDate)} | 문의: support@metis.ai</p>
  </div>

</div>
</body>
</html>`;
}

// ─── Helper: Executive Summary Generator ─────────────────────────
function generateExecutiveSummary(
  findings: Finding[],
  sevCounts: Record<string, number>,
  riskScore: number,
): string {
  const total = findings.length;
  if (total === 0) return '<p>분석 결과, 특이 사항이 발견되지 않았습니다.</p>';

  const riskLabel =
    riskScore >= 70 ? '높은 위험 수준' : riskScore >= 40 ? '주의가 필요한 수준' : '양호한 수준';
  const urgentCount = sevCounts.critical + sevCounts.high;
  const categories = new Set(findings.map((f) => f.category || '일반'));

  let html = `<p>본 분석에서 총 <strong>${total}개</strong>의 항목이 발견되었으며, 전체 위험 점수는 <strong>${riskScore}점/100점</strong>으로 <strong>${riskLabel}</strong>입니다.</p>`;

  if (urgentCount > 0) {
    html += `<p style="margin-top:8px;">🚨 <strong>즉시 조치가 필요한 심각/높음 등급 항목이 ${urgentCount}건</strong> 존재합니다. `;
    const criticals = findings.filter((f) => f.severity === 'critical');
    if (criticals.length > 0) {
      html += `특히 "<strong>${escHtml(criticals[0].title)}</strong>" 등 심각 등급 항목을 최우선으로 처리해야 합니다.`;
    }
    html += '</p>';
  }

  html += `<p style="margin-top:8px;">분석 영역은 <strong>${[...categories].slice(0, 5).join(', ')}</strong> 등 ${categories.size}개 카테고리에 걸쳐 있습니다.</p>`;

  return html;
}

// ─── Helper: Recommendations Summary ─────────────────────────────
function generateRecommendationsSummary(findings: Finding[]): string {
  const withReco = findings.filter((f) => f.recommendation);
  if (withReco.length === 0) return '';

  // Group by priority
  const urgent = withReco.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const moderate = withReco.filter((f) => f.severity === 'medium');
  const minor = withReco.filter((f) => f.severity === 'low' || f.severity === 'info');

  const buildList = (items: Finding[], icon: string) =>
    items
      .map((f) => {
        const sev = SEVERITY[f.severity];
        return `<li style="margin-bottom:8px;">
      <span class="severity-badge" style="background:${sev.bg};color:${sev.color};border:1px solid ${sev.border};font-size:10px;padding:1px 6px;">${sev.label}</span>
      <strong>${escHtml(f.title)}</strong>: ${escHtml(f.recommendation || '')}
    </li>`;
      })
      .join('\n');

  return `
  <div class="report-section">
    <h3>✅ 권고 조치 요약 (Action Items)</h3>
    ${
      urgent.length > 0
        ? `
      <h4 style="color:#DC2626;font-size:14px;margin:12px 0 8px;">🔴 즉시 조치 (Critical/High)</h4>
      <ul style="list-style:none;padding:0;">${buildList(urgent, '🔴')}</ul>`
        : ''
    }
    ${
      moderate.length > 0
        ? `
      <h4 style="color:#CA8A04;font-size:14px;margin:12px 0 8px;">🟡 단기 개선 (Medium)</h4>
      <ul style="list-style:none;padding:0;">${buildList(moderate, '🟡')}</ul>`
        : ''
    }
    ${
      minor.length > 0
        ? `
      <h4 style="color:#2563EB;font-size:14px;margin:12px 0 8px;">🔵 장기 개선 (Low/Info)</h4>
      <ul style="list-style:none;padding:0;">${buildList(minor, '🔵')}</ul>`
        : ''
    }
  </div>`;
}

// ─── Helper: Light Markdown → HTML ───────────────────────────────
function formatMarkdownLight(text: string): string {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>');
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

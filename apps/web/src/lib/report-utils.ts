/**
 * Shared report generation utilities
 * Used by both NodeSettingsPanels.tsx (preview/download) and page.tsx (pipeline execution)
 */

export interface Finding {
  id: string;
  title: string;
  severity: string;
  category: string;
  desc: string;
  risk: string; // 위험성 — 이 취약점이 악용될 경우 발생할 수 있는 피해/영향
  reco: string;
  cvss?: string;
  cwe?: string;
  location?: string;
}

export function escH(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Decoration / noise filters ──────────────────────────────
const DECO_RE = /^[█═─━┃│┌┐└┘├┤┬┴╔╗╚╝╠╣╬═\-=~*_\s]{5,}$/;
const META_SKIP_RE = /^(█\s+METIS|토큰:|🛡️|📊 취약점 통계|CRITICAL:\s*\d+건\s*\|)/;

function isDecorationLine(line: string): boolean {
  const t = line.trim();
  return DECO_RE.test(t) || t.length === 0;
}

function isMetaLine(line: string): boolean {
  return META_SKIP_RE.test(line.trim());
}

// ── Severity detection ──────────────────────────────────────
function detectSev(t: string): string {
  // 1. Pentest format: "위험도: CRITICAL" / "위험도: HIGH"
  const pentestSev = t.match(/위험도\s*[:：]\s*(CRITICAL|HIGH|MEDIUM|LOW|INFO)/i);
  if (pentestSev) {
    return pentestSev[1].toLowerCase();
  }
  // 2. Korean explicit label: "심각도: 높음"
  const ex =
    t.match(/심각도\s*[:：]\s*(심각|높음|보통|낮음|참고|critical|high|medium|low|info)/i) ||
    t.match(/\*\*심각도\s*[:：]?\s*(심각|높음|보통|낮음|참고).*?\*\*/i) ||
    t.match(/\(\s*(Critical|High|Medium|Low|Info|심각|높음|보통|낮음)\s*\)/i);
  if (ex) {
    const lb = ex[1].toLowerCase();
    if (/심각|critical/.test(lb)) return 'critical';
    if (/높음|high/.test(lb)) return 'high';
    if (/보통|medium/.test(lb)) return 'medium';
    if (/낮음|low/.test(lb)) return 'low';
    return 'info';
  }
  // 3. Fallback keyword match (avoiding false positives with 심각도)
  const l = t.toLowerCase();
  if (/(?<![가-힣])심각(?!도)|critical|긴급|치명/.test(l)) return 'critical';
  if (/(?<![가-힣])높음|(?<!\w)high(?!\w)|위험(?!.*점수)/.test(l)) return 'high';
  if (/(?<![가-힣])보통|(?<!\w)medium(?!\w)|중간|주의/.test(l)) return 'medium';
  if (/(?<![가-힣])낮음|(?<!\w)low(?!\w)|경미/.test(l)) return 'low';
  return 'info';
}

// ── Category detection ──────────────────────────────────────
function detectCat(t: string): string {
  const l = t.toLowerCase();
  if (/sql.?injection|인젝션|sql/i.test(l)) return '인젝션';
  if (/인증|auth(?!or)|jwt|세션|session/i.test(l)) return '인증/세션';
  if (/xss|cross.?site/i.test(l)) return 'XSS';
  if (/idor|권한|access|authorization/i.test(l)) return '접근 제어';
  if (/ssrf|server.?side.?request/i.test(l)) return 'SSRF';
  if (/command.?injection|os.?command/i.test(l)) return '커맨드 인젝션';
  if (/path.?traversal|디렉토리/i.test(l)) return '경로 조작';
  if (/암호|encrypt|hash|md5|sha1|bcrypt/i.test(l)) return '암호화';
  if (/api|endpoint|http/i.test(l)) return 'API 보안';
  if (/파일|file|upload/i.test(l)) return '파일 처리';
  if (/설정|config/i.test(l)) return '설정';
  if (/key|secret|credential|하드코딩/i.test(l)) return '비밀 관리';
  return '일반';
}

// ── Convert structured findings from node details ───────────
export function fromStructuredFindings(vulns: any[]): Finding[] {
  return vulns.map((v) => ({
    id: v.id || `V-${String(vulns.indexOf(v) + 1).padStart(3, '0')}`,
    title: v.name || v.title || '(제목 없음)',
    severity: (v.severity || 'info').toLowerCase(),
    category: detectCat(`${v.name || ''} ${v.cwe || ''} ${v.desc || ''}`),
    desc: v.desc || v.description || '',
    risk: v.risk || v.impact || '',
    reco: v.fix || v.recommendation || '',
    cvss: v.cvss || '',
    cwe: v.cwe || '',
    location: v.file ? `${v.file}${v.line ? ':' + v.line : ''}` : '',
  }));
}

// ── Parse findings from raw pipeline text ───────────────────
export function parseFindings(raw: string): Finding[] {
  // 1. Try pentest format: [PT-001] / [SA-001] style blocks separated by ═══
  const pentestFindings = parsePentestFormat(raw);
  if (pentestFindings.length > 0) return pentestFindings;

  // 2. Try markdown-style findings
  const mdFindings = parseMarkdownFormat(raw);
  if (mdFindings.length > 0) return mdFindings;

  // 3. Fallback: paragraph splitting
  return parseParagraphFallback(raw);
}

function parsePentestFormat(raw: string): Finding[] {
  const findings: Finding[] = [];

  // Match blocks starting with [XX-NNN] pattern
  const blockRe =
    /\[([A-Z]{2,4}-\d{2,4})\]\s*(.+?)(?=\n\[(?:[A-Z]{2,4}-\d{2,4})\]|\n[─━═]{10,}(?:\n(?:수정 로드맵|토큰))|$)/gs;
  let match;

  // Clean: remove decorator lines from raw first, but keep [ID] lines
  const lines = raw.split('\n');
  const cleanedLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // Skip pure decoration lines
    if (DECO_RE.test(t)) continue;
    // Skip metadata header lines (█ METIS.AI ...)
    if (/^█\s/.test(t)) continue;
    cleanedLines.push(line);
  }
  const cleaned = cleanedLines.join('\n');

  // Split by [XX-NNN] pattern
  const parts = cleaned.split(/(?=\[(?:[A-Z]{2,4}-\d{2,4})\]\s)/);

  for (const part of parts) {
    const t = part.trim();
    const idMatch = t.match(/^\[([A-Z]{2,4}-\d{2,4})\]\s*(.+)/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const titleLine = idMatch[2].trim();
    const bodyLines = t
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean);

    let severity = 'info';
    let cvss = '';
    let cwe = '';
    let location = '';
    let desc = '';
    let risk = '';
    let fix = '';

    for (const line of bodyLines) {
      if (/^위험도\s*[:：]/.test(line)) {
        const sevMatch = line.match(/위험도\s*[:：]\s*(\w+)/);
        if (sevMatch) severity = sevMatch[1].toLowerCase();
        const cvssMatch = line.match(/CVSS\s*[:：]?\s*([\d.]+)/);
        if (cvssMatch) cvss = cvssMatch[1];
        const cweMatch = line.match(/(CWE-\d+)/);
        if (cweMatch) cwe = cweMatch[1];
      } else if (/^위치\s*[:：]/.test(line)) {
        location = line.replace(/^위치\s*[:：]\s*/, '');
      } else if (/^설명\s*[:：]/.test(line)) {
        desc = line.replace(/^설명\s*[:：]\s*/, '');
      } else if (/^위험성\s*[:：]/.test(line)) {
        risk = line.replace(/^위험성\s*[:：]\s*/, '');
      } else if (/^수정\s*방안\s*[:：]/.test(line)) {
        fix = line.replace(/^수정\s*방안\s*[:：]\s*/, '');
      }
    }

    // If no structured fields found, use body as description
    if (!desc && bodyLines.length > 0) {
      desc = bodyLines
        .filter(
          (l) =>
            !l.startsWith('위험도') &&
            !l.startsWith('위치') &&
            !l.startsWith('수정') &&
            !l.startsWith('위험성'),
        )
        .join('\n');
    }

    findings.push({
      id,
      title: titleLine,
      severity,
      category: detectCat(`${titleLine} ${cwe} ${desc}`),
      desc: desc || titleLine,
      risk,
      reco: fix,
      cvss,
      cwe,
      location,
    });
  }

  return findings;
}

function parseMarkdownFormat(raw: string): Finding[] {
  const findings: Finding[] = [];
  // Split by markdown headers or numbered items, but skip decoration
  const blocks = raw.split(/\n(?=#{1,4}\s|\d+[\.\)]\s|\*\*\d+)/);
  let idx = 0;

  for (const block of blocks) {
    const t = block.trim();
    if (!t || t.length < 30) continue;

    // Skip blocks that are mostly decoration
    const contentLines = t.split('\n').filter((l) => !isDecorationLine(l) && !isMetaLine(l));
    if (contentLines.length < 2) continue;

    const titleMatch =
      t.match(/^#{1,4}\s*(?:\d+[\.\)]\s*)?(.+?)$/m) ||
      t.match(/^\*\*(.+?)\*\*/m) ||
      t.match(/^\d+[\.\)]\s*(.+?)$/m);
    if (!titleMatch) continue;

    const title = titleMatch[1].replace(/\*\*/g, '').trim();
    // Skip decoration-like titles
    if (DECO_RE.test(title) || title.length < 5) continue;

    idx++;
    const sev = detectSev(t);
    const lines = contentLines.slice(1);
    const recoMatch = t.match(
      /(?:권��|조치|대응|해결|수정\s*방안|recommendation)[:\s：]*(.+?)(?=\n(?:#{1,4}|$|\[))/is,
    );
    const riskMatch = t.match(
      /(?:위험성|영향|impact)[:\s：]*(.+?)(?=\n(?:#{1,4}|$|\[|권고|조치|수정))/is,
    );

    findings.push({
      id: `F-${String(idx).padStart(3, '0')}`,
      title: title.slice(0, 80),
      severity: sev,
      category: detectCat(t),
      desc: lines.slice(0, 5).join('\n').trim(),
      risk: riskMatch ? riskMatch[1].trim() : '',
      reco: recoMatch ? recoMatch[1].trim() : '',
    });
  }

  return findings;
}

function parseParagraphFallback(raw: string): Finding[] {
  const findings: Finding[] = [];
  // Remove all decoration lines first
  const cleaned = raw
    .split('\n')
    .filter((l) => !isDecorationLine(l) && !isMetaLine(l))
    .join('\n');

  cleaned
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 50)
    .slice(0, 15)
    .forEach((p, i) => {
      const firstLine = p
        .trim()
        .split('\n')[0]
        .replace(/^[-•*#\d.\s]+/, '')
        .trim()
        .slice(0, 80);
      if (DECO_RE.test(firstLine) || firstLine.length < 5) return;
      findings.push({
        id: `F-${String(i + 1).padStart(3, '0')}`,
        title: firstLine || `항목 ${i + 1}`,
        severity: detectSev(p),
        category: detectCat(p),
        desc: p.trim(),
        risk: '',
        reco: '',
      });
    });
  return findings;
}

export const SEV_STYLE: Record<
  string,
  { label: string; color: string; bg: string; border: string; icon: string }
> = {
  critical: { label: '심각', color: '#DC2626', bg: '#FEF2F2', border: '#FECACA', icon: '🔴' },
  high: { label: '높음', color: '#EA580C', bg: '#FFF7ED', border: '#FED7AA', icon: '🟠' },
  medium: { label: '보통', color: '#CA8A04', bg: '#FEFCE8', border: '#FEF08A', icon: '🟡' },
  low: { label: '낮음', color: '#2563EB', bg: '#EFF6FF', border: '#BFDBFE', icon: '🔵' },
  info: { label: '참고', color: '#6B7280', bg: '#F9FAFB', border: '#E5E7EB', icon: '⚪' },
};

// ══════════════════════════════════════════════════════════════
//  Professional HTML Dashboard Report
// ══════════════════════════════════════════════════════════════

export function buildProfessionalHtmlReport(
  content: string,
  title: string,
  project: string,
  structuredFindings?: any[],
): string {
  const findings: Finding[] = structuredFindings
    ? fromStructuredFindings(structuredFindings)
    : parseFindings(content);
  return _buildHtml(findings, content, title, project);
}

function _buildHtml(
  findings: Finding[],
  rawContent: string,
  title: string,
  project: string,
): string {
  const sevCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  findings.forEach((f) => {
    sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1;
  });
  const total = findings.length;
  const urgentCount = (sevCounts.critical || 0) + (sevCounts.high || 0);
  const riskScore = Math.min(
    100,
    Math.round(
      (((sevCounts.critical || 0) * 25 +
        (sevCounts.high || 0) * 15 +
        (sevCounts.medium || 0) * 8 +
        (sevCounts.low || 0) * 3) /
        Math.max(1, total)) *
        10,
    ),
  );
  const genDate = new Date().toLocaleString('ko-KR');

  // SVG donut
  const donutData = Object.entries(sevCounts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({
      label: SEV_STYLE[k]?.label || k,
      value: v,
      color: SEV_STYLE[k]?.color || '#999',
    }));
  const donutTotal = donutData.reduce((s, d) => s + d.value, 0) || 1;
  let angle = -90;
  const cx = 90,
    cy = 90,
    r = 63,
    sw = 22;
  const arcs = donutData
    .map((d) => {
      const pct = d.value / donutTotal;
      const a = pct * 360;
      const s1 = (angle * Math.PI) / 180;
      const s2 = ((angle + a) * Math.PI) / 180;
      const x1 = cx + r * Math.cos(s1),
        y1 = cy + r * Math.sin(s1),
        x2 = cx + r * Math.cos(s2),
        y2 = cy + r * Math.sin(s2);
      const lg = a > 180 ? 1 : 0;
      const path = `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${lg} 1 ${x2} ${y2}" fill="none" stroke="${d.color}" stroke-width="${sw}" stroke-linecap="round"/>`;
      angle += a;
      return path;
    })
    .join('');

  const legendHtml = donutData
    .map(
      (d) =>
        `<div style="display:flex;align-items:center;gap:6px;font-size:12px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${d.color};"></span>${d.label}: <b>${d.value}</b> (${Math.round((d.value / donutTotal) * 100)}%)</div>`,
    )
    .join('');

  // Risk gauge SVG
  const gaugeColor = riskScore >= 70 ? '#DC2626' : riskScore >= 40 ? '#F59E0B' : '#10B981';
  const gaugeLabel = riskScore >= 70 ? '위험' : riskScore >= 40 ? '주의' : '양호';
  const ga = (riskScore / 100) * 180;
  const gr = ((ga - 90) * Math.PI) / 180;
  const gcx = 60,
    gcy = 44,
    grr = 36;
  const gx = gcx + grr * Math.cos(gr),
    gy = gcy + grr * Math.sin(gr);

  // Category bar chart
  const catMap = new Map<string, number>();
  findings.forEach((f) => {
    catMap.set(f.category, (catMap.get(f.category) || 0) + 1);
  });
  const cats = [...catMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const catMax = Math.max(...cats.map((c) => c[1]), 1);
  const barColors = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#6366F1'];
  const barsHtml = cats
    .map(
      ([label, value], i) =>
        `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;"><span style="width:60px;text-align:right;font-size:11px;color:#6B7280;white-space:nowrap;">${escH(label)}</span><div style="flex:1;background:#F3F4F6;border-radius:4px;height:22px;overflow:hidden;"><div style="width:${Math.max(4, (value / catMax) * 100)}%;background:${barColors[i % 6]};height:100%;border-radius:4px;display:flex;align-items:center;justify-content:flex-end;padding-right:6px;"><span style="font-size:11px;color:white;font-weight:600;">${value}</span></div></div></div>`,
    )
    .join('');

  // Finding rows — with CVSS, CWE, location support
  const rows = findings
    .map((f) => {
      const s = SEV_STYLE[f.severity] || SEV_STYLE.info;
      const extraInfo = [
        f.cvss ? `CVSS: ${f.cvss}` : '',
        f.cwe || '',
        f.location ? `📍 ${f.location}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      return `<tr class="fr" onclick="this.classList.toggle('ex');this.nextElementSibling.classList.toggle('show');">
      <td style="font-weight:600;color:#374151;">${escH(f.id)}</td>
      <td><span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:${s.bg};color:${s.color};border:1px solid ${s.border};">${s.icon} ${s.label}</span></td>
      <td style="font-weight:500;">${escH(f.title)}</td>
      <td><span style="background:#EFF6FF;color:#3B82F6;padding:2px 8px;border-radius:4px;font-size:11px;">${escH(f.category)}</span></td>
      <td style="text-align:center;color:#9CA3AF;cursor:pointer;">▼</td>
    </tr>
    <tr class="dr"><td colspan="5"><div style="padding:16px 12px;background:#FAFBFC;border-radius:8px;margin:4px 0;">
      ${extraInfo ? `<div style="font-size:11px;color:#6B7280;margin-bottom:8px;">${escH(extraInfo)}</div>` : ''}
      <div style="font-size:13px;color:#374151;line-height:1.6;white-space:pre-wrap;">${escH(f.desc)}</div>
      ${f.risk ? `<div style="margin-top:8px;padding:8px 12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;"><strong style="color:#DC2626;font-size:12px;">⚠️ 위험성:</strong> <span style="font-size:12px;color:#991B1B;">${escH(f.risk)}</span></div>` : ''}
      ${f.reco ? `<div style="margin-top:8px;padding:8px 12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:6px;"><strong style="color:#15803D;font-size:12px;">✅ 수정 방안:</strong> <span style="font-size:12px;color:#166534;">${escH(f.reco)}</span></div>` : ''}
    </div></td></tr>`;
    })
    .join('\n');

  // Severity pills
  const pills = Object.entries(sevCounts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => {
      const s = SEV_STYLE[k] || SEV_STYLE.info;
      return `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:24px;font-size:12px;font-weight:600;background:${s.bg};color:${s.color};border:1px solid ${s.border};">${s.icon} ${s.label}: ${v}건</span>`;
    })
    .join(' ');

  // Recommendations summary
  const recFindings = findings.filter((f) => f.reco);
  const recoTable =
    recFindings.length > 0
      ? `<div class="pn pf" style="margin-bottom:24px;"><div class="pt">✅ 권고 조치 요약 (Action Items)</div>
    <table class="ft"><thead><tr><th style="width:70px;">우선순위</th><th style="width:70px;">ID</th><th>항목</th><th>조치사항</th></tr></thead><tbody>
    ${recFindings
      .sort(
        (a, b) =>
          ['critical', 'high', 'medium', 'low', 'info'].indexOf(a.severity) -
          ['critical', 'high', 'medium', 'low', 'info'].indexOf(b.severity),
      )
      .map((f) => {
        const s = SEV_STYLE[f.severity] || SEV_STYLE.info;
        return `<tr><td><span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${s.bg};color:${s.color};">${s.icon} ${s.label}</span></td><td style="font-weight:600;">${escH(f.id)}</td><td>${escH(f.title)}</td><td style="color:#166534;font-size:12px;">${escH(f.reco)}</td></tr>`;
      })
      .join('')}
    </tbody></table></div>`
      : '';

  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escH(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Pretendard','Noto Sans KR','Malgun Gothic',sans-serif;background:#F0F2F5;color:#1F2937;line-height:1.6;}
.rw{max-width:1200px;margin:0 auto;padding:24px;}
.hdr{background:linear-gradient(135deg,#1E3A5F 0%,#2563EB 100%);color:white;border-radius:16px;padding:32px 40px;margin-bottom:24px;position:relative;overflow:hidden;}
.hdr::after{content:'';position:absolute;top:-50%;right:-20%;width:400px;height:400px;border-radius:50%;background:rgba(255,255,255,0.05);}
.hdr h1{font-size:26px;font-weight:800;position:relative;z-index:1;} .hdr .st{font-size:14px;opacity:.85;position:relative;z-index:1;} .hdr .mt{display:flex;gap:24px;margin-top:16px;font-size:12px;opacity:.75;position:relative;z-index:1;}
.kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px;}
.kc{background:white;border-radius:12px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #E5E7EB;display:flex;align-items:center;gap:16px;transition:transform .15s;}
.kc:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.1);}
.ki{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;}
.kv{font-size:28px;font-weight:800;line-height:1;} .kl{font-size:12px;color:#6B7280;margin-top:2px;} .ku{font-size:14px;font-weight:400;color:#9CA3AF;}
.es{background:linear-gradient(135deg,#F0F9FF,#EFF6FF);border:1px solid #BFDBFE;border-radius:12px;padding:24px;margin-bottom:24px;}
.es h2{font-size:18px;font-weight:700;color:#1E40AF;margin-bottom:12px;}
.dg{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;} @media(max-width:768px){.dg{grid-template-columns:1fr;}}
.pn{background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #E5E7EB;}
.pt{font-size:15px;font-weight:700;color:#374151;margin-bottom:16px;}
.pf{grid-column:1/-1;}
table.ft{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;}
table.ft thead th{background:#F8FAFC;padding:10px 12px;text-align:left;font-weight:600;color:#6B7280;border-bottom:2px solid #E5E7EB;font-size:11px;text-transform:uppercase;letter-spacing:.05em;}
.fr{cursor:pointer;transition:background .15s;} .fr:hover{background:#F8FAFC;} .fr td{padding:12px;border-bottom:1px solid #F3F4F6;vertical-align:middle;}
.dr{display:none;} .dr.show{display:table-row;}
.rf{text-align:center;padding:24px;color:#9CA3AF;font-size:11px;border-top:1px solid #E5E7EB;margin-top:32px;}
@media print{body{background:white;} .rw{max-width:100%;padding:12px;} .hdr{background:#1E3A5F!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;} .kc,.pn{break-inside:avoid;} .dr{display:table-row!important;} .fr td:last-child,.ft thead th:last-child{display:none;}}
</style></head><body><div class="rw">
  <div class="hdr"><h1>📊 ${escH(title)}</h1>${project ? `<div class="st">${escH(project)}</div>` : ''}<div class="mt"><span>📅 ${genDate}</span><span>🤖 Metis.AI Workflow Engine</span></div></div>
  <div class="kg">
    <div class="kc"><div class="ki" style="background:#3B82F615;">🔍</div><div><div class="kv" style="color:#3B82F6;">${total}</div><div class="kl">총 발견 항목</div></div></div>
    <div class="kc"><div class="ki" style="background:#DC262615;">🚨</div><div><div class="kv" style="color:#DC2626;">${urgentCount}</div><div class="kl">심각/높음</div></div></div>
    <div class="kc"><div class="ki" style="background:#F59E0B15;">⚠️</div><div><div class="kv" style="color:#F59E0B;">${(sevCounts.medium || 0) + (sevCounts.low || 0)}</div><div class="kl">보통/낮음</div></div></div>
    <div class="kc"><div class="ki" style="background:${gaugeColor}15;">📊</div><div><div class="kv" style="color:${gaugeColor};">${riskScore}<span class="ku">/100</span></div><div class="kl">위험 점수</div></div></div>
  </div>
  <div class="es"><h2>📋 경영진 요약 (Executive Summary)</h2><div style="font-size:14px;color:#1E3A5F;line-height:1.8;">
    <p>본 분석에서 총 <strong>${total}개</strong>의 항목이 발견되었으며, 전체 위험 점수는 <strong>${riskScore}점/100점</strong>으로 <strong>${riskScore >= 70 ? '높은 위험 수준' : riskScore >= 40 ? '주의가 필요한 수준' : '양호한 수준'}</strong>입니다.</p>
    ${urgentCount > 0 ? `<p style="margin-top:8px;">🚨 <strong>즉시 조치가 필요한 심각/높음 등급 항목이 ${urgentCount}건</strong> 존재합니다.</p>` : ''}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">${pills}</div>
  </div>
  <div class="dg">
    <div class="pn"><div class="pt">🍩 심각도 분포</div>
      <div style="display:flex;align-items:center;gap:24px;justify-content:center;">
        <svg width="180" height="180" viewBox="0 0 180 180"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#F3F4F6" stroke-width="${sw}"/>${arcs}<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="24" font-weight="bold" fill="#1F2937">${findings.length}</text><text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="11" fill="#6B7280">총 항목</text></svg>
        <div style="display:flex;flex-direction:column;gap:6px;">${legendHtml}</div></div></div>
    <div class="pn"><div class="pt">📊 카테고리 분포</div>
      <div style="display:flex;align-items:center;justify-content:center;margin-bottom:12px;">
        <svg width="120" height="70" viewBox="0 0 120 70"><path d="M ${gcx - grr} ${gcy} A ${grr} ${grr} 0 0 1 ${gcx + grr} ${gcy}" fill="none" stroke="#E5E7EB" stroke-width="10" stroke-linecap="round"/><path d="M ${gcx - grr} ${gcy} A ${grr} ${grr} 0 ${ga > 90 ? 1 : 0} 1 ${gx} ${gy}" fill="none" stroke="${gaugeColor}" stroke-width="10" stroke-linecap="round"/><text x="${gcx}" y="${gcy - 4}" text-anchor="middle" font-size="18" font-weight="bold" fill="${gaugeColor}">${riskScore}</text><text x="${gcx}" y="${gcy + 10}" text-anchor="middle" font-size="9" fill="#6B7280">${gaugeLabel}</text></svg>
      </div>${barsHtml}</div>
  </div>
  <div class="pn pf" style="margin-bottom:24px;"><div class="pt">🔍 발견 항목 상세 (클릭하여 펼치기)</div>
    <div style="overflow-x:auto;"><table class="ft"><thead><tr><th style="width:70px;">ID</th><th style="width:90px;">심각도</th><th>항목명</th><th style="width:100px;">카테고리</th><th style="width:40px;"></th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;padding:24px;color:#9CA3AF;">분석 결과가 없습니다.</td></tr>'}</tbody></table></div></div>
  ${recoTable}
  <div class="rf"><p>이 보고서는 <strong>Metis.AI</strong> AgentOps Governance Platform에 의해 자동 생성되었습니다.</p><p style="margin-top:4px;">생성일시: ${genDate}</p></div>
</div></body></html>`;
}

// ══════════════════════════════════════════════════════════════
//  Professional Word Document (Word ML HTML format)
// ══════════════════════════════════════════════════════════════

export function buildProfessionalWordDoc(
  content: string,
  title: string,
  project: string,
  structuredFindings?: any[],
): string {
  const findings: Finding[] = structuredFindings
    ? fromStructuredFindings(structuredFindings)
    : parseFindings(content);
  return _buildWord(findings, content, title, project);
}

function _buildWord(
  findings: Finding[],
  rawContent: string,
  title: string,
  project: string,
): string {
  const sevCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  findings.forEach((f) => {
    sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1;
  });
  const total = findings.length;
  const urgentCount = (sevCounts.critical || 0) + (sevCounts.high || 0);
  const riskScore = Math.min(
    100,
    Math.round(
      (((sevCounts.critical || 0) * 25 +
        (sevCounts.high || 0) * 15 +
        (sevCounts.medium || 0) * 8 +
        (sevCounts.low || 0) * 3) /
        Math.max(1, total)) *
        10,
    ),
  );
  const genDate = new Date().toLocaleString('ko-KR');

  // Summary stats table
  const statsRows = Object.entries(sevCounts)
    .map(([k, v]) => {
      const s = SEV_STYLE[k] || SEV_STYLE.info;
      return `<tr><td style="background:${s.bg};color:${s.color};font-weight:bold;text-align:center;">${s.icon} ${s.label}</td><td style="text-align:center;">${v}</td><td style="text-align:center;">${total > 0 ? Math.round((v / total) * 100) : 0}%</td></tr>`;
    })
    .join('');

  // Findings table — with CVSS/CWE support
  const findingRows = findings
    .map((f) => {
      const s = SEV_STYLE[f.severity] || SEV_STYLE.info;
      return `<tr><td style="text-align:center;font-weight:600;">${escH(f.id)}</td><td style="background:${s.bg};color:${s.color};font-weight:bold;text-align:center;">${s.label}</td><td>${escH(f.title)}</td><td style="text-align:center;color:#3B82F6;">${escH(f.category)}</td>${f.cvss ? `<td style="text-align:center;">${f.cvss}</td>` : ''}</tr>`;
    })
    .join('');
  const hasCvss = findings.some((f) => f.cvss);

  // Detail for each finding
  const details = findings
    .map((f) => {
      const s = SEV_STYLE[f.severity] || SEV_STYLE.info;
      const metaInfo = [
        f.cvss ? `CVSS: ${f.cvss}` : '',
        f.cwe || '',
        f.location ? `위치: ${f.location}` : '',
      ]
        .filter(Boolean)
        .join(' | ');

      return `<h3 style="color:${s.color};margin-top:18pt;">${escH(f.id)} | [${s.label}] ${escH(f.title)}</h3>
    ${metaInfo ? `<p style="font-size:9pt;color:#6B7280;margin-bottom:4pt;">${escH(metaInfo)}</p>` : ''}
    <p>${escH(f.desc).replace(/\n/g, '<br>')}</p>
    ${f.risk ? `<p style="background:#FEF2F2;border:1px solid #FECACA;padding:6px 10px;border-radius:4px;margin:6pt 0;"><b style="color:#DC2626;">⚠️ 위험성:</b> ${escH(f.risk)}</p>` : ''}
    ${f.reco ? `<p style="background:#F0FDF4;border:1px solid #BBF7D0;padding:6px 10px;border-radius:4px;margin:6pt 0;"><b style="color:#15803D;">✅ 수정 방안:</b> ${escH(f.reco)}</p>` : ''}`;
    })
    .join('\n');

  // Recommendations summary
  const recoFindings = findings.filter((f) => f.reco);
  const recoSection =
    recoFindings.length > 0
      ? `<table><thead><tr><th>우선순위</th><th>ID</th><th>항목</th><th>조치사항</th></tr></thead><tbody>
${recoFindings
  .sort(
    (a, b) =>
      ['critical', 'high', 'medium', 'low', 'info'].indexOf(a.severity) -
      ['critical', 'high', 'medium', 'low', 'info'].indexOf(b.severity),
  )
  .map((f) => {
    const s = SEV_STYLE[f.severity] || SEV_STYLE.info;
    return `<tr><td style="background:${s.bg};color:${s.color};font-weight:bold;text-align:center;">${s.label}</td><td style="font-weight:600;">${escH(f.id)}</td><td>${escH(f.title)}</td><td style="color:#059669;">${escH(f.reco)}</td></tr>`;
  })
  .join('')}</tbody></table>`
      : '<p style="color:#6B7280;">명시적 권고 조치가 추출되지 않았습니다.</p>';

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8"><meta name="ProgId" content="Word.Document"><meta name="Generator" content="Metis.AI">
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
@page{size:A4;margin:2cm;}
body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;font-size:11pt;color:#1a1a1a;line-height:1.6;}
h1{font-size:22pt;color:#1E3A5F;border-bottom:3px solid #2563EB;padding-bottom:8pt;margin-bottom:6pt;}
h2{font-size:14pt;color:#1E3A5F;margin-top:18pt;border-left:4px solid #2563EB;padding-left:8pt;}
h3{font-size:11pt;color:#374151;margin-top:12pt;}
table{border-collapse:collapse;width:100%;margin:8pt 0;}
td,th{border:1px solid #D1D5DB;padding:6px 10px;font-size:10pt;}
th{background:#1E3A5F;color:white;font-weight:bold;text-align:center;}
.summary-box{background:#EFF6FF;border:1px solid #BFDBFE;padding:12pt;border-radius:6px;margin:10pt 0;}
.meta{color:#6B7280;font-size:9pt;margin-bottom:16pt;}
code,pre{font-family:Consolas,'D2Coding',monospace;font-size:9pt;background:#F1F5F9;padding:4px;border:1px solid #E2E8F0;border-radius:3px;}
</style></head><body><div class="Section1">
<h1>📊 ${escH(title)}</h1>
${project ? `<p style="font-size:13pt;color:#6B7280;margin-bottom:4pt;">${escH(project)}</p>` : ''}
<p class="meta">생성일시: ${genDate} | Metis.AI AgentOps Governance Platform</p>
<div style="border:2px solid #2563EB;height:0;margin:12pt 0;"></div>

<h2>📋 경영진 요약 (Executive Summary)</h2>
<div class="summary-box">
<p>본 분석에서 총 <b>${total}개</b>의 항목이 발견되었으며, 전체 위험 점수는 <b style="color:${riskScore >= 70 ? '#DC2626' : riskScore >= 40 ? '#CA8A04' : '#10B981'};">${riskScore}점/100점</b>으로 <b>${riskScore >= 70 ? '높은 위험 수준' : riskScore >= 40 ? '주의가 필요한 수준' : '양호한 수준'}</b>입니다.</p>
${urgentCount > 0 ? `<p style="margin-top:6pt;">⚠ <b style="color:#DC2626;">즉시 조치가 필요한 심각/높음 등급 항목: ${urgentCount}건</b></p>` : ''}
</div>

<h2>📊 심각도 분포</h2>
<table><thead><tr><th>심각도</th><th>건수</th><th>비율</th></tr></thead><tbody>${statsRows}</tbody></table>

<h2>🔍 발견 항목 목록</h2>
<table><thead><tr><th style="width:10%;">ID</th><th style="width:12%;">심각도</th><th>항목명</th><th style="width:15%;">카테고리</th>${hasCvss ? '<th style="width:10%;">CVSS</th>' : ''}</tr></thead><tbody>${findingRows}</tbody></table>

<h2>📄 발견 항목 상세</h2>
${details}

<h2>✅ 권고 조치 요약 (Action Items)</h2>
${recoSection}

<div style="border-top:1px solid #E5E7EB;margin-top:24pt;padding-top:8pt;text-align:center;color:#9CA3AF;font-size:9pt;">
이 보고서는 <b>Metis.AI</b> AgentOps Governance Platform에 의해 자동 생성되었습니다.<br>생성일시: ${genDate}
</div></div></body></html>`;
}

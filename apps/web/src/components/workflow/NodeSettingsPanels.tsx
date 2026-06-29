'use client';

import { useState, useRef, useCallback } from 'react';
import { storePendingFiles } from '@/lib/pending-file-store';
import { api } from '@/lib/api-client';
import { ModelSelect } from '@/lib/useModelOptions';
import {
  escH as _escH,
  parseFindings as _parseFindings,
  SEV_STYLE as _SEV_STYLE,
  buildProfessionalHtmlReport,
  buildProfessionalWordDoc,
} from '@/lib/report-utils';

// ── Lightweight ZIP Central Directory parser (no external deps) ──
// Reads the End of Central Directory record to find file entries.
async function parseZipEntries(file: File): Promise<Array<{ name: string; size: number }>> {
  const entries: Array<{ name: string; size: number }> = [];
  try {
    const buffer = await file.arrayBuffer();
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Find End of Central Directory signature (0x06054b50) from the end
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) return entries;

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdEntries = view.getUint16(eocdOffset + 10, true);

    let pos = cdOffset;
    const decoder = new TextDecoder('utf-8');
    for (let i = 0; i < cdEntries && pos < bytes.length - 46; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break; // Central directory file header
      const uncompressedSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const name = decoder.decode(bytes.slice(pos + 46, pos + 46 + nameLen));
      if (!name.endsWith('/')) {
        // Skip directories
        entries.push({ name, size: uncompressedSize });
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
  } catch (e) {
    console.warn('ZIP parsing failed:', e);
  }
  return entries;
}

// ═══════════════════════════════════════════════════════════════════
// Rich Node Settings Panels
// ═══════════════════════════════════════════════════════════════════
// Each node type gets a purpose-built, UX-focused settings panel
// instead of generic key-value text inputs.
// ═══════════════════════════════════════════════════════════════════

// ── Shared Types ──

interface NodeSettings {
  [key: string]: any;
}

interface PanelProps {
  nodeId: string;
  settings: NodeSettings;
  onUpdate: (nodeId: string, patch: { settings: NodeSettings }) => void;
  nodeName: string;
}

// ── Shared UI Primitives ──

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-semibold text-gray-700 mb-1.5">{children}</label>;
}

function HelpText({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] text-gray-400 mt-0.5">{children}</p>;
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${ok ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
    >
      {ok ? '✓' : '○'} {label}
    </span>
  );
}

function PipelineBadge({
  icon,
  label,
  description,
}: {
  icon: string;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2 p-2 bg-gray-50 border border-gray-200 rounded-lg">
      <span className="text-lg flex-shrink-0">{icon}</span>
      <div>
        <p className="text-[11px] font-semibold text-gray-800">{label}</p>
        <p className="text-[10px] text-gray-500">{description}</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 1. FILE OPERATION — INPUT (소스 로딩)
// ═══════════════════════════════════════════════════════════════════
// Drag-and-drop zone, file browser, zip/tar support,
// file type auto-detection, upload progress

const SUPPORTED_ARCHIVES = [
  { ext: '.zip', label: 'ZIP', icon: '📦' },
  { ext: '.tar.gz', label: 'TAR.GZ', icon: '📦' },
  { ext: '.tar', label: 'TAR', icon: '📦' },
  { ext: '.7z', label: '7Z', icon: '📦' },
  { ext: '.rar', label: 'RAR', icon: '📦' },
];

const SOURCE_TYPES = [
  { key: 'local', icon: '💻', label: '로컬 파일', desc: 'PC에서 파일 또는 폴더를 업로드' },
  { key: 'git', icon: '🔗', label: 'Git 저장소', desc: 'GitHub, GitLab, Bitbucket URL' },
  { key: 'upload', icon: '☁️', label: '클라우드 스토리지', desc: 'S3, GCS, Azure Blob' },
  { key: 'api', icon: '🌐', label: 'API 엔드포인트', desc: 'REST API에서 소스 가져오기' },
];

interface UploadedFile {
  name: string;
  size: number;
  type: string;
  isArchive: boolean;
  status: 'uploading' | 'ready' | 'extracting' | 'extracted' | 'error';
  progress: number;
  extractedCount?: number;
}

function FileInputPanel({ nodeId, settings, onUpdate, nodeName }: PanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>(settings._uploadedFiles || []);
  const sourceType = settings.sourceType || 'local';

  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const rawFiles = Array.from(fileList);
      const newFiles: UploadedFile[] = rawFiles.map((f) => {
        const isArchive = SUPPORTED_ARCHIVES.some((a) => f.name.toLowerCase().endsWith(a.ext));
        return {
          name: f.name,
          size: f.size,
          type: f.type || (isArchive ? 'application/archive' : 'text/plain'),
          isArchive,
          status: 'ready' as const,
          progress: 100,
        };
      });
      const updated = [...files, ...newFiles];
      setFiles(updated);
      updateSettings({ _uploadedFiles: updated, sourceReady: true });

      // Store actual File objects for backend upload during pipeline execution
      storePendingFiles(nodeId, rawFiles);

      // Parse ZIP files to extract archive entry metadata for downstream analysis
      for (const f of rawFiles) {
        if (/\.(zip)$/i.test(f.name)) {
          parseZipEntries(f)
            .then((entries) => {
              if (entries.length > 0) {
                updateSettings({
                  _archiveEntries: entries,
                  _archiveParsed: true,
                  sourcePath: f.name,
                });
              }
            })
            .catch(() => {
              /* ignore parse errors */
            });
        }
      }
    },
    [files, updateSettings, nodeId],
  );

  const removeFile = useCallback(
    (idx: number) => {
      const updated = files.filter((_, i) => i !== idx);
      setFiles(updated);
      updateSettings({ _uploadedFiles: updated, sourceReady: updated.length > 0 });
    },
    [files, updateSettings],
  );

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-4">
      {/* Source Type Selector */}
      <div>
        <SectionLabel>소스 유형</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {SOURCE_TYPES.map((st) => (
            <button
              key={st.key}
              onClick={() => updateSettings({ sourceType: st.key })}
              className={`p-2 rounded-lg border text-left transition ${
                sourceType === st.key
                  ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm">{st.icon}</span>
                <span className="text-[11px] font-semibold text-gray-800">{st.label}</span>
              </div>
              <p className="text-[9px] text-gray-500 mt-0.5">{st.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Local File: Drag & Drop Zone */}
      {sourceType === 'local' && (
        <div>
          <SectionLabel>파일 업로드</SectionLabel>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
              dragOver
                ? 'border-blue-400 bg-blue-50 scale-[1.02]'
                : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".zip,.tar,.tar.gz,.7z,.rar,.js,.ts,.jsx,.tsx,.py,.java,.c,.cpp,.cs,.go,.rb,.php,.swift,.kt,.rs,.vue,.svelte,.html,.css,.scss"
              onChange={(e) => handleFiles(e.target.files)}
              className="hidden"
            />
            <div className="text-3xl mb-2">{dragOver ? '📥' : '📂'}</div>
            <p className="text-sm font-semibold text-gray-700">
              {dragOver ? '여기에 놓으세요!' : '파일을 드래그하거나 클릭하여 선택'}
            </p>
            <p className="text-[10px] text-gray-400 mt-1">
              소스코드 파일 또는 압축 파일 (ZIP, TAR.GZ, 7Z, RAR)
            </p>
            <div className="flex justify-center gap-2 mt-3">
              {SUPPORTED_ARCHIVES.slice(0, 4).map((a) => (
                <span
                  key={a.ext}
                  className="px-2 py-0.5 bg-gray-100 rounded text-[9px] font-mono text-gray-600"
                >
                  {a.ext}
                </span>
              ))}
            </div>
          </div>

          {/* Uploaded Files List */}
          {files.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-gray-600">
                  {files.length}개 파일
                </span>
                <span className="text-[10px] text-gray-400">
                  총 {formatSize(files.reduce((sum, f) => sum + f.size, 0))}
                </span>
              </div>
              {files.map((f, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 p-2 bg-white border border-gray-200 rounded-lg group"
                >
                  <span className="text-sm flex-shrink-0">{f.isArchive ? '📦' : '📄'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium text-gray-800 truncate">{f.name}</p>
                    <p className="text-[9px] text-gray-400">{formatSize(f.size)}</p>
                  </div>
                  {f.isArchive && (
                    <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[9px] font-semibold rounded">
                      압축파일
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(idx);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition text-sm"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Archive Options */}
          {files.some((f) => f.isArchive) && (
            <div className="mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-[11px] font-semibold text-amber-700 mb-1.5">📦 압축 파일 설정</p>
              <label className="flex items-center gap-2 mb-1.5">
                <input
                  type="checkbox"
                  checked={settings.autoExtract !== false}
                  onChange={(e) => updateSettings({ autoExtract: e.target.checked })}
                  className="w-3.5 h-3.5 accent-amber-600"
                />
                <span className="text-[11px] text-amber-800">자동 압축 해제 후 분석</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings.scanSubdirs !== false}
                  onChange={(e) => updateSettings({ scanSubdirs: e.target.checked })}
                  className="w-3.5 h-3.5 accent-amber-600"
                />
                <span className="text-[11px] text-amber-800">하위 폴더 전체 포함</span>
              </label>
            </div>
          )}

          {/* File Filter */}
          <div className="mt-3">
            <SectionLabel>분석 대상 파일 확장자 (선택)</SectionLabel>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {[
                '*.js',
                '*.ts',
                '*.py',
                '*.java',
                '*.go',
                '*.c',
                '*.cpp',
                '*.cs',
                '*.php',
                '*.rb',
              ].map((ext) => {
                const selected = (settings.fileFilters || []).includes(ext);
                return (
                  <button
                    key={ext}
                    onClick={() => {
                      const current: string[] = settings.fileFilters || [];
                      const updated = selected
                        ? current.filter((e) => e !== ext)
                        : [...current, ext];
                      updateSettings({ fileFilters: updated });
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition ${
                      selected
                        ? 'bg-blue-100 text-blue-700 border border-blue-300'
                        : 'bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {ext}
                  </button>
                );
              })}
            </div>
            <HelpText>선택하지 않으면 모든 소스 파일을 포함합니다</HelpText>
          </div>
        </div>
      )}

      {/* Git Source */}
      {sourceType === 'git' && (
        <div className="space-y-3">
          <div>
            <SectionLabel>Git 저장소 URL</SectionLabel>
            <input
              type="text"
              value={settings.gitUrl || ''}
              onChange={(e) => updateSettings({ gitUrl: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="https://github.com/user/repo.git"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <SectionLabel>브랜치</SectionLabel>
              <input
                type="text"
                value={settings.gitBranch || 'main'}
                onChange={(e) => updateSettings({ gitBranch: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                placeholder="main"
              />
            </div>
            <div>
              <SectionLabel>접근 토큰</SectionLabel>
              <input
                type="password"
                value={settings.gitToken || ''}
                onChange={(e) => updateSettings({ gitToken: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                placeholder="ghp_..."
              />
            </div>
          </div>
          <div>
            <SectionLabel>대상 경로 (선택)</SectionLabel>
            <input
              type="text"
              value={settings.gitPath || ''}
              onChange={(e) => updateSettings({ gitPath: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="src/ (빈 값이면 전체)"
            />
          </div>
          {settings.gitUrl && (
            <button className="w-full px-3 py-2 bg-gray-900 text-white text-[11px] font-semibold rounded-lg hover:bg-gray-800 transition flex items-center justify-center gap-2">
              <span>🔗</span> 저장소 연결 테스트
            </button>
          )}
        </div>
      )}

      {/* Cloud Storage */}
      {sourceType === 'upload' && (
        <div className="space-y-3">
          <div>
            <SectionLabel>클라우드 서비스</SectionLabel>
            <select
              value={settings.cloudProvider || 's3'}
              onChange={(e) => updateSettings({ cloudProvider: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            >
              <option value="s3">Amazon S3</option>
              <option value="gcs">Google Cloud Storage</option>
              <option value="azure">Azure Blob Storage</option>
              <option value="minio">MinIO (Self-hosted)</option>
            </select>
          </div>
          <div>
            <SectionLabel>버킷 / 컨테이너 경로</SectionLabel>
            <input
              type="text"
              value={settings.cloudPath || ''}
              onChange={(e) => updateSettings({ cloudPath: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="s3://my-bucket/source-code/"
            />
          </div>
        </div>
      )}

      {/* API Endpoint */}
      {sourceType === 'api' && (
        <div className="space-y-3">
          <div>
            <SectionLabel>API 엔드포인트</SectionLabel>
            <input
              type="text"
              value={settings.apiUrl || ''}
              onChange={(e) => updateSettings({ apiUrl: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="https://api.example.com/v1/source"
            />
          </div>
          <div>
            <SectionLabel>인증 헤더</SectionLabel>
            <input
              type="password"
              value={settings.apiAuthHeader || ''}
              onChange={(e) => updateSettings({ apiAuthHeader: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="Bearer token..."
            />
          </div>
        </div>
      )}

      {/* ── Validation Status ── */}
      {sourceType === 'local' && files.length === 0 && (
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-start gap-2">
          <span className="text-lg flex-shrink-0">⚠️</span>
          <div>
            <p className="text-[11px] font-bold text-amber-800">
              파일을 업로드해야 실행할 수 있습니다
            </p>
            <p className="text-[9px] text-amber-600 mt-0.5">
              위의 드래그 영역에 소스코드 파일이나 압축파일을 넣어주세요. 업로드 없이 실행하면 이
              노드에서 오류가 발생합니다.
            </p>
          </div>
        </div>
      )}
      {sourceType === 'git' && !settings.gitUrl && (
        <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-start gap-2">
          <span className="text-lg flex-shrink-0">⚠️</span>
          <div>
            <p className="text-[11px] font-bold text-amber-800">
              Git 저장소 URL을 입력해야 실행할 수 있습니다
            </p>
            <p className="text-[9px] text-amber-600 mt-0.5">
              저장소 주소를 입력하고 연결 테스트를 먼저 해주세요.
            </p>
          </div>
        </div>
      )}

      {/* ── Readiness Indicator ── */}
      <div
        className={`mt-2 p-2.5 rounded-lg border flex items-center gap-2 ${
          (sourceType === 'local' && files.length > 0) || (sourceType === 'git' && settings.gitUrl)
            ? 'bg-green-50 border-green-300'
            : 'bg-gray-50 border-gray-200'
        }`}
      >
        <span className="text-lg">
          {(sourceType === 'local' && files.length > 0) || (sourceType === 'git' && settings.gitUrl)
            ? '✅'
            : '⏳'}
        </span>
        <div>
          <p
            className={`text-[10px] font-semibold ${
              (sourceType === 'local' && files.length > 0) ||
              (sourceType === 'git' && settings.gitUrl)
                ? 'text-green-700'
                : 'text-gray-500'
            }`}
          >
            {sourceType === 'local' && files.length > 0
              ? `실행 준비 완료 — ${files.length}개 파일 (${formatSize(files.reduce((s, f) => s + f.size, 0))})`
              : sourceType === 'git' && settings.gitUrl
                ? `실행 준비 완료 — ${settings.gitUrl.split('/').pop()}`
                : '소스를 준비해주세요'}
          </p>
          <p className="text-[9px] text-gray-400">이 노드의 결과가 다음 분석 노드에 전달됩니다</p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 2. FILE OPERATION — OUTPUT (파일 생성/다운로드)
// ═══════════════════════════════════════════════════════════════════

const OUTPUT_FORMATS = [
  { key: 'docx', label: 'Word', icon: '📝', ext: '.docx', desc: 'Microsoft Word 문서' },
  { key: 'pdf', label: 'PDF', icon: '📕', ext: '.pdf', desc: 'PDF 문서' },
  { key: 'xlsx', label: 'Excel', icon: '📊', ext: '.xlsx', desc: 'Excel 스프레드시트' },
  { key: 'html', label: 'HTML', icon: '🌐', ext: '.html', desc: 'HTML 리포트' },
  { key: 'csv', label: 'CSV', icon: '📋', ext: '.csv', desc: 'CSV 데이터' },
  { key: 'json', label: 'JSON', icon: '📄', ext: '.json', desc: 'JSON 데이터' },
  { key: 'md', label: 'Markdown', icon: '📑', ext: '.md', desc: 'Markdown 문서' },
];

const REPORT_TEMPLATES = [
  { key: 'security-audit', label: '보안 감사 보고서', desc: '취약점, 위험도, 권고사항 포함' },
  { key: 'code-review', label: '코드 리뷰 보고서', desc: '코드 품질, 개선점, 통계' },
  { key: 'executive-summary', label: '경영진 요약', desc: '핵심 지표, 결론, 조치사항' },
  { key: 'technical-detail', label: '기술 상세 보고서', desc: '전체 분석 결과, 코드 참조' },
  { key: 'custom', label: '사용자 정의', desc: '직접 템플릿 작성' },
];

// ── Professional Report Generators — imported from @/lib/report-utils ──
// escH, parseFindings, SEV_STYLE, buildProfessionalHtmlReport, buildProfessionalWordDoc
// are imported at the top of this file.

// Keep local aliases for backward compatibility within this file
const escH = _escH;
const parseFindings = _parseFindings;
const SEV_STYLE = _SEV_STYLE;

function FileOutputPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const [showPreview, setShowPreview] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const selectedFormat = settings.outputFormat || 'docx';
  const selectedTpl = settings.reportTemplate || 'security-audit';
  const fmtInfo = OUTPUT_FORMATS.find((f) => f.key === selectedFormat);
  const tplInfo = REPORT_TEMPLATES.find((t) => t.key === selectedTpl);

  // Check if there's upstream pipeline data available
  const hasPipelineData = !!(settings._pipelinePreview || settings._lastExecutionOutput);
  const previewContent = settings._pipelinePreview || settings._lastExecutionOutput || '';

  // Generate and download file from pipeline data
  const handleDownload = useCallback(() => {
    const content = settings._lastExecutionOutput || settings._pipelinePreview || '';
    if (!content) return;

    setIsGenerating(true);
    const timestamp = new Date().toISOString().slice(0, 10);
    const baseName = settings.fileNamePattern || 'metis-report';
    const fileName = settings.includeTimestamp !== false ? `${baseName}-${timestamp}` : baseName;

    try {
      let blob: Blob;
      let ext: string;

      if (selectedFormat === 'html') {
        const htmlDoc = buildProfessionalHtmlReport(
          content,
          tplInfo?.label || '분석 보고서',
          settings.projectName || '',
        );
        blob = new Blob([htmlDoc], { type: 'text/html;charset=utf-8' });
        ext = '.html';
      } else if (selectedFormat === 'csv') {
        blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
        ext = '.csv';
      } else if (selectedFormat === 'pdf') {
        // For PDF, generate an HTML that auto-prints
        const pdfHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${tplInfo?.label || 'Report'}</title><style>@media print{body{margin:0}}body{font-family:'Segoe UI',sans-serif;max-width:700px;margin:20px auto;padding:20px;font-size:12px;line-height:1.5}h1{font-size:18px;color:#1e40af}pre{white-space:pre-wrap;font-size:11px}</style><script>window.onload=function(){window.print()}<\/script></head><body><h1>${tplInfo?.label || '분석 보고서'}</h1><p style="color:#888;font-size:11px;">Metis.AI | ${new Date().toLocaleString('ko-KR')}</p><div>${content.replace(/\n/g, '<br>')}</div></body></html>`;
        blob = new Blob([pdfHtml], { type: 'text/html;charset=utf-8' });
        ext = '.html'; // Opens in browser for print-to-PDF
      } else if (selectedFormat === 'docx') {
        // Word ML (MHTML) format — opens natively in MS Word, professional formatting
        const wordDoc = buildProfessionalWordDoc(
          content,
          tplInfo?.label || '분석 보고서',
          settings.projectName || '',
        );
        blob = new Blob([wordDoc], { type: 'application/msword' });
        ext = '.doc';
      } else {
        // xlsx, json, md 등 — plain text fallback
        const header = `${tplInfo?.label || '분석 보고서'}\n생성: ${new Date().toLocaleString('ko-KR')} | Metis.AI\n${'═'.repeat(50)}\n\n`;
        blob = new Blob([header + content], { type: 'text/plain;charset=utf-8' });
        ext = fmtInfo?.ext || '.txt';
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setIsGenerating(false);
    }
  }, [settings, selectedFormat, tplInfo]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-[11px] font-bold text-blue-800 mb-0.5">
          📄 분석 결과를 문서로 만들어 다운로드할 수 있게 합니다
        </p>
        <p className="text-[9px] text-blue-600">
          이전 노드(보안점검, 모의해킹 등)의 결과가 자동으로 이 문서에 포함됩니다.
        </p>
      </div>

      {/* Output Format — 카드 선택 */}
      <div>
        <SectionLabel>문서 형식 선택</SectionLabel>
        <div className="grid grid-cols-4 gap-1.5">
          {OUTPUT_FORMATS.map((fmt) => (
            <button
              key={fmt.key}
              onClick={() =>
                updateSettings({ outputFormat: fmt.key, outputFormatLabel: fmt.label })
              }
              className={`p-2.5 rounded-lg border text-center transition ${
                selectedFormat === fmt.key
                  ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <span className="text-xl block">{fmt.icon}</span>
              <span className="text-[10px] font-bold text-gray-700 block mt-0.5">{fmt.label}</span>
              <span className="text-[8px] text-gray-400 block">{fmt.ext}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Report Template — 카드 선택 */}
      <div>
        <SectionLabel>보고서 유형</SectionLabel>
        <div className="space-y-1.5">
          {REPORT_TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              onClick={() => updateSettings({ reportTemplate: tpl.key })}
              className={`w-full p-2.5 rounded-lg border text-left transition flex items-center gap-3 ${
                selectedTpl === tpl.key
                  ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  selectedTpl === tpl.key ? 'border-blue-500 bg-blue-500' : 'border-gray-300'
                }`}
              >
                {selectedTpl === tpl.key && <span className="text-white text-[10px]">✓</span>}
              </div>
              <div>
                <p className="text-[11px] font-semibold text-gray-800">{tpl.label}</p>
                <p className="text-[9px] text-gray-500">{tpl.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 다운로드 옵션 */}
      <div>
        <SectionLabel>다운로드 설정</SectionLabel>
        <div className="space-y-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <label className="flex items-center gap-2.5 p-2 bg-white rounded-lg border border-gray-200 cursor-pointer hover:border-blue-300 transition">
            <input
              type="checkbox"
              checked={settings.downloadable !== false}
              onChange={(e) => updateSettings({ downloadable: e.target.checked })}
              className="w-4 h-4 accent-blue-600"
            />
            <div>
              <span className="text-[11px] font-semibold text-gray-700">
                실행 완료 시 자동 다운로드
              </span>
              <p className="text-[9px] text-gray-400">
                워크플로우 실행이 끝나면 바로 파일을 받을 수 있습니다
              </p>
            </div>
          </label>
          <label className="flex items-center gap-2.5 p-2 bg-white rounded-lg border border-gray-200 cursor-pointer hover:border-blue-300 transition">
            <input
              type="checkbox"
              checked={settings.includeTimestamp !== false}
              onChange={(e) => updateSettings({ includeTimestamp: e.target.checked })}
              className="w-4 h-4 accent-blue-600"
            />
            <div>
              <span className="text-[11px] font-semibold text-gray-700">
                파일명에 날짜/시간 포함
              </span>
              <p className="text-[9px] text-gray-400">report-2026-04-17.docx 형태로 생성됩니다</p>
            </div>
          </label>
        </div>
      </div>

      {/* ── 문서 미리보기 + 실제 다운로드 ── */}
      <div className="p-3 bg-white border border-gray-300 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-bold text-gray-700">📎 생성될 문서</p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setShowPreview(!showPreview)}
              className="px-2.5 py-1 bg-blue-100 text-blue-700 text-[10px] font-semibold rounded hover:bg-blue-200 transition"
            >
              {showPreview ? '닫기' : '📋 미리보기'}
            </button>
            {hasPipelineData && (
              <button
                type="button"
                onClick={handleDownload}
                disabled={isGenerating}
                className="px-2.5 py-1 bg-blue-600 text-white text-[10px] font-semibold rounded hover:bg-blue-700 transition disabled:opacity-50"
              >
                {isGenerating ? '생성 중...' : `⬇ ${fmtInfo?.label || ''} 다운로드`}
              </button>
            )}
          </div>
        </div>

        {/* 파일 카드 */}
        <div className="flex items-center gap-3 p-2.5 bg-gray-50 rounded-lg border border-gray-200">
          <span className="text-2xl">{fmtInfo?.icon || '📄'}</span>
          <div className="flex-1">
            <p className="text-[12px] font-semibold text-gray-800">
              {settings.fileNamePattern || 'metis-report'}
              {settings.includeTimestamp !== false
                ? `-${new Date().toISOString().slice(0, 10)}`
                : ''}
              {fmtInfo?.ext || '.docx'}
            </p>
            <p className="text-[9px] text-gray-500">
              {tplInfo?.label || '보안 감사 보고서'} · {fmtInfo?.desc}
            </p>
          </div>
          <span
            className={`px-2 py-0.5 text-[9px] font-semibold rounded ${hasPipelineData ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}
          >
            {hasPipelineData ? '✓ 데이터 준비됨' : '⏳ 실행 대기'}
          </span>
        </div>

        {/* 미리보기 — 실행 전/후 다른 내용 */}
        {showPreview && (
          <div className="mt-2 p-3 bg-white border border-gray-300 rounded-lg max-h-[250px] overflow-y-auto">
            <div className="text-center mb-3 pb-2 border-b border-gray-200">
              <p className="text-[13px] font-bold text-gray-800">
                {tplInfo?.label || '보안 감사 보고서'}
              </p>
              <p className="text-[9px] text-gray-400">
                생성일시: {new Date().toLocaleString('ko-KR')} | Metis.AI
              </p>
            </div>

            {hasPipelineData ? (
              /* 실행 후: 실제 파이프라인 데이터 미리보기 */
              <div className="text-[10px] text-gray-700 whitespace-pre-wrap break-words font-mono bg-gray-50 p-2 rounded">
                {previewContent.length > 2000
                  ? previewContent.substring(0, 2000) +
                    '\n\n... (이하 생략, 전체 내용은 다운로드 파일에 포함)'
                  : previewContent}
              </div>
            ) : (
              /* 실행 전: 보고서 구조 미리보기 */
              <div className="text-[10px] text-gray-600 space-y-2">
                <div className="p-2 bg-amber-50 border border-amber-200 rounded text-[9px] text-amber-700 mb-2">
                  워크플로우를 실행하면 이전 노드의 실제 분석 결과가 아래 구조에 채워집니다.
                </div>
                {selectedTpl === 'security-audit' && (
                  <>
                    <p className="font-bold text-gray-700">1. 경영진 요약</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      이전 노드의 보안 분석 결과 요약이 여기에 삽입됩니다
                    </p>
                    <p className="font-bold text-gray-700">2. 취약점 상세 목록</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      CVSS 스코어, CWE 분류, 위험도별 정렬
                    </p>
                    <p className="font-bold text-gray-700">3. 수정 권고사항</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      우선순위별 수정 가이드 및 코드 예시
                    </p>
                  </>
                )}
                {selectedTpl === 'code-review' && (
                  <>
                    <p className="font-bold text-gray-700">1. 코드 품질 개요</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      언어별 통계, 복잡도 분석
                    </p>
                    <p className="font-bold text-gray-700">2. 개선 포인트</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      리팩토링 대상, 코드 스멜
                    </p>
                  </>
                )}
                {selectedTpl === 'executive-summary' && (
                  <>
                    <p className="font-bold text-gray-700">핵심 결론</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      1-2문장 요약, KPI, 조치사항
                    </p>
                  </>
                )}
                {selectedTpl === 'technical-detail' && (
                  <>
                    <p className="font-bold text-gray-700">1. 분석 방법론</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      사용된 스캐너, AI 모델, 진단 범위
                    </p>
                    <p className="font-bold text-gray-700">2. 전체 분석 결과</p>
                    <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                      코드 참조 포함 상세 결과
                    </p>
                  </>
                )}
                {selectedTpl === 'custom' && (
                  <p className="text-gray-400 pl-3 border-l-2 border-blue-200">
                    사용자 정의 템플릿에 따라 생성됩니다
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 안내 */}
      {!hasPipelineData && (
        <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
          <span className="text-lg flex-shrink-0">💡</span>
          <div>
            <p className="text-[10px] font-semibold text-amber-700">워크플로우를 실행하세요</p>
            <p className="text-[9px] text-amber-600 mt-0.5">
              상단의 <strong>▶ 실행</strong> 버튼을 누르면 이전 노드의 결과가 이 문서에 자동으로
              포함되고, 실제 다운로드 버튼이 활성화됩니다.
            </p>
          </div>
        </div>
      )}
      {hasPipelineData && (
        <div className="p-2.5 bg-green-50 border border-green-200 rounded-lg flex items-start gap-2">
          <span className="text-lg flex-shrink-0">✅</span>
          <div>
            <p className="text-[10px] font-semibold text-green-700">결과 데이터가 준비되었습니다</p>
            <p className="text-[9px] text-green-600 mt-0.5">
              위의 <strong>⬇ 다운로드</strong> 버튼을 클릭하면 {fmtInfo?.label || '문서'} 파일을
              바로 받을 수 있습니다.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 3. AI PROCESSING — INSPECTION (보안점검/분석)
// ═══════════════════════════════════════════════════════════════════

const SECURITY_SCANNERS = [
  {
    key: 'sast',
    icon: '🔍',
    label: 'SAST',
    desc: '정적 분석 (코드 레벨 취약점)',
    severity: 'high',
  },
  { key: 'dast', icon: '🌐', label: 'DAST', desc: '동적 분석 (런타임 취약점)', severity: 'high' },
  { key: 'sca', icon: '📦', label: 'SCA', desc: '의존성 취약점 분석', severity: 'medium' },
  {
    key: 'secrets',
    icon: '🔑',
    label: 'Secret Scan',
    desc: '하드코딩된 비밀키/토큰 탐지',
    severity: 'critical',
  },
  {
    key: 'pentest',
    icon: '⚔️',
    label: '모의 해킹',
    desc: '침투 테스트 시뮬레이션',
    severity: 'critical',
  },
  {
    key: 'license',
    icon: '📜',
    label: '라이선스',
    desc: '오픈소스 라이선스 규정 점검',
    severity: 'low',
  },
];

const SEVERITY_LEVELS = [
  { key: 'critical', label: '치명적', color: 'bg-red-500' },
  { key: 'high', label: '높음', color: 'bg-orange-500' },
  { key: 'medium', label: '중간', color: 'bg-yellow-500' },
  { key: 'low', label: '낮음', color: 'bg-blue-500' },
  { key: 'info', label: '정보', color: 'bg-gray-400' },
];

function InspectionPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const selectedScanners: string[] = settings.scanners || ['sast', 'secrets'];
  const minSeverity = settings.minSeverity || 'low';

  const toggleScanner = (key: string) => {
    const updated = selectedScanners.includes(key)
      ? selectedScanners.filter((s) => s !== key)
      : [...selectedScanners, key];
    updateSettings({ scanners: updated });
  };

  return (
    <div className="space-y-4">
      {/* Scanner Selection */}
      <div>
        <SectionLabel>점검 도구 선택</SectionLabel>
        <div className="space-y-1.5">
          {SECURITY_SCANNERS.map((scanner) => {
            const selected = selectedScanners.includes(scanner.key);
            return (
              <button
                key={scanner.key}
                onClick={() => toggleScanner(scanner.key)}
                className={`w-full p-2.5 rounded-lg border text-left transition flex items-center gap-2.5 ${
                  selected
                    ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <span className="text-lg flex-shrink-0">{scanner.icon}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold text-gray-800">{scanner.label}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase text-white ${
                        scanner.severity === 'critical'
                          ? 'bg-red-500'
                          : scanner.severity === 'high'
                            ? 'bg-orange-500'
                            : scanner.severity === 'medium'
                              ? 'bg-yellow-500'
                              : 'bg-blue-500'
                      }`}
                    >
                      {scanner.severity}
                    </span>
                  </div>
                  <p className="text-[9px] text-gray-500">{scanner.desc}</p>
                </div>
                <div
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${
                    selected ? 'border-blue-500 bg-blue-500' : 'border-gray-300'
                  }`}
                >
                  {selected && <span className="text-white text-xs">✓</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Minimum Severity */}
      <div>
        <SectionLabel>최소 리포트 등급</SectionLabel>
        <div className="flex gap-1.5">
          {SEVERITY_LEVELS.map((level) => (
            <button
              key={level.key}
              onClick={() => updateSettings({ minSeverity: level.key })}
              className={`flex-1 px-2 py-1.5 rounded-lg border text-center transition ${
                minSeverity === level.key
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <div className={`w-2.5 h-2.5 rounded-full ${level.color} mx-auto mb-0.5`} />
              <span className="text-[9px] font-semibold text-gray-700">{level.label}</span>
            </button>
          ))}
        </div>
        <HelpText>선택한 등급 이상의 결과만 보고서에 포함됩니다</HelpText>
      </div>

      {/* AI Model */}
      <div>
        <SectionLabel>분석 AI 모델</SectionLabel>
        <ModelSelect value={settings.model} onChange={(v) => updateSettings({ model: v })} />
      </div>

      {/* Custom Rules */}
      <div>
        <SectionLabel>추가 점검 규칙 (선택)</SectionLabel>
        <textarea
          value={settings.customRules || ''}
          onChange={(e) => updateSettings({ customRules: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          rows={3}
          placeholder="예: SQL Injection 패턴 중점 점검&#10;OWASP Top 10 기반 분석&#10;인증/인가 로직 집중 검토"
        />
      </div>

      {/* FinOps */}
      <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold text-blue-700">
            💰 FinOps 3-Gate 파이프라인
          </span>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={settings.finopsEnabled !== false}
              onChange={(e) => updateSettings({ finopsEnabled: e.target.checked })}
              className="w-3 h-3 accent-blue-600"
            />
            <span className="text-[9px] text-blue-600">활성화</span>
          </label>
        </div>
        {settings.finopsEnabled !== false && (
          <div className="flex gap-3">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.finopsCache !== false}
                onChange={(e) => updateSettings({ finopsCache: e.target.checked })}
                className="w-3 h-3 accent-green-600"
              />
              <span className="text-[9px] text-gray-600">Cache</span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.finopsRouter !== false}
                onChange={(e) => updateSettings({ finopsRouter: e.target.checked })}
                className="w-3 h-3 accent-purple-600"
              />
              <span className="text-[9px] text-gray-600">Router</span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.finopsPacker !== false}
                onChange={(e) => updateSettings({ finopsPacker: e.target.checked })}
                className="w-3 h-3 accent-orange-600"
              />
              <span className="text-[9px] text-gray-600">Packer</span>
            </label>
          </div>
        )}
      </div>

      {/* Pipeline Data Flow */}
      <div className="flex gap-2">
        <div className="flex-1 p-2 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-[10px] font-semibold text-green-700">📥 입력</p>
          <p className="text-[9px] text-green-600">소스 코드 / 파일</p>
        </div>
        <div className="flex-1 p-2 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-[10px] font-semibold text-blue-700">📤 출력</p>
          <p className="text-[9px] text-blue-600">취약점 목록 + 위험도</p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 3-B. AI PROCESSING — PENTEST (모의해킹 취약점 진단)
// ═══════════════════════════════════════════════════════════════════

const ATTACK_VECTORS = [
  {
    key: 'injection',
    icon: '💉',
    label: 'Injection 공격',
    desc: 'SQL/NoSQL/OS Command/LDAP/Template Injection',
    owasp: 'A03:2021',
  },
  {
    key: 'auth-bypass',
    icon: '🔓',
    label: '인증 우회 / 세션 공격',
    desc: 'JWT 조작, 세션 하이재킹, OAuth 결함, 2FA 우회',
    owasp: 'A07:2021',
  },
  {
    key: 'access-control',
    icon: '🛡️',
    label: '권한 상승 / 접근 제어',
    desc: 'IDOR, BOLA, 수직/수평 권한 상승, 멀티테넌트 격리',
    owasp: 'A01:2021',
  },
  {
    key: 'api-abuse',
    icon: '🔗',
    label: 'API 남용',
    desc: 'Rate Limiting, Mass Assignment, 정보 누출',
    owasp: 'A04:2021',
  },
  {
    key: 'file-attack',
    icon: '📁',
    label: '파일 업로드 / 경로 탐색',
    desc: '악성 업로드, Path Traversal, Zip Slip, LFI/RFI',
    owasp: 'A08:2021',
  },
  {
    key: 'ssrf-request',
    icon: '🌐',
    label: 'SSRF / 요청 위조',
    desc: 'SSRF, Open Redirect, XSS, CSRF',
    owasp: 'A10:2021',
  },
  {
    key: 'crypto-weakness',
    icon: '🔐',
    label: '암호화 / 시크릿 결함',
    desc: '취약 해시, 하드코딩 키, TLS 결함, 안전하지 않은 난수',
    owasp: 'A02:2021',
  },
  {
    key: 'business-logic',
    icon: '⚙️',
    label: '비즈니스 로직 결함',
    desc: 'Race Condition, 금액 조작, 상태머신 결함',
    owasp: 'A04:2021',
  },
];

const SCAN_MODES = [
  { key: 'auto', icon: '🤖', label: '자동 선택', desc: '소스 코드 정찰 후 관련 벡터 자동 선택' },
  { key: 'full', icon: '🔥', label: '전체 스캔', desc: '8개 공격 벡터 전체 진단 (시간 소요 큼)' },
  { key: 'quick', icon: '⚡', label: '빠른 스캔', desc: 'Injection, 인증, 접근제어 3개만 진단' },
  { key: 'custom', icon: '🎯', label: '직접 선택', desc: '아래에서 원하는 벡터 선택' },
];

function PentestPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const scanMode = settings.scanMode || 'auto';
  const selectedVectors: string[] = settings.attackVectors || [];

  const toggleVector = (key: string) => {
    const updated = selectedVectors.includes(key)
      ? selectedVectors.filter((v) => v !== key)
      : [...selectedVectors, key];
    updateSettings({ attackVectors: updated, scanMode: 'custom' });
  };

  const selectAllVectors = () => {
    updateSettings({ attackVectors: ATTACK_VECTORS.map((v) => v.key), scanMode: 'custom' });
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">⚔️</span>
          <span className="text-[12px] font-bold text-red-800">모의해킹 취약점 진단</span>
        </div>
        <p className="text-[9px] text-red-600 leading-relaxed">
          소스 코드를 8개 공격 벡터로 심층 분석합니다. CVSS 3.1 스코어링, CWE/OWASP 매핑, PoC
          시나리오, Kill Chain 분석을 포함한 종합 보고서를 생성합니다.
        </p>
      </div>

      {/* Scan Mode */}
      <div>
        <SectionLabel>스캔 모드</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {SCAN_MODES.map((mode) => (
            <button
              key={mode.key}
              onClick={() => updateSettings({ scanMode: mode.key })}
              className={`p-2 rounded-lg border text-left transition ${
                scanMode === mode.key
                  ? 'border-red-500 bg-red-50 ring-1 ring-red-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm">{mode.icon}</span>
                <span className="text-[10px] font-bold text-gray-800">{mode.label}</span>
              </div>
              <p className="text-[8px] text-gray-500 mt-0.5">{mode.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Attack Vector Selection (visible in custom mode, read-only in others) */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <SectionLabel>
            공격 벡터 (
            {scanMode === 'full'
              ? '8개 전체'
              : scanMode === 'quick'
                ? '3개'
                : scanMode === 'custom'
                  ? `${selectedVectors.length}개 선택`
                  : '자동 결정'}
            )
          </SectionLabel>
          {scanMode === 'custom' && (
            <button
              onClick={selectAllVectors}
              className="text-[9px] text-red-600 font-medium hover:underline"
            >
              전체 선택
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {ATTACK_VECTORS.map((vec) => {
            const isActive =
              scanMode === 'full' ||
              (scanMode === 'quick' &&
                ['injection', 'auth-bypass', 'access-control'].includes(vec.key));
            const isSelected = scanMode === 'custom' ? selectedVectors.includes(vec.key) : isActive;
            const isDisabled = scanMode !== 'custom';
            return (
              <button
                key={vec.key}
                onClick={() => !isDisabled && toggleVector(vec.key)}
                disabled={isDisabled}
                className={`w-full p-2.5 rounded-lg border text-left transition flex items-center gap-2.5 ${
                  isSelected
                    ? 'border-red-400 bg-red-50 ring-1 ring-red-200'
                    : isDisabled
                      ? 'border-gray-100 bg-gray-50 opacity-50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <span className="text-lg flex-shrink-0">{vec.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-gray-800">{vec.label}</span>
                    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-[7px] font-mono text-gray-500">
                      {vec.owasp}
                    </span>
                  </div>
                  <p className="text-[8px] text-gray-500 truncate">{vec.desc}</p>
                </div>
                <div
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                    isSelected ? 'border-red-500 bg-red-500' : 'border-gray-300'
                  }`}
                >
                  {isSelected && <span className="text-white text-xs">✓</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* AI Model */}
      <div>
        <SectionLabel>분석 AI 모델</SectionLabel>
        <ModelSelect
          value={settings.model}
          onChange={(v) => updateSettings({ model: v })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-red-500"
        />
      </div>

      {/* Advanced Options */}
      <div>
        <SectionLabel>상세 설정</SectionLabel>
        <div className="space-y-2">
          {/* Max Tokens per vector */}
          <div>
            <label className="text-[9px] text-gray-500 block mb-0.5">벡터당 최대 토큰</label>
            <select
              value={settings.maxTokens || 6000}
              onChange={(e) => updateSettings({ maxTokens: parseInt(e.target.value) })}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs"
            >
              <option value={3000}>3,000 (빠른 진단)</option>
              <option value={6000}>6,000 (권장)</option>
              <option value={8000}>8,000 (상세 진단)</option>
            </select>
          </div>

          {/* CVSS Threshold */}
          <div>
            <label className="text-[9px] text-gray-500 block mb-0.5">CVSS 리포트 임계값</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={10}
                step={0.1}
                value={settings.cvssThreshold || 0}
                onChange={(e) => updateSettings({ cvssThreshold: parseFloat(e.target.value) })}
                className="flex-1 h-1.5 accent-red-500"
              />
              <span className="text-[10px] font-mono font-bold text-gray-700 w-8 text-right">
                {(settings.cvssThreshold || 0).toFixed(1)}
              </span>
            </div>
            <HelpText>이 점수 이상의 취약점만 보고서에 포함 (0.0 = 전체)</HelpText>
          </div>

          {/* Synthesis Report */}
          <label className="flex items-center gap-2 p-2 bg-amber-50 border border-amber-200 rounded-lg">
            <input
              type="checkbox"
              checked={settings.generateSynthesis !== false}
              onChange={(e) => updateSettings({ generateSynthesis: e.target.checked })}
              className="w-3.5 h-3.5 accent-amber-600"
            />
            <div>
              <span className="text-[10px] font-semibold text-amber-800">종합 보고서 생성</span>
              <p className="text-[8px] text-amber-600">
                경영진 요약, Kill Chain 분석, 수정 로드맵 포함
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Pipeline Data Flow */}
      <div className="flex gap-2">
        <div className="flex-1 p-2 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-[10px] font-semibold text-green-700">📥 입력</p>
          <p className="text-[9px] text-green-600">소스 코드 (이전 노드)</p>
        </div>
        <div className="flex-1 p-2 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-[10px] font-semibold text-red-700">📤 출력</p>
          <p className="text-[9px] text-red-600">CVSS 스코어 + PoC + 수정안</p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 4. AI PROCESSING — SUMMARY (요약/정리)
// ═══════════════════════════════════════════════════════════════════

const SUMMARY_STYLES = [
  { key: 'executive', icon: '📊', label: '경영진 요약', desc: '핵심 결론, KPI, 조치사항 중심' },
  { key: 'technical', icon: '🔧', label: '기술 요약', desc: '상세 기술 분석 결과, 코드 참조 포함' },
  { key: 'bullet', icon: '📋', label: '핵심 요점', desc: '중요 항목 불릿포인트로 정리' },
  { key: 'narrative', icon: '📝', label: '서술형 리포트', desc: '전체 맥락을 설명하는 문서' },
];

function SummaryPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Summary Style */}
      <div>
        <SectionLabel>정리 스타일</SectionLabel>
        <div className="space-y-1.5">
          {SUMMARY_STYLES.map((style) => (
            <button
              key={style.key}
              onClick={() => updateSettings({ summaryStyle: style.key })}
              className={`w-full p-2.5 rounded-lg border text-left transition flex items-center gap-2.5 ${
                (settings.summaryStyle || 'technical') === style.key
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <span className="text-lg flex-shrink-0">{style.icon}</span>
              <div>
                <p className="text-[11px] font-semibold text-gray-800">{style.label}</p>
                <p className="text-[9px] text-gray-500">{style.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Focus Areas */}
      <div>
        <SectionLabel>집중 분석 영역 (선택)</SectionLabel>
        <textarea
          value={settings.focusAreas || ''}
          onChange={(e) => updateSettings({ focusAreas: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          rows={2}
          placeholder="예: 보안 취약점 우선, 성능 이슈 포함"
        />
      </div>

      {/* Output Language */}
      <div>
        <SectionLabel>출력 언어</SectionLabel>
        <select
          value={settings.outputLanguage || 'ko'}
          onChange={(e) => updateSettings({ outputLanguage: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="ko">한국어</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="zh">中文</option>
        </select>
      </div>

      {/* Max Length */}
      <div>
        <SectionLabel>최대 길이</SectionLabel>
        <select
          value={settings.maxLength || 'medium'}
          onChange={(e) => updateSettings({ maxLength: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="short">간략 (~500자)</option>
          <option value="medium">보통 (~1500자)</option>
          <option value="long">상세 (~3000자)</option>
          <option value="unlimited">제한 없음</option>
        </select>
      </div>

      {/* AI Model */}
      <div>
        <SectionLabel>AI 모델</SectionLabel>
        <ModelSelect value={settings.model} onChange={(v) => updateSettings({ model: v })} />
      </div>

      {/* Pipeline */}
      <div className="flex gap-2">
        <div className="flex-1 p-2 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-[10px] font-semibold text-green-700">📥 입력</p>
          <p className="text-[9px] text-green-600">이전 노드 결과 데이터</p>
        </div>
        <div className="flex-1 p-2 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-[10px] font-semibold text-blue-700">📤 출력</p>
          <p className="text-[9px] text-blue-600">구조화된 요약 결과</p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 5. WEB SEARCH (검색/수집)
// ═══════════════════════════════════════════════════════════════════

const SEARCH_ENGINES = [
  { key: 'google', icon: '🔍', label: 'Google', desc: '일반 웹 검색' },
  { key: 'google-news', icon: '📰', label: 'Google News', desc: '뉴스 전문 검색' },
  { key: 'naver', icon: '🟢', label: 'Naver', desc: '한국 콘텐츠 검색' },
  { key: 'arxiv', icon: '🎓', label: 'arXiv', desc: '학술 논문 검색' },
  { key: 'github', icon: '🐙', label: 'GitHub', desc: '코드/저장소 검색' },
  { key: 'custom-api', icon: '🌐', label: 'Custom API', desc: '직접 API 연결' },
];

function WebSearchPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const [keywordInput, setKeywordInput] = useState('');
  const keywords: string[] = settings.keywordTags || [];

  const addKeyword = () => {
    const kw = keywordInput.trim();
    if (kw && !keywords.includes(kw)) {
      const updated = [...keywords, kw];
      updateSettings({ keywordTags: updated, keywords: updated.join(', ') });
      setKeywordInput('');
    }
  };

  const removeKeyword = (kw: string) => {
    const updated = keywords.filter((k) => k !== kw);
    updateSettings({ keywordTags: updated, keywords: updated.join(', ') });
  };

  return (
    <div className="space-y-4">
      {/* Search Engine */}
      <div>
        <SectionLabel>검색 엔진</SectionLabel>
        <div className="grid grid-cols-3 gap-1.5">
          {SEARCH_ENGINES.map((eng) => (
            <button
              key={eng.key}
              onClick={() => updateSettings({ searchEngine: eng.key })}
              className={`p-2 rounded-lg border text-center transition ${
                (settings.searchEngine || 'google') === eng.key
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <span className="text-sm block">{eng.icon}</span>
              <span className="text-[9px] font-semibold text-gray-700 block">{eng.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Keywords with Tags */}
      <div>
        <SectionLabel>검색 키워드</SectionLabel>
        <div className="flex gap-1 mb-2">
          <input
            type="text"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addKeyword())}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            placeholder="키워드 입력 후 Enter"
          />
          <button
            onClick={addKeyword}
            className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition"
          >
            +
          </button>
        </div>
        {keywords.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {keywords.map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-medium"
              >
                {kw}
                <button onClick={() => removeKeyword(kw)} className="hover:text-red-500">
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Search Options */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <SectionLabel>최대 결과 수</SectionLabel>
          <select
            value={settings.maxResults || 10}
            onChange={(e) => updateSettings({ maxResults: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          >
            <option value={5}>5개</option>
            <option value={10}>10개</option>
            <option value={20}>20개</option>
            <option value={50}>50개</option>
          </select>
        </div>
        <div>
          <SectionLabel>검색 언어</SectionLabel>
          <select
            value={settings.language || 'ko'}
            onChange={(e) => updateSettings({ language: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="ko">한국어</option>
            <option value="en">English</option>
            <option value="all">전체</option>
          </select>
        </div>
      </div>

      {/* Date Range */}
      <div>
        <SectionLabel>기간 필터</SectionLabel>
        <select
          value={settings.dateRange || 'week'}
          onChange={(e) => updateSettings({ dateRange: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="day">최근 24시간</option>
          <option value="week">최근 1주일</option>
          <option value="month">최근 1개월</option>
          <option value="year">최근 1년</option>
          <option value="all">전체 기간</option>
        </select>
      </div>

      {/* Custom API (when selected) */}
      {settings.searchEngine === 'custom-api' && (
        <div className="space-y-2 p-2.5 bg-gray-50 border border-gray-200 rounded-lg">
          <div>
            <SectionLabel>API 엔드포인트</SectionLabel>
            <input
              type="text"
              value={settings.customApiUrl || ''}
              onChange={(e) => updateSettings({ customApiUrl: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="https://api.example.com/search"
            />
          </div>
          <div>
            <SectionLabel>API 키</SectionLabel>
            <input
              type="password"
              value={settings.customApiKey || ''}
              onChange={(e) => updateSettings({ customApiKey: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="API key"
            />
          </div>
        </div>
      )}

      {/* Output */}
      <div className="p-2 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-[10px] font-semibold text-blue-700">📤 출력 데이터</p>
        <p className="text-[10px] text-blue-600">
          검색 결과 ({settings.maxResults || 10}건) — 제목, URL, 본문 요약
        </p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 6. SLACK MESSAGE (슬랙 알림)
// ═══════════════════════════════════════════════════════════════════

function SlackPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const isConnected = !!settings.slackWebhook || !!settings.slackToken;

  return (
    <div className="space-y-4">
      {/* Connection Status */}
      <div
        className={`p-3 rounded-lg border ${isConnected ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-lg">{isConnected ? '✅' : '⚠️'}</span>
          <span
            className={`text-[11px] font-semibold ${isConnected ? 'text-green-700' : 'text-amber-700'}`}
          >
            {isConnected ? 'Slack 연결됨' : 'Slack 연결이 필요합니다'}
          </span>
        </div>
        {!isConnected && (
          <p className="text-[10px] text-amber-600">Webhook URL 또는 Bot Token을 설정하세요</p>
        )}
      </div>

      {/* Connection Method */}
      <div>
        <SectionLabel>연결 방식</SectionLabel>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <button
            onClick={() => updateSettings({ slackConnectType: 'webhook' })}
            className={`p-2 rounded-lg border text-center transition ${
              (settings.slackConnectType || 'webhook') === 'webhook'
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <span className="text-[11px] font-semibold">🔗 Webhook</span>
            <p className="text-[9px] text-gray-500">간편 설정</p>
          </button>
          <button
            onClick={() => updateSettings({ slackConnectType: 'bot' })}
            className={`p-2 rounded-lg border text-center transition ${
              settings.slackConnectType === 'bot'
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <span className="text-[11px] font-semibold">🤖 Bot Token</span>
            <p className="text-[9px] text-gray-500">고급 기능</p>
          </button>
        </div>
      </div>

      {(settings.slackConnectType || 'webhook') === 'webhook' ? (
        <div>
          <SectionLabel>Webhook URL</SectionLabel>
          <input
            type="password"
            value={settings.slackWebhook || ''}
            onChange={(e) => updateSettings({ slackWebhook: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            placeholder="https://hooks.slack.com/services/..."
          />
          <HelpText>Slack App → Incoming Webhooks에서 생성</HelpText>
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <SectionLabel>Bot Token</SectionLabel>
            <input
              type="password"
              value={settings.slackToken || ''}
              onChange={(e) => updateSettings({ slackToken: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="xoxb-..."
            />
          </div>
          <div>
            <SectionLabel>채널</SectionLabel>
            <input
              type="text"
              value={settings.channel || ''}
              onChange={(e) => updateSettings({ channel: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="#general"
            />
          </div>
        </div>
      )}

      {/* Message Template */}
      <div>
        <SectionLabel>메시지 템플릿</SectionLabel>
        <textarea
          value={settings.messageTemplate || ''}
          onChange={(e) => updateSettings({ messageTemplate: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          rows={4}
          placeholder="🔔 *워크플로우 완료 알림*&#10;&#10;{{summary}}&#10;&#10;상세 결과: {{link}}"
        />
        <div className="flex flex-wrap gap-1 mt-1.5">
          {['{{summary}}', '{{details}}', '{{link}}', '{{timestamp}}'].map((v) => (
            <button
              key={v}
              onClick={() =>
                updateSettings({ messageTemplate: (settings.messageTemplate || '') + v })
              }
              className="px-1.5 py-0.5 bg-gray-100 rounded text-[9px] font-mono text-gray-600 hover:bg-gray-200 transition"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Options */}
      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.mentionUsers || false}
            onChange={(e) => updateSettings({ mentionUsers: e.target.checked })}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          <span className="text-[11px] text-gray-700">@here 멘션 포함</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.threadReply || false}
            onChange={(e) => updateSettings({ threadReply: e.target.checked })}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          <span className="text-[11px] text-gray-700">스레드 답글로 전송</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.includeAttachment !== false}
            onChange={(e) => updateSettings({ includeAttachment: e.target.checked })}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          <span className="text-[11px] text-gray-700">전체 결과 파일 첨부</span>
        </label>
      </div>

      {/* Preview */}
      <div className="p-2.5 bg-gray-50 border border-gray-200 rounded-lg">
        <p className="text-[10px] font-semibold text-gray-600 mb-1.5">💬 메시지 미리보기</p>
        <div className="p-2 bg-white rounded border-l-4 border-blue-400">
          <p className="text-[10px] text-gray-700 whitespace-pre-wrap">
            {(settings.messageTemplate || '워크플로우 결과가 여기에 표시됩니다').replace(
              /\{\{.*?\}\}/g,
              '[데이터]',
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 7. DATA STORAGE / 실행 감사 로그 (사용자 친화형)
// ═══════════════════════════════════════════════════════════════════

const AUDIT_LOG_PRESETS = [
  {
    key: 'full-audit',
    icon: '📋',
    label: '전체 실행 기록',
    desc: '모든 노드의 실행 시간, 결과, 오류를 기록합니다',
    settings: {
      storageType: 'postgresql',
      operation: 'INSERT',
      logScope: 'all',
      addTimestamp: true,
      addWorkflowId: true,
    },
  },
  {
    key: 'error-only',
    icon: '🚨',
    label: '오류만 기록',
    desc: '실패하거나 경고가 발생한 노드만 기록합니다',
    settings: {
      storageType: 'postgresql',
      operation: 'INSERT',
      logScope: 'errors',
      addTimestamp: true,
      addWorkflowId: true,
    },
  },
  {
    key: 'result-archive',
    icon: '💾',
    label: '분석 결과 보관',
    desc: '분석/점검 결과를 데이터베이스에 영구 보관합니다',
    settings: {
      storageType: 'postgresql',
      operation: 'UPSERT',
      logScope: 'results',
      addTimestamp: true,
      addWorkflowId: true,
    },
  },
  {
    key: 'compliance',
    icon: '🔒',
    label: '컴플라이언스 감사 추적',
    desc: '규제 준수를 위한 상세 감사 로그 (누가, 언제, 무엇을)',
    settings: {
      storageType: 'postgresql',
      operation: 'INSERT',
      logScope: 'compliance',
      addTimestamp: true,
      addWorkflowId: true,
      addUserInfo: true,
    },
  },
];

const RETENTION_OPTIONS = [
  { key: '30d', label: '30일', desc: '일반' },
  { key: '90d', label: '90일', desc: '권장' },
  { key: '1y', label: '1년', desc: '컴플라이언스' },
  { key: 'forever', label: '영구', desc: '아카이브' },
];

function DataStoragePanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const selectedPreset = settings.auditPreset || 'full-audit';

  const selectPreset = (preset: (typeof AUDIT_LOG_PRESETS)[0]) => {
    updateSettings({
      ...preset.settings,
      auditPreset: preset.key,
    });
  };

  return (
    <div className="space-y-4">
      {/* ── 이 노드가 하는 일 안내 ── */}
      <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">📊</span>
          <span className="text-[12px] font-bold text-indigo-800">실행 감사 로그란?</span>
        </div>
        <p className="text-[10px] text-indigo-600 leading-relaxed">
          워크플로우가 실행될 때마다 <strong>누가, 언제, 어떤 노드를, 어떤 결과로</strong>{' '}
          실행했는지를 자동으로 기록합니다. 나중에 실행 이력을 조회하거나, 문제가 생겼을 때 원인을
          추적하는 데 사용합니다.
        </p>
      </div>

      {/* ── 기록 방식 프리셋 선택 ── */}
      <div>
        <SectionLabel>기록 방식 선택</SectionLabel>
        <div className="space-y-1.5">
          {AUDIT_LOG_PRESETS.map((preset) => (
            <button
              key={preset.key}
              onClick={() => selectPreset(preset)}
              className={`w-full p-3 rounded-lg border text-left transition flex items-center gap-3 ${
                selectedPreset === preset.key
                  ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <span className="text-xl flex-shrink-0">{preset.icon}</span>
              <div className="flex-1">
                <p className="text-[11px] font-bold text-gray-800">{preset.label}</p>
                <p className="text-[9px] text-gray-500">{preset.desc}</p>
              </div>
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                  selectedPreset === preset.key
                    ? 'border-indigo-500 bg-indigo-500'
                    : 'border-gray-300'
                }`}
              >
                {selectedPreset === preset.key && <span className="text-white text-[10px]">✓</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── 보관 기간 ── */}
      <div>
        <SectionLabel>보관 기간</SectionLabel>
        <div className="grid grid-cols-4 gap-1.5">
          {RETENTION_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => updateSettings({ retention: opt.key })}
              className={`p-2 rounded-lg border text-center transition ${
                (settings.retention || '90d') === opt.key
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <span className="text-[11px] font-bold text-gray-700 block">{opt.label}</span>
              <span className="text-[8px] text-gray-400">{opt.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── 기록 포함 항목 (체크박스) ── */}
      <div>
        <SectionLabel>기록에 포함할 정보</SectionLabel>
        <div className="space-y-1.5 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          {[
            {
              key: 'addTimestamp',
              icon: '🕐',
              label: '실행 시각',
              desc: '각 노드의 시작/종료 시간',
              default: true,
            },
            {
              key: 'addWorkflowId',
              icon: '🔗',
              label: '워크플로우 ID',
              desc: '어떤 워크플로우에서 실행했는지',
              default: true,
            },
            {
              key: 'addUserInfo',
              icon: '👤',
              label: '실행자 정보',
              desc: '누가 실행했는지 (이름, 이메일)',
              default: false,
            },
            {
              key: 'addNodeResults',
              icon: '📄',
              label: '노드별 실행 결과',
              desc: '각 단계의 상세 결과 텍스트',
              default: true,
            },
            {
              key: 'addErrorDetails',
              icon: '⚠️',
              label: '오류 상세 정보',
              desc: '실패 시 에러 메시지와 스택',
              default: true,
            },
            {
              key: 'addDuration',
              icon: '⏱️',
              label: '소요 시간',
              desc: '각 노드별 처리 시간 (ms)',
              default: true,
            },
          ].map((item) => (
            <label
              key={item.key}
              className="flex items-center gap-2.5 p-2 bg-white rounded-lg border border-gray-200 cursor-pointer hover:border-indigo-300 transition"
            >
              <input
                type="checkbox"
                checked={settings[item.key] !== undefined ? settings[item.key] : item.default}
                onChange={(e) => updateSettings({ [item.key]: e.target.checked })}
                className="w-4 h-4 accent-indigo-600 flex-shrink-0"
              />
              <span className="text-sm flex-shrink-0">{item.icon}</span>
              <div>
                <span className="text-[10px] font-semibold text-gray-700">{item.label}</span>
                <p className="text-[8px] text-gray-400">{item.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* ── 저장 위치 (자동 — 사용자가 설정할 필요 없음) ── */}
      <div className="p-2.5 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center gap-2">
          <span className="text-sm">🐘</span>
          <div>
            <p className="text-[10px] font-semibold text-green-700">
              저장 위치: Metis 내장 데이터베이스 (PostgreSQL)
            </p>
            <p className="text-[9px] text-green-600">
              별도 설정 없이 자동으로 저장됩니다. 나중에 대시보드에서 조회할 수 있습니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 8. LOG MONITOR (로그/모니터링)
// ═══════════════════════════════════════════════════════════════════

const LOG_SOURCES = [
  { key: 'server', icon: '🖥️', label: '서버 로그', desc: 'syslog, journald' },
  { key: 'application', icon: '📱', label: '애플리케이션 로그', desc: 'stdout, file logs' },
  { key: 'cloud', icon: '☁️', label: '클라우드', desc: 'CloudWatch, Stackdriver' },
  { key: 'custom', icon: '🔧', label: '커스텀 소스', desc: 'API, 파일 경로 지정' },
];

function LogMonitorPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Log Source */}
      <div>
        <SectionLabel>로그 소스</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {LOG_SOURCES.map((src) => (
            <button
              key={src.key}
              onClick={() => updateSettings({ logSource: src.key })}
              className={`p-2 rounded-lg border text-left transition ${
                (settings.logSource || 'server') === src.key
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-sm">{src.icon}</span>
                <span className="text-[10px] font-semibold text-gray-800">{src.label}</span>
              </div>
              <p className="text-[8px] text-gray-500 mt-0.5">{src.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Connection */}
      <div>
        <SectionLabel>접속 정보</SectionLabel>
        <input
          type="text"
          value={settings.logEndpoint || ''}
          onChange={(e) => updateSettings({ logEndpoint: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          placeholder="ssh://user@host 또는 https://api.endpoint.com"
        />
      </div>

      {/* Log Level Filter */}
      <div>
        <SectionLabel>로그 레벨 필터</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {['ERROR', 'WARN', 'INFO', 'DEBUG'].map((level) => {
            const selected = (settings.logLevels || ['ERROR', 'WARN']).includes(level);
            const colors: Record<string, string> = {
              ERROR: 'bg-red-100 text-red-700 border-red-300',
              WARN: 'bg-amber-100 text-amber-700 border-amber-300',
              INFO: 'bg-blue-100 text-blue-700 border-blue-300',
              DEBUG: 'bg-gray-100 text-gray-700 border-gray-300',
            };
            return (
              <button
                key={level}
                onClick={() => {
                  const current: string[] = settings.logLevels || ['ERROR', 'WARN'];
                  const updated = selected
                    ? current.filter((l) => l !== level)
                    : [...current, level];
                  updateSettings({ logLevels: updated });
                }}
                className={`px-3 py-1 rounded-lg border text-[10px] font-bold transition ${
                  selected ? colors[level] : 'bg-gray-50 text-gray-400 border-gray-200'
                }`}
              >
                {level}
              </button>
            );
          })}
        </div>
      </div>

      {/* Alert Pattern */}
      <div>
        <SectionLabel>알림 패턴 (정규식)</SectionLabel>
        <input
          type="text"
          value={settings.alertPattern || ''}
          onChange={(e) => updateSettings({ alertPattern: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
          placeholder="OutOfMemory|ConnectionRefused|timeout"
        />
        <HelpText>이 패턴 매칭 시 즉시 알림을 발생시킵니다</HelpText>
      </div>

      {/* Threshold */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <SectionLabel>에러 임계치</SectionLabel>
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={settings.errorThreshold || 10}
              onChange={(e) => updateSettings({ errorThreshold: Number(e.target.value) })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              min={1}
            />
            <span className="text-[10px] text-gray-500 whitespace-nowrap">건/분</span>
          </div>
        </div>
        <div>
          <SectionLabel>수집 주기</SectionLabel>
          <select
            value={settings.collectInterval || '1m'}
            onChange={(e) => updateSettings({ collectInterval: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="10s">10초</option>
            <option value="30s">30초</option>
            <option value="1m">1분</option>
            <option value="5m">5분</option>
          </select>
        </div>
      </div>

      {/* Output */}
      <div className="p-2 bg-blue-50 border border-blue-200 rounded-lg">
        <p className="text-[10px] font-semibold text-blue-700">📤 출력 데이터</p>
        <p className="text-[10px] text-blue-600">수집된 로그, 에러 패턴, 통계 요약</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 9. AI PROCESSING — GENERAL (일반 AI 처리)
// ═══════════════════════════════════════════════════════════════════
// This is for ai-processing nodes that aren't specifically
// inspection or summarize types.

function AIProcessingGeneralPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Agent */}
      <div>
        <SectionLabel>에이전트 이름</SectionLabel>
        <input
          type="text"
          value={settings.agentName || 'workflow-agent'}
          onChange={(e) => updateSettings({ agentName: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          placeholder="에이전트 이름"
        />
      </div>

      {/* Model */}
      <div>
        <SectionLabel>AI 모델</SectionLabel>
        <ModelSelect value={settings.model} onChange={(v) => updateSettings({ model: v })} />
      </div>

      {/* Prompt */}
      <div>
        <SectionLabel>프롬프트</SectionLabel>
        <textarea
          value={settings.promptTemplate || ''}
          onChange={(e) => updateSettings({ promptTemplate: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          rows={4}
          placeholder="AI에게 전달할 프롬프트를 입력하세요"
        />
        <div className="flex flex-wrap gap-1 mt-1.5">
          {['{{이전 노드 결과}}', '{{검색 결과}}', '{{파일 내용}}'].map((v) => (
            <button
              key={v}
              onClick={() =>
                updateSettings({ promptTemplate: (settings.promptTemplate || '') + '\n' + v })
              }
              className="px-1.5 py-0.5 bg-gray-100 rounded text-[9px] font-mono text-gray-600 hover:bg-gray-200 transition"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Parameters */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <SectionLabel>Temperature</SectionLabel>
          <input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={settings.temperature ?? 0.7}
            onChange={(e) => updateSettings({ temperature: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <SectionLabel>Max Tokens</SectionLabel>
          <input
            type="number"
            min={100}
            max={200000}
            value={settings.maxTokens ?? 2000}
            onChange={(e) => updateSettings({ maxTokens: Number(e.target.value) })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {/* FinOps */}
      <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold text-blue-700">
            💰 FinOps 3-Gate 파이프라인
          </span>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={settings.finopsEnabled !== false}
              onChange={(e) => updateSettings({ finopsEnabled: e.target.checked })}
              className="w-3 h-3 accent-blue-600"
            />
            <span className="text-[9px] text-blue-600">활성화</span>
          </label>
        </div>
        {settings.finopsEnabled !== false && (
          <div className="flex gap-3">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.finopsCache !== false}
                onChange={(e) => updateSettings({ finopsCache: e.target.checked })}
                className="w-3 h-3 accent-green-600"
              />
              <span className="text-[9px] text-gray-600">Cache</span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.finopsRouter !== false}
                onChange={(e) => updateSettings({ finopsRouter: e.target.checked })}
                className="w-3 h-3 accent-purple-600"
              />
              <span className="text-[9px] text-gray-600">Router</span>
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={settings.finopsPacker !== false}
                onChange={(e) => updateSettings({ finopsPacker: e.target.checked })}
                className="w-3 h-3 accent-orange-600"
              />
              <span className="text-[9px] text-gray-600">Packer</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 10. DATA TRANSFORM (데이터 변환)
// ═══════════════════════════════════════════════════════════════════

function DataTransformPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  return (
    <div className="space-y-4">
      <div>
        <SectionLabel>변환 유형</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            { key: 'json-to-table', icon: '📊', label: 'JSON → 테이블' },
            { key: 'csv-to-json', icon: '🔄', label: 'CSV → JSON' },
            { key: 'filter', icon: '🔍', label: '데이터 필터링' },
            { key: 'aggregate', icon: '📈', label: '집계/통계' },
            { key: 'merge', icon: '🔗', label: '데이터 병합' },
            { key: 'custom', icon: '⚙️', label: '커스텀 변환' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => updateSettings({ transformType: t.key })}
              className={`p-2 rounded-lg border text-left transition ${
                (settings.transformType || 'json-to-table') === t.key
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <span className="text-sm">{t.icon}</span>
              <span className="text-[10px] font-semibold text-gray-700 ml-1">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Mapping Rules */}
      <div>
        <SectionLabel>변환 규칙</SectionLabel>
        <textarea
          value={settings.mappingRules || ''}
          onChange={(e) => updateSettings({ mappingRules: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
          rows={4}
          placeholder="// 예: 필드 매핑&#10;input.name → output.title&#10;input.score → output.rating (number)"
        />
      </div>

      {/* Pipeline */}
      <div className="flex gap-2">
        <div className="flex-1 p-2 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-[10px] font-semibold text-green-700">📥 입력</p>
          <p className="text-[9px] text-green-600">이전 노드 데이터</p>
        </div>
        <div className="flex-1 p-2 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-[10px] font-semibold text-blue-700">📤 출력</p>
          <p className="text-[9px] text-blue-600">변환된 데이터</p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 11. NOTIFICATION — 완료 알림 (사용자 친화형)
// ═══════════════════════════════════════════════════════════════════

const NOTIFICATION_CHANNELS = [
  {
    key: 'email',
    icon: '📧',
    label: '이메일 알림',
    desc: '워크플로우 완료 결과를 이메일로 받습니다',
    color: 'blue',
  },
  {
    key: 'slack',
    icon: '💬',
    label: 'Slack 알림',
    desc: 'Slack 채널에 완료 메시지를 보냅니다',
    color: 'purple',
  },
  {
    key: 'browser',
    icon: '🔔',
    label: '브라우저 알림',
    desc: '브라우저 푸시 알림으로 알려드립니다',
    color: 'amber',
  },
  {
    key: 'webhook',
    icon: '🔗',
    label: '웹훅 호출',
    desc: '지정한 URL로 결과를 전송합니다 (Jira, Teams 등)',
    color: 'green',
  },
];

const NOTIFICATION_TEMPLATES = [
  {
    key: 'success',
    icon: '✅',
    label: '간단 완료 알림',
    preview: '워크플로우 "보안취약성 점검"이 완료되었습니다. (소요 시간: 45초)',
  },
  {
    key: 'with-summary',
    icon: '📋',
    label: '결과 요약 포함',
    preview: '워크플로우 완료 — CRITICAL 2건, HIGH 5건 발견. 즉시 조치가 필요합니다.',
  },
  {
    key: 'error-only',
    icon: '⚠️',
    label: '오류 발생 시에만 알림',
    preview: '워크플로우 실행 중 오류 발생 — 오류 내용과 발생 위치를 포함합니다.',
  },
  {
    key: 'custom',
    icon: '📊',
    label: '상세 결과 전체',
    preview: '전체 분석 결과를 포함한 상세 알림을 전송합니다.',
  },
];

const EMAIL_RECIPIENTS_PRESETS = [
  { key: 'me', icon: '👤', label: '나에게만', desc: '현재 로그인한 사용자' },
  { key: 'team', icon: '👥', label: '팀 전체', desc: '같은 테넌트의 모든 멤버' },
  { key: 'admins', icon: '🛡️', label: '관리자', desc: '시스템 관리자에게만' },
  { key: 'custom', icon: '✏️', label: '직접 지정', desc: '이메일 주소 입력' },
];

function NotificationPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const [recipientPreview, setRecipientPreview] = useState<{
    emails: string[];
    names: string[];
    count: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testSending, setTestSending] = useState(false);

  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  const selectedChannel = settings.notifyChannel || 'email';
  const selectedTemplate = settings.notifyTemplate || 'with-summary';
  const selectedRecipient = settings.recipientType || 'me';

  // Fetch recipient preview from backend
  const loadRecipientPreview = useCallback(
    async (recipientType: string) => {
      setPreviewLoading(true);
      setRecipientPreview(null);
      try {
        const customParam =
          recipientType === 'custom' && settings.customEmail
            ? `&customEmails=${encodeURIComponent(settings.customEmail)}`
            : '';
        const data = await api.get<{ emails: string[]; names: string[]; count: number }>(
          `/api/notifications/recipients/preview?recipientType=${recipientType}${customParam}`,
        );
        setRecipientPreview(data);
      } catch {
        // API not available — show placeholder
        const placeholders: Record<string, { emails: string[]; names: string[] }> = {
          me: { emails: ['(로그인한 사용자의 이메일)'], names: ['나'] },
          team: { emails: ['(현재 테넌트의 팀원들)'], names: ['팀 전체'] },
          admins: { emails: ['(관리자 권한 사용자들)'], names: ['관리자'] },
          custom: { emails: [settings.customEmail || '(이메일 입력 필요)'], names: ['직접 지정'] },
        };
        const p = placeholders[recipientType] || placeholders.me;
        setRecipientPreview({ emails: p.emails, names: p.names, count: p.emails.length });
      }
      setPreviewLoading(false);
    },
    [settings.customEmail],
  );

  // Send test notification
  const sendTestNotification = useCallback(async () => {
    setTestSending(true);
    setTestResult(null);
    try {
      const payload = {
        channel: selectedChannel,
        recipientType: selectedRecipient,
        customEmails:
          selectedRecipient === 'custom' && settings.customEmail
            ? settings.customEmail
                .split(/[,;\s]+/)
                .map((e: string) => e.trim())
                .filter(Boolean)
            : undefined,
        slackChannel: selectedChannel === 'slack' ? settings.slackChannel || '#general' : undefined,
        slackWebhookUrl: settings.slackWebhookUrl,
        webhookUrl: settings.webhookUrl,
        template: selectedTemplate,
        workflowName: '테스트 알림',
        executionSummary: '이것은 Metis.AI 워크플로우 알림 테스트입니다.',
      };
      const result = await api.post<{
        success: boolean;
        error?: string;
        resolvedRecipients?: string[];
      }>('/api/notifications/send', payload);
      if (result.success) {
        setTestResult({
          success: true,
          message: `✅ 전송 성공! (${result.resolvedRecipients?.join(', ') || selectedChannel})`,
        });
      } else {
        setTestResult({ success: false, message: `❌ ${result.error || '전송 실패'}` });
      }
    } catch {
      // If backend not available, show browser notification as fallback for 'browser' channel
      if (selectedChannel === 'browser') {
        if ('Notification' in window) {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            new Notification('Metis.AI 워크플로우 완료', {
              body: '워크플로우가 성공적으로 완료되었습니다.',
              icon: '/favicon.ico',
            });
            setTestResult({ success: true, message: '✅ 브라우저 알림이 표시되었습니다!' });
          } else {
            setTestResult({
              success: false,
              message:
                '❌ 브라우저 알림 권한이 거부되었습니다. 브라우저 설정에서 알림을 허용해주세요.',
            });
          }
        } else {
          setTestResult({ success: false, message: '❌ 이 브라우저는 알림을 지원하지 않습니다.' });
        }
      } else {
        setTestResult({
          success: false,
          message: '❌ API 서버에 연결할 수 없습니다. 백엔드가 실행 중인지 확인하세요.',
        });
      }
    }
    setTestSending(false);
  }, [selectedChannel, selectedRecipient, selectedTemplate, settings]);

  return (
    <div className="space-y-4">
      {/* ── 이 노드가 하는 일 ── */}
      <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">🔔</span>
          <span className="text-[12px] font-bold text-green-800">
            워크플로우 완료 시 알림을 보냅니다
          </span>
        </div>
        <p className="text-[10px] text-green-600 leading-relaxed">
          모든 분석이 끝나면 선택한 채널(이메일, Slack 등)로 결과를 알려드립니다. 직접 입력할 필요
          없이, 아래에서 원하는 항목을 선택하세요.
        </p>
      </div>

      {/* ── 1. 알림 채널 선택 ── */}
      <div>
        <SectionLabel>어디로 알림을 받을까요?</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          {NOTIFICATION_CHANNELS.map((ch) => (
            <button
              key={ch.key}
              onClick={() => {
                updateSettings({ notifyChannel: ch.key, channel: ch.key });
                setTestResult(null);
              }}
              className={`p-3 rounded-lg border text-left transition ${
                selectedChannel === ch.key
                  ? 'border-green-500 bg-green-50 ring-1 ring-green-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xl">{ch.icon}</span>
                <span className="text-[11px] font-bold text-gray-800">{ch.label}</span>
              </div>
              <p className="text-[8px] text-gray-500">{ch.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* 브라우저 알림 권한 안내 */}
      {selectedChannel === 'browser' && (
        <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg">
          <p className="text-[10px] font-semibold text-blue-700 mb-1">브라우저 알림 작동 방식</p>
          <p className="text-[9px] text-blue-600 leading-relaxed">
            워크플로우가 완료되면 브라우저 상단에 팝업 알림이 나타납니다. 아래{' '}
            <strong>테스트 보내기</strong> 버튼을 눌러 권한을 허용하고 미리 확인해보세요.
          </p>
        </div>
      )}

      {/* ── 2. 수신자 선택 (이메일/Slack일 때) ── */}
      {(selectedChannel === 'email' || selectedChannel === 'slack') && (
        <div>
          <SectionLabel>누구에게 보낼까요?</SectionLabel>
          <div className="space-y-1.5">
            {EMAIL_RECIPIENTS_PRESETS.map((rcp) => (
              <button
                key={rcp.key}
                onClick={() => {
                  updateSettings({ recipientType: rcp.key });
                  loadRecipientPreview(rcp.key);
                }}
                className={`w-full p-2.5 rounded-lg border text-left transition flex items-center gap-3 ${
                  selectedRecipient === rcp.key
                    ? 'border-green-500 bg-green-50 ring-1 ring-green-200'
                    : 'border-gray-200 hover:border-gray-300 bg-white'
                }`}
              >
                <span className="text-lg flex-shrink-0">{rcp.icon}</span>
                <div className="flex-1">
                  <span className="text-[11px] font-bold text-gray-800">{rcp.label}</span>
                  <p className="text-[9px] text-gray-500">{rcp.desc}</p>
                </div>
                <div
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                    selectedRecipient === rcp.key
                      ? 'border-green-500 bg-green-500'
                      : 'border-gray-300'
                  }`}
                >
                  {selectedRecipient === rcp.key && (
                    <span className="text-white text-[10px]">✓</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* 직접 지정 시 이메일 입력 */}
          {selectedRecipient === 'custom' && (
            <div className="mt-2">
              <input
                type="email"
                value={settings.customEmail || ''}
                onChange={(e) => updateSettings({ customEmail: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-green-500"
                placeholder="이메일 주소 입력 (예: team@company.com)"
              />
            </div>
          )}

          {/* 수신자 확인 결과 */}
          {previewLoading && (
            <div className="mt-2 p-2 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-[9px] text-gray-500 animate-pulse">수신자 확인 중...</p>
            </div>
          )}
          {recipientPreview && !previewLoading && (
            <div className="mt-2 p-2.5 bg-white border border-green-200 rounded-lg">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] font-bold text-green-700">
                  📬 알림 수신 대상 ({recipientPreview.count}명)
                </span>
              </div>
              <div className="space-y-0.5">
                {recipientPreview.emails.slice(0, 5).map((email, i) => (
                  <div key={i} className="flex items-center gap-2 text-[9px]">
                    <span className="w-4 h-4 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0">
                      {(recipientPreview.names[i] || email).charAt(0).toUpperCase()}
                    </span>
                    <span className="text-gray-700">{recipientPreview.names[i] || email}</span>
                    <span className="text-gray-400">{email.includes('@') ? `(${email})` : ''}</span>
                  </div>
                ))}
                {recipientPreview.count > 5 && (
                  <p className="text-[8px] text-gray-400 pl-6">
                    외 {recipientPreview.count - 5}명...
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Slack 채널 선택 */}
      {selectedChannel === 'slack' && (
        <div>
          <SectionLabel>Slack 채널</SectionLabel>
          <div className="grid grid-cols-3 gap-1.5">
            {[
              { key: '#general', label: '#general' },
              { key: '#security', label: '#security' },
              { key: '#dev-ops', label: '#dev-ops' },
              { key: '#alerts', label: '#alerts' },
              { key: '#reports', label: '#reports' },
              { key: 'custom', label: '직접 입력' },
            ].map((ch) => (
              <button
                key={ch.key}
                onClick={() => updateSettings({ slackChannel: ch.key })}
                className={`p-2 rounded-lg border text-center transition text-[10px] font-mono ${
                  (settings.slackChannel || '#general') === ch.key
                    ? 'border-purple-500 bg-purple-50 text-purple-700 font-bold'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                {ch.label}
              </button>
            ))}
          </div>
          {settings.slackChannel === 'custom' && (
            <input
              type="text"
              value={settings.customSlackChannel || ''}
              onChange={(e) => updateSettings({ customSlackChannel: e.target.value })}
              className="mt-1.5 w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-purple-500"
              placeholder="#채널명"
            />
          )}
          <div className="mt-2 p-2 bg-purple-50 border border-purple-200 rounded-lg">
            <p className="text-[9px] text-purple-600">
              Slack 알림을 사용하려면 관리자 설정에서 <strong>Slack Webhook URL</strong>이 설정되어
              있어야 합니다. (환경변수: SLACK_WEBHOOK_URL)
            </p>
          </div>
        </div>
      )}

      {/* 웹훅 URL */}
      {selectedChannel === 'webhook' && (
        <div>
          <SectionLabel>웹훅 URL</SectionLabel>
          <input
            type="text"
            value={settings.webhookUrl || ''}
            onChange={(e) => updateSettings({ webhookUrl: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-green-500"
            placeholder="https://hooks.slack.com/... 또는 https://your-api.com/webhook"
          />
          <HelpText>Microsoft Teams, Jira, 커스텀 시스템 등의 웹훅 URL을 입력하세요</HelpText>
        </div>
      )}

      {/* ── 3. 메시지 형식 선택 ── */}
      <div>
        <SectionLabel>알림에 포함할 내용</SectionLabel>
        <div className="space-y-1.5">
          {NOTIFICATION_TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              onClick={() => updateSettings({ notifyTemplate: tpl.key })}
              className={`w-full p-2.5 rounded-lg border text-left transition ${
                selectedTemplate === tpl.key
                  ? 'border-green-500 bg-green-50 ring-1 ring-green-200'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm">{tpl.icon}</span>
                <span className="text-[11px] font-bold text-gray-800">{tpl.label}</span>
              </div>
              <p className="text-[9px] text-gray-500 bg-gray-50 p-1.5 rounded italic">
                "{tpl.preview}"
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* ── 테스트 전송 ── */}
      <div className="p-3 bg-gray-50 border border-gray-300 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-bold text-gray-600">📬 알림 미리보기 & 테스트</p>
          <button
            type="button"
            onClick={sendTestNotification}
            disabled={testSending}
            className="px-3 py-1.5 bg-green-600 text-white text-[10px] font-semibold rounded-lg hover:bg-green-700 transition disabled:opacity-50"
          >
            {testSending ? '전송 중...' : '🚀 테스트 보내기'}
          </button>
        </div>

        {/* 미리보기 */}
        <div className="p-2.5 bg-white rounded-lg border border-gray-200">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-lg">
              {NOTIFICATION_CHANNELS.find((c) => c.key === selectedChannel)?.icon}
            </span>
            <span className="text-[11px] font-bold text-gray-800">
              {NOTIFICATION_CHANNELS.find((c) => c.key === selectedChannel)?.label}
            </span>
            <span className="text-[9px] text-gray-400">→</span>
            <span className="text-[10px] text-gray-600">
              {selectedRecipient === 'me'
                ? '나 (로그인 이메일)'
                : selectedRecipient === 'team'
                  ? '팀 전체 (같은 테넌트 멤버)'
                  : selectedRecipient === 'admins'
                    ? '관리자 (ADMIN/OWNER)'
                    : selectedChannel === 'browser'
                      ? '현재 브라우저'
                      : settings.customEmail || '수신자 미지정'}
            </span>
          </div>
          <p className="text-[10px] text-gray-600 italic">
            "{NOTIFICATION_TEMPLATES.find((t) => t.key === selectedTemplate)?.preview}"
          </p>
        </div>

        {/* 테스트 결과 */}
        {testResult && (
          <div
            className={`mt-2 p-2 rounded-lg text-[10px] font-semibold ${
              testResult.success
                ? 'bg-green-50 border border-green-200 text-green-700'
                : 'bg-red-50 border border-red-200 text-red-700'
            }`}
          >
            {testResult.message}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 12. API CALL (API 호출)
// ═══════════════════════════════════════════════════════════════════

function ApiCallPanel({ nodeId, settings, onUpdate }: PanelProps) {
  const updateSettings = useCallback(
    (patch: Partial<NodeSettings>) => {
      onUpdate(nodeId, { settings: { ...settings, ...patch } });
    },
    [nodeId, settings, onUpdate],
  );

  return (
    <div className="space-y-4">
      {/* Method + URL */}
      <div>
        <SectionLabel>API 요청</SectionLabel>
        <div className="flex gap-1.5">
          <select
            value={settings.method || 'GET'}
            onChange={(e) => updateSettings({ method: e.target.value })}
            className="w-24 px-2 py-2 border border-gray-300 rounded-lg text-sm font-bold focus:outline-none focus:border-blue-500"
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={settings.url || ''}
            onChange={(e) => updateSettings({ url: e.target.value })}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            placeholder="https://api.example.com/endpoint"
          />
        </div>
      </div>

      {/* Auth */}
      <div>
        <SectionLabel>인증</SectionLabel>
        <select
          value={settings.authType || 'none'}
          onChange={(e) => updateSettings({ authType: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="none">인증 없음</option>
          <option value="bearer">Bearer Token</option>
          <option value="basic">Basic Auth</option>
          <option value="api-key">API Key</option>
        </select>
        {settings.authType === 'bearer' && (
          <input
            type="password"
            value={settings.authToken || ''}
            onChange={(e) => updateSettings({ authToken: e.target.value })}
            className="w-full mt-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
            placeholder="Bearer token"
          />
        )}
        {settings.authType === 'api-key' && (
          <div className="grid grid-cols-2 gap-1.5 mt-1.5">
            <input
              type="text"
              value={settings.apiKeyHeader || 'X-API-Key'}
              onChange={(e) => updateSettings({ apiKeyHeader: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="Header name"
            />
            <input
              type="password"
              value={settings.apiKeyValue || ''}
              onChange={(e) => updateSettings({ apiKeyValue: e.target.value })}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-blue-500"
              placeholder="Key value"
            />
          </div>
        )}
      </div>

      {/* Headers */}
      <div>
        <SectionLabel>헤더 (JSON)</SectionLabel>
        <textarea
          value={settings.headers || ''}
          onChange={(e) => updateSettings({ headers: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
          rows={2}
          placeholder='{"Content-Type": "application/json"}'
        />
      </div>

      {/* Body */}
      {['POST', 'PUT', 'PATCH'].includes(settings.method || 'GET') && (
        <div>
          <SectionLabel>요청 본문</SectionLabel>
          <textarea
            value={settings.bodyTemplate || ''}
            onChange={(e) => updateSettings({ bodyTemplate: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-blue-500"
            rows={4}
            placeholder='{"data": {{이전 노드 결과}}}'
          />
        </div>
      )}

      {/* Test */}
      <button className="w-full px-3 py-2 bg-gray-900 text-white text-[11px] font-semibold rounded-lg hover:bg-gray-800 transition flex items-center justify-center gap-2">
        🚀 API 테스트 호출
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORTS — Panel Router
// ═══════════════════════════════════════════════════════════════════

type NodeType =
  | 'schedule'
  | 'web-search'
  | 'ai-processing'
  | 'pentest'
  | 'email-send'
  | 'slack-message'
  | 'data-storage'
  | 'api-call'
  | 'data-transform'
  | 'condition'
  | 'wait-approval'
  | 'jira'
  | 'git-deploy'
  | 'log-monitor'
  | 'file-operation'
  | 'notification'
  | 'webhook';

/**
 * Determines which rich panel to render based on node type AND its stepCategory.
 * This is the key insight: the same nodeType (e.g. 'file-operation') can have
 * very different UIs depending on whether it's an input or output node.
 */
export function getNodeSettingsPanel(
  nodeType: NodeType,
  nodeId: string,
  nodeName: string,
  settings: NodeSettings,
  onUpdate: (nodeId: string, patch: { settings: NodeSettings }) => void,
): React.ReactNode | null {
  const panelProps: PanelProps = { nodeId, settings, onUpdate, nodeName };
  const category = settings.stepCategory || '';

  switch (nodeType) {
    case 'file-operation':
      if (category === 'input') {
        return <FileInputPanel {...panelProps} />;
      } else if (category === 'output') {
        return <FileOutputPanel {...panelProps} />;
      }
      // Fallback: guess based on operation
      if (settings.operation === 'read' || /로딩|로드|불러|업로드/.test(nodeName)) {
        return <FileInputPanel {...panelProps} />;
      }
      return <FileOutputPanel {...panelProps} />;

    case 'ai-processing':
    case 'pentest':
      if (category === 'pentest') {
        return <PentestPanel {...panelProps} />;
      }
      if (category === 'inspection' || category === 'analysis') {
        return <InspectionPanel {...panelProps} />;
      }
      if (category === 'summarize') {
        return <SummaryPanel {...panelProps} />;
      }
      return <AIProcessingGeneralPanel {...panelProps} />;

    case 'web-search':
      return <WebSearchPanel {...panelProps} />;

    case 'slack-message':
      return <SlackPanel {...panelProps} />;

    case 'data-storage':
      return <DataStoragePanel {...panelProps} />;

    case 'log-monitor':
      return <LogMonitorPanel {...panelProps} />;

    case 'data-transform':
      return <DataTransformPanel {...panelProps} />;

    case 'api-call':
      return <ApiCallPanel {...panelProps} />;

    case 'notification':
      return <NotificationPanel {...panelProps} />;

    // These still use the existing specialized panels in page.tsx:
    // - schedule
    // - email-send
    // The remaining types use the generic fallback.
    default:
      return null;
  }
}

/**
 * Node-card mini-status — shows a brief "what's configured" badge
 * below each node card in the pipeline view.
 */
export function getNodeMiniStatus(nodeType: NodeType, settings: NodeSettings): string {
  const category = settings.stepCategory || '';

  switch (nodeType) {
    case 'file-operation':
      if (category === 'input') {
        const files = settings._uploadedFiles || [];
        if (files.length > 0) return `📁 ${files.length}개 파일 준비됨`;
        if (settings.gitUrl) return `🔗 Git: ${settings.gitUrl.split('/').pop()}`;
        const sourceType = settings.sourceType || 'local';
        return sourceType === 'local' ? '📂 파일 대기 중' : `☁️ ${sourceType}`;
      }
      if (category === 'output') {
        const fmt = settings.outputFormatLabel || 'docx';
        return `📎 ${fmt} 생성`;
      }
      return settings.operation === 'read' ? '📂 파일 읽기' : '💾 파일 쓰기';

    case 'ai-processing':
      if (category === 'inspection') {
        const scanners = settings.scanners || [];
        return scanners.length > 0 ? `🔍 ${scanners.join(', ').toUpperCase()}` : '🔍 보안 점검';
      }
      if (category === 'summarize') {
        return `📋 ${settings.summaryStyle || 'technical'} 요약`;
      }
      return `🤖 ${settings.model || 'claude-sonnet-4.6'}`;

    case 'pentest': {
      const vectors = settings.attackVectors || [];
      const mode = settings.scanMode || 'auto';
      if (vectors.length > 0) return `🛡️ ${vectors.length}개 벡터 (${mode})`;
      return `🛡️ 모의해킹 (${mode})`;
    }

    case 'notification': {
      const ch = settings.notifyChannel || settings.channel || 'email';
      const chLabels: Record<string, string> = {
        email: '이메일',
        slack: 'Slack',
        browser: '브라우저',
        webhook: '웹훅',
      };
      const recipType = settings.recipientType || 'me';
      const recipLabels: Record<string, string> = {
        me: '나에게',
        team: '팀',
        admins: '관리자',
        custom: '직접지정',
      };
      return `🔔 ${chLabels[ch] || ch} → ${recipLabels[recipType] || recipType}`;
    }

    case 'web-search':
      return `🔍 ${settings.searchEngine || 'Google'} (${settings.maxResults || 10}건)`;

    case 'slack-message':
      return settings.slackWebhook || settings.slackToken ? '✅ Slack 연결됨' : '⚠️ 설정 필요';

    case 'data-storage': {
      const presetLabels: Record<string, string> = {
        'full-audit': '전체 기록',
        'errors-only': '오류만',
        'results-archive': '결과 보관',
        compliance: '컴플라이언스',
      };
      const retentionLabels: Record<string, string> = {
        '30d': '30일',
        '90d': '90일',
        '180d': '6개월',
        '365d': '1년',
      };
      const preset = settings.auditPreset || 'full-audit';
      const ret = settings.retention || '90d';
      return `📊 ${presetLabels[preset] || preset} · ${retentionLabels[ret] || ret}`;
    }

    case 'log-monitor':
      return `📊 ${(settings.logLevels || ['ERROR']).join('/')} 모니터링`;

    case 'schedule':
      return `⏰ ${settings.scheduleType || '즉시 실행'}`;

    case 'email-send':
      return settings.smtpUser ? `📧 ${settings.smtpHost}` : '⚠️ SMTP 설정 필요';

    default:
      return '';
  }
}

/**
 * File Upload Executor
 *
 * Handles source code loading from multiple sources:
 *   - Local file upload (with drag-drop from frontend)
 *   - Git repository cloning
 *   - Cloud storage (S3/GCS) download
 *   - API endpoint fetch
 *
 * Key capabilities:
 *   - Archive extraction (ZIP, TAR, TAR.GZ, 7Z)
 *   - File type detection and filtering
 *   - Directory tree scanning
 *   - Source code statistics (LOC, file count by language)
 *
 * Registers as connector: metis-file-upload
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import { promisify } from 'util';
import { assertExternalUrl } from '../../../common/utils/url-validator';

const execFileAsync = promisify(child_process.execFile);
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
  UploadedFileInfo,
} from '../node-executor-registry';

// Language detection by extension
const LANG_MAP: Record<string, string> = {
  '.js': 'JavaScript',
  '.jsx': 'JavaScript/React',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript/React',
  '.py': 'Python',
  '.java': 'Java',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.c': 'C',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
  '.xml': 'XML',
  '.md': 'Markdown',
  '.dockerfile': 'Docker',
  '.tf': 'Terraform',
};

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz', '.7z', '.rar', '.gz'];

@Injectable()
export class FileUploadExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'file-upload';
  readonly displayName = '파일 업로드 / 소스 로딩';
  readonly handledNodeTypes = ['file-operation'];
  readonly handledCategories = ['input'];

  private readonly logger = new Logger(FileUploadExecutor.name);
  private uploadDir: string;
  private readonly maxArchiveSize = 500 * 1024 * 1024; // 500MB max archive size

  constructor(
    private readonly registry: NodeExecutorRegistry,
    private readonly config: ConfigService,
  ) {
    this.uploadDir = this.config.get('UPLOAD_DIR') || path.join(os.tmpdir(), 'metis-uploads');
  }

  onModuleInit() {
    this.registry.register(this);
    // Ensure upload directory exists
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const sourceType = settings.sourceType || 'local';

    try {
      let sourceFiles: SourceFile[] = [];
      let sourcePath = '';

      switch (sourceType) {
        case 'local':
          ({ sourceFiles, sourcePath } = await this.handleLocalUpload(input));
          break;
        case 'git':
          ({ sourceFiles, sourcePath } = await this.handleGitClone(settings));
          break;
        case 'upload':
          ({ sourceFiles, sourcePath } = await this.handleCloudDownload(settings));
          break;
        case 'api':
          ({ sourceFiles, sourcePath } = await this.handleApiDownload(settings));
          break;
        default:
          throw new Error(`Unsupported source type: ${sourceType}`);
      }

      // Apply file filters if specified
      const filters: string[] = settings.fileFilters || [];
      if (filters.length > 0) {
        sourceFiles = sourceFiles.filter((f) =>
          filters.some((filter) => {
            const ext = filter.replace('*', '');
            return f.name.endsWith(ext);
          }),
        );
      }

      // Generate statistics
      const stats = this.generateStats(sourceFiles);

      // Build output text for downstream nodes
      const outputText = this.buildOutputText(sourceFiles, stats, sourcePath);

      return {
        success: true,
        data: {
          sourcePath: path.resolve(sourcePath),
          sourceType,
          fileCount: sourceFiles.length,
          totalSize: sourceFiles.reduce((s, f) => s + f.size, 0),
          languages: stats.languages,
          stats,
          files: sourceFiles.slice(0, 100).map((f) => ({
            name: f.name,
            path: f.relativePath,
            size: f.size,
            language: f.language,
            lineCount: f.lineCount,
          })),
        },
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

  private async handleLocalUpload(
    input: NodeExecutionInput,
  ): Promise<{ sourceFiles: SourceFile[]; sourcePath: string }> {
    const uploadedFiles = input.uploadedFiles || input.settings._uploadedFiles || [];

    if (!uploadedFiles.length) {
      // If no pre-uploaded files, check for a path setting
      const filePath = input.settings.path || input.settings.sourcePath;
      if (filePath) {
        // SECURITY (M-4): confine reads to the upload/temp/session directories.
        // Reject traversal and any path that escapes the allow-listed roots.
        if (filePath.includes('..')) {
          throw new Error(`보안 오류: 경로 탐색(path traversal)이 감지되었습니다.`);
        }
        const resolved = path.resolve(filePath);
        // Allow only: the configured upload dir, the metis temp prefix, and the
        // current execution session dir. Arbitrary absolute host paths are NOT
        // permitted (previous `path.isAbsolute` escape removed).
        const allowedRoots = [
          path.resolve(this.uploadDir),
          path.resolve(path.join(os.tmpdir(), 'metis-uploads')),
          path.resolve(path.join(os.tmpdir(), 'metis-outputs')),
          path.resolve(path.join(this.uploadDir, input.executionSessionId)),
        ];
        const isSafe = allowedRoots.some(
          (root) => resolved === root || resolved.startsWith(root + path.sep),
        );
        if (!isSafe) {
          this.logger.warn(`Path rejected: ${resolved} (allowed: ${allowedRoots.join(', ')})`);
          throw new Error(
            `보안 오류: 허용되지 않는 경로입니다. 업로드 디렉토리 내의 파일만 지정할 수 있습니다.`,
          );
        }
        if (fs.existsSync(resolved)) {
          return this.scanDirectory(resolved);
        }
        // Path doesn't exist — not an error, just no files
        this.logger.warn(`Specified path does not exist: ${resolved}`);
      }
      throw new Error('업로드된 파일이 없습니다. 파일을 드래그 앤 드롭하거나 경로를 지정해주세요.');
    }

    const sessionDir = path.join(this.uploadDir, input.executionSessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const allFiles: SourceFile[] = [];

    for (const file of uploadedFiles) {
      const filePath = file.path || path.join(sessionDir, file.name);

      if (file.isArchive && input.settings.autoExtract !== false) {
        // Validate archive size before extraction
        const archiveSize = fs.statSync(filePath).size;
        if (archiveSize > this.maxArchiveSize) {
          throw new Error(
            `아카이브 파일이 너무 큽니다. 최대 ${(this.maxArchiveSize / (1024 * 1024)).toFixed(0)}MB 이하의 파일만 지원합니다.`,
          );
        }

        // Extract archive
        const extractDir = path.join(
          sessionDir,
          `extracted_${path.basename(file.name, path.extname(file.name))}`,
        );
        await this.extractArchive(filePath, extractDir);
        const { sourceFiles } = await this.scanDirectory(extractDir);
        allFiles.push(...sourceFiles);
      } else if (fs.existsSync(filePath)) {
        const content = this.tryReadFile(filePath);
        allFiles.push({
          name: path.basename(filePath),
          relativePath: path.basename(filePath),
          absolutePath: filePath,
          size: fs.statSync(filePath).size,
          language: this.detectLanguage(filePath),
          lineCount: content ? content.split('\n').length : 0,
          content: content?.slice(0, 50000), // Cap at 50KB per file
        });
      }
    }

    return { sourceFiles: allFiles, sourcePath: sessionDir };
  }

  private async handleGitClone(
    settings: Record<string, any>,
  ): Promise<{ sourceFiles: SourceFile[]; sourcePath: string }> {
    const gitUrl = settings.gitUrl;
    if (!gitUrl) throw new Error('Git 저장소 URL이 필요합니다.');

    const branch = settings.gitBranch || 'main';
    const cloneDir = path.join(this.uploadDir, `git_${Date.now()}`);

    // SECURITY (H-2): validate URL (no SSRF, only https/git) and branch name,
    // then run git via execFile with an argument array — NO shell.
    let parsedScheme = '';
    try {
      parsedScheme = new URL(gitUrl).protocol;
    } catch {
      throw new Error('유효하지 않은 Git URL 형식입니다.');
    }
    if (parsedScheme === 'https:') {
      await assertExternalUrl(gitUrl); // SSRF guard for https remotes
    } else if (parsedScheme !== 'git:') {
      throw new Error('Git URL은 https 또는 git 프로토콜만 허용됩니다.');
    }
    if (!/^[\w.\-\/]+$/.test(branch)) {
      throw new Error('유효하지 않은 브랜치 이름입니다.');
    }

    // Inject token for private https repos (token only — never shell-interpolated).
    let cloneUrl = gitUrl;
    if (settings.gitToken && parsedScheme === 'https:') {
      if (!/^[\w.\-~+/=:@]+$/.test(String(settings.gitToken))) {
        throw new Error('유효하지 않은 Git 토큰 형식입니다.');
      }
      cloneUrl = gitUrl.replace('https://', `https://${settings.gitToken}@`);
    }

    try {
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', '--branch', branch, cloneUrl, cloneDir],
        { timeout: 120000 },
      );
    } catch (err) {
      throw new Error(`Git clone 실패: ${(err as Error).message}`);
    }

    // If a subpath is specified, scan only that
    const scanPath = settings.gitPath ? path.join(cloneDir, settings.gitPath) : cloneDir;

    return this.scanDirectory(scanPath);
  }

  private async handleCloudDownload(
    settings: Record<string, any>,
  ): Promise<{ sourceFiles: SourceFile[]; sourcePath: string }> {
    // Placeholder — in production, use AWS SDK / GCS SDK
    const provider = settings.cloudProvider || 's3';
    const cloudPath = settings.cloudPath || '';
    this.logger.log(`Cloud download from ${provider}: ${cloudPath}`);
    throw new Error(
      `클라우드 다운로드(${provider})는 클라우드 커넥터 설정 후 사용할 수 있습니다. 커넥터 페이지에서 ${provider} 커넥터를 설정하세요.`,
    );
  }

  private async handleApiDownload(
    settings: Record<string, any>,
  ): Promise<{ sourceFiles: SourceFile[]; sourcePath: string }> {
    const apiUrl = settings.apiUrl;
    if (!apiUrl) throw new Error('API 엔드포인트 URL이 필요합니다.');

    // Fetch from API
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiAuthHeader) {
      headers['Authorization'] = settings.apiAuthHeader;
    }

    await assertExternalUrl(apiUrl); // SSRF guard (H-1)
    const response = await fetch(apiUrl, { headers });
    if (!response.ok) {
      throw new Error(`API 요청 실패: ${response.status} ${response.statusText}`);
    }

    const data = await response.text();
    const tempDir = path.join(this.uploadDir, `api_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, 'api_response.json');
    fs.writeFileSync(filePath, data);

    return this.scanDirectory(tempDir);
  }

  private async scanDirectory(
    dirPath: string,
  ): Promise<{ sourceFiles: SourceFile[]; sourcePath: string }> {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`경로를 찾을 수 없습니다: ${dirPath}`);
    }

    const files: SourceFile[] = [];
    const scan = (dir: string, baseDir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // Skip hidden dirs, node_modules, .git, etc.
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === '__pycache__' ||
          entry.name === 'dist' ||
          entry.name === 'build'
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          scan(fullPath, baseDir);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const lang = LANG_MAP[ext];
          if (!lang && !entry.name.match(/\.(txt|env|lock|toml|ini|cfg)$/)) {
            // Skip non-source files
            continue;
          }
          const stat = fs.statSync(fullPath);
          if (stat.size > 1_000_000) continue; // Skip files > 1MB

          const content = this.tryReadFile(fullPath);
          files.push({
            name: entry.name,
            relativePath: path.relative(baseDir, fullPath),
            absolutePath: fullPath,
            size: stat.size,
            language: lang || 'Other',
            lineCount: content ? content.split('\n').length : 0,
            content: content?.slice(0, 50000),
          });
        }
      }
    };

    const stat = fs.statSync(dirPath);
    if (stat.isFile()) {
      const content = this.tryReadFile(dirPath);
      files.push({
        name: path.basename(dirPath),
        relativePath: path.basename(dirPath),
        absolutePath: dirPath,
        size: stat.size,
        language: this.detectLanguage(dirPath),
        lineCount: content ? content.split('\n').length : 0,
        content: content?.slice(0, 50000),
      });
    } else {
      scan(dirPath, dirPath);
    }

    return { sourceFiles: files, sourcePath: dirPath };
  }

  private async extractArchive(archivePath: string, extractDir: string): Promise<void> {
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    const ext = archivePath.toLowerCase();

    // SECURITY (H-3): never shell out with an interpolated string. All archive
    // tools are invoked via execFile with an explicit argument array (no shell),
    // so attacker-controlled file names cannot inject commands.
    try {
      if (ext.endsWith('.zip')) {
        await execFileAsync('unzip', ['-o', archivePath, '-d', extractDir], { timeout: 60000 });
      } else if (ext.endsWith('.tar.gz') || ext.endsWith('.tgz')) {
        await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { timeout: 60000 });
      } else if (ext.endsWith('.tar')) {
        await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], { timeout: 60000 });
      } else if (ext.endsWith('.7z')) {
        await execFileAsync('7z', ['x', archivePath, `-o${extractDir}`, '-y'], { timeout: 60000 });
      } else if (ext.endsWith('.gz')) {
        // Single-file gzip: decompress into the target dir without a shell.
        const outName = path.basename(archivePath.replace(/\.gz$/i, ''));
        const outPath = path.join(extractDir, outName || 'output');
        const { stdout } = await execFileAsync('gzip', ['-dc', archivePath], {
          timeout: 60000,
          maxBuffer: 256 * 1024 * 1024,
          encoding: 'buffer' as any,
        });
        fs.writeFileSync(outPath, stdout as unknown as Buffer);
      } else {
        throw new Error(`지원하지 않는 압축 형식: ${path.extname(archivePath)}`);
      }
    } catch (err) {
      throw new Error(`압축 해제 실패: ${(err as Error).message}`);
    }

    // SECURITY (H-3): zip-slip guard. After extraction verify that no extracted
    // path escapes extractDir. If anything does, delete it and abort.
    const root = path.resolve(extractDir);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // Resolve symlinks to their real target to catch link-based escapes.
        let real: string;
        try {
          real = fs.realpathSync(full);
        } catch {
          real = path.resolve(full);
        }
        if (real !== root && !real.startsWith(root + path.sep)) {
          offenders.push(full);
          continue;
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
      }
    };
    walk(root);
    if (offenders.length > 0) {
      try {
        fs.rmSync(extractDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      throw new Error(
        `보안 오류: 압축 파일에 디렉토리를 벗어나는 경로(zip-slip)가 포함되어 있어 차단되었습니다.`,
      );
    }
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return LANG_MAP[ext] || 'Other';
  }

  private tryReadFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private generateStats(files: SourceFile[]): SourceStats {
    const langCount: Record<string, number> = {};
    const langLines: Record<string, number> = {};
    let totalLines = 0;
    let totalSize = 0;

    for (const f of files) {
      langCount[f.language] = (langCount[f.language] || 0) + 1;
      langLines[f.language] = (langLines[f.language] || 0) + f.lineCount;
      totalLines += f.lineCount;
      totalSize += f.size;
    }

    return {
      totalFiles: files.length,
      totalLines,
      totalSize,
      languages: Object.entries(langCount)
        .sort((a, b) => b[1] - a[1])
        .map(([lang, count]) => ({
          language: lang,
          fileCount: count,
          lineCount: langLines[lang] || 0,
        })),
    };
  }

  private buildOutputText(files: SourceFile[], stats: SourceStats, sourcePath: string): string {
    const absolutePath = path.resolve(sourcePath);
    const lines: string[] = [];
    lines.push(`=== 소스 코드 로딩 완료 ===`);
    lines.push(`저장 경로 (절대): ${absolutePath}`);
    lines.push(
      `총 파일: ${stats.totalFiles}개 | 총 라인: ${stats.totalLines.toLocaleString()}줄 | 크기: ${(stats.totalSize / 1024).toFixed(1)}KB`,
    );
    lines.push('');
    lines.push('--- 언어별 분포 ---');
    for (const lang of stats.languages.slice(0, 10)) {
      lines.push(
        `  ${lang.language}: ${lang.fileCount}개 파일, ${lang.lineCount.toLocaleString()}줄`,
      );
    }
    lines.push('');
    lines.push('--- 파일 목록 (상위 30개) ---');
    for (const f of files.slice(0, 30)) {
      lines.push(`  ${f.relativePath} (${f.language}, ${f.lineCount}줄)`);
    }
    if (files.length > 30) {
      lines.push(`  ... 외 ${files.length - 30}개 파일`);
    }

    // Include file contents for AI analysis downstream
    lines.push('\n\n=== 소스 코드 내용 (분석 대상) ===\n');
    let contentBudget = 200000; // ~200KB of source for AI to analyze
    for (const f of files) {
      if (!f.content || contentBudget <= 0) break;
      const header = `\n--- ${f.relativePath} (${f.language}) ---\n`;
      const chunk = f.content.slice(0, Math.min(f.content.length, contentBudget));
      lines.push(header + chunk);
      contentBudget -= chunk.length + header.length;
    }

    return lines.join('\n');
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-file-upload',
      name: '파일 업로드 / 소스 로딩',
      type: 'BUILT_IN',
      description:
        '로컬 파일, Git 저장소, 클라우드 스토리지에서 소스코드를 로딩합니다. ZIP/TAR 압축 해제, 파일 필터링, 코드 통계 생성을 지원합니다.',
      category: 'input',
      inputSchema: {
        sourceType: { type: 'string', enum: ['local', 'git', 'upload', 'api'] },
        files: { type: 'array', description: '업로드된 파일 목록' },
        gitUrl: { type: 'string', description: 'Git 저장소 URL' },
        fileFilters: { type: 'array', description: '파일 확장자 필터' },
      },
      outputSchema: {
        sourcePath: { type: 'string' },
        fileCount: { type: 'number' },
        totalLines: { type: 'number' },
        files: { type: 'array' },
        sourceCode: { type: 'string', description: '소스 코드 텍스트 (다음 노드에 전달)' },
      },
      capabilities: [
        'file-upload',
        'archive-extract',
        'git-clone',
        'source-scan',
        'code-statistics',
      ],
    };
  }
}

// Internal types
interface SourceFile {
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  language: string;
  lineCount: number;
  content?: string;
}

interface SourceStats {
  totalFiles: number;
  totalLines: number;
  totalSize: number;
  languages: Array<{ language: string; fileCount: number; lineCount: number }>;
}

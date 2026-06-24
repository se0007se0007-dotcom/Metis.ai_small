/**
 * Document Generation Executor
 *
 * Generates real downloadable documents from analysis results:
 *   - DOCX (Word) — via docx library
 *   - PDF — via pdfkit
 *   - HTML — direct generation
 *   - CSV/JSON — data export
 *   - Markdown — text format
 *
 * Registers as connector: metis-document-gen
 */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  INodeExecutor,
  NodeExecutionInput,
  NodeExecutionOutput,
  ConnectorMetadata,
  NodeExecutorRegistry,
  GeneratedFile,
} from '../node-executor-registry';
import {
  generateDashboardHtml,
  parseAnalysisContent,
  ReportData,
  SEVERITY_CONFIG,
} from './report-template';

@Injectable()
export class DocumentGenExecutor implements OnModuleInit, INodeExecutor {
  readonly executorKey = 'document-gen';
  readonly displayName = '문서 생성 / 파일 내보내기';
  readonly handledNodeTypes = ['file-operation'];
  readonly handledCategories = ['output'];

  private readonly logger = new Logger(DocumentGenExecutor.name);
  private outputDir: string;

  constructor(
    private readonly registry: NodeExecutorRegistry,
    private readonly config: ConfigService,
  ) {
    this.outputDir = this.config.get('OUTPUT_DIR') || path.join(os.tmpdir(), 'metis-outputs');
  }

  onModuleInit() {
    this.registry.register(this);
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async execute(input: NodeExecutionInput): Promise<NodeExecutionOutput> {
    const start = Date.now();
    const settings = input.settings;
    const format = settings.outputFormat || 'docx';
    const content = input.previousOutput;

    if (!content || content.length < 10) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: '문서에 포함할 내용이 없습니다. 이전 노드의 결과를 확인하세요.',
      };
    }

    try {
      const sessionDir = path.join(this.outputDir, input.executionSessionId);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      // Build filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const baseName = settings.fileNamePattern
        ? settings.fileNamePattern
            .replace('{{date}}', timestamp.slice(0, 10))
            .replace('{{time}}', timestamp.slice(11))
            .replace('{{project}}', 'metis')
        : `report-${timestamp}`;

      let generatedFile: GeneratedFile;

      switch (format) {
        case 'docx':
          generatedFile = await this.generateDocx(content, baseName, sessionDir, settings);
          break;
        case 'pdf':
          generatedFile = await this.generatePdf(content, baseName, sessionDir, settings);
          break;
        case 'html':
          generatedFile = await this.generateHtml(content, baseName, sessionDir, settings);
          break;
        case 'csv':
          generatedFile = await this.generateCsv(content, baseName, sessionDir);
          break;
        case 'json':
          generatedFile = await this.generateJson(content, baseName, sessionDir);
          break;
        case 'md':
        default:
          generatedFile = await this.generateMarkdown(content, baseName, sessionDir);
          break;
      }

      return {
        success: true,
        data: {
          format,
          fileName: generatedFile.name,
          filePath: generatedFile.path,
          fileSize: generatedFile.size,
          downloadUrl: generatedFile.downloadUrl,
        },
        outputText: `문서 생성 완료: ${generatedFile.name} (${(generatedFile.size / 1024).toFixed(1)}KB)\n다운로드: ${generatedFile.downloadUrl}`,
        generatedFiles: [generatedFile],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: {},
        outputText: '',
        durationMs: Date.now() - start,
        error: `문서 생성 실패: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Generate DOCX (Word) document — Professional format with tables, colors, structure
   * Uses the docx npm package for rich formatting. Falls back to HTML if unavailable.
   */
  private async generateDocx(
    content: string,
    baseName: string,
    outputDir: string,
    settings: Record<string, any>,
  ): Promise<GeneratedFile> {
    const fileName = `${baseName}.docx`;
    const filePath = path.join(outputDir, fileName);
    const title = settings.reportTitle || 'Metis.AI 분석 보고서';
    const parsed = parseAnalysisContent(content);

    try {
      const docx = require('docx');
      const {
        Document,
        Packer,
        Paragraph,
        TextRun,
        HeadingLevel,
        AlignmentType,
        Table,
        TableRow,
        TableCell,
        WidthType,
        BorderStyle,
        ShadingType,
        Header,
        Footer,
        PageNumber,
        NumberFormat,
        TabStopPosition,
        TabStopType,
      } = docx;

      const children: any[] = [];
      const SEV_COLORS: Record<string, string> = {
        critical: 'DC2626',
        high: 'EA580C',
        medium: 'CA8A04',
        low: '2563EB',
        info: '6B7280',
      };
      const SEV_BG: Record<string, string> = {
        critical: 'FEF2F2',
        high: 'FFF7ED',
        medium: 'FEFCE8',
        low: 'EFF6FF',
        info: 'F9FAFB',
      };
      const SEV_LABEL: Record<string, string> = {
        critical: '심각',
        high: '높음',
        medium: '보통',
        low: '낮음',
        info: '참고',
      };

      // ── Cover / Title ──
      children.push(
        new Paragraph({ spacing: { after: 600 } }),
        new Paragraph({
          children: [
            new TextRun({
              text: title,
              size: 52,
              bold: true,
              color: '1E3A5F',
              font: 'Malgun Gothic',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 100 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: settings.projectName || 'Metis.AI AgentOps Governance Platform',
              size: 24,
              color: '6B7280',
              font: 'Malgun Gothic',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: `생성일시: ${new Date().toLocaleString('ko-KR')}`,
              size: 20,
              color: '9CA3AF',
              font: 'Malgun Gothic',
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        }),
        new Paragraph({
          children: [new TextRun({ text: '─'.repeat(60), color: '3B82F6', size: 16 })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 },
        }),
      );

      // ── Executive Summary ──
      const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const f of parsed.findings) sevCounts[f.severity]++;
      const totalFindings = parsed.findings.length;
      const urgentCount = sevCounts.critical + sevCounts.high;
      const riskScore = parsed.kpis.find((k) => k.label.includes('위험'))?.value || 0;

      children.push(
        new Paragraph({
          text: '경영진 요약 (Executive Summary)',
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: `본 분석에서 총 `, size: 22, font: 'Malgun Gothic' }),
            new TextRun({
              text: `${totalFindings}개`,
              size: 22,
              bold: true,
              font: 'Malgun Gothic',
            }),
            new TextRun({
              text: `의 항목이 발견되었으며, 위험 점수는 `,
              size: 22,
              font: 'Malgun Gothic',
            }),
            new TextRun({
              text: `${riskScore}점/100점`,
              size: 22,
              bold: true,
              color:
                typeof riskScore === 'number' && riskScore >= 70
                  ? 'DC2626'
                  : typeof riskScore === 'number' && riskScore >= 40
                    ? 'CA8A04'
                    : '10B981',
              font: 'Malgun Gothic',
            }),
            new TextRun({ text: `입니다.`, size: 22, font: 'Malgun Gothic' }),
          ],
          spacing: { after: 100 },
        }),
      );

      if (urgentCount > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `⚠ 즉시 조치가 필요한 심각/높음 등급 항목: ${urgentCount}건`,
                size: 22,
                bold: true,
                color: 'DC2626',
                font: 'Malgun Gothic',
              }),
            ],
            spacing: { after: 200 },
          }),
        );
      }

      // ── Summary Statistics Table ──
      children.push(
        new Paragraph({
          text: '심각도 분포',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 150 },
        }),
      );

      const statsRows = [
        new TableRow({
          tableHeader: true,
          children: ['심각도', '건수', '비율'].map(
            (h) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: h,
                        bold: true,
                        size: 20,
                        color: 'FFFFFF',
                        font: 'Malgun Gothic',
                      }),
                    ],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
                shading: { type: ShadingType.CLEAR, fill: '1E3A5F' },
                width: { size: 33, type: WidthType.PERCENTAGE },
              }),
          ),
        }),
        ...Object.entries(sevCounts).map(
          ([sev, count]) =>
            new TableRow({
              children: [
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: `${SEVERITY_CONFIG[sev as keyof typeof SEVERITY_CONFIG]?.icon || ''} ${SEV_LABEL[sev]}`,
                          size: 20,
                          bold: true,
                          color: SEV_COLORS[sev],
                          font: 'Malgun Gothic',
                        }),
                      ],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                  shading: { type: ShadingType.CLEAR, fill: SEV_BG[sev] },
                }),
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({ text: `${count}`, size: 20, font: 'Malgun Gothic' }),
                      ],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                }),
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text:
                            totalFindings > 0
                              ? `${Math.round((count / totalFindings) * 100)}%`
                              : '0%',
                          size: 20,
                          font: 'Malgun Gothic',
                        }),
                      ],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                }),
              ],
            }),
        ),
      ];

      children.push(
        new Table({
          rows: statsRows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
      );

      // ── Findings Detail ──
      children.push(
        new Paragraph({ spacing: { after: 200 } }),
        new Paragraph({
          text: '발견 항목 상세',
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        }),
      );

      // Findings table
      if (parsed.findings.length > 0) {
        const headerRow = new TableRow({
          tableHeader: true,
          children: ['ID', '심각도', '항목명', '카테고리'].map(
            (h) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: h,
                        bold: true,
                        size: 18,
                        color: 'FFFFFF',
                        font: 'Malgun Gothic',
                      }),
                    ],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
                shading: { type: ShadingType.CLEAR, fill: '374151' },
              }),
          ),
        });

        const dataRows = parsed.findings.map(
          (f) =>
            new TableRow({
              children: [
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [new TextRun({ text: f.id, size: 18, font: 'Malgun Gothic' })],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                  width: { size: 12, type: WidthType.PERCENTAGE },
                }),
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: `${SEVERITY_CONFIG[f.severity]?.icon || ''} ${SEV_LABEL[f.severity]}`,
                          size: 18,
                          bold: true,
                          color: SEV_COLORS[f.severity],
                          font: 'Malgun Gothic',
                        }),
                      ],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                  shading: { type: ShadingType.CLEAR, fill: SEV_BG[f.severity] },
                  width: { size: 15, type: WidthType.PERCENTAGE },
                }),
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [new TextRun({ text: f.title, size: 18, font: 'Malgun Gothic' })],
                    }),
                  ],
                  width: { size: 53, type: WidthType.PERCENTAGE },
                }),
                new TableCell({
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: f.category || '일반',
                          size: 18,
                          color: '3B82F6',
                          font: 'Malgun Gothic',
                        }),
                      ],
                      alignment: AlignmentType.CENTER,
                    }),
                  ],
                  width: { size: 20, type: WidthType.PERCENTAGE },
                }),
              ],
            }),
        );

        children.push(
          new Table({
            rows: [headerRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
        );
      }

      // ── Each Finding in Detail ──
      for (const f of parsed.findings) {
        const sev = SEVERITY_CONFIG[f.severity];
        children.push(
          new Paragraph({ spacing: { after: 100 } }),
          new Paragraph({
            children: [
              new TextRun({ text: `${f.id} | `, size: 22, color: '9CA3AF', font: 'Malgun Gothic' }),
              new TextRun({
                text: `[${sev?.label || f.severity}] `,
                size: 22,
                bold: true,
                color: SEV_COLORS[f.severity],
                font: 'Malgun Gothic',
              }),
              new TextRun({ text: f.title, size: 22, bold: true, font: 'Malgun Gothic' }),
            ],
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 80 },
          }),
        );

        // Description
        for (const line of f.description.split('\n')) {
          if (line.trim()) {
            children.push(
              new Paragraph({
                children: [new TextRun({ text: line.trim(), size: 20, font: 'Malgun Gothic' })],
                spacing: { after: 40 },
              }),
            );
          }
        }

        // Impact
        if (f.impact) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: '영향: ',
                  size: 20,
                  bold: true,
                  color: 'EA580C',
                  font: 'Malgun Gothic',
                }),
                new TextRun({ text: f.impact, size: 20, font: 'Malgun Gothic' }),
              ],
              spacing: { before: 60, after: 40 },
            }),
          );
        }

        // Recommendation
        if (f.recommendation) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: '권고 조치: ',
                  size: 20,
                  bold: true,
                  color: '10B981',
                  font: 'Malgun Gothic',
                }),
                new TextRun({ text: f.recommendation, size: 20, font: 'Malgun Gothic' }),
              ],
              spacing: { before: 60, after: 40 },
            }),
          );
        }

        // Code snippet
        if (f.codeSnippet) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: f.codeSnippet, size: 18, font: 'D2Coding' })],
              shading: { type: ShadingType.CLEAR, fill: 'F1F5F9' },
              spacing: { before: 80, after: 80 },
            }),
          );
        }
      }

      // ── Recommendations Summary ──
      const withReco = parsed.findings.filter((f) => f.recommendation);
      if (withReco.length > 0) {
        children.push(
          new Paragraph({ spacing: { after: 200 } }),
          new Paragraph({
            text: '권고 조치 요약 (Action Items)',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 400, after: 200 },
          }),
        );

        const priorities = [
          {
            label: '즉시 조치 (Critical/High)',
            items: withReco.filter((f) => f.severity === 'critical' || f.severity === 'high'),
            color: 'DC2626',
          },
          {
            label: '단기 개선 (Medium)',
            items: withReco.filter((f) => f.severity === 'medium'),
            color: 'CA8A04',
          },
          {
            label: '장기 개선 (Low/Info)',
            items: withReco.filter((f) => f.severity === 'low' || f.severity === 'info'),
            color: '2563EB',
          },
        ];

        for (const group of priorities) {
          if (group.items.length === 0) continue;
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `▎ ${group.label}`,
                  size: 22,
                  bold: true,
                  color: group.color,
                  font: 'Malgun Gothic',
                }),
              ],
              spacing: { before: 150, after: 80 },
            }),
          );
          for (const item of group.items) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `• ${item.title}: `,
                    size: 20,
                    bold: true,
                    font: 'Malgun Gothic',
                  }),
                  new TextRun({ text: item.recommendation || '', size: 20, font: 'Malgun Gothic' }),
                ],
                spacing: { after: 40 },
                indent: { left: 360 },
              }),
            );
          }
        }
      }

      // ── Build Document ──
      const doc = new Document({
        styles: {
          default: {
            heading1: { run: { size: 32, bold: true, color: '1E3A5F', font: 'Malgun Gothic' } },
            heading2: { run: { size: 26, bold: true, color: '374151', font: 'Malgun Gothic' } },
            heading3: { run: { size: 22, bold: true, color: '1F2937', font: 'Malgun Gothic' } },
          },
        },
        sections: [
          {
            properties: {
              page: {
                margin: { top: 1440, bottom: 1440, left: 1080, right: 1080 },
              },
            },
            headers: {
              default: new Header({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: `${title} — Metis.AI`,
                        size: 16,
                        color: '9CA3AF',
                        font: 'Malgun Gothic',
                      }),
                    ],
                    alignment: AlignmentType.RIGHT,
                  }),
                ],
              }),
            },
            footers: {
              default: new Footer({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: 'Metis.AI AgentOps Governance Platform  |  ',
                        size: 14,
                        color: '9CA3AF',
                        font: 'Malgun Gothic',
                      }),
                      new TextRun({ children: [PageNumber.CURRENT], size: 14, color: '9CA3AF' }),
                      new TextRun({ text: ' / ', size: 14, color: '9CA3AF' }),
                      new TextRun({
                        children: [PageNumber.TOTAL_PAGES],
                        size: 14,
                        color: '9CA3AF',
                      }),
                    ],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
              }),
            },
            children,
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(filePath, buffer);
    } catch (e) {
      // Fallback: generate professional HTML report (Word can open HTML)
      this.logger.warn(
        `docx package not available (${(e as Error).message}), generating HTML dashboard fallback`,
      );
      const htmlFile = await this.generateHtml(content, baseName, outputDir, settings);
      return { ...htmlFile, format: 'html' };
    }

    const stat = fs.statSync(filePath);
    return {
      name: fileName,
      path: filePath,
      format: 'docx',
      size: stat.size,
      downloadUrl: `/api/workflow-nodes/download/${path.basename(outputDir)}/${fileName}`,
    };
  }

  /**
   * Generate PDF document
   */
  private async generatePdf(
    content: string,
    baseName: string,
    outputDir: string,
    settings: Record<string, any>,
  ): Promise<GeneratedFile> {
    const fileName = `${baseName}.pdf`;
    const filePath = path.join(outputDir, fileName);

    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 72, right: 72 },
        info: {
          Title: settings.reportTitle || 'Metis.AI Report',
          Author: 'Metis.AI',
          Creator: 'Metis.AI Workflow Engine',
        },
      });

      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Title
      doc.fontSize(20).text(settings.reportTitle || 'Metis.AI 분석 보고서', { align: 'center' });
      doc.moveDown();
      doc
        .fontSize(10)
        .fillColor('#666')
        .text(`생성일시: ${new Date().toLocaleString('ko-KR')}`, { align: 'center' });
      doc.moveDown(2);

      // Content
      doc.fontSize(11).fillColor('#000');
      const sections = this.parseContentToSections(content);

      for (const section of sections) {
        if (section.type === 'heading') {
          doc.moveDown();
          doc.fontSize(14).fillColor('#1a365d').text(section.text);
          doc.moveDown(0.3);
          doc.fontSize(11).fillColor('#000');
        } else {
          doc.text(section.text, { lineGap: 3 });
        }
      }

      doc.end();

      await new Promise<void>((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });
    } catch {
      this.logger.warn('pdfkit not available, generating HTML fallback');
      return this.generateHtml(content, baseName, outputDir, settings);
    }

    const stat = fs.statSync(filePath);
    return {
      name: fileName,
      path: filePath,
      format: 'pdf',
      size: stat.size,
      downloadUrl: `/api/workflow-nodes/download/${path.basename(outputDir)}/${fileName}`,
    };
  }

  /**
   * Generate HTML report — Professional dashboard style
   */
  private async generateHtml(
    content: string,
    baseName: string,
    outputDir: string,
    settings: Record<string, any>,
  ): Promise<GeneratedFile> {
    const fileName = `${baseName}.html`;
    const filePath = path.join(outputDir, fileName);

    const reportData: ReportData = {
      title: settings.reportTitle || 'Metis.AI 분석 보고서',
      subtitle: settings.projectName || settings.reportSubtitle || '',
      projectName: settings.projectName,
      generatedAt: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      rawContent: content,
    };

    const html = generateDashboardHtml(reportData);
    fs.writeFileSync(filePath, html, 'utf-8');

    const stat = fs.statSync(filePath);
    return {
      name: fileName,
      path: filePath,
      format: 'html',
      size: stat.size,
      downloadUrl: `/api/workflow-nodes/download/${path.basename(outputDir)}/${fileName}`,
    };
  }

  private async generateCsv(
    content: string,
    baseName: string,
    outputDir: string,
  ): Promise<GeneratedFile> {
    const fileName = `${baseName}.csv`;
    const filePath = path.join(outputDir, fileName);
    // Convert content to CSV-like format (best effort)
    fs.writeFileSync(filePath, content, 'utf-8');
    const stat = fs.statSync(filePath);
    return {
      name: fileName,
      path: filePath,
      format: 'csv',
      size: stat.size,
      downloadUrl: `/api/workflow-nodes/download/${path.basename(outputDir)}/${fileName}`,
    };
  }

  private async generateJson(
    content: string,
    baseName: string,
    outputDir: string,
  ): Promise<GeneratedFile> {
    const fileName = `${baseName}.json`;
    const filePath = path.join(outputDir, fileName);
    const data = {
      generatedAt: new Date().toISOString(),
      content,
      sections: this.parseContentToSections(content),
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    const stat = fs.statSync(filePath);
    return {
      name: fileName,
      path: filePath,
      format: 'json',
      size: stat.size,
      downloadUrl: `/api/workflow-nodes/download/${path.basename(outputDir)}/${fileName}`,
    };
  }

  private async generateMarkdown(
    content: string,
    baseName: string,
    outputDir: string,
  ): Promise<GeneratedFile> {
    const fileName = `${baseName}.md`;
    const filePath = path.join(outputDir, fileName);
    const md = `# Metis.AI 분석 보고서\n\n*생성일시: ${new Date().toLocaleString('ko-KR')}*\n\n---\n\n${content}`;
    fs.writeFileSync(filePath, md, 'utf-8');
    const stat = fs.statSync(filePath);
    return {
      name: fileName,
      path: filePath,
      format: 'md',
      size: stat.size,
      downloadUrl: `/api/workflow-nodes/download/${path.basename(outputDir)}/${fileName}`,
    };
  }

  private parseContentToSections(
    content: string,
  ): Array<{ type: 'heading' | 'body'; text: string }> {
    const sections: Array<{ type: 'heading' | 'body'; text: string }> = [];
    const lines = content.split('\n');
    let currentBody = '';

    for (const line of lines) {
      if (line.match(/^={3,}/) || line.match(/^-{3,}/) || line.match(/^#{1,3}\s/)) {
        if (currentBody.trim()) {
          sections.push({ type: 'body', text: currentBody.trim() });
          currentBody = '';
        }
        const headingText = line
          .replace(/^#{1,3}\s/, '')
          .replace(/^[=-]+\s*/, '')
          .trim();
        if (headingText) sections.push({ type: 'heading', text: headingText });
      } else {
        currentBody += line + '\n';
      }
    }

    if (currentBody.trim()) {
      sections.push({ type: 'body', text: currentBody.trim() });
    }

    return sections;
  }

  private formatAsText(content: string, settings: Record<string, any>): string {
    return `${settings.reportTitle || 'Metis.AI 보고서'}\n${'='.repeat(60)}\n생성일시: ${new Date().toLocaleString('ko-KR')}\n\n${content}`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  getConnectorMetadata(): ConnectorMetadata {
    return {
      key: 'metis-document-gen',
      name: '문서 생성 / 파일 내보내기',
      type: 'BUILT_IN',
      description:
        '분석 결과를 DOCX, PDF, HTML, CSV, JSON, Markdown 형식의 문서로 생성합니다. 보고서 템플릿, 파일명 패턴, 자동 다운로드를 지원합니다.',
      category: 'output',
      inputSchema: {
        outputFormat: { type: 'string', enum: ['docx', 'pdf', 'html', 'csv', 'json', 'md'] },
        reportTemplate: { type: 'string' },
        fileNamePattern: { type: 'string' },
        content: { type: 'string', description: '문서에 포함할 내용 (이전 노드에서 전달)' },
      },
      outputSchema: {
        fileName: { type: 'string' },
        downloadUrl: { type: 'string' },
        fileSize: { type: 'number' },
      },
      capabilities: [
        'docx-gen',
        'pdf-gen',
        'html-gen',
        'csv-export',
        'json-export',
        'markdown-gen',
      ],
    };
  }
}

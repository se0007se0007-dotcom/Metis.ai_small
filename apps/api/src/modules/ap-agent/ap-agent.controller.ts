/**
 * AP Agent Controller — REST API surface for invoice processing.
 * Endpoints: GET|POST /ap/invoices, state transitions, approvals.
 */
import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { APAgentService, CreateInvoiceDto } from './ap-agent.service';
import { CurrentUser, RequestUser, Audit, Roles } from '../../common/decorators';

@ApiTags('AccountsPayable')
@ApiBearerAuth()
@Controller('ap/invoices')
export class APAgentController {
  constructor(private readonly apAgentService: APAgentService) {}

  /**
   * GET /ap/invoices
   * List invoices with filtering by status, vendor, date range.
   */
  @Get()
  @ApiOperation({ summary: 'List invoices' })
  @ApiQuery({ name: 'status', required: false, type: String })
  @ApiQuery({ name: 'vendorId', required: false, type: String })
  @ApiQuery({ name: 'dateFrom', required: false, type: String })
  @ApiQuery({ name: 'dateTo', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.apAgentService.listInvoices(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      {
        status,
        vendorId,
        dateFrom,
        dateTo,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      },
    );
  }

  /**
   * GET /ap/invoices/summary
   * Get summary stats: counts by status, today's processed.
   */
  @Get('summary')
  @ApiOperation({ summary: 'Get invoice summary statistics' })
  async summary(@CurrentUser() user: RequestUser) {
    return this.apAgentService.summary({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });
  }

  /**
   * GET /ap/invoices/:id
   * Get single invoice.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get invoice detail' })
  async getById(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.apAgentService.getInvoice(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  /**
   * POST /ap/invoices
   * Create new invoice (status=RECEIVED).
   */
  @Post()
  @Roles('OPERATOR')
  @Audit('CREATE', 'APInvoice')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create new invoice' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateInvoiceDto) {
    return this.apAgentService.createInvoice(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      dto,
    );
  }

  /**
   * POST /ap/invoices/:id/parse
   * Parse invoice with simulated OCR (RECEIVED → MATCHING).
   */
  @Post(':id/parse')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'APInvoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parse invoice with OCR' })
  async parse(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body?: { sourceUri?: string },
  ) {
    return this.apAgentService.parseInvoice(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      { sourceUri: body?.sourceUri },
    );
  }

  /**
   * POST /ap/invoices/:id/match
   * Run 3-way matching (MATCHING → EXCEPTION|PENDING_APPROVAL).
   */
  @Post(':id/match')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'APInvoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run 3-way matching against PO and GR' })
  async match(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.apAgentService.runMatching(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
    );
  }

  /**
   * POST /ap/invoices/:id/approve
   * Approve invoice (PENDING_APPROVAL|EXCEPTION → APPROVED).
   */
  @Post(':id/approve')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'APInvoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve invoice for payment' })
  async approve(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.apAgentService.approve(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      user.userId,
    );
  }

  /**
   * POST /ap/invoices/:id/reject
   * Reject invoice with reason (PENDING_APPROVAL|EXCEPTION → REJECTED).
   */
  @Post(':id/reject')
  @Roles('OPERATOR')
  @Audit('STATUS_TRANSITION', 'APInvoice')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject invoice' })
  async reject(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.apAgentService.reject(
      { tenantId: user.tenantId, userId: user.userId, role: user.role },
      id,
      body.reason,
    );
  }
}

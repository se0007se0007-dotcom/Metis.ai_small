import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import * as path from 'path';

import { DatabaseModule } from './modules/database.module';
import { SharedRedisModule } from './common/redis/shared-redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { PackModule } from './modules/pack/pack.module';
import { ExecutionModule } from './modules/execution/execution.module';
import { GovernanceModule } from './modules/governance/governance.module';
import { ConnectorModule } from './modules/connector/connector.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { HealthModule } from './modules/health/health.module';
import { ReleaseModule } from './modules/release/release.module';
import { FinOpsModule } from './modules/finops/finops.module';
import { FinopsGwModule } from './modules/finops-gw/finops-gw.module';
import { EmailModule } from './modules/email/email.module';
import { NotificationModule } from './modules/notification/notification.module';
import { BuilderModule } from './modules/builder/builder.module';
import { AgentKernelModule } from './modules/agent-kernel/agent-kernel.module';
import { AutonomousOpsModule } from './modules/autonomous-ops/autonomous-ops.module';
import { APAgentModule } from './modules/ap-agent/ap-agent.module';
import { FdsModule } from './modules/fds/fds.module';
import { EventsModule } from './modules/events/events.module';
import { CapabilityRegistryModule } from './modules/capability-registry/capability-registry.module';
import { WorkflowNodesModule } from './modules/workflow-nodes/workflow-nodes.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { OrbModule } from './modules/orb/orb.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { IngestModule } from './modules/ingest/ingest.module';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ThrottleGuard } from './common/guards/throttle.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { CorrelationInterceptor } from './common/interceptors/correlation.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        path.resolve(__dirname, '../../../.env'), // from dist/ → monorepo root
        path.resolve(process.cwd(), '.env'), // CWD (if running from root)
        '../../.env', // relative fallback
        '.env', // local fallback
      ],
    }),
    DatabaseModule,
    SharedRedisModule,
    AuthModule,
    TenantModule,
    PackModule,
    ExecutionModule,
    GovernanceModule,
    ConnectorModule,
    KnowledgeModule,
    HealthModule,
    ReleaseModule,
    FinOpsModule,
    FinopsGwModule,
    EmailModule,
    NotificationModule,
    BuilderModule,
    AgentKernelModule,
    AutonomousOpsModule,
    APAgentModule,
    FdsModule,
    EventsModule,
    CapabilityRegistryModule,
    WorkflowNodesModule,
    WorkflowModule,
    OrbModule,
    DashboardModule,
    MetricsModule,
    IngestModule,
  ],
  providers: [
    // Global correlation ID on every request
    { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
    // Global audit logging on state-changing operations
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Global rate limiting
    { provide: APP_GUARD, useClass: ThrottleGuard },
    // Global JWT authentication
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global RBAC enforcement
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}

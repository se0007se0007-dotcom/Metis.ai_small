import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { CsrfMiddleware } from './common/middleware/csrf.middleware';

// 전역 크래시 가드 — 한 커넥터/외부 프로세스의 오류(예: Windows 에서 MCP 서버를 띄우는
// `spawn npx ENOENT`)가 API 전체를 죽이지 않도록 한다. 로깅만 하고 프로세스는 유지.
// (실제 SaaS 운영 원칙: 단일 커넥터 장애가 플랫폼 가용성을 떨어뜨려선 안 됨.)
process.on('uncaughtException', (err: any) => {
  Logger.error(
    `Uncaught exception (가드됨 — 프로세스 유지): ${err?.message ?? err}`,
    err?.stack,
    'ProcessGuard',
  );
});
process.on('unhandledRejection', (reason: any) => {
  Logger.error(
    `Unhandled rejection (가드됨 — 프로세스 유지): ${reason?.message ?? reason}`,
    reason?.stack,
    'ProcessGuard',
  );
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  // M-2: trust the first proxy hop so Express derives req.ip from X-Forwarded-For.
  // NestApplication has no .set(); reach the underlying Express instance.
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);

  const config = app.get(ConfigService);
  const port = config.get<number>('API_PORT', 4000);
  const prefix = (config.get<string>('API_PREFIX', '/v1') || '/v1').trim();
  const corsOrigin = (config.get<string>('CORS_ORIGIN', 'http://localhost:3000') || '').trim();
  const isProduction = (config.get<string>('NODE_ENV') || process.env.NODE_ENV) === 'production';

  // L-1: refuse to boot in production with a weak/missing/example AUTH_SECRET.
  const authSecret = config.get<string>('AUTH_SECRET') || '';
  const KNOWN_DEV_SECRETS = [
    'dev-secret',
    'change-me',
    'changeme',
    'secret',
    'metis-dev-secret',
    'your-secret-here',
  ];
  if (isProduction) {
    if (!authSecret || authSecret.length < 32 || KNOWN_DEV_SECRETS.includes(authSecret)) {
      throw new Error(
        'AUTH_SECRET is missing, too short (<32 chars), or a known dev value. ' +
          'Set a strong unique AUTH_SECRET before starting in production.',
      );
    }
  }

  // Security
  app.use(helmet());

  // Cookie parser (required for CSRF middleware)
  app.use(cookieParser());

  // CORS — M-3: explicit allowlist from env; never wildcard with credentials in prod.
  const corsOrigins = corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (isProduction) {
    if (corsOrigins.length === 0 || corsOrigins.includes('*')) {
      throw new Error(
        'CORS_ORIGIN must be an explicit allowlist in production (wildcard "*" is not ' +
          'allowed with credentials). Set CORS_ORIGIN to your frontend origin(s).',
      );
    }
  }
  // Validate against the allowlist per-request; allow no-origin (curl/SSR) requests.
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Correlation-ID'],
  });

  // CSRF Protection (double submit cookie)
  const csrfMiddleware = new CsrfMiddleware();
  app.use((req: any, res: any, next: any) => csrfMiddleware.use(req, res, next));

  app.setGlobalPrefix(prefix);

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // OpenAPI / Swagger (protected in production)
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Metis.AI API')
      .setDescription('Multi-tenant AgentOps Governance SaaS')
      .setVersion('1.0.0')
      .addBearerAuth()
      .addTag('Auth')
      .addTag('Tenant')
      .addTag('Packs')
      .addTag('Installations')
      .addTag('Executions')
      .addTag('Governance')
      .addTag('Connectors')
      .addTag('Health')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs/openapi.json',
    });
  }

  await app.listen(port);
  Logger.log(`🚀 Metis.AI API running on http://localhost:${port}${prefix}`, 'Bootstrap');
  Logger.log(`📖 OpenAPI docs at http://localhost:${port}/docs`, 'Bootstrap');
}
bootstrap();

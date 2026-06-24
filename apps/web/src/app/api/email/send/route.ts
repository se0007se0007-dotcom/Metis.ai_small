/**
 * Next.js API Route: POST /api/email/send
 *
 * Sends email via SMTP using Nodemailer.
 *
 * Security (G4 / H-8):
 *   - Requires authentication: the request must carry the httpOnly metis_access
 *     cookie. We validate it by calling the backend /auth/me with the cookie.
 *   - SMTP credentials/host/port are read from server env ONLY. Any SMTP config
 *     in the request body is IGNORED. A host allowlist (SMTP_ALLOWED_HOSTS)
 *     gates which servers may be used.
 *   - TLS certificate validation is enforced (rejectUnauthorized: true).
 *   - All inputs are validated. Client-supplied HTML is NOT sent raw — the
 *     route is text-only.
 *   - SMTP error text is never reflected to the client.
 *   - If SMTP env is not configured the route is disabled (501).
 */
import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BACKEND_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && EMAIL_RE.test(value.trim());
}

/** Validate an optional comma/semicolon-separated recipient list. */
function validRecipientList(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const parts = value
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => isValidEmail(p));
}

/** Confirm the caller is authenticated via the httpOnly metis_access cookie. */
async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const accessCookie = request.cookies.get('metis_access')?.value;
  if (!accessCookie) return false;
  try {
    const res = await fetch(`${BACKEND_BASE}/auth/me`, {
      method: 'GET',
      headers: {
        // Forward the cookie so the backend JWT guard can validate it.
        cookie: `metis_access=${accessCookie}`,
        Authorization: `Bearer ${accessCookie}`,
      },
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readSmtpEnv() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = Number(process.env.SMTP_PORT ?? '587');
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const fromEmail = process.env.SMTP_FROM_EMAIL || user;
  const fromName = process.env.SMTP_FROM_NAME || 'Metis.AI';
  const allowed = (process.env.SMTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { host, user, pass, port, secure, fromEmail, fromName, allowed };
}

export async function POST(request: NextRequest) {
  // 1) AuthN
  if (!(await isAuthenticated(request))) {
    return NextResponse.json(
      { success: false, error: '인증이 필요합니다.', timestamp: new Date().toISOString() },
      { status: 401 },
    );
  }

  // 2) Server-side SMTP config only
  const smtp = readSmtpEnv();
  if (!smtp.host || !smtp.user || !smtp.pass) {
    return NextResponse.json(
      {
        success: false,
        error: '이메일 발송이 구성되지 않았습니다. 관리자에게 문의하세요.',
        timestamp: new Date().toISOString(),
      },
      { status: 501 },
    );
  }
  if (smtp.allowed.length === 0 || !smtp.allowed.includes(smtp.host.toLowerCase())) {
    return NextResponse.json(
      {
        success: false,
        error: '이메일 발송이 허용되지 않은 서버로 구성되어 있습니다.',
        timestamp: new Date().toISOString(),
      },
      { status: 501 },
    );
  }

  // 3) Validate inputs (SMTP config in the body is ignored)
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: '잘못된 요청 형식입니다.', timestamp: new Date().toISOString() },
      { status: 400 },
    );
  }

  const to = body.to;
  const subject = body.subject;
  const text = body.body;
  const cc = body.cc;
  const bcc = body.bcc;

  const errors: string[] = [];
  if (!isValidEmail(to)) errors.push('수신자(to)가 올바른 이메일이 아닙니다.');
  if (typeof subject !== 'string' || subject.trim().length === 0 || subject.length > 998)
    errors.push('제목(subject)이 올바르지 않습니다.');
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 100_000)
    errors.push('본문(body)이 올바르지 않습니다.');
  if (!validRecipientList(cc)) errors.push('참조(cc)에 올바르지 않은 이메일이 있습니다.');
  if (!validRecipientList(bcc)) errors.push('숨은참조(bcc)에 올바르지 않은 이메일이 있습니다.');

  if (errors.length > 0) {
    return NextResponse.json(
      {
        success: false,
        error: errors.join(' '),
        timestamp: new Date().toISOString(),
        recipient: isValidEmail(to) ? (to as string) : '',
        subject: typeof subject === 'string' ? subject : '',
      },
      { status: 400 },
    );
  }

  // 4) Send (text-only; client-supplied HTML is intentionally NOT used)
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: true },
    });

    const fromAddress = `"${smtp.fromName}" <${smtp.fromEmail}>`;

    const info = await transporter.sendMail({
      from: fromAddress,
      to: (to as string).trim(),
      subject: (subject as string).trim(),
      text: text as string,
      ...(typeof cc === 'string' && cc ? { cc } : {}),
      ...(typeof bcc === 'string' && bcc ? { bcc } : {}),
    });

    transporter.close();

    return NextResponse.json({
      success: true,
      messageId: info.messageId,
      timestamp: new Date().toISOString(),
      recipient: to as string,
      subject: subject as string,
    });
  } catch (error) {
    // Never reflect raw SMTP error text to the client.
    console.error('Email send failed:', (error as Error).message);
    return NextResponse.json(
      {
        success: false,
        error: '이메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.',
        timestamp: new Date().toISOString(),
        recipient: to as string,
        subject: subject as string,
      },
      { status: 502 },
    );
  }
}

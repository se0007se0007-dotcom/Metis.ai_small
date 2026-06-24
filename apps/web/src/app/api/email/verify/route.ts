/**
 * Next.js API Route: POST /api/email/verify
 *
 * Verifies the server-configured SMTP connection without sending an email.
 *
 * Security (G4 / H-8):
 *   - Requires authentication via the httpOnly metis_access cookie.
 *   - Uses server env SMTP config ONLY (request body is ignored).
 *   - Enforces a host allowlist (SMTP_ALLOWED_HOSTS) and TLS validation.
 *   - Returns generic errors (no raw SMTP text). Disabled (501) if unconfigured.
 */
import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

const BACKEND_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const accessCookie = request.cookies.get('metis_access')?.value;
  if (!accessCookie) return false;
  try {
    const res = await fetch(`${BACKEND_BASE}/auth/me`, {
      method: 'GET',
      headers: {
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
  const allowed = (process.env.SMTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { host, user, pass, port, secure, allowed };
}

export async function POST(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ success: false, error: '인증이 필요합니다.' }, { status: 401 });
  }

  const smtp = readSmtpEnv();
  if (!smtp.host || !smtp.user || !smtp.pass) {
    return NextResponse.json(
      { success: false, error: '이메일 발송이 구성되지 않았습니다. 관리자에게 문의하세요.' },
      { status: 501 },
    );
  }
  if (smtp.allowed.length === 0 || !smtp.allowed.includes(smtp.host.toLowerCase())) {
    return NextResponse.json(
      { success: false, error: '이메일 발송이 허용되지 않은 서버로 구성되어 있습니다.' },
      { status: 501 },
    );
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: true },
    });

    await transporter.verify();
    transporter.close();

    return NextResponse.json({ success: true, message: 'SMTP 연결 성공' });
  } catch (error) {
    console.error('SMTP verify failed:', (error as Error).message);
    return NextResponse.json(
      { success: false, error: 'SMTP 연결 확인에 실패했습니다.' },
      { status: 502 },
    );
  }
}

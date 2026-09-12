import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { readRequestLog, writeRequestLog } from '../../../lib/requestLog';

export const runtime = 'nodejs';

// [서버 가드 — 미들웨어] 이 라우트는 requestId만 받습니다. 제목·본문·수신자를 요청 본문으로
// 다시 받지 않는 이유는, 화면에서 사람이 확인한 초안과 실제로 나가는 메일이 항상 같아야
// 하기 때문입니다 — /api/requests에 등록된 내용을 그대로 씁니다. 그래서:
//   - requestId가 없거나, 등록된 적 없는 값이면 애초에 아무것도 보내지 않습니다.
//     (화면을 거치지 않고 이 API를 직접 호출해도 발송되지 않는다는 뜻입니다.)
//   - 이미 발송된(sentAt이 있는) requestId면 다시 보내지 않습니다(중복 발송 방지).
// "확인 후 발송"이라는 절차를 프롬프트나 화면 흐름이 아니라 이 코드가 강제합니다.
export async function POST(request: Request) {
  try {
    const { requestId } = await request.json() as { requestId?: string };
    if (!requestId) {
      return NextResponse.json({ error: '확인된 요청이 없어 발송할 수 없습니다. 먼저 검토 요청 초안을 등록해 주세요.' }, { status: 400 });
    }

    const entries = await readRequestLog();
    const index = entries.findIndex((entry) => entry.id === requestId);
    if (index === -1) {
      return NextResponse.json({ error: '등록된 요청을 찾을 수 없습니다. 확인 절차를 다시 진행해 주세요.' }, { status: 404 });
    }

    const entry = entries[index];
    if (entry.sentAt) {
      return NextResponse.json({ error: '이미 발송된 요청입니다. 중복 발송을 막기 위해 다시 보내지 않습니다.' }, { status: 409 });
    }
    if (!entry.subject.trim() || !entry.text.trim() || !entry.recipients.length) {
      return NextResponse.json({ error: '등록된 요청에 제목·본문·수신자 정보가 없습니다.' }, { status: 400 });
    }

    const user = process.env.GMAIL_USER;
    const password = process.env.GMAIL_APP_PASSWORD;
    const to = entry.recipients.join(', ') || process.env.GMAIL_TO;
    if (!user || !password || !to) {
      return NextResponse.json({ error: 'GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_TO 설정을 확인해 주세요.' }, { status: 500 });
    }

    const now = new Date().toISOString();
    // .invalid 주소는 일부러 발송이 불가능한 데모용 수신자입니다. SMTP 타임아웃을
    // 기다리지 않고 로컬 흐름만 진행시킵니다.
    let simulated = false;
    if (to.split(',').every((recipient) => recipient.trim().toLowerCase().endsWith('.invalid'))) {
      simulated = true;
    } else {
      const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: password } });
      await transporter.sendMail({ from: user, to, subject: entry.subject.trim(), text: entry.text.trim() });
    }

    entries[index] = { ...entry, sentAt: now, updatedAt: now };
    await writeRequestLog(entries);

    return NextResponse.json({ ok: true, simulated, entry: entries[index] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '메일 발송에 실패했습니다.';
    return NextResponse.json({ error: `메일 발송에 실패했습니다: ${message}` }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { readRequestLog, writeRequestLog, type RequestLogEntry, type RequestStatus } from '../../../lib/requestLog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export async function GET() {
  const entries = await readRequestLog();
  return NextResponse.json({ entries: entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
}

// 이 호출이 "사람이 초안을 확인했다"는 서버 측 기록입니다. 화면에서 초안을 보여주고
// "메일 보내기"를 누르는 순간 실제 발송(POST /api/mail) 전에 먼저 여기로 등록되고,
// 그 결과로 받은 id가 있어야만 /api/mail이 발송을 진행합니다. subject·text·recipients를
// 이 시점에 그대로 저장해 두므로, 등록 이후에는 내용이 바뀔 수 없습니다.
export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<RequestLogEntry>;
    if (!body.question?.trim()) return NextResponse.json({ error: '업무 상황 정보가 필요합니다.' }, { status: 400 });
    if (!body.subject?.trim() || !body.text?.trim()) return NextResponse.json({ error: '메일 제목과 본문이 필요합니다.' }, { status: 400 });
    const recipients = Array.isArray(body.recipients) ? body.recipients.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
    if (!recipients.length) return NextResponse.json({ error: '수신 부서를 최소 1곳 선택해 주세요.' }, { status: 400 });
    const entries = await readRequestLog();
    const now = new Date().toISOString();
    const entry: RequestLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      updatedAt: now,
      question: body.question.trim(),
      site: body.site ?? '미선택',
      category: body.category ?? '자동 분류',
      owner: body.owner?.trim() || '미확정',
      partners: Array.isArray(body.partners) ? body.partners.filter((item): item is string => typeof item === 'string') : [],
      recipients,
      subject: body.subject.trim(),
      text: body.text,
      sentAt: null,
      status: '검토 대기'
    };
    entries.push(entry);
    await writeRequestLog(entries);
    return NextResponse.json({ entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청 이력을 저장하지 못했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// 화면의 상태 트래커(검토 대기 → 검토중 → 회신 완료) 버튼과 연동해 이력에도 같은 상태를 반영합니다.
export async function PATCH(request: Request) {
  try {
    const body = await request.json() as { id?: string; status?: RequestStatus };
    if (!body.id || !body.status) return NextResponse.json({ error: 'id와 status가 필요합니다.' }, { status: 400 });
    const entries = await readRequestLog();
    const index = entries.findIndex((entry) => entry.id === body.id);
    if (index === -1) return NextResponse.json({ error: '해당 요청을 찾을 수 없습니다.' }, { status: 404 });
    // 아직 실제로 발송되지 않은(등록만 된) 요청은 "검토중/회신 완료"로 넘어갈 수 없습니다 —
    // 현업이 검토할 메일 자체가 아직 안 나간 상태이기 때문입니다. sentAt이 명시적으로 null인
    // 경우만 "미발송"으로 봅니다 — 이 필드가 생기기 전(레거시)에 저장된 항목은 sentAt이
    // 아예 없는데(undefined), 그때는 발송이 성공했을 때만 이력이 기록됐으므로 이미 발송된
    // 것으로 취급합니다.
    if (entries[index].sentAt === null) {
      return NextResponse.json({ error: '메일이 아직 발송되지 않아 상태를 변경할 수 없습니다.' }, { status: 409 });
    }
    entries[index] = { ...entries[index], status: body.status, updatedAt: new Date().toISOString() };
    await writeRequestLog(entries);
    return NextResponse.json({ entry: entries[index] });
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청 상태를 업데이트하지 못했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

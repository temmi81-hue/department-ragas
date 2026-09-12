import fs from 'node:fs/promises';
import path from 'node:path';

// /api/requests와 /api/mail이 같은 파일을 공유하기 위한 공용 모듈입니다.
//
// [미들웨어 가드] 발송(POST /api/mail)은 이 로그에 먼저 등록된(requestId가 있는) 요청만
// 실행합니다. 제목·본문·수신자는 발송 시점에 클라이언트가 다시 보내는 값이 아니라
// 여기 저장된 값을 그대로 씁니다 — 확인 화면에서 본 내용과 실제로 나가는 메일이 항상
// 같다는 것을, "그러길 바라는 프롬프트/UI"가 아니라 코드가 보장합니다.
// sentAt이 이미 채워진 요청은 다시 보내지 않습니다(중복 발송 방지).
export const LOG_PATH = path.join(process.cwd(), 'data', 'request-log.json');

export type RequestStatus = '검토 대기' | '검토중' | '회신 완료';
export type RequestLogEntry = {
  id: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  site: string;
  category: string;
  owner: string;
  partners: string[];
  recipients: string[];
  subject: string;
  text: string;
  // null이면 "등록만 되고 아직 발송 전" — /api/mail이 이 값을 보고 발송 여부를 판단합니다.
  sentAt: string | null;
  status: RequestStatus;
};

export async function readRequestLog(): Promise<RequestLogEntry[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function writeRequestLog(entries: RequestLogEntry[]) {
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(LOG_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

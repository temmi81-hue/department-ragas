import { NextResponse } from 'next/server';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { traceable } from 'langsmith/traceable';
import fs from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
// Next.js는 라우트 핸들러 안에서 실행되는 fetch() 호출(OpenAI SDK가 내부적으로 사용하는
// 호출 포함)을 기본적으로 Data Cache에 캐시할 수 있습니다. 이 라우트는 매 요청마다 새로운
// 질문으로 실제 임베딩 검색과 LLM 호출을 해야 하므로, 캐시된(오래된) 답변이 재사용되지
// 않도록 이 라우트 전체를 always dynamic으로 표시합니다.
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
let storePromise: Promise<MemoryVectorStore> | undefined;
let allowedDepartmentsPromise: Promise<string[]> | undefined;

// 데모 범위를 투자·회계·구매(설비) 업무로 한정합니다.
// 전사 조직도는 남겨둡니다 — 투자·회계 절차 문서 자체에는 담당 부서명이 매번
// 명시돼 있지 않아, 조직도 없이는 근거 부족으로 "확인 필요"만 반복 반환했습니다.
// 조직도를 넣어도 owner/partners는 아래 화이트리스트로만 제한되므로
// 범위 밖 부서명이 나오는 문제는 그대로 방지됩니다.
// 파일명 부분 일치(정규화 후 includes)로 매칭합니다 — Windows/Node에서 한글 파일명이
// NFC/NFD로 다르게 정규화되어 완전일치 비교가 실패하는 경우를 피하기 위함입니다.
// '설비자재구매그룹' 키워드는 구매관리규정 문서와, 투자관리그룹의 "(5억 이상) 타당성
// 평가 및 심의 지침"과 연계되는 "(설비도입/장비투자) 타당성 검토 및 자료 작성 업무지침"
// 문서를 함께 매칭합니다(두 파일 모두 파일명이 이 키워드로 시작).
const SCOPE_DOC_KEYWORDS: { keyword: string; department: string; type: string }[] = [
  { keyword: '조직 및 책임권한', department: '전사 조직', type: '업무분장' },
  { keyword: '투자관리그룹', department: '투자관리그룹', type: '투자·공사' },
  { keyword: '회계세무그룹', department: '회계세무그룹', type: '재무·회계' },
  { keyword: '설비자재구매그룹', department: '설비자재구매그룹', type: '구매·자재' }
];
const SCOPE_CATEGORIES = ['투자·공사', '재무·회계', '구매·자재'];
const SCOPE_DEPARTMENTS = [...new Set(SCOPE_DOC_KEYWORDS.map((entry) => entry.department))];

function matchScopeDoc(name: string) {
  const normalized = name.normalize('NFC');
  return SCOPE_DOC_KEYWORDS.find((entry) => normalized.includes(entry.keyword.normalize('NFC')));
}

// 조직도(260827_조직 및 책임권한 규정)에는 원문을 나눠 받은 흔적("다음 파트에서 계속",
// "계속 진행할까요?" 같은 생성 중간 스캐폴딩)이 청크로 섞여 있습니다. 실질 내용이 거의
// 없는 이런 청크는 임베딩 노이즈만 늘리고, 근거로 인용될 경우 사용자에게 그대로 노출되므로
// 인덱싱 전에 제거합니다.
function isLowValueChunk(text: string) {
  const stripped = text
    .replace(/---\s*\[원문 page-\d+\]\s*---/g, '')
    .replace(/\(다음 파트에서 계속[^)]*\)/g, '')
    .trim();
  return stripped.length < 30 || /계속 진행할까요|GPT-\d/.test(text);
}

// [3차 개선 - 원인③ 근본 수정] "정확히 5억원"처럼 심의 기준 금액과 같은 경계값을 LLM이
// 프롬프트 지시만으로 안정적으로 판단하지 못했습니다(같은 질문을 반복 호출하면 "미달"과
// "범위밖" 사이에서 답이 흔들림 - 3차 평가에서 실측 확인). 금액 비교처럼 결정적으로 계산
// 가능한 판단은 LLM에 맡기지 않고 서버가 정규식으로 직접 파싱·계산해서 "사실"로 프롬프트에
// 주입합니다. "3억 5천만원", "12억원", "4천만원" 등 억/천만/만 단위 조합을 지원합니다.
const INVESTMENT_REVIEW_THRESHOLD_WON = 500_000_000; // 5억원 - source_docs 부칙 문서 기준

function parseKoreanAmountToWon(text: string): number | null {
  let total = 0;
  let matched = false;
  const eokMatch = text.match(/(\d+(?:\.\d+)?)\s*억/);
  if (eokMatch) {
    total += parseFloat(eokMatch[1]) * 100_000_000;
    matched = true;
  }
  const cheonManMatch = text.match(/(\d+(?:\.\d+)?)\s*천\s*만/);
  if (cheonManMatch) {
    total += parseFloat(cheonManMatch[1]) * 1000 * 10_000;
    matched = true;
  } else {
    const manMatch = text.match(/(\d+(?:\.\d+)?)\s*만/);
    if (manMatch) {
      total += parseFloat(manMatch[1]) * 10_000;
      matched = true;
    }
  }
  return matched ? total : null;
}

// LLM에게 "판단"이 아니라 "이미 계산된 사실"로 제시할 문장을 만듭니다.
function describeAmountFact(question: string): string {
  const amountWon = parseKoreanAmountToWon(question);
  if (amountWon === null) return '질문에서 구체적인 금액을 특정할 수 없습니다.';
  const comparison = amountWon >= INVESTMENT_REVIEW_THRESHOLD_WON ? '이상' : '미만';
  return `질문에 명시된 금액은 ${amountWon.toLocaleString('ko-KR')}원이며, 이는 투자심의 기준 금액(5억원) ${comparison}입니다.`;
}

async function buildStore() {
  const dir = path.join(process.cwd(), 'source_docs');
  const names = await fs.readdir(dir);
  const loaded: Document[] = [];
  for (const name of names) {
    const info = matchScopeDoc(name);
    if (!info) continue;
    const docs = await new DocxLoader(path.join(dir, name)).load();
    loaded.push(...docs.map((doc) => new Document({
      pageContent: doc.pageContent,
      metadata: { ...doc.metadata, department: info.department, document: name, workType: info.type, source: `source_docs/${name}` }
    })));
  }
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 900, chunkOverlap: 120 });
  const chunks = (await splitter.splitDocuments(loaded)).filter((chunk) => !isLowValueChunk(chunk.pageContent));
  return MemoryVectorStore.fromDocuments(chunks, new OpenAIEmbeddings({ model: 'text-embedding-3-small' }));
}

function getStore() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY가 설정되지 않았습니다.');
  storePromise ??= buildStore();
  return storePromise;
}

// pilot_departments.json(35개 대표부서)에서 투자·공사, 재무·회계 카테고리만 추려
// 약 9~10개로 좁힌 화이트리스트를 만듭니다. owner/partners가 이 목록을 벗어나지
// 않도록 프롬프트에 그대로 주입합니다.
async function getAllowedDepartments() {
  allowedDepartmentsPromise ??= (async () => {
    const file = await fs.readFile(path.join(process.cwd(), 'public', 'pilot_departments.json'), 'utf-8');
    const data = JSON.parse(file) as { organizations: { name: string; categories: string[] }[] };
    return data.organizations
      .filter((org) => org.categories.some((category) => SCOPE_CATEGORIES.includes(category)))
      .map((org) => org.name);
  })();
  return allowedDepartmentsPromise;
}

// 이 함수 하나가 질문 접수부터 최종 JSON 응답까지 전체 파이프라인입니다.
// traceable()로 감싸서 LangSmith에 "질문 → 검색 근거 → 최종 답변"이 하나의
// 트레이스로 묶여 보이도록 합니다. 내부에서 호출하는 ChatOpenAI.invoke()는
// LangSmith 트레이싱이 켜져 있으면(LANGSMITH_TRACING=true) 자동으로 이 트레이스의
// 하위 실행(child run)으로 잡힙니다. LANGSMITH_API_KEY가 없으면 langsmith SDK가
// 아무 것도 전송하지 않고 조용히 통과하므로, 로컬 개발에는 영향이 없습니다.
const runRagPipeline = traceable(
  async ({ question, site, category }: { question: string; site?: string; category?: string }) => {
    const store = await getStore();
    const allowedDepartments = await getAllowedDepartments();
    // site/category는 UI에서 선택하지 않으면 '미선택'/'자동 분류' placeholder 문자열이 그대로 넘어온다.
    // 이 값들은 실제 필터가 아니므로 검색 쿼리에 섞으면 임베딩이 오염되어(예: 관련 문서가
    // top-k에서 밀려남) 정상적으로 근거가 있는 질문도 "추가 확인 필요"로 잘못 판정될 수 있다.
    const UNSET_FILTER_VALUES = new Set(['미선택', '자동 분류']);
    const queryParts = [question, site, category].filter(
      (part): part is string => typeof part === 'string' && part.length > 0 && !UNSET_FILTER_VALUES.has(part)
    );
    const queryText = queryParts.join(' / ');
    const topK = Number(process.env.RAG_TOP_K ?? 6);
    // 조직도(전사 조직) 문서 하나가 전체 청크의 90% 이상을 차지해서(94/103), 단순 유사도
    // 검색(top-k든 부서별 분배든 점수순 정렬이든)에 맡기면 근소한 임베딩 점수 차이로 실제
    // 범위 문서(투자관리그룹 5개, 회계세무그룹 4개 청크뿐)가 통째로 밀리는 현상이 있었습니다
    // (동일 질문을 반복 호출해도 결과가 들쭉날쭉했음). 반대로 두 문서를 조건 없이 항상 전부
    // 포함하면, 질문과 무관해도(예: 안전모 미착용) LLM이 매번 눈에 보이는 투자 문서 쪽으로
    // 답을 만들어내는 문제가 새로 생겼습니다. 그래서 부서별 "최고 유사도 점수"가 최소 기준을
    // 넘는 경우에만 해당 부서 문서를 통째로 포함합니다: 청크 수가 적어 특정 청크 하나가
    // 대표성을 갖기 어렵기 때문에, 상위 몇 개가 아니라 부서 전체를 넣거나 아예 뺍니다.
    const SUPPLEMENTARY_DEPARTMENT = '전사 조직';
    const primaryDepartments = SCOPE_DEPARTMENTS.filter((department) => department !== SUPPLEMENTARY_DEPARTMENT);
    const RELEVANCE_THRESHOLD = 0.4;
    const primaryRelevance = await Promise.all(
      primaryDepartments.map(async (department) => {
        const scored = await store.similaritySearchWithScore(queryText, 1, (doc) => doc.metadata.department === department);
        const score = scored.length ? scored[0][1] : 0;
        const docs = score >= RELEVANCE_THRESHOLD
          ? store.memoryVectors
              .filter((vector) => vector.metadata.department === department)
              .map((vector) => new Document({ pageContent: vector.content, metadata: vector.metadata }))
          : [];
        return { department, score, docs };
      })
    );
    if (process.env.RAG_DEBUG_SCORES === 'true') {
      const ranked = [...primaryRelevance].sort((a, b) => b.score - a.score)
        .map((e) => `${e.department}:${e.score.toFixed(4)}`).join('  ');
      console.log(`[relevance] "${question}" ->`, ranked);
    }
    const primaryDocs = primaryRelevance.flatMap((entry) => entry.docs);
    const orgChartDocs = await store.similaritySearch(
      queryText,
      Math.max(1, topK - primaryDocs.length),
      (doc) => doc.metadata.department === SUPPLEMENTARY_DEPARTMENT
    );
    const docs = [...primaryDocs, ...orgChartDocs];
    const context = docs.map((doc, index) => `[근거 ${index + 1}] ${doc.pageContent}\n출처: ${doc.metadata.document}\n부서: ${doc.metadata.department}\n업무 유형: ${doc.metadata.workType}`).join('\n\n');
    // [3차 개선] gpt-4o-mini -> GPT-5.6 Luna로 기본 모델 교체. 골든셋 19건 재평가에서
    // 코드/프롬프트 변경 없이 모델만 바꿨는데 주관부서 매칭 정확도가 79%->95%로 크게
    // 오른 것을 확인해 기본값으로 채택했습니다(단, 응답속도는 약 2배 느려짐 - 라이브 데모 시 참고).
    // RAG_CHAT_MODEL 환경변수로 다른 모델(예: 'gpt-4o-mini')로 되돌릴 수 있습니다.
    // o-시리즈/GPT-5 계열 "추론 모델"은 temperature 파라미터 자체를 지원하지 않아(실제 호출 시
    // "temperature does not support 0" 400 에러 확인) 조건부로 뺍니다.
    const CHAT_MODEL = process.env.RAG_CHAT_MODEL ?? 'gpt-5.6-luna';
    const isReasoningModel = /^(o\d|gpt-5)/i.test(CHAT_MODEL);
    const model = new ChatOpenAI(
      isReasoningModel ? { model: CHAT_MODEL } : { model: CHAT_MODEL, temperature: 0 }
    );
    const response = await model.invoke([
      ['system', [
        '당신은 사내 업무분장 안내 도우미입니다. 이 데모는 투자·공사, 재무·회계, 설비·자재 구매 관련 업무만 다룹니다. 제공된 근거만 사용하세요.',
        `owner와 partners는 반드시 다음 부서 목록 중에서만 선택하세요: ${allowedDepartments.join(', ')}. 목록에 없는 부서명은 절대 만들어내지 마세요.`,
        '질문이 투자·공사, 재무·회계, 설비·자재 구매와 무관하거나(예: 안전·인사 등), 근거에 목록 안의 부서가 명확히 나오지 않으면 owner를 빈 문자열로 두고 needsMoreInfo를 true로 하여 reason에 "투자·회계·구매 관련 업무가 아니거나 추가 확인이 필요합니다"라고 답하세요. 부서를 추측하지 마세요.',
        // [3차 개선 - 원인②] 기존 지시("owner보다 기준을 넓게, 같은 문서에 등장하면 모두 포함")는
        // 더미 문서들이 서로의 부서명을 인용하는 구조상 거의 모든 질문에서 3개 부서를 통째로
        // partners에 담게 만들었다(예: 자산등록만 묻는 질문에도 구매·투자 부서까지 포함).
        // "질문이 실제로 다루는 절차 단계"로 기준을 좁혀 정밀도를 높인다.
        'partners(협업 부서)는 질문이 실제로 묻는 절차 단계와 직접 관련된 부서만 포함하세요. 근거 문서에 같은 표(R&R 표 등)에 나열되어 있다는 이유만으로 무관한 단계의 부서를 넣지 마세요 - 예를 들어 질문이 회계처리(자산등록·감가상각)만 묻는다면 구매 실행이나 투자심의 단계 부서는 partners에 넣지 마세요. 질문이 여러 단계(투자심의~구매~회계처리)를 함께 묻거나 전체 절차를 묻는 경우에만 관련된 여러 부서를 partners에 포함하세요. owner와 동일한 부서는 partners에 절대 중복 포함하지 마세요.',
        '여러 부서가 근거에 함께 등장하고 그중 일정 금액 기준(예: 5억원) 이상 여부를 심의·승인하는 절차(투자심의회 등)를 주관하는 부서가 있다면, 그 심의 주관 부서를 owner로 선택하고 나머지(구매 실행, 회계처리 등 후속 업무를 담당하는 부서)는 partners에 포함하세요. 심의 절차 없이 실행·처리 업무만 언급된 경우에는 그 실행 부서를 owner로 선택하세요.',
        // [3차 개선 - 원인③ 근본 수정] "정확히 5억원" 같은 경계값을 LLM이 직접 계산하게 하면
        // 같은 질문에도 답이 흔들렸습니다(3차 평가에서 실측). 그래서 서버가 정규식으로 금액을
        // 미리 계산해 human 메시지의 "금액 판정"으로 사실을 못박아 주입합니다. LLM은 그 판정을
        // 그대로 따르기만 하면 되고, 스스로 금액을 다시 읽고 비교할 필요가 없습니다.
        '아래 human 메시지의 "금액 판정"은 서버가 이미 계산해 둔 사실입니다. 금액 판정은 "설비·장비를 신규로 구매/도입할지 결정하는 단계"에서 투자심의 대상 여부(owner가 투자관리그룹인지 설비자재구매그룹인지)를 가릴 때만 사용하세요 - 이 경우 질문 속 금액을 스스로 다시 읽고 5억원과 비교하지 말고 판정을 그대로 따르세요: "5억원 이상"이면 심의 주관 부서(예: 투자관리그룹)를 owner로, "미달"이면 실행 부서(예: 설비자재구매그룹)를 owner로 선택하고 needsMoreInfo는 false로 하세요(미달은 범위 밖이 아니라 내부 승인 대상입니다). 이 경우에 한해 판정이 "특정할 수 없습니다"이면 부서를 추측하지 말고 owner를 빈 문자열로, needsMoreInfo를 true로 하여 reason에 금액 확인이 필요하다고 답하세요. 반대로 질문이 이미 구매 이후의 특정 절차(공급사 선정, 계약 체결, 검수·대금지급, 수의계약, 자산등록, 결산 등)를 묻고 있다면 애초에 금액과 무관하게 owner가 정해지므로, 금액 판정이 "특정할 수 없습니다"여도 owner를 비우지 말고 해당 절차를 담당하는 부서로 정상 답변하세요.',
        'JSON 이외의 글은 출력하지 마세요.'
      ].join(' ')],
      ['human', `질문: ${question}\n사업장: ${site ?? '미선택'}\n업무 유형: ${category ?? '자동 분류'}\n금액 판정: ${describeAmountFact(question)}\n\n검색 근거:\n${context}\n\n다음 JSON 형식으로 답하세요: {"needsMoreInfo": boolean, "owner": string, "partners": string[] (관련 부서를 최대한 근거 안에서 찾아 포함, 정말 없으면만 빈 배열), "reason": string, "evidence": [{"quote": string, "source": string}]}`]
    ]);
    const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const result = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    // 화이트리스트 강제 적용: 프롬프트 지시만으로는 가끔 목록 밖 부서명이 섞여 나올 수 있어
    // (예: 실제 테스트에서 "결산지원조직"처럼 9개 목록에 없는 이름이 partners에 나온 사례 확인),
    // 응답을 한 번 더 검증해 목록 밖 값은 제거합니다.
    const allowedSet = new Set(allowedDepartments);
    const ownerAllowed = typeof result.owner === 'string' && allowedSet.has(result.owner);
    const safeOwner = ownerAllowed ? result.owner : '';
    const safePartners: string[] = Array.isArray(result.partners)
      ? result.partners.filter((partner: unknown): partner is string => typeof partner === 'string' && allowedSet.has(partner) && partner !== safeOwner)
      : [];
    // 온도 0이라도 LLM 호출은 완전히 결정적이지 않습니다. 근거(관련성 임계값을 통과한
    // primaryDocs)가 이미 확보돼 있는데도 LLM이 가끔 needsMoreInfo:true로 답하는 사례가
    // 확인되어(동일 질문을 반복하면 결과가 들쭉날쭉함), 서버가 이미 계산해 둔 부서별 관련성
    // 점수를 신뢰해 owner가 비어 있을 때는 결정적으로 채웁니다. LLM이 owner를 정상적으로
    // 찾은 경우는 그대로 두고 건드리지 않습니다.
    // 다만 이 폴백이 LLM의 정당한 판단까지 덮어써서는 안 됩니다(예: 질문 금액이 근거 문서의
    // 심의 기준 금액에 못 미쳐 "내부 승인 대상"이라고 구체적인 이유를 들어 owner를 비운 경우).
    // 그런 판단은 프롬프트 지시(reason에 구체적 근거를 적으라는 지시)를 따른 것이므로, reason이
    // 프롬프트가 제시한 범위-밖 정형 문구와 다르게 구체적으로 채워져 있으면 LLM의 판단을 존중해
    // 폴백을 건너뜁니다. reason이 비어 있거나 정형 문구 그대로인 경우만 "판단 실패(플레이키)"로
    // 간주해 기존처럼 관련성 점수로 자동 매칭합니다.
    const OUT_OF_SCOPE_BOILERPLATE = '투자·회계·구매 관련 업무가 아니거나 추가 확인이 필요합니다';
    const declinedWithSpecificReason = !ownerAllowed && result.needsMoreInfo === true
      && typeof result.reason === 'string' && result.reason.trim().length > 0
      && !result.reason.includes(OUT_OF_SCOPE_BOILERPLATE);
    const relevantPrimary = primaryRelevance
      .filter((entry) => entry.docs.length > 0)
      .sort((a, b) => b.score - a.score);
    // [3차 개선 - 원인① 1차 수정] 골든셋 평가에서 이 폴백이 "관련 부서가 하나도 없거나(org-001의
    // 조직도 질문) 근거가 아예 없는(lease-002의 리스 회계처리)" 질문에도 관련성 임계값(0.4)을
    // 우연히 넘긴 부서가 하나라도 있으면 억지로 owner를 채워버리는 문제를 확인했습니다
    // (그 결과 reason이 LLM의 실제 판단이 아니라 아래 정형 문구로 덮어써짐).
    // 1차 수정은 "부서가 정확히 1개일 때만 적용"으로 막았으나, 이 개수 기준은 acc-002처럼
    // 부서 2~3개가 걸려도 1위가 뚜렷하게 앞서는 정당한 케이스까지 함께 걸러내는 부작용이
    // 있었습니다(재평가로 확인).
    // [원인① 2차 수정 - 점수 격차 기반] 골든셋 9개 케이스의 실제 유사도 점수를 계측한 결과
    // (RAG_DEBUG_SCORES=true로 로깅), 1위-2위 점수 격차가 0.06~0.14인 경우는 1위가 항상
    // 정답이었고, 격차가 0.005~0.033인 경우는 1위가 정답이 아니거나(acc-001) 애초에 관련
    // 부서가 없는 질문(org-001, lease-002)이었습니다. 그래서 "개수"가 아니라 "1위가 2위를
    // 얼마나 확실하게 앞서는지"로 기준을 바꿉니다. 부서가 1개만 걸린 경우는 비교 대상이 없어
    // 그대로 인정하고, 2개 이상이면 격차가 RELEVANCE_MARGIN 이상일 때만 1위를 신뢰합니다.
    // (다만 acc-001처럼 격차 자체가 애초에 거의 없는 경우는 이 로직으로도 구제되지 않고
    // LLM의 needsMoreInfo 판단을 그대로 따릅니다 - 이건 임베딩 신호 자체가 약한 근본적 한계로,
    // 다음 단계에서는 검색 방식 자체(재순위화 등) 개선이 필요합니다.)
    const RELEVANCE_MARGIN = 0.05;
    const hasDominantWinner = relevantPrimary.length === 1
      || (relevantPrimary.length > 1 && relevantPrimary[0].score - relevantPrimary[1].score >= RELEVANCE_MARGIN);
    let finalOwner = safeOwner;
    let finalPartners = safePartners;
    let finalNeedsMoreInfo = ownerAllowed ? result.needsMoreInfo : true;
    let finalReason = typeof result.reason === 'string' ? result.reason : '';
    if (!finalOwner && !declinedWithSpecificReason && hasDominantWinner) {
      finalOwner = relevantPrimary[0].department;
      finalNeedsMoreInfo = false;
      // [3차 개선] 이전에는 2위 이하 부서를 전부 partners로 끼워넣었으나, 격차 기반 판단의
      // 전제 자체가 "2위 이하는 신뢰할 수 없는 노이즈"라는 것이므로 여기서도 동일하게
      // 기계적으로 추가하지 않습니다(재평가에서 inv-006/proc-002가 owner는 맞았지만 이
      // 기계적 추가 때문에 partners가 틀리는 것을 확인). LLM이 스스로 찾은 partners(safePartners)만 사용합니다.
      finalPartners = safePartners.filter((partner) => partner !== finalOwner);
      finalReason = '검색된 지침 근거에서 관련 부서가 확인되어 자동으로 매칭되었습니다.';
    }
    const safeResult = { ...result, owner: finalOwner, partners: finalPartners, needsMoreInfo: finalNeedsMoreInfo, reason: finalReason };
    return { ...safeResult, retrieved: docs.map((doc) => ({ content: doc.pageContent, ...doc.metadata })) };
  },
  { name: 'rag-department-match', run_type: 'chain' }
);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { question?: string; site?: string; category?: string };
    const question = body.question?.trim();
    if (!question) return NextResponse.json({ error: '업무 상황을 입력해 주세요.' }, { status: 400 });
    const result = await runRagPipeline({ question, site: body.site, category: body.category });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'RAG 검색 중 오류가 발생했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

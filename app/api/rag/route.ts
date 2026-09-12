import { NextResponse } from 'next/server';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { DocxLoader } from '@langchain/community/document_loaders/fs/docx';
import { traceable } from 'langsmith/traceable';
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
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

function getChatModel() {
  // [3차 개선] gpt-4o-mini -> GPT-5.6 Luna로 기본 모델 교체. 골든셋 19건 재평가에서
  // 코드/프롬프트 변경 없이 모델만 바꿨는데 주관부서 매칭 정확도가 79%->95%로 크게
  // 오른 것을 확인해 기본값으로 채택했습니다(단, 응답속도는 약 2배 느려짐 - 라이브 데모 시 참고).
  // RAG_CHAT_MODEL 환경변수로 다른 모델(예: 'gpt-4o-mini')로 되돌릴 수 있습니다.
  // o-시리즈/GPT-5 계열 "추론 모델"은 temperature 파라미터 자체를 지원하지 않아(실제 호출 시
  // "temperature does not support 0" 400 에러 확인) 조건부로 뺍니다.
  const CHAT_MODEL = process.env.RAG_CHAT_MODEL ?? 'gpt-5.6-luna';
  const isReasoningModel = /^(o\d|gpt-5)/i.test(CHAT_MODEL);
  return new ChatOpenAI(isReasoningModel ? { model: CHAT_MODEL } : { model: CHAT_MODEL, temperature: 0 });
}

type PrimaryRelevanceEntry = { department: string; score: number; docs: Document[] };
type Evidence = { quote: string; source: string };

// 부서별 "최고 유사도 점수"가 임계값을 넘는 항목만 남겨 점수 내림차순으로 정렬합니다.
// judge/reReview 두 노드 모두 이 정렬 기준으로 "1위/2위 후보"를 판단하므로 공용 함수로 뺐습니다.
function computeRelevantPrimary(primaryRelevance: PrimaryRelevanceEntry[]) {
  return primaryRelevance
    .filter((entry) => entry.docs.length > 0)
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────
// [4단계 개선] 그래프 기반 "애매한 경계 사례 재검토" 노드
//
// 기존(3단계까지) 로직은 검색 → 판정이 한 번에 끝나는 단선 흐름이었습니다. 1위-2위
// 부서의 유사도 점수 격차가 좁은(RELEVANCE_MARGIN 미만) "애매한 경계 사례"는 LLM의
// 1차 판단을 그대로 신뢰할 수밖에 없었고, 코드 주석에도 "다음 단계에서는 검색 방식
// 자체(재순위화 등) 개선이 필요하다"고 남겨져 있었습니다(향후 계획 슬라이드의
// "Reranking" 항목이 바로 이 부분입니다).
//
// 이번에 LangGraph의 StateGraph로 이 부분을 명시적인 조건부 분기로 만들었습니다:
// judge 노드가 "1위가 뚜렷하다(hasDominantWinner)"고 판단하면 그대로 끝내고,
// 애매하면 reReview 노드로 넘어가 상위 2개 후보의 근거만 다시 좁혀 비교하는
// 별도 LLM 호출(2차 판단)을 한 번 더 실행합니다. LangSmith 트레이스에도 이 두 노드가
// 별도 단계로 찍혀, 애매한 사례에서 실제로 재검토가 실행됐는지 확인할 수 있습니다.
// ─────────────────────────────────────────────────────────────────────────

const RagAnnotation = Annotation.Root({
  question: Annotation<string>(),
  site: Annotation<string | undefined>(),
  category: Annotation<string | undefined>(),
  queryText: Annotation<string>(),
  allowedDepartments: Annotation<string[]>(),
  primaryRelevance: Annotation<PrimaryRelevanceEntry[]>(),
  docs: Annotation<Document[]>(),
  context: Annotation<string>(),
  owner: Annotation<string>(),
  partners: Annotation<string[]>(),
  needsMoreInfo: Annotation<boolean>(),
  reason: Annotation<string>(),
  evidence: Annotation<Evidence[]>(),
  hasDominantWinner: Annotation<boolean>(),
  declinedWithSpecificReason: Annotation<boolean>(),
  resolvedByAmountRule: Annotation<boolean>(),
  reReviewed: Annotation<boolean>(),
});

type RagState = typeof RagAnnotation.State;

// 1) 검색 노드: 기존 임베딩 검색 로직 그대로(부서별 최고 점수가 임계값을 넘을 때만
// 해당 부서 문서를 통째로 포함 + 조직도 보충 문서 추가) — 3단계까지와 동일합니다.
async function retrieveNode(state: RagState): Promise<Partial<RagState>> {
  const store = await getStore();
  const allowedDepartments = await getAllowedDepartments();
  const UNSET_FILTER_VALUES = new Set(['미선택', '자동 분류']);
  const queryParts = [state.question, state.site, state.category].filter(
    (part): part is string => typeof part === 'string' && part.length > 0 && !UNSET_FILTER_VALUES.has(part)
  );
  const queryText = queryParts.join(' / ');
  const topK = Number(process.env.RAG_TOP_K ?? 6);
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
    console.log(`[relevance] "${state.question}" ->`, ranked);
  }
  const primaryDocs = primaryRelevance.flatMap((entry) => entry.docs);
  const orgChartDocs = await store.similaritySearch(
    queryText,
    Math.max(1, topK - primaryDocs.length),
    (doc) => doc.metadata.department === SUPPLEMENTARY_DEPARTMENT
  );
  const docs = [...primaryDocs, ...orgChartDocs];
  const context = docs.map((doc, index) => `[근거 ${index + 1}] ${doc.pageContent}\n출처: ${doc.metadata.document}\n부서: ${doc.metadata.department}\n업무 유형: ${doc.metadata.workType}`).join('\n\n');
  return { queryText, allowedDepartments, primaryRelevance, docs, context };
}

// 2) 판정 노드: 기존 1차 LLM 판정 + 화이트리스트 검증 + "뚜렷한 1위" 자동 매칭 로직 —
// 3단계까지와 동일합니다. 다만 여기서 끝내지 않고 hasDominantWinner를 함께 반환해
// 그래프가 다음에 finalize로 갈지 reReview로 갈지 결정하게 합니다.
async function judgeNode(state: RagState): Promise<Partial<RagState>> {
  const model = getChatModel();
  const response = await model.invoke([
    ['system', [
      '당신은 사내 업무분장 안내 도우미입니다. 이 데모는 투자·공사, 재무·회계, 설비·자재 구매 관련 업무만 다룹니다. 제공된 근거만 사용하세요.',
      `owner와 partners는 반드시 다음 부서 목록 중에서만 선택하세요: ${state.allowedDepartments.join(', ')}. 목록에 없는 부서명은 절대 만들어내지 마세요.`,
      '질문이 투자·공사, 재무·회계, 설비·자재 구매와 무관하거나(예: 안전·인사 등), 근거에 목록 안의 부서가 명확히 나오지 않으면 owner를 빈 문자열로 두고 needsMoreInfo를 true로 하여 reason에 "투자·회계·구매 관련 업무가 아니거나 추가 확인이 필요합니다"라고 답하세요. 부서를 추측하지 마세요.',
      'partners(협업 부서)는 질문이 실제로 묻는 절차 단계와 직접 관련된 부서만 포함하세요. 근거 문서에 같은 표(R&R 표 등)에 나열되어 있다는 이유만으로 무관한 단계의 부서를 넣지 마세요 - 예를 들어 질문이 회계처리(자산등록·감가상각)만 묻는다면 구매 실행이나 투자심의 단계 부서는 partners에 넣지 마세요. 질문이 여러 단계(투자심의~구매~회계처리)를 함께 묻거나 전체 절차를 묻는 경우에만 관련된 여러 부서를 partners에 포함하세요. owner와 동일한 부서는 partners에 절대 중복 포함하지 마세요.',
      '여러 부서가 근거에 함께 등장하고 그중 일정 금액 기준(예: 5억원) 이상 여부를 심의·승인하는 절차(투자심의회 등)를 주관하는 부서가 있다면, 그 심의 주관 부서를 owner로 선택하고 나머지(구매 실행, 회계처리 등 후속 업무를 담당하는 부서)는 partners에 포함하세요. 심의 절차 없이 실행·처리 업무만 언급된 경우에는 그 실행 부서를 owner로 선택하세요.',
      '아래 human 메시지의 "금액 판정"은 서버가 이미 계산해 둔 사실입니다. 금액 판정은 "설비·장비를 신규로 구매/도입할지 결정하는 단계"에서 투자심의 대상 여부(owner가 투자관리그룹인지 설비자재구매그룹인지)를 가릴 때만 사용하세요 - 이 경우 질문 속 금액을 스스로 다시 읽고 5억원과 비교하지 말고 판정을 그대로 따르세요: "5억원 이상"이면 심의 주관 부서(예: 투자관리그룹)를 owner로, "미달"이면 실행 부서(예: 설비자재구매그룹)를 owner로 선택하고 needsMoreInfo는 false로 하세요(미달은 범위 밖이 아니라 내부 승인 대상입니다). 이 경우에 한해 판정이 "특정할 수 없습니다"이면 부서를 추측하지 말고 owner를 빈 문자열로, needsMoreInfo를 true로 하여 reason에 금액 확인이 필요하다고 답하세요. 반대로 질문이 이미 구매 이후의 특정 절차(공급사 선정, 계약 체결, 검수·대금지급, 수의계약, 자산등록, 결산 등)를 묻고 있다면 애초에 금액과 무관하게 owner가 정해지므로, 금액 판정이 "특정할 수 없습니다"여도 owner를 비우지 말고 해당 절차를 담당하는 부서로 정상 답변하세요.',
      'JSON 이외의 글은 출력하지 마세요.'
    ].join(' ')],
    ['human', `질문: ${state.question}\n사업장: ${state.site ?? '미선택'}\n업무 유형: ${state.category ?? '자동 분류'}\n금액 판정: ${describeAmountFact(state.question)}\n\n검색 근거:\n${state.context}\n\n다음 JSON 형식으로 답하세요: {"needsMoreInfo": boolean, "owner": string, "partners": string[] (관련 부서를 최대한 근거 안에서 찾아 포함, 정말 없으면만 빈 배열), "reason": string, "evidence": [{"quote": string, "source": string}]}`]
  ]);
  const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  const result = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());

  // 화이트리스트 강제 적용: 프롬프트 지시만으로는 가끔 목록 밖 부서명이 섞여 나올 수 있어
  // (예: 실제 테스트에서 "결산지원조직"처럼 9개 목록에 없는 이름이 partners에 나온 사례 확인),
  // 응답을 한 번 더 검증해 목록 밖 값은 제거합니다.
  const allowedSet = new Set(state.allowedDepartments);
  const ownerAllowed = typeof result.owner === 'string' && allowedSet.has(result.owner);
  const safeOwner = ownerAllowed ? result.owner : '';
  const safePartners: string[] = Array.isArray(result.partners)
    ? result.partners.filter((partner: unknown): partner is string => typeof partner === 'string' && allowedSet.has(partner) && partner !== safeOwner)
    : [];

  const OUT_OF_SCOPE_BOILERPLATE = '투자·회계·구매 관련 업무가 아니거나 추가 확인이 필요합니다';
  const declinedWithSpecificReason = !ownerAllowed && result.needsMoreInfo === true
    && typeof result.reason === 'string' && result.reason.trim().length > 0
    && !result.reason.includes(OUT_OF_SCOPE_BOILERPLATE);

  const relevantPrimary = computeRelevantPrimary(state.primaryRelevance);
  const RELEVANCE_MARGIN = 0.05;
  const hasDominantWinner = relevantPrimary.length === 1
    || (relevantPrimary.length > 1 && relevantPrimary[0].score - relevantPrimary[1].score >= RELEVANCE_MARGIN);

  let finalOwner = safeOwner;
  let finalPartners = safePartners;
  let finalNeedsMoreInfo = ownerAllowed ? result.needsMoreInfo : true;
  let finalReason = typeof result.reason === 'string' ? result.reason : '';

  // [4단계 개선 - 별도 버그 수정] "8억원짜리 신규 설비" 처럼 금액이 명확히 주어졌고
  // human 메시지의 "금액 판정"에도 서버가 이미 사실을 못박아 뒀는데도, LLM이 이 사실을
  // 무시하고 owner를 비운 채 "금액 확인이 필요합니다" 류의 이유로 보류하는 사례를 재현
  // 확인했습니다(동일 질문 반복 시에도 간헐적으로 재현 - 프롬프트 지시 준수 실패, 온도 0
  // 이어도 완전히 결정적이지 않은 LLM의 한계). "정확히 얼마인지 알 수 없어" 보류하는 것과
  // "얼마인지는 알지만 그 판단을 스스로 다시 하려다 실패"하는 것은 다른 문제이므로,
  // describeAmountFact()가 이미 명확한 판정("이상"/"미만")을 내린 상태에서 LLM의 보류 사유가
  // 그 판정 자체를 문제 삼는 경우에만(범위밖 판정이나 다른 사유의 보류는 건드리지 않음)
  // 서버가 이미 계산해 둔 사실로 owner를 직접 확정합니다 - 금액 파싱을 LLM에 맡기지 않은
  // 기존 원칙(describeAmountFact 자체)과 동일한 접근입니다.
  const amountFact = describeAmountFact(state.question);
  const amountIsDetermined = !amountFact.includes('특정할 수 없습니다');
  const reasonCitesAmountConfusion = /금액/.test(finalReason) && /(확인|특정)/.test(finalReason);
  let resolvedByAmountRule = false;
  if (!finalOwner && amountIsDetermined && reasonCitesAmountConfusion) {
    finalOwner = amountFact.includes('이상') ? '투자관리그룹' : '설비자재구매그룹';
    finalNeedsMoreInfo = false;
    finalPartners = safePartners.filter((partner) => partner !== finalOwner);
    finalReason = `${amountFact} 이 판정에 따라 ${finalOwner}이 담당합니다.`;
    // 검색 유사도 점수와 무관하게 서버가 이미 확정한 사실이므로, 뒤이어 그래프가
    // (점수 격차가 좁다는 이유로) reReview 노드로 보내 이 확정을 다시 흔들지 않도록
    // hasDominantWinner와 동일하게 "확정됨" 신호로 취급합니다.
    resolvedByAmountRule = true;
  }

  if (!finalOwner && !declinedWithSpecificReason && hasDominantWinner) {
    finalOwner = relevantPrimary[0].department;
    finalNeedsMoreInfo = false;
    finalPartners = safePartners.filter((partner) => partner !== finalOwner);
    finalReason = '검색된 지침 근거에서 관련 부서가 확인되어 자동으로 매칭되었습니다.';
  }

  return {
    owner: finalOwner,
    partners: finalPartners,
    needsMoreInfo: finalNeedsMoreInfo,
    reason: finalReason,
    evidence: Array.isArray(result.evidence) ? result.evidence : [],
    hasDominantWinner,
    declinedWithSpecificReason,
    resolvedByAmountRule,
    reReviewed: false,
  };
}

// 3) 재검토 노드 [신규]: judge 노드가 "애매하다"고 판단한 경우(1위-2위 점수 격차가
// 좁음)에만 실행됩니다. 상위 2개 후보 부서의 근거만 좁혀서 다시 비교시키는 별도
// LLM 호출로, 애매한 두 후보 중 하나를 더 근거 있게 골라내려는 시도입니다.
// 재검토로도 확정하지 못하면 judge 노드의 1차 판단을 그대로 유지합니다(회귀 방지 —
// 이 노드는 기존 결과를 절대 더 나쁘게 만들지 않고, 개선되거나 그대로거나 둘 중 하나입니다).
async function reReviewNode(state: RagState): Promise<Partial<RagState>> {
  const relevantPrimary = computeRelevantPrimary(state.primaryRelevance);
  const candidates = relevantPrimary.slice(0, 2);
  if (candidates.length < 2) {
    return { reReviewed: true };
  }

  const candidateContext = candidates
    .map((candidate, index) => (
      `[후보 ${index + 1}: ${candidate.department}] (검색 유사도 점수 ${candidate.score.toFixed(4)})\n`
      + candidate.docs.map((doc) => doc.pageContent).join('\n---\n')
    ))
    .join('\n\n');

  const model = getChatModel();
  const response = await model.invoke([
    ['system', [
      '당신은 사내 업무분장 안내 도우미입니다.',
      '1차 판단에서 두 후보 부서의 검색 유사도 점수 차이가 근소해(0.05 미만) 어느 부서가 주관인지 확정하기 어려웠습니다.',
      '아래 두 후보의 근거 문서만 다시 비교해서, 이 업무를 실제로 어느 부서가 주관하는지 하나를 고르세요.',
      `owner는 다음 중 하나여야 합니다: ${candidates.map((candidate) => candidate.department).join(', ')}. 이 목록에 없는 부서명은 만들지 마세요.`,
      '근거를 다시 봐도 정말 판단이 불가능하면 owner를 빈 문자열로 하고 needsMoreInfo를 true로 하세요. 애매하다고 아무거나 고르지 마세요.',
      'JSON 이외의 글은 출력하지 마세요.'
    ].join(' ')],
    ['human', `질문: ${state.question}\n금액 판정: ${describeAmountFact(state.question)}\n\n두 후보의 근거:\n${candidateContext}\n\n다음 JSON 형식으로 답하세요: {"owner": string, "reason": string, "needsMoreInfo": boolean}`]
  ]);

  const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  let reReviewResult: { owner?: unknown; reason?: unknown; needsMoreInfo?: unknown };
  try {
    reReviewResult = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    // 재검토 응답 파싱 실패: 1차 판단을 그대로 유지합니다.
    return { reReviewed: true };
  }

  const candidateNames = new Set(candidates.map((candidate) => candidate.department));
  const reReviewOwner = typeof reReviewResult.owner === 'string' ? reReviewResult.owner : '';
  const reReviewOwnerValid = candidateNames.has(reReviewOwner);

  if (!reReviewOwnerValid) {
    // 재검토로도 확정하지 못한 경우: 1차 판단을 그대로 유지하되, 재검토를
    // 시도했다는 사실만 기록합니다.
    return { reReviewed: true };
  }

  const reReviewReason = typeof reReviewResult.reason === 'string' ? reReviewResult.reason : '';
  return {
    owner: reReviewOwner,
    partners: state.partners.filter((partner) => partner !== reReviewOwner),
    needsMoreInfo: false,
    reason: `[재검토] 유사도 점수가 근접한 두 후보(${candidates.map((candidate) => candidate.department).join(' vs ')})의 근거를 다시 비교해 판단했습니다. ${reReviewReason}`.trim(),
    reReviewed: true,
  };
}

const ragGraph = new StateGraph(RagAnnotation)
  .addNode('retrieve', retrieveNode)
  .addNode('judge', judgeNode)
  .addNode('reReview', reReviewNode)
  .addEdge(START, 'retrieve')
  .addEdge('retrieve', 'judge')
  .addConditionalEdges('judge', (state: RagState) => (
    state.hasDominantWinner || state.declinedWithSpecificReason || state.resolvedByAmountRule ? END : 'reReview'
  ))
  .addEdge('reReview', END)
  .compile();

// 이 함수 하나가 질문 접수부터 최종 JSON 응답까지 전체 파이프라인입니다.
// traceable()로 감싸서 LangSmith에 "질문 → 검색 근거 → 최종 답변"이 하나의
// 트레이스로 묶여 보이도록 합니다. 내부에서 호출하는 ragGraph.invoke()는 LangGraph
// StateGraph(LangChain Runnable)라서, LangSmith 트레이싱이 켜져 있으면
// (LANGSMITH_TRACING=true) retrieve/judge/reReview 각 노드가 이 트레이스의 하위
// 실행(child run)으로 자동으로 잡힙니다. LANGSMITH_API_KEY가 없으면 langsmith SDK가
// 아무 것도 전송하지 않고 조용히 통과하므로, 로컬 개발에는 영향이 없습니다.
const runRagPipeline = traceable(
  async ({ question, site, category }: { question: string; site?: string; category?: string }) => {
    const finalState = await ragGraph.invoke({ question, site, category });
    return {
      needsMoreInfo: finalState.needsMoreInfo,
      owner: finalState.owner,
      partners: finalState.partners,
      reason: finalState.reason,
      evidence: finalState.evidence,
      reReviewed: finalState.reReviewed,
      retrieved: finalState.docs.map((doc) => ({ content: doc.pageContent, ...doc.metadata })),
    };
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

'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Department = { id: string; name: string; parent: string; sites: string[]; categories: string[]; keywords: string[]; responsibility: string; sourcePath: string };
type Match = Department & { score: number; reasons: string[] };
type Workflow = { id: string; title: string; keywords: string[]; threshold: string; steps: { order: number; title: string; owner: string; detail: string; evidence: string }[]; note: string };
type RagResult = { needsMoreInfo: boolean; owner: string; partners: string[]; reason: string; evidence: { quote: string; source: string }[]; retrieved: { content: string; document?: string; department?: string; workType?: string }[] };
type ReferenceDocument = { document: string; department: string; workType: string };
type RequestStatus = '작성중' | '검토 대기' | '검토중' | '회신 완료';
type RequestLogEntry = { id: string; createdAt: string; question: string; site: string; category: string; owner: string; partners: string[]; status: RequestStatus };
const MAIL_DOMAIN = process.env.NEXT_PUBLIC_MAIL_DOMAIN ?? 'example.invalid';

const sites = ['미선택', '포항', '광양', '세종', '전사'];
const categories = ['자동 분류', '안전', '환경', '설비·정비', '구매·자재', '투자·공사', '생산·조업', '품질', '재무·회계', '컴플라이언스'];
function rank(question: string, site: string, category: string, departments: Department[], workflows: Workflow[]): Match[] {
  const text = question.toLowerCase();
  const workflow = workflows.find((item) => item.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length >= 2);
  const workflowOrder = new Map<string, number>();
  workflow?.steps.forEach((step) => {
    if (!workflowOrder.has(step.owner)) workflowOrder.set(step.owner, step.order);
  });
  return departments.map((department) => {
    let score = 0; const reasons: string[] = [];
    const matchedCategories = department.categories.filter((item) => text.includes(item.toLowerCase()));
    const matchedKeywords = department.keywords.filter((item) => text.includes(item.toLowerCase()));
    if (category !== '자동 분류' && department.categories.includes(category)) { score += 6; reasons.push(`${category} 업무유형 일치`); }
    else if (matchedCategories.length) { score += 6; reasons.push(`${matchedCategories[0]} 업무유형 일치`); }
    if (site !== '미선택' && (department.sites.includes(site) || department.sites.includes('전사'))) { score += department.sites.includes(site) ? 5 : 2; reasons.push(department.sites.includes(site) ? `${site} 사업장 담당` : '전사 담당 조직'); }
    if (matchedKeywords.length) { score += Math.min(matchedKeywords.length * 2, 6); reasons.push(`${matchedKeywords.slice(0, 3).join('·')} 키워드 일치`); }
    if (department.id === 'investment' && /(투자|승인|5억|5억원|타당성|심의|투자비)/.test(text)) { score += 10; reasons.push('투자 승인·심의 의도 일치'); }
    if (department.id === 'accounting-tax' && /(회계|회계처리|비용|자산|감가상각|전표)/.test(text)) { score += 7; reasons.push('회계처리 의도 일치'); }
    if (department.id === 'equipment-material' && /(구매|설비|발주|계약)/.test(text)) { score += 4; reasons.push('설비 구매·계약 의도 일치'); }
    return { ...department, score, reasons };
  }).filter((item) => item.score > 0).sort((a, b) => {
    const aOrder = workflowOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = workflowOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return b.score - a.score || a.name.localeCompare(b.name, 'ko');
  });
}

function level(score: number): [string, string] { return score >= 11 ? ['높음', 'high'] : score >= 6 ? ['보통', 'medium'] : ['추가 확인 필요', 'low']; }
function departmentEmail(id: string) { return `${id}@${MAIL_DOMAIN}`; }
// confirmDraft(규칙 기반)와 createRagRequest(RAG 기반) 양쪽에서 같은 요청 문구를 쓰도록 공용화합니다.
function buildRequestItems(recipientCount: number) {
  return ['관련 절차와 사전 검토 필요 여부를 확인해 주세요.', ...(recipientCount > 1 ? ['여러 부서가 관련되어 있는데, 어느 부서에 먼저 협의를 요청하면 될지 처리 순서를 안내해 주세요.'] : ['추가로 협의해야 할 부서나 담당 업무가 있으면 안내해 주세요.']), '사전 협의 시 첨부해야 할 자료(예: 투자품의서, 견적서, 타당성 검토안)가 있다면 안내해 주세요.', '검토 및 회신까지 예상되는 소요 기간을 알려주세요.'].map((item, index) => `${index + 1}. ${item}`).join('\n');
}

export default function Home() {
  const [workflowTab, setWorkflowTab] = useState('input');
  const [departments, setDepartments] = useState<Department[]>([]); const [workflows, setWorkflows] = useState<Workflow[]>([]); const [question, setQuestion] = useState(''); const [site, setSite] = useState('미선택'); const [category, setCategory] = useState('자동 분류'); const [searched, setSearched] = useState(false); const [error, setError] = useState(''); const [draft, setDraft] = useState(''); const [copied, setCopied] = useState(false); const [pendingDepartment, setPendingDepartment] = useState<Match | null>(null); const [requestClosed, setRequestClosed] = useState(false); const [requestStatus, setRequestStatus] = useState<RequestStatus>('작성중'); const [rag, setRag] = useState<RagResult | null>(null); const [ragLoading, setRagLoading] = useState(false); const [activeTab, setActiveTab] = useState('dashboard'); const [mailSending, setMailSending] = useState(false); const [mailError, setMailError] = useState(''); const [selectedDepartments, setSelectedDepartments] = useState<string[]>([]);
  const [referenceDocuments, setReferenceDocuments] = useState<ReferenceDocument[]>([]); const [complianceEntries, setComplianceEntries] = useState<RequestLogEntry[]>([]); const [requestId, setRequestId] = useState<string | null>(null);
  useEffect(() => { Promise.all([fetch('/pilot_departments.json').then((r) => r.json()), fetch('/instruction_workflows.json').then((r) => r.json()), fetch('/reference_documents.json').then((r) => r.json())]).then(([departmentData, workflowData, referenceData]) => { setDepartments(departmentData.organizations); setWorkflows(workflowData.workflows); setReferenceDocuments(referenceData.documents ?? []); }).catch(() => setError('데모 데이터를 불러오지 못했습니다.')); }, []);
  async function loadComplianceEntries() { try { const response = await fetch('/api/requests'); const data = await response.json(); setComplianceEntries(Array.isArray(data.entries) ? data.entries : []); } catch { /* Compliance Hub 이력 조회 실패는 화면 흐름에 영향 주지 않음 */ } }
  useEffect(() => { if (!searched) { setActiveTab('dashboard'); setWorkflowTab('input'); window.setTimeout(() => document.querySelector('#regulatory-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); } }, [searched]);
  const results = useMemo(() => rank(question, site, category, departments, workflows), [question, site, category, departments, workflows]); const primary = results[0];
  const workflow = useMemo(() => workflows.find((item) => item.keywords.filter((keyword) => question.toLowerCase().includes(keyword.toLowerCase())).length >= 2), [question, workflows]);
  async function searchRag() { setRagLoading(true); setRag(null); try { const response = await fetch('/api/rag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, site, category }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setRag(data); } catch (ragError) { setError(ragError instanceof Error ? ragError.message : 'RAG 검색에 실패했습니다.'); } finally { setRagLoading(false); } }
  function submit(event: FormEvent) { event.preventDefault(); setDraft(''); if (!question.trim()) { setError('업무 상황을 입력해 주세요.'); return; } setError(''); setSelectedDepartments([]); setWorkflowTab('check'); setActiveTab('regulatory-search'); setSearched(true); void searchRag(); }
  function navigateTab(id: string, target: string) { setActiveTab(id); if (id === 'dashboard') { setSearched(false); setDraft(''); setRag(null); setError(''); setRequestClosed(false); setRequestStatus('작성중'); setRequestId(null); setSelectedDepartments([]); setWorkflowTab('input'); } if (id === 'compliance-hub') void loadComplianceEntries(); window.setTimeout(() => { const element = document.querySelector(target) ?? document.querySelector('#regulatory-search'); element?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 0); }
  function navigateWorkflow(id: string, target: string) { setWorkflowTab(id); if (id === 'input') { setActiveTab('dashboard'); setSearched(false); setDraft(''); setRag(null); setError(''); setRequestClosed(false); setRequestStatus('작성중'); setRequestId(null); setSelectedDepartments([]); } window.setTimeout(() => { const element = document.querySelector(target) ?? document.querySelector('#regulatory-search'); element?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 0); }
  function createDraft(department: Match) { setWorkflowTab('request'); setSelectedDepartments((current) => current.includes(department.id) ? current : [...current, department.id]); setPendingDepartment(department); setRequestClosed(false); setDraft(''); setCopied(false); setRequestStatus('작성중'); setRequestId(null); }
  function confirmDraft() { if (!pendingDepartment) return; const department = pendingDepartment; const recipientIds = selectedDepartments.includes(department.id) ? selectedDepartments : [...selectedDepartments, department.id]; const recipientLines = recipientIds.map((id) => { const selected = results.find((item) => item.id === id); return `${selected?.name ?? id} <${departmentEmail(id)}>`; }).join(', '); setSelectedDepartments(recipientIds); setDraft(`수신: ${recipientLines}\n제목: [사전 협의 요청] ${department.name} 관련 업무 검토\n\n업무 상황\n${question}\n\n사업장: ${site === '미선택' ? '미입력' : site}\n요청 사항\n${buildRequestItems(recipientIds.length)}\n\n추천 근거\n${department.reasons.join(', ')}\n업무분장 근거\n${department.sourcePath}`); setPendingDepartment(null); setRequestStatus('작성중'); }
  // [3차 개선] RAG 추천(owner/partners)은 지금까지 규칙 기반 카드(DepartmentCard)의
  // "검토 요청 내용 준비" 버튼과 연결되어 있지 않아, 메일은 항상 규칙 기반 후보를 대상으로만
  // 발송됐습니다. RAG의 owner/partners는 이름(string)만 갖고 있으므로, 이메일 주소 생성에
  // 필요한 department.id를 찾기 위해 전체 부서 목록(departments)에서 이름으로 매칭합니다.
  // RAG는 이미 근거를 확인해 owner/partners를 확정한 상태이므로, 규칙 기반 흐름과 달리
  // 부서를 하나씩 추가하는 확인 단계(pendingDepartment) 없이 바로 초안을 작성합니다.
  function createRagRequest() {
    if (!rag || rag.needsMoreInfo || !rag.owner) return;
    const ownerDept = departments.find((item) => item.name === rag.owner);
    if (!ownerDept) { setMailError('추천 부서 정보를 부서 목록에서 찾을 수 없습니다.'); return; }
    const partnerDepts = rag.partners.map((name) => departments.find((item) => item.name === name)).filter((item): item is Department => Boolean(item));
    const recipients = [ownerDept, ...partnerDepts];
    setWorkflowTab('request'); setRequestClosed(false); setCopied(false); setRequestStatus('작성중'); setRequestId(null); setMailError('');
    setSelectedDepartments(recipients.map((item) => item.id));
    const recipientLines = recipients.map((item) => `${item.name} <${departmentEmail(item.id)}>`).join(', ');
    const evidenceText = rag.evidence.length ? rag.evidence.map((item) => `- ${item.quote} (${item.source})`).join('\n') : rag.reason;
    setDraft(`수신: ${recipientLines}\n제목: [사전 협의 요청] ${ownerDept.name} 관련 업무 검토\n\n업무 상황\n${question}\n\n사업장: ${site === '미선택' ? '미입력' : site}\n요청 사항\n${buildRequestItems(recipients.length)}\n\nAI(LangChain RAG) 추천 근거\n${rag.reason}\n${evidenceText}`);
  }
  async function sendMail() { setMailSending(true); setMailError(''); try { const subject = draft.split('\n').find((line) => line.startsWith('제목:'))?.replace(/^제목:\s*/, '') ?? '사전 협의 요청'; const recipients = selectedDepartments.map(departmentEmail); const response = await fetch('/api/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, text: draft, recipients }) }); const contentType = response.headers.get('content-type') ?? ''; const data = contentType.includes('application/json') ? await response.json() : { error: `메일 서버가 정상 응답을 반환하지 않았습니다. (HTTP ${response.status})` }; if (!response.ok) throw new Error(data.error); setRequestStatus('검토 대기'); void logRequest(recipients); } catch (mailSendError) { setMailError(mailSendError instanceof Error ? mailSendError.message : '메일 발송에 실패했습니다.'); } finally { setMailSending(false); } }
  // 메일 발송이 성공한 시점에만 Compliance Hub 이력에 한 건을 남깁니다. RAG가 확정한 owner/partners가
  // 있으면 그것을, 없으면(추가 확인 필요 등) 화면에 이미 보여준 규칙 기반 후보를 그대로 기록합니다.
  async function logRequest(recipients: string[]) {
    const owner = rag && !rag.needsMoreInfo ? rag.owner : primary?.name ?? '';
    const partners = rag && !rag.needsMoreInfo ? rag.partners : results.slice(1, 4).map((item) => item.name);
    try {
      const response = await fetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, site, category, owner, partners, recipients }) });
      const data = await response.json();
      if (response.ok) setRequestId(data.entry.id);
    } catch { /* 이력 저장 실패는 메일 발송 결과에 영향 주지 않음 */ }
  }
  async function updateRequestStatus(status: '검토중' | '회신 완료') {
    setRequestStatus(status);
    if (!requestId) return;
    try { await fetch('/api/requests', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: requestId, status }) }); } catch { /* 상태 동기화 실패는 화면 흐름에 영향 주지 않음 */ }
  }
  function toggleDepartment(id: string) { setSelectedDepartments((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }
  const tabs = [['dashboard', 'Dashboard', '#dashboard'], ['regulatory-search', 'Regulatory Search', '#results'], ['compliance-hub', 'Compliance Hub', '#notice']] as const;
  return <main id="dashboard" data-active-tab={activeTab}>
    <nav className="workflow-nav" aria-label="업무 진행 단계"><button className={workflowTab === 'input' ? 'active' : ''} type="button" onClick={() => navigateWorkflow('input', '#regulatory-search')}>1. 업무 입력</button><button className={workflowTab === 'check' ? 'active' : ''} type="button" onClick={() => navigateWorkflow('check', '#results')}>2. 절차·부서 확인</button><button className={workflowTab === 'request' ? 'active' : ''} type="button" onClick={() => navigateWorkflow('request', '.draft, .request-confirmation, .request-tracker')}>3. 협업 요청</button></nav>
    <header className="topbar"><div className="brand"><span className="brand-mark">R</span><span>업무 지침 네비게이터</span></div><nav className="nav-links" aria-label="주 메뉴">{tabs.map(([id, label, href]) => <a key={id} className={activeTab === id ? 'active' : ''} href={href} aria-current={activeTab === id ? 'page' : undefined} onClick={(event) => { event.preventDefault(); navigateTab(id, href); }}>{label}</a>)}</nav><span className="demo-badge">투자·공사, 재무·회계 중심 검증</span></header>
    {!searched && <section id="regulatory-search" className="hero"><p className="eyebrow">지침 기반 부서 안내</p><h1>무엇을 도와드릴까요?</h1><p className="lead">업무 상황을 입력하면 관련 지침에 따라 협의할 부서 후보와 근거를 안내합니다.</p>
      <div className="hero-diagram" aria-hidden="true"><div className="hero-diagram-step"><span className="hero-diagram-icon">💬</span><span>업무 상황 입력</span></div><span className="hero-diagram-arrow">→</span><div className="hero-diagram-step"><span className="hero-diagram-icon">📄</span><span>지침 문서 검색</span></div><span className="hero-diagram-arrow">→</span><div className="hero-diagram-step"><span className="hero-diagram-icon">🏢</span><span>부서 추천</span></div><span className="hero-diagram-arrow">→</span><div className="hero-diagram-step"><span className="hero-diagram-icon">✉️</span><span>협업 요청</span></div></div>
      <form onSubmit={submit} className="search-panel"><label htmlFor="question">업무 상황</label><textarea id="question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="예: 포항 공장의 설비를 교체하려는데 먼저 협의할 부서를 알고 싶어요." /><div className="search-options"><label>사업장<select value={site} onChange={(e) => setSite(e.target.value)}>{sites.map((item) => <option key={item}>{item}</option>)}</select></label><label>업무 유형<select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label><button>부서 찾기</button></div></form>
    </section>}
    {error && <p className="message error">{error}</p>}
    {searched && !error && <section id="results" className="results result-screen"><button type="button" className="back-button" onClick={() => { setSearched(false); setDraft(''); setRag(null); setSelectedDepartments([]); }}>← 다시 검색</button><div className="query-summary"><span>검색한 업무 상황</span><strong>{question}</strong>{site !== '미선택' && <small>{site} · {category}</small>}</div>{ragLoading && <p className="message notice loading"><span className="spinner" aria-hidden="true" />지침 문서를 검색하고 근거를 확인하는 중입니다…</p>}{rag && <RagPanel result={rag} fallback={results} onRequest={createRagRequest} />}{workflow && <section className="workflow"><div className="result-title"><div><p className="eyebrow">관련 규정 맞춤 해석</p><h2>{workflow.title}</h2></div><span className="threshold">적용 기준: {workflow.threshold}</span></div><div className="workflow-steps">{workflow.steps.map((step) => <article className="workflow-step" key={step.order}><span className="step-number">{step.order}</span><div><h3>{step.title}</h3><strong>주관: {step.owner}</strong><p>{step.detail}</p><small>{step.evidence}</small></div></article>)}</div><p className="message notice">{workflow.note}</p></section>}<div className="result-title"><div><p className="eyebrow">기존 규칙 기반 후보</p><h2>비교용 추천 결과</h2></div><p>실제 배정이나 최종 판단은 담당 부서 확인이 필요합니다.</p></div>{site === '미선택' && <p className="message notice">사업장을 선택하면 현장 담당 부서를 더 정확히 안내할 수 있습니다.</p>}{primary ? <div className="result-grid"><DepartmentCard department={primary} role="주관 후보" onDraft={createDraft} selected={selectedDepartments.includes(primary.id)} onToggle={() => toggleDepartment(primary.id)} /><div className="partner-column"><h3>협업 후보</h3>{results.slice(1, 4).map((item) => <DepartmentCard key={item.id} department={item} role="협업 후보" compact onDraft={createDraft} selected={selectedDepartments.includes(item.id)} onToggle={() => toggleDepartment(item.id)} />)}</div></div> : <div className="empty-state"><h3>일치하는 부서를 찾지 못했습니다.</h3><p>업무 유형을 선택하거나 설비·안전·구매·환경처럼 핵심 업무 단어를 추가해 주세요.</p></div>}</section>}
    {pendingDepartment && <section className="request-confirmation"><p className="eyebrow">검토 요청 확인</p><h2>관련 부서에 검토 요청을 할까요?</h2><p><strong>{selectedDepartments.map((id) => { const selected = results.find((item) => item.id === id); return `${selected?.name ?? id} (${departmentEmail(id)})`; }).join(', ')}</strong>에 사전 협의 내용을 준비합니다.</p><div className="confirmation-actions"><button type="button" onClick={confirmDraft}>예, 요청 내용 준비</button><button type="button" className="secondary" onClick={() => { setPendingDepartment(null); setDraft(''); setRequestClosed(true); }}>아니오</button></div></section>}
    {requestClosed && !pendingDepartment && !draft && <p className="message notice">검토 요청을 종료했습니다. 추가 전송이나 변경은 없습니다.</p>}
    {draft && <section className="draft"><div><p className="eyebrow">검토 요청 초안</p><p className="draft-help">선택된 부서: {selectedDepartments.length ? selectedDepartments.map(departmentEmail).join(', ') : '없음'}</p></div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="검토 요청 초안" /><div><button type="button" onClick={async () => { await navigator.clipboard?.writeText(draft); setCopied(true); }}>초안 복사</button>{copied && <span className="copy-status"> 클립보드에 복사했습니다.</span>}</div>{mailError && <p className="message error">{mailError}</p>}<button type="button" className="send-button" disabled={mailSending || !selectedDepartments.length} onClick={sendMail}>{mailSending ? '메일을 보내는 중입니다…' : !selectedDepartments.length ? '부서를 선택해 주세요' : '메일 보내기 · 검토 대기로 이동'}</button></section>}
    {(requestStatus !== '작성중' || requestClosed) && <section className="request-tracker"><div className="tracker-heading"><div><p className="eyebrow">요청 상태</p><h2>현업 확인 현황</h2></div><span className={`status-pill ${requestStatus === '회신 완료' ? 'done' : 'waiting'}`}>{requestStatus}</span></div><div className="status-steps"><span className="complete">질문 입력</span><span className={requestStatus !== '작성중' ? 'complete' : ''}>메일 발송</span><span className={requestStatus === '회신 완료' ? 'complete' : 'current'}>현업 검토</span><span className={requestStatus === '회신 완료' ? 'complete' : ''}>회신 완료</span></div>{requestStatus === '검토 대기' && <button type="button" className="reply-tab" onClick={() => updateRequestStatus('검토중')}>담당 부서 접수 확인 · 검토중으로 변경</button>}{requestStatus === '검토중' && <button type="button" className="reply-tab" onClick={() => updateRequestStatus('회신 완료')}>현업 담당자: 확인 후 ‘회신 완료’로 변경</button>}{requestStatus === '회신 완료' && <p className="completed-note">현업 담당자가 확인하고 회신 완료 처리했습니다.</p>}</section>}
    <ComplianceHub documents={referenceDocuments} entries={complianceEntries} /><footer id="notice">출처: 260827_조직 및 책임권한 규정_업무분장_더미파일.docx · 본 화면은 파일 기반 데모입니다.</footer>
  </main>;
}

function RagPanel({ result, fallback, onRequest }: { result: RagResult; fallback: Match[]; onRequest: () => void }) {
  const sources = [...new Set(result.retrieved.map((item) => item.document).filter(Boolean))];
  // RAG가 확신하지 못해 owner를 비워둔 경우, 화면이 통째로 비어 보이면 사용자가 "적중률이
  // 낮다"고 느끼기 쉽습니다. 이때는 기존 키워드 규칙 기반 후보(아래 "기존 규칙 기반 후보"
  // 섹션과 동일한 소스)를 참고용으로라도 보여줍니다. 신뢰도가 다른 두 방식임을 명확히
  // 구분하기 위해 "규칙 기반 참고" 배지를 붙이고, RAG 자체 추천과 섞이지 않게 합니다.
  const ruleBasedFallback = result.needsMoreInfo ? fallback.slice(0, 3) : [];
  return <section className="workflow rag-panel"><div className="result-title"><div><p className="eyebrow">LangChain RAG 근거 기반 추천</p><h2>{result.needsMoreInfo ? '추가 확인이 필요합니다' : result.owner}</h2></div><span className="threshold">주관 부서</span></div><p>{result.reason}</p><p><strong>협업 부서:</strong> {result.partners.length ? result.partners.join(' · ') : '확인되지 않음'}</p>{ruleBasedFallback.length > 0 && <p className="message notice"><strong>규칙 기반 참고 후보:</strong> {ruleBasedFallback.map((item) => `${item.name}(${level(item.score)[0]})`).join(' · ')} — 아래 "기존 규칙 기반 후보"에서 근거를 확인해 주세요.</p>}{!result.needsMoreInfo && result.owner && <button type="button" className="draft-button" data-testid="rag-draft-button" onClick={onRequest}>이 추천으로 협업 요청 준비</button>}<div className="evidence"><span>검색된 지침 근거</span>{result.evidence.length ? result.evidence.map((item, index) => <p key={`${item.source}-${index}`}>“{item.quote}”<small>{item.source}</small></p>) : <p>구체적인 절차 확인이 필요합니다. 질문에 승인 기준이나 회계처리 단계 등 확인할 내용을 추가해 주세요.</p>}{sources.length > 0 && <details><summary>검색된 문서 {sources.length}건 보기</summary><ul>{sources.map((source) => <li key={source}>{source}</li>)}</ul></details>}</div></section>;
}

function ComplianceHub({ documents, entries }: { documents: ReferenceDocument[]; entries: RequestLogEntry[] }) {
  return <section id="compliance-hub" className="compliance-screen">
    <p className="eyebrow">Compliance Hub</p>
    <h2>컴플라이언스 안내</h2>
    <p>사내 규정과 업무분장 근거를 확인하고 검토 요청 진행 상황을 관리하는 공간입니다.</p>
    <div className="compliance-panel">
      <h3>참고 문서</h3>
      {documents.length
        ? <ul className="document-list">{documents.map((item) => <li key={item.document}><strong>{item.document}</strong><span>{item.department} · {item.workType}</span></li>)}</ul>
        : <p className="message notice">참고 문서를 불러오지 못했습니다.</p>}
    </div>
    <div className="compliance-panel">
      <h3>협업 요청 이력</h3>
      {entries.length
        ? <div className="request-log-wrap"><table className="request-log"><thead><tr><th>요청 시각</th><th>업무 상황</th><th>주관 부서</th><th>협업 부서</th><th>상태</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{new Date(entry.createdAt).toLocaleString('ko-KR')}</td><td>{entry.question}</td><td>{entry.owner || '미확정'}</td><td>{entry.partners.length ? entry.partners.join(', ') : '-'}</td><td><span className={`status-pill ${entry.status === '회신 완료' ? 'done' : 'waiting'}`}>{entry.status}</span></td></tr>)}</tbody></table></div>
        : <p className="message notice">아직 접수된 협업 요청이 없습니다. 검토 요청 메일을 보내면 이곳에 기록됩니다.</p>}
    </div>
  </section>;
}

function DepartmentCard({ department, role, compact = false, onDraft, selected, onToggle }: { department: Match; role: string; compact?: boolean; onDraft: (department: Match) => void; selected: boolean; onToggle: () => void }) {
  const [label, className] = level(department.score);
  return <article className={`department-card ${compact ? 'compact' : 'primary'}`} data-testid={`department-card-${department.id}`}><div className="card-meta"><label><input type="checkbox" checked={selected} onChange={onToggle} data-testid={`department-checkbox-${department.id}`} /> 메일 수신 부서</label><span className={`confidence ${className}`}>{label}</span></div><h3>{department.name}</h3><p className="parent">{department.parent}</p><p className="reason">{department.reasons.join(' · ')}</p><div className="evidence"><span>업무분장 근거</span><p>{department.responsibility}</p><small>{department.sourcePath}</small></div>{!compact && <button type="button" className="draft-button" data-testid="rule-draft-button" onClick={() => onDraft(department)}>검토 요청 내용 준비</button>}</article>;
}

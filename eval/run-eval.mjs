// 3차 평가 스크립트
//
// 무엇을 하나:
// 1) eval/golden-dataset.json을 LangSmith Dataset("department-rag-golden")으로 동기화합니다
//    (이미 있으면 내용이 바뀐 케이스만 갱신 - 몇 번을 다시 실행해도 중복 생성되지 않습니다).
// 2) 실행 중인 Next.js dev 서버의 /api/rag를 각 케이스마다 실제로 호출합니다.
// 3) owner/partners/needsMoreInfo/근거문서를 기대값과 비교해 채점하고,
//    LangSmith에 "Experiment"로 기록합니다 (질문/검색근거/최종답변까지 전부 UI에서 확인 가능).
// 4) 터미널에도 요약 표를 출력합니다.
//
// 실행 전 준비:
//   - .env.local에 OPENAI_API_KEY, LANGSMITH_API_KEY, LANGSMITH_PROJECT가 채워져 있어야 함
//   - 평가 대상 서버가 떠 있어야 함(예: npm run dev -- -p 3100)
//
// 실행:
//   node eval/run-eval.mjs
//   EVAL_BASE_URL=http://localhost:3100 node eval/run-eval.mjs   (기본값도 3100)

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'langsmith';
import { evaluate } from 'langsmith/evaluation';

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';
// Next.js와 동일한 우선순위: .env.local이 .env보다 우선합니다.
loadEnv({ path: path.join(ROOT, '.env.local') });
loadEnv({ path: path.join(ROOT, '.env') });

const BASE_URL = process.env.EVAL_BASE_URL ?? 'http://localhost:3100';
const DATASET_NAME = process.env.LANGSMITH_EVAL_DATASET ?? 'department-rag-golden';

if (!process.env.LANGSMITH_API_KEY) {
  console.error('LANGSMITH_API_KEY가 없습니다. .env.local을 확인하세요.');
  process.exit(1);
}

const client = new Client();

// ---------- 1) 골든셋 -> LangSmith Dataset 동기화 ----------

async function loadGoldenDataset() {
  const raw = await fs.readFile(path.join(ROOT, 'eval', 'golden-dataset.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.cases;
}

function toExampleFields(testCase) {
  return {
    // 골든셋 케이스는 앱의 "업무 유형(category)" 필터를 지정하지 않으므로 question/site만 넘깁니다.
    // (testCase.category는 앱 입력값이 아니라 골든셋 자체의 테스트 분류표시입니다 - metadata로만 보냄)
    inputs: { question: testCase.question, site: testCase.site ?? undefined },
    outputs: testCase.expected,
    metadata: { caseId: testCase.id, testCategory: testCase.category, reviewNeeded: Boolean(testCase.reviewNeeded) }
  };
}

function shallowEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function syncDataset(cases) {
  const exists = await client.hasDataset({ datasetName: DATASET_NAME });
  if (!exists) {
    await client.createDataset(DATASET_NAME, {
      description: '업무 지침 네비게이터 RAG 골든셋 - source_docs 원문 대조로 owner/partners/needsMoreInfo 정답을 확정한 케이스 모음 (eval/golden-dataset.json)'
    });
    console.log(`[dataset] "${DATASET_NAME}" 새로 생성함`);
  }

  // caseId -> 기존 Example 매핑
  const existingByCaseId = new Map();
  for await (const example of client.listExamples({ datasetName: DATASET_NAME })) {
    const caseId = example.metadata?.caseId;
    if (caseId) existingByCaseId.set(caseId, example);
  }

  const toCreate = [];
  const toUpdate = [];
  for (const testCase of cases) {
    const fields = toExampleFields(testCase);
    const existing = existingByCaseId.get(testCase.id);
    if (!existing) {
      toCreate.push({ ...fields, dataset_name: DATASET_NAME });
      continue;
    }
    const changed = !shallowEqual(existing.inputs, fields.inputs) || !shallowEqual(existing.outputs, fields.outputs);
    if (changed) toUpdate.push({ id: existing.id, ...fields });
  }

  if (toCreate.length) await client.createExamples(toCreate);
  if (toUpdate.length) await client.updateExamples(toUpdate);
  console.log(`[dataset] 동기화 완료 - 신규 ${toCreate.length}건, 갱신 ${toUpdate.length}건, 변경없음 ${cases.length - toCreate.length - toUpdate.length}건`);
}

// ---------- 2) 평가 대상: 실행 중인 /api/rag 호출 ----------

async function target(input) {
  const res = await fetch(`${BASE_URL}/api/rag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: input.question, site: input.site, category: input.category })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`/api/rag ${res.status}: ${body.error ?? '알 수 없는 오류'}`);
  return body;
}

// ---------- 3) 채점 함수(evaluator) ----------
// 각 evaluator는 {run, example, inputs, outputs, referenceOutputs} 형태의 인자를 받습니다.
// outputs = target()이 반환한 실제 응답, referenceOutputs = 골든셋의 expected 값입니다.

function setOf(arr) {
  return new Set(Array.isArray(arr) ? arr : []);
}

function f1(expected, actual) {
  const exp = setOf(expected);
  const act = setOf(actual);
  if (exp.size === 0 && act.size === 0) return 1;
  let tp = 0;
  for (const v of act) if (exp.has(v)) tp++;
  const precision = act.size ? tp / act.size : 0;
  const recall = exp.size ? tp / exp.size : 0;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

const ownerMatch = ({ outputs, referenceOutputs }) => ({
  key: 'owner_match',
  score: (outputs.owner ?? '') === (referenceOutputs.owner ?? '') ? 1 : 0,
  comment: `expected="${referenceOutputs.owner || '(빈값)'}" actual="${outputs.owner || '(빈값)'}"`
});

const needsMoreInfoMatch = ({ outputs, referenceOutputs }) => ({
  key: 'needs_more_info_match',
  score: outputs.needsMoreInfo === referenceOutputs.needsMoreInfo ? 1 : 0,
  comment: `expected=${referenceOutputs.needsMoreInfo} actual=${outputs.needsMoreInfo}`
});

const partnerF1 = ({ outputs, referenceOutputs }) => {
  const score = f1(referenceOutputs.partners, outputs.partners);
  return {
    key: 'partner_f1',
    score,
    comment: `expected=[${(referenceOutputs.partners ?? []).join(', ')}] actual=[${(outputs.partners ?? []).join(', ')}]`
  };
};

// 근거문서 기대값이 있는 케이스에서만 채점합니다(없는 케이스, 예: 범위밖 질문은 score를 비워
// 평균 계산에서 자연히 제외되도록 합니다 - "해당없음"을 0점으로 잘못 세지 않기 위함).
const evidenceOverlap = ({ outputs, referenceOutputs }) => {
  const expectedDocs = referenceOutputs.evidenceDocuments ?? [];
  if (expectedDocs.length === 0) return { key: 'evidence_overlap', score: null, comment: '근거문서 기대값 없음(해당없음)' };
  const retrievedNames = (outputs.retrieved ?? []).map((doc) => doc.document ?? '');
  const matched = expectedDocs.filter((expected) => retrievedNames.some((name) => name.includes(expected)));
  return {
    key: 'evidence_overlap',
    score: matched.length / expectedDocs.length,
    comment: `기대 ${expectedDocs.length}건 중 ${matched.length}건 검색됨`
  };
};

const overallCorrect = ({ outputs, referenceOutputs }) => {
  const owner = (outputs.owner ?? '') === (referenceOutputs.owner ?? '');
  const needsMore = outputs.needsMoreInfo === referenceOutputs.needsMoreInfo;
  const partners = f1(referenceOutputs.partners, outputs.partners) === 1;
  return { key: 'overall_correct', score: owner && needsMore && partners ? 1 : 0 };
};

// ---------- 4) 실행 ----------

async function main() {
  const cases = await loadGoldenDataset();
  console.log(`골든셋 ${cases.length}개 케이스 로드 (${path.join('eval', 'golden-dataset.json')})`);
  console.log(`평가 대상 서버: ${BASE_URL}`);

  await syncDataset(cases);

  console.log('\n평가 실행 중... (케이스당 LLM 호출이 있어 다소 시간이 걸립니다)\n');
  const results = await evaluate(target, {
    data: DATASET_NAME,
    evaluators: [ownerMatch, needsMoreInfoMatch, partnerF1, evidenceOverlap, overallCorrect],
    experimentPrefix: 'dept-rag',
    client,
    maxConcurrency: 3
  });

  // ---------- 5) 터미널 요약 ----------
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const rows = results.results.map(({ example, evaluationResults }) => {
    const caseId = example.metadata?.caseId ?? example.id;
    const scoreOf = (key) => evaluationResults.results.find((r) => r.key === key)?.score;
    return {
      id: caseId,
      category: caseById.get(caseId)?.category ?? '',
      owner: scoreOf('owner_match'),
      needsMoreInfo: scoreOf('needs_more_info_match'),
      partnerF1: scoreOf('partner_f1'),
      evidence: scoreOf('evidence_overlap'),
      overall: scoreOf('overall_correct')
    };
  });

  const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? v.toFixed(2) : String(v));
  console.log('id'.padEnd(12), 'category'.padEnd(20), 'owner', 'needsInfo', 'partnerF1', 'evidence', 'overall');
  for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(
      row.id.padEnd(12),
      row.category.padEnd(20),
      fmt(row.owner).padEnd(5),
      fmt(row.needsMoreInfo).padEnd(9),
      fmt(row.partnerF1).padEnd(9),
      fmt(row.evidence).padEnd(8),
      fmt(row.overall)
    );
  }

  const avg = (values) => {
    const nums = values.filter((v) => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  console.log('\n--- 평균 ---');
  console.log('owner_match       :', fmt(avg(rows.map((r) => r.owner))));
  console.log('needs_more_info   :', fmt(avg(rows.map((r) => r.needsMoreInfo))));
  console.log('partner_f1        :', fmt(avg(rows.map((r) => r.partnerF1))));
  console.log('evidence_overlap  :', fmt(avg(rows.map((r) => r.evidence))), '(근거문서 기대값 있는 케이스만)');
  console.log('overall_correct   :', fmt(avg(rows.map((r) => r.overall))));
  console.log(`\nLangSmith Experiment: "${results.experimentName}" (Dataset "${DATASET_NAME}" 페이지의 Experiments 탭에서 확인)`);
}

main().catch((error) => {
  console.error('평가 실행 실패:', error);
  process.exit(1);
});

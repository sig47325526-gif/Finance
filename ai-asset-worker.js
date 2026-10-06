/**
 * AI 자산관리 Cloudflare Worker
 * Secrets: OPENAI_API_KEY, AI_RELAY_KEY
 * Optional variable: OPENAI_MODEL (default: gpt-6-luna)
 *
 * The browser sends only a summarized asset snapshot. Never place OPENAI_API_KEY
 * in the HTML file.
 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Relay-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function outputText(r) {
  if (typeof r?.output_text === 'string' && r.output_text.trim()) return r.output_text.trim();
  const parts = [];
  for (const item of (r?.output || [])) {
    for (const c of (item?.content || [])) {
      if (c?.type === 'output_text' && c?.text) parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

const INSTRUCTIONS = `당신은 개인 자산관리 의사결정 지원 코치다. 사용자가 제공한 요약 데이터만 근거로 한국어로 답한다.
규칙:
1) 숫자를 새로 지어내지 말고, 제공되지 않은 정보는 '데이터가 없음/확인 필요'라고 말한다.
2) 계좌번호, 비밀번호, 주민번호, API 키 같은 민감정보를 요구하지 않는다.
3) 특정 종목·상품을 지금 매수/매도하라고 단정적으로 지시하지 않는다. 대신 자산배분, 집중도, 유동성, 목표, 현금흐름, 위험요인과 선택지의 장단점을 설명한다.
4) 수익률을 보장하거나 시장을 확정적으로 예측하지 않는다. 가정치는 가정이라고 명시한다.
5) 세금·법률·대출계약처럼 조건에 따라 달라지는 부분은 확정 판단 대신 확인할 항목을 안내한다.
6) 부채 총액에는 '앱 장부의 부채 계정 분개에 등록된 범위만 집계'라는 제한이 있으므로, 0원이어도 실제 무부채라고 단정하지 않는다.
7) 답변 형식은: 한줄 진단 → 핵심 근거 3~5개 → 우선순위 행동 3개 → 주의할 점. 필요한 경우에만 간단한 계산식을 덧붙인다.
8) 사용자의 목표와 위험감수성 정보가 없으면 투자성향을 추정하지 않는다.`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    const supplied = request.headers.get('X-Relay-Key') || '';
    if (!sameSecret(supplied, env.AI_RELAY_KEY || '')) return json({ error: '연결 비밀번호가 맞지 않습니다.' }, 401);

    const model = env.OPENAI_MODEL || 'gpt-6-luna';
    if (url.pathname.endsWith('/health')) return json({ ok: true, model });
    if (!url.pathname.endsWith('/ai-advice')) return json({ error: 'Not found' }, 404);
    if (!env.OPENAI_API_KEY) return json({ error: 'Worker에 OPENAI_API_KEY가 설정되지 않았습니다.' }, 500);

    let body;
    try { body = await request.json(); } catch { return json({ error: '잘못된 JSON 요청입니다.' }, 400); }
    const question = String(body?.question || '').trim();
    const summary = body?.summary;
    const history = Array.isArray(body?.history) ? body.history.slice(-6) : [];
    if (!question || !summary) return json({ error: '질문과 자산 요약이 필요합니다.' }, 400);

    const input = [];
    for (const m of history) {
      if (!['user','assistant'].includes(m?.role)) continue;
      const content = String(m?.content || '').slice(0, 4000);
      if (content) input.push({ role: m.role, content });
    }
    input.push({
      role: 'user',
      content: `현재 자산 요약(JSON):\n${JSON.stringify(summary)}\n\n사용자 질문: ${question}`
    });

    const api = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: INSTRUCTIONS,
        input,
        max_output_tokens: 1200,
        store: false
      })
    });
    const result = await api.json().catch(() => ({}));
    if (!api.ok) {
      const msg = result?.error?.message || `OpenAI API 오류 (${api.status})`;
      return json({ error: msg }, api.status >= 400 && api.status < 600 ? api.status : 500);
    }
    const answer = outputText(result);
    if (!answer) return json({ error: 'AI 응답에서 텍스트를 찾지 못했습니다.' }, 502);
    return json({ ok: true, model, answer });
  }
};

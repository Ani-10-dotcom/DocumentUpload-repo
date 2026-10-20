// /api/chat — server-side proxy to the LLM so the API key never reaches the browser.
// Runs on Vercel (Edge runtime) and locally via `node server.js`.
//
// Environment variables:
// Defaults to Groq — only GROQ_API_KEY is required.
//   GROQ_API_KEY   your Groq key (https://console.groq.com/keys)   — or LLM_API_KEY for other providers
//   LLM_MODEL      default openai/gpt-oss-120b (Groq). Others: openai/gpt-oss-20b, or any model your provider offers
//   LLM_PROVIDER   "openai" (default — any OpenAI-compatible API, incl. Groq) or "anthropic"
//   LLM_BASE_URL   OpenAI-compatible base URL       (default https://api.groq.com/openai/v1)
//   LLM_MAX_TOKENS max answer length                (default 2048)
//   LLM_REASONING_EFFORT  low | medium | high       (gpt-oss models only, default low = fastest)
//   ALLOWED_ORIGIN optional, e.g. https://your-site.vercel.app (blocks other sites using your proxy)

export const config = { runtime: 'edge' };

const env = (k, d = '') => (typeof process !== 'undefined' && process.env?.[k]) || d;
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async function handler(req) {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });

  const allowed = env('ALLOWED_ORIGIN');
  const origin = req.headers.get('origin');
  if (allowed && origin && origin !== allowed) return json(403, { error: 'Origin not allowed' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON' }); }

  // Basic input limits so the proxy can't be abused for huge requests
  const messages = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
  const size = messages.reduce((a, m) => a + String(m?.content || '').length, 0);
  if (!messages.length || size > 60000) return json(400, { error: 'Missing or oversized messages' });
  const clean = messages
    .filter((m) => ['system', 'user', 'assistant'].includes(m?.role))
    .map((m) => ({ role: m.role, content: String(m.content) }));

  const provider = env('LLM_PROVIDER', 'openai').toLowerCase();
  const apiKey = env('LLM_API_KEY') || env('GROQ_API_KEY');
  const model = env('LLM_MODEL', 'openai/gpt-oss-120b');
  const maxTokens = parseInt(env('LLM_MAX_TOKENS', '2048'), 10);
  const temperature = Math.max(0, Math.min(1, Number(body.temperature ?? 0.2)));
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(env('LLM_BASE_URL'))) return json(500, { error: 'Server is missing GROQ_API_KEY — add it to .env (local) or the Vercel environment variables.' });

  try {
    if (provider === 'anthropic') return await anthropic({ clean, apiKey, model, maxTokens, temperature });
    return await openaiCompatible({ clean, apiKey, model, maxTokens, temperature });
  } catch (err) {
    return json(502, { error: 'Upstream error: ' + err.message });
  }
}

async function openaiCompatible({ clean, apiKey, model, maxTokens, temperature }) {
  const base = env('LLM_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const payload = { model, messages: clean, stream: true, temperature, max_tokens: maxTokens };
  if (/gpt-oss/.test(model)) payload.reasoning_effort = env('LLM_REASONING_EFFORT', 'low');
  const r = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!r.ok) return json(r.status, { error: (await r.text()).slice(0, 500) });
  // Already OpenAI-style SSE → pass straight through
  return new Response(r.body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

async function anthropic({ clean, apiKey, model, maxTokens, temperature }) {
  const system = clean.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = clean.filter((m) => m.role !== 'system');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system, messages: msgs, max_tokens: maxTokens, temperature, stream: true }),
  });
  if (!r.ok) return json(r.status, { error: (await r.text()).slice(0, 500) });

  // Translate Anthropic's stream events into OpenAI-style SSE so the front end only needs one parser
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = '';
  const stream = new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'content_block_delta' && ev.delta?.text) {
            ctl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ev.delta.text } }] })}\n\n`));
          }
        } catch { /* ignore */ }
      }
    },
    flush(ctl) { ctl.enqueue(enc.encode('data: [DONE]\n\n')); },
  });
  return new Response(r.body.pipeThrough(stream), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

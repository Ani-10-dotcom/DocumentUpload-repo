// rag.js — shared RAG engine used by both pages
// Storage (IndexedDB) · text extraction · chunking · BM25 retrieval · LLM streaming

const CDN = {
  pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs',
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
};

const scriptCache = {};
function loadScript(src) {
  return (scriptCache[src] ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load library: ' + src));
    document.head.appendChild(s);
  }));
}

/* ───────────────────────── Change notifications (across tabs) ───────────────────────── */
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('rag-kb') : null;
const listeners = new Set();
export function onKBChange(cb) { listeners.add(cb); }
function notify(kind = 'kb', remote = false) {
  if (kind === 'kb') index = null;
  listeners.forEach((cb) => cb(kind));
  if (!remote && bc) bc.postMessage(kind);
}
if (bc) bc.onmessage = (e) => notify(e.data, true);

/* ───────────────────────── IndexedDB storage ───────────────────────── */
let dbPromise;
function db() {
  return (dbPromise ||= new Promise((res, rej) => {
    const r = indexedDB.open('rag-kb', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('chunks')) {
        d.createObjectStore('chunks', { keyPath: 'id' }).createIndex('docId', 'docId');
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function listDocs() {
  const d = await db();
  const docs = await reqP(d.transaction('docs').objectStore('docs').getAll());
  return docs.sort((a, b) => b.addedAt - a.addedAt);
}
export async function getAllChunks() {
  const d = await db();
  return reqP(d.transaction('chunks').objectStore('chunks').getAll());
}
export async function getDocChunks(docId) {
  const d = await db();
  const rows = await reqP(d.transaction('chunks').objectStore('chunks').index('docId').getAll(docId));
  return rows.sort((a, b) => a.i - b.i);
}

async function putMany(docs, chunks) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(['docs', 'chunks'], 'readwrite');
    docs.forEach((x) => t.objectStore('docs').put(x));
    chunks.forEach((x) => t.objectStore('chunks').put(x));
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  notify();
}

export async function deleteDoc(id) {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(['docs', 'chunks'], 'readwrite');
    t.objectStore('docs').delete(id);
    const cur = t.objectStore('chunks').index('docId').openCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } };
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  notify();
}

export async function clearAll() {
  const d = await db();
  await new Promise((res, rej) => {
    const t = d.transaction(['docs', 'chunks'], 'readwrite');
    t.objectStore('docs').clear();
    t.objectStore('chunks').clear();
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
  notify();
}

/* ───────────────────────── Text extraction ───────────────────────── */
export const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp'];
const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'ods'];

// Returns an array of sections: [{ text, loc }] where loc is e.g. "page 3" or "sheet Sales"
export async function extractText(file, onProgress = () => {}) {
  const e = extOf(file.name);
  const t = file.type || '';
  if (e === 'pdf' || t === 'application/pdf') return extractPdf(file, onProgress);
  if (e === 'docx') return extractDocx(file);
  if (SHEET_EXT.includes(e)) return extractSheet(file);
  if (e === 'pptx') return extractPptx(file, onProgress);
  if (IMAGE_EXT.includes(e) || t.startsWith('image/')) return extractImage(file, onProgress);
  if (e === 'html' || e === 'htm' || t === 'text/html') return extractHtml(file);
  if (e === 'rtf') return [{ text: stripRtf(await file.text()), loc: '' }];
  if (['doc', 'ppt'].includes(e)) {
    throw new Error(`Legacy .${e} files can't be read in the browser — save it as .${e}x or PDF and upload again.`);
  }
  return extractPlain(file);
}

async function extractPlain(file) {
  const text = await file.text();
  const sample = text.slice(0, 5000);
  const bad = (sample.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  if (sample.length && bad / sample.length > 0.05) {
    throw new Error('This looks like a binary file format that can\'t be read as text.');
  }
  return [{ text, loc: '' }];
}

async function extractPdf(file, onProgress) {
  const pdfjs = await import(/* @vite-ignore */ CDN.pdfjs);
  pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const sections = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const it of content.items) text += it.str + (it.hasEOL ? '\n' : ' ');
    sections.push({ text, loc: `page ${i}` });
    onProgress(i / pdf.numPages * 0.5);
  }
  // Scanned PDF (no text layer) → OCR each page
  if (sections.every((s) => s.text.replace(/\s/g, '').length < 20)) {
    await loadScript(CDN.tesseract);
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const { data } = await window.Tesseract.recognize(canvas, 'eng');
      out.push({ text: data.text, loc: `page ${i} (OCR)` });
      onProgress(0.5 + i / pdf.numPages * 0.5);
    }
    return out;
  }
  onProgress(1);
  return sections;
}

async function extractDocx(file) {
  await loadScript(CDN.mammoth);
  const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return [{ text: r.value, loc: '' }];
}

async function extractSheet(file) {
  await loadScript(CDN.xlsx);
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return wb.SheetNames.map((n) => ({ text: window.XLSX.utils.sheet_to_csv(wb.Sheets[n]), loc: `sheet "${n}"` }));
}

async function extractPptx(file, onProgress) {
  await loadScript(CDN.jszip);
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const slides = Object.keys(zip.files)
    .map((p) => [p, p.match(/^ppt\/slides\/slide(\d+)\.xml$/)])
    .filter(([, m]) => m)
    .sort((a, b) => +a[1][1] - +b[1][1]);
  const out = [];
  for (let k = 0; k < slides.length; k++) {
    const [path, m] = slides[k];
    const xml = new DOMParser().parseFromString(await zip.file(path).async('string'), 'application/xml');
    const paras = [...xml.getElementsByTagName('a:p')]
      .map((p) => [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join(''))
      .filter(Boolean);
    out.push({ text: paras.join('\n'), loc: `slide ${m[1]}` });
    onProgress((k + 1) / slides.length);
  }
  return out;
}

async function extractImage(file, onProgress) {
  await loadScript(CDN.tesseract);
  const { data } = await window.Tesseract.recognize(file, 'eng', {
    logger: (m) => m.status === 'recognizing text' && onProgress(m.progress),
  });
  return [{ text: data.text, loc: 'OCR' }];
}

async function extractHtml(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return [{ text: doc.body?.textContent || '', loc: '' }];
}

function stripRtf(s) {
  return s
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'[0-9a-f]{2}/gi, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '');
}

/* ───────────────────────── Chunking ───────────────────────── */
export function chunkSections(sections, { size = 1000, overlap = 200 } = {}) {
  const out = [];
  const tail = (s) => {
    if (s.length <= overlap) return s;
    const t = s.slice(-overlap);
    const i = t.search(/\s/);
    return i > 0 ? t.slice(i + 1) : t;
  };
  for (const s of sections) {
    const text = (s.text || '').replace(/\r/g, '').replace(/[ \t\u00A0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    const units = text.split(/(?<=[.!?।])\s+|\n+/).map((u) => u.trim()).filter(Boolean);
    let cur = '';
    for (let u of units) {
      while (u.length > size) {
        if (cur) { out.push({ text: cur, loc: s.loc }); cur = ''; }
        out.push({ text: u.slice(0, size), loc: s.loc });
        u = u.slice(size - overlap);
      }
      if (cur && cur.length + u.length + 1 > size) {
        out.push({ text: cur, loc: s.loc });
        cur = tail(cur) + '\n' + u;
      } else {
        cur = cur ? cur + '\n' + u : u;
      }
    }
    if (cur.trim()) out.push({ text: cur.trim(), loc: s.loc });
  }
  return out;
}

/* ───────────────────────── Ingestion ───────────────────────── */
export async function ingestFile(file, onStatus = () => {}) {
  onStatus({ stage: 'Reading', progress: 0 });
  const sections = await extractText(file, (p) => onStatus({ stage: 'Reading', progress: p }));
  onStatus({ stage: 'Chunking', progress: 1 });
  const pieces = chunkSections(sections);
  if (!pieces.length) throw new Error('No readable text was found in this file.');
  const id = crypto.randomUUID();
  const doc = {
    id,
    name: file.name,
    type: extOf(file.name) || file.type || 'file',
    size: file.size,
    chars: sections.reduce((a, s) => a + (s.text || '').length, 0),
    chunks: pieces.length,
    addedAt: Date.now(),
    source: 'local',
  };
  const chunks = pieces.map((p, i) => ({ id: `${id}:${i}`, docId: id, i, text: p.text, loc: p.loc }));
  onStatus({ stage: 'Indexing', progress: 1 });
  await putMany([doc], chunks);
  return doc;
}

/* ───────────────────────── Retrieval (BM25) ───────────────────────── */
const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those ' +
  'i me my you your he she we they them his her our their what which who whom how why when where do does did not no can could should ' +
  'would will shall may might must about into over than then there here so such only also just please tell give explain').split(' '));
const stem = (w) => (/^[a-z]+$/.test(w) && w.length > 4 ? w.replace(/(ingly|edly|ing|ed|es|s)$/, '') : w);
export function tokenize(s) {
  return ((s || '').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

let index = null;
async function getIndex() {
  if (index) return index;
  const [chunks, docs] = await Promise.all([getAllChunks(), listDocs()]);
  const names = Object.fromEntries(docs.map((d) => [d.id, d.name]));
  const df = new Map();
  let total = 0;
  const items = chunks.map((c) => {
    const toks = tokenize(c.text + ' ' + (names[c.docId] || ''));
    const tf = new Map();
    toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    total += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { c, tf, len: toks.length, docName: names[c.docId] || 'Unknown document' };
  });
  index = { items, df, N: items.length, avg: total / Math.max(items.length, 1) };
  return index;
}

export async function search(query, k = 6) {
  const { items, df, N, avg } = await getIndex();
  const q = [...new Set(tokenize(query))];
  if (!q.length || !N) return [];
  const k1 = 1.5, b = 0.75;
  return items
    .map((it) => {
      let s = 0;
      for (const t of q) {
        const f = it.tf.get(t);
        if (!f) continue;
        const n = df.get(t);
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * it.len / avg));
      }
      return { ...it.c, docName: it.docName, score: s };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/* ───────────────────────── Settings ───────────────────────── */
export const DEFAULT_PROMPT = `You are a helpful assistant that answers questions using ONLY the document excerpts provided in CONTEXT.
- If the answer is not in the context, say you couldn't find it in the uploaded documents. Do not make things up.
- Cite the excerpts you used with their numbers, like [1] or [2][3].
- Be clear and concise. Use bullet points or tables when they help.
- Reply in the same language the user writes in.`;

export const DEFAULT_SETTINGS = {
  mode: 'proxy',            // 'proxy' | 'direct' | 'none'
  proxyUrl: '/api/chat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  temperature: 0.2,
  topK: 6,
  botName: 'Document Assistant',
  welcome: 'Ask me anything about the uploaded documents.',
  systemPrompt: DEFAULT_PROMPT,
};
const SETTINGS_KEY = 'rag-settings';
export function getSettings() {
  let s;
  try { s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { s = { ...DEFAULT_SETTINGS }; }
  // Opened straight from disk (file://): there is no /api/chat, so show matching passages instead
  if (location.protocol === 'file:' && s.mode === 'proxy') s.mode = 'none';
  return s;
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
  notify('settings');
}

/* ───────────────────────── Prompt + LLM ───────────────────────── */
export function buildMessages({ question, contexts, history = [], settings }) {
  const ctx = contexts
    .map((c, i) => `[${i + 1}] Source: ${c.docName}${c.loc ? ` (${c.loc})` : ''}\n${c.text}`)
    .join('\n\n---\n\n');
  const system = `${settings.systemPrompt}\n\nCONTEXT:\n${ctx || '(No relevant excerpts were found in the uploaded documents.)'}`;
  const hist = history.slice(-6).map((m) => ({ role: m.role, content: m.content }));
  return [{ role: 'system', content: system }, ...hist, { role: 'user', content: question }];
}

// Streams an OpenAI-compatible chat completion. Works with the /api/chat proxy or directly.
export async function streamChat(messages, settings, onToken, signal) {
  const headers = { 'Content-Type': 'application/json' };
  const body = { messages, stream: true, temperature: Number(settings.temperature) || 0 };
  let url;
  if (settings.mode === 'direct') {
    url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
    body.model = settings.model;
  } else {
    url = settings.proxyUrl;
  }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`LLM request failed (${r.status}): ${(await r.text()).slice(0, 300)}`);

  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {
    const j = await r.json();
    const t = j.choices?.[0]?.message?.content ?? j.answer ?? '';
    onToken(t);
    return t;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith('data:')) continue;
      const data = l.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const d = JSON.parse(data).choices?.[0]?.delta?.content;
        if (d) { full += d; onToken(d); }
      } catch { /* ignore keep-alives / partial lines */ }
    }
  }
  return full;
}

// Fallback answer when no LLM is connected: show the best passages.
export function extractiveAnswer(contexts) {
  if (!contexts.length) return "I couldn't find anything about that in the uploaded documents.";
  return '_No language model is connected yet, so here are the most relevant passages from the documents:_\n\n' +
    contexts.slice(0, 3).map((c, i) => `**[${i + 1}] ${c.docName}${c.loc ? ` — ${c.loc}` : ''}**\n\n> ${c.text.slice(0, 600).replace(/\n/g, '\n> ')}`).join('\n\n');
}

/* ───────────────────────── Export / publish ───────────────────────── */
export async function exportKB() {
  const s = getSettings();
  const { apiKey, ...publicSettings } = s; // never export the API key
  return { version: 1, exportedAt: new Date().toISOString(), settings: publicSettings, docs: await listDocs(), chunks: await getAllChunks() };
}

export async function importKB(data, { asPublished = false } = {}) {
  if (!data || !Array.isArray(data.docs) || !Array.isArray(data.chunks)) throw new Error('Not a valid knowledge-base file.');
  const docs = data.docs.map((d) => ({ ...d, source: asPublished ? 'published' : d.source || 'local' }));
  if (asPublished) {
    const keep = new Set(docs.map((d) => d.id));
    for (const d of await listDocs()) if (d.source === 'published' && !keep.has(d.id)) await deleteDoc(d.id);
  }
  await putMany(docs, data.chunks);
}

// User page: load /knowledge-base.json (published by the admin) if present and newer.
export async function syncPublishedKB(url = 'knowledge-base.json') {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return false;
    const data = await r.json();
    const marker = localStorage.getItem('rag-published-at');
    if (marker === data.exportedAt) return false;
    await importKB(data, { asPublished: true });
    if (data.settings && !localStorage.getItem('rag-settings')) {
      saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
    }
    localStorage.setItem('rag-published-at', data.exportedAt);
    return true;
  } catch { return false; }
}

/* ───────────────────────── Small helpers ───────────────────────── */
export function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

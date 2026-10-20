# Document Assistant — RAG chatbot

Two pages:

| Page | URL | What it does |
|---|---|---|
| **Document upload** (home) | `/` (`index.html`) | Upload any document → text is extracted, chunked and indexed **in the browser**. Has an **Open chatbot** button. |
| **Chatbot** | `/chat.html` | ChatGPT-style chat. Users ask questions; answers come only from the uploaded documents, with clickable source citations. Chat history, stop button, dark mode, mobile layout. |

## How the RAG pipeline works

```
Upload file ──► extract text ──► split into ~1000-char chunks (200 overlap) ──► store in IndexedDB
                                                                                          │
User question ──► BM25 keyword search over chunks ──► top-K passages ──► prompt + passages ──► LLM ──► streamed answer [1][2]
```

**Supported files:** PDF (scanned PDFs are OCR'd), DOCX, PPTX, XLSX/XLS/ODS, CSV, TXT, MD, JSON, HTML, RTF, and images (PNG/JPG/WEBP via OCR). Legacy `.doc`/`.ppt` must be re-saved as `.docx`/`.pptx` or PDF.

## Run locally

Requires Node.js 18+ — no `npm install` needed.

```bash
cp .env.example .env      # then paste your Groq key into GROQ_API_KEY
node dev-server.js
```

Open http://localhost:3000/, upload documents, then click **Open chatbot**.

## LLM: Groq

The chatbot sends requests to `/api/chat` (`api/chat.js`), which calls **Groq** and keeps your key on the server.

1. Create a free key at https://console.groq.com/keys
2. Set `GROQ_API_KEY` (in `.env` locally, or in Vercel environment variables).

Default model is `openai/gpt-oss-120b` (Groq's current production model; `llama-3.3-70b-versatile` was retired on 16 Aug 2026). Change it with `LLM_MODEL`, e.g. `openai/gpt-oss-20b` for faster answers. Other providers (OpenAI, Gemini, Claude, Ollama) still work — see `.env.example`.

## Deploy on Vercel

1. Push this folder to a GitHub repo and import it in Vercel (framework preset: **Other**, no build command).
2. Add `GROQ_API_KEY` in Project → Settings → Environment Variables, then redeploy.

### Where documents are stored

Documents are processed and stored in the browser that uploaded them (IndexedDB), so the chatbot on that same browser can answer from them. Visitors on other devices won't see them. To share one set of documents with every visitor, the next step is server storage (see below) or a `knowledge-base.json` file in the project root — the chatbot loads that file automatically if present (`exportKB()` in `assets/rag.js` produces it).

### Who can upload

The upload page has no login, so anyone who opens it can add or delete documents (in their own browser). If you deploy publicly and only want the chatbot open to everyone, protect `index.html` with your host (e.g. Vercel Password Protection) or run the upload page only locally — it only needs to produce `knowledge-base.json`.

## Project structure

```
index.html          Document upload page (home)
chat.html           Chatbot page
assets/rag.js       RAG engine: extraction, chunking, IndexedDB, BM25 search, prompt, LLM streaming
assets/styles.css   Shared styles (light/dark)
api/chat.js         Server-side LLM proxy (Vercel Edge function; also used by dev-server.js)
dev-server.js       Local dev server (static files + /api/chat)
.env.example        LLM configuration examples
```

## Ideas for next steps

- **Semantic search:** add embeddings (e.g. `@xenova/transformers` in the browser or an embeddings API) and combine with BM25 for better matching on paraphrased questions.
- **Shared server storage:** store chunks in a database (Supabase/pgvector, Vercel Blob) so uploads go live instantly without the publish step.
- **Sign-in for uploaders** if the site goes public (Clerk, Auth.js, Supabase Auth).

# AGM Complaint Hub — Full Stack

## What is included
- `server_full.py` — Flask backend (JWT demo auth, SQLite persistence, S3 presign optional, OpenAI proxy with SSE streaming and embeddings for RAG)
- `index.html`, `styles.css`, `script_full.js` — Frontend
- `Dockerfile`, `requirements.txt`
- `.github/workflows/deploy.yml` — example CI deploy

## Quick local run
1. Create virtualenv:
   ```bash
   python -m venv venv
   source venv/bin/activate
   ```
2. Install:
   ```bash
   pip install -r requirements.txt
   ```
3. Set env vars:
   - `OPENAI_API_KEY` (required)
   - `JWT_SECRET` (recommended)
   - (optional) `AWS_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
4. Run:
   ```bash
   python server_full.py
   ```
5. Serve frontend (same folder) with a static server or open `index.html` in browser.
   For same-origin API calls, run frontend from same host or set `API_BASE` appropriately.

## Security notes
- Do NOT commit secrets to Git.
- Monitor OpenAI usage to avoid unexpected costs.
- Add rate limiting and proper auth for production.


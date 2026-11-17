# CloudLabs Workshop Operations Dashboard

A table-first operations console for a simulated Azure workshop with 120 learner lab environments. It is designed to help an instructor spot failures, find stuck learners, monitor spend, and take action quickly.

**Design intent:** restrained operations-console styling, dense scan-friendly data, explicit AI provenance, and status color used only to communicate environment state.

<img width="1910" height="918" alt="image" src="https://github.com/user-attachments/assets/1d442ad2-cc40-43d4-8465-a8d643cae829" />
<img width="1553" height="822" alt="image" src="https://github.com/user-attachments/assets/8eb08018-96ec-4bcd-8404-5b5fcc6f9f2b" />


## Stack
- Frontend: React + Vite
- Backend: FastAPI
- Database: SQLite
- Local AI: Ollama (`gemma3:1b` by default)
- Safety path: deterministic rule-based recommendations when Ollama is unavailable or returns unusable output

## Run locally

### 1. Backend
Use Python 3.10+.

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Copy `.env.example` to `.env`. Ollama must be installed and running locally.

```env
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma3:1b
AI_CACHE_TTL_SECONDS=180
MAX_AI_ITEMS=5
```

If needed, download the model:

```powershell
ollama pull gemma3:1b
```

Start the API from the project root:

```powershell
uvicorn main:app --host 0.0.0.0 --reload --port 8000
```

API docs: http://127.0.0.1:8000/docs

### 2. Frontend
Open a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

If the backend is hosted elsewhere, copy `frontend/.env.example` to `frontend/.env` and update `VITE_API_URL`.

## What works
- Automatically seeds 120 synthetic learner environments into SQLite when the database is empty.
- Live environment table with server-side filtering, sorting, search, progress, runtime, and spend.
- Session summary: active count, failures, estimated spend, hourly burn rate, and average completion.
- Environment distribution across provisioning, ready, in-use, failed, and deprovisioned states.
- Reprovision action changes a failed environment to `provisioning`; the next fetch reflects the mutation.
- Server-side drift simulation updates environment telemetry. The frontend polls for changes without sending extra drift ticks.
- At-risk learner triage uses Ollama for a compact priority batch and deterministic rules for the remaining learners.
- The UI identifies which recommendations came from Ollama and which came from rules.
- If Ollama is unavailable, returns invalid JSON, or times out, the API provides rule-based guidance instead.
- Re-run analysis forces a fresh Ollama request; normal dashboard polling does not repeatedly trigger AI analysis.
- Reset demo action restores the seeded 120-environment dataset.
- Loading, error, empty, and dense 120-row states.

## API endpoints
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Backend and Ollama configuration status |
| GET | `/api/environments` | Filter/search/sort environment rows |
| GET | `/api/summary` | Session aggregations and state counts |
| GET | `/api/at-risk` | Rule-based at-risk list |
| GET | `/api/at-risk/ai` | Ollama analysis with rule-based fallback |
| POST | `/api/environments/{learner_id}/reprovision` | Move a failed environment to provisioning |
| POST | `/api/simulate/drift` | Manually advance the demo simulation |
| POST | `/api/demo/reset` | Restore the 120-row demo dataset |

## Demo checklist
1. Start Ollama, backend, and frontend; confirm the 120 environments appear.
2. Confirm the At-risk learners panel shows `OLLAMA · LOCAL AI` when the model responds.
3. Confirm the panel shows `RULE-BASED FALLBACK` if Ollama is stopped.
4. Filter to `Failed`; reprovision one learner and confirm its state changes to `Provisioning`.
5. Search a learner ID and sort by time on step or spend.
6. Use Reset demo before the final recording to restore a balanced starting dataset.
7. Capture the dense environment table and AI provenance panel.

## Data and limitations
All learner records and Azure environment states are synthetic. This prototype does not provision, inspect, or connect to real Azure resources. Estimated spend is illustrative and calculated from the seeded hourly rate and runtime. Ollama runs locally on the machine hosting the backend; a browser on another device uses the backend's AI service and does not need its own Ollama installation.

## AI assistant use
ChatGPT was used to scaffold and refine parts of the API, UI, and documentation. The interface avoids generic gradient KPI cards and instead prioritizes a dense table, clear status distribution, and transparent AI-versus-rules provenance. The AI feature is bounded: deterministic backend rules identify at-risk candidates, Ollama explains a small priority batch, learner IDs are validated, and deterministic fallback covers the rest.

# Engineering decisions

**Data model.** One SQLite row represents one learner's provisioned lab environment. It stores learner/environment identifiers, state, current step, progress, time on step, runtime, hourly rate, and update time. The backend seeds 120 synthetic rows on first run; CSV is unnecessary for this prototype.

**Server-side logic.** Filtering, sorting, spend calculation, and session aggregates live in FastAPI so the browser receives consistent results and the UI does not own business rules. The reprovision endpoint mutates a failed row in SQLite. A server-side drift endpoint changes selected telemetry so polling reflects changing session conditions.

**AI and fail-safe.** Deterministic rules select candidates using actual state and time-on-step fields. Ollama (local LLM, `gemma3:1b` by default) receives only those candidates and is asked to explain risk and suggest next actions. The API validates every returned learner ID against the candidate set, fills missing entries with rule-based results, and falls back entirely to rules if Ollama is unreachable, times out, returns invalid JSON, or the parsed result contains no usable IDs. The dashboard remains fully usable without Ollama. LLM analysis is not triggered by each telemetry poll; it runs on initial load and explicit re-analysis to avoid hammering a cold model.

**Trade-offs and next steps.** SQLite and synthetic telemetry keep the 6–8 hour prototype small and reproducible. A production version would connect to Azure resource telemetry, use a managed database, add authentication/authorization, audit actions, and validate spend against actual billing data. Add automated API/UI tests and capture the required 60–90 second demo before submission.

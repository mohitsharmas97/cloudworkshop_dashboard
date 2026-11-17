"""CloudLabs Workshop Operations API.

Run:  uvicorn main:app --host 0.0.0.0 --reload --port 8000
"""
import asyncio
import hashlib
import json
import logging
import os
import random
import re
import statistics
import threading
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import (DateTime, Float, Integer, String, case, create_engine,
                        event, func, inspect, select)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cloudlabs")

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./cloudlabs.db")
DRIFT_ENABLED = os.getenv("DRIFT_ENABLED", "true").lower() == "true"
DRIFT_INTERVAL = float(os.getenv("DRIFT_INTERVAL_SECONDS", "4"))  # 1 tick = 1 simulated minute
ENABLE_DEMO = os.getenv("ENABLE_DEMO_ENDPOINTS", "true").lower() == "true"
CORS_ORIGINS = [o.strip() for o in os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]

STATES = ["provisioning", "ready", "in_use", "failed", "deprovisioned"]
STATE_RANK = {"failed": 0, "provisioning": 1, "in_use": 2, "ready": 3, "deprovisioned": 4}
RUNNING = ("provisioning", "ready", "in_use")  # billed states
TOTAL_STEPS = 5
STEP_NAMES = ["Create resource group", "Deploy virtual network", "Provision VM",
              "Configure storage", "Deploy and verify app"]
FAILURE_REASONS = [
    "QuotaExceeded: regional vCPU limit",
    "ImagePullBackOff: lab image unavailable",
    "NetworkProvisioningTimeout",
    "DeploymentTimeout: ARM template",
    "VM out of memory, instance killed",
]
LEVELS = ["low", "medium", "high"]
SEV = {name: i for i, name in enumerate(LEVELS)}

# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #
is_sqlite = DATABASE_URL.startswith("sqlite")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if is_sqlite else {})
if is_sqlite:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(conn, _):
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
write_lock = threading.Lock()  # serialises drift, reprovision and reset


class Base(DeclarativeBase):
    pass


class Environment(Base):
    __tablename__ = "environments"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    learner_id: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    learner_name: Mapped[str] = mapped_column(String(80))
    environment_name: Mapped[str] = mapped_column(String(80), unique=True)
    state: Mapped[str] = mapped_column(String(20), index=True)
    current_step: Mapped[int] = mapped_column(Integer, default=1)
    total_steps: Mapped[int] = mapped_column(Integer, default=TOTAL_STEPS)
    progress_percent: Mapped[int] = mapped_column(Integer, default=0)
    # Minutes in the current step (in_use), or in the current state (others).
    time_on_step_minutes: Mapped[int] = mapped_column(Integer, default=0)
    # Billed minutes. Only accrues while provisioning / ready / in_use.
    runtime_minutes: Mapped[int] = mapped_column(Integer, default=0)
    hourly_rate: Mapped[float] = mapped_column(Float, default=0.50)
    failure_reason: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    reprovision_count: Mapped[int] = mapped_column(Integer, default=0)
    pace: Mapped[float] = mapped_column(Float, default=0.05)  # per-minute chance to finish a step (sim only)
    updated_at: Mapped[datetime] = mapped_column(DateTime)  # naive UTC


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds") + "Z"


def ensure_schema():
    """Demo data only: if an older schema exists, recreate it."""
    insp = inspect(engine)
    if insp.has_table("environments"):
        existing = {c["name"] for c in insp.get_columns("environments")}
        wanted = {c.name for c in Environment.__table__.columns}
        if not wanted <= existing:
            log.warning("Old schema detected, recreating demo tables")
            Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)


# --------------------------------------------------------------------------- #
# Domain logic
# --------------------------------------------------------------------------- #
def progress_for(r: Environment) -> int:
    per = 100 // r.total_steps
    if r.state == "deprovisioned":
        return 100
    base = (r.current_step - 1) * per
    if r.state == "in_use":
        base += min(per - 1, r.time_on_step_minutes * per // 15)
    return min(99, base)


def spend(r: Environment) -> float:
    return round(r.hourly_rate * r.runtime_minutes / 60, 2)


def serialize(r: Environment) -> dict:
    idx = min(max(r.current_step, 1), len(STEP_NAMES)) - 1
    return {
        "learner_id": r.learner_id, "learner_name": r.learner_name,
        "environment_name": r.environment_name, "state": r.state,
        "current_step": r.current_step, "total_steps": r.total_steps,
        "step_name": STEP_NAMES[idx], "progress_percent": r.progress_percent,
        "time_on_step_minutes": r.time_on_step_minutes,
        "runtime_minutes": r.runtime_minutes, "hourly_rate": r.hourly_rate,
        "estimated_spend": spend(r), "failure_reason": r.failure_reason,
        "reprovision_count": r.reprovision_count, "updated_at": iso(r.updated_at),
    }


def seed_database():
    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(Environment)):
            return
        rng = random.Random(42)
        dist = (["in_use"] * 54 + ["ready"] * 24 + ["provisioning"] * 16 +
                ["failed"] * 14 + ["deprovisioned"] * 12)
        rng.shuffle(dist)
        now = utcnow()
        for i, state in enumerate(dist, start=1):
            rate = rng.choice([0.35, 0.50, 0.65, 0.80])
            pace = rng.uniform(0.015, 0.04)
            step, tos, runtime, reason = 1, 0, 0, None
            if state == "provisioning":
                tos = rng.randint(22, 40) if rng.random() < 0.2 else rng.randint(1, 12)
                runtime = tos
            elif state == "ready":
                tos = rng.randint(0, 10)
                runtime = tos + rng.randint(5, 20)
            elif state == "in_use":
                step = rng.randint(1, TOTAL_STEPS)
                slow = rng.random() < 0.14  # these learners get stuck
                tos = rng.randint(24, 55) if slow else rng.randint(1, 18)
                pace = 0.004 if slow else pace
                runtime = (step - 1) * rng.randint(14, 26) + tos + rng.randint(8, 20)
            elif state == "failed":
                step = rng.randint(1, TOTAL_STEPS)
                tos = rng.randint(2, 40)  # minutes since failure
                reason = rng.choice(FAILURE_REASONS)
                runtime = (step - 1) * rng.randint(14, 26) + rng.randint(5, 25)
            else:  # deprovisioned = finished and torn down
                step = TOTAL_STEPS
                runtime = rng.randint(80, 150)
            row = Environment(
                learner_id=f"LRN-{i:03d}", learner_name=f"Learner {i:03d}",
                environment_name=f"azure-lab-{i:03d}", state=state,
                current_step=step, total_steps=TOTAL_STEPS, progress_percent=0,
                time_on_step_minutes=tos, runtime_minutes=runtime, hourly_rate=rate,
                failure_reason=reason, reprovision_count=0, pace=pace,
                updated_at=now - timedelta(minutes=tos),
            )
            row.progress_percent = progress_for(row)
            db.add(row)
        db.commit()


# ---- simulated drift: one tick == one simulated minute ---------------------- #
def _move(r: Environment, state: str, now: datetime) -> bool:
    r.state, r.time_on_step_minutes, r.updated_at = state, 0, now
    r.progress_percent = progress_for(r)
    return True


def _fail(r: Environment, now: datetime) -> bool:
    r.failure_reason = random.choice(FAILURE_REASONS)
    return _move(r, "failed", now)


def _step(r: Environment, now: datetime) -> bool:
    """Advance one simulated minute. True if the state or step changed."""
    if r.state == "deprovisioned":
        return False
    r.time_on_step_minutes += 1
    if r.state == "failed":
        return False  # failed environments are not billed
    r.runtime_minutes += 1
    if r.state == "provisioning":
        if random.random() < (0.03 if r.time_on_step_minutes > 30 else 0.01):
            return _fail(r, now)
        if random.random() < 0.06:
            return _move(r, "ready", now)
    elif r.state == "ready":
        if random.random() < 0.04:
            return _move(r, "in_use", now)
    elif r.state == "in_use":
        if random.random() < 0.0015:
            return _fail(r, now)
        if random.random() < r.pace:
            if r.current_step >= r.total_steps:
                return _move(r, "deprovisioned", now)
            r.current_step += 1
            return _move(r, "in_use", now)
        r.progress_percent = progress_for(r)
    return False


def drift_tick(minutes: int = 1) -> dict:
    transitions = 0
    with write_lock, SessionLocal() as db:
        rows = db.scalars(select(Environment).where(
            Environment.state.in_(RUNNING + ("failed",)))).all()
        now = utcnow()
        for r in rows:
            for _ in range(minutes):
                if _step(r, now):
                    transitions += 1
        db.commit()
    return {"ticks": minutes, "transitions": transitions}


async def drift_loop():
    while True:
        await asyncio.sleep(DRIFT_INTERVAL)
        try:
            await asyncio.to_thread(drift_tick)
        except Exception:
            log.exception("drift tick failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(drift_loop()) if DRIFT_ENABLED else None
    yield
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


ensure_schema()
seed_database()

app = FastAPI(title="CloudLabs Workshop Operations API", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

# --------------------------------------------------------------------------- #
# SQL expressions used for server-side sorting / aggregation
# --------------------------------------------------------------------------- #
SPEND_EXPR = Environment.hourly_rate * Environment.runtime_minutes / 60.0
STATE_RANK_EXPR = case(STATE_RANK, value=Environment.state, else_=9)
SORT_COLUMNS = {
    "learner_id": Environment.learner_id,
    "state": STATE_RANK_EXPR,  # failed first
    "current_step": Environment.current_step,
    "progress_percent": Environment.progress_percent,
    "time_on_step_minutes": Environment.time_on_step_minutes,
    "runtime_minutes": Environment.runtime_minutes,
    "estimated_spend": SPEND_EXPR,
}


def like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/")
def root():
    return {"service": "CloudLabs Workshop Operations API", "docs": "/docs"}


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "database": "connected",
        "drift_enabled": DRIFT_ENABLED,
        "ollama_configured": True,
        "ollama_host": os.getenv("OLLAMA_HOST", "http://localhost:11434").strip(),
        "ollama_model": os.getenv("OLLAMA_MODEL", "gemma3:1b").strip(),
        "ai_provider_order": ["ollama", "rules"],
    }


@app.get("/api/environments")
def list_environments(
    state: Optional[str] = Query(None, description="one state or comma-separated list, or 'all'"),
    search: Optional[str] = None,
    step: Optional[int] = Query(None, ge=1, le=TOTAL_STEPS),
    min_stuck_minutes: Optional[int] = Query(None, ge=0),
    sort_by: str = Query("state", pattern="^(" + "|".join(SORT_COLUMNS) + ")$"),
    order: str = Query("asc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(120, ge=1, le=200),
    debug_delay_ms: int = Query(0, ge=0, le=5000),
    debug_fail: bool = False,
):
    if ENABLE_DEMO:  # lets you demo the loading and error states
        if debug_delay_ms:
            time.sleep(debug_delay_ms / 1000)
        if debug_fail:
            raise HTTPException(500, "Simulated server error")

    conditions = []
    if state and state != "all":
        wanted = [s.strip() for s in state.split(",") if s.strip()]
        bad = [s for s in wanted if s not in STATES]
        if bad:
            raise HTTPException(400, f"Unknown environment state: {', '.join(bad)}")
        conditions.append(Environment.state.in_(wanted))
    if search and search.strip():
        term = f"%{like_escape(search.strip())}%"
        conditions.append(
            Environment.learner_id.ilike(term, escape="\\")
            | Environment.learner_name.ilike(term, escape="\\")
            | Environment.environment_name.ilike(term, escape="\\"))
    if step is not None:
        conditions.append(Environment.current_step == step)
    if min_stuck_minutes is not None:
        conditions.append(Environment.time_on_step_minutes >= min_stuck_minutes)

    col = SORT_COLUMNS[sort_by]
    ordering = col.desc() if order == "desc" else col.asc()
    with SessionLocal() as db:
        total = db.scalar(select(func.count()).select_from(Environment).where(*conditions))
        rows = db.scalars(
            select(Environment).where(*conditions)
            .order_by(ordering, Environment.learner_id.asc())
            .offset((page - 1) * page_size).limit(page_size)).all()
        return {"items": [serialize(r) for r in rows], "total": total,
                "page": page, "page_size": page_size}


@app.get("/api/summary")
def summary(stuck_minutes: int = Query(20, ge=1, le=240)):
    with SessionLocal() as db:
        total, spend_total, avg_progress = db.execute(select(
            func.count(),
            func.coalesce(func.sum(SPEND_EXPR), 0.0),
            func.coalesce(func.avg(Environment.progress_percent), 0.0),
        ).select_from(Environment)).one()
        counts = dict(db.execute(
            select(Environment.state, func.count()).group_by(Environment.state)).all())
        burn = db.scalar(select(func.coalesce(func.sum(Environment.hourly_rate), 0.0))
                         .where(Environment.state.in_(RUNNING)))
        stuck = db.scalar(select(func.count()).select_from(Environment).where(
            Environment.state == "in_use",
            Environment.time_on_step_minutes >= stuck_minutes))
        by_step = dict(db.execute(
            select(Environment.current_step, func.count())
            .where(Environment.state == "in_use").group_by(Environment.current_step)).all())
        state_counts = {s: counts.get(s, 0) for s in STATES}
        return {
            "total_environments": total,
            "active_count": sum(state_counts[s] for s in RUNNING),  # billed environments
            "failure_count": state_counts["failed"],
            "stuck_count": stuck,
            "stuck_threshold_minutes": stuck_minutes,
            "estimated_spend": round(spend_total, 2),
            "burn_rate_per_hour": round(burn, 2),
            "average_completion": round(avg_progress, 1),  # across all environments
            "state_counts": state_counts,
            "in_use_by_step": {str(s): by_step.get(s, 0) for s in range(1, TOTAL_STEPS + 1)},
            "generated_at": iso(utcnow()),
        }


@app.post("/api/environments/{learner_id}/reprovision")
def reprovision(learner_id: str):
    with write_lock, SessionLocal() as db:
        row = db.scalar(select(Environment).where(Environment.learner_id == learner_id))
        if not row:
            raise HTTPException(404, "Learner environment not found")
        if row.state != "failed":
            raise HTTPException(409, "Only failed environments can be reprovisioned")
        row.state = "provisioning"
        row.failure_reason = None
        row.time_on_step_minutes = 0
        row.reprovision_count += 1
        row.updated_at = utcnow()
        row.progress_percent = progress_for(row)
        db.commit()
        db.refresh(row)
        return {"message": f"{learner_id} moved to provisioning", "environment": serialize(row)}


@app.post("/api/simulate/drift")
def simulate_drift(ticks: int = Query(1, ge=1, le=60)):
    if not ENABLE_DEMO:
        raise HTTPException(404, "Not found")
    return drift_tick(ticks)


@app.post("/api/demo/reset")
def reset_demo():
    if not ENABLE_DEMO:
        raise HTTPException(404, "Not found")
    with write_lock:
        with SessionLocal() as db:
            db.query(Environment).delete()
            db.commit()
        seed_database()
    return {"message": "Demo dataset reset to 120 environments"}


# --------------------------------------------------------------------------- #
# At-risk learners: rules first, Ollama optional
# --------------------------------------------------------------------------- #
def get_risk_candidates(db, stuck_minutes: int) -> list[dict]:
    rows = db.scalars(select(Environment).where(
        Environment.state.in_(["failed", "in_use", "provisioning"]))).all()
    in_use_steps = [r.current_step for r in rows if r.state == "in_use"]
    median = statistics.median(in_use_steps) if in_use_steps else None
    high_at = stuck_minutes * 2
    out = []
    for r in rows:
        sev, reasons = 0, []  # 0 none, 1 medium, 2 high
        tos = r.time_on_step_minutes
        if r.state == "failed":
            sev = 2
            reasons.append(f"Failed {tos} min ago: {r.failure_reason or 'unknown cause'}")
            if r.reprovision_count:
                reasons.append(f"already reprovisioned {r.reprovision_count}x")
        elif tos >= stuck_minutes:
            sev = 2 if tos >= high_at else 1
            reasons.append(f"{tos} min on step {r.current_step}" if r.state == "in_use"
                           else f"provisioning for {tos} min")
        if r.state == "in_use" and median is not None and median - r.current_step >= 2:
            sev = max(sev, 1)
            reasons.append(f"{median - r.current_step:g} steps behind cohort median (step {median:g})")
        if sev:
            out.append({**serialize(r), "observed_reason": "; ".join(reasons),
                        "rule_severity": LEVELS[sev], "_sort": (-sev, -tos)})
    out.sort(key=lambda c: c["_sort"])
    for c in out:
        c.pop("_sort")
    return out


def rule_action(c: dict) -> str:
    if c["state"] == "failed":
        return f"Reprovision the environment and check logs for: {c['failure_reason'] or 'unknown cause'}."
    if c["state"] == "provisioning":
        return "Check provisioning status; reprovision if it does not progress."
    return f"Check in with the learner on step {c['current_step']} ({c['step_name']})."


def evidence_of(c: dict) -> dict:
    """Facts straight from the database, always shown next to any AI text."""
    return {"state": c["state"], "step": f"{c['current_step']}/{c['total_steps']}",
            "step_name": c["step_name"], "time_on_step_minutes": c["time_on_step_minutes"],
            "runtime_minutes": c["runtime_minutes"], "failure_reason": c["failure_reason"],
            "reprovision_count": c["reprovision_count"]}


def make_item(c: dict, risk_level: str, reason: str, action: str, source: str) -> dict:
    return {"learner_id": c["learner_id"], "learner_name": c["learner_name"],
            "risk_level": risk_level, "reason": reason, "recommended_action": action,
            "source": source, "evidence": evidence_of(c)}


def rules_items(candidates: list[dict]) -> list[dict]:
    return [make_item(c, c["rule_severity"], c["observed_reason"], rule_action(c), "rules")
            for c in candidates]


@app.get("/api/at-risk")
def at_risk(stuck_minutes: int = Query(20, ge=1, le=240)):
    with SessionLocal() as db:
        candidates = get_risk_candidates(db, stuck_minutes)
    return {"mode": "rules",
            "summary": f"{len(candidates)} learners need attention based on state, time on step and cohort progress.",
            "items": rules_items(candidates)}


# ---- AI provider: local Ollama -> deterministic rules fallback ----------------
AI_CACHE_TTL = int(os.getenv("AI_CACHE_TTL_SECONDS", "180"))
MAX_AI_ITEMS = int(os.getenv("MAX_AI_ITEMS", "5"))
_ai_cache = {"key": None, "at": 0.0, "payload": None}
_ai_lock = threading.Lock()


class AIProviderError(Exception):
    pass


def _extract_json(text: str) -> dict:
    """Parse JSON while tolerating code fences or a short model preamble."""
    if not isinstance(text, str) or not text.strip():
        raise AIProviderError("Ollama returned an empty response.")

    cleaned = text.strip().lstrip("\ufeff")
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        value = None
        decoder = json.JSONDecoder()
        for index, char in enumerate(cleaned):
            if char == "{":
                try:
                    candidate, _ = decoder.raw_decode(cleaned[index:])
                    if isinstance(candidate, dict):
                        value = candidate
                        break
                except json.JSONDecodeError:
                    continue

    if not isinstance(value, dict) or not isinstance(value.get("items"), list):
        preview = cleaned[:180].replace("\n", " ")
        raise AIProviderError(
            "Ollama returned invalid JSON or an unexpected structure. "
            f"Response began: {preview}"
        )
    return value


def call_ollama(model: str, prompt: str) -> dict:
    """Call local Ollama with JSON mode and a generous cold-start timeout."""
    base_url = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Return exactly one valid JSON object and nothing else. "
                    "No markdown, no code fences, no preamble. Shape: "
                    '{"summary":"short summary","items":['
                    '{"learner_id":"LRN-001","risk_level":"high",'
                    '"reason":"evidence-based reason",'
                    '"recommended_action":"practical next step"}]}'
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "format": "json",
        "keep_alive": "5m",
        "options": {"temperature": 0, "num_predict": 700, "num_ctx": 4096},
    }

    try:
        response = requests.post(
            f"{base_url}/api/chat", json=body, timeout=(5, 180)
        )
    except requests.Timeout as exc:
        raise AIProviderError(
            "Ollama timed out; rule-based guidance is being used."
        ) from exc
    except requests.RequestException as exc:
        raise AIProviderError(
            "Could not connect to Ollama. Check that the Ollama app is running."
        ) from exc

    if not response.ok:
        log.warning("Ollama HTTP %s: %s", response.status_code, response.text[:400])
        if response.status_code == 404:
            raise AIProviderError(
                f"Ollama model '{model}' was not found. Run: ollama pull {model}"
            )
        raise AIProviderError(f"Ollama request failed with HTTP {response.status_code}.")

    try:
        content = response.json().get("message", {}).get("content", "")
    except (ValueError, AttributeError, TypeError) as exc:
        raise AIProviderError("Ollama returned an unexpected response.") from exc
    return _extract_json(content)


def build_prompt(candidates: list[dict]) -> str:
    compact = [
        {
            "learner_id": c["learner_id"],
            "state": c["state"],
            "step": f'{c["current_step"]}/{c["total_steps"]}',
            "step_name": c["step_name"],
            "minutes_in_state_or_step": c["time_on_step_minutes"],
            "failure_reason": c["failure_reason"],
            "rule_risk": c["rule_severity"],
            "observed_reason": c["observed_reason"],
        }
        for c in candidates
    ]
    return (
        "Review these Azure workshop learners using only the supplied facts. "
        "Return JSON with keys summary and items. Each item needs learner_id, "
        "risk_level (high/medium/low), reason, recommended_action. "
        "Include every supplied learner ID exactly once. Do not invent facts. "
        "Keep reason and action under 18 words. JSON only. Learners: "
        + json.dumps(compact, separators=(",", ":"))
    )


def _validate_ai_result(parsed: dict, candidates: list[dict], provider: str, model: str) -> dict:
    by_id = {c["learner_id"]: c for c in candidates}
    validated = {}
    for item in parsed.get("items", []):
        if not isinstance(item, dict):
            continue
        learner_id = item.get("learner_id")
        if learner_id not in by_id or learner_id in validated:
            continue
        candidate = by_id[learner_id]
        level = item.get("risk_level")
        if level not in SEV:
            level = "medium"
        # An LLM cannot downgrade risk identified by deterministic rules.
        if SEV[level] < SEV[candidate["rule_severity"]]:
            level = candidate["rule_severity"]
        validated[learner_id] = make_item(
            candidate,
            level,
            str(item.get("reason") or candidate["observed_reason"])[:300],
            str(item.get("recommended_action") or rule_action(candidate))[:300],
            provider,
        )

    items = [
        validated.get(c["learner_id"]) or make_item(
            c, c["rule_severity"], c["observed_reason"], rule_action(c), "rules"
        )
        for c in candidates
    ]
    ai_count = sum(item["source"] == provider for item in items)
    if ai_count == 0:
        raise AIProviderError(f"{provider} returned no usable learner recommendations.")
    return {
        "mode": provider,
        "summary": str(parsed.get("summary") or f"{provider} reviewed {ai_count} learners.")[:400],
        "items": items,
        "ai_items": ai_count,
        "model": model,
        "provider": provider,
    }


@app.get("/api/at-risk/ai")
def at_risk_ai(stuck_minutes: int = Query(20, ge=1, le=240), refresh: bool = False):
    with SessionLocal() as db:
        candidates = get_risk_candidates(db, stuck_minutes)

    def fallback(message: str):
        return {
            "mode": "rules_fallback",
            "provider": "rules",
            "summary": f"{message} Showing rule-based guidance for {len(candidates)} learners.",
            "items": rules_items(candidates),
            "ai_items": 0,
        }

    if not candidates:
        return {
            "mode": "rules", "provider": "rules",
            "summary": "No learners currently meet the at-risk rules.",
            "items": [], "ai_items": 0,
        }

    model = os.getenv("OLLAMA_MODEL", "gemma3:1b").strip() or "gemma3:1b"
    batch = candidates[:MAX_AI_ITEMS]

    stable_fields = (
        "learner_id", "state", "current_step", "failure_reason",
        "rule_severity", "reprovision_count",
    )
    stable_snapshot = [
        {key: candidate.get(key) for key in stable_fields}
        for candidate in batch
    ]
    cache_key = hashlib.sha256(
        (model + json.dumps(stable_snapshot, sort_keys=True)).encode()
    ).hexdigest()
    now = time.time()

    with _ai_lock:
        if (
            not refresh
            and _ai_cache["key"] == cache_key
            and now - _ai_cache["at"] < AI_CACHE_TTL
        ):
            return {**_ai_cache["payload"], "cached": True}

    try:
        parsed = call_ollama(model, build_prompt(batch))
        payload = _validate_ai_result(parsed, batch, "ollama", model)

        # AI reviews the highest-priority batch; rules cover all remaining learners.
        if len(candidates) > len(batch):
            known = {item["learner_id"] for item in payload["items"]}
            payload["items"].extend(
                make_item(c, c["rule_severity"], c["observed_reason"],
                          rule_action(c), "rules")
                for c in candidates[len(batch):]
                if c["learner_id"] not in known
            )

        with _ai_lock:
            _ai_cache.update(key=cache_key, at=time.time(), payload=payload)
        return {**payload, "cached": False}

    except AIProviderError as exc:
        log.warning("Ollama analysis unavailable: %s", exc)
        fallback_payload = fallback(f"Ollama unavailable: {exc}")
    except Exception:
        log.exception("Unexpected Ollama analysis failure")
        fallback_payload = fallback("Ollama analysis failed unexpectedly.")

    # Cache fallback too, so dashboard polling does not repeatedly call a bad model.
    with _ai_lock:
        _ai_cache.update(key=cache_key, at=time.time(), payload=fallback_payload)
    return {**fallback_payload, "cached": False}

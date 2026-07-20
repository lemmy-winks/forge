from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..coach import CoachUnavailable, run_review
from ..db import get_db
from ..models import AgentRun, Plan, PlanRevision, User
from ..security import current_user

router = APIRouter(prefix="/api", tags=["coach"])


@router.get("/proposal")
def get_proposal(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rev = (db.query(PlanRevision).join(Plan)
           .filter(Plan.user_id == user.id, PlanRevision.status == "proposed")
           .order_by(PlanRevision.num.desc()).first())
    if not rev:
        return {"proposal": None}
    return {"proposal": {"id": rev.id, "num": rev.num, "rationale": rev.rationale,
                         "content": rev.content, "created_at": rev.created_at.isoformat()}}


def _get_owned_proposal(db: Session, user: User, rid: str) -> PlanRevision:
    rev = db.get(PlanRevision, rid)
    if not rev or rev.status != "proposed":
        raise HTTPException(status_code=404, detail="proposal not found")
    plan = db.get(Plan, rev.plan_id)
    if not plan or plan.user_id != user.id:
        raise HTTPException(status_code=404, detail="proposal not found")
    return rev


@router.post("/proposal/{rid}/approve")
def approve(rid: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rev = _get_owned_proposal(db, user, rid)
    (db.query(PlanRevision)
     .filter(PlanRevision.plan_id == rev.plan_id, PlanRevision.status == "active")
     .update({"status": "superseded"}))
    rev.status = "active"
    db.commit()
    return {"ok": True, "revision": rev.num}


@router.post("/proposal/{rid}/reject")
def reject(rid: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rev = _get_owned_proposal(db, user, rid)
    rev.status = "superseded"
    db.commit()
    return {"ok": True}


@router.post("/coach/run-review")
def trigger_review(user: User = Depends(current_user), db: Session = Depends(get_db)):
    try:
        summary = run_review(db, user)
    except CoachUnavailable:
        raise HTTPException(status_code=503, detail="coach not configured — set ANTHROPIC_API_KEY")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"coach run failed: {e}")
    return {"ok": True, "summary": summary}


@router.get("/coach/runs")
def runs(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(AgentRun).filter(AgentRun.user_id == user.id)
            .order_by(AgentRun.created_at.desc()).limit(20).all())
    return [{"kind": r.kind, "model": r.model, "input_tokens": r.input_tokens,
             "output_tokens": r.output_tokens, "tool_calls": r.tool_calls, "ok": bool(r.ok),
             "at": r.created_at.isoformat()} for r in rows]

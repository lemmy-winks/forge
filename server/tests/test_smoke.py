"""End-to-end API smoke tests against sqlite. Run: python -m pytest tests/ -q"""
import os
import tempfile

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["ALLOWED_USERS"] = "james@test.dev:James,shelby@test.dev:Shelby"
os.environ["DEV_AUTH"] = "true"
os.environ["SESSION_SECRET"] = "test-secret"

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)
MONDAY = "2026-07-20"


def setup_module():
    client.__enter__()  # run lifespan (create tables + seed)


def teardown_module():
    client.__exit__(None, None, None)


def login(email="james@test.dev"):
    r = client.post("/auth/dev", json={"email": email})
    assert r.status_code == 200, r.text


def test_health_and_auth_mode():
    assert client.get("/healthz").json()["ok"] is True
    mode = client.get("/auth/mode").json()
    assert mode["dev"] is True
    assert len(mode["users"]) == 2


def test_allowlist_rejects_stranger():
    r = client.post("/auth/dev", json={"email": "stranger@test.dev"})
    assert r.status_code == 403


def test_me_requires_session():
    fresh = TestClient(app)
    assert fresh.get("/auth/me").status_code == 401


def test_full_training_flow():
    login()
    me = client.get("/auth/me").json()
    assert me["name"] == "James"

    # Monday with a 40-minute budget: trims expected, squat protected
    t = client.get(f"/api/today?date={MONDAY}&budget=40").json()
    assert t["kind"] == "strength"
    assert t["trims"], "40-minute budget should trim something"
    squat = next(e for e in t["exercises"] if e["slug"] == "back-squat")
    assert squat["sets"] == 3, "main lift must never be trimmed"
    assert squat["warmups"], "main barbell lift gets a warm-up ramp"
    assert "Per side" in (squat.get("plate") or "")

    # start session, log squat sets
    s = client.post("/api/sessions", json={"date": MONDAY, "budget": 40}).json()
    sid = s["id"]
    assert any(tt["slug"] == "back-squat" and tt["sets"] == 3 for tt in s["fitted"]["targets"])
    for i in range(1, 4):
        r = client.post(f"/api/sessions/{sid}/sets",
                        json={"slug": "back-squat", "set_no": i, "weight": 60, "reps": 5, "rpe": 7})
        assert r.status_code == 200, r.text

    # second heavier set later should register a PB
    r = client.post(f"/api/sessions/{sid}/sets",
                    json={"slug": "back-squat", "set_no": 4, "weight": 62.5, "reps": 5})
    assert any(p["kind"] == "e1rm" for p in r.json()["pbs"])

    # complete with cool-down done
    r = client.post(f"/api/sessions/{sid}/complete",
                    json={"cooldown_status": "done", "cooldown_min": 5, "notes": "knee fine"})
    stats = r.json()["stats"]
    assert stats["sets_done"] == 4
    assert stats["tonnage"] > 0

    # history + detail
    hist = client.get("/api/history").json()
    assert hist and hist[0]["name"] == "Lower A"
    detail = client.get(f"/api/sessions/{sid}").json()
    assert detail["exercises"][0]["slug"] == "back-squat"
    assert detail["notes"] == "knee fine"

    # progress + records
    prog = client.get("/api/progress").json()
    assert "back-squat" in prog["e1rm"]
    recs = client.get("/api/records").json()
    assert any(rr["slug"] == "back-squat" and rr["kind"] == "e1rm" for rr in recs)


def test_cooldown_includes_niggle_mobility():
    login()
    t = client.get(f"/api/today?date={MONDAY}").json()
    cd = t["cooldown"]
    assert any(c.get("why") for c in cd), "niggle-targeted mobility should be flagged"


def test_swap_alternatives_respect_niggle_and_equipment():
    login()
    alts = client.get("/api/exercises/back-squat/alternatives").json()
    by_slug = {a["slug"]: a for a in alts}
    assert "leg-press" in by_slug and not by_slug["leg-press"]["excluded"]
    assert "bulgarian-split-squat" in by_slug and by_slug["bulgarian-split-squat"]["excluded"]


def test_ingest_flow():
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    payload = {"data": {"metrics": [
        {"name": "weight_body_mass", "units": "kg",
         "data": [{"date": "2026-07-18 07:15:00 +0100", "qty": 82.1}]},
        {"name": "vo2_max", "units": "ml/kg/min",
         "data": [{"date": "2026-07-17 18:00:00 +0100", "qty": 41.2}]}],
        "workouts": [{"name": "Outdoor Run", "start": "2026-07-15 18:00:00 +0100",
                      "end": "2026-07-15 18:40:00 +0100",
                      "duration": 2418, "distance": {"qty": 6.82},
                      "avgHeartRate": {"qty": 133}}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200
    assert r.json()["stored"] == 3
    # idempotent
    r2 = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r2.json()["stored"] == 0

    assert client.post("/ingest", json=payload,
                       headers={"Authorization": "Bearer fg_bogus"}).status_code == 401

    conn = client.get("/api/connections").json()
    assert conn["apple_health"]["last_push"] is not None

    hist = client.get("/api/history").json()
    assert any(h["kind"] == "cardio" for h in hist)


def test_reveal_token_for_mcp_config():
    login("shelby@test.dev")
    tok = client.post("/api/connections/rotate-token").json()["token"]
    assert client.get("/api/connections/token").json()["token"] == tok
    login()  # james sees his own token, never shelby's
    james = client.get("/api/connections/token").json()["token"]
    assert james != tok


def test_mcp_oauth_flow():
    import base64
    import hashlib
    from urllib.parse import parse_qs, urlsplit

    # discovery: both well-known docs, and the 401 that points clients at them
    meta = client.get("/.well-known/oauth-authorization-server").json()
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["registration_endpoint"].endswith("/mcp/oauth/register")
    assert client.get("/.well-known/oauth-protected-resource/mcp").json()["resource"].endswith("/mcp")
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401 and "resource_metadata" in r.headers["www-authenticate"]

    # dynamic client registration — https only
    cb = "https://claude.ai/api/mcp/auth_callback"
    reg = client.post("/mcp/oauth/register", json={"client_name": "Claude", "redirect_uris": [cb]})
    assert reg.status_code == 201
    cid = reg.json()["client_id"]
    assert client.post("/mcp/oauth/register",
                       json={"redirect_uris": ["http://evil.example/cb"]}).status_code == 400

    login()
    verifier = "smoke-test-pkce-verifier-string"
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    q = {"response_type": "code", "client_id": cid, "redirect_uri": cb, "state": "xyz",
         "code_challenge": challenge, "code_challenge_method": "S256"}

    def get_code():
        r = client.post("/mcp/oauth/authorize", params=q, data={"decision": "allow"},
                        follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"].startswith(cb + "?")
        qs = parse_qs(urlsplit(r.headers["location"]).query)
        assert qs["state"] == ["xyz"]
        return qs["code"][0]

    # consent page renders; deny redirects with access_denied and mints nothing
    page = client.get("/mcp/oauth/authorize", params=q)
    assert page.status_code == 200 and "Connect Claude?" in page.text
    denied = client.post("/mcp/oauth/authorize", params=q, data={"decision": "deny"},
                         follow_redirects=False)
    assert "error=access_denied" in denied.headers["location"]

    # a wrong PKCE verifier is rejected and spends the code
    code = get_code()
    bad = client.post("/mcp/oauth/token", data={
        "grant_type": "authorization_code", "code": code, "client_id": cid,
        "redirect_uri": cb, "code_verifier": "wrong"})
    assert bad.status_code == 400

    # the real exchange: token works against /mcp as James, and codes are single-use
    code = get_code()
    form = {"grant_type": "authorization_code", "code": code, "client_id": cid,
            "redirect_uri": cb, "code_verifier": verifier}
    tok = client.post("/mcp/oauth/token", data=form).json()
    assert tok["access_token"].startswith("fgm_") and tok["refresh_token"].startswith("fgr_")
    assert client.post("/mcp/oauth/token", data=form).status_code == 400  # reuse
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    r = client.post("/mcp", headers={"Authorization": f"Bearer {tok['access_token']}"}, json=rpc)
    assert any(t["name"] == "log_food" for t in r.json()["result"]["tools"])

    # refresh rotates both tokens; the old access token dies with it
    tok2 = client.post("/mcp/oauth/token", data={
        "grant_type": "refresh_token", "refresh_token": tok["refresh_token"]}).json()
    assert tok2["access_token"] != tok["access_token"]
    assert client.post("/mcp", headers={"Authorization": f"Bearer {tok['access_token']}"},
                       json=rpc).status_code == 401
    assert client.post("/mcp", headers={"Authorization": f"Bearer {tok2['access_token']}"},
                       json=rpc).status_code == 200

    # the grant shows in Settings → Connections; only its owner can revoke it
    grants = client.get("/api/connections").json()["mcp_clients"]
    assert [g["name"] for g in grants] == ["Claude"]
    login("shelby@test.dev")
    assert client.delete(f"/api/connections/mcp/{grants[0]['id']}").status_code == 404
    login()
    assert client.delete(f"/api/connections/mcp/{grants[0]['id']}").json()["ok"] is True
    assert client.post("/mcp", headers={"Authorization": f"Bearer {tok2['access_token']}"},
                       json=rpc).status_code == 401


def test_labs_and_niggles_and_export():
    login()
    r = client.post("/api/labs", json={"drawn_on": "2026-06-14", "results": [
        {"marker": "LDL", "value": 2.9, "ref_high": 3.0},
        {"marker": "HDL", "value": 1.3, "ref_low": 1.0}]})
    assert r.status_code == 200
    labs = client.get("/api/labs").json()
    assert labs[0]["results"][0]["marker"] == "LDL"

    n = client.post("/api/niggles", json={"body_part": "Right wrist", "note": "test"}).json()
    r = client.patch(f"/api/niggles/{n['id']}", json={"status": "cleared"})
    assert r.status_code == 200

    exp = client.get("/api/export").json()
    assert exp["user"]["email"] == "james@test.dev"
    assert len(exp["sets"]) >= 4


def test_week_overview():
    login()
    w = client.get(f"/api/week?date={MONDAY}").json()
    assert w["start"] == MONDAY
    assert len(w["days"]) == 7
    d0, d1, d2 = w["days"][0], w["days"][1], w["days"][2]
    assert d0["kind"] == "strength" and d0["name"] == "Lower A" and d0["est"] > 0
    assert d0["session"] and d0["session"]["status"] == "completed"
    assert d0["session"]["stats"]["tonnage"] > 0
    assert d1["kind"] == "rest" and d1["session"] is None
    assert d2["kind"] == "cardio" and d2["minutes"] == 40


def test_week_snaps_to_monday_and_pages():
    login()
    # any date inside the week returns that whole Mon–Sun week
    w = client.get("/api/week?date=2026-07-23").json()
    assert w["start"] == MONDAY
    assert w["days"][0]["date"] == MONDAY and len(w["days"]) == 7
    assert "today" in w
    # previous week pages back a full 7 days
    prev = client.get("/api/week?date=2026-07-19").json()
    assert prev["start"] == "2026-07-13"
    # food week follows the same alignment
    fw = client.get("/api/food/week?date=2026-07-23").json()
    assert fw["start"] == MONDAY and "today" in fw


def test_planned_items_future_week():
    login()
    next_mon = "2026-07-27"
    meal = client.post("/api/plan-items", json={
        "date": "2026-07-28", "kind": "meal", "title": "Chili prep", "notes": "double batch"}).json()
    wo = client.post("/api/plan-items", json={
        "date": next_mon, "kind": "workout", "plan_day": "0"}).json()
    assert wo["title"] == "Lower A", "workout title comes from the plan day"

    w = client.get(f"/api/week?date={next_mon}").json()
    assert [i["id"] for i in w["days"][0]["planned"]] == [wo["id"]]
    assert w["days"][1]["planned"][0]["notes"] == "double batch"
    assert all(d["planned"] == [] for d in w["days"][2:])

    # validation: unknown kind, plan_day outside the active plan, empty title
    assert client.post("/api/plan-items",
                       json={"date": next_mon, "kind": "snack", "title": "x"}).status_code == 400
    assert client.post("/api/plan-items",
                       json={"date": next_mon, "kind": "workout", "plan_day": "9"}).status_code == 400
    assert client.post("/api/plan-items",
                       json={"date": next_mon, "kind": "meal", "title": "  "}).status_code == 400

    r = client.patch(f"/api/plan-items/{meal['id']}", json={"notes": "triple batch"})
    assert r.json()["notes"] == "triple batch"

    # segregation: Shelby sees nothing and can't touch James's items
    login("shelby@test.dev")
    ws = client.get(f"/api/week?date={next_mon}").json()
    assert all(d["planned"] == [] for d in ws["days"])
    assert client.delete(f"/api/plan-items/{meal['id']}").status_code == 404
    assert client.patch(f"/api/plan-items/{meal['id']}", json={"title": "hijack"}).status_code == 404

    login()
    assert client.delete(f"/api/plan-items/{meal['id']}").json()["ok"] is True
    assert client.delete(f"/api/plan-items/{wo['id']}").json()["ok"] is True
    w = client.get(f"/api/week?date={next_mon}").json()
    assert all(d["planned"] == [] for d in w["days"])


def test_history_pagination():
    login()
    full = client.get("/api/history").json()
    assert len(full) >= 2
    p1 = client.get("/api/history?limit=1").json()
    p2 = client.get("/api/history?limit=1&offset=1").json()
    assert [p1[0]["id"], p2[0]["id"]] == [full[0]["id"], full[1]["id"]]
    assert client.get("/api/history?limit=0").status_code == 422


def test_pull_forward_another_days_workout():
    login()
    tuesday = "2026-07-21"
    # Tuesday is a rest day; pull Friday's Upper A (plan day "4") onto it
    r = client.post("/api/sessions", json={"date": tuesday, "budget": None, "plan_day": "4"})
    assert r.status_code == 200, r.text
    fitted = r.json()["fitted"]
    assert fitted["name"] == "Upper A"
    assert any(t["slug"] == "bench-press" for t in fitted["targets"])
    detail = client.get(f"/api/sessions/{r.json()['id']}").json()
    assert detail["day"] == tuesday, "session recorded on the requested date, not Friday"
    # close it out — an active session left behind becomes `dangling` for later
    # tests as soon as the London calendar moves past this test's fixed date
    client.post(f"/api/sessions/{r.json()['id']}/complete", json={"cooldown_status": "skipped"})
    # cardio days can't be pulled into a strength session
    bad = client.post("/api/sessions", json={"date": "2026-07-23", "plan_day": "2"})
    assert bad.status_code == 400


def _wait_chat(max_s: float = 3.0) -> dict:
    """Poll GET /api/chat until the background coach thread finishes."""
    import time as _time
    deadline = _time.time() + max_s
    while _time.time() < deadline:
        data = client.get("/api/chat").json()
        if not data["pending"]:
            return data
        _time.sleep(0.05)
    raise AssertionError("chat reply never arrived")


def test_coach_unconfigured_fallbacks():
    login()
    # chat is async now: POST returns pending, the reply lands via polling
    r = client.post("/api/chat", json={"text": "hello coach"})
    assert r.json()["pending"] is True
    data = _wait_chat()
    assert data["messages"][-1]["who"] == "coach"
    assert "Anthropic API key" in data["messages"][-1]["text"]
    assert client.post("/api/coach/run-review").status_code == 503


def test_proposal_validation_and_approve_flow():
    from app.coach import create_proposal
    from app.db import SessionLocal
    from app.models import User

    login()
    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()

        bad = create_proposal(db, james, {"days": {"0": {"kind": "strength", "exercises": [
            {"slug": "no-such-lift", "sets": 3, "reps": 5, "priority": 1}],
            "cooldown": [{"slug": "walk-easy"}]}}}, "r")
        assert "unknown exercise" in bad["error"]

        bad2 = create_proposal(db, james, {"days": {"0": {"kind": "strength", "exercises": [
            {"slug": "back-squat", "sets": 3, "reps": 5, "priority": 2}],
            "cooldown": [{"slug": "walk-easy"}]}}}, "r")
        assert "priority 1" in bad2["error"]

        bad3 = create_proposal(db, james, {"days": {"0": {"kind": "strength", "exercises": [
            {"slug": "back-squat", "sets": 3, "reps": 5, "priority": 1}], "cooldown": []}}}, "r")
        assert "cooldown" in bad3["error"]

        good_content = {"days": {
            "0": {"name": "Lower A", "kind": "strength", "focus": ["Quads"],
                  "why": "Main squat day — keep climbing",
                  "exercises": [{"slug": "back-squat", "sets": 3, "reps": 5, "weight": 62.5,
                                 "rest": 120, "priority": 1, "min_sets": 3}],
                  "cooldown": [{"slug": "quad-hip-flexor-stretch", "hold": "45 s"}]},
            "2": {"name": "Zone 2", "kind": "cardio", "focus": ["Base"],
                  "why": "45 easy minutes banks half the Zone-2 target early",
                  "cardio": {"type": "run", "minutes": 45, "hr_low": 125, "hr_high": 140}},
        }, "changes": [{"sign": "+", "what": "Back Squat 60 → 62.5 kg",
                        "why": "all reps clean at RPE 7"}]}

        # day-note quality gates: notes are per-session, not week copy
        import copy
        c = copy.deepcopy(good_content)
        del c["days"]["2"]["why"]
        assert "no why" in create_proposal(db, james, c, "r")["error"]
        c = copy.deepcopy(good_content)
        c["days"]["2"]["why"] = c["days"]["0"]["why"]
        assert "share the same" in create_proposal(db, james, c, "r")["error"]
        c = copy.deepcopy(good_content)
        bad_rat = "Deload week. " + c["days"]["0"]["why"]
        assert "restates the weekly rationale" in create_proposal(db, james, c, bad_rat)["error"]

        good = create_proposal(db, james, good_content, "Squat earned +2.5; test proposal.")
        assert good.get("ok"), good
        assert good["status"] == "proposed"
    finally:
        db.close()

    prop = client.get("/api/proposal").json()["proposal"]
    assert prop and prop["rationale"].startswith("Squat earned")
    assert prop["content"]["changes"][0]["sign"] == "+"
    assert prop["content"]["days"]["0"]["why"].startswith("Main squat")

    r = client.post(f"/api/proposal/{prop['id']}/approve")
    assert r.status_code == 200
    assert client.get("/api/proposal").json()["proposal"] is None

    t = client.get(f"/api/today?date={MONDAY}").json()
    squat = next(e for e in t["exercises"] if e["slug"] == "back-squat")
    assert squat["weight"] == 62.5, "approved proposal should be the active plan"


def test_onboarding_prefs_and_intake_mode():
    from app.coach import _system_prompt
    from app.db import SessionLocal
    from app.models import User

    login()
    r = client.patch("/api/prefs", json={"prefs": {"onboarding_step": 2}, "units": "lb"})
    assert r.json()["units"] == "lb"
    assert r.json()["prefs"]["onboarding_step"] == 2
    assert client.patch("/api/prefs", json={"units": "furlongs"}).json()["units"] == "lb"

    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        assert "INTAKE MODE" in _system_prompt(db, james), "not onboarded -> intake mode"
        client.patch("/api/prefs", json={"prefs": {"onboarded": True}, "units": "kg"})
        db.refresh(james)
        assert "INTAKE MODE" not in _system_prompt(db, james), "onboarded -> normal coaching"
    finally:
        db.close()


def test_watch_run_reconciliation():
    """Phase 4 exit: a Watch run auto-appears matched to the planned cardio day."""
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    # Wednesday 2026-07-22 — plan day "2" is the approved Zone 2 prescription (125-140)
    hr = [{"date": f"2026-07-22 18:{i:02d}:00 +0100", "qty": v}
          for i, v in enumerate([128, 131, 133, 135, 130, 129, 134, 132, 160, 100])]
    payload = {"data": {"workouts": [{
        "name": "Outdoor Run", "start": "2026-07-22 18:00:00 +0100",
        "end": "2026-07-22 18:45:00 +0100", "duration": 2700,
        "distance": {"qty": 7.5}, "avgHeartRate": {"qty": 132},
        "heartRateData": hr}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200 and r.json()["stored"] == 1

    hist = client.get("/api/history").json()
    run = next(h for h in hist if h["day"] == "2026-07-22")
    assert run["status"] == "completed", "matched run must not stay unplanned"
    assert run["name"] == "Zone 2", "matched run takes the prescription's name"
    s = run["stats"]
    assert s["target"]["minutes"] == 45 and s["target"]["hr_low"] == 125
    assert s["pct_in_zone"] == 80.0, "8 of 10 HR samples inside 125-140"
    assert s["zone2_min"] == 36.0, "8 of 10 samples inside the Zone-2 band (110-145)"
    assert s["pace_min_km"] == 6.0

    # annotate the synced session (E5.2 AC3)
    r = client.patch(f"/api/sessions/{run['id']}/notes", json={"notes": "felt easy"})
    assert r.status_code == 200
    assert client.get(f"/api/sessions/{run['id']}").json()["notes"] == "felt easy"


def test_unmatched_workout_stays_unplanned():
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    payload = {"data": {"workouts": [{  # Thursday — no cardio planned
        "name": "Pool Swim", "start": "2026-07-23 07:00:00 +0100", "duration": 1800}]}}
    client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    hist = client.get("/api/history").json()
    swim = next(h for h in hist if h["day"] == "2026-07-23")
    assert swim["status"] == "unplanned" and swim["name"] == "Pool Swim"


def test_run_series_zones_and_backfill():
    """Rich run detail: HR/route series stored at ingest, zones computed on read,
    and a re-sent workout backfills traces instead of being dropped."""
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    hr = [{"date": f"2026-07-24 07:{i:02d}:00 +0100", "qty": 120 + i * 3} for i in range(10)]
    route = [{"lat": 51.5 + i * 1e-4, "lon": -0.12 + i * 1e-4} for i in range(5)]
    payload = {"data": {"workouts": [{
        "name": "Morning Jog", "start": "2026-07-24 07:00:00 +0100", "duration": 600,
        "distance": {"qty": 2.0}, "heartRateData": hr, "route": route}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200 and r.json()["stored"] == 1
    run = next(h for h in client.get("/api/history").json() if h["day"] == "2026-07-24")
    d = client.get(f"/api/sessions/{run['id']}").json()
    assert d["series"]["hr"][0] == [0.0, 120.0] and len(d["series"]["hr"]) == 10
    assert d["series"]["route"][0] == [51.5, -0.12] and len(d["series"]["route"]) == 5
    assert d["zones"]["estimated"] and d["zones"]["hr_max"] == 190
    assert sum(z["min"] for z in d["zones"]["zones"]) > 0
    # duplicate send with series already stored → skipped, not duplicated
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["skipped"] == 1

    # a run ingested without traces gains them when HAE re-sends the day
    bare = {"data": {"workouts": [{
        "name": "Evening Jog", "start": "2026-07-25 19:00:00 +0100", "duration": 600}]}}
    client.post("/ingest", json=bare, headers={"Authorization": f"Bearer {tok}"})
    rich = {"data": {"workouts": [{
        "name": "Evening Jog", "start": "2026-07-25 19:00:00 +0100", "duration": 600,
        "heartRateData": [{"date": f"2026-07-25 19:{i:02d}:00 +0100", "qty": 130}
                          for i in range(10)]}]}}
    r = client.post("/ingest", json=rich, headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["stored"] == 1, "re-sent day backfills the series"
    run = next(h for h in client.get("/api/history").json() if h["day"] == "2026-07-25")
    d = client.get(f"/api/sessions/{run['id']}").json()
    assert len(d["series"]["hr"]) == 10 and d["stats"]["hr_samples"] == 10


def test_dangling_session_save_incomplete():
    """A workout started on a previous day and abandoned surfaces in /api/week
    as `dangling`; completing it banks the sets, flags it partial, and clears
    the reminder."""
    login()
    past_monday = "2026-07-13"  # strength plan day, before today
    r = client.post("/api/sessions", json={"date": past_monday})
    assert r.status_code == 200 and r.json()["resumed"] is False
    sid = r.json()["id"]
    client.post(f"/api/sessions/{sid}/sets",
                json={"slug": "back-squat", "set_no": 1, "weight": 60, "reps": 5, "rpe": 7})

    d = client.get("/api/week").json()["dangling"]
    assert d and d["id"] == sid and d["sets_done"] == 1 and d["date"] == past_monday

    r = client.post(f"/api/sessions/{sid}/complete", json={"cooldown_status": "skipped"})
    stats = r.json()["stats"]
    assert stats["partial"] is True and stats["sets_done"] == 1
    assert stats["duration_s"] is not None and stats["duration_s"] < 6 * 3600, \
        "duration ends at the last set, not at save time a day later"
    assert client.get("/api/week").json()["dangling"] is None, "reminder cleared"
    detail = client.get(f"/api/sessions/{sid}").json()
    assert detail["status"] == "completed" and detail["stats"]["partial"] is True


def test_progress_zone2_and_vo2_trend():
    login()
    p = client.get("/api/progress").json()
    assert p["zone2"]["target"] == 45, "weekly Zone-2 target comes from the active plan"
    assert len(p["vo2max_smooth"]) == len(p["vo2max"])


def test_dashboard():
    login()
    d = client.get("/api/dashboard").json()
    assert d["name"] == "James"
    assert "back-squat" in d["e1rm"]
    assert len(d["tonnage_weekly"]) == 12 and len(d["heatmap"]) == 12
    assert all(len(row["days"]) == 7 for row in d["heatmap"])
    assert d["zone2_target"] == 45
    assert any(r["slug"] == "back-squat" for r in d["records"])
    assert client.get("/dashboard").status_code == 200, "SPA route serves the app shell"


def test_withings_unconfigured_and_webhook_ignores_unknown():
    login()
    assert client.get("/api/withings/connect").status_code == 503, "no creds configured"
    conn = client.get("/api/connections").json()["withings"]
    assert conn["configured"] is False and conn["linked"] is False
    # webhook: probe OK, unknown Withings user ignored (logged), never an error
    assert client.get("/api/withings/webhook").status_code == 200
    r = client.post("/api/withings/webhook", data={"userid": "999", "appli": "1"})
    assert r.status_code == 200 and r.json()["ignored"] is True


def test_body_composition_and_units():
    from app.db import SessionLocal
    from app.models import User
    from app.routers.withings import store_measuregrps

    login()
    # Withings measure groups map to canonical metric rows (kg / cm / %)
    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        grps = [{"date": 1784800000, "measures": [
            {"type": 1, "value": 82150, "unit": -3},    # 82.15 kg
            {"type": 6, "value": 213, "unit": -1},      # 21.3 %
            {"type": 76, "value": 58200, "unit": -3},   # 58.2 kg muscle
            {"type": 77, "value": 47100, "unit": -3},   # 47.1 kg water
            {"type": 88, "value": 32, "unit": -1},      # 3.2 kg bone
            {"type": 4, "value": 183, "unit": -2},      # 1.83 m -> 183 cm
        ]}]
        assert store_measuregrps(db, james.id, grps) == 6
        assert store_measuregrps(db, james.id, grps) == 0, "idempotent"
        db.commit()
    finally:
        db.close()

    p = client.get("/api/progress").json()
    bc = p["bodycomp"]
    assert bc["fat_pct"][-1]["v"] == 21.3
    assert bc["muscle"][-1]["v"] == 58.2
    assert bc["height_cm"] == 183.0
    assert bc["water_pct"][-1]["v"] == round(100 * 47.1 / 82.15, 1)

    # manual body entry + validation
    assert client.post("/api/body", json={"type": "height", "value": 180.0}).status_code == 200
    assert client.post("/api/body", json={"type": "shoe_size", "value": 9}).status_code == 400
    assert client.post("/api/body", json={"type": "height", "value": -1}).status_code == 400

    # unit prefs round-trip; dashboard exposes them (default load unit = lb)
    client.patch("/api/prefs", json={"prefs": {"unit_lipids": "mgdl",
                                               "load_units": {"back-squat": "kg"}}})
    d = client.get("/api/dashboard").json()
    assert d["unit_load"] == "lb" and d["unit_lipids"] == "mgdl"
    assert d["load_units"] == {"back-squat": "kg"}
    assert d["bodycomp"]["fat_pct"][-1]["v"] == 21.3


def test_hae_body_fat_ingest():
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    payload = {"data": {"metrics": [
        {"name": "body_fat_percentage", "units": "%",
         "data": [{"date": "2026-07-18 07:16:00 +0100", "qty": 21.9}]},
        {"name": "lean_body_mass", "units": "lb",
         "data": [{"date": "2026-07-18 07:16:00 +0100", "qty": 141.0}]}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["stored"] == 2
    p = client.get("/api/progress").json()
    assert any(pt["v"] == 21.9 for pt in p["bodycomp"]["fat_pct"]), "HAE fat %% joined the series"
    # lean_body_mass honored the lb unit: 141 lb -> ~63.96 kg
    exp = client.get("/api/export").json()
    lbm = [m for m in exp["metrics"] if m["type"] == "fat_free_mass"]
    assert lbm and abs(lbm[-1]["value"] - 63.96) < 0.05


def test_push_three_kinds_enforced():
    import pytest

    from app import notify
    from app.db import SessionLocal
    from app.models import User

    login()
    assert client.get("/api/push/config").json()["enabled"] is False
    r = client.post("/api/push/subscribe",
                    json={"endpoint": "https://push.example/ep1",
                          "keys": {"p256dh": "k", "auth": "a"}})
    assert r.status_code == 200

    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        with pytest.raises(ValueError):
            notify.send_push(db, james, "marketing", "nope", "never")  # E12.1 AC2
        assert notify.send_push(db, james, "reminder", "t", "b") == 0, "no VAPID keys -> no send"
    finally:
        db.close()

    from datetime import datetime
    assert notify.in_quiet_hours(datetime(2026, 7, 22, 23, 0)) is True
    assert notify.in_quiet_hours(datetime(2026, 7, 22, 7, 30)) is True
    assert notify.in_quiet_hours(datetime(2026, 7, 22, 17, 0)) is False


def test_curated_form_media():
    import pytest

    from app import notify
    from app.db import SessionLocal
    from app.models import User

    login()
    e = client.get("/api/exercises/back-squat").json()
    assert e["media_tier"] == "images"
    urls = e["media_url"].split(",")
    assert urls == ["/media/exercises/back-squat-0.jpg", "/media/exercises/back-squat-1.jpg"]
    # unmatched exercises keep no media and stay cues-only
    assert client.get("/api/exercises/landmine-press").json()["media_url"] == ""

    # the filming push kind is retired along with the media pipeline
    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        with pytest.raises(ValueError):
            notify.send_push(db, james, "film", "t", "b")
    finally:
        db.close()


def test_coach_context_and_new_tools():
    from app.coach import _exec_tool, amend_week
    from app.db import SessionLocal
    from app.models import Plan, PlanRevision, User

    login()
    # deep-link context: the stored message carries a short [re: …] tag
    sid = client.get("/api/history").json()[0]["id"]
    r = client.post("/api/chat", json={"text": "how did this look?",
                                       "context": {"kind": "session", "id": sid}})
    assert r.json()["pending"] is True
    data = _wait_chat()
    mine = [m for m in data["messages"] if m["who"] == "me"]
    assert "[re: session" in mine[-1]["text"]

    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        assert len(_exec_tool(db, james, "get_week", {})["days"]) == 7

        # amend one day — every other day of the active week must survive untouched
        active = _exec_tool(db, james, "get_active_plan", {})
        before_days = set(active["content"]["days"].keys())
        out = amend_week(db, james,
                         {"2": {"name": "Easy spin", "kind": "cardio", "focus": ["Recovery"],
                                "why": "deload the mid-week run",
                                "cardio": {"type": "bike", "minutes": 30, "hr_low": 110, "hr_high": 130}}},
                         [{"sign": "~", "what": "Zone 2 run → easy bike", "why": "knee care"}],
                         "test amend")
        assert out.get("ok"), out
        prop = _exec_tool(db, james, "get_proposal", {})["proposal"]
        assert set(prop["content"]["days"].keys()) == before_days
        assert prop["content"]["days"]["2"]["name"] == "Easy spin"

        # a new proposal supersedes the old one — never more than one pending
        assert amend_week(db, james, {}, [], "re-proposal").get("ok")
        pending = (db.query(PlanRevision).join(Plan)
                   .filter(Plan.user_id == james.id, PlanRevision.status == "proposed").count())
        assert pending == 1

        assert _exec_tool(db, james, "update_goal", {"goal": "Squat 100 kg clean"})["ok"]
        assert _exec_tool(db, james, "log_body_metric", {"type": "weight", "value": 82.0})["ok"]
        assert "error" in _exec_tool(db, james, "log_body_metric", {"type": "shoe_size", "value": 9})
        assert "This week so far" in __import__("app.coach", fromlist=["x"])._system_prompt(db, james)
    finally:
        db.close()
    # tidy: reject the pending proposal so later tests see a clean slate
    prop_id = client.get("/api/proposal").json()["proposal"]["id"]
    assert client.post(f"/api/proposal/{prop_id}/reject").status_code == 200


def test_expanded_library():
    from pathlib import Path

    from app.seed import MEDIA_SLUGS

    login()
    lib = client.get("/api/exercises").json()
    assert len(lib) >= 60, "common-gym expansion should be seeded"
    dl = client.get("/api/exercises/deadlift").json()
    assert dl["media_tier"] == "images" and dl["cues"] and dl["dont"]
    assert len(dl["benefit"]) > 40, "every exercise ships a why-it-matters line"
    from app.seed import BENEFITS, EXERCISES
    missing = [e[0] for e in EXERCISES if e[0] not in BENEFITS]
    assert not missing, f"benefit text missing for {missing}"
    # every media slug's photos actually ship in the web bundle
    media = Path(__file__).resolve().parents[2] / "web" / "public" / "media" / "exercises"
    missing = [s for s in MEDIA_SLUGS if not (media / f"{s}-0.jpg").exists()]
    assert not missing, f"media files missing for {missing}"
    # new lifts join the swap pool
    alts = client.get("/api/exercises/back-squat/alternatives").json()
    assert any(a["slug"] == "front-squat" and not a["excluded"] for a in alts)


def test_user_segregation():
    login("shelby@test.dev")
    assert client.get("/api/history").json() == []
    assert client.get("/api/records").json() == []
    assert client.get("/api/labs").json() == []
    dash = client.get("/api/dashboard").json()
    assert dash["e1rm"] == {} and dash["records"] == [], "dashboard is user-scoped too"
    t = client.get(f"/api/today?date={MONDAY}").json()
    squat = next(e for e in t["exercises"] if e["slug"] == "back-squat")
    assert squat["weight"] < 60, "Shelby's seeded plan is scaled independently"
    assert not any(c.get("why") for c in t["cooldown"]), "James's niggle must not leak"


def test_map_config():
    # signed-in only — the key is publishable but not anonymous
    fresh = TestClient(app)
    assert fresh.get("/api/map/config").status_code == 401

    login("shelby@test.dev")
    assert client.get("/api/map/config").json() == {"enabled": False, "key": ""}

    # admin stores the key in-app; it applies live, and any member gets it in
    # full (it ships to the browser to fetch tiles — masking would be theater)
    login()
    r = client.put("/api/admin/settings", json={"values": {"maptiler_key": "mt-test-key"}})
    assert r.status_code == 200
    assert r.json()["maptiler_key"] == {"set": True, "value": "mt-test-key", "source": "app"}
    login("shelby@test.dev")
    assert client.get("/api/map/config").json() == {"enabled": True, "key": "mt-test-key"}

    # clearing reverts to the env default (empty) — clients fall back to the SVG trace
    login()
    client.put("/api/admin/settings", json={"values": {"maptiler_key": ""}})
    assert client.get("/api/map/config").json()["enabled"] is False


def test_admin_settings_and_user_management():
    # member is locked out entirely
    login("shelby@test.dev")
    assert client.get("/api/admin/settings").status_code == 403
    assert client.get("/api/admin/users").status_code == 403

    login()  # james is the admin (first in ALLOWED_USERS)
    s = client.get("/api/admin/settings").json()
    assert s["anthropic_api_key"]["set"] is False
    assert s["coach_model"]["value"] == "claude-sonnet-5"

    # secrets are stored but only a masked tail ever comes back
    r = client.put("/api/admin/settings",
                   json={"values": {"anthropic_api_key": "sk-ant-test-1234567890"}})
    assert r.status_code == 200
    got = r.json()["anthropic_api_key"]
    assert got["set"] is True and got["source"] == "app"
    assert "sk-ant-test" not in got["value"] and got["value"].endswith("7890")
    # live: the coach status flips without a restart
    assert client.get("/api/connections").json()["coach_mcp"]["active"] is True

    # unknown keys are rejected; google stays compose-only
    assert client.put("/api/admin/settings",
                      json={"values": {"google_client_id": "x"}}).status_code == 422

    # clearing reverts to the env (empty here)
    client.put("/api/admin/settings", json={"values": {"anthropic_api_key": ""}})
    assert client.get("/api/admin/settings").json()["anthropic_api_key"]["set"] is False

    # vapid generation wires push end to end
    pub = client.post("/api/admin/settings/vapid").json()["public_key"]
    assert client.get("/api/push/config").json() == {"enabled": True, "public_key": pub}

    # user management: fix the second seat's email, then sign in with it
    users = client.get("/api/admin/users").json()
    assert [u["role"] for u in users] == ["admin", "member"]
    shelby = users[1]
    r = client.patch(f"/api/admin/users/{shelby['id']}",
                     json={"email": "shelby@example.org", "name": "Shel"})
    assert r.status_code == 200
    assert client.patch(f"/api/admin/users/{shelby['id']}",
                        json={"email": "james@test.dev"}).status_code == 409
    assert client.patch(f"/api/admin/users/{shelby['id']}",
                        json={"email": "nonsense"}).status_code == 422
    login("shelby@example.org")  # the users table IS the allowlist now
    assert client.get("/auth/me").json()["name"] == "Shel"
    # both seats taken → no third user
    login()
    assert client.post("/api/admin/users",
                       json={"email": "third@test.dev", "name": "Third"}).status_code == 409
    # put shelby back so earlier-run state stays consistent for other tests
    client.patch(f"/api/admin/users/{shelby['id']}",
                 json={"email": "shelby@test.dev", "name": "Shelby"})


def test_second_matching_workout_stays_unplanned():
    """The planned day is claimed once — a second run must not double-complete it."""
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    payload = {"data": {"workouts": [{
        "name": "Outdoor Run", "start": "2026-07-22 19:30:00 +0100",
        "end": "2026-07-22 20:00:00 +0100", "duration": 1800,
        "avgHeartRate": {"qty": 130}}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200 and r.json()["stored"] == 1
    day = [h for h in client.get("/api/history").json() if h["day"] == "2026-07-22"]
    assert sorted(h["status"] for h in day) == ["completed", "unplanned"]


def test_workout_units_honored():
    """Workout payload units convert like body metrics do — miles never stored as km."""
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    payload = {"data": {"workouts": [{
        "name": "Outdoor Walk", "start": "2026-07-23 08:00:00 +0100",
        "duration": 2700, "distance": {"qty": 3.0, "units": "mi"},
        "activeEnergyBurned": {"qty": 1000, "units": "kJ"}}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200 and r.json()["stored"] == 1
    walk = next(h for h in client.get("/api/history").json() if h["day"] == "2026-07-23")
    assert walk["status"] == "unplanned"
    assert abs(walk["stats"]["distance"] - 4.828) < 0.01, "3 mi → km"
    assert abs(walk["stats"]["kcal"] - 239.0) < 0.5, "1000 kJ → kcal"
    assert abs(walk["stats"]["pace_min_km"] - 9.32) < 0.02, "pace over km, not miles"


def test_admin_added_user_gets_defaults_immediately():
    """A user added via the admin API is usable at once: equipment + starter plan."""
    from app.db import SessionLocal
    from app.models import EquipmentProfile, Plan, User
    from app.seed import seed_user_defaults

    db = SessionLocal()
    try:
        u = User(email="third@test.dev", name="Third", role="member", prefs={})
        db.add(u)
        db.flush()
        seed_user_defaults(db, u)
        db.commit()
        gym = (db.query(EquipmentProfile)
               .filter(EquipmentProfile.user_id == u.id, EquipmentProfile.name == "Gym").first())
        assert gym is not None and u.active_profile_id == gym.id
        assert (db.query(EquipmentProfile)
                .filter(EquipmentProfile.user_id == u.id, EquipmentProfile.name == "Travel")
                .count()) == 1
        assert db.query(Plan).filter(Plan.user_id == u.id).count() == 1
    finally:
        db.close()


def test_demo_account_lifecycle():
    """Bruce Willis: a year of data, sign-in button, isolation, reset/remove."""
    login()  # admin creates the demo
    r = client.post("/api/admin/demo")
    assert r.status_code == 200 and r.json()["exists"] is True

    # demo is invisible to user management and doesn't consume a seat
    assert all(u["role"] != "demo" for u in client.get("/api/admin/users").json())
    mode = client.get("/auth/mode").json()
    assert mode["demo"] is True
    assert all(u["name"] != "Bruce Willis" for u in mode["users"])

    # anyone can open the demo; it's fully onboarded
    r = client.post("/auth/demo")
    assert r.status_code == 200 and r.json()["name"] == "Bruce Willis"
    me = client.get("/auth/me").json()
    assert me["role"] == "demo" and me["prefs"].get("onboarded") is True

    # a year of history that the screens can actually render, paged
    hist = client.get("/api/history").json()
    assert len(hist) == 30, "history serves a full default page"
    page2 = client.get("/api/history?offset=30").json()
    assert page2 and page2[0]["id"] not in {h["id"] for h in hist}
    assert any(h["kind"] == "cardio" and (h["stats"].get("pct_in_zone") or 0) > 0 for h in hist)
    prog = client.get("/api/progress").json()
    assert len(prog["e1rm"]["back-squat"]["points"]) > 20, "a year of squat progression"
    assert len(prog["weight"]) > 60 and prog["weight"][0]["v"] > prog["weight"][-1]["v"]
    recs = client.get("/api/records").json()
    assert any(rr["slug"] == "back-squat" and rr["kind"] == "e1rm" for rr in recs)
    assert len(client.get("/api/week").json()["days"]) == 7
    assert client.get("/api/dashboard").status_code == 200
    assert client.get("/api/proposal").json()["proposal"] is not None, "pending proposal to show off"
    assert len(client.get("/api/chat").json()["messages"]) >= 6
    assert len(client.get("/api/labs").json()) == 3
    assert client.get("/api/export").json()["user"]["email"] == "bruce@demo.forge"

    # reset regenerates deterministically; remove deletes everything
    login()
    assert client.post("/api/admin/demo").status_code == 200
    assert client.delete("/api/admin/demo").json()["exists"] is False
    assert client.get("/auth/mode").json()["demo"] is False
    assert client.post("/auth/demo").status_code == 404
    # and the real seats still exist untouched
    emails = {u["email"] for u in client.get("/api/admin/users").json()}
    assert {"james@test.dev", "shelby@test.dev"} <= emails


def test_demo_cannot_reach_member_data():
    """The demo seat is a stranger to member rows on every surface: direct API,
    chat context attachment, coach tools, and the admin API."""
    login()
    client.post("/api/admin/demo")
    james_hist = client.get("/api/history").json()
    sid = james_hist[0]["id"]

    client.post("/auth/demo")
    assert client.get(f"/api/sessions/{sid}").status_code == 404, "direct object reference"
    assert not ({h["id"] for h in client.get("/api/history").json()}
                & {h["id"] for h in james_hist}), "history overlap"
    assert client.get("/api/admin/settings").status_code == 403
    assert client.post("/api/admin/demo").status_code == 403, "demo can't reset itself"

    # coach-side: the context attach and the tool read both refuse James's session
    from app.coach import _exec_tool
    from app.db import SessionLocal
    from app.models import User
    from app.routers.misc import _chat_context
    db = SessionLocal()
    try:
        bruce = db.query(User).filter(User.role == "demo").first()
        assert _chat_context(db, bruce, {"kind": "session", "id": sid}) == ("", "")
        assert _exec_tool(db, bruce, "get_session", {"session_id": sid}).get("error")
    finally:
        db.close()

    login()
    client.delete("/api/admin/demo")


def test_food_week_recipe_and_one_tap_log():
    """Phase 7 kitchen core (E16.2/E16.4): the seeded food week resolves recipes,
    leftovers and order/out slots; ticking a slot snapshots macros idempotently."""
    login()
    me = client.get("/auth/me").json()
    assert me["prefs"]["nutrition_targets"]["protein_g"] == 160, "seeded targets"

    w = client.get(f"/api/food/week?date={MONDAY}").json()
    assert w["has_plan"] and len(w["days"]) == 7
    assert w["targets"]["fiber_g"] == 38
    # extended targets always resolve, even for users whose stored prefs predate them
    assert w["targets"]["carbs_g"] == 250 and w["targets"]["sodium_mg"] == 2300
    mon = w["days"][0]
    dinner = next(s for s in mon["slots"] if s["slot"] == "dinner")
    assert dinner["recipe"]["slug"] == "harissa-chicken-traybake"
    assert dinner["recipe"]["platefig"] == "tray-chicken"
    assert dinner["logged"] is False
    # Wednesday inherits Monday's dinner as leftovers; Friday is the night out;
    # Tuesday lunch is an order-assist slot
    wed = next(s for s in w["days"][2]["slots"] if s["slot"] == "dinner")
    assert wed.get("leftover") and wed["recipe"]["slug"] == "harissa-chicken-traybake"
    fri = next(s for s in w["days"][4]["slots"] if s["slot"] == "dinner")
    assert fri.get("out") is True
    tue_lunch = next(s for s in w["days"][1]["slots"] if s["slot"] == "lunch")
    assert tue_lunch.get("order") is True

    # recipe detail: done-when steps with a timer step, joined ingredients, the trio
    r = client.get("/api/food/recipes/harissa-chicken-traybake").json()
    assert len(r["steps"]) == 5 and any(s.get("timer") for s in r["steps"])
    assert any(i["name"] == "chickpeas" and i["aisle"] == "cupboard" for i in r["ingredients"])
    assert any(i.get("pantry") for i in r["ingredients"]), "pantry staples flagged"
    assert r["fiber_g"] == 11 and r["satfat_g"] == 4.5 and r["difficulty"] == "easy"
    # full label set on the card (E16 macro expansion)
    assert r["carbs_g"] == 38 and r["fat_g"] == 16 and r["sugar_g"] == 10 and r["sodium_mg"] == 620
    assert client.get("/api/food/recipes/nope").status_code == 404

    # one-tap tick with offline-queue idempotency
    body = {"date": MONDAY, "slot": "dinner", "recipe": "harissa-chicken-traybake",
            "client_id": "tick-1"}
    r1 = client.post("/api/food/log", json=body).json()
    assert r1["duplicate"] is False and r1["totals"]["protein_g"] == 42
    assert r1["totals"]["carbs_g"] == 38 and r1["totals"]["sodium_mg"] == 620, "full macro snapshot"
    r2 = client.post("/api/food/log", json=body).json()
    assert r2["duplicate"] is True and r2["id"] == r1["id"]
    w = client.get(f"/api/food/week?date={MONDAY}").json()
    dinner = next(s for s in w["days"][0]["slots"] if s["slot"] == "dinner")
    assert dinner["logged"] is True and dinner["log_id"] == r1["id"]
    assert w["days"][0]["totals"]["protein_g"] == 42
    # off-plan entries need their own numbers
    assert client.post("/api/food/log", json={"date": MONDAY, "slot": "snack"}).status_code == 400
    # untick
    assert client.delete(f"/api/food/log/{r1['id']}").json()["totals"]["kcal"] == 0


def test_food_household_scope_and_demo_wall():
    """E16.8: one household food week, strictly per-user logs; the demo seat
    sees the shared recipe library but never the household's week or plates."""
    login("shelby@test.dev")
    w = client.get(f"/api/food/week?date={MONDAY}").json()
    dinner = next(s for s in w["days"][0]["slots"] if s["slot"] == "dinner")
    assert dinner["recipe"]["slug"] == "harissa-chicken-traybake", "household week is shared"

    # James logs his plate; Shelby's day stays hers
    login()
    jid = client.post("/api/food/log", json={"date": MONDAY, "slot": "dinner",
                                             "recipe": "harissa-chicken-traybake",
                                             "client_id": "seg-1"}).json()["id"]
    login("shelby@test.dev")
    w = client.get(f"/api/food/week?date={MONDAY}").json()
    dinner = next(s for s in w["days"][0]["slots"] if s["slot"] == "dinner")
    assert dinner["logged"] is False and w["days"][0]["totals"]["kcal"] == 0
    assert client.delete(f"/api/food/log/{jid}").status_code == 404, "cross-user delete"

    # the demo seat: shared library yes, household week no
    login()
    client.post("/api/admin/demo")
    client.post("/auth/demo")
    wd = client.get(f"/api/food/week?date={MONDAY}").json()
    # the demo now ships its own food week — but it must be served from the
    # demo's OWN revision, and the household's plates must never leak into it
    from app.db import SessionLocal
    from app.models import MealRevision, User
    db = SessionLocal()
    try:
        bruce = db.query(User).filter(User.role == "demo").first()
        active = (db.query(MealRevision)
                  .filter(MealRevision.user_id == bruce.id, MealRevision.status == "active").first())
        assert active is not None, "demo food week lives in the demo's own scope"
    finally:
        db.close()
    assert wd["has_plan"] is True
    # James's seg-1 dinner log (still present) must not appear anywhere in the demo's week
    assert not any(s.get("log_id") == jid for d in wd["days"] for s in d["slots"])
    assert not any(x["id"] == jid for d in wd["days"] for x in d["extras"])
    assert client.get("/api/food/recipes/harissa-chicken-traybake").status_code == 200

    login()
    client.delete("/api/admin/demo")
    assert any(m["recipe"] == "harissa-chicken-traybake"
               for m in client.get("/api/export").json()["meals"]), "meals in export (E15.3)"
    client.delete(f"/api/food/log/{jid}")


def test_demo_food_rows_cleaned_up():
    """The public demo seat can log meals; demo reset/remove must delete them —
    on Postgres a missed table is an FK crash at delete time, on sqlite an
    orphan row. Guards the delete_demo model list staying complete."""
    login()
    client.post("/api/admin/demo")
    client.post("/auth/demo")
    r = client.post("/api/food/log", json={"date": MONDAY, "slot": "snack",
                                           "recipe": "almonds-30", "client_id": "demo-food-1"})
    assert r.status_code == 200

    login()
    assert client.post("/api/admin/demo").status_code == 200, "reset with demo meal rows present"
    assert client.delete("/api/admin/demo").json()["exists"] is False

    from app.db import SessionLocal
    from app.models import MealLog, User
    db = SessionLocal()
    try:
        assert db.query(User).filter(User.role == "demo").count() == 0
        assert db.query(MealLog).filter(MealLog.recipe_slug == "almonds-30").count() == 0, \
            "demo meal rows must not survive demo removal"
    finally:
        db.close()


def _food_week_content():
    """A valid proposal: the seeded week (it satisfies every validator)."""
    from app.food_seed import _first_week
    return _first_week()


FOOD_CHANGES = [{"sign": "~", "what": "Salmon moves to Thursday", "why": "test diff row"}]


def test_food_proposal_validation_and_approve_flow():
    """Phase 8 core (E16.3): validators catch broken weeks; a good proposal
    round-trips proposed → approved → active, exactly one pending at a time."""
    import copy

    from app.db import SessionLocal
    from app.food_coach import create_food_proposal
    from app.models import MealRevision, User

    login()
    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        good = _food_week_content()

        # structural validators, one broken thing at a time
        c = copy.deepcopy(good)
        del c["days"]["6"]
        assert "missing day" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]

        c = copy.deepcopy(good)
        del c["days"]["0"]["slots"]["snack"]
        assert "every slot" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]

        c = copy.deepcopy(good)
        c["days"]["0"]["slots"]["dinner"] = {"recipe": "no-such-recipe", "why": "x"}
        assert "unknown recipe" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]

        c = copy.deepcopy(good)
        c["days"]["0"]["slots"]["dinner"] = {"recipe": "oats-no1", "why": "x"}
        assert "kind 'dinner'" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]

        c = copy.deepcopy(good)
        c["days"]["1"]["slots"]["dinner"].pop("why")
        assert "why" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]

        c = copy.deepcopy(good)
        c["days"]["2"]["slots"]["dinner"] = {"recipe": "prawn-soba-stirfry", "why": "x"}
        c["days"]["4"]["slots"]["dinner"] = {"recipe": "salmon-puy-lentils", "why": "x"}
        assert "zero-cook" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]

        assert "changes[]" in create_food_proposal(db, james, good, [], "r")["error"]
        assert "rationale" in create_food_proposal(db, james, good, FOOD_CHANGES, " ")["error"]

        # dinner-note quality gates: plate notes, not week copy
        c = copy.deepcopy(good)
        c["days"]["1"]["slots"]["dinner"]["why"] = c["days"]["0"]["slots"]["dinner"]["why"]
        assert "share the same dinner why" in create_food_proposal(db, james, c, FOOD_CHANGES, "r")["error"]
        c = copy.deepcopy(good)
        rat = "Steady week. " + c["days"]["0"]["slots"]["dinner"]["why"]
        assert "restates the weekly rationale" in create_food_proposal(db, james, c, FOOD_CHANGES, rat)["error"]

        # the real thing
        out = create_food_proposal(db, james, good, FOOD_CHANGES, "Test food week — same as the baseline.")
        assert out.get("ok"), out
        assert out["status"] == "proposed"

        # a second proposal supersedes the first — never more than one pending
        out2 = create_food_proposal(db, james, good, FOOD_CHANGES, "Re-proposal.")
        assert out2.get("ok")
        assert (db.query(MealRevision).filter(MealRevision.user_id.is_(None),
                                              MealRevision.status == "proposed").count()) == 1
    finally:
        db.close()

    prop = client.get("/api/food/proposal").json()["proposal"]
    assert prop and prop["rationale"] == "Re-proposal."
    assert prop["changes"][0]["sign"] == "~"
    assert prop["recipes"]["harissa-chicken-traybake"]["platefig"] == "tray-chicken"

    # Shelby (same household) sees and can approve the shared proposal
    login("shelby@test.dev")
    assert client.get("/api/food/proposal").json()["proposal"]["id"] == prop["id"]
    assert client.post(f"/api/food/proposal/{prop['id']}/approve").status_code == 200
    assert client.get("/api/food/proposal").json()["proposal"] is None
    w = client.get(f"/api/food/week?date={MONDAY}").json()
    assert w["rationale"] == "Re-proposal.", "approved food proposal is the active week"
    login()


def test_food_proposal_demo_wall_and_coach_tools():
    """Phase 8: the demo seat's food proposals live in its own scope; the coach
    tools read/write food through the same guarded paths."""
    from app.coach import _exec_tool, _food_context
    from app.db import SessionLocal
    from app.food_coach import create_food_proposal
    from app.models import MealLog, User

    login()
    client.post("/api/admin/demo")

    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        bruce = db.query(User).filter(User.role == "demo").first()

        # a demo proposal is invisible to members, and vice versa
        out = create_food_proposal(db, bruce, _food_week_content(), FOOD_CHANGES, "Demo week.")
        assert out.get("ok"), out
        member_prop = create_food_proposal(db, james, _food_week_content(), FOOD_CHANGES, "Member week.")
        assert member_prop.get("ok")

        assert client.get("/api/food/proposal").json()["proposal"]["rationale"] == "Member week."
        client.post("/auth/demo")
        demo_view = client.get("/api/food/proposal").json()["proposal"]
        assert demo_view["rationale"] == "Demo week."
        # demo cannot decide the household's proposal
        member_id = (db.query(__import__("app.models", fromlist=["MealRevision"]).MealRevision)
                     .filter_by(rationale="Member week.").first().id)
        assert client.post(f"/api/food/proposal/{member_id}/approve").status_code == 404
        login()

        # coach tools: read the week, the pool, the proposal; log an off-plan estimate
        assert len(_exec_tool(db, james, "get_food_week", {})["days"]) == 7
        pool = _exec_tool(db, james, "get_recipes", {"kind": "dinner"})
        assert pool and all(p["kind"] == "dinner" for p in pool)
        assert all(p["carbs_g"] > 0 and p["sodium_mg"] > 0 for p in pool), "pool carries the full label set"
        assert _exec_tool(db, james, "get_food_proposal", {})["proposal"]["rationale"] == "Member week."
        r = _exec_tool(db, james, "log_meal", {"slot": "lunch", "label": "burrito bowl",
                                               "kcal": 700, "protein_g": 45, "carbs_g": 70,
                                               "sugar_g": 6, "fiber_g": 12, "fat_g": 24,
                                               "satfat_g": 8, "sodium_mg": 1400, "estimated": True})
        assert r.get("id") and r["totals"]["sodium_mg"] == 1400 and r["totals"]["carbs_g"] == 70
        row = db.query(MealLog).filter(MealLog.id == r["id"]).first()
        assert row.estimated == 1 and row.source == "chat" and row.user_id == james.id
        assert row.sugar_g == 6 and row.fat_g == 24
        db.delete(row)

        # carry-overs: add, list, keep/bin
        assert _exec_tool(db, james, "update_carryovers",
                          {"add": [{"item": "½ jar harissa", "qty": "½ jar", "use_by": "2026-08-01"}]})["ok"]
        rows = _exec_tool(db, james, "get_carryovers", {})
        assert rows and rows[0]["item"] == "½ jar harissa"
        assert _exec_tool(db, james, "update_carryovers",
                          {"updates": [{"id": rows[0]["id"], "status": "kept"}]})["ok"]
        assert _exec_tool(db, james, "get_carryovers", {})[0]["status"] == "kept"
        # demo can't touch the household's carry-overs
        assert "error" in _exec_tool(db, bruce, "update_carryovers",
                                     {"updates": [{"id": rows[0]["id"], "status": "binned"}]})

        # dynamic prompt grounds the food half
        ctx = _food_context(db, james)
        assert "Nutrition targets" in ctx and "food week is awaiting" in ctx
    finally:
        db.close()

    # tidy: reject the pending member proposal, drop the demo
    prop_id = client.get("/api/food/proposal").json()["proposal"]["id"]
    assert client.post(f"/api/food/proposal/{prop_id}/reject").status_code == 200
    client.delete("/api/admin/demo")

def test_edit_logged_set_and_stats_recompute():
    """A mis-logged set can be corrected (active AND completed sessions);
    completed-session stats are recomputed so the summary stays honest."""
    login()
    s = client.post("/api/sessions", json={"date": MONDAY, "budget": 60}).json()
    sid = s["id"]
    r = client.post(f"/api/sessions/{sid}/sets",
                    json={"slug": "back-squat", "set_no": 1, "weight": 60, "reps": 3, "rpe": 9})
    assert r.status_code == 200

    # fat-fingered: it was actually 5 reps at RPE 7
    r = client.patch(f"/api/sessions/{sid}/sets",
                     json={"slug": "back-squat", "set_no": 1, "weight": 60, "reps": 5, "rpe": 7})
    assert r.status_code == 200
    detail = client.get(f"/api/sessions/{sid}").json()
    sq = next(g for g in detail["exercises"] if g["slug"] == "back-squat")
    assert sq["sets"][0]["reps"] == 5 and sq["sets"][0]["rpe"] == 7

    # unknown set 404s; then complete and correct again — tonnage follows
    assert client.patch(f"/api/sessions/{sid}/sets",
                        json={"slug": "back-squat", "set_no": 9, "weight": 60, "reps": 5}).status_code == 404
    client.post(f"/api/sessions/{sid}/complete", json={"cooldown_status": "done"})
    r = client.patch(f"/api/sessions/{sid}/sets",
                     json={"slug": "back-squat", "set_no": 1, "weight": 80, "reps": 5, "rpe": 8})
    assert r.status_code == 200
    stats = client.get(f"/api/sessions/{sid}").json()["stats"]
    assert stats["tonnage"] == 0.4, "80 kg × 5 = 0.4 t after the correction"
    assert stats["avg_rpe"] == 8


def test_metric_history_and_vo2_aliases():
    """Progress drill-down serves full history; HAE's alternate VO2max metric
    names all land as vo2max (historical exports used different spellings)."""
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    payload = {"data": {"metrics": [
        {"name": "vo2max", "units": "ml/kg/min",
         "data": [{"date": "2024-03-01 18:00:00 +0100", "qty": 38.9}]},
        {"name": "vo2 max", "units": "ml/kg/min",
         "data": [{"date": "2024-06-01 18:00:00 +0100", "qty": 39.4}]},
        {"name": "body_fat_percentage", "units": "%",
         "data": [{"date": "2026-07-10 07:00:00 +0100", "qty": 21.4}]}]}}
    r = client.post("/ingest", json=payload, headers={"Authorization": f"Bearer {tok}"})
    assert r.json()["stored"] == 3

    h = client.get("/api/metrics/vo2max/history").json()
    assert h["unit"] == "ml/kg/min"
    assert [p["v"] for p in h["points"][:2]] == [38.9, 39.4], "2024 readings included — full history"
    assert 21.4 in [p["v"] for p in client.get("/api/metrics/body_fat_pct/history").json()["points"]]
    assert client.get("/api/metrics/nope/history").status_code == 404
    assert client.get("/api/metrics/water_pct/history").status_code == 200


# ---------------------------------------------------------------- MCP food surface

PNG_1PX = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
           "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def _mcp(tok, method, params=None, rid=1):
    r = client.post("/mcp", headers={"Authorization": f"Bearer {tok}"},
                    json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
    return r


def _mcp_tool(tok, name, args):
    r = _mcp(tok, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    return r.json()["result"]


def test_mcp_handshake_and_auth():
    login()
    assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    tok = client.post("/api/connections/rotate-token").json()["token"]

    init = _mcp(tok, "initialize", {"protocolVersion": "2025-06-18",
                                    "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})
    body = init.json()["result"]
    assert body["protocolVersion"] == "2025-06-18"
    assert body["serverInfo"]["name"] == "forge-food"
    assert _mcp(tok, "notifications/initialized").status_code == 202
    assert client.get("/mcp").status_code == 405

    tools = {t["name"] for t in _mcp(tok, "tools/list").json()["result"]["tools"]}
    assert tools == {"log_food", "get_food_log", "delete_food_log",
                     "import_recipe", "search_recipes", "get_recipe"}


def test_mcp_log_food_with_photo_and_venue():
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]
    res = _mcp_tool(tok, "log_food", {
        "description": "Chicken burrito bowl", "date": "2026-07-20", "slot": "lunch",
        "venue": "Chipotle", "cost": 12.4, "currency": "USD",
        "kcal": 640, "protein_g": 45, "fiber_g": 9, "satfat_g": 6,
        "photos": [PNG_1PX], "client_id": "mcp-test-1"})["structuredContent"]
    assert res["duplicate"] is False
    entry = next(e for e in res["logged"] if e["id"] == res["id"])
    assert entry["venue"] == "Chipotle" and entry["cost"] == 12.4
    assert entry["photos"][0].startswith("/api/food/media/")

    # the stored photo serves to the signed-in owner, and is private to them
    assert client.get(entry["photos"][0]).headers["content-type"] == "image/png"
    login("shelby@test.dev")
    assert client.get(entry["photos"][0]).status_code == 404
    login()

    # idempotent retry via client_id
    again = _mcp_tool(tok, "log_food", {"description": "Chicken burrito bowl", "kcal": 640,
                                        "date": "2026-07-20", "slot": "lunch",
                                        "client_id": "mcp-test-1"})["structuredContent"]
    assert again["duplicate"] is True

    # counted in the app's week view (slot-matched to the planned lunch, or an extra)
    week = client.get("/api/food/week?date=2026-07-20").json()
    day = next(d for d in week["days"] if d["date"] == "2026-07-20")
    assert day["totals"]["kcal"] >= 640

    # get + delete round-trip
    got = _mcp_tool(tok, "get_food_log", {"date": "2026-07-20"})["structuredContent"]
    assert any(e["id"] == res["id"] for e in got["days"][0]["logged"])
    gone = _mcp_tool(tok, "delete_food_log", {"log_id": res["id"]})["structuredContent"]
    assert gone["ok"] is True


def test_mcp_recipe_import_and_search():
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]

    # borrow a known ingredient name from a seed recipe so one import can be complete
    found = _mcp_tool(tok, "search_recipes", {"kind": "dinner"})["structuredContent"]
    assert found["count"] > 0
    seed = next(r for r in found["recipes"] if r["source"] == "seed")
    seed_full = _mcp_tool(tok, "get_recipe", {"slug": seed["slug"]})["structuredContent"]
    known_ing = seed_full["ingredients"][0]["name"]

    # seeds are protected from overwrite
    clash = _mcp_tool(tok, "import_recipe", {
        "name": seed["name"], "slug": seed["slug"], "source_url": "https://example.com/x",
        "kcal": 500, "protein_g": 30,
        "ingredients": [{"name": known_ing}], "steps": [{"title": "Cook", "detail": "Until done"}]})
    assert clash["isError"] is True

    res = _mcp_tool(tok, "import_recipe", {
        "name": "Harissa Chicken Traybake", "slug": "test-import-traybake", "kind": "dinner", "minutes": 35,
        "difficulty": "easy", "serves": 2, "kcal": 520, "protein_g": 42, "fiber_g": 8,
        "satfat_g": 4, "why": "High protein, one tray",
        "source": "bbc-good-food", "source_url": "https://www.bbcgoodfood.com/recipes/harissa-chicken",
        "rating": 4.6, "rating_count": 212, "tags": ["traybake"],
        "ingredients": [{"name": known_ing, "qty": 300, "unit": "g"}],
        "steps": [{"title": "Roast", "detail": "Until the edges char and juices run clear, ~25 min",
                   "minutes": 25, "timer": True}]})["structuredContent"]
    assert res["complete"] is True and res["updated"] is False

    # re-import of the same source_url updates in place
    res2 = _mcp_tool(tok, "import_recipe", {
        "name": "Harissa Chicken Traybake", "source_url": "https://www.bbcgoodfood.com/recipes/harissa-chicken",
        "kcal": 530, "protein_g": 43, "rating": 4.7,
        "ingredients": [{"name": known_ing, "qty": 300, "unit": "g"}],
        "steps": [{"title": "Roast", "detail": "Until juices run clear, ~25 min"}]})["structuredContent"]
    assert res2["updated"] is True and res2["slug"] == res["slug"]

    # unknown ingredients park the recipe as incomplete, with a warning
    park = _mcp_tool(tok, "import_recipe", {
        "name": "Mystery Stew", "source_url": "https://example.com/stew",
        "kcal": 400, "protein_g": 20,
        "ingredients": [{"name": "unicorn dust"}],
        "steps": [{"title": "Simmer", "detail": "Until thick enough to coat a spoon"}]})["structuredContent"]
    assert park["complete"] is False and any("unicorn dust" in w for w in park["warnings"])

    # visible in the app API with attribution + rating; incomplete never proposable
    detail = client.get(f"/api/food/recipes/{res['slug']}").json()
    assert detail["source_url"].endswith("/harissa-chicken")
    assert detail["rating"] == 4.7 and detail["kcal"] == 530
    complete_only = _mcp_tool(tok, "search_recipes", {"query": "mystery"})["structuredContent"]
    assert complete_only["count"] == 0
    with_parked = _mcp_tool(tok, "search_recipes",
                            {"query": "mystery", "include_incomplete": True})["structuredContent"]
    assert with_parked["count"] == 1


def test_mcp_import_creates_ingredients_and_library_lists_all():
    """An unknown ingredient carrying per-100g reference macros joins the
    canonical table (the import completes); a macro-less unknown still parks.
    The app's /api/food/recipes library endpoint lists both, badged by
    `complete`, with search + kind filter."""
    login()
    tok = client.post("/api/connections/rotate-token").json()["token"]

    res = _mcp_tool(tok, "import_recipe", {
        "name": "Unicorn Shank Stew", "source_url": "https://example.com/unicorn-stew",
        "kcal": 410, "protein_g": 38, "tags": ["stew"],
        "ingredients": [{"name": "unicorn shank", "qty": 250, "unit": "g", "aisle": "protein",
                         "kcal_100": 120, "protein_100": 21.5, "fat_100": 3.2}],
        "steps": [{"title": "Braise", "detail": "Until it shreds with a fork, ~2 h"}],
    })["structuredContent"]
    assert res["complete"] is True
    assert res["ingredients_added"] == ["unicorn shank"]

    # now canonical: a second recipe uses it with no macro data and still completes
    res2 = _mcp_tool(tok, "import_recipe", {
        "name": "Unicorn Skewers", "source_url": "https://example.com/unicorn-skewers",
        "kcal": 300, "protein_g": 30,
        "ingredients": [{"name": "unicorn shank", "qty": 150, "unit": "g"}],
        "steps": [{"title": "Grill", "detail": "Until charred at the edges, ~8 min"}],
    })["structuredContent"]
    assert res2["complete"] is True and "ingredients_added" not in res2

    # recipe detail joins the newly created reference row for its aisle
    detail = client.get("/api/food/recipes/unicorn-shank-stew").json()
    assert detail["ingredients"][0]["aisle"] == "protein"

    # a macro-less unknown still parks, and the warning points at the fix
    park = _mcp_tool(tok, "import_recipe", {
        "name": "Gryphon Surprise", "source_url": "https://example.com/gryphon",
        "kcal": 350, "protein_g": 25,
        "ingredients": [{"name": "gryphon egg"}],
        "steps": [{"title": "Poach", "detail": "Until the white is set through"}],
    })["structuredContent"]
    assert park["complete"] is False
    assert any("per-100g" in w for w in park["warnings"])

    # the library endpoint: everything, parked included, badged by `complete`
    lib = client.get("/api/food/recipes").json()
    by_slug = {r["slug"]: r for r in lib["recipes"]}
    assert by_slug["unicorn-shank-stew"]["complete"] is True
    assert by_slug["gryphon-surprise"]["complete"] is False
    hits = client.get("/api/food/recipes?q=unicorn&kind=dinner").json()
    assert {r["slug"] for r in hits["recipes"]} == {"unicorn-shank-stew", "unicorn-skewers"}
    assert client.get("/api/food/recipes?q=unicorn&kind=breakfast").json()["count"] == 0


def test_restart_with_new_budget_refits():
    """Shortening the workout after it was already started must stick: a second
    POST /api/sessions with a different budget re-fits the active session's
    snapshot instead of returning the stale (full-length) one, and never trims
    below sets already logged."""
    login("shelby@test.dev")  # seeded plan intact — James's was replaced by a proposal
    monday = "2026-07-27"  # untouched by other tests

    full = client.post("/api/sessions", json={"date": monday}).json()
    assert full["resumed"] is False
    full_sets = {t["slug"]: t["sets"] for t in full["fitted"]["targets"]}

    # user backs out, shortens to 40 min, starts again → trimmed fit, same session
    short = client.post("/api/sessions", json={"date": monday, "budget": 40}).json()
    assert short["resumed"] is True and short["id"] == full["id"]
    assert short["fitted"]["budget"] == 40
    short_sets = {t["slug"]: t["sets"] for t in short["fitted"]["targets"]}
    assert sum(short_sets.values()) < sum(full_sets.values()), "40 min must trim"
    assert short_sets["back-squat"] == full_sets["back-squat"], "main lift untouched"

    # log 2 sets of an accessory, then squeeze to 25 min: that accessory
    # can't be trimmed below what's already in the book
    acc = next(s for s in full_sets if s != "back-squat")
    for i in (1, 2):
        client.post(f"/api/sessions/{full['id']}/sets",
                    json={"slug": acc, "set_no": i, "weight": 20, "reps": 10})
    tight = client.post("/api/sessions", json={"date": monday, "budget": 25}).json()
    tight_sets = {t["slug"]: t["sets"] for t in tight["fitted"]["targets"]}
    assert tight_sets[acc] >= 2, "logged sets are never dropped by a re-fit"

    # sliding back up restores the full session
    again = client.post("/api/sessions", json={"date": monday}).json()
    assert {t["slug"]: t["sets"] for t in again["fitted"]["targets"]} == full_sets
    client.post(f"/api/sessions/{full['id']}/complete", json={"cooldown_status": "skipped"})


def test_demo_food_seed_and_enrich():
    """The demo seat ships with a food story (E16 beta): an active week in its
    own scope, a pending food proposal, weeks of meal logs including order-out
    lunches with venue/cost — and /api/admin/demo/enrich tops up a demo created
    before the food beta without touching its training history."""
    from app.db import SessionLocal
    from app.models import Carryover, LunchFavorite, MealLog, MealRevision, User, WorkoutSession

    login()
    client.post("/api/admin/demo")

    client.post("/auth/demo")
    assert client.get("/api/food/week").json()["has_plan"] is True
    prop = client.get("/api/food/proposal").json()["proposal"]
    assert prop and prop["changes"], "demo ships with a pending food proposal"

    db = SessionLocal()
    try:
        bruce = db.query(User).filter(User.role == "demo").first()
        orders = db.query(MealLog).filter(MealLog.user_id == bruce.id, MealLog.source == "order").all()
        assert orders and all(o.venue and o.cost > 0 for o in orders), "order lunches carry venue+cost"
        assert db.query(Carryover).filter_by(user_id=bruce.id).count() >= 3
        assert db.query(LunchFavorite).filter_by(user_id=bruce.id).count() == 2
        sessions_before = db.query(WorkoutSession).filter_by(user_id=bruce.id).count()
    finally:
        db.close()

    # enrich is a no-op when the demo already has everything
    login()
    assert client.post("/api/admin/demo/enrich").json()["added"] == []

    # a demo from before the food beta gets topped up in place
    db = SessionLocal()
    try:
        bruce = db.query(User).filter(User.role == "demo").first()
        db.query(MealLog).filter_by(user_id=bruce.id).delete()
        db.query(MealRevision).filter_by(user_id=bruce.id).delete()
        db.query(Carryover).filter_by(user_id=bruce.id).delete()
        db.query(LunchFavorite).filter_by(user_id=bruce.id).delete()
        db.commit()
    finally:
        db.close()
    assert client.post("/api/admin/demo/enrich").json()["added"] == ["food"]

    client.post("/auth/demo")
    assert client.get("/api/food/week").json()["has_plan"] is True
    db = SessionLocal()
    try:
        bruce = db.query(User).filter(User.role == "demo").first()
        assert db.query(WorkoutSession).filter_by(user_id=bruce.id).count() == sessions_before, \
            "enrich never touches training history"
    finally:
        db.close()
    login()


def test_security_txt():
    """RFC 9116: served at the well-known path (and the legacy root alias),
    contact derived from the admin seat, expiry present and in the future."""
    r = client.get("/.well-known/security.txt")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert "Contact: mailto:james@test.dev" in r.text
    exp = next(line for line in r.text.splitlines() if line.startswith("Expires: "))
    assert exp.split(" ", 1)[1] > "2026"
    alias = client.get("/security.txt")
    assert alias.status_code == 200 and "Contact: mailto:james@test.dev" in alias.text


def test_html_base_url_substitution():
    """HTML entry points must never leak the __BASE_URL__ token — the real
    host is substituted from settings at serve time (it lives only in the
    compose override, never in tracked files)."""
    for path in ("/", "/welcome", "/welcome.html", "/dashboard"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert "__BASE_URL__" not in r.text, path


def test_weekly_note_repair_and_voice():
    """Two real failure modes from the live coach (Jul 2026): the model
    double-escapes unicode in tool args (the user saw literal '\\u2014' in the
    Plan-screen note), and at Sunday review it writes the rationale in 'next
    week' voice — but the note is read ON the week it covers."""
    from app.coach import create_proposal, repair_text
    from app.db import SessionLocal
    from app.models import Plan, PlanRevision, User

    assert repair_text("light work \\u2014 not a grind") == "light work — not a grind"

    login()
    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        days = {"0": {"name": "Lower A", "kind": "strength", "focus": ["Quads"],
                      "why": "squats climb \\u2014 watch bar speed",
                      "exercises": [{"slug": "back-squat", "sets": 3, "reps": 5, "weight": 65.0,
                                     "rest": 120, "priority": 1, "min_sets": 3}],
                      "cooldown": [{"slug": "quad-hip-flexor-stretch", "hold": "45 s"}]}}

        bad = create_proposal(db, james, {"days": days, "changes": []},
                              "Next week's squats move to 65 kg.")
        assert "present voice" in bad["error"]

        good = create_proposal(db, james, {"days": days, "changes": []},
                               "This week banks 65 kg squats \\u2014 a first at this load.")
        assert good.get("ok"), good
    finally:
        db.close()

    prop = client.get("/api/proposal").json()["proposal"]
    assert "—" in prop["rationale"] and "\\u" not in prop["rationale"]
    assert "—" in prop["content"]["days"]["0"]["why"]
    client.post(f"/api/proposal/{prop['id']}/reject")  # leave the seeded plan active

    # rows written before the write-side repair heal on first read
    db = SessionLocal()
    try:
        james = db.query(User).filter(User.email == "james@test.dev").first()
        rev = (db.query(PlanRevision).join(Plan)
               .filter(Plan.user_id == james.id, Plan.domain == "training",
                       PlanRevision.status == "active")
               .order_by(PlanRevision.num.desc()).first())
        rev.rationale = "Bench nudges up \\u2014 light work, not a grind."
        db.commit()
    finally:
        db.close()
    wk = client.get("/api/week").json()
    assert "—" in wk["rationale"] and "\\u" not in wk["rationale"]

def test_favorite_star_and_filter():
    """Star a session, confirm it in the detail + history payloads, and that the
    favorites filter narrows History to starred sessions."""
    login()
    r = client.post("/api/sessions", json={"date": MONDAY, "budget": 40}).json()
    sid = r["id"]
    client.post(f"/api/sessions/{sid}/sets",
                json={"slug": "back-squat", "set_no": 1, "weight": 60, "reps": 5})
    client.post(f"/api/sessions/{sid}/complete", json={"cooldown_status": "skipped"})

    assert client.get(f"/api/sessions/{sid}").json()["favorite"] is False
    row = next(h for h in client.get("/api/history").json() if h["id"] == sid)
    assert row["favorite"] is False

    r = client.patch(f"/api/sessions/{sid}/favorite", json={"favorite": True})
    assert r.status_code == 200 and r.json()["favorite"] is True
    assert client.get(f"/api/sessions/{sid}").json()["favorite"] is True

    fav = client.get("/api/history?favorites=true").json()
    assert any(h["id"] == sid for h in fav) and all(h["favorite"] for h in fav)

    client.patch(f"/api/sessions/{sid}/favorite", json={"favorite": False})
    assert all(h["id"] != sid for h in client.get("/api/history?favorites=true").json())


def test_delete_session():
    """Discard/delete drops the session and its sets; it vanishes from History."""
    login()
    r = client.post("/api/sessions", json={"date": MONDAY, "budget": 40}).json()
    sid = r["id"]
    client.post(f"/api/sessions/{sid}/sets",
                json={"slug": "back-squat", "set_no": 1, "weight": 60, "reps": 5})
    client.post(f"/api/sessions/{sid}/complete", json={"cooldown_status": "skipped"})
    assert any(h["id"] == sid for h in client.get("/api/history").json())

    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    assert all(h["id"] != sid for h in client.get("/api/history").json())
    assert client.get(f"/api/sessions/{sid}").status_code == 404


def test_discard_dangling_session():
    """The unfinished-workout sheet discards an abandoned session via DELETE,
    clearing the /api/week reminder."""
    login()
    past_monday = "2026-07-06"  # strength day, before today
    r = client.post("/api/sessions", json={"date": past_monday})
    sid = r.json()["id"]
    client.post(f"/api/sessions/{sid}/sets",
                json={"slug": "back-squat", "set_no": 1, "weight": 60, "reps": 5})
    assert client.get("/api/week").json()["dangling"]["id"] == sid

    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    assert client.get("/api/week").json()["dangling"] is None


def test_favorite_and_delete_scoped_to_owner():
    """Neither favoriting nor deleting reaches another user's session (404)."""
    login("james@test.dev")
    sid = client.post("/api/sessions", json={"date": MONDAY, "budget": 40}).json()["id"]
    login("shelby@test.dev")
    assert client.patch(f"/api/sessions/{sid}/favorite", json={"favorite": True}).status_code == 404
    assert client.delete(f"/api/sessions/{sid}").status_code == 404
    # clean up James's leftover active session
    login("james@test.dev")
    client.delete(f"/api/sessions/{sid}")

"""Session fitting: time-budget trimming, warm-up ramps, plate math, e1RM.

Policies (locked in the spec):
- The priority-1 (main) exercise is never trimmed.
- Accessories lose sets first (to min_sets floors), the cool-down shortens
  5 -> 2 minutes late in the ladder, and is never dropped entirely.
"""

from __future__ import annotations

WARMUP_S = 480  # general warm-up
SETUP_S = 240  # per-exercise setup/changeover
WORK_SET_S = 60
CD_FULL_S = 300
CD_SHORT_S = 120


def epley_e1rm(weight: float, reps: int) -> float:
    if reps <= 0 or weight <= 0:
        return 0.0
    if reps == 1:
        return round(weight, 1)
    return round(weight * (1 + reps / 30.0), 1)


def plate_breakdown(weight: float, bar_kg: float, plates_kg: list[float]) -> str:
    if weight <= 0:
        return ""
    per = (weight - bar_kg) / 2.0
    if per < 0.01:
        return f"Empty bar ({bar_kg:g} kg)"
    out: list[float] = []
    for p in sorted(plates_kg, reverse=True):
        while per >= p - 1e-9:
            out.append(p)
            per -= p
    txt = "Per side: " + " + ".join(f"{p:g}" for p in out) if out else "Per side: —"
    if per > 0.01:
        txt += f" — no plate for {per:.2f} kg"
    return txt


def loadable(weight: float, bar_kg: float, plates_kg: list[float]) -> bool:
    per = round((weight - bar_kg) / 2.0, 3)
    if per < 0:
        return False
    for p in sorted(plates_kg, reverse=True):
        while per >= p - 1e-9:
            per = round(per - p, 3)
    return per <= 0.01


def warmup_ramp(work_weight: float, bar_kg: float) -> list[dict] | None:
    if work_weight < 50:
        return None
    rnd = lambda x: round(x / 2.5) * 2.5
    return [
        {"weight": bar_kg, "reps": 10},
        {"weight": rnd(work_weight * 0.5), "reps": 8},
        {"weight": rnd(work_weight * 0.7), "reps": 5},
        {"weight": rnd(work_weight * 0.85), "reps": 3},
    ]


def _est_seconds(entries: list[dict], sets_map: dict[str, int], cd: str) -> int:
    s = WARMUP_S + (CD_FULL_S if cd == "full" else CD_SHORT_S)
    for e in entries:
        n = sets_map.get(e["slug"], 0)
        if n > 0:
            s += n * WORK_SET_S + (n - 1) * e.get("rest", 90) + SETUP_S
    return s


def est_minutes(entries: list[dict], sets_map: dict[str, int], cd: str) -> int:
    return round(_est_seconds(entries, sets_map, cd) / 60)


def build_trim_ladder(entries: list[dict]) -> list[tuple[str, object]]:
    """Trim steps, least-important first. entries carry priority (1=main, higher
    trims earlier), sets (base) and min_sets."""
    acc = [e for e in entries if e.get("priority", 2) > 1]
    acc.sort(key=lambda e: -e.get("priority", 2))
    ladder: list[tuple[str, object]] = []
    # pass 1: everyone down to max(min_sets, base-1)
    for e in acc:
        if e["sets"] - 1 >= max(e.get("min_sets", 0), 1):
            ladder.append((e["slug"], e["sets"] - 1))
    # pass 2: down to min_sets where min >= 1
    for e in acc:
        if e.get("min_sets", 0) >= 1 and e["sets"] - 1 > e["min_sets"]:
            ladder.append((e["slug"], e["min_sets"]))
    # shorten cool-down before dropping whole exercises
    ladder.append(("__cooldown__", "short"))
    # pass 3: droppable exercises (min_sets == 0) to zero
    for e in acc:
        if e.get("min_sets", 0) == 0:
            ladder.append((e["slug"], 0))
    return ladder


def fit_day(entries: list[dict], budget_min: int | None) -> dict:
    """Returns {sets: {slug: n}, cd: 'full'|'short', est: minutes, trims: [str]}."""
    sets_map = {e["slug"]: e["sets"] for e in entries}
    cd = "full"
    trims: list[str] = []
    if budget_min:
        for slug, val in build_trim_ladder(entries):
            if est_minutes(entries, sets_map, cd) <= budget_min:
                break
            if slug == "__cooldown__":
                cd = "short"
                trims.append("cool-down 5→2 min")
            else:
                entry = next(e for e in entries if e["slug"] == slug)
                new_n = int(val)
                if new_n == 0:
                    trims.append(f"{entry.get('name', slug)} dropped")
                else:
                    trims.append(f"{entry.get('name', slug)} {sets_map[slug]}→{new_n} sets")
                sets_map[slug] = new_n
    return {
        "sets": sets_map,
        "cd": cd,
        "est": est_minutes(entries, sets_map, cd),
        "trims": trims,
    }

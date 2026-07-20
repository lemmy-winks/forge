"""Idempotent startup seed: allowlisted users, exercise library, equipment
profiles, a starter plan per user, and James's known niggle."""

from sqlalchemy.orm import Session

from .config import get_settings
from .models import EquipmentProfile, Exercise, IngestToken, Niggle, Plan, PlanRevision, User
from .security import new_ingest_token

EXERCISES = [
    # slug, name, kind, primary, secondary, equipment, patterns, cues, dont
    ("back-squat", "Back Squat", "bb", ["Quads", "Glutes"], ["Core"], ["Barbell + power rack"], ["squat"],
     ["Bar over mid-foot, brace before you bend", "Knees track the toes", "Drive the floor away — hips and chest rise together"],
     "Don't let the hips shoot up first"),
    ("romanian-deadlift", "Romanian Deadlift", "bb", ["Hamstrings", "Glutes"], ["Lower back"], ["Barbell + power rack"], ["hinge"],
     ["Soft knees — hinge at the hips, chest proud", "Bar slides down the thighs, weight in mid-foot", "Stop when the hamstrings pull — don't chase the floor"],
     "Don't round the back or bend it into a squat"),
    ("split-squat", "Split Squat", "db", ["Quads", "Glutes"], [], ["Dumbbells"], ["lunge"],
     ["Long stance, front shin vertical", "Straight down, not forward", "Push through the front heel"],
     "Don't let the front knee cave inward"),
    ("bulgarian-split-squat", "Bulgarian Split Squat", "db", ["Quads", "Glutes"], [], ["Dumbbells", "Bench"], ["lunge", "deep_lunge"],
     ["Rear foot on the bench, hips square", "Drop straight down"], "Don't chase depth with a grumpy knee"),
    ("hanging-leg-raise", "Hanging Leg Raise", "bw", ["Abs"], ["Hip flexors", "Grip"], ["Pull-up bar"], ["trunk_flexion"],
     ["Dead hang, shoulders packed", "Curl the pelvis, not just the legs", "Lower on a 3-count"],
     "Don't swing — momentum steals the work"),
    ("leg-press", "Leg Press", "machine", ["Quads", "Glutes"], [], ["Leg press"], ["squat"],
     ["Feet mid-platform", "Lower under control to 90°"], "Don't let the lower back roll off the pad"),
    ("goblet-squat", "Goblet Squat", "db", ["Quads", "Glutes"], ["Core"], ["Dumbbells"], ["squat"],
     ["Dumbbell tight to the chest", "Elbows inside the knees at depth"], "Don't tip forward"),
    ("bench-press", "Bench Press", "bb", ["Chest"], ["Triceps", "Front delts"], ["Barbell + power rack", "Bench"], ["horizontal_push"],
     ["Feet planted, slight arch", "Bar to lower chest", "Press back toward the rack"], "Don't bounce off the chest"),
    ("db-bench-press", "DB Bench Press", "db", ["Chest"], ["Triceps"], ["Dumbbells", "Bench"], ["horizontal_push"],
     ["Palms slightly turned in", "Full stretch at the bottom"], "Don't clang the bells at the top"),
    ("seated-row", "Seated Row", "machine", ["Back"], ["Biceps", "Rear delts"], ["Cable stack"], ["horizontal_pull"],
     ["Chest tall, pull to the sternum", "Squeeze the shoulder blades"], "Don't heave with the lower back"),
    ("lat-pulldown", "Lat Pulldown", "machine", ["Back"], ["Biceps"], ["Cable stack"], ["vertical_pull"],
     ["Pull the elbows down and back"], "Don't lean into a row"),
    ("overhead-press", "Overhead Press", "bb", ["Shoulders"], ["Triceps"], ["Barbell + power rack"], ["overhead_press"],
     ["Squeeze glutes, ribs down", "Press slightly back, head through"], "Don't turn it into a standing incline"),
    ("landmine-press", "Landmine Press", "bb", ["Shoulders"], ["Chest", "Triceps"], ["Barbell + power rack"], ["incline_push"],
     ["Press up and away on the arc"], "Don't shrug the shoulder to the ear"),
    ("face-pull", "Face Pull", "machine", ["Rear delts"], ["Upper back"], ["Cable stack"], ["horizontal_pull"],
     ["Rope to the bridge of the nose", "Thumbs point behind you"], "Don't turn it into a row — light and strict"),
    ("db-romanian-deadlift", "DB Romanian Deadlift", "db", ["Hamstrings", "Glutes"], [], ["Dumbbells"], ["hinge"],
     ["Same hinge, bells slide down the thighs"], "Don't round the back"),
    ("back-extension", "Back Extension", "bw", ["Hamstrings", "Lower back"], ["Glutes"], [], ["hinge"],
     ["Hinge, don't hyperextend"], "Don't whip through the top"),
    ("cable-crunch", "Cable Crunch", "machine", ["Abs"], [], ["Cable stack"], ["trunk_flexion"],
     ["Crunch the ribs to the hips"], "Don't pull with the arms"),
    ("plank", "Plank", "bw", ["Core"], [], [], [],
     ["Squeeze glutes, ribs down, long neck"], "Don't sag at the hips"),
    # ---- expanded common-gym library (Jul 2026) ----
    # lower
    ("front-squat", "Front Squat", "bb", ["Quads", "Core"], ["Glutes"], ["Barbell + power rack"], ["squat"],
     ["Bar on the front delts, elbows high", "Stay tall — the torso is the lever", "Drive up through mid-foot"],
     "Don't let the elbows drop — the bar goes with them"),
    ("deadlift", "Deadlift", "bb", ["Hamstrings", "Glutes", "Lower back"], ["Traps", "Grip"], ["Barbell + power rack"], ["hinge"],
     ["Bar over mid-foot, shins touch", "Wedge in: chest up, lats on", "Push the floor away, finish tall"],
     "Don't jerk the bar off the floor — take the slack out first"),
    ("sumo-deadlift", "Sumo Deadlift", "bb", ["Glutes", "Hamstrings"], ["Quads", "Lower back"], ["Barbell + power rack"], ["hinge"],
     ["Wide stance, toes out, knees track the toes", "Hips close to the bar", "Spread the floor as you stand"],
     "Don't let the knees cave on the way up"),
    ("hip-thrust", "Barbell Hip Thrust", "bb", ["Glutes"], ["Hamstrings"], ["Barbell + power rack", "Bench"], ["hinge"],
     ["Upper back on the bench, bar over the hips", "Chin tucked, ribs down", "Squeeze to a full lockout — pause at the top"],
     "Don't hyperextend the lower back at the top"),
    ("walking-lunge", "DB Walking Lunge", "db", ["Quads", "Glutes"], ["Core"], ["Dumbbells"], ["lunge"],
     ["Long step, torso tall", "Back knee kisses the floor", "Drive off the front heel into the next step"],
     "Don't let the front knee dive inward"),
    ("reverse-lunge", "DB Reverse Lunge", "db", ["Quads", "Glutes"], [], ["Dumbbells"], ["lunge"],
     ["Step back, drop straight down", "Front shin stays near vertical"],
     "Don't push off the back toe — the front leg does the work"),
    ("leg-curl", "Lying Leg Curl", "machine", ["Hamstrings"], [], ["Leg curl machine"], [],
     ["Hips pinned to the pad", "Curl fast, lower on a 3-count"],
     "Don't let the hips pop up as you curl"),
    ("leg-extension", "Leg Extension", "machine", ["Quads"], [], ["Leg extension machine"], [],
     ["Pad on the shins, back against the seat", "Pause a beat at lockout"],
     "Don't kick with momentum — squeeze"),
    ("standing-calf-raise", "Standing Calf Raise", "machine", ["Calves"], [], ["Calf raise machine"], [],
     ["Full stretch at the bottom", "Pause at the top — no bouncing"],
     "Don't cut the range to move more weight"),
    ("glute-bridge", "Glute Bridge", "bw", ["Glutes"], ["Hamstrings"], [], ["hinge"],
     ["Heels close, drive through them", "Squeeze the glutes to lift, ribs down"],
     "Don't arch the lower back to fake height"),
    ("good-morning", "Good Morning", "bb", ["Hamstrings", "Lower back"], ["Glutes"], ["Barbell + power rack"], ["hinge"],
     ["Soft knees, hinge until the hamstrings bite", "Brace like a squat — the bar stays quiet"],
     "Don't round — this one punishes it"),
    ("kettlebell-swing", "Kettlebell Swing", "db", ["Glutes", "Hamstrings"], ["Core"], ["Kettlebells"], ["hinge"],
     ["Hike it back, snap the hips", "The arms are ropes — power comes from the hinge", "Stand tall at the top"],
     "Don't squat it — it's a hinge"),
    ("step-up", "DB Step-Up", "db", ["Quads", "Glutes"], [], ["Dumbbells", "Bench"], ["lunge"],
     ["Whole foot on the box", "Drive through the top heel — no push-off below"],
     "Don't bounce off the bottom leg"),
    # push
    ("incline-bench-press", "Incline Bench Press", "bb", ["Chest", "Front delts"], ["Triceps"], ["Barbell + power rack", "Bench"], ["incline_push"],
     ["Bar to the upper chest", "Feet planted, slight arch", "Press up and slightly back"],
     "Don't flare the elbows to 90°"),
    ("incline-db-press", "Incline DB Press", "db", ["Chest", "Front delts"], ["Triceps"], ["Dumbbells", "Bench"], ["incline_push"],
     ["Bells start at the shoulders, palms forward-ish", "Full stretch at the bottom"],
     "Don't clang the bells at the top"),
    ("machine-chest-press", "Machine Chest Press", "machine", ["Chest"], ["Triceps"], ["Chest press machine"], ["horizontal_push"],
     ["Handles mid-chest height", "Shoulder blades back into the pad"],
     "Don't shrug as you press"),
    ("pec-deck", "Pec Deck Fly", "machine", ["Chest"], [], ["Pec deck"], [],
     ["Elbows slightly bent, sweep to the middle", "Squeeze a beat, open slow"],
     "Don't open past a comfortable stretch"),
    ("cable-crossover", "Cable Crossover", "machine", ["Chest"], ["Front delts"], ["Cable stack"], [],
     ["Step forward, slight lean", "Hug a barrel — hands meet low"],
     "Don't turn it into a pressing movement"),
    ("db-shoulder-press", "DB Shoulder Press", "db", ["Shoulders"], ["Triceps"], ["Dumbbells", "Bench"], ["overhead_press"],
     ["Bells at ear height to start", "Press to lockout, biceps by the ears"],
     "Don't arch the lower back to press bigger bells"),
    ("lateral-raise", "Lateral Raise", "db", ["Shoulders"], [], ["Dumbbells"], [],
     ["Lead with the elbows, out to shoulder height", "Tip the pinkies slightly up"],
     "Don't swing — lighter and stricter wins"),
    ("dips", "Dips", "bw", ["Chest", "Triceps"], ["Front delts"], ["Dip station"], ["horizontal_push"],
     ["Lean forward for chest, upright for triceps", "Down until the upper arm is parallel"],
     "Don't sink below a comfortable shoulder depth"),
    ("push-up", "Push-Up", "bw", ["Chest"], ["Triceps", "Core"], [], ["horizontal_push"],
     ["Body one straight line", "Hands under the shoulders, elbows ~45°", "Chest to the floor"],
     "Don't let the hips sag"),
    ("close-grip-bench", "Close-Grip Bench Press", "bb", ["Triceps"], ["Chest"], ["Barbell + power rack", "Bench"], ["horizontal_push"],
     ["Hands just inside shoulder width", "Elbows tucked, bar to the lower chest"],
     "Don't go so narrow the wrists complain"),
    ("triceps-pushdown", "Triceps Pushdown", "machine", ["Triceps"], [], ["Cable stack"], [],
     ["Elbows pinned to the ribs", "Full lockout, control back up"],
     "Don't lean on the cable"),
    ("overhead-triceps-extension", "Overhead Triceps Extension", "db", ["Triceps"], [], ["Dumbbells"], [],
     ["Both hands under one bell", "Lower behind the head, elbows point forward"],
     "Don't flare the elbows wide"),
    ("skullcrusher", "Skullcrusher", "bb", ["Triceps"], [], ["Barbell + power rack", "Bench"], [],
     ["Bar to the forehead or just behind", "Elbows stay pointed at the ceiling"],
     "Don't let the elbows drift out"),
    # pull
    ("pull-up", "Pull-Up", "bw", ["Back", "Biceps"], ["Grip"], ["Pull-up bar"], ["vertical_pull"],
     ["Dead hang, shoulders packed", "Pull the elbows to the ribs", "Chin over the bar, lower slow"],
     "Don't kip — full hang, full pull"),
    ("chin-up", "Chin-Up", "bw", ["Back", "Biceps"], ["Grip"], ["Pull-up bar"], ["vertical_pull"],
     ["Palms toward you, shoulder width", "Lead the pull with the chest"],
     "Don't shorten the bottom half"),
    ("barbell-row", "Barbell Row", "bb", ["Back"], ["Biceps", "Lower back"], ["Barbell + power rack"], ["horizontal_pull", "hinge"],
     ["Hinge to ~45°, back flat", "Pull the bar to the lower ribs", "Squeeze the blades, lower quiet"],
     "Don't heave with the hips — that's a different lift"),
    ("db-row", "One-Arm DB Row", "db", ["Back"], ["Biceps"], ["Dumbbells", "Bench"], ["horizontal_pull"],
     ["Knee and hand on the bench, back flat", "Pull to the hip, not the armpit"],
     "Don't rotate the torso to lift more"),
    ("straight-arm-pulldown", "Straight-Arm Pulldown", "machine", ["Back"], [], ["Cable stack"], ["vertical_pull"],
     ["Arms long, sweep the bar to the thighs", "Feel the lats, not the arms"],
     "Don't bend the elbows into a pressdown"),
    ("rear-delt-fly", "Rear Delt Fly", "db", ["Rear delts"], ["Upper back"], ["Dumbbells", "Bench"], [],
     ["Chest supported or hinged flat", "Sweep wide, thumbs down slightly"],
     "Don't swing the weight up"),
    ("shrug", "Barbell Shrug", "bb", ["Traps"], ["Grip"], ["Barbell + power rack"], [],
     ["Straight up toward the ears", "Pause at the top, lower long"],
     "Don't roll the shoulders — straight up and down"),
    ("barbell-curl", "Barbell Curl", "bb", ["Biceps"], ["Forearms"], ["Barbell + power rack"], [],
     ["Elbows pinned to the sides", "Curl to the collarbone, lower on 3"],
     "Don't sway the hips to start the rep"),
    ("db-curl", "DB Curl", "db", ["Biceps"], ["Forearms"], ["Dumbbells"], [],
     ["Supinate as you curl — pinky up at the top", "Full straight-arm bottom"],
     "Don't let the elbows drift forward"),
    ("hammer-curl", "Hammer Curl", "db", ["Biceps", "Forearms"], [], ["Dumbbells"], [],
     ["Neutral grip the whole way", "Squeeze at the top"],
     "Don't rush the lowering half"),
    ("cable-curl", "Cable Curl", "machine", ["Biceps"], ["Forearms"], ["Cable stack"], [],
     ["Constant tension — don't rest at the bottom", "Elbows stay put"],
     "Don't lean back to finish reps"),
    # core
    ("crunch", "Crunch", "bw", ["Abs"], [], [], ["trunk_flexion"],
     ["Ribs to hips — it's a short move", "Exhale hard at the top"],
     "Don't pull on the neck"),
    ("russian-twist", "Russian Twist", "bw", ["Abs", "Obliques"], [], [], ["trunk_flexion"],
     ["Lean back to ~45°, chest proud", "Rotate from the ribs, hands follow"],
     "Don't round into a slump"),
    ("ab-wheel", "Ab Wheel Rollout", "bw", ["Abs", "Core"], [], ["Ab wheel"], [],
     ["Tuck the pelvis before you roll", "Go only as far as the back stays flat"],
     "Don't let the hips sag into an arch"),
    ("side-plank", "Side Plank", "bw", ["Core", "Obliques"], [], [], [],
     ["Elbow under shoulder, body one line", "Push the hip tall — don't hang on the joint"],
     "Don't let the top shoulder roll forward"),
    ("dead-bug", "Dead Bug", "bw", ["Core"], [], [], [],
     ["Lower back glued to the floor", "Opposite arm and leg reach long, slow"],
     "Don't hold your breath — exhale on the reach"),
    # mobility / cool-down items
    ("quad-hip-flexor-stretch", "Quad & hip flexor stretch", "mobility", ["Quads", "Hip flexors"], [], [], [],
     ["Half-kneel, tuck the pelvis, reach tall"], ""),
    ("hamstring-stretch", "Hamstring stretch", "mobility", ["Hamstrings"], [], [], [],
     ["Hinge to a gentle pull, breathe"], ""),
    ("ninety-ninety-hip", "90/90 hip switch", "mobility", ["Hips"], [], [], [],
     ["Slow switches, tall spine"], ""),
    ("walk-easy", "Walk it off", "mobility", ["Legs"], [], [], [],
     ["2 minutes easy — flat treadmill counts"], ""),
    ("chest-doorway-stretch", "Doorway chest stretch", "mobility", ["Chest"], [], [], [],
     ["Forearm on the frame, step through gently"], ""),
]

# Curated form media (James's call: existing demos, not self-filmed — the old
# Phase 5 media pipeline is retired). Two public-domain frames per exercise from
# free-exercise-db, self-hosted in web/public/media/exercises/<slug>-{0,1}.jpg.
MEDIA_SLUGS = [
    "back-squat", "romanian-deadlift", "split-squat", "bulgarian-split-squat",
    "hanging-leg-raise", "leg-press", "goblet-squat", "bench-press", "db-bench-press",
    "seated-row", "lat-pulldown", "overhead-press", "face-pull", "db-romanian-deadlift",
    "back-extension", "cable-crunch", "plank", "quad-hip-flexor-stretch",
    "hamstring-stretch", "ninety-ninety-hip", "walk-easy",
    # expanded library
    "front-squat", "deadlift", "sumo-deadlift", "hip-thrust", "glute-bridge",
    "walking-lunge", "reverse-lunge", "leg-curl", "leg-extension", "standing-calf-raise",
    "good-morning", "kettlebell-swing", "step-up",
    "incline-bench-press", "incline-db-press", "machine-chest-press", "pec-deck",
    "cable-crossover", "db-shoulder-press", "lateral-raise", "dips", "push-up",
    "close-grip-bench", "triceps-pushdown", "overhead-triceps-extension", "skullcrusher",
    "pull-up", "chin-up", "barbell-row", "db-row", "straight-arm-pulldown",
    "rear-delt-fly", "shrug", "barbell-curl", "db-curl", "hammer-curl", "cable-curl",
    "crunch", "russian-twist", "ab-wheel", "side-plank", "dead-bug",
]


def _media_url(slug: str) -> str:
    return ",".join(f"/media/exercises/{slug}-{i}.jpg" for i in (0, 1))


# Why each exercise earns its place — shown on the Learn screen.
BENEFITS = {
    "back-squat": "The biggest bang-for-buck lower-body lift: loads the whole leg and trunk at once, and drives strength that carries to everything from sprinting to standing up when you're 80.",
    "romanian-deadlift": "Builds the hamstrings and glutes through a long stretch under load — the best insurance policy for a strong, injury-resistant posterior chain.",
    "split-squat": "Trains each leg on its own, exposing and fixing left–right gaps while sparing the lower back the load a heavy squat needs.",
    "bulgarian-split-squat": "Brutal single-leg strength and balance with light dumbbells — huge leg stimulus per kg in the hands.",
    "hanging-leg-raise": "Trains the abs the way they actually work — resisting and controlling the pelvis — while building grip and shoulder hang tolerance for free.",
    "leg-press": "Heavy leg work with the back fully supported — perfect for volume when the spine has had enough, or as a squat stand-in on tired days.",
    "goblet-squat": "The friendliest squat there is: the front-held weight forces good posture automatically, making it ideal for warm-ups, technique work, and home sessions.",
    "bench-press": "The benchmark horizontal press — chest, triceps and front delts moving the most weight they ever will together.",
    "db-bench-press": "The barbell bench's honest sibling: each arm works alone through a longer range, building balanced pressing strength and healthier shoulders.",
    "seated-row": "Directly counters desk posture: pulls the shoulder blades back and builds the mid-back thickness that keeps shoulders sitting where they should.",
    "lat-pulldown": "Builds the lats and the pull-up you may not have yet — vertical pulling strength with a fully adjustable load.",
    "overhead-press": "The most complete shoulder builder and a whole-body brace test — nothing goes overhead without the trunk earning it.",
    "landmine-press": "An overhead-ish press on an arc that most cranky shoulders tolerate well — keeps pressing progress alive when strict overhead is a no.",
    "face-pull": "Small load, big payoff: builds the rear delts and rotator cuff that keep pressing shoulders healthy. The antidote to every push day.",
    "db-romanian-deadlift": "All the hamstring-building hinge of the barbell RDL in a lighter, home-friendly package.",
    "back-extension": "Strengthens the often-neglected spinal erectors and glutes through simple repeatable volume — a resilient lower back is built here.",
    "cable-crunch": "Loads trunk flexion progressively like any other lift — abs grow with resistance, not with endless floor reps.",
    "plank": "Teaches the trunk's real job: holding a rigid, neutral spine while everything else works. The foundation under every barbell lift.",
    "front-squat": "Squatting with the bar in front makes the upper back and core do overtime and keeps the torso tall — quad growth plus posture in one lift.",
    "deadlift": "Picking heavy things off the floor is the most fundamental strength there is — total posterior chain, grip and nerve, one bar.",
    "sumo-deadlift": "The wide-stance pull: more quads and glutes, less lower-back demand — a great fit when conventional pulling beats you up.",
    "hip-thrust": "The most direct glute loader in the gym — drives hip power for sprinting, jumping and every squat and pull you do.",
    "glute-bridge": "The no-equipment glute switch-on: wakes up hips that sit in a chair all day; the floor version of the hip thrust.",
    "walking-lunge": "Strength that travels: single-leg drive, balance and hip mobility rep after rep — legs that work in the real world.",
    "reverse-lunge": "The knee-friendliest lunge — stepping back keeps the shin vertical, making it the go-to when forward lunges grumble.",
    "leg-curl": "The only direct knee-flexion work most programs have — hamstrings that are strong at the knee, not just the hip, protect the whole leg.",
    "leg-extension": "Isolates the quads with zero balance demand — ideal for adding volume, rehabbing knees, or finishing a session.",
    "standing-calf-raise": "Strong calves absorb impact for every run and jump — trained through full range they also keep ankles springy.",
    "good-morning": "A pure hinge that hammers the hamstrings and spinal erectors — teaches back discipline that pays off in every deadlift.",
    "kettlebell-swing": "Explosive hip power plus conditioning in one move — the hinge pattern at speed, and a brutal heart-rate spike in 30 seconds.",
    "step-up": "Climbing strength, one leg at a time — simple, joint-friendly, and honest about which leg is doing the work.",
    "incline-bench-press": "Targets the upper chest and front delts that flat pressing underserves — the fix for a bench that's strong but a chest that's bottom-heavy.",
    "incline-db-press": "Upper-chest work with each arm honest and a friendlier shoulder path than the barbell — the incline for most people, most of the time.",
    "machine-chest-press": "Pressing volume with the stability handled for you — push close to failure safely without a spotter.",
    "pec-deck": "Pure chest isolation through a controlled arc — constant tension the pressing lifts can't give.",
    "cable-crossover": "Chest work with tension where presses have none — at the squeeze — and endlessly adjustable angles.",
    "db-shoulder-press": "Overhead strength with each shoulder working alone on its natural path — the dumbbell answer to pressing imbalances.",
    "lateral-raise": "The only lift that directly builds shoulder width — light, strict and high-rep is the whole game.",
    "dips": "Bodyweight pressing at its best — chest and triceps through a deep range, and strength that scales with you.",
    "push-up": "The everywhere exercise: pressing, plank and shoulder-blade control in one move, infinitely scalable and free.",
    "close-grip-bench": "The heaviest triceps work you can do — narrows the bench to shift the load where lockout strength lives.",
    "triceps-pushdown": "Elbow-friendly triceps volume with constant cable tension — the staple finisher for arm size.",
    "overhead-triceps-extension": "Trains the triceps' long head at full stretch — the part pressing never quite reaches, and where most arm growth hides.",
    "skullcrusher": "The classic mass-builder for the back of the arm — big stretch, big load, elbows doing exactly one job.",
    "pull-up": "The upper-body benchmark: moving your own body through space builds a back, biceps and grip nothing else quite matches.",
    "chin-up": "The pull-up's biceps-forward sibling — usually a rep or two stronger, and the fastest route to your first strict rep.",
    "barbell-row": "The heaviest horizontal pull there is — back thickness, rear delts and a hinge hold, all in one bar.",
    "db-row": "One arm, full support, zero excuses — a huge range of motion and a back that grows evenly side to side.",
    "straight-arm-pulldown": "Isolates the lats without the arms helping — teaches you to feel the muscle every other pull depends on.",
    "rear-delt-fly": "Direct work for the small muscles that hold your shoulders back — posture insurance measured in grams, not kilos.",
    "shrug": "Direct trap work for the top of the back — simple, heavy, and great for grip while it's there.",
    "barbell-curl": "The heaviest straight-bar biceps work — arms grow from progressive load like everything else.",
    "db-curl": "Biceps with a full twist — the supinating curl trains the muscle's actual function through its whole range.",
    "hammer-curl": "The neutral grip hits the brachialis and forearms — thicker arms and a stronger grip from one small change.",
    "cable-curl": "Constant tension top to bottom — the curl with no resting point, ideal for finishing sets.",
    "crunch": "The simple, honest ab flexion move — short range, full control, no equipment.",
    "russian-twist": "Adds rotation to trunk training — the plane sport and life actually happen in.",
    "ab-wheel": "The hardest anti-extension exercise most people can access — a plank that fights back, and abs that hold under load.",
    "side-plank": "Trains the obliques and lateral hip as stabilisers — the quiet muscles that keep hips level every time you stand on one leg.",
    "dead-bug": "Core control at its purest: keep the spine still while the limbs move — the pattern every heavy lift borrows.",
    "quad-hip-flexor-stretch": "Opens the front of hips that shorten with sitting — better squat depth and a happier lower back.",
    "hamstring-stretch": "Keeps the hinge honest — hamstrings with room to lengthen protect the back when the bar gets heavy.",
    "ninety-ninety-hip": "Rotational hip mobility both directions at once — squats, lunges and life all borrow from it.",
    "walk-easy": "The most underrated recovery tool: easy movement clears the legs and settles the heart rate after work is done.",
    "chest-doorway-stretch": "Undoes pressing and desk hours — opens the chest so the shoulders can sit back where pulling work needs them.",
}


GYM_ITEMS = [
    "Barbell + power rack", "Bench", "Dumbbells", "Cable stack", "Leg press", "Pull-up bar",
    "Leg curl machine", "Leg extension machine", "Calf raise machine",
    "Chest press machine", "Pec deck", "Dip station", "Ab wheel",
]
HOME_ITEMS = ["Dumbbells", "Bench", "Pull-up bar", "Resistance bands"]


def _lower_a(main_kg: float, scale: float) -> dict:
    s = lambda x: round(x * scale / 2.5) * 2.5
    return {
        "name": "Lower A", "kind": "strength", "focus": ["Quads", "Hams", "Core"],
        "exercises": [
            {"slug": "back-squat", "sets": 3, "reps": 5, "weight": main_kg, "rest": 120, "priority": 1, "min_sets": 3},
            {"slug": "romanian-deadlift", "sets": 3, "reps": 8, "weight": s(70), "rest": 90, "priority": 2, "min_sets": 2},
            {"slug": "split-squat", "sets": 3, "reps": 10, "weight": s(20), "rest": 75, "priority": 3, "min_sets": 0},
            {"slug": "hanging-leg-raise", "sets": 3, "reps": 12, "weight": 0, "rest": 60, "priority": 4, "min_sets": 0},
        ],
        "cooldown": [
            {"slug": "quad-hip-flexor-stretch", "hold": "45 s each side"},
            {"slug": "hamstring-stretch", "hold": "45 s each side"},
            {"slug": "ninety-ninety-hip", "hold": "60 s slow"},
            {"slug": "walk-easy", "hold": "2 min easy"},
        ],
    }


def _upper_a(bench_kg: float, scale: float) -> dict:
    s = lambda x: round(x * scale / 2.5) * 2.5
    return {
        "name": "Upper A", "kind": "strength", "focus": ["Chest", "Back", "Rear delts"],
        "exercises": [
            {"slug": "bench-press", "sets": 3, "reps": 8, "weight": bench_kg, "rest": 120, "priority": 1, "min_sets": 3},
            {"slug": "seated-row", "sets": 3, "reps": 10, "weight": s(60), "rest": 90, "priority": 2, "min_sets": 2},
            {"slug": "landmine-press", "sets": 3, "reps": 10, "weight": s(30), "rest": 75, "priority": 3, "min_sets": 0},
            {"slug": "face-pull", "sets": 3, "reps": 15, "weight": s(20), "rest": 60, "priority": 4, "min_sets": 0},
        ],
        "cooldown": [
            {"slug": "chest-doorway-stretch", "hold": "45 s each side"},
            {"slug": "walk-easy", "hold": "2 min easy"},
        ],
    }


def _week(scale: float = 1.0) -> dict:
    return {
        "days": {
            "0": _lower_a(round(60 * scale / 2.5) * 2.5, scale),
            "2": {"name": "Zone 2 run", "kind": "cardio", "focus": ["Aerobic base"],
                  "cardio": {"type": "run", "minutes": 40, "hr_low": 125, "hr_high": 140,
                             "note": "Starts on your Watch — it syncs here automatically"}},
            "4": _upper_a(round(40 * scale / 2.5) * 2.5, scale),
            "5": {"name": "Intervals", "kind": "cardio", "focus": ["VO₂max"],
                  "cardio": {"type": "run", "minutes": 32, "hr_low": 150, "hr_high": 178,
                             "note": "4×4 min hard, 3 min easy — placed away from Monday's squats"}},
        }
    }


def seed_user_defaults(db: Session, u: User, scale: float = 0.6) -> None:
    """Equipment profiles + starter plan for one user. Idempotent; used at boot
    for seeded users and by the admin API when a user is added later."""
    if not db.query(EquipmentProfile).filter(EquipmentProfile.user_id == u.id,
                                             EquipmentProfile.name == "Gym").first():
        gym = EquipmentProfile(user_id=u.id, name="Gym",
                               items=[{"name": n, "available": True} for n in GYM_ITEMS]
                               + [{"name": "Kettlebells", "available": False},
                                  {"name": "Rowing machine", "available": False}],
                               bar_kg=20, plates_kg=[25, 20, 15, 10, 5, 2.5, 1.25], db_max_kg=30)
        db.add(gym)
        db.flush()
        if not u.active_profile_id:
            u.active_profile_id = gym.id
        db.add(EquipmentProfile(user_id=u.id, name="Travel",
                                items=[{"name": "Resistance bands", "available": True},
                                       {"name": "Bodyweight only", "available": True}],
                                bar_kg=0, plates_kg=[], db_max_kg=0))
    if db.query(Plan).filter(Plan.user_id == u.id).count() == 0:
        plan = Plan(user_id=u.id, goal="Get stronger and fitter; build the aerobic base.",
                    status="active")
        db.add(plan)
        db.flush()
        db.add(PlanRevision(plan_id=plan.id, num=1, status="active",
                            content=_week(scale=scale),
                            rationale="Starter week — hand-written baseline before the coach takes over."))


def run_seed(db: Session) -> None:
    settings = get_settings()

    # users + ingest tokens — ALLOWED_USERS is bootstrap only: it seeds an empty
    # table, then the users table is the source of truth (managed in-app by the
    # admin under Settings → Server), so edits there survive restarts.
    if db.query(User).first() is None:
        first = True
        for email, name in settings.allowlist.items():
            user = User(email=email, name=name, role="admin" if first else "member",
                        prefs={"notif_proposal": True, "notif_reminder": True, "notif_film": True})
            db.add(user)
            db.flush()
            db.add(IngestToken(user_id=user.id, token=new_ingest_token()))
            first = False
    db.commit()

    # exercise library — insert any missing entry, so expansions reach existing DBs
    have = {s for (s,) in db.query(Exercise.slug).all()}
    for slug, name, kind, prim, sec, equip, patterns, cues, dont in EXERCISES:
        if slug not in have:
            db.add(Exercise(slug=slug, name=name, kind=kind, primary_muscles=prim,
                            secondary_muscles=sec, equipment=equip, patterns=patterns,
                            cues=cues, dont=dont))
    db.commit()

    # attach curated form media to any entry that has none (idempotent; also
    # upgrades libraries seeded before the media existed)
    for slug in MEDIA_SLUGS:
        ex = db.query(Exercise).filter(Exercise.slug == slug).first()
        if ex and not ex.media_url:
            ex.media_url = _media_url(slug)
            ex.media_tier = "images"
    # backfill "why it's in the library" text
    for ex in db.query(Exercise).all():
        if not ex.benefit and ex.slug in BENEFITS:
            ex.benefit = BENEFITS[ex.slug]
    db.commit()

    users = db.query(User).order_by(User.created_at).all()

    # shared Home equipment profile (user_id NULL — visible to both)
    if not db.query(EquipmentProfile).filter(EquipmentProfile.user_id.is_(None),
                                             EquipmentProfile.name == "Home").first():
        db.add(EquipmentProfile(user_id=None, name="Home",
                                items=[{"name": n, "available": True} for n in HOME_ITEMS],
                                bar_kg=0, plates_kg=[], db_max_kg=24))

    # per-user defaults — also called by the admin API when a user is added later
    for i, u in enumerate(users):
        seed_user_defaults(db, u, scale=1.0 if i == 0 else 0.6)

    # backfill new gym equipment into existing Gym profiles (available by default —
    # toggle off anything the gym actually lacks, in Settings → Equipment)
    for prof in db.query(EquipmentProfile).filter(EquipmentProfile.name == "Gym").all():
        present = {i["name"] for i in (prof.items or [])}
        missing = [n for n in GYM_ITEMS if n not in present]
        if missing:
            prof.items = list(prof.items or []) + [{"name": n, "available": True} for n in missing]
    db.commit()

    # James's standing niggle (kept from intake; clear it in Settings when it's gone)
    james = users[0] if users else None
    if james and db.query(Niggle).filter(Niggle.user_id == james.id).count() == 0:
        db.add(Niggle(user_id=james.id, body_part="Left knee", severity="mild", status="active",
                      note="Grumbles in deep lunges — avoiding that pattern",
                      avoid_patterns=["deep_lunge"], mobility_slug="quad-hip-flexor-stretch"))
        db.commit()

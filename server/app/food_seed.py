"""Nutrition seed (beta track, Phase 7): ingredient macro table, the curated
recipe library, per-user nutrition prefs defaults, and the hand-written first
food week — all idempotent / insert-missing, same contract as `seed.run_seed`.

Recipes follow the HelloFresh card format (structured steps, why-it's-here,
minimal ingredients) around BBC Good Food-style classics, tuned for the
cholesterol trio: protein up, fiber up, sat fat capped. Macros are authored
per serving (hand-checked against USDA-style references), stored canonical.
"""

from sqlalchemy.orm import Session

from .models import Ingredient, MealRevision, Recipe, User

# The cholesterol trio (protein/fiber/satfat) stays the coached core; the rest
# of the label set is tracked and displayed. sugar/satfat/sodium are caps.
DEFAULT_TARGETS = {"kcal": 2300, "protein_g": 160, "carbs_g": 250, "sugar_g": 65,
                   "fiber_g": 38, "fat_g": 80, "satfat_g": 18, "sodium_mg": 2300}
NUTRITION_PREF_DEFAULTS = {
    "nutrition_targets": DEFAULT_TARGETS,
    "cook_nights": 4,
    "budget_grocery": 110,
    "budget_lunch": 15,
    "household_dinners": True,
}

# name, aisle, unit, typical pack, then per-100 (or per-item when unit is 'x'):
# kcal, protein, carbs, sugar, fiber, fat, satfat, sodium (mg), pantry
INGREDIENTS = [
    # produce
    ("chicken thighs, skinless", "protein", "g", "650 g tray", 121, 20, 0, 0, 0, 4.7, 1.1, 95, 0),
    ("chicken breast", "protein", "g", "500 g tray", 106, 22, 0, 0, 0, 1.9, 0.4, 63, 0),
    ("salmon fillets", "protein", "x", "2 × 130 g", 232, 25, 0, 0, 0, 15, 2.6, 50, 0),
    ("cod fillets", "protein", "x", "2 × 140 g", 96, 21, 0, 0, 0, 0.7, 0.1, 70, 0),
    ("prawns, raw", "protein", "g", "300 g bag", 85, 18, 0.2, 0, 0, 0.6, 0.2, 210, 0),
    ("turkey mince 5%", "protein", "g", "500 g pack", 120, 22, 0, 0, 0, 3.5, 0.9, 75, 0),
    ("tuna in spring water", "cupboard", "x", "145 g tin", 116, 26, 0, 0, 0, 0.8, 0.1, 320, 0),
    ("eggs", "protein", "x", "box of 12", 74, 6.5, 0.4, 0.2, 0, 5, 1.1, 70, 0),
    ("greek yogurt 0%", "dairy", "g", "1 kg tub", 57, 10, 3.6, 3.2, 0, 0.2, 0.1, 36, 0),
    ("feta", "dairy", "g", "200 g block", 264, 14, 4.1, 4.1, 0, 21, 10.9, 1100, 0),
    ("halloumi light", "dairy", "g", "225 g block", 255, 24, 2, 1.5, 0, 17, 10.5, 1900, 0),
    ("parmesan", "dairy", "g", "wedge", 392, 32, 3.2, 0.8, 0, 29, 13.7, 1500, 1),
    ("peppers", "produce", "x", "3-pack", 31, 1, 6, 4.2, 2.1, 0.3, 0, 4, 0),
    ("red onions", "produce", "x", "net of 4", 40, 1.1, 9.3, 4.2, 1.7, 0.1, 0, 4, 0),
    ("spinach", "produce", "g", "250 g bag", 23, 2.9, 3.6, 0.4, 2.2, 0.4, 0.1, 79, 0),
    ("long-stem broccoli", "produce", "g", "200 g pack", 35, 3, 7, 1.7, 3, 0.4, 0.1, 33, 0),
    ("spring greens", "produce", "g", "200 g bag", 33, 3, 3.1, 2, 3.4, 0.7, 0.1, 9, 0),
    ("courgettes", "produce", "x", "3-pack", 17, 1.2, 3.1, 2.5, 1, 0.3, 0.1, 8, 0),
    ("cherry tomatoes", "produce", "g", "500 g pack", 18, 0.9, 3.9, 2.6, 1.2, 0.2, 0, 5, 0),
    ("sweet potatoes", "produce", "g", "1 kg bag", 86, 1.6, 20, 4.2, 3, 0.1, 0, 55, 0),
    ("baking potatoes", "produce", "x", "4-pack", 93, 2.5, 21, 1.2, 2.2, 0.1, 0, 6, 0),
    ("lemons", "produce", "x", "3-pack", 29, 1.1, 9.3, 2.5, 2.8, 0.3, 0, 2, 0),
    ("limes", "produce", "x", "3-pack", 30, 0.7, 10.5, 1.7, 2.8, 0.2, 0, 2, 0),
    ("ginger", "produce", "g", "root", 80, 1.8, 18, 1.7, 2, 0.8, 0.1, 13, 0),
    ("garlic", "produce", "x", "bulb", 149, 6.4, 33, 1, 2.1, 0.5, 0.1, 17, 1),
    ("coriander", "produce", "x", "bunch", 23, 2.1, 3.7, 0.9, 2.8, 0.5, 0, 46, 0),
    ("dill", "produce", "x", "pot", 43, 3.5, 7, 0, 2.1, 1.1, 0, 61, 0),
    ("avocado", "produce", "x", "each", 160, 2, 8.5, 0.7, 6.7, 14.7, 2.1, 7, 0),
    ("apples", "produce", "x", "6-pack", 52, 0.3, 14, 10.4, 2.4, 0.2, 0, 1, 0),
    ("berries, mixed", "produce", "g", "400 g punnet", 43, 0.7, 9.6, 4.9, 3.8, 0.5, 0, 1, 0),
    ("bananas", "produce", "x", "bunch", 89, 1.1, 23, 12, 2.6, 0.3, 0.1, 1, 0),
    # cupboard
    ("chickpeas", "cupboard", "x", "400 g tin", 115, 6.3, 16.7, 0.4, 5.4, 2.6, 0.2, 220, 0),
    ("black beans", "cupboard", "x", "400 g tin", 91, 6, 15.4, 0.3, 6.5, 0.5, 0.1, 180, 0),
    ("white beans", "cupboard", "x", "400 g tin", 90, 5.4, 15.5, 0.6, 5.6, 0.6, 0.1, 240, 0),
    ("kidney beans", "cupboard", "x", "400 g tin", 84, 5.2, 14, 0.6, 6.4, 0.5, 0.1, 230, 0),
    ("puy lentils", "cupboard", "g", "250 g pouch", 116, 9, 17, 0.6, 7.9, 0.6, 0.1, 180, 0),
    ("red lentils, dry", "cupboard", "g", "500 g bag", 352, 25, 60, 2, 11, 1.1, 0.2, 7, 1),
    ("chopped tomatoes", "cupboard", "x", "400 g tin", 32, 1.2, 5.5, 4, 1.3, 0.2, 0, 130, 0),
    ("passata", "cupboard", "ml", "500 g carton", 32, 1.4, 6, 4.5, 1.1, 0.2, 0, 160, 0),
    ("harissa paste", "cupboard", "g", "185 g jar", 130, 3, 14, 7, 6, 6.5, 0.6, 1300, 0),
    ("miso paste", "cupboard", "g", "tub", 199, 12, 26, 6.2, 5.4, 6, 0.4, 3700, 1),
    ("olives", "cupboard", "g", "160 g jar", 145, 1, 3.8, 0.5, 3.3, 15, 1.6, 1560, 0),
    ("capers", "cupboard", "g", "jar", 23, 2.4, 4.9, 0.4, 3.2, 0.9, 0.1, 2960, 1),
    ("wholewheat spaghetti", "cupboard", "g", "500 g bag", 348, 13, 62, 2.6, 10, 2.5, 0.3, 6, 0),
    ("soba noodles", "cupboard", "g", "250 g pack", 336, 14, 74, 1, 3, 0.7, 0.1, 790, 0),
    ("brown rice", "cupboard", "g", "1 kg bag", 362, 7.5, 76, 0.9, 3.4, 2.8, 0.5, 5, 1),
    ("bulgur wheat", "cupboard", "g", "500 g bag", 342, 12, 69, 0.4, 12.5, 1.3, 0.2, 17, 1),
    ("gnocchi", "cupboard", "g", "500 g pack", 151, 4, 32, 0.6, 2, 0.4, 0.1, 300, 0),
    ("oats", "cupboard", "g", "1 kg bag", 379, 13, 60, 1, 10, 6.9, 1, 2, 1),
    ("ground flaxseed", "cupboard", "g", "200 g pack", 534, 18, 29, 1.6, 27, 42, 3.2, 30, 1),
    ("almonds", "cupboard", "g", "200 g bag", 579, 21, 22, 4.4, 12.5, 50, 3.8, 1, 1),
    ("peanut butter", "cupboard", "g", "340 g jar", 588, 25, 20, 9, 6, 50, 9.5, 430, 1),
    ("olive oil", "cupboard", "ml", "bottle", 884, 0, 0, 0, 0, 100, 13.8, 0, 1),
    ("soy sauce, reduced salt", "cupboard", "ml", "bottle", 53, 8, 8, 1, 0.8, 0.1, 0, 3300, 1),
    ("wholegrain bread", "cupboard", "x", "loaf, per slice", 90, 4, 15, 2, 2.5, 1.5, 0.2, 180, 0),
    ("smoked paprika", "cupboard", "g", "jar", 282, 14, 54, 10, 35, 13, 0.9, 68, 1),
    ("cumin", "cupboard", "g", "jar", 375, 18, 44, 2.3, 10.5, 22, 1.5, 168, 1),
    ("chilli flakes", "cupboard", "g", "jar", 282, 12, 50, 10, 27, 14, 1, 30, 1),
]

# Every dinner: HelloFresh-card structure — why-it's-here, quantified ingredients
# joined to INGREDIENTS by name, and done-when steps (timer=True → cook-mode ring).
RECIPES: list[dict] = [
    # ---- dinners ----
    dict(
        slug="harissa-chicken-traybake", name="Harissa chicken traybake", kind="dinner",
        minutes=25, difficulty="easy", serves=2, batch=2, platefig="tray-chicken",
        kcal=520, protein_g=42, carbs_g=38, sugar_g=10, fiber_g=11,
        fat_g=16, satfat_g=4.5, sodium_mg=620,
        why="Your highest-protein traybake; chickpeas carry the fiber. Low sat fat banks headroom for a night out. Doubles into a zero-cook night — one cook, two dinners.",
        tags=["traybake", "batch", "high-fiber"],
        ingredients=[
            {"name": "chicken thighs, skinless", "qty": 900, "unit": "g", "disp": "900 g"},
            {"name": "chickpeas", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "peppers", "qty": 3, "unit": "x", "disp": "3"},
            {"name": "red onions", "qty": 2, "unit": "x", "disp": "2"},
            {"name": "harissa paste", "qty": 30, "unit": "g", "disp": "2 tbsp"},
            {"name": "spinach", "qty": 125, "unit": "g", "disp": "½ bag"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "olive oil", "qty": 15, "unit": "ml", "disp": "1 tbsp", "note": "pantry"},
            {"name": "cumin", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Prep", "minutes": 5, "detail": "Oven to 220° fan. Pat the thighs dry — dry meat browns, wet meat steams. Peppers into strips, onions into wedges, chickpeas drained well."},
            {"title": "Dress", "minutes": 2, "detail": "Everything into the tray with harissa, oil, cumin and half the lemon. Toss until slicked; thighs on top so they roast, not stew."},
            {"title": "Roast", "minutes": 22, "timer": True, "detail": "Done when thighs read 74° / juices run clear and the chickpeas just blister. No turning — let the edges char."},
            {"title": "Finish", "minutes": 1, "detail": "Off the heat: fold the spinach through the hot chickpeas to wilt, squeeze the rest of the lemon over."},
            {"title": "Box & plate", "minutes": 1, "detail": "Half into the box before plating — portion now, no willpower needed on leftover night."},
        ],
    ),
    dict(
        slug="salmon-puy-lentils", name="Charred salmon, puy lentils & broccoli", kind="dinner",
        minutes=20, difficulty="easy", serves=2, platefig="plate-salmon",
        kcal=540, protein_g=38, carbs_g=30, sugar_g=3, fiber_g=9,
        fat_g=24, satfat_g=3.5, sodium_mg=480,
        why="The omega-3 day — salmon fat is the kind your lipid panel likes. Lentils carry the fiber under it.",
        tags=["fish", "omega-3", "quick"],
        ingredients=[
            {"name": "salmon fillets", "qty": 2, "unit": "x", "disp": "2 fillets"},
            {"name": "puy lentils", "qty": 250, "unit": "g", "disp": "1 pouch"},
            {"name": "long-stem broccoli", "qty": 200, "unit": "g", "disp": "200 g"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "garlic", "qty": 2, "unit": "x", "disp": "2 cloves", "note": "pantry"},
            {"name": "olive oil", "qty": 10, "unit": "ml", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Sear", "minutes": 4, "timer": True, "detail": "Hot pan, skin-side down, don't touch it. Done when the skin releases without a fight and the sides look cooked a third of the way up."},
            {"title": "Steam", "minutes": 5, "detail": "Broccoli into a steamer (or the same pan with a splash of water and a lid). Bright green and just tender — a knife should meet slight resistance."},
            {"title": "Warm the lentils", "minutes": 3, "detail": "Pouch into the pan with garlic and a little oil. Warm through, season, lemon juice in."},
            {"title": "Flip & finish", "minutes": 3, "detail": "Salmon flipped for its last two minutes — done when it flakes at the thickest part but still looks juicy, not chalky."},
        ],
    ),
    dict(
        slug="turkey-black-bean-chili", name="Turkey & black-bean chili", kind="dinner",
        minutes=35, difficulty="medium", serves=2, batch=2, platefig="bowl-chili",
        kcal=480, protein_g=45, carbs_g=46, sugar_g=11, fiber_g=13,
        fat_g=10, satfat_g=3, sodium_mg=680,
        why="Fiber engine of the week — two kinds of bean, 5% turkey keeps the sat fat down. The batch feeds a lunch.",
        tags=["batch", "high-fiber", "freezes"],
        ingredients=[
            {"name": "turkey mince 5%", "qty": 500, "unit": "g", "disp": "500 g"},
            {"name": "black beans", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "kidney beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "chopped tomatoes", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "red onions", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "bulgur wheat", "qty": 120, "unit": "g", "disp": "120 g", "note": "pantry"},
            {"name": "coriander", "qty": 1, "unit": "x", "disp": "½ bunch"},
            {"name": "smoked paprika", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
            {"name": "cumin", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
            {"name": "chilli flakes", "qty": 2, "unit": "g", "disp": "1 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Brown", "minutes": 6, "detail": "Turkey into a hot, barely-oiled pot. Leave it to catch before breaking it up — the browned bits are the flavour. Onion in for the last two minutes."},
            {"title": "Spice", "minutes": 1, "detail": "Paprika, cumin, chilli flakes straight onto the meat. Thirty seconds — fragrant, not burnt."},
            {"title": "Simmer", "minutes": 25, "timer": True, "detail": "Tomatoes, both beans, half a tin of water. Lid half-on. Done when it's thick enough that a spoon dragged through leaves a trail."},
            {"title": "Bulgur", "minutes": 12, "detail": "Meanwhile: bulgur in double its volume of boiling water, lid on, off the heat. It cooks itself while the chili simmers."},
            {"title": "Box & bowl", "minutes": 1, "detail": "Two portions into the lunch box before serving. Coriander over the bowls."},
        ],
    ),
    dict(
        slug="prawn-soba-stirfry", name="Prawn & soba stir-fry", kind="dinner",
        minutes=15, difficulty="easy", serves=2, platefig="bowl-soba",
        kcal=430, protein_g=34, carbs_g=52, sugar_g=4, fiber_g=7,
        fat_g=8, satfat_g=1.5, sodium_mg=1150,
        why="The fastest dinner in the pool — prawns are nearly pure protein, and the whole thing has less sat fat than a latte.",
        tags=["quick", "low-satfat"],
        ingredients=[
            {"name": "prawns, raw", "qty": 300, "unit": "g", "disp": "300 g"},
            {"name": "soba noodles", "qty": 150, "unit": "g", "disp": "150 g"},
            {"name": "spring greens", "qty": 100, "unit": "g", "disp": "½ bag"},
            {"name": "ginger", "qty": 20, "unit": "g", "disp": "thumb"},
            {"name": "garlic", "qty": 2, "unit": "x", "disp": "2 cloves", "note": "pantry"},
            {"name": "soy sauce, reduced salt", "qty": 30, "unit": "ml", "disp": "2 tbsp", "note": "pantry"},
            {"name": "limes", "qty": 1, "unit": "x", "disp": "1"},
        ],
        steps=[
            {"title": "Noodles", "minutes": 4, "timer": True, "detail": "Soba into boiling water. Done a minute early — they finish in the pan. Rinse cold so they don't clump."},
            {"title": "Flash the aromatics", "minutes": 1, "detail": "Screaming-hot wok, ginger and garlic for thirty seconds — moving constantly, golden not brown."},
            {"title": "Prawns", "minutes": 3, "detail": "In with the prawns and greens. Done when every prawn has curled into a loose C and gone pink through — a tight C is overdone."},
            {"title": "Toss", "minutes": 2, "detail": "Noodles back in with soy and lime. One minute of proper tossing so every strand is coated."},
        ],
    ),
    dict(
        slug="baked-cod-white-bean-stew", name="Baked cod on white bean stew", kind="dinner",
        minutes=30, difficulty="easy", serves=2, platefig="bowl-stew",
        kcal=420, protein_g=40, carbs_g=36, sugar_g=8, fiber_g=12,
        fat_g=8, satfat_g=2, sodium_mg=740,
        why="Sunday-calm cooking. Cod is the leanest fish in the pool and the beans do the fiber work — a soft landing for the week's sat-fat average.",
        tags=["fish", "high-fiber", "one-pan"],
        ingredients=[
            {"name": "cod fillets", "qty": 2, "unit": "x", "disp": "2 fillets"},
            {"name": "white beans", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "cherry tomatoes", "qty": 250, "unit": "g", "disp": "250 g"},
            {"name": "harissa paste", "qty": 15, "unit": "g", "disp": "1 tbsp"},
            {"name": "spring greens", "qty": 100, "unit": "g", "disp": "½ bag"},
            {"name": "garlic", "qty": 2, "unit": "x", "disp": "2 cloves", "note": "pantry"},
            {"name": "olive oil", "qty": 10, "unit": "ml", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Start the stew", "minutes": 8, "detail": "Garlic in oil until fragrant, tomatoes in until they start to burst and slump. Harissa through — this finishes the jar."},
            {"title": "Beans in", "minutes": 5, "detail": "Both tins, half drained. Simmer until it looks like a stew, not a soup. Greens folded in to wilt."},
            {"title": "Bake the cod", "minutes": 12, "timer": True, "detail": "Fillets on top of the stew, lid or foil on, into a 200° oven. Done when the flakes separate at a nudge and the middle is opaque."},
        ],
    ),
    dict(
        slug="one-pan-chicken-puttanesca", name="One-pan chicken puttanesca", kind="dinner",
        minutes=30, difficulty="easy", serves=2, platefig="plate-chicken",
        kcal=495, protein_g=44, carbs_g=28, sugar_g=10, fiber_g=9,
        fat_g=18, satfat_g=3.8, sodium_mg=1040,
        why="Olives and capers bring the salt-and-punch a lean chicken dinner usually lacks — and a surprising fiber nudge.",
        tags=["one-pan"],
        ingredients=[
            {"name": "chicken thighs, skinless", "qty": 600, "unit": "g", "disp": "600 g"},
            {"name": "chopped tomatoes", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "olives", "qty": 80, "unit": "g", "disp": "½ jar"},
            {"name": "capers", "qty": 20, "unit": "g", "disp": "1 tbsp", "note": "pantry"},
            {"name": "white beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "garlic", "qty": 3, "unit": "x", "disp": "3 cloves", "note": "pantry"},
            {"name": "chilli flakes", "qty": 1, "unit": "g", "disp": "½ tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Brown the thighs", "minutes": 6, "detail": "Hot pan, thighs seasoned and left alone until deeply golden on one side. They finish cooking in the sauce — colour is the point here."},
            {"title": "Build the sauce", "minutes": 3, "detail": "Garlic and chilli into the same pan, then tomatoes, olives, capers and the beans. Scrape the bottom — that's flavour, not mess."},
            {"title": "Simmer", "minutes": 18, "timer": True, "detail": "Thighs back in, half-covered. Done when the sauce has thickened to coat a spoon and the chicken pulls apart easily."},
        ],
    ),
    dict(
        slug="turkey-meatball-spaghetti", name="Turkey meatballs & wholewheat spaghetti", kind="dinner",
        minutes=30, difficulty="medium", serves=2, batch=2, platefig="bowl-pasta",
        kcal=560, protein_g=42, carbs_g=62, sugar_g=12, fiber_g=10,
        fat_g=12, satfat_g=4, sodium_mg=640,
        why="Comfort food that behaves: 5% turkey and wholewheat pasta hold the line on sat fat and fiber where beef and white pasta wouldn't.",
        tags=["batch", "comfort"],
        ingredients=[
            {"name": "turkey mince 5%", "qty": 500, "unit": "g", "disp": "500 g"},
            {"name": "wholewheat spaghetti", "qty": 160, "unit": "g", "disp": "160 g"},
            {"name": "passata", "qty": 500, "unit": "ml", "disp": "1 carton"},
            {"name": "red onions", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "garlic", "qty": 2, "unit": "x", "disp": "2 cloves", "note": "pantry"},
            {"name": "parmesan", "qty": 20, "unit": "g", "disp": "20 g", "note": "pantry"},
            {"name": "eggs", "qty": 1, "unit": "x", "disp": "1"},
        ],
        steps=[
            {"title": "Roll", "minutes": 6, "detail": "Turkey, egg, grated onion, half the parmesan, pepper. Wet hands, 12 balls — don't overwork them or they bounce."},
            {"title": "Brown", "minutes": 5, "detail": "A film of oil, meatballs turned until golden on two sides. They finish in the sauce — don't cook them through yet."},
            {"title": "Simmer", "minutes": 15, "timer": True, "detail": "Passata and garlic in, balls half-submerged, lid ajar. Done when a ball cut in half shows no pink."},
            {"title": "Pasta", "minutes": 10, "detail": "Spaghetti in well-salted water, one minute short of the packet. Into the sauce with a splash of pasta water; toss until glossy."},
        ],
    ),
    dict(
        slug="miso-salmon-greens", name="Miso salmon, greens & brown rice", kind="dinner",
        minutes=20, difficulty="easy", serves=2, platefig="plate-salmon",
        kcal=530, protein_g=36, carbs_g=48, sugar_g=3, fiber_g=6,
        fat_g=20, satfat_g=3, sodium_mg=1010,
        why="Second oily-fish night, different costume. Miso does the marinade's work in ten minutes flat.",
        tags=["fish", "omega-3", "quick"],
        ingredients=[
            {"name": "salmon fillets", "qty": 2, "unit": "x", "disp": "2 fillets"},
            {"name": "miso paste", "qty": 25, "unit": "g", "disp": "1½ tbsp", "note": "pantry"},
            {"name": "brown rice", "qty": 140, "unit": "g", "disp": "140 g", "note": "pantry"},
            {"name": "spring greens", "qty": 100, "unit": "g", "disp": "½ bag"},
            {"name": "ginger", "qty": 15, "unit": "g", "disp": "½ thumb"},
            {"name": "soy sauce, reduced salt", "qty": 15, "unit": "ml", "disp": "1 tbsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Rice on", "minutes": 2, "detail": "Brown rice into plenty of boiling water — it takes 25 minutes and needs nothing from you."},
            {"title": "Glaze", "minutes": 2, "detail": "Miso, soy and grated ginger loosened with a splash of water. Brush thickly over the fillets."},
            {"title": "Grill", "minutes": 9, "timer": True, "detail": "Salmon under a hot grill. Done when the glaze has caught in spots and the flakes just separate — the char is the flavour, black is not."},
            {"title": "Greens", "minutes": 3, "detail": "Steam or flash-fry with the leftover glaze. Bright and barely tender."},
        ],
    ),
    dict(
        slug="chicken-fajita-bowl", name="Chicken fajita bowl", kind="dinner",
        minutes=25, difficulty="easy", serves=2, platefig="bowl-grain",
        kcal=510, protein_g=43, carbs_g=48, sugar_g=8, fiber_g=11,
        fat_g=13, satfat_g=3.5, sodium_mg=420,
        why="Everything a fajita night promises with the tortilla-and-cheese tax refunded into beans and avocado.",
        tags=["bowl", "high-fiber"],
        ingredients=[
            {"name": "chicken breast", "qty": 400, "unit": "g", "disp": "400 g"},
            {"name": "peppers", "qty": 2, "unit": "x", "disp": "2"},
            {"name": "red onions", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "black beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "brown rice", "qty": 140, "unit": "g", "disp": "140 g", "note": "pantry"},
            {"name": "avocado", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "limes", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "smoked paprika", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Rice on", "minutes": 2, "detail": "Brown rice into boiling water — 25 minutes, no attention needed."},
            {"title": "Char the veg", "minutes": 6, "detail": "Peppers and onion in a dry, very hot pan until blistered at the edges. Out and set aside."},
            {"title": "Chicken", "minutes": 7, "timer": True, "detail": "Sliced breast tossed in paprika, into the same pan. Done when no piece shows pink at its thickest cut and the edges have caught."},
            {"title": "Assemble", "minutes": 3, "detail": "Rice, beans warmed in the pan, veg, chicken, avocado. Lime over everything — it replaces the sour cream, honestly."},
        ],
    ),
    dict(
        slug="lentil-spinach-dal", name="Red lentil & spinach dal", kind="dinner",
        minutes=30, difficulty="easy", serves=2, batch=2, platefig="bowl-stew",
        kcal=440, protein_g=22, carbs_g=60, sugar_g=8, fiber_g=16,
        fat_g=10, satfat_g=2.5, sodium_mg=380,
        why="The meat-free night that out-fibers everything else in the pool. Freezes perfectly — the batch is insurance.",
        tags=["veggie", "batch", "high-fiber", "freezes"],
        ingredients=[
            {"name": "red lentils, dry", "qty": 200, "unit": "g", "disp": "200 g", "note": "pantry"},
            {"name": "spinach", "qty": 125, "unit": "g", "disp": "½ bag"},
            {"name": "chopped tomatoes", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "red onions", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "ginger", "qty": 20, "unit": "g", "disp": "thumb"},
            {"name": "garlic", "qty": 3, "unit": "x", "disp": "3 cloves", "note": "pantry"},
            {"name": "cumin", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
            {"name": "chilli flakes", "qty": 2, "unit": "g", "disp": "1 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Soften", "minutes": 5, "detail": "Onion in a little oil until translucent; garlic, ginger, cumin and chilli in for the last minute — fragrant, not coloured."},
            {"title": "Simmer", "minutes": 22, "timer": True, "detail": "Lentils, tomatoes, 600 ml water. Done when the lentils have collapsed into a porridge that plops rather than bubbles — stir the bottom occasionally."},
            {"title": "Finish", "minutes": 2, "detail": "Spinach folded through to wilt, salt to taste, squeeze of lemon if it needs lifting. Box the batch."},
        ],
    ),
    dict(
        slug="tuna-white-bean-salad", name="Warm tuna & white bean salad", kind="dinner",
        minutes=10, difficulty="easy", serves=2, platefig="plate-salad",
        kcal=400, protein_g=38, carbs_g=30, sugar_g=6, fiber_g=10,
        fat_g=12, satfat_g=2, sodium_mg=780,
        why="The break-glass dinner: ten minutes, one pan, mostly cupboard. Keeps a tired Thursday from becoming a takeaway.",
        tags=["quick", "storecupboard"],
        ingredients=[
            {"name": "tuna in spring water", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "white beans", "qty": 2, "unit": "x", "disp": "2 tins"},
            {"name": "cherry tomatoes", "qty": 250, "unit": "g", "disp": "250 g"},
            {"name": "red onions", "qty": 1, "unit": "x", "disp": "½, sliced thin"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "olive oil", "qty": 15, "unit": "ml", "disp": "1 tbsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Warm the beans", "minutes": 4, "detail": "Beans with a little oil until just heated — warm beans drink the dressing, cold ones shrug it off."},
            {"title": "Assemble", "minutes": 4, "detail": "Tomatoes halved, onion sliced paper-thin, tuna forked through in big flakes. Lemon and oil over; season harder than feels right."},
        ],
    ),
    dict(
        slug="sweet-potato-turkey-skillet", name="Sweet potato & turkey skillet", kind="dinner",
        minutes=25, difficulty="easy", serves=2, platefig="pan-skillet",
        kcal=500, protein_g=40, carbs_g=50, sugar_g=10, fiber_g=9,
        fat_g=12, satfat_g=3.5, sodium_mg=340,
        why="One pan, no drama: lean turkey and sweet potato make a heavier-feeling dinner than its sat-fat number admits.",
        tags=["one-pan"],
        ingredients=[
            {"name": "turkey mince 5%", "qty": 500, "unit": "g", "disp": "500 g"},
            {"name": "sweet potatoes", "qty": 500, "unit": "g", "disp": "500 g"},
            {"name": "peppers", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "spinach", "qty": 125, "unit": "g", "disp": "½ bag"},
            {"name": "smoked paprika", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
            {"name": "garlic", "qty": 2, "unit": "x", "disp": "2 cloves", "note": "pantry"},
        ],
        steps=[
            {"title": "Potatoes first", "minutes": 10, "timer": True, "detail": "Sweet potato in small dice, into the skillet with oil and a lid. Done when a fork slides in — shake the pan halfway."},
            {"title": "Turkey", "minutes": 7, "detail": "Push potatoes aside, brown the turkey properly, then garlic, paprika and the pepper. Mix it all together."},
            {"title": "Wilt & serve", "minutes": 2, "detail": "Spinach folded through off the heat. Straight from the pan — it's that kind of dinner."},
        ],
    ),
    dict(
        slug="chicken-gnocchi-tray", name="Crispy gnocchi & chicken traybake", kind="dinner",
        minutes=25, difficulty="easy", serves=2, platefig="tray-chicken",
        kcal=540, protein_g=41, carbs_g=58, sugar_g=6, fiber_g=7,
        fat_g=14, satfat_g=5, sodium_mg=820,
        why="Gnocchi roast into crispy little pillows — the treat-feeling dinner that still fits the caps.",
        tags=["traybake", "crowd-pleaser"],
        ingredients=[
            {"name": "chicken thighs, skinless", "qty": 600, "unit": "g", "disp": "600 g"},
            {"name": "gnocchi", "qty": 500, "unit": "g", "disp": "1 pack"},
            {"name": "cherry tomatoes", "qty": 250, "unit": "g", "disp": "250 g"},
            {"name": "courgettes", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "parmesan", "qty": 15, "unit": "g", "disp": "15 g", "note": "pantry"},
            {"name": "olive oil", "qty": 15, "unit": "ml", "disp": "1 tbsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Everything in", "minutes": 5, "detail": "220° fan. Gnocchi straight from the pack (no boiling), chicken, tomatoes, courgette half-moons — tossed in oil on the tray, chicken on top."},
            {"title": "Roast", "minutes": 20, "timer": True, "detail": "Done when the gnocchi are golden and crisp-edged and the chicken reads 74°. Shake the tray once at half time."},
            {"title": "Finish", "minutes": 1, "detail": "Parmesan grated thinly over the hot tray — it's seasoning, not a blanket."},
        ],
    ),
    dict(
        slug="garlic-prawn-spaghetti", name="Garlic prawn & courgette spaghetti", kind="dinner",
        minutes=20, difficulty="easy", serves=2, platefig="bowl-pasta",
        kcal=470, protein_g=36, carbs_g=58, sugar_g=5, fiber_g=8,
        fat_g=10, satfat_g=2.5, sodium_mg=620,
        why="A card-box classic rebuilt: wholewheat pasta and double courgette where the cream used to be.",
        tags=["quick", "card-box-style"],
        ingredients=[
            {"name": "prawns, raw", "qty": 300, "unit": "g", "disp": "300 g"},
            {"name": "wholewheat spaghetti", "qty": 160, "unit": "g", "disp": "160 g"},
            {"name": "courgettes", "qty": 2, "unit": "x", "disp": "2"},
            {"name": "garlic", "qty": 3, "unit": "x", "disp": "3 cloves", "note": "pantry"},
            {"name": "chilli flakes", "qty": 1, "unit": "g", "disp": "½ tsp", "note": "pantry"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "1"},
        ],
        steps=[
            {"title": "Pasta on", "minutes": 10, "timer": True, "detail": "Wholewheat spaghetti takes a couple of minutes longer than white — start it before anything else. Save a mug of pasta water."},
            {"title": "Courgettes", "minutes": 5, "detail": "Coarsely grated, into a hot oiled pan until the water cooks off and they start to catch. This is the 'sauce'."},
            {"title": "Prawns", "minutes": 3, "detail": "Garlic and chilli in for thirty seconds, then prawns — done at a loose pink C."},
            {"title": "Toss", "minutes": 2, "detail": "Pasta in with a splash of its water and the lemon. Toss until it looks creamy — that's the starch, not cream."},
        ],
    ),
    dict(
        slug="peri-chicken-rice-greens", name="Peri-peri chicken, rice & greens", kind="dinner",
        minutes=30, difficulty="easy", serves=2, platefig="plate-chicken",
        kcal=520, protein_g=45, carbs_g=50, sugar_g=4, fiber_g=8,
        fat_g=12, satfat_g=3.5, sodium_mg=560,
        why="The Friday-night-out flavour, cooked in. Thighs stay juicy at a fraction of the restaurant's oil.",
        tags=["crowd-pleaser"],
        ingredients=[
            {"name": "chicken thighs, skinless", "qty": 600, "unit": "g", "disp": "600 g"},
            {"name": "brown rice", "qty": 140, "unit": "g", "disp": "140 g", "note": "pantry"},
            {"name": "spring greens", "qty": 100, "unit": "g", "disp": "½ bag"},
            {"name": "harissa paste", "qty": 20, "unit": "g", "disp": "4 tsp"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "smoked paprika", "qty": 2, "unit": "g", "disp": "1 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Marinate fast", "minutes": 3, "detail": "Harissa, paprika, lemon juice massaged into the thighs. Even ten minutes while the rice starts is enough."},
            {"title": "Rice on", "minutes": 2, "detail": "Brown rice into boiling water — 25 minutes."},
            {"title": "Grill", "minutes": 16, "timer": True, "detail": "Thighs under a hot grill, turned once. Done at 74° with charred edges — the marinade should look baked on, not wet."},
            {"title": "Greens", "minutes": 3, "detail": "Shredded, flashed in the pan with a squeeze of lemon."},
        ],
    ),
    dict(
        slug="veggie-chilli-baked-potato", name="Veggie chilli baked potatoes", kind="dinner",
        minutes=35, difficulty="easy", serves=2, batch=2, platefig="bowl-chili",
        kcal=450, protein_g=20, carbs_g=78, sugar_g=11, fiber_g=17,
        fat_g=6, satfat_g=2, sodium_mg=560,
        why="The other meat-free night — seventeen grams of fiber, most of the week's target in one bowl. Yogurt plays the sour cream.",
        tags=["veggie", "batch", "high-fiber"],
        ingredients=[
            {"name": "baking potatoes", "qty": 2, "unit": "x", "disp": "2 large"},
            {"name": "black beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "kidney beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "chopped tomatoes", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "peppers", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "greek yogurt 0%", "qty": 80, "unit": "g", "disp": "4 tbsp"},
            {"name": "cumin", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
            {"name": "smoked paprika", "qty": 4, "unit": "g", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[
            {"title": "Potatoes in", "minutes": 2, "detail": "Pricked, oiled, salted, straight onto the oven shelf at 220°. They need ~45 minutes — microwave 8 minutes first to halve that."},
            {"title": "Chilli", "minutes": 20, "timer": True, "detail": "Pepper softened, spices bloomed, beans and tomatoes in. Done when thick enough to sit on a potato without running off."},
            {"title": "Load", "minutes": 2, "detail": "Potatoes split and crushed open, chilli over, cold yogurt on the hot chilli. Box the spare chilli."},
        ],
    ),
    # ---- breakfasts (templates — planned daily, one-tap) ----
    dict(
        slug="oats-no1", name="Oats №1 — overnight oats, berries & flax", kind="breakfast",
        minutes=5, difficulty="easy", serves=1, platefig="bowl-oats",
        kcal=420, protein_g=34, carbs_g=52, sugar_g=8, fiber_g=11,
        fat_g=9, satfat_g=2, sodium_mg=65,
        why="The fiber head-start: oats and flax are the two best breakfast levers a lipid panel has.",
        tags=["template", "high-fiber"],
        ingredients=[
            {"name": "oats", "qty": 60, "unit": "g", "disp": "60 g", "note": "pantry"},
            {"name": "ground flaxseed", "qty": 15, "unit": "g", "disp": "1 tbsp", "note": "pantry"},
            {"name": "greek yogurt 0%", "qty": 200, "unit": "g", "disp": "200 g"},
            {"name": "berries, mixed", "qty": 80, "unit": "g", "disp": "80 g"},
        ],
        steps=[
            {"title": "Night before", "minutes": 2, "detail": "Oats, flax and yogurt stirred with a splash of milk or water in a jar. Fridge."},
            {"title": "Morning", "minutes": 1, "detail": "Berries on top. Done — that was the point."},
        ],
    ),
    dict(
        slug="yogurt-berry-bowl", name="Greek yogurt & berry bowl", kind="breakfast",
        minutes=3, difficulty="easy", serves=1, platefig="bowl-oats",
        kcal=320, protein_g=28, carbs_g=34, sugar_g=12, fiber_g=6,
        fat_g=8, satfat_g=1, sodium_mg=55,
        why="The lighter morning — most of the protein, none of the prep.",
        tags=["template", "quick"],
        ingredients=[
            {"name": "greek yogurt 0%", "qty": 250, "unit": "g", "disp": "250 g"},
            {"name": "berries, mixed", "qty": 100, "unit": "g", "disp": "100 g"},
            {"name": "almonds", "qty": 15, "unit": "g", "disp": "small handful", "note": "pantry"},
            {"name": "ground flaxseed", "qty": 10, "unit": "g", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[{"title": "Assemble", "minutes": 3, "detail": "Yogurt, berries, almonds, flax. A drizzle of honey if it's been that kind of week."}],
    ),
    dict(
        slug="eggs-spinach-toast", name="Eggs, spinach & wholegrain toast", kind="breakfast",
        minutes=10, difficulty="easy", serves=1, platefig="plate-eggs",
        kcal=380, protein_g=24, carbs_g=30, sugar_g=3, fiber_g=6,
        fat_g=17, satfat_g=3.5, sodium_mg=500,
        why="The weekend one. Eggs' cholesterol matters far less than the sausage and butter that usually flank them — so they arrive with spinach instead.",
        tags=["template", "weekend"],
        ingredients=[
            {"name": "eggs", "qty": 2, "unit": "x", "disp": "2"},
            {"name": "spinach", "qty": 60, "unit": "g", "disp": "2 handfuls"},
            {"name": "wholegrain bread", "qty": 2, "unit": "x", "disp": "2 slices"},
        ],
        steps=[
            {"title": "Spinach", "minutes": 2, "detail": "Wilted in the dry pan first, squeezed of its water, set on the toast."},
            {"title": "Eggs", "minutes": 4, "detail": "However you like them — poached is the low-fat play; fried in a teaspoon of oil is fine. Yolks jammy, not chalky."},
        ],
    ),
    # ---- WFH lunches ----
    dict(
        slug="lentil-feta-salad", name="Big lentil & feta salad", kind="lunch",
        minutes=10, difficulty="easy", serves=1, platefig="plate-salad",
        kcal=430, protein_g=28, carbs_g=40, sugar_g=5, fiber_g=14,
        fat_g=16, satfat_g=5, sodium_mg=620,
        why="The WFH default: lentils for fiber, a measured amount of feta doing maximum work.",
        tags=["wfh", "high-fiber"],
        ingredients=[
            {"name": "puy lentils", "qty": 125, "unit": "g", "disp": "½ pouch"},
            {"name": "feta", "qty": 40, "unit": "g", "disp": "40 g"},
            {"name": "cherry tomatoes", "qty": 125, "unit": "g", "disp": "handful"},
            {"name": "spinach", "qty": 40, "unit": "g", "disp": "handful"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "½"},
            {"name": "olive oil", "qty": 10, "unit": "ml", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[{"title": "Assemble", "minutes": 8, "detail": "Everything in a bowl, feta crumbled last so it stays in proud chunks. Lemon and oil over."}],
    ),
    dict(
        slug="tuna-bean-lunchbox", name="Tuna & bean lunchbox", kind="lunch",
        minutes=8, difficulty="easy", serves=1, platefig="plate-salad",
        kcal=380, protein_g=34, carbs_g=32, sugar_g=4, fiber_g=10,
        fat_g=10, satfat_g=1.5, sodium_mg=700,
        why="Cupboard-only, travels well, and quietly one of the best protein-per-sat-fat ratios in the pool.",
        tags=["wfh", "storecupboard"],
        ingredients=[
            {"name": "tuna in spring water", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "white beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "red onions", "qty": 1, "unit": "x", "disp": "¼, sliced thin"},
            {"name": "lemons", "qty": 1, "unit": "x", "disp": "½"},
            {"name": "olive oil", "qty": 10, "unit": "ml", "disp": "2 tsp", "note": "pantry"},
        ],
        steps=[{"title": "Assemble", "minutes": 8, "detail": "Beans rinsed, tuna forked through, onion and dressing over. Better after an hour in the fridge."}],
    ),
    dict(
        slug="chicken-grain-soup", name="Chicken, bean & grain soup", kind="lunch",
        minutes=25, difficulty="easy", serves=2, platefig="bowl-stew",
        kcal=350, protein_g=30, carbs_g=36, sugar_g=3, fiber_g=8,
        fat_g=8, satfat_g=2, sodium_mg=620,
        why="The cold-day lunch — makes two, second one's tomorrow.",
        tags=["wfh", "batch"],
        ingredients=[
            {"name": "chicken breast", "qty": 250, "unit": "g", "disp": "250 g"},
            {"name": "white beans", "qty": 1, "unit": "x", "disp": "1 tin"},
            {"name": "bulgur wheat", "qty": 60, "unit": "g", "disp": "60 g", "note": "pantry"},
            {"name": "spring greens", "qty": 80, "unit": "g", "disp": "handful"},
            {"name": "garlic", "qty": 2, "unit": "x", "disp": "2 cloves", "note": "pantry"},
        ],
        steps=[
            {"title": "Simmer", "minutes": 18, "timer": True, "detail": "Chicken poached whole in 800 ml stock with garlic. Done when it shreds with two forks."},
            {"title": "Everything in", "minutes": 5, "detail": "Chicken shredded back in with beans, bulgur and greens until the bulgur is tender."},
        ],
    ),
    # ---- snacks ----
    dict(
        slug="apple-peanut-butter", name="Apple & peanut butter", kind="snack",
        minutes=1, difficulty="easy", serves=1, platefig="snack-apple",
        kcal=210, protein_g=5, carbs_g=24, sugar_g=16, fiber_g=4,
        fat_g=11, satfat_g=1.5, sodium_mg=65,
        why="Fiber plus fat that satisfies — the 3pm biscuit replacement that actually works.",
        tags=["snack"],
        ingredients=[
            {"name": "apples", "qty": 1, "unit": "x", "disp": "1"},
            {"name": "peanut butter", "qty": 15, "unit": "g", "disp": "1 tbsp", "note": "pantry"},
        ],
        steps=[],
    ),
    dict(
        slug="almonds-30", name="Almonds, a proper handful", kind="snack",
        minutes=1, difficulty="easy", serves=1, platefig="snack-nuts",
        kcal=180, protein_g=6, carbs_g=6, sugar_g=1.3, fiber_g=4,
        fat_g=15, satfat_g=1.2, sodium_mg=0,
        why="Thirty grams of almonds is one of the few snacks with actual lipid-panel evidence behind it.",
        tags=["snack"],
        ingredients=[{"name": "almonds", "qty": 30, "unit": "g", "disp": "30 g", "note": "pantry"}],
        steps=[],
    ),
    dict(
        slug="protein-yogurt-pot", name="Protein yogurt pot", kind="snack",
        minutes=1, difficulty="easy", serves=1, platefig="snack-yogurt",
        kcal=150, protein_g=18, carbs_g=12, sugar_g=8, fiber_g=1,
        fat_g=2, satfat_g=0.5, sodium_mg=60,
        why="The evening protein closer when the day's number is short.",
        tags=["snack"],
        ingredients=[
            {"name": "greek yogurt 0%", "qty": 170, "unit": "g", "disp": "170 g"},
            {"name": "berries, mixed", "qty": 50, "unit": "g", "disp": "50 g"},
        ],
        steps=[],
    ),
]


def _first_week() -> dict:
    """Hand-written first food week (the Phase 2 seed-plan trick, applied to food).
    Weekday keys 0–6 like the training plan; the rolling week maps dates onto them.
    Office days Tue–Thu carry order-assist lunch slots; Friday is the night out."""
    order_note = "Order out — target P 40+, sat ≤ 6 g, inside the lunch cap. Favorites + menu ranking land in Phase 9."
    d = {
        "0": {"slots": {
            "breakfast": {"recipe": "oats-no1"},
            "lunch": {"recipe": "lentil-feta-salad"},
            "dinner": {"recipe": "harissa-chicken-traybake", "why": "cook once, eat twice — boxes Wednesday"},
            "snack": {"recipe": "apple-peanut-butter"},
        }},
        "1": {"slots": {
            "breakfast": {"recipe": "oats-no1"},
            "lunch": {"order": True, "note": order_note},
            "dinner": {"recipe": "salmon-puy-lentils", "why": "omega-3 day; lentils carry fiber"},
            "snack": {"recipe": "apple-peanut-butter"},
        }},
        "2": {"slots": {
            "breakfast": {"recipe": "oats-no1"},
            "lunch": {"order": True, "note": order_note},
            "dinner": {"leftover_of": "0", "why": "zero-cook on your run day"},
            "snack": {"recipe": "protein-yogurt-pot"},
        }},
        "3": {"slots": {
            "breakfast": {"recipe": "yogurt-berry-bowl"},
            "lunch": {"order": True, "note": order_note},
            "dinner": {"recipe": "turkey-black-bean-chili", "why": "fiber engine; batch feeds Friday lunch"},
            "snack": {"recipe": "apple-peanut-butter"},
        }},
        "4": {"slots": {
            "breakfast": {"recipe": "oats-no1"},
            "lunch": {"leftover_of": "3", "why": "Thursday's chili, boxed"},
            "dinner": {"out": True, "note": "Night out — enjoy it. Sat-fat headroom banked Mon–Thu."},
            "snack": {"recipe": "almonds-30"},
        }},
        "5": {"slots": {
            "breakfast": {"recipe": "eggs-spinach-toast"},
            "lunch": {"recipe": "tuna-bean-lunchbox"},
            "dinner": {"recipe": "prawn-soba-stirfry", "why": "fifteen minutes; barely any sat fat"},
            "snack": {"recipe": "almonds-30"},
        }},
        "6": {"slots": {
            "breakfast": {"recipe": "eggs-spinach-toast"},
            "lunch": {"recipe": "chicken-grain-soup"},
            "dinner": {"recipe": "baked-cod-white-bean-stew", "why": "finishes the harissa jar; soft landing for the week"},
            "snack": {"recipe": "protein-yogurt-pot"},
        }},
    }
    return {"days": d}


def run_food_seed(db: Session) -> None:
    """Insert-missing, same contract as run_seed — safe on every boot."""
    # ingredient reference table
    have = {i.name: i for i in db.query(Ingredient).all()}
    for name, aisle, unit, pack, kcal, prot, carbs, sugar, fib, fat, sat, sodium, pantry in INGREDIENTS:
        if name not in have:
            db.add(Ingredient(name=name, aisle=aisle, unit=unit, pack=pack, kcal_100=kcal,
                              protein_100=prot, carbs_100=carbs, sugar_100=sugar, fiber_100=fib,
                              fat_100=fat, satfat_100=sat, sodium_100=sodium, pantry=pantry))
        else:  # backfill macros that predate the full-label set (startup ALTER defaults them to 0)
            row = have[name]
            for col, val in (("carbs_100", carbs), ("sugar_100", sugar),
                             ("fat_100", fat), ("sodium_100", sodium)):
                if not getattr(row, col, 0):
                    setattr(row, col, val)
    # recipe library
    have_r = {r.slug: r for r in db.query(Recipe).all()}
    for r in RECIPES:
        if r["slug"] not in have_r:
            db.add(Recipe(**r))
        else:  # same backfill for authored recipe macros; meal_log snapshots stay untouched
            row = have_r[r["slug"]]
            for col in ("carbs_g", "sugar_g", "fat_g", "sodium_mg"):
                if not getattr(row, col, 0):
                    setattr(row, col, r.get(col, 0))
    db.commit()

    # per-user nutrition prefs defaults (JSON column: reassign, never mutate in place)
    for u in db.query(User).all():
        prefs = dict(u.prefs or {})
        missing = {k: v for k, v in NUTRITION_PREF_DEFAULTS.items() if k not in prefs}
        if missing:
            u.prefs = {**prefs, **missing}
    db.commit()

    # the member household's first food week (demo weeks are seeded by demo.py later)
    if not db.query(MealRevision).filter(MealRevision.user_id.is_(None)).first():
        db.add(MealRevision(
            user_id=None, num=1, status="active", content=_first_week(),
            rationale=("First food week — hand-written baseline before the coach takes over "
                       "(Phase 8). Protein lands ~155 g/day without red meat; fiber averages "
                       "high 30s with beans, lentils and oats doing the work; sat fat holds "
                       "roughly 14 g/day, leaving honest room for Friday out."),
            changes=[],
        ))
        db.commit()

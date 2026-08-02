# Crystal Dawn — Build Contract

A Tiberian Dawn–style 2D skirmish RTS. Browser, Vite + TypeScript + Canvas 2D. **All art is original, drawn procedurally in code** (offscreen canvases at boot) — no binary assets, no EA content.

This file is the contract between build phases. Agents: follow it exactly; if you must deviate, document the deviation at the bottom under "Deviations".

## Ground rules

- `npm run build` (tsc --noEmit + vite build) must pass at the end of every phase. Do NOT start dev servers.
- No new runtime dependencies without approval. TypeScript strict mode stays on.
- Deterministic sim: fixed-timestep logic tick at 20 Hz (`TICK_MS = 50`), rendering interpolates at display rate. All gameplay logic advances only in `tick()`; never in `requestAnimationFrame`.
- Single source of truth: `GameState` object. Systems are functions/classes that read+mutate GameState in a defined order each tick. No module-level mutable game state.
- Coordinates: world space in pixels; `TILE = 24` px. Map is 96×96 tiles. Tile coords are `tx, ty`; world coords `x, y` (unit positions are world-space floats, centered).
- RNG: use the seeded `rng` in `src/engine/rng.ts` for anything gameplay-affecting (never `Math.random` in sim code).

## File layout

```
src/
  main.ts              — boot: create canvas, GameState, systems, loop; expose window.__game
  engine/
    loop.ts            — fixed-timestep loop (tick 20Hz + render rAF)
    input.ts           — mouse/keyboard state, edge-scroll, drag-box, right-click (suppress context menu)
    camera.ts          — pan/clamp, world<->screen transforms
    rng.ts             — seeded PRNG (mulberry32)
  game/
    state.ts           — GameState type + factory; entity types (Unit, Building, Projectile)
    constants.ts       — TICK_MS, TILE, MAP_W/H, faction/player ids
    rules.ts           — data tables: UNIT_TYPES, BUILDING_TYPES (cost, hp, speed, weapons, armor, power, prereqs)
    map.ts             — terrain grid gen (grass/sand/rock/cliff/crystal), passability, crystal fields
    pathfinding.ts     — A* on tiles + path smoothing; local avoidance in movement system
    systems/
      movement.ts      — path following, steering separation
      harvest.ts       — harvester AI cycle (field -> refinery), credit payout
      production.ts    — build queues (buildings + units), power effects on speed
      combat.ts        — target acquisition, weapons, projectiles, damage vs armor table
      fog.ts           — explored/visible grids, sight radii
      ai.ts            — enemy AI: build order, economy, attack waves
      victory.ts       — win/lose check (all production buildings destroyed)
  render/
    sprites.ts         — procedural pixel-art sprite factory; returns offscreen canvases, cached
    renderer.ts        — terrain layer (cached), entities, projectiles, fog, selection UI, health bars
    ui.ts              — sidebar (build tabs, credits, power meter), minimap, EVA text ticker
  audio/
    sfx.ts             — WebAudio synthesized effects + announcer hooks
```

Later phases may add files but not restructure existing ones.

## Key types (Phase 1 defines these in state.ts; later phases extend, don't rename)

```ts
type PlayerId = 0 | 1;               // 0 = human (Coalition), 1 = AI (The Order)
interface GameState {
  tick: number;
  map: MapData;                       // terrain, passability, crystal amounts
  units: Unit[];
  buildings: Building[];
  projectiles: Projectile[];
  players: [PlayerState, PlayerState]; // credits, power (drain / capacity), radar flag
  selection: number[];                // entity ids (human's)
  fog: FogState;
  result: 'playing' | 'won' | 'lost';
}
```

Entities have stable numeric `id`s (monotonic counter in GameState). Systems look up via id maps built per tick or maintained indexes — keep O(n) per tick, target 60 fps render with 300 units.

## Debug hook

`window.__game = { state, spawn(type, tx, ty, player), give(credits), reveal(), speed(mult), select(ids) }` — Phase 1 creates it with `state`; each phase adds its helpers. Used for testing; keep it working.

## Player-facing conventions

- Right-click = move/attack order (context menu suppressed on canvas). Left drag = box select. Ctrl+1..9 assign control groups, 1..9 recall. A+click = attack-move. Edge scroll + arrow keys pan.
- Sidebar on the right, C&C style: credits counter animates, power bar (green/yellow/red), two build tabs (Structures / Units), grayed items when prereqs/power unmet, click to queue, click-again on ready building to enter placement mode (green/red footprint ghost).
- EVA-style ticker announcements: "Construction complete", "Unit ready", "Insufficient funds", "Low power", "Base under attack".

## Balance data (initial; Phase 7 tunes)

Factions v1: shared roster. Armor classes: `none, light, heavy, structure`. Weapons declare damage + multiplier per armor class.

Buildings: ConYard (n/a), Power Plant (300cr, +100 pwr), Refinery (2000cr incl. free harvester, -30 pwr), Barracks (400cr, -20), War Factory (2000cr, -30), Comm Center (1500cr, -40, radar), Silo (150cr, +1500 storage), Guard Tower (500cr, -10), Sandbag (50cr).
Units: Minigunner 100cr, Rocket Soldier 300cr, Engineer 500cr, Harvester 1400cr, Scout Buggy 700cr, Light Tank 1000cr, Medium Tank 1600cr, Artillery 1200cr.
Start: 5000cr, ConYard + MCV-less (ConYard pre-placed), 1 free minigunner scout. Crystal cell ~200cr, harvester carries 700cr/trip.

## Phases

1. **Engine core** — loop, map gen, camera, input, terrain rendering, sprite factory basics, __game hook
2. **Units** — selection, orders, A*, movement/steering
3. **Economy & construction** — harvest cycle, power, sidebar production + placement
4. **Combat & fog** — weapons/armor, projectiles, health bars, fog of war
5. **AI & skirmish** — enemy AI, victory/defeat
6. **UI & audio polish** — minimap, EVA, SFX, menus
7. **Balance & playtest** — human-driven tuning

## Deviations

### Phase 1 (engine core)

- **Crystal tile value.** Balance data says "Crystal cell ~200cr"; Phase 1 generates tiles holding
  `CRYSTAL_TILE_AMOUNT = 1500` credits each (±200 jitter), per the Phase 1 brief. Harvester capacity
  stays at 700cr/trip, so a full tile is ~2 loads. A generated map holds ~400k credits total across
  6 fields. Phase 7 retunes `CRYSTAL_TILE_AMOUNT` / `HARVEST_RATE` if that proves too rich.
- **ConYard cost/build time.** Listed as "n/a" in the balance table, but `BUILDING_TYPES` needs total
  coverage, so it carries nominal values (5000cr / 30s). It is not offered in the sidebar; it exists
  pre-placed. Phase 3 should keep it out of the buildable list (or gate it behind an MCV).
- **`GameState` has fields beyond the Key-types snippet**, all additive: `nextId` (the monotonic id
  counter the snippet describes in prose), `controlGroups`, `rng`, `messages` (EVA ticker backlog)
  and `seed`. Nothing in the snippet was renamed.
- **Starting bases are placed in `main.ts`** (`placeStartingBases`: ConYard + one free minigunner per
  player, per the balance section). This is boot scaffolding so Phase 1 is testable; Phase 3/5 should
  move it into proper skirmish setup.
- **`Input` takes the `Camera` in its constructor** so click/drag events carry resolved world
  coordinates when they are produced, rather than needing a separate resolve step.
- **Silo footprint is 2x1 tiles**; footprints were not specified in the balance section.
  Others: ConYard 3x3, Refinery/War Factory 3x2, Power Plant/Barracks/Comm Center 2x2,
  Guard Tower/Sandbag 1x1.

### Phase 2 (units, pathfinding, movement)

Built: `pathfinding.ts` (A* binary heap, 8-dir no corner cutting, ~4000 node cap, string-pulling
smoothing, `findNearestPassable`), `systems/orders.ts` (box select, shift add, control groups,
right-click move w/ formation spread, attack-move kind, shift-queue, `orderUnitsById`),
`systems/movement.ts` (path follow w/ turning + pivot slowdown, soft separation, stuck
repath/give-up, `PATH_BUDGET_PER_TICK` staggered repaths). `__game.order(ids, kind, tx, ty, opts)` added.
Verified by manager: 50-tank cross-map group move all arrive (worst 5.7 tiles from rally, min
separation 20px, 0.09 ms/tick @ 50 pathing units incl. spawn inside footprints).

- **Manager fixes (post-agent):** units standing ON an impassable tile (e.g. displaced into a
  building footprint) previously froze forever. Two guards added: `moveClamped` allows free
  movement when the current tile is impassable, and the no-path branch in movement walks the unit
  to `findNearestPassable` before repathing. Phase 3 production should still spawn units on open
  tiles adjacent to the factory — the escape path is a safety net, not the spawn mechanism.

### Phase 3 (economy & construction)

Built: `systems/harvest.ts` (harvester state machine + crystal/refinery/dock searches),
`systems/production.ts` (queues, power/storage books, prereqs, placement, unit spawning),
`render/ui.ts` (`Sidebar`: credits/power/tabs/icon grid/EVA ticker + input routing),
sidebar icons in `sprites.ts`, placement ghost in `renderer.ts`.
Tick order in `main.ts` is now `sidebar.update -> orders -> movement -> harvest -> production`,
then the renderer drains `state.dirtyTiles`.
`__game` gained `queue(type, player?)`, `placeReady(tx, ty)`, `harvestInfo(player?)`.

- **Dirty-tile wiring.** The sim never sees the renderer. `state.dirtyTiles` (flat tile indices)
  is filled by `markMapTileDirty` / `markMapRectDirty` in `state.ts`; `main.ts` drains it into
  `renderer.markTileDirty` after the systems run. Phase 4+ (craters, wall rubble) should use the
  same queue.
- **Additive state fields.** `GameState.dirtyTiles`; `PlayerState.lowPower`;
  `Unit.harvestTimer` (gather cadence + search backoff); `UiState.placement` (new
  `PlacementState` type) and `UiState.buildTab`. Nothing was renamed.
- **Low power halves the build *rate*, not `ProductionItem.total`.** `total` stays the type's
  `buildTime` (ticks at full power) and progress accrues at 0.5/tick while `lowPower`, so the
  doc comment on `total` ("adjusted for low power") describes the intent, not the mechanism.
  Verified: a 40-tick sandbag takes 80 ticks under low power and still costs exactly 50cr.
- **Drip charging is rounded to whole credits.** Each tick the item is charged
  `round(cost * progress/total) - spent`, so credits stay integral and a completed item has cost
  *exactly* its price (no floating-point dust), even after pausing for insufficient funds.
- **Placed structures are complete immediately** (`status: 'ready'`), matching C&C1 where the
  build bar runs in the sidebar and placement is instant. The `'constructing'` status is left in
  place and is already honoured everywhere (no power, no storage, no prereq, no production), so
  Phase 5/7 can add on-map build-up if wanted.
- **Storage caps harvester deposits only.** `START_CREDITS` (5000) exceeds `BASE_STORAGE` (2000),
  so clamping the balance every tick would confiscate starting funds. Overflow is only lost at the
  refinery ("Silos needed"); production refunds and `__game.give` are not clamped. Practical
  effect: a fresh base banks nothing from harvesting until it has spent down below its cap.
- **Build radius applies to every structure**, including the ones `rules.ts` marks
  `standalone: true` (sandbag, guard tower). The flag is still unused; Phase 4 should honour it if
  forward-deployed defences are wanted. Radius is Chebyshev <= 4 tiles between footprints, measured
  against the player's own non-sandbag buildings.
- **Placement also rejects tiles with a unit standing on them**, so a structure can never bury a
  unit (the Phase 2 escape guard then never has to fire for this reason).
- **Harvest tunables** (local to `harvest.ts`, not `constants.ts`): one `HARVEST_RATE` (25cr)
  scoop every 4 ticks -> 112 ticks per 700cr load; unloading drips 50cr/tick -> 14 ticks; dock
  range 1.6 tiles from the refinery footprint; crystal/dock ring searches cap at 40 tiles with a
  20-tick backoff when they fail. A spent tile stays the harvester's search anchor, which keeps it
  in the same field.
- **Harvesters only act when idle.** The system issues ordinary `move` orders and never steers a
  unit itself, so a player order always wins; the cycle resumes when that order ends. `harvest`
  and `deliver` orders are consumed by the system and converted into cycle state.
- **Sidebar input routing.** `Sidebar.update()` runs before `updateOrders` and returns a snapshot
  with the events it consumed removed (sidebar clicks, placement clicks, sidebar-only drag boxes,
  a placement-cancelling Escape). `orders.ts` needed no change — its existing `!click.inView`
  guard already ignores the sidebar strip.
- **Renderer changes are additive:** a `sidebarDraw` hook (when set, `ui.ts` owns the whole strip;
  the Phase 1 placeholder is the fallback) and `drawPlacementGhost`, which only picks a colour —
  validity is computed in the tick and carried on `state.ui.placement.valid`.
- **Queue limits:** one structure at a time, five units queued (C&C). Right-clicking a sidebar
  icon cancels that queue's head item and refunds what it paid. A finished unit whose factory is
  gone (or is completely boxed in) holds at 100% and retries every tick instead of refunding.
- **ConYard stays unbuildable** (`BUILDABLE_STRUCTURES` filters it), per the Phase 1 note.
- EVA strings used this phase: "Construction complete", "`<Name>` online", "Unit ready",
  "Insufficient funds", "Low power" (once per transition), "Silos needed", "Refinery needed",
  "No crystal in range", "Cannot deploy here".

### Phase 4 (combat & fog of war)

Built: `systems/combat.ts` (acquisition, firing, projectiles, splash, damage, death,
`removeDead`), `systems/fog.ts` (explored/visible grids + the renderer's culling predicate),
renderer layers (projectiles, muzzle flashes, explosions, health bars, shroud), `sprites.ts`
FX helpers, right-click-to-attack in `orders.ts`. Tick order in `main.ts` is now
`sidebar.update -> orders -> movement -> harvest -> production -> combat -> fog -> removeDead`,
then the dirty-tile drain. `__game` gained `attack(ids, targetId, queued?)`,
`damage(id, amount)` and `fogAt(tx, ty)`.

- **Engagement model.** Three distinct behaviours, all expressed through the existing order
  machinery rather than new unit state:
  - *commanded attack* — `{ kind: 'attack', targetId }`. A mobile shooter that is out of range
    swaps this for a **pursuit move**: `{ kind: 'move', targetId, tile, target }`. A `move`
    order that carries a `targetId` is the marker for "chasing something"; the ordinary
    movement system does the driving and combat flips it back to `attack` at 92% of range
    (hysteresis, so it does not oscillate on the range boundary). Pursuit is unlimited — a
    commanded attack follows its victim across the map.
  - *attack-move engagement* — when an `attackMove` unit finds a target inside weapon range,
    the attack-move order is pushed onto `orderQueue` and replaced by
    `{ kind: 'attack', targetId, auto: true }`. Because `attack` is not a move kind the unit
    parks itself and fires; when the target dies (or breaks a 2.5-tile leash) `completeOrder`
    pops the attack-move and the advance resumes. Out-of-range targets inside the acquisition
    radius (range + 2 tiles) are tracked but not engaged, so the unit keeps advancing.
  - *idle / guard* — free fire with **no order at all**, only `unit.targetId`. This is what
    keeps the Phase 3 contract intact: an armed escort standing next to a harvester never
    stops being "idle", so harvest logic and player orders always win.
- **Additive state fields** (nothing renamed): `Order.auto`, `Projectile.travel` (flight length,
  for the ballistic arc), `FogState.version` (render cache invalidation), `GameState.effects`
  plus the `Effect`/`EffectKind` types. `Unit.targetId` / `cooldown` / `turretFacing` and
  `Building.targetId` / `cooldown` / `turretFacing` were already declared in Phase 1.
- **Direct fire never misses.** `bullet` and `shell` projectiles carry `targetId` and re-aim at
  the target's live position each tick, so `weapon.inaccuracy` only jitters the *impact point*
  (which matters for splash), not whether the shot connects. Verified: N minigunner shots deal
  exactly `N * damageAgainst(...)` against none/light/heavy/structure armor. `rocket` steers at
  0.16 rad/tick (it can be led away by a fast mover); `arc` (artillery) has no target entity at
  all — it commits to a point, so a target that drives off is missed.
- **Splash falloff is linear**, `damage * (1 - d / radius)`, then run through the warhead/armor
  table. It hits everything in the radius including the firer's own side, and excludes the
  entity that already took the direct hit. Distance is measured centre-to-centre for units and
  to the footprint edge for structures (the same metric weapon range uses).
- **Aiming.** Turreted vehicles traverse at 0.22 rad/tick and may only fire within 0.14 rad of
  the target; non-turreted vehicles (artillery) swing the *hull* at their own `turnRate` under
  the same tolerance; infantry and defensive structures snap on and fire instantly, per the
  phase brief. Turrets keep tracking while on cooldown.
- **Guard Tower goes offline under `lowPower`** (`weaponOf` returns null): no acquisition, no
  fire. Verified: 0 shots fired and the tower is razed by three minigunners it would otherwise
  kill.
- **Artillery has no minimum-range retreat.** `howitzer.minRange` (2.5 tiles) is honoured as a
  hold-fire band, but a unit that ends up inside it just stops shooting instead of backing off.
  Phase 5/7 should add the kite-back behaviour.
- **Death.** `hp <= 0` sets `dead`, and the entity stays in the arrays until `removeDead()` at
  the end of the tick so every id resolved this tick still resolves. Structures release their
  footprint (`setFootprintOccupied(false)`) and mark the rect dirty *immediately* on death, not
  at cleanup. No terrain change (no craters/rubble) this phase, per the brief. `removeDead`
  also scrubs the dead ids out of `state.selection` and every control group.
- **EVA lines** are human-only and throttled by scanning the ticker backlog (no module-level
  state): "Unit lost" / "Structure lost" at most once per 60 ticks (3s), "Base under attack" at
  most once per 300 ticks (15s), the latter only for structures that survived the hit.
- **Fog recompute.** `visible` has to shrink behind a moving unit, so it is fully rebuilt every
  `FOG_INTERVAL = 4` ticks; on the three ticks in between, the 1/4 slice of sources whose
  `id % 4` matches re-marks its circle additively, which is the "staggered" part — newly
  uncovered ground shows up within a tick without paying for a rebuild. Sight is a plain
  circle (no line-of-sight blocking by cliffs); structures use `sight + max(w,h)/2`.
- **`fog.version` bumps on every full rebuild**, even when nothing actually moved, so the
  renderer re-uploads its 96x96 shroud bitmap 5x/second in the worst case. That is ~9k pixels
  of `putImageData` and was measured as noise; making it exact would need a second copy of the
  `visible` grid to diff against.
- **Enemy visibility is strict**: enemy units *and* structures are drawn only while a tile they
  occupy is currently `visible`. Explored-but-dark ground shows terrain under a 45% black
  overlay and nothing else — C&C1 keeps discovered structures on screen; this does not.
  `orders.enemyAtPoint` uses the same predicate, so the player cannot right-click a target they
  cannot see.
- **Fog is ON from boot** (`main.ts` sets `state.fog.enabled = true` after placing the bases).
  `__game.reveal()` still works exactly as Phase 1 defined it (fills both grids and sets
  `enabled = false`, which makes the fog system a no-op); it now also bumps `fog.version`.
- **The AI ignores fog entirely** — the grids are the human's only. Phase 5 must not read them
  for AI decisions.
- **Projectiles consume entity ids** from `state.nextId`, so ids advance faster than in Phase 3.
  Nothing depends on ids being dense.
- **Effects are sim-spawned, render-only.** `GameState.effects` is filled inside `tick()` (so it
  stays deterministic and replayable) and capped at 192 entries; the renderer ages them off
  `state.tick` and culls them by fog.
- **Right-click context order**: an enemy unit under the cursor (or an enemy structure under the
  clicked tile) issues `attack`; anything else is still a ground move. Unarmed selected units
  (engineer, harvester) are sent to the target's position instead of being given an attack they
  cannot execute. Shift still queues.
- **Target priority**: nearest wins, scored as `distance * weight` with weight 0.78 for armed
  units, 1.0 for unarmed ones and 1.35 for structures — so a tank picks the escort over the
  harvester behind it, but will not cross the map to do so. Ties break on entity id (determinism).
- Verified headlessly (harnesses live outside the repo): exact DPS vs all four armor classes and
  a 10-tick rate of fire; medium tank beats light tank with **125/400 hp** left, matching the
  analytic model to the point; a guard tower kills 3 approaching minigunners with 15 shots
  keeping 84% hp (0 shots and destroyed when `lowPower`); artillery lands 5.4px from the aim
  point and its splash matches `damage * (1 - d/r)` exactly at 0/10/20/28/40px, friendly fire
  included; structure death restores passability/buildability and A* immediately routes through
  the rubble; fog explored grows 197 -> 790 tiles across a scout run while `visible` stays at
  ~198; **150 v 150 mixed armies + 4 structures run at 0.36 ms/tick mean, 0.73 ms p95** (budget
  50 ms).

### Phase 5 (enemy AI & skirmish flow)

Built: `systems/ai.ts` (build order, placement, unit mix, waves, defence, difficulty),
`systems/victory.ts` (defeat rule + result/EVA), `game/skirmish.ts` (`initSkirmish`, taking the
starting-base setup out of `main.ts`), the mission-result curtain in `renderer.ts`, and a
no-reload restart in `main.ts`. Tick order is now
`[sidebar.update -> orders, only while playing] -> movement -> harvest -> production -> combat
-> fog -> removeDead -> ai -> victory`.
`__game` gained `ai(level?)`, `aiInfo()`, `result()` and `restart(level?)`.

- **AI state lives on `GameState.ai`** (`AiState`, declared in `ai.ts`, referenced from
  `state.ts` with a type-only import so no runtime cycle exists). It is optional: a bare
  `createGameState()` has no `ai` and `updateAi` is then a no-op. That is what makes restart a
  plain `createGameState() + initSkirmish()` with nothing left to clean up.
- **Decision cadence.** `updateAi` returns immediately unless `(tick + 3) % 10 === 0`, so the
  whole AI runs 2x/second. Unit micro is left to combat/movement exactly as the Phase 4 handoff
  asked; the AI only ever calls `issueGroundOrder`, `issueAttackOrder` and `stopUnits`.
- **The build order doubles as the rebuild list.** `BUILD_PLAN` is a list of `{ type, count }`
  targets walked in order; the first entry below its target count is what gets queued. A razed
  barracks therefore re-queues itself with no separate rebuild code path. Power is checked
  *before* the plan (a deficit halves every build in the base), and silos / a second refinery /
  extra towers are appended after it.
- **Placement** uses `canPlaceAt` — the same validation the human's placement ghost uses — and a
  ring search outward from an anchor, first valid tile wins. The anchor is the ConYard centre,
  except defences (5 tiles toward the human start) and refinery/silo (4 tiles toward the home
  crystal field). After `PLACE_FAIL_LIMIT` (24) consecutive failures the ready structure is
  cancelled for a refund rather than wedging the queue forever.
- **Two rules were needed to stop the AI fielding nothing but minigunners**, and both are
  consequences of Phase 3's economy rather than AI bugs:
  - *Infantry share.* There is one unit queue per player, so 100cr/3s minigunners roll out ~3x
    faster than armour and filled the whole army cap in the first three minutes, freezing the
    composition there for the rest of the game. Above `INFANTRY_SHARE` (55%) infantry is cut from
    the pool.
  - *Pick-then-save.* Rolling the unit type against current credits always picked whatever
    crossed the affordability line first — i.e. the cheapest unlocked unit, forever. The AI now
    rolls a `wantUnit` ignoring price and saves for it (re-rolled after `WANT_TIMEOUT`, 45s). It
    commits at `COMMIT_FRACTION` (65%) of the price and lets production drip-charge the rest,
    which is what a human does by clicking the icon early.
  With both in place a 20-minute run fields minigunners/rocket soldiers first, light then medium
  tanks from ~4 min, and artillery from ~9 min.
- **Economy insurance.** With no refinery the AI's income is *exactly* zero, so spending its last
  credit while on a single refinery was an unrecoverable position: a sniped refinery could never
  be replaced (measured: frozen at 4 credits for 8+ sim-minutes). While it holds exactly one
  refinery the AI now keeps that refinery's price banked and unavailable to unit production, and
  pays cash for units instead of drip-charging through the reserve. Related: a unit already in
  the queue will happily drip-charge the rebuild money away, so while a *critical* structure
  (refinery / barracks / war factory) is being replaced and money is short, the unit queue is
  cancelled for its refund. This is an AI-only behaviour — **the same trap still exists for the
  human player**, flagged for Phase 7 below.
- **Defence.** A human unit within 10 tiles of the AI ConYard sends the rally group (topped up
  from the units already out attacking, never taking more than half a wave back) to attack-move
  the intruder's tile. It stands down at 13 tiles (hysteresis), `stopUnits` the defenders, and the
  rally logic walks them back to the staging point the same tick. The order is only re-issued once
  the intruder has moved more than 3 tiles, so it does not thrash.
- **Waves.** The rally group gathers at a staging tile 6 tiles toward the human. At
  `nextWaveTick` the AI launches when the group has reached `waveSize`, or after a 75s grace with
  at least 3 units. Attackers are committed for good (they never return to the rally); idle
  attackers are re-pointed at the current target every decision and focus-fire it with
  `issueAttackOrder` once inside 8 tiles. `waveSize` grows by the difficulty's `waveGrowth` after
  each launch, clamped to `waveCap`.
- **`AI_DIFFICULTY`** scales credit bonus / first-wave tick / interval / wave size, growth and cap /
  army cap. Measured over 10 sim-minutes: easy 5000cr, first wave 5:30, 20 units; normal 6500cr,
  4:00, 34; hard 9000cr, 3:00, 47. `__game.ai(level)` switches it live *and* selects the level the
  next `restart()` uses.
- **Victory rule** is the brief's operationalization: `defeated = no living, finished
  productionStructure AND (no units OR (no refinery AND credits < 400))`, where 400 is derived from
  `BUILDING_TYPES` as the cheapest non-ConYard production structure. Verified that a human with
  zero buildings, five medium tanks and credits is **not** declared dead, and that a lone refinery
  keeps a factory-less player alive. `updateVictory` returns early when the world is completely
  empty, so a bare state is never "defeated" before `initSkirmish` runs.
- **Result is sticky**: once `state.result` leaves `'playing'` it never changes, and `updateAi`
  returns immediately, so the AI goes quiet under the curtain.
- **The curtain does not pause the sim.** `render` draws `drawResultOverlay` over everything
  (sidebar included) and `tick()` skips `sidebar.update` + `updateOrders` entirely, so orders are
  ignored while every other system keeps running. Any left click, or R, restarts.
- **Restart is a wholesale state swap.** `main.ts` holds `state` in a `let`; `restart()` builds a
  new one, re-points `api.state`, and re-primes the three pieces of render-side cache that outlive
  the state: `renderer.buildTerrain`, the new `renderer.invalidateFog()` (the shroud bitmap is
  keyed on `fog.version`, which restarts at 0 and could otherwise collide with the cached number)
  and the new `Sidebar.reset()` (the rolling credit counter). Both new methods are additive.
- **Deviation from the brief's defence wording.** "Pull the current rally group + up to half the
  next wave" is implemented as *the rally group is the next wave* (it is literally the pool the
  next wave draws from), topped up from the committed attackers to at most `ceil(waveSize / 2)`.
- **Deviation on "income stalls".** The second-refinery trigger uses home-field depletion (below
  35% of its starting crystal) plus a direct signal from the harvest system — a harvester alive
  more than 20s that is still `seeking` with no `harvestTile` — rather than sampling income over
  time, which would need new per-tick bookkeeping to separate income from spending.
- **`silo` placement can look greedy at the start.** The AI opens with 6500cr against 3000
  storage, so once the plan is done the "credits pinned against storage" rule immediately buys its
  four silos (4:02-4:47 in the timeline). Harmless at 150cr each, but Phase 7 may want the rule to
  require sustained pinning.
- Verified headlessly (harnesses outside the repo, 99 checks across 9 scripts): **build timeline**
  power 0:08 / refinery 0:29 / barracks 0:39 / power 0:48 / war factory 1:08 / towers 1:19 + 1:29 /
  comm centre 1:57, first harvester deposit at 0:50; **waves** launch at 04:00 (5 units), 07:18
  (7), 10:44 (9), 13:50 (11) — asks 7/9/11/13, cap 16 — with first damage to a passive human base
  at 05:00 (tick 6003); **defence** triggers 0.4s after a medium tank parks 6 tiles from the
  ConYard, 11 defenders answer, the tank dies, and 8 units walk back to staging; **rebuild**
  barracks 10s / war factory 20s / refinery 20s from razed to standing again; **restart** resets
  tick, entities, credits, fog (9216 -> 0 explored tiles), map crystal (166k -> 413k) and the AI
  plan, and R does it from inside `tick()`; **perf** 20 sim-minutes with the full AI and fog on
  runs **0.025 ms/tick mean, 0.036 ms p95, 4.3 ms worst** (budget 50 ms), units peaking at 38 and
  effects at 17, with no drift between saturated windows (x1.17); the same seed is bit-identical
  across runs, there is no `Math.random` anywhere in `src`, and `ai.ts` contains zero references to
  `state.fog`.

**Handed to Phase 7 (balance):**

- The **no-refinery / no-income trap applies to the human too**. Lose your only refinery while
  holding under 2000cr and the game is unwinnable but never ends, because the victory rule
  (correctly) keeps a player with units alive. Options: a cheaper emergency refinery, a ConYard
  credit trickle, a sell-for-refund mechanic, or a stalemate condition.
- The AI **pins at its storage cap (10000cr with 2 refineries + 4 silos)** in the late game once
  the army cap is reached — it has nothing left to buy. Either the army cap should be value-based
  rather than count-based, or `MAX_SILOS` / `MAX_TOWERS` / `MAX_REFINERIES` should keep rising.
- **Wave 1 cannot arrive before ~04:45**: it leaves at 04:00 and the map's ~69-tile diagonal is a
  45s walk for infantry. To make the first attack land earlier, move `firstWave` earlier rather
  than pushing the staging point forward, which would expose the rally group.
- Guard towers earn their 500cr against the AI's infantry-heavy early waves but do almost nothing
  to armour (`towerGun` is `smallArms`: 0.2x vs heavy). A human who turtles on towers alone loses
  to wave 3+, which is roughly the intended shape but worth a deliberate decision.
- **Field pacing measured**: over 20 sim-minutes the AI's home field goes from 86,982cr to **0**
  (its expansion trigger fires as designed) while the map as a whole is only 23.7% consumed
  (412,892 -> 314,892). So a 20-minute game is roughly one field per side; `CRYSTAL_TILE_AMOUNT`
  is about right for that length, but a longer game pushes both players onto the contested
  neutral fields, which nothing currently defends. Worth a look when tuning game length.

### Phase 6 (UI & audio polish)

Built: real pixel art for every unit and structure in `render/sprites.ts` (replacing the Phase 1
placeholder box/slab), a radar minimap in `render/ui.ts`, WebAudio SFX + an EVA announcer in the
new `audio/sfx.ts`, and a title screen in the new `render/title.ts`. `renderer.ts` composites
hull+turret and building+turret and gained `renderTitle`/`titleDraw`; `main.ts` gained the
`'title' -> 'playing'` phase machine and the audio wiring. `__game` gained `spriteAudit()`,
`sfx(name?)`, `mute(on?)` and `phase(next?)`.

**Sprites.** Units are described *once* as a list of body-space rectangles (+x = forward) and
rasterised into the 2px art grid at each of the 16 facings — the shape list is rotated, not the
bitmap, so every facing is crisply on-grid instead of being a smeared `drawImage` rotate. One pass
fills a coverage map; the drop shadow and the 1px dark outline are derived from it, so a sprite
costs `dim^2 * shapes`. Canvas size is computed from the shapes' own corner radii
(`requiredDim`), so no facing can ever clip. Buildings never rotate and are painted straight onto
a footprint-sized canvas.

- **Two house schemes** (`SCHEMES`): player 0 Coalition olive/gold (`#7d8350` / `#e0b53c`),
  player 1 The Order slate/crimson (`#5c626b` / `#c8402c`). Both extend the existing
  `PLAYER_COLORS` accents, so the minimap dots and the sprites agree.
- **Turrets are separate cached sprites** for `buggy` / `lightTank` / `mediumTank` (and the guard
  tower), composited by the renderer at `turretFacing`. Artillery is deliberately *not* turreted
  (matching `rules.ts`): its long barrel is part of the hull, which is why it swings the whole
  vehicle to aim.
- **Harvester load state** is a second cached hull with an ore pile and a `crystalHot` core block
  in the bin; the renderer picks it off `(u.cargo ?? 0) > 0`.
- **Small animations only, all <= 4 frames and all cached**: power plant reactor glow (2),
  comm centre dish sweep (4), silo fill level (4, driven by the owner's `credits / storage`).
  Frames come off `state.tick`, so they freeze with the sim.
- **`constructing`** renders as a darkened scaffold (hazard frame + girder cross) with the
  finished sprite cross-faded in at `buildProgress`, replacing Phase 4's black wipe. Structures
  still complete instantly (Phase 3 deviation), so this path is only reachable by hand today — it
  is exercised by `spriteAudit()` and by the headless render harness.
- **Selection brackets / health bars now size off `def.radius * 2 + 4`** instead of the flat
  12/18 the placeholder used, so they hug the actual silhouette.
- **Sidebar icons were left as the Phase 3 schematics.** The brief allowed updating them only if
  trivially reusable from the new art, and they are not: the building sprites are 36x24-ish and
  downscaling pixel art into a 30px plate with smoothing off drops rows and reads worse than the
  purpose-drawn glyphs. They are still covered by the audit.
- **`getUnitPlaceholder` / `getBuildingPlaceholder` were deleted** (only `renderer.ts` used them)
  and `Renderer.playerColor` with them.
- **`drawPixelText` / `measurePixelText`** add a 5x7 bitmap font to `sprites.ts` for the title
  logotype and the radar's NO SIGNAL card, so headline type stays on the same pixel grid as the
  art instead of falling back to an anti-aliased system font. Unknown glyphs render as blanks.
- **`__game.spriteAudit()`** forces *every* sprite the factory can produce and reports
  `{key, w, h, opaquePx}`. **520 entries**: terrain 20 (5 types x 4 variants), unit hulls 288
  (8 types x 16 facings x 2 players, + 16x2 for the loaded harvester), turrets 128
  (3 turreted types + guard tower, x 16 x 2), buildings 50 (9 types x 2 players x
  ready-frames + constructing), icons 17, FX 17.

**Minimap.** Lives in `ui.ts` as a `Minimap` owned by `Sidebar`, sized `min(184, sidebar - 2*PAD)`
= 180px at the default `SIDEBAR_W`, sitting between the build grid and the EVA ticker
(`cells()` now stops above it).

- **Terrain is downsampled to one pixel per tile** into an offscreen 96x96 bitmap and repainted
  only where the sim reports change: `main.ts` now fans `state.dirtyTiles` out to *both*
  `renderer.markTileDirty` and `sidebar.markTileDirty`. The shroud gets its own 96x96 bitmap
  keyed on `fog.version`, exactly like the world renderer. A frame is therefore two `drawImage`
  calls plus the dots.
- **Radar gating reads `state.players[0].radar`** (Phase 5's precomputed `commCenter && !lowPower`)
  and nothing else. Dark = animated static + NO SIGNAL, and *all* minimap input is refused.
- **The static is four pre-baked noise frames cycled every 4 render frames**, not per-frame
  regeneration — the brief allowed a render-side RNG, and this keeps the dark state as cheap as
  the lit one. It is generated with the seeded `makeRng`, not `Math.random`.
- **Drag-scroll uses the live `snap.drag`**, and a drag that *started* on the pane keeps steering
  the camera after the pointer leaves it. Sidebar drags were already excluded from box-select by
  the Phase 3 `box.x1 < x0` filter, so no selection leaks.
- **Enemy dots respect fog** (`isEntityVisibleToHuman`), so the radar cannot be used to see
  through the shroud. Buildings draw at footprint size, units as 2px dots.
- `Sidebar.reset()` now also invalidates the minimap, which is why restart needed no new call.

**Audio.** `audio/sfx.ts` is a pure *consumer*: it is called from `render()`, never from `tick()`,
and nothing in `src/game` imports it. Ten synthesised sounds, no assets, no dependencies.

- **`Effect` gained one optional field, `weapon?: WeaponId`**, set by `fireWeapon` in `combat.ts`.
  This is the only sim-side change in the phase. It was necessary because a muzzle `Effect`
  otherwise carries only a size (6 or 9), which cannot separate a machine gun from a rocket. It is
  render-only, never read back by the sim, and does not affect determinism.
- **Watermarking.** `consume()` replays everything with `startTick >= watermark`, then sets
  `watermark = state.tick`. The watermark advances *even while muted or locked*, so unmuting never
  dumps a backlog of stale battle noise. `restart()` calls `sfx.resetStream()` because `state.tick`
  restarts at 0.
- **The harvester deposit chime is inferred render-side.** The sim posts no event when a load
  lands, so the consumer watches each human harvester's `harvestState` and chimes on the
  `unloading -> seeking` transition. No sim change was needed for it.
- **Voice budget**: max 3 of any one sound and 8 voices total per consumed frame, effects are
  gated on `isTileVisible` (you do not hear what you cannot see), off-camera effects play at 30%
  gain, and everything is panned by its x offset from the view centre when `StereoPannerNode`
  exists.
- **EVA speech** uses `speechSynthesis` at rate 0.92 / pitch 0.4. `SpeechQueue` is deliberately
  lossy — a line arriving while **more than 2** are already in flight is dropped, so EVA stays
  current instead of reading a backlog. The whole thing is behind a `SpeechBackend` interface, so
  a missing synthesiser is one `available() === false` and never an exception.
- **Autoplay policy**: the `AudioContext` is created *and* resumed only from a real gesture
  (`attachUnlock` on pointerdown/keydown/mousedown). Until then every `play()` is a silent no-op
  returning false. `Math.random` is used for the one-second noise buffer — that is outside the
  sim by construction, and it is the only `Math.random` in `src`.
- **'M' toggles mute**, persisted to `localStorage['crystal-dawn.muted']` behind try/catch on both
  read and write (private browsing / quota never throws). A speaker glyph in the sidebar footer
  shows muted (red, slashed) / ready (green) / locked (dim).
- The click sting on title-screen input is fired from `main.ts`'s input handling, not from a
  system; no system function calls audio.

**Title screen.** `render/title.ts` owns a two-state machine, `nextPhase(phase, action)`, driven
from `main.ts`.

- **The sim is genuinely frozen, not ticked-and-hidden**: while `phase === 'title'` the tick
  handles mute + title input and then *returns before `camera.pan` and every system*, so
  `state.tick` never advances. The loop keeps running and `render()` calls
  `Renderer.renderTitle()`, which animates off the title's own render-side frame counter — that is
  why the backdrop still drifts and the prompt still blinks with the sim stopped.
- **Boot creates a normal `GameState`** so the terrain layer exists for the backdrop, then
  deploying calls the existing `restart(difficulty)` — i.e. the map is generated twice on the way
  into the first mission. That is a deliberate trade for keeping one code path
  (`createGameState + initSkirmish`); map gen is ~10ms.
- **R from the result overlay still restarts straight into a fresh mission**, unchanged from
  Phase 5 — it does not return to the title.
- Difficulty buttons call the existing `__game.ai`-style path (`difficulty` -> `restart(level)`).
  Keys 1/2/3 pick a difficulty, Enter/Space deploy, and a click anywhere outside the buttons also
  deploys (the screen says "click to deploy" and means it).
- `Renderer` gained `renderTitle(state)` + a `titleDraw` hook, mirroring the additive
  `sidebarDraw` hook Phase 3 added. Nothing was restructured.

**Verified.** `npm run build` clean. Headless harnesses (outside the repo) drive the real modules
through a software canvas: **520 sprites built in 28ms with 0 under 20 opaque px** (thinnest real
entity sprite is the buggy turret at 168px; the 32px floor is the tiny muzzle-flash FX by design);
**69/69 logic checks** across radar gating, the speech-queue drop rule, mute persistence
(including a storage that throws on both get and set), title transitions and the
effect/message -> sound mapping; **12/12 render smoke steps** rendering every unit and building
type for both players, both radar states, shroud, placement ghost, debug overlay, result curtain
and 20 live sim ticks. In the browser: all 10 sounds reach the mixer, `spriteAudit()` returns 520
entries with 0 blanks, M toggles and persists mute, a minimap click and a minimap drag land the
camera on the analytically-expected world point, a dark radar refuses both, and
**`renderer.render` costs 0.19-0.31 ms/frame** with 18 units + 10 structures on screen (16.7ms
budget).

**Handed to Phase 7 — consolidated balance checklist.**

Everything flagged across Phases 1-6, in one list. Nothing here was changed in Phase 6; these are
open tuning decisions.

1. **Refinery-loss trap (human).** Lose your only refinery under 2000cr and the game is
   unwinnable but never ends — the victory rule correctly keeps a player with units alive. The AI
   has insurance (it banks a refinery's price while on one refinery, and cancels its unit queue to
   fund a critical rebuild); the human has none. Options: a cheaper emergency refinery, a ConYard
   credit trickle, sell-for-refund, or a stalemate condition.
2. **Guard tower vs armour.** `towerGun` is `smallArms` (0.2x vs heavy). A 500cr tower earns its
   keep against the AI's infantry-heavy early waves and does almost nothing to tanks; turtling on
   towers alone loses to wave 3+. Decide whether that is intended or whether the tower needs an
   AP option / a second tier.
3. **Minigunner vs heavy armour.** Same multiplier: 8 damage x 0.2 = 1.6 per shot every 10 ticks
   = 3.2 dps, so one minigunner needs ~94s to kill a 300hp light tank. Massed infantry is the
   intended answer, but check the crossover point against `crusher` (tanks run infantry over).
4. **Artillery.** (a) No minimum-range retreat: `howitzer.minRange` 2.5 tiles is honoured as a
   hold-fire band, so an artillery piece that gets rushed just stops shooting instead of kiting
   back. (b) Splash is 30px `he`, linear falloff, and hits *your own* units — a blob of artillery
   firing into a melee damages the melee. (c) `arc` shots commit to a point, so fast movers are
   simply missed. Decide how much of that is skill expression and how much is frustration.
5. **Crystal richness.** `CRYSTAL_TILE_AMOUNT = 1500` against the balance table's "~200cr" (a
   Phase 1 deviation). A generated map holds ~413k credits over 6 fields; 20 sim-minutes consumes
   23.7% of it while emptying the AI's home field entirely. Tune `CRYSTAL_TILE_AMOUNT` /
   `HARVEST_RATE` to the target game length, and note that a long game pushes both sides onto the
   neutral contested fields, which nothing currently defends.
6. **Wave timing.** Wave 1 cannot land before ~04:45: it leaves at 04:00 (normal) and the map's
   ~69-tile diagonal is a 45s infantry walk. To make first contact earlier move `firstWave`
   earlier rather than pushing the staging point forward, which would expose the rally group.
   Measured launches (normal): 04:00 / 07:18 / 10:44 / 13:50 at 5/7/9/11 units, cap 16.
7. **AI late-game credit pin.** With 2 refineries + 4 silos the AI pins at its 10000cr storage cap
   once the army cap is reached — it has nothing left to buy. Either make the army cap value-based
   rather than count-based, or keep `MAX_SILOS` / `MAX_TOWERS` / `MAX_REFINERIES` rising.
8. **Silo over-buying.** The AI opens with 6500cr against 3000 storage, so it buys all four silos
   at 4:02-4:47 as soon as its build plan finishes. Harmless at 150cr, but the "credits pinned
   against storage" rule may want to require *sustained* pinning.
9. **Human storage feels punitive early.** `START_CREDITS` (5000) exceeds `BASE_STORAGE` (2000)
   and overflow is only lost at the refinery, so a fresh base banks nothing from harvesting until
   it has spent down below its cap. Correct per the rules, but it reads as "my harvester is doing
   nothing" for the first few minutes.
10. **`standalone` is still unused.** Sandbags and guard towers are flagged `standalone: true` in
    `rules.ts` but the Chebyshev <= 4 build radius applies to them anyway, so forward-deployed
    defences are impossible. Decide whether to honour the flag.
11. **ConYard cost/build time are nominal** (5000cr / 30s) and it is filtered out of
    `BUILDABLE_STRUCTURES`. If Phase 7 wants an MCV or a second base, those numbers become real.

### Phase 7 (final balance)

Built: the balance numbers below, plus one new mechanic — **selling structures** (`sellBuilding` /
`updateSelling` in `systems/production.ts`, the 'S' binding in `systems/orders.ts`, the dismantle
animation in `renderer.ts`, the prompt in `ui.ts`). Tick order is unchanged; the sell clock is
retired at the top of `updateProduction`, so a sold building dies before `combat`/`removeDead` and
`victory` sees a consistent world. `__game` gained `sell(id?, player?)`.

**Numbers changed (old -> new), with the reason each moved.**

| # | Where | Old | New | Why |
|---|---|---|---|---|
| 1 | `WEAPONS.towerGun.damage` | 12 | 22 | see below |
| 1 | `WEAPONS.towerGun.warhead` | `smallArms` | `apAuto` (new) | 0.2x vs heavy made a 500cr tower irrelevant to armour |
| 1 | `WEAPONS.towerGun.range` | 6 | 7.5 | the tower must get shots in before a 5.5-tile light tank replies |
| 1 | `WEAPONS.towerGun.cooldown` | 12 | 14 | pays for the damage/warhead buff so anti-infantry output barely moves |
| 1 | `WARHEADS.apAuto` | — | none 0.9 / light 1.0 / heavy 0.6 / structure 0.4, splash 0 | between `smallArms` and `ap`: still an infantry gun, now bites armour |
| 2 | `WARHEADS.he.splash` | 30px | 50px | 30px only covered the tile it landed on; 50px reaches a packed squad's corners (33.9px). Friendly fire kept |
| 3 | `CRYSTAL_TILE_AMOUNT` | 1500 (±200) | 600 (±100) | a map held ~413k credits and 20 minutes consumed 23.7%; now ~165k, and home fields actually run out |
| 4 | `BASE_STORAGE` | 2000 | 5000 | the 5000cr opening was above the cap, so a fresh base banked nothing for minutes. `SILO_STORAGE` stays 1500 |
| 5 | `UNIT_TYPES.rocketSoldier.cost` | 300 | 250 | the cheap anti-armour answer should be buyable two-at-a-time off one 700cr load |
| 6 | `ai.ts` `PIN_FRACTION` / `LATE_EXTRA_SILOS` / `PIN_WAVE_BONUS` | — | 0.8 / 3 / 2 | late-game spending sink (below) |
| 7 | `constants.SELL_REFUND` / `SELL_TIME` | — | 0.5 / 30 ticks (1.5s) | the sell mechanic |

Everything else in the balance tables is untouched — unit hp/speed/cost (bar the rocket soldier),
all other weapons and warheads, building costs, power, `HARVEST_RATE`, `HARVESTER_CAPACITY`,
`START_CREDITS`, and every difficulty tuple.

**Selling — how it works.**

- **Binding: 'S' with exactly one of your own finished structures selected.** Left-click a
  structure (or box-select one; `boxSelect` only falls back to structures when the box caught no
  units) and press S. There is no second key and no sell cursor mode: with a *unit* selection 'S'
  is still Stop, and the two can never collide because a structure selection never contains units.
  A gold banner across the foot of the radar pane shows `[S] SELL <SHORT> +$<refund>` whenever a
  sellable structure is selected, so the affordance is discoverable without a new button.
- **50% refund, paid immediately** (`Math.floor(cost * 0.5)`: ConYard 2500, Refinery/War Factory
  1000, Comm Center 750, Guard Tower 250, Barracks 200, Power Plant 150, Silo 75, Sandbag 25). The
  refund is *not* clamped to storage, exactly like the Phase 3 queue-cancel refund — only harvester
  deposits are capped. Paying on the tick of sale is the whole point: it is the emergency cash
  button that gets a player out of the refinery-loss trap (checklist item 1).
- **The structure is inert the moment it is sold.** `status` becomes `'selling'` and every
  "is this structure working" test now reads `status === 'ready'` instead of
  `status !== 'constructing'`: `weaponOf` (a sold tower stops firing), `hasBuilding` (prereqs),
  `producerFor`, `recomputeEconomy` (power and storage drop instantly), and the harvest system's
  refinery lookups (a sold refinery stops accepting loads).
- **1.5s dismantle, then a quiet death.** `updateSelling` calls `killEntity(state, b, true)` when
  `tick >= sellAt`. `quiet` is a new optional parameter that skips the fireball effect and the
  "Structure lost" line; everything else is the ordinary death path, so the footprint is released,
  the rect is marked dirty and `removeDead` scrubs the id from the selection and control groups.
  There was never any death *damage* in this game, so "no explosion damage" needed no other change.
  The renderer draws the sold structure sinking into its own footprint (scale 1 -> 0.35, alpha
  1 -> 0.25) and skips its brackets/health bar. EVA says "Structure sold".
- **The ConYard is sellable.** Going all-in is a legitimate C&C move; nothing special-cases it.
- **Victory treats `'selling'` as alive.** `productionStructureCount` and `hasRefinery` count a
  selling structure, so a player is never declared defeated during the 1.5s window. The instant it
  actually dies the ordinary rule applies — selling your last factory with no units and under 400cr
  still loses, just one tick later, not 30 ticks early.
- **AI emergency sell.** In the critical-rebuild path, after the existing "cancel the unit queue for
  its refund" step, if the AI still cannot cover the rebuild it dismantles its own base:
  silo -> sandbag -> guard tower -> comm centre -> a *spare* power plant (never the ConYard, never a
  production structure, never the last plant, and never into a power deficit). With **no refinery
  standing its income is exactly zero**, so in that case it only commits when the whole shortfall
  can be raised — a partial fire-sale that still leaves it short would just cost it the base for
  nothing. Measured: refinery sniped at 40cr, the AI sells 4 silos + 4 towers + the comm centre in
  one decision (2050cr raised), the refinery is standing again 408 ticks (20s) later, and the free
  harvester that comes with it pays for the comm centre and two towers back.
- **AI late-game credit pin.** When credits exceed 80% of storage *and* the army is at its cap, the
  AI buys guard towers up to 4, then silos up to `MAX_SILOS + 3` (7), which raises the ceiling it is
  pinned against. On `hard` it also adds +2 to `waveSize` (once per wave, tracked by the new
  `AiState.pinBumpWave`, clamped to `waveCap`). Measured over 20 minutes on normal: towers 2 -> 4 at
  12:00, silos 0 -> 7 between 14:00 and 19:00, storage 7000 -> 17500, and the AI finishes at
  13800cr and still rising instead of frozen at its cap.

**Deviations / decisions.**

- **A new warhead id was added** (`apAuto`), extending the `WarheadId` union. Nothing was renamed
  and no existing warhead's multipliers moved; `he.splash` is the only edit to the existing table,
  and `he` is used by the howitzer alone, so the splash change touches artillery only.
- **`systems/orders.ts` and `systems/production.ts` now import each other** (orders needs
  `sellBuilding`, production has always needed `issueGroundOrder`). Every binding involved is an
  `export function`, so it is hoisted, and neither module calls the other during evaluation — safe
  under both Rollup and the CommonJS harness mirror, which exercises both import orders.
- **`Building.sellAt`** is the one new entity field (additive, optional). `AiState.pinBumpWave` is
  the one new AI field. `BuildStatus` already declared `'selling'` from Phase 1.
- **The sell refund makes the ConYard's "nominal" 5000cr price real** (checklist item 11): it is
  now the number a player gets 2500 back from. If a later phase adds an MCV, that price is load
  bearing.

**Checklist items deliberately NOT changed.**

- **(3) Minigunner vs heavy armour stays at 0.2x.** Massed cheap infantry beating tanks is not the
  game this is; the answer to armour is now a *250cr* rocket soldier, and the guard tower change
  covers the "an infantry-tech base has nothing that hurts a tank" gap. Tanks also still crush.
- **(4a) Artillery still has no minimum-range retreat** and **(4c) `arc` shots still commit to a
  point.** Both are unit *behaviour*, not balance, and kiting is the one piece of micro the game
  currently rewards. The splash widening already made artillery matter; adding auto-kite would have
  changed how it plays, not how strong it is.
- **(6) Wave timing is untouched.** First wave still leaves at 04:00 on normal (verified). Making
  first contact land earlier is a difficulty change, and the tower/rocket-soldier moves already
  shift how a defended base survives it.
- **(8) Silo over-buying was not given a "sustained pinning" rule** — raising `BASE_STORAGE` to 5000
  fixed it as a side effect. In the 20-minute run the AI now buys its first silo at 14:00 (it used
  to buy all four between 4:02 and 4:47), because its opening 6500cr is no longer miles above a
  3000cr ceiling.
- **(10) `standalone` is still unused.** Forward-deployed towers/sandbags would change map control
  more than any number in this phase; it is a feature, not a tuning knob.

**Verified.** `npm run build` clean. Eight headless harnesses (freshly built CommonJS mirror of
`src/game` + `src/engine`, outside the repo), **53/53 checks**:

- **Guard tower** (powered): kills 3 approaching minigunners in 175 ticks keeping **376/400 hp
  (94%)**; against 2 light tanks it destroys one and dies to the second, leaving the survivor on
  **52% hp** — 500cr trades into 1000cr and change, and 2000cr of armour still takes the tower.
- **Artillery**: `applySplash` at the centre of a 3x3 squad on adjacent tiles damages **9/9**
  (54/28.1/17.3 at 0/24/33.9px, corner = **34.7%** of centre); one live shell also hits 9/9, and an
  own-side minigunner standing in the blast takes full damage — friendly fire intact.
- **Economy, 20 sim-minutes at 600cr tiles** (normal, immortal human base): map crystal 165,130 at
  t0; gross AI inflow 51,751cr; second refinery at **09:00** (was ~14:00 at 1500cr tiles), home
  field empty at **11:00**, income still flowing in the last five minutes (45,473 -> 51,751), 0
  starvation ticks, 5 waves, 34 combat units at the end. Same run on hard: 55,543cr inflow, 48
  units, waveSize at its cap of 20.
- **Selling**: every structure refunds exactly 50%; refund lands on the tick of sale; status flips
  to `'selling'` and storage drops immediately; death at 31 ticks with **0 explosion effects**, no
  "Structure lost", footprint back to passable/buildable with `occupied === 0`; a sold tower fires
  0 further shots; a human whose last barracks is sold is **not** defeated during the 1.5s and
  **is** defeated the tick after it dies; AI poverty scenario recovers as described above.
- **Storage**: opening 5000cr is never clipped (still 5000 after 30s); deposits cap at 6000 with a
  refinery and no silos, and two silos carry a 9000cr bank, so ~8000 banked genuinely requires
  silos; a base at 4000cr banks its next loads instead of burning them.
- **Regressions**: medium vs light tank still ends **125/400 hp (31.3%) after 309 ticks** —
  bit-identical to the Phase 4 measurement; two 250cr rocket soldiers kill a 1000cr light tank in
  212 ticks losing one of themselves; wave launches (normal) at **04:00 / 07:19 / 09:52 / 12:35 /
  16:53**.
- **Full game**: AI vs a passive human base with four guard towers -> AI wins at **11:06**;
  **0.016 ms/tick mean, 0.025 ms p95**, worst 3.1 ms (map-gen tick), peak 23 units — budget 50 ms,
  and unchanged from Phase 5's 0.025/0.036.
- No `Math.random` anywhere in `src/game` or `src/engine` (the only one in `src` is still the audio
  noise buffer, outside the sim by construction).

**Known rough edges for the final playthrough.**

- Selling is keyboard-only. There is no sell *cursor* mode (click-to-sell like C&C1's sidebar
  button), so a player who never reads the banner may never find it.
- A structure destroyed *while* it is dismantling explodes normally and the seller keeps the
  refund. That is the classic behaviour, but it means selling under fire is strictly good.
- The AI's emergency sell can strip its comm centre, which briefly locks it out of medium tanks and
  artillery until `BUILD_PLAN` re-queues it. Correct, but it makes a sniped refinery a real tempo
  swing — worth watching in a real game.
- With 600cr tiles both sides run their home fields dry around 11 minutes and push onto the neutral
  contested fields, which still nothing defends (the Phase 5 note stands). Long games are now
  genuinely map-control games.

### Post-release: briefing & help

Player feedback after the Phase 7 playthrough: *"there are no instructions or mission objectives"* —
a new player was dropped into a base with no idea what to do or which keys did what. Three additions,
**all render/UI-side**: a mission briefing screen, an in-world objectives readout, and a controls
overlay. New files: `render/briefing.ts`, `render/hud.ts`. Touched: `render/title.ts` (phase machine),
`render/renderer.ts` (two hooks), `render/ui.ts` (footer hint), `render/sprites.ts` (font glyphs),
`main.ts` (wiring + `__game`). No system, rule or balance number moved.

**Nothing here can change the sim.** `Hud` never receives a mutable `GameState` reference outside
`draw`, the two keys it owns ('O' and 'H'/'F1') are stripped from the input snapshot before
`Sidebar.update` and `updateOrders` see them, and both preferences live in `localStorage`. The one
write into `GameState` is EVA's opening line (below), which is a `messages` entry and is posted
identically on every mission start.

**Phase machine.** `AppPhase` is now `'title' | 'briefing' | 'playing'` and `nextPhase` is
`title --start--> briefing --start--> playing`; every other action (picking a difficulty, skipping the
typewriter) is a self-transition and `'playing'` is terminal. `TitleAction` is unchanged;
`BriefingAction` (`'reveal' | 'start'`) and the `PhaseAction` union are new. **`restart()` moved**:
the title screen's deploy no longer builds a mission, it only enters the briefing — the mission is
built when the briefing deploys, so the map is still generated exactly twice on the way into the
first game (Phase 6's trade), not three times.

**Briefing (`render/briefing.ts`).** Same discipline as the title screen: while `phase === 'briefing'`
the tick returns before `camera.pan` and every system, so `state.tick` never advances and the
typewriter runs off the class's own render-frame counter (`CHARS_PER_FRAME = 3`, ~180 chars/s, 517
characters over 173 frames -> ~2.9 s at 60 fps). It draws through the existing `titleDraw` hook — `main.ts` dispatches on the
phase, so `Renderer` needed no change for it.

- **Copy** (`BRIEFING_LINES`) is a `{ kind, text }` list: header, situation, `OBJECTIVE: DESTROY ALL
  ORDER STRUCTURES.`, the defeat rule in the victory system's own words ("lose all production
  structures and cannot rebuild"), and four field directives (harvest crystal - keep power above
  drain or construction slows and radar/towers fail - build a Comm Center for radar - press [H] for
  controls). Only `text` characters are typed; rules and blank lines cost nothing, which is what
  makes `BRIEFING_CHARS` the exact typewriter total.
- **Two clicks, never one.** Click / Enter / Space while typing returns `{ kind: 'reveal' }` and dumps
  the rest of the text; the *next* one returns `{ kind: 'start' }`. A player who clicks straight
  through therefore always sees the full briefing for at least one frame before deploying, and can
  never skip it by accident with a double click. The tick returns immediately after `update`, so the
  briefing swallows every event it sees — no click leaks into box-select, same as the title screen.
- **EVA's opening line** (`Objective: destroy all enemy structures.`) is posted with `postMessage`,
  so it goes through the ordinary ticker + `SpeechQueue` path and needs no new audio API. It is
  posted from inside the mission's **first tick**, not straight after `restart()`: `Sfx.consume`
  watermarks on `state.tick`, so a message posted while the clock is still 0 is re-consumed by every
  render frame until the clock moves and EVA would say it two or three times. `objectiveLinePending`
  in `main.ts` is the one-tick deferral.

**Objectives readout (`Hud.drawObjectives`).** Two lines of 5x7 bitmap type on a semi-transparent
plate at the top-left of the *world view* (never the sidebar), drawn through the new
`Renderer.hudDraw` hook — after the sidebar, **before** the result curtain, so a decided mission dims
it along with everything else instead of fighting the headline.

- Line 1 is the objective; once `state.result` leaves `'playing'` it becomes `MISSION ACCOMPLISHED` /
  `MISSION FAILED` in the curtain's own green/red, i.e. the curtain's wording verbatim rather than the
  brief's "MISSION COMPLETE", so the two can never disagree.
- Line 2 is `ENEMY STRUCTURES: n`, but **only with radar** (`state.players[0].radar`, Phase 5's
  `commCenter && !lowPower`); otherwise it reads `UNKNOWN` in dim type. That is deliberate: it makes
  the briefing's "build a Comm Center" directive pay off visibly, and it means the panel can never be
  used to see through the shroud. The count includes structures that are `constructing` or `selling`
  (they are standing), matching how `victory.ts` counts.
- **'O' collapses it** to a `[O] OBJECTIVES` tab, persisted to `localStorage['crystal-dawn.objectives']`
  behind try/catch on both read and write, exactly like `MUTE_KEY`. The preference survives
  `restart()` on purpose; `Hud.onMissionStart()` resets only the render-side pieces.

**Help overlay (`Hud.drawHelp`).** 'H' or F1 toggles a centred panel listing 16 bindings in two
columns; Escape, another H/F1 or any click closes it. It is drawn through the new
`Renderer.overlayDraw` hook — *last of all*, over the sidebar and over the result curtain, because it
is the one thing that must stay readable whatever else is on screen. It **pauses nothing**: the
mission keeps running behind it, which is why the keyboard stays live (only pointer input is
swallowed) and the blink runs off the render counter. A window too narrow for two 300px columns gets
one tall column instead of overlapping text.

- **Input precedence** is now HUD -> sidebar -> orders. `Hud.update()` is the outermost ring and
  follows the same contract `Sidebar.update` already had: it returns the snapshot with what it
  consumed removed, and returns the *same object* when it consumed nothing. While the overlay is open
  by choice it strips `clicks`, `dragBoxes` **and** the live `drag`, so nothing box-selects, scrubs
  the radar, queues a build or restarts the mission underneath it. Escape is only swallowed while the
  overlay is open, so placement-cancel and deselect are untouched otherwise.
- **`[H] HELP` / `[O] OBJECTIVES`** sits in the sidebar between the EVA ticker and the audio footer.
  `EVA_H` went 58 -> 74 with the ticker box pinned at its old 38px (`EVA_PANEL_H`), so the panel keeps
  its Phase 6 size and only moves up 16px; the radar pane, which is anchored above it, moves with it.
- **One-time hint.** The first time a mission ever starts (`localStorage['crystal-dawn.helpSeen']`)
  the overlay auto-opens. That variant is deliberately **non-modal**: it swallows nothing, any input
  at all dismisses it, and it times out after `HELP_HINT_TICKS` (100 ticks = 5 s) if the player just
  sits there. Swallowing the first click of a first-time player's game — which is what a modal hint
  would do — is exactly the annoyance worth avoiding; the cost is that the dismissing click also does
  whatever it would normally have done, which is the correct trade.

**Font.** `sprites.ts` gained 13 punctuation glyphs (`, + = [ ] ( ) < > ? ' % *`) for the briefing and
HUD copy. Purely additive — no existing glyph moved, and unknown characters still render as blanks.

**`__game`** gained `help(show?)`, `objectives(show?)` (true = expanded) and `briefing()`
(`{ revealed, total, complete }`); `phase(next?)` now accepts `'briefing'` (rewinds the typewriter)
as well as `'title'` / `'playing'` (the latter takes the same `startMission()` path as the briefing's
deploy, from any phase).

**Restart hygiene.** The new render-side state resets through the existing single path: `restart()`
calls `hud.onMissionStart()` (closes a hand-opened overlay, re-arms the hint check, re-arms the
objective line) alongside the Phase 5/6 `renderer.buildTerrain` / `invalidateFog` / `sidebar.reset` /
`sfx.resetStream`. The briefing's typewriter is rewound by `briefing.reset()` on the title's deploy
and by `__game.phase('briefing')`.

**Verified.** `npm run build` clean. Two headless harnesses outside the repo, driving a CommonJS
mirror of the real modules: **112/112 logic checks** (phase transitions including the
skip-then-start click sequencing through `nextPhase`, `BRIEFING_CHARS` == the sum of the line
lengths and `ceil(total / CHARS_PER_FRAME)` frames to finish, the objectives counter incl. dead /
human / constructing / selling structures and the radar UNKNOWN gate, headline wording per result,
key swallowing (H/F1/O always, Escape and all pointer events only while open, other keys never),
snapshot pass-through by identity when nothing is consumed, collapse persistence round-tripped
through storage, a storage that **throws on both getItem and setItem**, the hint showing exactly once
and auto-dismissing at exactly 100 ticks without swallowing the dismissing input) and **151/151
render smoke assertions** (briefing at 6 window sizes x empty/half/full reveal x 45 frames, plus a
null terrain backdrop; the HUD at 6 sizes x playing/radar/won/lost/collapsed, help open and hidden)
asserting nothing throws and no `fillRect`/`strokeRect` ever gets a NaN or negative size.

### Post-release: stances & harvester self-preservation

Player feedback after a full playthrough: *"we should be able to set modes for the troops. like
explore (run away if attacked), defensive, offensive"* and *"the harvesters should run away if
attacked; if i move them somewhere else they just go back into danger."* Two features, both sim-side.
Touched: `game/state.ts` (new type + 5 optional `Unit` fields), `systems/combat.ts`,
`systems/harvest.ts`, `systems/orders.ts`, one guard in `systems/ai.ts`, `render/renderer.ts`,
`render/ui.ts`, `render/hud.ts`, `render/briefing.ts`, `main.ts`. No new files, no restructuring, no
balance number moved.

**Stances.** `Unit.stance?: 'explore' | 'defensive' | 'offensive'`, read through `stanceOf(u)`.
**An absent field means `'offensive'`**, so every unit that existed before this change behaves
exactly as it did — and because the AI never sets a stance, `ai.ts` is untouched by design rather
than by special-casing.

- **offensive — literally today's code path.** The free-fire branch of `stepUnitCombat` is unchanged
  for it. Worth being precise about what "offensive pursues" means here, because the brief's
  shorthand can mislead: the pursuit that exists in this game is the *commanded* one (an `attack`
  order swaps itself for a `move` order carrying `targetId` and follows its victim across the map,
  Phase 4). An **idle** offensive unit has never chased an auto-acquired target and still does not.
  That was deliberate: adding idle pursuit would change every AI unit's behaviour, which the brief
  explicitly ruled out.
- **defensive — a leashed post.** `Unit.holdPos` is the post. The unit auto-acquires out to
  `range + 2` tiles, may walk at most `DEFENSIVE_LEASH` (1.5 tiles) off the post to bring a target
  into range, stops and fires when it gets there, and walks back the moment it has nothing to shoot.
  A target it cannot reach without breaking the leash is dropped outright.
- **explore — never engages.** No acquisition, no attack-move engagement, no return fire. When
  damaged it runs `FLEE_DISTANCE` (10 tiles) directly away from whatever hit it, cancelling the
  current move order. An explicit `attack` order (or the pursuit move it turns into) still fires,
  and taking damage does **not** cancel it — player intent wins.

**How the post is anchored.** `holdPos` is set when the stance is chosen, and **cleared by every
externally issued order** (`assignOrder`, `issueAttackOrder`, `stopUnits`). The unit re-anchors on
the first idle tick after that order is discharged, which is exactly "the spot where it last
completed an order". A defensive unit's own leash walks are *self errands* — a `move` order carrying
`auto: true` and **no** `targetId` — which is the marker that distinguishes them from a commanded
pursuit (`move` + `targetId`, section 2 of combat) and from a player order. Self errands do not
clear the anchor, so leaning out and walking home does not move the post.

- **An order overrides the leash while it is active.** Move, attack and attack-move all work
  normally on a defensive unit; a commanded attack chases across the map exactly like an offensive
  one. The leash only applies when nothing but the unit's own errands are driving it.
- Errand orders carry the *exact* world point as `target` and the tile only as the pathfinding goal,
  so a unit lands on its post rather than on the nearest tile centre. `HOLD_SETTLE` (0.5 tiles) is
  comfortably above the movement system's ~7px arrival tolerance, so a unit that has just walked
  home does not immediately re-issue the walk.

**Deviation: explore ignores attack-move too.** Attack-move engagement is implemented as an `auto`
attack order, i.e. auto-engagement, so an explore unit given attack-move advances and never stops to
fight. That reads oddly if you think of attack-move as an explicit combat order, but "auto
engagement never happens" was the stricter and simpler contract, and a player who wants an explore
unit to shoot has the ordinary attack order.

**Damage attribution.** `damageEntity` gained an optional 4th parameter, `sourceId`, threaded from
`Projectile.sourceId` through `detonate` and `applySplash`. It is what explore runs *away from*.
An unattributed hit (splash from a firer that has since died, or `__game.damage` with no source)
still triggers the reflex — it just runs toward the nearest own structure instead of away from a
point it cannot compute.

**EVA.** `Unit falling back` is posted through the existing `postThrottled` backlog scan at most
once per 60 ticks (3 s), human only. Setting a stance posts `Explore/Defensive/Offensive stance`,
which is what gives the stance keys their audio feedback: `soundForMessage` maps an unknown `info`
line to the existing `unitReady` sting, so no new synth work was needed.

**Harvester self-preservation — hardwired, not a stance.** Harvesters take no stance at all
(`acceptsStance` filters them out of every setter, so the keys and the sidebar row silently skip
them in a mixed selection). Instead:

- **Shot at -> break off and run home.** `harvesterUnderFire` records `dangerTile` (the tile it was
  standing on), arms `dangerHoldUntil = tick + 240` (12 s) and issues a self errand to a dock tile
  beside the nearest own **refinery or ConYard** (`nearestHome`; a refinery wins ties by a tile,
  because a loaded harvester can dock there and the trip is not wasted). Sustained fire refreshes
  the hold every hit but only re-plans the run every 20 ticks, so a machine gun does not throw the
  path away ten times a second.
- **The hold suppresses `seeking` and `harvesting` only.** `returning` and `unloading` are allowed
  to finish, so a load already aboard is banked instead of being carried around for 12 seconds —
  and home is where the harvester was running anyway. A harvester that was empty when it was hit
  simply parks at the base until the hold expires.
- **Resume prefers a different field.** `nearestCrystalTile` gained optional `avoid` /
  `avoidRadius` arguments; once `dangerTile` is set the search runs **from the harvester's current
  position** (not from its old anchor) and skips everything within `SAFE_FIELD_TILES` (8) of the
  danger tile. **Tradeoff, deliberate:** if nothing that far away has crystal on a passable tile it
  falls back to the ordinary nearest-field search and accepts the risk — a permanently starved
  economy is strictly worse than one dangerous trip. Either way `dangerTile` is cleared once a tile
  has been picked, so a harvester is never barred from a whole quarter of the map for the rest of
  the mission. Reachability is approximated by passability, exactly as the unfiltered search has
  always done; a real path test per candidate would cost an A* per tile.
- **A player move always wins.** `issueGroundOrder` gained a `manual` flag (true only from the
  human's right-click / attack-move and from `__game.order`; production rally points and the AI
  leave it false, so a freshly built harvester still walks to its rally and starts work at once).
  A manual move order on a harvester calls `releaseHarvester`: the crystal tile and refinery bond
  are dropped, `dangerTile` is set to where it was standing, the hold is armed, and `harvestState`
  is forced to `seeking` — which the hold then suppresses. Net effect: **the harvester idles where
  the player sent it for 12 s and then re-acquires from its NEW position**, which is the direct fix
  for "I move them and they walk straight back into danger". 'S' (Stop) deliberately does *not* do
  this — stopping is not "go somewhere else", so a stopped harvester resumes its cycle as before.
- **AI harvesters get the same reflex** (it is unit behaviour, not a UI feature). One guard was
  needed in `ai.ts`: `needsMoreEconomy` reads "a harvester alive a while, still `seeking`, with no
  tile" as "the field is done", and a harvester sitting out a hold looks exactly like that. It now
  skips harvesters on a danger hold, so a raided base does not panic-buy a second refinery.

**Keys and UI.**

- **Z / X / C = explore / defensive / offensive**, applied to the whole selection. All three were
  free (the codebase only bound A, F, H, M, O, R, S and the digits). `Ctrl`/`Cmd` is excluded so the
  browser's Ctrl+Z/X/C never fires a stance change.
- **Stance tag in the world:** one 5x7 letter on a dark plate to the right of the health bar —
  `E` blue / `D` gold / `O` orange. Shown for any selected human unit **and** for any human unit not
  on the default offensive stance, so a scout left on explore is visible without selecting it. A
  letter beat a chevron here: it stays legible at a 24px tile on both house schemes.
- **Sidebar stance row:** `[Z EXP][X DEF][C OFF]`, three clickable segments across the **top of the
  radar pane**, shown only while units that can hold a stance are selected. The Phase 7 sell hint is
  a banner across the *bottom* of the same pane and needs a *structure* selected, so the two can
  never be on screen together — which is why the row needed no reflow anywhere in the strip. A drag
  that starts on the row is not treated as a radar scrub. On a window too short for a radar the row
  falls back to just above the EVA ticker.
- **Mixed-selection highlight is strict majority**, and a tie highlights nothing (documented choice:
  the row must never claim a selection is uniform when it is not). An absent stance counts as
  offensive.
- FIELD MANUAL gained `Z / X / C  STANCE EXPLORE/DEF/OFF` (and `S` was corrected to
  `STOP / SELL STRUCTURE`). The briefing gained one field directive,
  `SET UNIT STANCE WITH [Z] [X] [C]` — it fits the existing bullet list cleanly and
  `BRIEFING_CHARS` is computed from the copy, so the typewriter total follows it.

**Plumbing.** Stance is unit state, not an order: it survives every order, and it is **not** written
to `localStorage` (nothing about it is persisted; a restart builds fresh units). `__game` gained
`stance(ids, mode)`, `damage(id, amount, sourceId?)`, and four fields per harvester in
`harvestInfo()`: `stance`, `holding`, `holdTicks`, `dangerTile`. No new render-side cache was added,
so `restart()` needed no new reset call.

**Verified.** `npm run build` clean. Seven headless harnesses outside the repo (freshly built
CommonJS mirror of `src/game` + `src/engine`, plus `src/render` for the sidebar smoke),
**118/118 checks**:

- **(a) explore**: a minigunner on explore under fire from 4 tiles away ends **13.7 tiles** from its
  attacker, travels 9.7 tiles, fires **0** shots and holds no target, while the enemy does fire (the
  scenario is real); exactly **1** "Unit falling back" line in 400 ticks; the flee direction is
  away from the shooter. Under a commanded attack the same unit fires **7** shots and kills its
  target, and taking damage mid-attack does not cancel the order. Offensive control in the identical
  setup returns fire (7 shots) and does not move.
- **(b) defensive**: a light tank on post engages an intruder (**6** shots), leans out at most
  **1.05 tiles**, does **not** chase it when it retreats 30 tiles, and comes to rest **0.37 tiles**
  off its post with its stale target dropped. Offensive idle in the same scenario also does not
  chase (**0.00 tiles** — the pre-existing behaviour, unchanged); offensive **plus a commanded
  attack chases 29.9 tiles**, and so does a defensive unit given the same order (an order overrides
  the leash). A player move re-anchors the post **7.8 tiles** away; a unit shoved 4 tiles off post
  with no order walks back to within **0.36 tiles**.
- **(c) setter**: a 5-unit mixed selection applies to **4** (infantry, tank, artillery, engineer) and
  leaves the harvester with no stance at all through explore/defensive/offensive round-trips;
  defensive anchors a post and switching away clears it; dead units are skipped; `stanceSelection`
  drops harvesters; majority is right for uniform, 3-v-1, 2-v-2 (null) and empty selections.
- **(d) harvester**: shot mid-gather with 400cr aboard it arms a **240-tick** hold, records the tile,
  breaks off, closes to **2.35 tiles** of the refinery, banks the load (**+425cr**), never harvests
  during the hold, ends **11.4 tiles** east of where it was hit, then resumes on the far field
  **27.1 tiles** from the danger tile and keeps earning. Given a manual move mid-flee it drops both
  bonds, arrives **0.22 tiles** from the destination with **57 ticks** of hold left, sits there
  idle (`seeking`, no tile, no order), never heads back west, and then works the **east** field
  (26.0 tiles from the old danger tile) — not the field it was pulled off. With only one field on
  the map it falls back to it and income resumes. An AI harvester arms the same hold.
- **(e) AI economy, 20 sim-minutes (seed 1337, normal)**: baseline **52,550cr** gross inflow, waves
  at **04:00 / 06:42 / 10:00 / 13:26**, 37 units, second refinery built, **0** harvester
  hold-ticks — i.e. nothing ever shot an AI harvester, so the new harvest path never ran and the
  baseline run is unchanged by construction. Re-running the same seed is bit-identical. A second run
  that deliberately shoots an AI harvester **every 30 s** (37 raids, 8,365 hold unit-ticks) still
  banks **42,930cr** (82% of baseline), still earns **6,281cr in the last five minutes**, is never
  broke for more than **99 ticks**, still launches 4 waves, and still builds exactly **2**
  refineries — the hold does not fight the rebuild logic.
- **(f) combat regression**: medium vs light tank, both offensive, ends **125/400 hp after 309
  ticks** — bit-identical to the Phase 4 and Phase 7 measurements. A defensive medium tank defending
  its own post against the same light tank produces an identical result (125 hp, 313 ticks): the
  leash limits movement, never damage.
- **(g) perf**: 150 v 150 mixed armies attack-moving into each other, with 50 human units on
  defensive and 50 on explore so the new branches are inside the hot loop —
  **0.233 ms/tick mean, 0.546 p95, 3.264 ms worst** over 600 ticks (budget 10 ms), 215 of 300 units
  dead by the end.
- **Sidebar smoke** (real `Sidebar.draw`/`update` through a recording stub context): the row is
  absent with nothing selected, absent for a harvester-only selection, present with mixed units,
  never on screen with the sell hint, draws clean geometry at full and short window heights, and a
  click on each of the three segments sets the matching stance on the non-harvester units and posts
  the EVA line.

**Known rough edges.**

- The defensive leash is only observable when the unit is on its own — which, given idle offensive
  units never chased either, means defensive's practical value today is "leans out 1.5 tiles to
  shoot, and walks back if shoved or after an engagement" rather than "unlike offensive, it does not
  chase". If a later pass ever gives idle offensive units real pursuit, the contrast becomes the
  headline behaviour and nothing about defensive has to change.
- A harvester pulled off its cycle by hand always idles for the full 12 s, even if the player moved
  it somewhere completely safe. That is the brief's design (it is what stops the walk-back), but it
  is a real 12 s of lost income per manual reposition.
- Explore units under attack-move never fight (above). Explore units also do not flee from damage
  they take while executing a commanded attack, by design — which means an explore unit told to
  attack something bigger than it will die there.

#### Manager fixes after live verification (stances phase)

Two harvester-flee defects survived the headless harness and were caught driving the real page:
1. **Flee destination could sit inside the kill zone** — "run home" targeted the nearest own
   refinery dock even when that dock was 1–2 tiles from the shooter (field raided beside its own
   refinery); the harvester parked there and died under fire. Now `harvesterUnderFire` receives the
   attacker id: if the home dock is closer than `FLEE_MIN_GAP` (6 tiles) to the shooter (or no home
   exists), the harvester runs `FLEE_AWAY_TILES` (10) directly away from the shooter instead.
2. **The reflex stomped player orders** — the every-20-ticks flee re-plan cleared and reissued the
   order unconditionally, overriding a manual rescue move within a second. A live non-`auto` order
   now short-circuits the re-plan (hold stays armed; the player keeps the wheel).

### V2: air units

The first unit that does not touch the ground. One new structure (**Helipad**), one new unit
(**Gunship**), and a targeting rule that splits the roster into things that can shoot up and things
that cannot. New file: `game/systems/air.ts` (the ammo/rearm cycle). Touched: `game/rules.ts`,
`game/state.ts`, `systems/{movement,combat,orders,production,ai}.ts`, `render/{sprites,renderer}.ts`,
`render/{hud,briefing}.ts`, `main.ts`. **No existing balance number moved**, no file was
restructured, and `systems/victory.ts` was not touched at all.

Tick order is now
`[hud -> sidebar -> orders] -> movement -> harvest -> **air** -> production -> combat -> fog ->
removeDead -> ai -> victory`. `updateAir` sits beside `updateHarvest` for the same reason harvest
sits there: both need "the unit arrived this tick", which movement has just decided.

**The data.**

| | value |
|---|---|
| `helipad` | 2x2, 1000cr, -10 power, 14s build, prereq `warFactory`, `produces: ['air']`, `productionStructure: false` |
| `gunship` | 1200cr, 190hp, **light** armour, speed **5.6** (buggy is 5.0), turn 0.34, sight 8, radius 10, 11s build, `producedAt: 'helipad'`, prereq `['helipad']` |
| `gunshipRockets` | 55 damage, `rocket` warhead, range 5, cooldown 12, homing, **6 rounds**, 6s rearm |

Two flags carry the whole air/ground split, so **nothing anywhere checks a type name**:

- **`UnitTypeDef.isAir`** — flies. Read by movement (no A*, no passability, air-only separation),
  by orders (formation slots ignore passability), by production (spawns on the pad) and by the
  renderer (drawn last, with a shadow).
- **`Weapon.targetsAir` + `Weapon.vsAirScale`** — may this gun engage an aircraft, and at what
  multiplier. `machinegun` true/**0.5**, `rocketLauncher` true/1, `towerGun` true/1,
  `gunshipRockets` true/1; `lightCannon`, `mediumCannon` and `howitzer` are **false**.
- **`UnitTypeDef.ammo` / `rearmTime`** — a finite pod. 0 (every ground unit) means unlimited and
  every ammo code path is a no-op for them.

**Damage, and why 55.** `rocket` is 1.0x vs heavy armour, so a full pod is `6 x 55 = 330`: it
**kills a 300hp light tank and leaves a 400hp medium tank on 70hp**. That is the whole balance
statement — a gunship sortie trades up against light armour and forces a medium tank to disengage,
but never deletes one, and the aircraft then has to spend ~6s of flying plus 6s of rearm before it
can do it again. Against infantry (`rocket` 0.5x vs none) a rocket is 27.5, so the pod is worth
about eleven minigunners.

**Who can shoot back, in both directions.** `canWeaponHit(weapon, target)` is asked in *four*
places, which is what makes the rule symmetric rather than a rendering trick: target acquisition
(a tank never even sees an aircraft), the commanded-attack branch (an attack order on an aircraft is
dropped rather than pursued), `issueAttackOrder` (a unit that cannot reach the target is treated
exactly like an engineer — it is sent to the spot instead), and detonation. `Projectile` gained one
field, **`weapon?: WeaponId`**, so a round in flight still knows the rules it was fired under; this
is the first genuinely *gameplay* data on a projectile beyond damage/warhead, and it is what makes
an artillery burst pass harmlessly under a hovering gunship instead of splashing it.

- Anti-air today: rocket soldier (250cr, full damage), guard tower (full damage), other gunships,
  and machine guns at half.
- **The scout buggy also plinks at air**, because it carries the same `machinegun` the minigunner
  does and the flag lives on the *weapon*, not the unit. That was not in the brief; it is the
  correct consequence of not hardcoding type names, it is thematically right (a pintle MG), and at
  4 damage a shot it is a nuisance rather than an answer. Flagged rather than special-cased.

**Flight model.** `steerAir` in `movement.ts` is the ground steering with every ground constraint
removed: turn toward the destination at the type's own turn rate, advance along the new facing, no
path, no `moveClamped`, no terrain-cost multiplier. It keeps the pivot/slow-turn feel
(`PIVOT_ANGLE` / `SLOW_TURN_ANGLE`) so aircraft and vehicles read as one game. Straight-line travel
is therefore exactly `distance / speed` ticks once the turn is done — measured 213 ticks over 50
tiles against an ideal of 214.3.

- **Separation is air-only.** A pair is skipped entirely when `isAir` differs, and air-air pushes
  are scaled by `AIR_SEPARATION_SCALE` (0.5) so a flight fans out without shoving. A gunship
  hovering in a blob of eight medium tanks moves **0.000px**.
- **Orders.** `formationTiles` gained a `flying` flag that skips both passability tests, and
  `issueGroundOrder` splits a mixed selection into a ground order and an air order (each half is
  uniform, so the recursion terminates in one step). With no aircraft selected the expression is
  the old one exactly. This is what lets a gunship be sent onto a cliff or over its own base;
  without it the ground code would have clamped the destination to the nearest open tile.
- **Fog is unchanged.** Aircraft are ordinary units to `fog.ts` and to
  `isEntityVisibleToHuman`, so they reveal and are revealed exactly like a buggy.

**The pod — ammo, rearm, retreat.** All of it is in `air.ts`, and all of it goes through the same
"self errand" contract the harvest system and the defensive stance already use: the system only ever
issues `move` orders carrying `auto: true`, and it **never overrides a live commanded order**.

1. **Fire six rockets** (12-tick cadence -> 3.6s to empty). `tryFire` spends the round.
2. **An empty pod cannot fight.** Section 0 of `stepUnitCombat` drops the target and completes any
   attack / pursuit order, so the aircraft goes *idle* — which is precisely the signal `air.ts`
   waits for. A commanded **move** is deliberately left alone: it can still be flown somewhere, it
   just cannot shoot on the way.
3. **Auto-return to a free own pad.** `padId` is a soft reservation — a pad is free when no other
   living aircraft names it — so two gunships never fight over one pad; the second waits and takes
   its turn. Nearest pad wins, ties break on id.
4. **Dock and rearm.** Within `DOCK_RANGE` (0.6 tiles) the aircraft snaps to the pad centre, clears
   its order, and sits there for `rearmTime` (**120 ticks / 6s**) with `docked = true`. Movement
   skips docked units and separation excludes them, so it stays put; the air system re-pins its
   position every tick so nothing can nudge it off.
5. **Re-engage.** The pod refills, `docked` clears, the reservation is released, and it is an
   ordinary unit again — still standing on the pad, ready for the next order.

- **A manual order interrupts the return, and the return re-attempts itself.** Any non-`auto` order
  makes `air.ts` step aside and drop the reservation; because the retry is driven by "the aircraft
  is idle", the trip resumes by itself the moment that order is discharged. Measured: pulled 66
  tiles off course mid-return, it arrives within **0.23 tiles** of where it was sent, sits, then
  docks **141 ticks** later on its own.
- **A commanded order also scrambles a docked aircraft**, part-rearmed. That is deliberate: an
  emergency is an emergency, and the alternative (ignoring the player for up to 6s) is worse.
- **No pad at all** — never built, or all of them destroyed — the aircraft falls back to a ring
  `PERIMETER_TILES` (3) from its nearest own structure and idles there, with **one** EVA line,
  `No helipad available` (`airNoted` latches it). With no structures at all it simply stops where
  it is. It re-tries the moment a pad exists.
- **Losing the pad under a docked aircraft** (destroyed or sold) undocks it cleanly on the next
  tick with no stale reservation.

**Renderer.** `drawUnits` is now two passes — every ground unit, then every aircraft — so aircraft
composite over ground units *and* over the structures drawn before them. `drawUnit` is the extracted
per-unit body; nothing about ground rendering changed.

- **Shadow**: a soft ellipse offset **6px** down-right (a quarter tile — deliberately not subtle,
  it is the only altitude cue), dropping to **2px** while docked, which reads as wheels down.
- **Rotor**: a separate cached sprite, 4 frames. It is *orientation independent* — a spinning disc
  looks the same whichever way the airframe points — so it is cached per (player, frame) rather
  than per facing, 8 sprites instead of 128. It steps every tick while airborne and freezes on
  frame 0 at 55% alpha while docked.
- **Ammo pips**: six gold pips above the health bar of a selected aircraft; spent rounds stay as
  dark sockets so the magazine size is always readable.
- **Rearm bar**: a gold progress bar under a docked aircraft, drawn whether or not it is selected,
  so a player can see the pad is busy at a glance.
- No new render-side cache was added (the rotor lives in the existing `unitCache`, which
  `initSprites` already clears), so `restart()` needed no new reset call.

**Art.** Gunship: slim fuselage, bubble canopy well forward, stub wings with two rocket pods, tall
tail fin — a silhouette that shares nothing with the ground roster. Helipad: tarmac square with a
painted touchdown circle and H, four gold approach lights, and a service shed with a windsock, so it
never reads as a silo. Both house schemes, plus purpose-drawn sidebar icons in the Phase 3 schematic
style (the Phase 6 note about not downscaling the world art still holds).

**`__game.spriteAudit()` is now 566 entries** (was 520), **+46**: 32 gunship hulls (16 facings x 2
players), 8 rotor frames (4 x 2 players), 4 helipad frames (2 players x ready + constructing), and
2 sidebar icons. 0 blanks.

**AI.** Two changes, both difficulty-gated so **an easy AI is bit-identical to the pre-V2 one**
(verified: it never builds a pad, never fields aircraft, and its 20-minute run is unchanged).

- `BUILD_PLAN` entries gained an optional `only` list; `{ type: 'helipad', count: 1, only:
  ['normal', 'hard'] }` sits immediately after the war factory. Because the plan doubles as the
  rebuild list, a razed pad re-queues itself for free.
- `stepUnits` buys aircraft **outside** the weighted roll: from wave 3 on, normal keeps 1 in the
  field and hard keeps 2 (`AIR_WANTED`). The roll is a *composition* model for the ground army and
  letting aircraft into the pool would have re-tuned every existing wave; buying them separately
  leaves the ground mix untouched. Everything after the purchase — the army cap, the rally group,
  wave assembly, the attack logic — treats a gunship as an ordinary combat unit.
- **One narrow wave-logic touch, and it is the "fold into waves" requirement itself.** The rally
  list is sorted by id and the wave takes `slice(0, waveSize)`, so a gunship — always the newest
  thing in the base — was sliced off the end and sat out every wave it was built for (measured: on
  normal it missed wave 3 entirely and only joined wave 4). Aircraft now go to the front of that
  slice. Size, clock, target and the ordering of the ground units are all untouched, and **with no
  aircraft in the rally the expression is `r.rally` again**, which is why easy is unchanged. A
  docked or empty aircraft is held back for the next wave rather than launched with no rockets.
- `isIdle` now returns false for a docked aircraft, so the rally/attack logic does not scramble it
  half-armed every decision. AI aircraft use exactly the same ammo/rearm cycle as the human's.

**Victory is untouched.** `helipad.productionStructure` is `false`, so the defeat rule is still
ConYard / Barracks / War Factory only and `CHEAPEST_PRODUCTION` is still 400. Verified explicitly:
a player whose only structure is a helipad, with no units and no credits, **is** defeated; losing
your pads while a barracks stands is **not** a loss.

**`__game`** gained **`airInfo(player?)`** — the ammo readout — returning
`{ id, type, ammo, maxAmmo, docked, padId, rearmTicks, order, pos }` per aircraft.
`spawn('gunship', tx, ty, player)` works unchanged (`createUnit` fills the pod from
`UNIT_TYPES[type].ammo`).

**UI plumbing.** The sidebar needed no code change at all: `BUILDABLE_STRUCTURES` /
`BUILDABLE_UNITS` are derived from the type tables, and the existing prereq system greys the
gunship out until a helipad stands. FIELD MANUAL gained one row
(`GUNSHIPS  FLY ANYWHERE, REARM AT PAD`) and the briefing one field directive
(`HELIPADS ARM GUNSHIPS - 6 ROCKETS, THEN REARM`); `BRIEFING_CHARS` is computed from the copy, so
the typewriter total follows it. Two new EVA lines, `Aircraft rearmed` (info) and
`No helipad available` (warning), both land on the existing `soundForMessage` fallbacks — no audio
work was needed.

**Deviations / decisions.**

- **The buggy can shoot at air** (above): a consequence of flagging weapons rather than units.
- **`Projectile.weapon` is sim state**, unlike the render-only `Effect.weapon`. It is read back by
  `detonate` / `applySplash`; a round with no weapon tag (a test helper's) behaves as ground-only.
- **Aircraft spawn *on* their pad**, not beside it: they need no open ground, and a pad hemmed in by
  structures must still be able to produce. They also get **no default rally hop** (the ground
  default walks a fresh unit 3 tiles clear of the door, which an aircraft has no reason to do); an
  explicit rally point is still honoured.
- **Air units still take ground *orders* through `issueGroundOrder`**, including attack-move and
  stances. Explore/defensive/offensive all work unchanged — a defensive gunship leashes to a hover
  post, an explore one runs from whatever hit it.
- **No anti-air-only structure was added.** The guard tower already had `apAuto` at range 7.5 from
  Phase 7 and makes a perfectly good AA emplacement; adding a dedicated SAM would have been a
  balance change on top of a feature.

**Verified.** `npm run build` clean. Eight headless harnesses outside the repo (a freshly built
CommonJS mirror of `src/game` + `src/engine`, plus `src/render/sprites.ts` driven through a
pixel-accurate software canvas), **141/141 checks**:

- **(a) flight**: over a 4-tile rock/cliff wall spanning 90 tiles and straight over a war factory,
  a gunship crosses 50 tiles in **213 ticks against an ideal 214.3** (`distance / 5.6`) and holds an
  A* path for **0** ticks; the light tank sent between the same two points detours around the wall
  and takes **877 ticks against its own 333-tick straight line (x2.63)**, never entering it. A
  gunship ordered onto an impassable cliff tile keeps that tile as its destination and parks on it.
  Air ignores ground separation exactly (0.000px displacement inside a blob of 8 medium tanks).
- **(b) ammo cycle**: exactly **6** rockets leave the pod, empty at t=183, docked on the reserved
  pad at t=302 (**119 ticks** flying home), pad centre to **0.000px**, full at t=422 — **120 ticks
  docked, i.e. exactly 6s** — then it re-engages for another **6**. A manual order mid-return is
  honoured (arrives within **0.23 tiles**, **141 ticks** later it docks by itself). Two aircraft
  **never** share one pad and both still get rearmed in turn. With no pad it holds a **3.78-tile**
  perimeter, docks never, and posts the EVA line **exactly once**. An empty pod fires **0** shots.
  Killing the pad under a docked aircraft undocks it with no stale reservation.
- **(c) damage + targeting**: a 6-rocket run **kills a light tank in 6 rockets** and leaves a medium
  tank on **70/400 hp**. Light tank / medium tank / artillery **never acquire, never fire and deal
  0 damage** to air; rocket soldier, gunship, minigunner and guard tower all acquire, fire and
  damage it. Minigunner does **exactly 0.5x** (4.00 -> 2.00 damage per shot against the same light
  armour class), rocket soldier exactly **1.0x**. An artillery shell that damages a ground target
  does **0** to the gunship hovering over the impact. A commanded attack on an aircraft by a medium
  tank comes out as a plain `move` with no pursuit target. A gunship engages enemy *air* on its own.
- **(d) AI, 20 sim-minutes, seed 1337** (baseline in brackets = the stances phase). **Normal**:
  war factory 01:08, **helipad 01:22**, first gunship 07:19; waves **04:00 / 06:57 / 10:18 /
  13:39** [04:00 / 06:42 / 10:00 / 13:26] with **1 gunship from wave 3 on**; gross inflow
  **54,790cr** [52,550]; 37 units [37]; 2 refineries; 72 rockets fired and **12 rearms** in the
  field. **Hard**: helipad 01:22, waves 03:00 / 05:27 / **07:39 (2 air)** / 10:53 (2) / 14:33 (2),
  54,621cr, 51 units, 174 rockets, 28 rearms. **Easy**: no helipad, **0** gunships, waves 05:30 /
  10:08 / 14:49 — unchanged.
- **(e) regression**: medium vs light tank, same seed and tiles, still ends **125/400 hp after 309
  ticks** — bit-identical to Phase 4, Phase 7 and the stances phase. A* is untouched: 4/4 cross-map
  paths complete with an unchanged waypoint signature, the same query twice gives an identical list,
  and a wall is never routed through. The 50-tank group move still lands everyone within **4.6
  tiles** of the rally at **20.0px** minimum separation. The same seed replays bit-identically.
- **(f) perf**: 150 v 150 mixed armies attack-moving into each other **plus 12 gunships and 4
  helipads**, with the rearm cycle live inside the hot loop — **0.509 ms/tick mean, 1.030 p95,
  6.061 ms worst** over 600 ticks (budget 10 ms), 231 of 312 units dead by the end.
- **(g) sprites**: **566 entries, 0 blanks** (was 520, +46 exactly as budgeted). Thinnest new
  sprite is a rotor frame at 356 opaque px; the gunship hull is 712 and the helipad 2304.
- **(h) victory + plumbing**: helipad is not a production structure, the production set is still
  exactly `barracks,conyard,warFactory`, `CHEAPEST_PRODUCTION` is still 400, a helipad-only player
  is defeated and a barracks-only player is not; the gunship is gated on the pad and un-gated the
  moment one stands (and re-gated when it dies, without losing the game); a queued gunship rolls out
  **on the pad centre** with a full pod for **exactly 1200cr**; the pad draws exactly 10 power.

**What to eyeball in the browser.** Build a War Factory, then a **Helipad** (structures tab, 1000cr)
and a **Gunship** (units tab — greyed until the pad stands). Watch for: the offset drop shadow and
the spinning rotor as it flies, that it crosses cliffs/rock and passes straight over buildings, the
six gold ammo pips above its health bar when selected (draining one per rocket), the automatic
flight home when the pod empties, and the **docked** look on the pad — tight shadow, frozen rotor,
gold rearm bar counting up. Then check the helipad art itself (H marking, corner lights, windsock)
against The Order's crimson scheme, and confirm a medium tank simply ignores a gunship overhead
while a guard tower or rocket soldier shoots it down.

### V2: engineer capture & map variety

Two features. **Engineer capture** finally makes the `capture` OrderKind (declared in Phase 1, inert
ever since) do something: an engineer walks into an enemy structure and it changes hands. **Map
variety** takes the seed the whole sim is already parameterised on and puts it on the title screen.

New file: `game/systems/capture.ts`. Touched: `game/rules.ts`, `game/state.ts`, `engine/rng.ts`,
`systems/{orders,combat,air,harvest}.ts`, `render/{title,briefing,ui,hud}.ts`, `main.ts`.
No file was restructured, no balance number moved, and `systems/{victory,ai,production,movement}.ts`
were not touched at all — both features fall out of predicates those files already ask.

Tick order is now
`[hud -> sidebar -> orders] -> movement -> harvest -> air -> **capture** -> production -> combat ->
fog -> removeDead -> ai -> victory`. `updateCapture` sits with `harvest` and `air` for the same
reason they do: it needs "where did the unit end up this tick", which movement has just decided. It
runs *before* `production` so a captured structure's power/storage books settle in the same tick.

---

#### 1. Engineer capture

**Three moving parts, and only one of them is new state.**

1. **Intent — `Unit.captureId`** (one new optional field). It lives on the *unit*, not on the order,
   because the movement system owns the order and may finish it (arrival) or abandon it (stuck /
   give-up), and the intent has to outlive both. It is cleared by every **externally issued** order —
   `assignOrder`, `issueAttackOrder`, `stopUnits` — which is exactly the contract `holdPos` already
   had: player intent always wins.
2. **Approach — a plain `{ kind: 'capture', targetId, tile }` order** pointed at a passable tile
   touching the footprint (`dockTile`, the harvest system's existing helper). **`'capture'` was added
   to `MOVE_KINDS`**, so the ordinary movement system does all the driving — A*, steering,
   separation, repathing. `capture.ts` steers nothing.
3. **Contact — `CAPTURE_RANGE`, 1.2 tiles** to the nearest footprint edge. That number is derived,
   not guessed: the worst *adjacent* tile is a diagonal corner, whose centre is `hypot(12,12)` =
   17.0px out, and movement parks a unit anywhere inside its arrival tolerance
   (`max(TILE*0.3, radius*0.7)` = 7.2px for infantry) of that centre — 24.2px, reachable while
   genuinely standing against the wall. 28.8px covers it with room for a separation nudge and still
   cannot reach a non-adjacent tile, whose nearest centre is 36px out. (Measured first at 0.9 tiles;
   a refinery capture stalled at **0.968 tiles** — the harness caught exactly this case.)

**The conversion is total, and it is nearly free.** Everything a structure *does* is derived from
`b.player` at read time — `hasBuilding` (prereqs), `producerFor` (production routing),
`recomputeEconomy` (power / storage / radar), `canSell` (sell rights), `weaponOf`, the AI's
`countBuildings`, `victory.productionStructureCount`. So the transfer is one assignment plus a
`recomputeEconomy`. **HP is untouched** — you capture a wreck as a wreck. Footprint, `occupied` grid
and `status` are untouched too.

What *does* need explicit work is the state other entities hold **about** the building:

- **A helipad's aircraft never changes sides.** Every unit whose `padId` names the captured pad is
  kicked airborne (`docked = false`, `rearmAt` cleared) and its reservation dropped; `air.ts` then
  re-pads it on another own pad or flies it to the base perimeter through its existing no-pad path.
  `updateAir`'s two pad lookups gained an owner test as the belt-and-braces half of the same rule
  (they previously matched on id alone, which was correct until ownership could change).
- **A refinery's harvesters unbond** through the existing `releaseHarvester` path — bond dropped,
  danger hold armed, `harvestState` forced to `seeking` — so they sit out the 12s hold and then
  re-acquire from where they stand. `stepUnloading` gained the same owner test for the same reason:
  a captured refinery must stop banking the *previous* owner's loads.
- **Queue, rally point and turret target** belong to the old owner and are dropped. The losing
  player's *build* queues are untouched — those live on `PlayerState`, not on the building.
- **Selection / control-group hygiene**: a structure that leaves the human's hands leaves their
  selection and every control group. Nothing is auto-selected on the winning side.
- **The engineer is consumed, not killed.** `killEntity` gained one line: its **unit** branch now
  honours the `quiet` flag Phase 7 added for the sell path, so a spent engineer neither explodes nor
  posts "Unit lost". `quiet` still defaults false, so every other death is unchanged.

**The right-click rule, in one sentence:** on an enemy **structure**, engineers in the selection get
a `capture` order and everything else gets the ordinary `issueAttackOrder`; on an enemy **unit**,
nothing captures and engineers fall through to the Phase 4 "unarmed units are sent to the spot"
path. Shift still queues. The split lives in `orders.ts`'s context-order branch and is gated on
`isCaptureTarget`, so a structure that is still going up — or one its owner is dismantling — is not
a legal target and the whole selection just attacks it.

**Flags, not type names.** `UnitTypeDef.captures` is a new required field (false on all eight other
units, true on the engineer), matching how `isAir` was added in the air phase. Nothing anywhere tests
for the string `'engineer'`.

**EVA**: `Structure captured` (info) for the capturing player, `Structure lost` (alert) for the
victim, human side only, both through the existing `postThrottled` backlog scan at most once per 60
ticks (3s). `postThrottled` was exported from `combat.ts` for it — no new throttling mechanism, and
still no module-level state.

**AI response.** The AI needed **zero** changes, and that was verified rather than assumed: its build
plan doubles as its rebuild list and is driven by `countBuildings`, which counts
`b.player === PLAYER_AI` — a captured structure is simply absent, exactly as if it had been razed, so
it re-queues itself for free. `baseBuilding` already falls back to "first surviving structure" when
the ConYard is gone. **The AI does not use engineers itself** (it never queues one and never has);
capture is a human capability in v1. Flagged for a later pass rather than special-cased.

**Deviations / decisions.**

- **`'capture'` is a move kind.** That is what makes the approach ordinary path-following instead of
  a second steering implementation. The consequence is that `isMoveOrder('capture')` is now true,
  which also means a *manual* capture order on a harvester would call `releaseHarvester` — harvesters
  cannot capture, so the branch is unreachable, but it is worth knowing it is there.
- **The intent survives a self errand, not a player order.** An explore-stance engineer that is shot
  at flees (a `move` carrying `auto: true`) and then *resumes* its capture run, because `capture.ts`
  re-issues the approach on the first tick the unit is idle. A player order clears `captureId`
  outright. That asymmetry is deliberate: fleeing is the unit's own errand, not a change of orders.
- **Only `'ready'` structures are capturable.** Same test as `hasBuilding` / `weaponOf` /
  `recomputeEconomy`. A structure being sold cannot be stolen out from under the sale.
- **A walled-in target cancels the run** rather than wedging the engineer: if `dockTile` finds no
  passable tile touching the footprint, the intent is dropped.
- **No sell-style keyboard affordance and no cursor mode.** There is no hover-cursor concept in the
  codebase (`HudInfo.pointerX/Y` exist but nothing reads them), so the discoverability hook is a
  banner in the radar pane's footer — `[RMB] CAPTURE ENEMY BUILDING` — sharing the slot the Phase 7
  sell hint uses. The two can never collide: selling needs a *structure* selected, capturing needs
  units, and a structure selection never contains units.
- **Capturing the enemy's last production structure wins the mission on the same tick.** `victory.ts`
  is untouched; it just counts one fewer building on the next pass, which is the pass in the same
  tick. Verified both ways — it does *not* fire while the loser still has an army and a refinery.

---

#### 2. Map variety

`createGameState(seed)` was already fully parameterised, so this is plumbing, not generation work.

**The four curated maps** were picked by generating 600 maps headlessly, keeping the ones that are
*valid* (both start areas clear + buildable, six crystal fields, a start-to-start A* path) and then
maximising layout difference across four rock-density buckets:

| | seed | sector | rock+cliff | crystal | field centres |
|---|---|---|---|---|---|
| **ALPHA** | 355 | 0163 | 10.7% | 165,091 | (23,21)x60 (72,74)x66 (52,48)x35 (17,74)x41 (76,21)x42 (51,17)x33 |
| **BRAVO** | 187 | 00BB | 12.9% | 173,627 | (23,21)x74 (76,75)x70 (47,47)x46 (25,71)x38 (69,21)x30 (41,16)x30 |
| **CHARLIE** | 84 | 0054 | 18.6% | 159,150 | (26,24)x68 (72,74)x58 (51,46)x33 (26,73)x43 (68,19)x30 (59,24)x37 |
| **DELTA** | 245 | 00F5 | 23.5% | 168,726 | (23,21)x72 (72,74)x58 (44,43)x40 (22,65)x32 (74,27)x41 (50,24)x35 |

Rock/cliff cover more than **doubles** from ALPHA to DELTA (ALPHA is open ground with room to
manoeuvre; DELTA is a maze), no two of them agree on more than **53%** of their tiles (min 46.8%,
max 61.4% differing), and the mean nearest-neighbour gap between their field centres is **5.5-6.6
tiles**. Field *anchors* are fixed by the generator (home field toward centre, four neutral anchors),
so the fields move by roughly the generator's own jitter — the headline difference between the maps
is terrain, which is what actually changes how a game plays.

**The seed's journey**, and the one sanctioned exception to determinism:

- `render/title.ts` owns `MAPS`, `seedFor(choice)` and **`rollMapSeed()`** — the only
  non-seeded entropy in the sim's lifecycle. It is `Math.random() ^ Date.now()`, it lives in
  render-side title input handling, it runs before any `GameState` exists, and its entire output is a
  *number*. Everything downstream is a pure function of it, so the sim is exactly as deterministic as
  it was. **Nothing in `src/game` or `src/engine` may call it**; `Math.random` still appears exactly
  twice in `src`, here and in the audio noise buffer.
- `TitleAction` gained two members: `{ kind: 'map', map, seed }` (row click) and the existing start
  action now carries `{ map, seed }`. Both are *resolved* seeds — RANDOM rolls at click **and** again
  at deploy, so two RANDOM missions are two different maps. `nextPhase` was not changed: it only
  reads `action.kind`, and `'map'` is a self-transition on the title exactly like `'difficulty'`.
- `main.ts` stashes `mapChoice` + `mapSeed` from the action and `newGame()` builds
  `createGameState(mapSeed)`. **`restart()` replays the stashed seed, never a fresh roll** — so R
  after a defeat is the same map, and returning to the title is how you change it. `GAME_SEED` is no
  longer read at boot; it is now documented as the *regression* seed every baseline in this file is
  measured on.

**Title layout.** A second row of five buttons (`ALPHA BRAVO CHARLIE DELTA RANDOM`) under a
`SELECT SECTOR` caption, spanning exactly the same width as the difficulty row so the two read as one
panel at any window size. `menuTop` now reserves the whole block's height, so the deploy button never
falls off a short window. The map row is pointer-only (1/2/3 still pick difficulty, Enter/Space still
deploy, a click anywhere outside the buttons still deploys on the current selection). The chosen
map's sector code sits under the deploy button.

**Sector tag.** `sectorCode(seed)` is the low 16 bits of the seed in hex — `SECTOR 0163`. The
briefing header carries `MAP <NAME> - SECTOR <CODE>`, right-aligned on the title line. It is
deliberately **not** part of `BRIEFING_LINES`, so it costs no typewriter characters and
`BRIEFING_CHARS` is unaffected by it (the briefing *did* gain one field directive,
`ENGINEERS CAPTURE ENEMY STRUCTURES - RIGHT CLICK`, and `BRIEFING_CHARS` is computed from the copy,
so the typewriter total follows it).

**Nothing assumed the fixed seed.** `grep GAME_SEED` had exactly one consumer (`main.ts`'s
`newGame`). Minimap, terrain, fog, AI home-field selection, staging and placement all key off
`state.map` / `map.startTiles` / `map.crystalFields` already, and `restart()`'s existing three cache
resets (`renderer.buildTerrain`, `renderer.invalidateFog`, `sidebar.reset`) needed no new call —
they were verified against a *different* seed rather than a same-seed restart.

**`__game`** gained **`capture(engineerIds, buildingId)`**, **`captureInfo(player?)`**
(`{id, player, targetId, distance, order}` per capture-capable unit), **`mapSeed()`** and
**`map(choice?)`** (reads, or selects and resolves a seed for the next mission). `restart()` respects
the selected seed, unchanged in signature.

---

**Verified.** `npm run build` clean. Seven headless harnesses outside the repo (a freshly built
CommonJS mirror of `src/game` + `src/engine` + `src/render`, driving the real modules through the
real tick order, with a recording 2D context for the title/briefing smoke), **293/293 checks**:

- **(a) capture basics, 48 checks.** An engineer takes an enemy power plant at **tick 31**:
  ownership flips, **hp stays at 137**, status stays `ready`, the footprint stays occupied, power
  moves **100 -> 0 / 0 -> 100**, sell rights invert (the human then sells it for exactly **150cr**),
  the engineer vanishes with **0** explosion effects and **no** "Unit lost", and EVA says "Structure
  captured". A captured silo carries **+1500 storage** and a captured comm centre moves radar to the
  human and takes it off the AI. A mixed selection right-clicking the plant splits **engineer ->
  capture / medium tank -> attack (targeting the plant) / harvester -> move**, and a following player
  move clears the capture intent. Right-clicking an enemy *unit* with an engineer produces a plain
  move and no intent. An AI engineer taking a human barracks drops it from the human's selection
  **and** control group 1 and posts "Structure lost". Own structures, non-engineers and
  being-sold structures are all refused. Contact happens at **0.94-1.24 tiles**.
- **(b) capture edge cases, 43 checks.** *Victory*: capturing the AI's only barracks (no units, no
  refinery, 0cr) flips `productionStructureCount` 1 -> 0 and the mission to **won on the capture
  tick (28)**; the same capture with an army and a refinery still standing leaves the AI **alive**.
  *Helipad*: a docked gunship's pad is captured at tick 46 — the aircraft **stays with the AI**,
  scrambles (`docked` false, reservation dropped), re-pads on the surviving own pad at **tick 81**
  and rearms to **6** there; with no second pad it holds a **3.9-tile** perimeter around its ConYard
  and never docks on the captured one. *Refinery*: a bonded AI harvester unbonds on capture
  (`refineryId`/`harvestTile` cleared, **239 ticks** of danger hold armed, state forced to
  `seeking`), **never pays the new owner a credit**, the AI's income stops dead, and once the AI
  builds a replacement the same harvester bonds to it and earns **2,100cr**. Rally point, per-building
  queue and turret target are all dropped on capture.
- **(c) capture + prereqs, 20 checks.** With no war factory the human cannot queue a light tank
  (`enqueue` returns false, queue stays empty) and `helipad` is locked. After capturing the AI's war
  factory at **tick 7**: `hasBuilding` true for the human and false for the AI, **lightTank and
  helipad unlock**, the AI can no longer build vehicles, and the whole pipeline runs — queued,
  drip-charged for **exactly 1000cr**, and a light tank rolls out **1.8 tiles from the captured
  factory**. The harvester correctly stays locked until a refinery also stands (it needs both).
- **(d) map variety, 75 checks.** All four curated seeds: **338/338 start-area tiles clear and
  buildable** on both sides, **6** crystal fields, a start-to-start path (2-4 waypoints), **6/6**
  fields reachable, and a field tagged for each start. Pairwise: **46.8-61.4%** of tiles differ and
  field centres sit **5.5-6.6 tiles** apart; rock density spans **10.7% -> 23.5%**. Same seed is
  bit-identical. RANDOM gives **50/50 distinct** seeds and two deploys differ; a curated map deploys
  the same seed twice. `restart()` replays the identical terrain and the identical seed, and a fresh
  title deploy changes it. Cache: `buildTerrain` is called **once per restart**, is handed the **new**
  map, its terrain signature **changes** across a seed change (5,656 tiles differ) and reproduces
  exactly on a same-seed restart; the minimap is invalidated once per restart. A full skirmish opens
  cleanly on all four (two ConYards, an AI plan with a **58-70 tile** home field, three AI structures
  up within 30s).
- **(e) regressions, 30 checks.** **AI 20-minute economy on seed 1337 (normal) is
  bit-for-bit the air-phase baseline**: gross inflow **54,790cr**, **37** units, **2** refineries,
  waves at **04:00 / 06:57 / 10:18 / 13:39**, and **0** engineers ever built by the AI. Medium vs
  light tank ends **125/400 hp after 309 ticks** — identical to Phase 4, Phase 7, the stances phase
  and the air phase. Seeds 1337 and 355 each replay bit-identically (entities, credits and RNG state)
  and different seeds diverge. A* on all four curated seeds: **4/4** probes complete, **0** waypoints
  on impassable ground, and the same query twice is identical. A tank still razes a power plant
  (destroyed, never captured, with its explosion) and an ordinary unit death still posts "Unit lost".
- **(f) perf, 6 checks.** Full AI, 20 sim-minutes: **0.028 ms/tick mean, 0.048 p95, 1.68 worst**
  (budget 50 ms) — unchanged from the air phase. 150 v 150 mixed armies + 12 gunships + **20
  engineers capturing 8 structures mid-battle**: **0.439 ms/tick mean, 0.937 p95, 2.35 worst** (budget
  10 ms), 8/8 captured. An idle `updateCapture` costs **0.10 us**.
- **(g) title + briefing render smoke, 71 checks.** Six window sizes (640x480 up to 1920x1080 plus a
  tall 480x900): the title draws with **no NaN and no negative-size rect**, lays out **3 difficulty +
  5 map + 1 deploy** buttons with **0 overlaps**, keeps the whole block on screen, and every button
  hit-tests back to itself. Clicking each map button selects it and returns its seed (a rolled one for
  RANDOM); a click outside deploys on the selected map; the difficulty buttons still work. The
  briefing tag renders (`MAP CHARLIE - SECTOR 0054`), `BRIEFING_CHARS` still equals the sum of the
  copy, and the briefing draws clean at all six sizes across 40 typewriter frames.

**Known rough edges.**

- **The AI never builds an engineer**, so capture is a one-way capability today. Losing a structure
  to a *human* engineer is handled correctly end to end (it is the same code path in both
  directions, and the harness drives it), but a player will never have it done to them.
- **An engineer walking into a defended base usually dies.** It has 30 hp, no weapon and no escort
  logic, and nothing about capture makes it survivable — clearing the way first is the whole skill of
  the move, exactly as in C&C1. An explore-stance engineer will at least run from fire and then
  resume, which is the closest thing to self-preservation it has.
- **The capture intent is silent when it fails.** A run cancelled because the target died, was sold,
  or is walled in posts no EVA line; the engineer simply stops.
- **RANDOM can roll a poor map.** Only the four curated seeds are validated; a random seed is checked
  by nothing (the generator's own connectivity carve makes a broken map unlikely — 399 of the first
  400 seeds scanned were valid — but it is not guaranteed).

**What to eyeball in the browser.**

1. **Title screen** — the new `SELECT SECTOR` row under the difficulty buttons. Click each of
   ALPHA/BRAVO/CHARLIE/DELTA and watch the `SECTOR ####` code under the deploy button change; click
   RANDOM twice and confirm the code changes each time. Check the row does not crowd the difficulty
   buttons or the deploy button on a small window.
2. **Briefing header** — `MAP ALPHA - SECTOR 0163` right-aligned on the title line, on screen
   immediately (it is not typed out).
3. **Map difference** — deploy on ALPHA, note the terrain, then return to the title and deploy on
   DELTA: DELTA should read as visibly rockier and more broken-up. Confirm the minimap and the fog
   both match the new map (no stale terrain from the previous mission).
4. **Capture flow** — build a Barracks, queue an **Engineer** (500cr), select it and right-click an
   enemy structure. Watch for the `[RMB] CAPTURE ENEMY BUILDING` banner at the foot of the radar pane
   while it is selected, the walk to the building's edge, the structure flipping to your house colour
   (olive/gold) with its damage intact, the engineer disappearing with **no explosion**, and EVA
   saying "Structure captured". Then check the sidebar: capturing their War Factory should un-grey
   your vehicle icons.
5. **Mixed selection** — box-select an engineer together with a couple of tanks and right-click one
   enemy building: the tanks should open fire while the engineer walks in past them.
6. **R after defeat** replays the same map; going back to the title (`__game.phase('title')`) and
   deploying again on RANDOM gives a new one.

### Post-release: match debriefing

Player feedback after the V2 playthrough: *"can we add a summary after the match"* — the mission
ended on a flat coloured headline that said nothing about what had just happened. This adds C&C's
score screen: **per-player match statistics tracked in the sim**, and a **debriefing panel** that
replaces the Phase 5 result curtain, counts its numbers up, and offers a second way out (back to
the title).

New file: `render/debrief.ts`. Touched: `game/state.ts` (the counters), `systems/{combat,production,
harvest,capture}.ts` (one increment each, at the source of truth), `render/renderer.ts` (one hook,
replacing the curtain body), `main.ts` (wiring, the T binding, `__game.stats`). No system was
reordered, no balance number moved, and `systems/{victory,ai,movement,orders,air,fog}.ts` were not
touched at all.

**The counters.** `GameState.stats: [PlayerStats, PlayerStats]`, an additive field created by
`createGameState` — which is what makes restart hygiene free: `restart()` is still
`createGameState + initSkirmish`, so the table zeroes itself and no new reset call was needed.
Ten fields per player, each incremented **inside the system that performs the action**, so a counter
is one `++` on an event that was already happening — no scans, no per-tick sampling, and nothing to
keep in sync. Mission length is `state.tick`; there is no separate clock.

| counter | where it is written | rule |
|---|---|---|
| `unitsProduced` | `production.spawnFromBuilding` | the one place a unit rolls out, so it covers the unit queue **and** the Refinery's free harvester |
| `unitsLost` | `combat.killEntity` | a real death only |
| `unitsKilled` | `combat.killEntity` | attributed to `sourcePlayer`, and only when it differs from the victim's |
| `buildingsBuilt` | `production.placeStructure` | a structure the player put on the map |
| `buildingsLost` | `combat.killEntity` | **destroyed** only |
| `buildingsRazed` | `combat.killEntity` | same attribution rule as `unitsKilled` |
| `buildingsCaptured` | `capture.captureBuilding` | credited to the taker |
| `buildingsSold` | `production.sellBuilding` | on the tick of sale, not when the dismantle finishes |
| `creditsHarvested` | `harvest.stepUnloading` | what the player actually **received** |
| `creditsSpent` | `production.advanceQueue` | production drip, gross (refunds are not subtracted) |

**The attribution rules, stated exactly** (this was the one genuinely ambiguous piece):

- **Kill credit follows the house, not the entity.** `damageEntity` and `killEntity` gained an
  optional `sourcePlayer`, threaded exactly the way `sourceId` already flows and fed from
  **`Projectile.player`** — a field that has existed since Phase 4. It is deliberately *not* derived
  from `sourceId`: the firer is frequently dead by the time its round lands (measured in the
  harness), and resolving an id would cost an entity scan per hit. A shot therefore still scores
  after its firer has been destroyed mid-flight.
- **Friendly fire is the victim's loss and nobody's kill.** Credit requires `sourcePlayer !==
  victim.player`, so a blob of your own artillery firing into a melee costs you units and earns you
  nothing. The enemy does not get credit for it either — they did not do it.
- **An unattributed death** (splash from a round with no firer, `__game.damage` with no source) is a
  loss for the victim and is scored by nobody. `__game.damage(id, amount, sourceId)` does resolve
  the source's house when given one, so a scripted hit scores exactly like a real shot.
- **A `quiet` death is neither a loss nor a kill.** That is the Phase 7 sell path and the V2
  capture path: a dismantled structure is `buildingsSold`, a captured one is `buildingsCaptured`
  for the taker and *nothing at all* for the loser (it is still standing — it just changed hands),
  and an engineer consumed by a capture is not a casualty.
- **Starting units and the pre-placed ConYard are not counted.** `initSkirmish` calls `createUnit` /
  `createBuilding` directly, so the free minigunner and the opening ConYard were *issued*, not
  produced. Same for `__game.spawn`. Documented rather than special-cased: "UNITS BUILT" means units
  that came out of a factory.
- **`creditsHarvested` is net of overflow.** A deposit that hits a full bank ("Silos needed") is
  burned at the refinery and never arrives, so it is not counted. The counter answers "how much
  money did the crystal actually make you", not "how much crystal did you dig".

**The debriefing panel (`render/debrief.ts`).** Same discipline as `title.ts` / `briefing.ts`:
render-side only, reads `state.stats` and never writes, and animates off its own render-frame
counter rather than `state.tick` (the sim keeps ticking under the panel — the Phase 5 note that the
curtain does not pause the sim still stands).

- **It replaces the curtain in the curtain's own slot.** `Renderer.drawResultOverlay` now delegates
  to a new additive `resultDraw` hook, exactly like `sidebarDraw` / `hudDraw` / `overlayDraw`, and
  is still called after the sidebar and the objectives readout and **before** the help overlay — so
  the debrief dims the HUD along with everything else and F1 still reads over the top of it.
  `main.ts` closes over the map label, seed and difficulty, which the renderer has never known about.
- **Content:** headline (`MISSION ACCOMPLISHED` green / `MISSION FAILED` red — the same wording
  `Hud.objectiveHeadline` uses, so the two can never disagree), then
  `MAP CHARLIE - SECTOR 0054   HARD   TIME 11:06`, then the two-column table (UNITS BUILT / UNITS
  LOST / ENEMIES DESTROYED / STRUCTURES BUILT / LOST / RAZED / CAPTURED / [SOLD] / CREDITS
  HARVESTED) under `YOU` and `ORDER` headers, then the two prompts.
- **`STRUCTURES SOLD` only appears when the human sold something.** It is an emergency move, not a
  headline stat, and an all-zero row is noise. When it does appear both columns are filled — the AI
  sells too, in its critical-rebuild path.
- **Count-up:** `COUNT_FRAMES = 90` (~1.5 s at 60 fps) with an ease-out, so the figures snap most of
  the way up and settle; `countProgress(COUNT_FRAMES)` is exactly 1, so the final numbers are the
  real ones. Eight audible steps are emitted through `DebriefScreen.takeBeep()`, which `main.ts`
  polls from `render()` and answers with the existing `click` sting — **the panel imports no audio**,
  keeping the Phase 6 rule that nothing outside `audio/sfx.ts` produces sound and nothing in a
  system calls it. The restart prompt only starts blinking once the tally has landed, so the eye
  goes to the numbers first.
- **Layout is computed, not hardcoded.** `debriefLayout()` is a pure function (exported for the
  headless smoke) that picks the chunkiest font scale fitting both axes, and gives the headline, the
  mission line and the prompts each the biggest scale *they* fit at, capped by the table's — so a
  narrow window shrinks the 41-character restart prompt rather than the numbers the screen is about.
  The table is centred as a **block** rather than spanned across the panel: the headline sets the
  panel width and stretching the columns to the far edge left a lake of dead space between a label
  and its figure.
- **Two ways out.** `PRESS R OR CLICK TO RESTART - SAME SECTOR` is the Phase 5 behaviour verbatim
  (unchanged code, one branch lower), and `T - RETURN TO COMMAND` is new. **T is clean by
  construction**: the title phase returns from the tick before `camera.pan` and every system, so the
  decided state simply stops being ticked and the title owns its own input from the next tick on;
  the next deploy is the ordinary `briefing -> startMission() -> restart()` path, so nothing about
  the finished game survives. `nextPhase` needed no change — leaving a mission has never been a
  phase *action*.
- **Restart hygiene:** `restart()` calls `debrief.reset()` alongside the existing
  `renderer.buildTerrain` / `invalidateFog` / `sidebar.reset` / `sfx.resetStream` /
  `hud.onMissionStart`. It is the only new reset, and it is render-side.

**`__game`** gained **`stats()`** — `{ tick, time: 'MM:SS', result, players: [PlayerStats,
PlayerStats] }`, where `players` are the *live* `GameState.stats` objects, so it can be watched while
a mission runs.

**Deviations / decisions.**

- **`damageEntity` / `killEntity` / `applySplash` gained an optional trailing `sourcePlayer`.**
  Nothing was renamed and every existing call site behaves identically without it.
- **The old curtain was deleted, not kept as a fallback.** `resultDraw` unset means the renderer
  draws nothing for a decided mission, matching how `hudDraw` / `overlayDraw` already behave.
- **The FIELD MANUAL was not touched.** T only does anything on a decided mission and the panel
  itself says so; adding a binding to the in-mission help for a key that is inert in the mission
  would have been worse than the omission.
- **`__game.give` does not move `creditsHarvested`.** Cheat money is not income.

**Verified.** `npm run build` clean. Four headless harnesses outside the repo (a freshly built
CommonJS mirror of `src/game` + `src/engine` + `src/render`, driven through the real tick order,
plus a recording 2D context and a spy on `drawPixelText` so the *actual strings* that reach the
screen can be asserted), **354/354 checks**, and a fifth build of the same sources with every stat
statement stripped out for the A/B.

- **(a) stat accuracy, 69 checks.** Every counter is checked against ground truth computed
  *independently of the counter*. A scripted 6000-tick skirmish (AI off, both sides building and
  producing): `unitsProduced` **7 / 4** equals the units observed appearing and equals
  queued + the Refinery's free harvester; `buildingsBuilt` **4 / 2** equals the placements the script
  made, with the starting ConYard correctly excluded; and the money ledger
  `start + harvested - spent == credits` closes **exactly** for both players (6000cr and 6900cr).
  A second scene with silos and no overflow closes the crystal identity **exactly**:
  `creditsHarvested` **8400** == 8300 crystal removed from the map + 100 aboard at the start - 0
  aboard at the end. Attribution: an AI tank killing human infantry and the mirror image both score
  1/0 the right way round; an **AI guard tower** scores its kill; a rocket whose firer is killed at
  **t=5**, ~90 ticks before impact, **still scores for the house that fired it**; own artillery
  splash killing **3 of 3** own engineers is 3 human losses and **0** kills for anybody; enemy
  artillery into a mixed cluster scores the enemy **exactly the 3 human deaths** and **0** for its
  own casualty; an unattributed hit is a loss and no kill. Structures: a razed power plant is
  1 razed / 1 lost, a captured barracks is 1 captured / **0** lost / **0** razed with the engineer
  **not** counted as a casualty, and a sold guard tower is 1 sold / **0** lost both immediately and
  after the 30-tick dismantle.
- **(b) determinism, restart, regression, 22 checks.** A fresh state has both blocks at ten zeroed
  fields; a played game moves them; a restart zeroes them again. **300 debrief frames plus every
  render-side read change nothing** (and the next ticks do, so the check is not vacuous). The same
  seed replays bit-identically at t=4000, stats included; a different seed diverges. Medium vs light
  tank still ends on **125/400 hp** — bit-identical to Phase 4, Phase 7, the stances phase and the
  air phase (313 ticks at this harness's 4-tile spawn gap; hp is the load-bearing number). The
  **20 sim-minute AI baseline on seed 1337 (normal, immortal human base) is bit-for-bit unchanged**:
  **54,790cr** by the phase harnesses' own "sum of positive credit deltas" observer, **37** units,
  **2** refineries, waves at **04:00 / 06:57 / 10:18 / 13:39**. The new counter reads **58,200cr** on
  the same run — the delta observer under-counts by 3,410 because it misses any tick where a deposit
  and a purchase land together, so `creditsHarvested` is the strictly better measure and the old
  number is preserved only as the regression key. The AI's full-game ledger closes **exactly**
  (17,500cr = 5000 + bonus + 58,200 - 47,200, no sells that run).
- **(c) render smoke, 263 checks.** Six window sizes (1920x1080 down to 640x480 plus a tall 480x900)
  x won/lost x count-up start/mid/complete: nothing throws, **no NaN and no negative-size rect**,
  the panel is fully on screen at every size, **no two pieces of type overlap**, and nothing is drawn
  outside the panel. The tally shows zeros on frame 1, partial figures at the half-way frame, and —
  read back through the `drawPixelText` spy — **the exact final figures** once complete. Beeps fire
  **exactly 8** times over the count-up, **0** afterwards, and **8 again** after `reset()`. A mission
  still `playing` paints **0** operations and does not advance its own clock. Row rules
  (9 with a sale, 8 without), headline wording, the mission line and the `MM:SS` clock
  (`13320 -> 11:06`, `24000 -> 20:00`, `90000 -> 75:00`) all check out, and **every glyph the panel
  uses exists in the 5x7 font**. Phase logic: `nextPhase` transitions unchanged, and the decided
  branch in `main.ts` is asserted against the source — T is handled first and returns, R and a left
  click still restart through the identical `restart(); endTick(); return;` sequence, the debrief is
  installed on `resultDraw`, `restart()` rewinds it, and the beep is played from `render()`.
- **(d) perf, A/B against a stats-free build.** The same sources with all 8 stat statements removed
  produce a **byte-identical sim signature at t=8000** (sha1 `fe37de4b…` both ways), which is the
  strongest available proof that the counters cannot affect the simulation. Timings over three runs
  each: AI 20 sim-minutes **0.0266-0.0282 ms/tick** with stats vs **0.0267-0.0275** without
  (p95 0.043-0.048 both ways, worst ~1.7 ms — the map-gen tick); 150v150 mixed armies + 12 gunships
  attack-moving into each other **0.399-0.415 ms/tick** with vs **0.412-0.428** without, p95 ~0.57,
  worst ~3.1-3.8 ms, 130 of 312 dead by t=600. The stats build is not consistently slower than the
  build without them: the difference is inside run-to-run noise, which is what "one `++` on an event
  that was already happening" predicts. Budgets are 50 ms and 10 ms respectively.

**Known rough edges.**

- **The AI's stats are shown but never explained.** "ORDER: STRUCTURES CAPTURED 0" is always 0 today
  because the AI never builds an engineer (the V2 note stands); the row is kept for symmetry.
- **`creditsSpent` is not on the panel.** It is tracked and exposed through `__game.stats()`, but
  nine rows is already the most a 640x480 window will take without dropping to an illegible scale.
- **The count-up does not respond to input.** Clicking during the tally restarts the mission rather
  than skipping to the final figures, which is the Phase 5 behaviour preserved verbatim — but it
  means an impatient player never sees the numbers. The briefing's two-click "reveal then start"
  pattern would fix it and was left out deliberately: making the restart click conditional would
  change behaviour that has shipped.
- **T is undiscoverable in the mission.** It only exists on the debriefing panel, which says so, but
  the FIELD MANUAL does not mention it.

**What to eyeball in the browser.**

1. **Win or lose a mission** (fastest: `__game.ai('easy')`, or `__game.spawn` a few medium tanks and
   raze The Order's base; fastest of all, `__game.state.result = 'won'` for one frame). Check the
   panel: the green/red headline, `MAP ALPHA - SECTOR 0163   NORMAL   TIME mm:ss` under it, and the
   two columns lining up under `YOU` / `ORDER`.
2. **The count-up feel** — the numbers should sweep up over about a second and a half with a
   mechanical tick, settle exactly on the real figures, and only then should the restart line start
   blinking. Cross-check the final numbers against `__game.stats()` in the console.
3. **`T`** — press it on the panel: you should land on the title screen with the drifting backdrop,
   able to pick a different sector and deploy into a clean mission. Then do a run where you press
   **R** instead and confirm it still replays the *same* sector immediately, exactly as before.
4. **Window sizes** — resize the window with the panel up (640x480 is the tight case): the panel
   should stay centred and fully on screen, and the restart prompt should shrink before the table
   does.
5. **The sold row** — sell a structure ('S' with one selected) before the mission ends and confirm
   `STRUCTURES SOLD` appears; on a run where you sell nothing it should be absent.
6. **F1 over the panel** — the help overlay must still draw *over* the debriefing, and the
   objectives readout underneath it should be dimmed by the panel's wash rather than fighting it.

### V3: conquest campaign

Player request: *"pick a country, kinda like risk and take over land, maybe gets harder the more
land you take over"* — the classic C&C territory map. A thirteen-territory continent, a Risk
adjacency rule, and a battle configuration that grows with both how deep a territory sits and how
much of the map you already hold.

New files: `game/campaign.ts` (pure data + logic — no rendering, no `GameState`) and
`render/campaign.ts` (the map screen). Touched: `game/skirmish.ts`, `game/systems/ai.ts`,
`render/{title,briefing,debrief}.ts`, `main.ts`. **No system was reordered, no balance number moved,
and no sim file other than `ai.ts` / `skirmish.ts` was touched at all** — `systems/{victory,combat,
movement,orders,production,harvest,air,capture,fog}.ts`, `rules.ts`, `state.ts`, `map.ts` and
`constants.ts` are byte-for-byte unchanged.

---

#### 1. The continent

Thirteen territories in six columns, west (home) to east (the stronghold). **Tier is graph distance
from home, computed by BFS at module load, never hand-authored**, so the number the scaling reads
can never drift from the map the player sees. `assertGraph()` runs at load and throws on a
non-symmetric edge, a dangling id, an unreachable territory, a duplicate seed, or a stronghold that
is not the deepest node.

| # | territory | id | tier | seed | rock+cliff | adjacent to |
|---|---|---|---|---|---|---|
| 1 | **HARROW LANDING** (HQ) | `harrow` | 0 | 1059 | 8.0% | ashen, karst |
| 2 | ASHEN REACH | `ashen` | 1 | 1326 | 11.6% | harrow, karst, salt, dry |
| 3 | KARST LINE | `karst` | 1 | 1317 | 12.3% | harrow, ashen, dry, ironwash |
| 4 | SALT VERGE | `salt` | 2 | 1171 | 13.0% | ashen, dry, cinder |
| 5 | THE DRY MARCH | `dry` | 2 | 1281 | 13.6% | ashen, karst, salt, ironwash, cinder, vulture |
| 6 | IRONWASH | `ironwash` | 2 | 1251 | 14.2% | karst, dry, vulture, glass |
| 7 | CINDER STEPPE | `cinder` | 3 | 1165 | 14.6% | salt, dry, vulture, rift |
| 8 | VULTURE GAP | `vulture` | 3 | 1359 | 15.0% | dry, ironwash, cinder, glass, rift, blackspine |
| 9 | GLASS BASIN | `glass` | 3 | 1321 | 15.4% | ironwash, vulture, blackspine, ember |
| 10 | RIFT COLLAR | `rift` | 4 | 1322 | 16.0% | cinder, vulture, blackspine, crown |
| 11 | BLACKSPINE | `blackspine` | 4 | 1117 | 16.7% | vulture, glass, rift, ember, crown |
| 12 | EMBER FLATS | `ember` | 4 | 1074 | 17.5% | glass, blackspine, crown |
| 13 | **OBSIDIAN CROWN** (stronghold) | `crown` | 5 | 1273 | 18.6% | rift, blackspine, ember |

- **26 undirected edges**, planar in both senses: within the Euler bound (26 <= 3V-6 = 33) *and*
  geometrically — no two border links between territory centres cross, which is what lets the map be
  drawn as a continent rather than a tangle. Tier distribution is 1 / 2 / 3 / 3 / 3 / 1 and no edge
  skips a tier.
- **The thirteen seeds were validated to exactly the V2 curated-map bar**: both start areas
  **338/338 tiles clear *and* buildable**, **6** crystal fields, a start-to-start A* path, and every
  field reachable. They were chosen from a 402-seed scan (400 valid, 2 rejected) by spreading across
  rock density and rejecting any pair agreeing on more than 70% of their tiles — **minimum pairwise
  terrain difference 37.9%**. None of them collides with a curated skirmish seed (355/187/84/245).
- **Terrain gets rockier as you push east.** Rock+cliff cover runs **8.0% at home to 18.6% at the
  stronghold** and the tier-mean rises monotonically (8.0 -> 12.0 -> 13.6 -> 15.0 -> 16.7 -> 18.6%),
  so the ground itself reads as harder country the deeper you go. That is a deliberate assignment of
  validated seeds to tiers, not a generator change.

#### 2. Rules

- **You may attack any enemy territory adjacent to owned land.** Home is owned from the start, so
  the front is never empty; `attackable(cs)` is the whole rule.
- **Win -> it becomes yours. Lose -> nothing changes at all** beyond the counters: the territory
  stays enemy, you keep everything you held, and the same fight can be retried immediately.
  **Owned land is never lost in v1.** That is a documented simplification — enemy counter-attacks on
  your own territories are a second mission type, not a variant of this one — and it is what makes
  the campaign a ratchet rather than a grind.
- **Own all thirteen -> campaign victory.**
- Save: `localStorage['crystal-dawn.campaign']`, versioned (`version: 1`) inside the payload.
  **Anything wrong with it is a fresh campaign, never a throw and never a half-restored one**: bad
  JSON, a foreign version, unknown territory ids, a missing home territory, or a `"victory"` that
  does not hold all thirteen (the result is recomputed from `owned`, not trusted). `current` is
  deliberately dropped on load — a battle that was in progress when the tab closed did not happen.
  Storage that throws on read *or* write is a session-only campaign, guarded exactly like the mute /
  objectives preferences.

#### 3. Scaling — the exact formula

`campaignBattleConfig(state, territoryId)` is a **pure function of (land held, depth)** that returns
an *extended `SkirmishOptions`*, so `main.ts` hands it straight to `initSkirmish` with no
translation step. `conquered = ownedCount - 1` (home is free); `depth = tier - 1`.

| knob | formula | at the stronghold fought last |
|---|---|---|
| `difficulty` | `tier <= 2 -> easy`, `3-4 -> normal`, `5 -> hard` | `hard` |
| `aiCreditBonus` | `conquered * 400 + tier * 600` | `11*400 + 5*600 =` **7400 cr** |
| `aiScaling.waveSize` | `1 + conquered*0.04 + depth*0.06` | **x1.68** |
| `aiScaling.waveInterval` | `max(0.50, 1 - conquered*0.025 - depth*0.04)` | **x0.565** (shorter = more pressure) |
| `aiScaling.armyCap` | `1 + conquered*0.03 + depth*0.04` | **x1.49** |
| `aiPrebuilt` | tier 3: plant + 1 tower; tier 4: plant + 2 towers; tier 5: plant + refinery + 3 towers | **5 structures** |
| `threat` (UI only) | `min(1, depth/4 * 0.65 + conquered/11 * 0.35)` | **0.97 -> OVERWHELMING** |

- **Every term is non-decreasing in both inputs**, so the stronghold fought last is the maximum
  configuration the campaign can produce **by construction rather than by tuning**. Verified
  exhaustively over all 12 attackable territories x all 12 possible owned-counts: 0 decreases in
  land, 0 in depth, and 0 configurations anywhere that exceed the final stronghold on any axis.
- **The first invasion of a fresh campaign is a plain easy skirmish plus 600 cr** — neutral scaling,
  no pre-built defences, `LIGHT` resistance.
- **`AiScaling` does not fork the AI.** Every consumer of the difficulty tuple now reads it through
  `aiTuning(difficulty, scaling)`, which **returns `AI_DIFFICULTY[level]` itself — the same object,
  no allocation — whenever the scaling is neutral**. That is the mechanism that makes a skirmish
  provably unchanged rather than merely intended to be. The three call sites are `nextStructure`
  (army cap), `stepUnits` (army cap, wave cap) and `stepAttack` (wave growth/cap, intervals);
  `createAiState` and `aiDifficulty` resolve it too. `firstWave` scales with `waveInterval`, so a
  deep territory's first wave also lands sooner.
  Stronghold tuple: `firstWave 3600->2034`, `interval 2200-3000 -> 1243-1695`,
  `wave 7/3/20 -> 12/5/34`, `armyCap 48->72`.
- **Pre-built extras go up through the AI's own `findPlacementTile`**, i.e. the same `canPlaceAt`
  the human's placement ghost uses — buildable terrain, no overlap, no burying a unit, inside the
  build radius. An extra with nowhere legal to go is skipped rather than forced.
- **The Power Plant in every pre-built set is not decoration.** Guard towers go offline under
  `lowPower` (Phase 4) and a deficit halves every build in the base, so towers handed to a
  ConYard-only opening would sit dark. With the plant in front, tier 3 opens at **+90** power margin,
  tier 4 at **+80** and the stronghold at **+40** — measured, and no prebuilt battle opens in
  deficit.
- **A pre-built Refinery brings its free Harvester** (otherwise it is a building that earns
  nothing), created directly rather than through `spawnFromBuilding` — pre-placed things are
  *issued*, not *produced*, so `buildingsBuilt` and `unitsProduced` stay at **0** at t=0, matching
  how the opening ConYard and free minigunner have always been counted.

#### 4. The map screen

`render/campaign.ts`, same discipline as `title.ts` / `briefing.ts` / `debrief.ts`: render-side only,
never sees a `GameState`, animates off its own frame counter (the sim is frozen while the phase is
`'campaign'`, exactly as on the title screen), and `campaignLayout` / `plateLayout` / `plateLines` /
`pointInShape` / `territoryAt` are **pure**, so the headless smoke asserts geometry directly.

- **`AppPhase` is now `'title' | 'campaign' | 'briefing' | 'playing'`** and `nextPhase` gained one
  branch: `title --campaign--> campaign --invade--> briefing --start--> playing`. Opening the invade
  plate, wiping the save and dismissing are all self-transitions. `'playing'` is still terminal —
  returning to the map from the debriefing is a `main.ts` jump, not a phase action, exactly like
  the T binding.
- **Regions are irregular blobs with visible channels between them, plus explicit border links**
  between adjacent centres. *Deviation from the brief*, which asked for adjacency to be implied by
  shared borders: abutting polygons in a 13-region hand-authored map either leave hairline seams or
  need exact shared edge lists, and neither reads as well as a lit link. The links also carry
  information the borders cannot — a link touching owned ground is drawn lit, an enemy-to-enemy link
  is background — so the front is legible at a glance.
- **States**: owned gold fill + gold outline (`HQ` / `HELD` tag), attackable crimson fill with a
  **pulsing** outline (tier + `n TRIED` tag), unreachable enemy dim crimson. Names are centred on the
  label anchor and nudged back inside the window — the eastern territories sit against the edge of
  the continent and OBSIDIAN CROWN would otherwise run off a 480px-wide window (the render smoke
  caught exactly this).
- **Invade plate**: `INVADE <NAME>` / `TIER n - <LEVEL> GARRISON` / `ESTIMATED RESISTANCE: <LABEL>` /
  `ORDER RESERVES: +n CR` / `DEFENCES ALREADY STANDING` / `PREVIOUS ATTEMPTS: n`, with LAUNCH ASSAULT
  and CANCEL. It is modal over the map: while it is up only its own controls mean anything and
  anywhere else dismisses. Enter/Space also launches; Escape dismisses.
- **Progress** is `TERRITORIES n/13   BATTLES n   WON n   FRONTS n` under the header.
- **RESET CAMPAIGN is double-confirm**: the first click arms it (the label becomes `CONFIRM WIPE?` in
  red and the footer says so), the second wipes the save. **Any click that is not on the control
  disarms it**, so an armed wipe can never survive to catch a later, unrelated click.
- **Title screen.** A `[C] CONQUEST CAMPAIGN` plate below the deploy button (past the sector tag),
  gold-outlined so it reads as the other mode rather than another skirmish option, plus the `C` key.
  The skirmish block — SELECT DIFFICULTY, SELECT SECTOR, CLICK TO DEPLOY — is **untouched in order,
  geometry and behaviour**; only `menuTop`'s reserved block height grew. The map and campaign rows
  drop to a smaller font face when their label does not fit their plate; the difficulty and deploy
  rows are unchanged.
- **Campaign complete** reuses the debriefing's own furniture — same panel, rule, two-column
  YOU/ORDER table and literally `debriefRows()` — under a green `CONTINENT SECURED`, with
  `13 TERRITORIES   n BATTLES   TIME mm:ss` from the cumulative counters. `R` starts a new campaign
  (no double-confirm: the campaign is over, there is nothing to lose accidentally) and `T` returns to
  the title.

#### 5. Debriefing and wiring

- **`DebriefInfo` gained two optional fields**, `kind` (the word before the label: `MAP` by default,
  `TERRITORY` in the campaign) and `campaign`. Their presence is the only thing that swaps the
  panel's two foot prompts, through a new pure `debriefPrompts(info, result)`; `debriefLayout` sizes
  the panel from exactly what `draw` writes, so a campaign prompt can never overflow. **A skirmish
  gets byte-identical strings and byte-identical geometry** (`TITLE_PROMPT` is shorter than
  `RESTART_PROMPT`, so the new `min(fit(a), fit(b))` is the old expression).
  - won: `TERRITORY SECURED - CLICK TO CONTINUE` / `T - RETURN TO COMMAND`
  - lost: `ASSAULT REPULSED - CLICK TO WITHDRAW` / `R - RETRY THIS TERRITORY   T - COMMAND`
- **`R` after a campaign win is not a retry.** The ground is already yours, so R behaves like the
  click and returns to the map — which is what the panel says. After a *loss* R re-begins the battle
  (counting a fresh attempt, re-resolving the scaling) and restarts immediately.
- **The result is folded into the campaign on the tick it is decided, exactly once**, latched by
  `campaignResolved` and saved in the same breath — not when the player clicks past the panel, which
  they may never do. A reload mid-debriefing already has the territory.
- **`campaignBattle` is the mode switch.** Null for every skirmish; when set, `newGame()` passes
  `{ ...campaignBattle, difficulty }` to `initSkirmish` (so `__game.ai(level)` still works mid-
  campaign) and `missionInfo()` labels the briefing and the debriefing with the territory. The
  skirmish entry point `setMission()` clears it, so deploying a skirmish from the title can never
  inherit a stale campaign battle.
- **`__game`** gained **`campaign()`** (owned / attackable / result / counters + the live battle
  configuration for all thirteen territories), **`campaignInvade(id)`** (the debug counterpart of
  confirming on the plate — same `startCampaignBattle` path), **`campaignWin()`** (force the current
  battle to a win; `updateVictory` is already sticky, so the result then travels the *real* path) and
  **`campaignReset()`**. `phase()` accepts `'campaign'`.
- **Restart hygiene needed no new reset call.** The campaign screen holds no cache — only its
  selection and reset-arm state, cleared by `campaignScreen.reset()` whenever the map is entered.

#### 6. Deviations / decisions

- **Adjacency is drawn as links, not shared borders** (above). Documented rather than fudged.
- **Owned land is never lost.** Losing an attack costs an attempt and nothing else.
- **`aiTuning` returns the shared difficulty object when unscaled.** Object identity is the proof
  that a skirmish cannot have changed; `isNeutralScaling` is exported so harnesses can assert it.
- **`AiState.scaling` is one new field** (additive; a skirmish carries `NO_AI_SCALING`).
  `SkirmishOptions` gained three optional fields (`aiCreditBonus`, `aiScaling`, `aiPrebuilt`), all
  omitted everywhere except a campaign battle. `AiReport` gained `scaling` and the resolved `tuning`.
- **The campaign map screen's *input* computes the plate geometry on demand** rather than caching it
  from `draw`. The first cut cached it, which made a click depend on a frame having been rendered
  first — the headless harness (which clicks without drawing) caught it, and the same bug would have
  fired in the browser on a click landing in the frame after a resize.
- **The home territory has a validated seed it will never play.** Home is owned from the start, so
  its map is only ever the title/campaign backdrop. Keeping it means all thirteen are held to the
  same bar and a future "defend your ground" mission has a map to use.
- **`prebuiltSummary` hides the Power Plant** from the invade plate's copy: it exists to keep the
  towers lit, and listing it as a threat would be misleading.
- **The invade plate is reachable only by pointer or Enter/Space** on an already-selected territory;
  there is no keyboard territory cursor. The map row on the title screen has the same limitation and
  the same reason (it is a spatial choice).

#### 7. Verified

`npm run build` clean. Seven headless harnesses plus an A/B build, all outside the repo, driving a
**freshly compiled CommonJS mirror of the real sources** (game + engine + render + `main.ts` itself,
booted through a stub DOM and a stub `localStorage`, with a recording 2D context and a spy on
`drawPixelText` so the *actual strings* reaching the screen can be asserted): **895/895 checks**.

- **(a) campaign logic, 107 checks.** Graph: 13 territories, 52 directed / **26 undirected** edges,
  every adjacency symmetric, no self-loops, no dangling ids, tier distribution `1/2/3/3/3/1`, no edge
  skipping a tier, unique ids/names/seeds, within the Euler planar bound and **0 geometric link
  crossings**. Shapes: all 13 label anchors inside their own polygon, all vertices inside the 0..100
  space, >= 6 vertices each, and **0** shapes swallowing another territory's centre. Rules: a fresh
  campaign owns only home and fronts on `ashen, karst`; taking ASHEN opens `karst, salt, dry`; an
  illegal attack counts nothing; a **loss leaves `owned` byte-identical**, keeps the territory
  attackable and records the attempt; resolving twice is a no-op; a win flips ownership, counts, and
  folds ticks + both stat blocks into the totals. A legal 12-battle walk reaches **13/13 owned ->
  `victory`** with nothing left to attack. Persistence: full round-trip incl. records and totals,
  `current` never restored, **11 corrupt/hostile inputs** (missing, empty, malformed JSON, bare
  array, number, `null`, no version, wrong version, wrong types, negative and NaN counters) all give
  a fresh campaign; unknown ids and duplicates dropped; a **false `"victory"` is corrected** and a
  real one recognised; reset removes the key; and a storage that **throws on get, set and remove**
  (and a null storage) never throws out.
- **(b) territory seeds, 45 checks.** All 13: **338/338** start tiles clear + buildable on both
  sides, **6** crystal fields, a complete start-to-start A* path (1-5 waypoints), 6/6 fields
  reachable, 163k-189k crystal. Every seed regenerates bit-identically; minimum pairwise terrain
  difference **37.9%**; rock density **8.0% -> 18.6%** rising monotonically with tier; no collision
  with a curated skirmish seed.
- **(c) scaling, 54 checks.** Exhaustive monotonicity over 12 territories x 12 owned-counts x 6 axes:
  **0** decreases in land held, **0** in depth, and **0** configurations exceeding the final
  stronghold. Difficulty steps `easy easy normal normal hard`. Stronghold = hard / **+7400 cr** /
  **x1.68** wave / **x0.565** interval / **x1.49** army / 5 prebuilt / `OVERWHELMING`; first invasion
  = easy / +600 cr / neutral / none / `LIGHT`. Pre-built placement on **all 12** attackable
  territories' real maps: every extra found a legal tile, **0** overlapping footprints, **0** buried
  units, **0** off-map tiles, **0** on unbuildable terrain, **0** power deficits. A configured battle
  actually opens with them: stronghold seed 1273, hard, credits `5000 + 4000 + 7400`, **3 towers +
  1 refinery + 1 plant all `ready` at t=0**, the refinery's free harvester present,
  `buildingsBuilt`/`unitsProduced` still **0**, and the human side untouched. Neutral scaling returns
  the shared tuple by **object identity**.
- **(d) full campaign loop, 67 checks.** Driven through the real `main.ts`: `C` on the title opens
  the map; clicking ASHEN opens the plate without starting anything; clicking the **stronghold from
  home does nothing**; LAUNCH lands on the briefing, counts the attempt and **saves immediately**;
  two briefing clicks deploy onto seed 1326 at easy with `5000+600` cr; `campaignWin()` then one tick
  flips the territory **on the deciding tick**, and **60 further ticks do not re-resolve**; the
  debrief click returns to the map with the front grown to `karst, salt, dry`. A mid-campaign loss
  leaves `owned`, `battlesWon` and the **whole attackable set byte-identical**, records the failed
  attempt, and `R` retries the same seed (attempt 2) and takes it. A **fresh page load on the same
  storage** restores owned, counters and the front with no battle in progress. The remaining ten
  territories are taken the same way, stronghold last: **13/13 owned, `victory` fired, 12 battles
  won**, the save reflects it, cumulative ticks recorded, and the final fight has the most credits,
  the biggest waves, the shortest wave gap and the most pre-built defences of the whole route (and is
  the **only** `hard` one). `campaignReset()` empties it and a reload after reset is fresh.
- **(e) regressions, 31 checks.** Measured against the **pre-V3 sources compiled from git HEAD**,
  under the identical harness, so the comparison cannot drift the way a hard-coded number from an
  older phase can. Seed 1337 normal 20 sim-min: inflow **54,928**, **37** units, **2** refineries,
  waves **04:00 / 06:57 / 09:49 / 12:42 / 16:47**, and a **full sim signature identical** to the
  pre-V3 build; same for easy and hard at 10 minutes. (These absolute numbers differ from the
  V2/debriefing SPEC entries because this harness keeps human *units* immortal as well as structures;
  the load-bearing check is the A/B, not the constant.) The medium-vs-light-tank duel still ends on
  **125/400 hp** in 309 ticks. A tier-1 campaign battle is in-family with easy/normal: first wave on
  **easy's own clock (05:30)**, 4 waves, 45,188 cr inflow against easy's 43,908 and normal's 56,126,
  **23** units — exactly easy's — and a refinery built. The stronghold is visibly a different animal:
  first wave at **01:41** vs plain hard's 03:00, **8** waves vs 5, **75** units vs 51.
- **A/B, 6/6 scenarios bit-identical.** The pre-V3 build and the working tree produce the **same
  sha1 sim signature** (entities, positions, hp, ammo, credits, power, storage, both build queues,
  the whole stat table, the AI's wave bookkeeping and the next RNG draw) at every 4000-tick mark and
  at the end, over seeds 1337 (normal 20 min, easy and hard 10 min), 355, 245 and 1273.
- **(f) render smoke, 583 checks.** Seven window sizes (1920x1080 down to 640x480 plus a tall
  480x900) x fresh / mid / nearly-done / won, 45 frames each: **nothing throws, no NaN, no
  negative-size rect**, the map square and both controls are on screen and non-overlapping, **all 13
  territories hit-test back to themselves** at every size, a point outside the map hits nothing, all
  13 names plus the header, the progress line, the `HQ` tag and the reset control reach the screen,
  **every glyph exists in the 5x7 font**, and **no type runs off the window** (the check that caught
  OBSIDIAN CROWN overflowing at 480px). The invade plate at all seven sizes: panel on screen, LAUNCH
  and CANCEL non-overlapping and inside the panel, the target named, tier and resistance stated,
  LAUNCH invades the selected territory and CANCEL dismisses. Reset: first click arms and shows
  `CONFIRM WIPE?`, second wipes, an unrelated click disarms. Debriefing: skirmish prompts and the
  `MAP ...` mission line **unchanged**, campaign prompts correct per result, and the panel draws
  clean and fully on screen across 7 sizes x won/lost x skirmish/campaign with the right prompts
  read back through the font spy.
- **(g) perf, 8 checks.** Campaign map at 1920x1080 with all 13 territories **and** the invade plate:
  **0.054 ms/frame mean, 0.067 p95, 0.206 worst** (16.7 ms budget). `attackable()` +
  `campaignBattleConfig()` together cost **0.41 us**; a save serialise + deserialise round trip
  **1.85 us**. Battle perf unchanged: 20 sim-min on seed 1337 normal is **0.0245 ms/tick mean /
  0.0399 p95** against the pre-V3 build's 0.0266 / 0.0455 (budget 50 ms). The heaviest campaign
  battle — the stronghold at maximum scaling, 75 units — runs at **0.0574 ms/tick mean, 0.0992 p95**.
  `initSkirmish` with five pre-built extras costs **0.59 ms** against 0.39 ms plain.

#### 8. Known rough edges

- **Owned land is never lost**, so a campaign can only stall, never go backwards. There is no reason
  to defend anything you have taken.
- **`campaignWin()` is a live debug hook in the shipped build**, like every other `__game` helper. It
  is the only way to test the loop without playing twelve matches, and it is exactly as
  "cheat-enabled" as `__game.give`.
- **The campaign has one save slot and no difficulty selection.** The tier drives the AI level, so
  the title's EASY/NORMAL/HARD buttons do nothing for a campaign battle (`__game.ai(level)` still
  overrides mid-battle).
- **The briefing copy is the skirmish briefing verbatim.** Only the header tag changes
  (`TERRITORY OBSIDIAN CROWN - SECTOR 04F9`); the situation/objective text does not mention the
  campaign or the territory.
- **A territory's map never changes.** Retrying a lost assault replays the identical terrain, which
  is deliberate (it is *that* ground) but means a map you find awkward stays awkward.

#### 9. What to eyeball in the browser

1. **Title screen** — the gold `[C] CONQUEST CAMPAIGN` plate under CLICK TO DEPLOY, and that the
   skirmish block above it is unchanged at a few window sizes (640x480 is the tight case). Deploy a
   normal skirmish first and confirm nothing about it moved: same difficulty row, same SELECT SECTOR
   row, same debriefing prompts.
2. **The map** — press C. Check the continent reads west-to-east, HARROW LANDING is gold with an
   `HQ` tag, ASHEN REACH and KARST LINE **pulse** as attackable, everything else is dim crimson, and
   the border links between owned and enemy ground are lit while enemy-to-enemy links are not.
   Hover a territory and confirm the outline thickens.
3. **Invade flow** — click ASHEN REACH, read the plate (`TIER 1 - EASY GARRISON`,
   `ESTIMATED RESISTANCE: LIGHT`, `ORDER RESERVES: +600 CR`), click LAUNCH ASSAULT, and confirm the
   briefing header says `TERRITORY ASHEN REACH - SECTOR 052E`. Win it (fastest:
   `__game.campaignWin()`), check the footer reads **TERRITORY SECURED - CLICK TO CONTINUE**, click,
   and watch ASHEN REACH **flip to gold** with the front growing to SALT VERGE and THE DRY MARCH.
   Then lose one on purpose and confirm the footer reads **ASSAULT REPULSED - CLICK TO WITHDRAW**,
   that `R` retries the same ground immediately, and that the map is exactly as you left it.
4. **Scaling felt in a real battle** — take five or six territories, then invade a **tier 4**
   (RIFT COLLAR / BLACKSPINE / EMBER FLATS). At battle start you should already see The Order's
   **power plant and two guard towers standing**, and the first wave should arrive noticeably before
   the 04:00 you are used to on normal. Cross-check with `__game.aiInfo()` — `scaling` and `tuning`
   show the multipliers and the resolved wave clock. Then look at OBSIDIAN CROWN's plate: hard,
   +7400 cr, `OVERWHELMING`, `DEFENCES ALREADY STANDING`.
5. **Save survives a reload** — take a territory, then hard-refresh the page and press C: the same
   ground should still be gold with the same battle counters. Then use RESET CAMPAIGN and confirm it
   takes **two** clicks (the label turns red first), that a click elsewhere cancels the arming, and
   that the continent goes back to just HARROW LANDING.
6. **Campaign complete** — fastest is `__game.campaignInvade(id)` + `__game.campaignWin()` repeatedly
   (or edit `localStorage['crystal-dawn.campaign']`): the map should be replaced by a green
   **CONTINENT SECURED** panel with the cumulative YOU/ORDER table and the total campaign time.

### V3.1: theater map art

Player feedback on the V3 conquest screen, with a screenshot: *"can you make it look like a world
map instead of shapes"*. V3 drew the thirteen territories as separate rounded blobs floating on a
dark backdrop with visible channels between them, plus explicit "border links" between their centres
standing in for adjacency (a documented V3 deviation). V3.1 replaces that with **one continent on an
ocean**: a landmass with a real coastline whose thirteen regions **tessellate it exactly**, so a
border between two territories *is* the adjacency rather than a line drawn to say so.

New file: `render/theater.ts` (the map geometry). Rewritten: `render/campaign.ts` (the screen).
`game/campaign.ts` is **behaviourally byte-identical** — one doc comment changed and nothing else.
`main.ts` needed **zero edits**: `CampaignScreen`'s constructor, `reset`, `update`, `handleClick`,
`plateFor` and `draw(ctx, terrain, w, h, cs)` all keep their V3 signatures, and so do
`campaignLayout` / `territoryAt` / `pointInShape` / `plateLines` / `plateLayout`. No other file in
`src` was touched.

---

#### 1. Where the geometry lives, and why

**Render-side, in `render/theater.ts`.** `game/campaign.ts` is pure data + logic that the campaign
harnesses assert on directly; a drawing's vertices are render data. The one link back is an
*assertion*: every territory's authored `cx` / `cy` must fall inside its new region, so the
west-to-east arrangement the difficulty scaling was designed around cannot silently drift when the
art is redrawn. `Territory.shape` is retained as the V3 authoring record of that intent (and the V3
logic harness still checks it); nothing draws from it any more. That trade is documented on the
type itself.

#### 2. Approach: a planar subdivision with shared, roughened edges

Not thirteen outlines — **one subdivision**:

- **`NODES`** is a shared vertex table in the same 0..100 continent space.
- **`RINGS`** gives each territory as an ordered loop of *node ids*, all wound the same way.
- An **edge** is an unordered node pair. Both territories using an edge read the **same stored
  polyline**, so a border is drawn once and shared. No gaps, no overlaps, no hairline seams — by
  construction, not by careful authoring.
- Edges used by **two** faces are interior borders (thin dark line + a 1px light lift, so a border
  reads as a ridge rather than a crack); edges used by **one** are coastline (heavier, plus a
  bleached beach rim inside it and three fading shelf strokes outside it).
- Straight node-to-node segments would read as a subdivided rectangle, so every edge is roughened by
  **midpoint displacement seeded from the edge key** (FNV-1a -> `makeRng`), 3 passes -> 8 segments,
  amplitude 20% of length on coast and 13% inside, halving per pass. Deterministic at module load,
  no entropy, and *shared* between the two faces — which is exactly what keeps the tessellation
  exact while the borders meander.

**Geometric adjacency is made to equal the graph exactly**, which is the simplest of the options the
brief allowed (no river/ridge motif is needed because no unwanted geometric neighbour exists). The
mechanism is a brick-wall offset: six columns of land, and the horizontal splits of *neighbouring*
columns **interleave** down each shared boundary. On L3 the order is salt|dry, cinder|vulture,
dry|ironwash, vulture|glass — which is precisely what gives THE DRY MARCH a border with both CINDER
STEPPE and VULTURE GAP while SALT VERGE borders only CINDER STEPPE. The offset pattern *is* the
adjacency graph. Counted out: 2 + 4 + 5 + 5 + 3 interior edges down the five column boundaries plus
7 horizontal ones = **26**, the campaign's 26 undirected edges, one per edge.

`assertTheater()` runs at load, exactly like `assertGraph()`, and throws on: an edge used by more
than two faces, a graph edge with no shared border, a shared border that is not a graph edge, a
border shorter than 3 continent units, a degenerate or oppositely-wound ring, a region with no
interior label anchor, a `cx`/`cy` outside its own region, and a coastline that forks, breaks or
closes early. `COASTLINE` is built by chaining the *directed* boundary edges out of the face rings,
so "the landmass is a single closed loop, not several islands" is proved rather than assumed.

Geography, unchanged in reading: **HARROW LANDING is the green west-coast beachhead** (the only deep
water landing), terrain runs damp green -> scrub -> dry grass -> sand -> broken rock -> black stone
west to east matching the SPEC's own 8.0% -> 18.6% rock progression, THE DRY MARCH / VULTURE GAP /
BLACKSPINE are **landlocked** interior country, and **OBSIDIAN CROWN is the eastern highland cape**,
the furthest land from home, carrying a keep badge in danger red.

#### 3. States and reading the front

- **Owned**: gold wash + a firm gold border. **Enemy**: a *muted* dark crimson wash + a thin dim
  border. **Attackable**: a *brighter* crimson wash, a subtle fill breath, and a bright pulsing
  stroke on **the shared border with your own ground** — i.e. the map animates the line you would
  actually cross, which the V3 centre-to-centre links could not express.
- **HQ pip** on HARROW LANDING, **keep** on OBSIDIAN CROWN, and **battle scars** (one tick per
  attempt, capped at five) along the foot of any territory that has been fought for.
- The ocean animates off the screen's own render-side frame counter (never `state.tick`): three flat
  sea tones, the composited terrain layer drifting at 6% as sea floor, and 84 deterministic shimmer
  specks scrolling. The sim stays frozen exactly as on the title screen.

**Two draw caches**, which is what pays for the extra art:

- `land` — terrain fills, dithered texture, interior borders, coastline. Keyed on the map square's
  size only, so it survives every click and every conquest.
- `overlay` — ownership washes, firm borders, badges, scars and the resolved labels. Keyed on the
  size plus a signature of the campaign, so it is rebuilt only when the front moves.

Per frame that leaves: the sea, two `drawImage`s, the pulse and the hover outline.

#### 4. Label rules (the V3 collision was not repeated)

`campaignLabels(layout, campaign)` is **pure** and the harness asserts on it directly.

1. The anchor is the region's **pole of inaccessibility** (coarse grid + two refinements), so a name
   sits in the fat part of its region rather than on a centroid a concave outline can push against
   an edge.
2. **One name scale for the whole map.** The layout's body scale is used only when *every* name fits
   within **1.6x** its own region's bounding-box width at that scale; otherwise the whole map drops
   to scale 1. Mixing 1x and 2x bitmap type across one map reads as a mistake rather than as a
   hierarchy. Measured: scale 2 from **1440x900** up, scale 1 below — OBSIDIAN CROWN (longest name,
   narrowest region) is the binding case at every size.
3. The **tier / state tag is a second line only when it fits the region** (no wider than the bbox,
   no taller than 55% of it). Cramped regions and small windows go **name-only**: 5 of 416 placements
   across the tested matrix, all of them IRONWASH / OBSIDIAN CROWN at 960x620 and below.
4. **The reserved rect is the whole block** — badge above the name, scars below it — so the
   collision pass covers everything drawn. (The first cut hung the badge off the anchor and the
   stronghold's keep promptly landed on BLACKSPINE; the harness caught it.)
5. Blocks are placed **largest region first**, at the anchor, then over a deterministic ring search,
   then an exhaustive grid scan. Every candidate is clamped inside the map square before it is
   tested, so a label can never leave the window.
6. If the accepted block no longer covers its anchor, a **leader line** is drawn from the anchor to
   the block. At 640x480 and up the geometry is roomy enough that none is currently needed; the path
   fires from 560x420 down.

#### 5. Deviations / decisions

- **Geometry matches the graph exactly** (the brief's "simplest" option). There is no geometric
  neighbour pair that is not a campaign adjacency, so no river/ridge separator motif was needed.
- **The V3 centre-to-centre border links are gone.** Shared borders now carry that information, and
  the pulse carries the "you can cross here" part better than a lit link did.
- **`Territory.shape` / `cx` / `cy` are no longer drawn from** but are kept: `cx`/`cy` are asserted
  to lie inside the new regions (a live invariant), `shape` is the authoring record.
- **The map square stays square** (`campaignLayout` is untouched), because the continent space is
  0..100 in both axes and every consumer — the plate, the controls, `main.ts` — is unchanged.
- **The tag text gained one string**: an owned OBSIDIAN CROWN reads `CROWN HELD` rather than `HELD`.
  Everything else (`HQ`, `HELD`, `TIER n`, `n TRIED`) is V3 verbatim.
- **Below ~400x300 the map square is physically smaller than thirteen stacked name plates**, so the
  no-collision guarantee is asserted from 400x300 up (the screen's real floor is 640x480).
- **The first frame after entering the map or resizing builds both caches** — 14.2k `fillRect`s at
  1920x1080, ~8 ms in a browser, once. Every subsequent frame is 1.7k. This is the same order as the
  10 ms map generation the title screen already pays and was judged the right trade for a textured
  continent that costs nothing to keep on screen.

#### 6. Verified

`npm run build` clean (tsc --noEmit + vite). Five headless harnesses outside the repo, driving a
freshly compiled CommonJS mirror of the real sources through a stub DOM, a stub `localStorage`, a
recording 2D context and a controllable rAF clock: **10,103 / 10,103 checks**.

- **(a) geometry, 120 checks.** 26 interior + 31 coast edges; the geometric pair set is **exactly**
  the campaign's 26 undirected edges in both directions. Rasterized at two window sizes: at 640x480,
  84,547 land cells and 45,774 ocean cells with **0 pixels claimed by two territories, 0 pixels
  inside the coast owned by nobody, and 0 territory pixels outside the coastline**; at 1920x1080,
  143,302 / 77,598 with the same three zeros. Every graph edge is at least **26.1 px** of drawn
  shared border at 640x480 (shortest: RIFT COLLAR ~ VULTURE GAP; floor asserted at 20 px). Smallest
  region **3,502 px^2** at 640x480 (EMBER FLATS) against a 1,500 px^2 clickability floor, largest
  11,551 (HARROW LANDING); 23,736 -> 78,436 px^2 at 1920x1080. Coastline closed, 248 vertices, no
  segment jump > 6 units. Byte-identical across two module loads (deterministic).
- **(b) hit-testing, 133 checks.** Seven window sizes: **6,301 interior samples, 0 wrong**; all 13
  anchors hit-test to themselves; **all 13 clickable at 640x480**; 1,381 offshore samples, **0** hit
  a territory; points outside the map square return null. 416 border side-samples stepped 0.35 units
  off each border segment: **0 misclassified** (both sides always land on the two owners).
  Click routing: ASHEN REACH and KARST LINE select and open the plate, HARROW LANDING (owned) and
  OBSIDIAN CROWN (unreachable) do nothing.
- **(c) labels, 9,518 checks.** 8 window sizes (640x480, 800x600, 960x620, 1280x800, 1440x900,
  1920x1080, 480x900, 1100x720) x 4 ownership states (fresh / mid / nearly-done / all-owned) =
  **416 placements: 0 rect intersections, 0 off-window**. Every name and tag fits its reserved rect,
  every badge and scar row is inside it, every anchor is on the map square, and **every glyph exists
  in the 5x7 font**. Deterministic, returned in continent order. Separately swept over 16 sizes from
  400x300 to 2560x1440 x 3 states: **0 collisions, 0 off-window**.
- **(d) regression, 279 checks.** *Campaign logic*: 52 directed / 26 undirected edges, symmetry, no
  self-loops, tier distribution `1/2/3/3/3/1`, no edge skipping a tier, **the id/seed list asserted
  verbatim**, the fresh front, a loss changing nothing, resolve-twice being a no-op, the front
  growing on a win, tick accumulation, first-invasion and stronghold configs (easy/+600/LIGHT and
  hard/+7400/5 prebuilt/OVERWHELMING), save round-trip, **8 corrupt inputs -> fresh campaign**, and a
  false `"victory"` corrected. *Phase actions*: all seven `nextPhase` branches unchanged and the
  whole public surface `main.ts` uses still present. *Render smoke*: 7 sizes x 3 states x **45
  frames = 945 frames, 0 throws, 0 NaN coordinates, 0 negative-size rects**, with hover, an open
  invade plate and an armed reset exercised; a font spy confirms all 13 names + header + progress
  line + `HQ` + both controls reach the screen. *Perf* at 1920x1080: **0.0125 ms/frame mean, 0.0169
  p95** (0.0220 / 0.0285 with the invade plate up) against the 0.2 ms budget and a 16.7 ms frame;
  0.0104 ms at 640x480.
- **(e) the V3 loop through the real `main.ts`, 53 checks.** Booted through the stub DOM with a
  driven rAF clock: `C` opens the map; clicking OBSIDIAN CROWN from home does nothing; clicking
  ASHEN REACH selects without counting an attempt; **LAUNCH ASSAULT reaches the briefing, counts the
  attempt and saves immediately**; two briefing clicks deploy onto **seed 1326 at easy**;
  `campaignWin()` flips the territory and grows the front to `dry, karst, salt`, and **60 further
  ticks do not re-resolve**; the debrief click returns to the map and all five sampled territories
  hit-test correctly against the new save. A loss leaves `owned` byte-identical and **`R` retries the
  same seed**. The remaining eleven are taken stronghold-last: **13/13 owned, `victory` fired, 12
  won**, the CONTINENT SECURED screen draws clean, `campaignReset()` empties it and removes the save
  key, and the map redraws without error across three live window resizes.

#### 7. What to eyeball in the browser

1. **Press C from the title.** It should read as **one continent on an ocean** — a coastline with
   bays and headlands, sea shelf glow around it, shimmer specks drifting — not thirteen floating
   shapes. There should be **no gap anywhere between two territories**.
2. **Fresh campaign.** HARROW LANDING green on the west coast with the gold HQ pip; ASHEN REACH and
   KARST LINE in brighter crimson with the **border they share with HARROW pulsing**; everything
   else muted dark crimson; OBSIDIAN CROWN darkest, far east, with the red keep badge.
3. **Mid campaign** (take four or five). The gold belt should read as a front moving west to east,
   with the pulse jumping to the new border. Retry a territory and lose: `TIER n - 2 TRIED` plus two
   scar ticks under the name.
4. **Resize from 640x480 to full screen.** No two labels should ever touch; names step from 1x to 2x
   bitmap type at about 1440x900 and the whole map steps together; IRONWASH / OBSIDIAN CROWN drop
   their tier line at the small end.
5. **Everything else must be identical to V3**: hit-testing, the invade plate and its copy, the
   header and progress line, the double-confirm RESET CAMPAIGN, T MENU, the footer hint, and the
   CONTINENT SECURED panel.

### C1: era framework

The first phase of the **CHRONO CAMPAIGN**: a second campaign in which you time-travel to win
battles in past and future wars, each with its own unit roster. C1 is the sim-side foundation only —
era definitions, every new unit/building/weapon/warhead with tuned stats, availability gating, and
per-era AI compositions. **Art is placeholder** (drawn in the existing vocabulary so nothing renders
blank and the game is playable now); C2 owns the real per-era art and palettes, C3 the campaign flow.

New file: `game/eras.ts`. Touched: `game/rules.ts`, `game/state.ts`, `game/skirmish.ts`,
`systems/{production,ai,combat,movement}.ts`, `render/{sprites,renderer,ui}.ts`, `main.ts`.
No file was restructured, no system was reordered, the tick order is unchanged, and
`systems/{victory,orders,harvest,air,capture,fog}.ts`, `map.ts`, `constants.ts` and
`pathfinding.ts` were **not touched at all**.

**The load-bearing guarantee: `silicon` is the shipped game, bit-for-bit.** Every existing mode
(skirmish, the V3 conquest campaign) runs in the `silicon` era, whose rosters are exactly today's
type tables and whose AI composition table reproduces the pre-C1 `rollWantedUnit` pool *entry for
entry, in order*. Verified against the pre-C1 build compiled from git HEAD: identical sim signatures
across a 20-minute run, three difficulties and four seeds (below).

---

#### 1. The eras

| id | label | year | roster | tower | air pad / unit | scout | palette key |
|---|---|---|---|---|---|---|---|
| `trench` | THE GREAT TRENCH, 1917 | 1917 | rifleman, stormtrooper, landship, fieldgun | `mgnest` | — / — | rifleman | `trenchMud` |
| `steel` | THE STEEL WINTER, 1943 | 1943 | riflesquad, atgun, mediumtank43, heavytank, divebomber | `flaktower` | `airstrip` / divebomber | riflesquad | `steelWinter` |
| `silicon` | THE CRYSTAL DAWN, 1991 | 1991 | **the shipped nine, unchanged** | `guardTower` | `helipad` / gunship | minigunner | `siliconDesert` |
| `future` | THE LAST DAWN, 2077 | 2077 | plasmatrooper, hovertank, spidermech, swarmdrone, phaselancer | `lasertower` | `helipad` / swarmdrone | plasmatrooper | `futureNeon` |

- **`harvester` and `engineer` are temporal constants** — available in *every* era, because they
  travel with the player. That is also what makes the economy identical everywhere: same harvester
  (1400cr / 600hp / 700 cargo), same refinery (2000cr, free harvester, 1000 storage), same
  `HARVEST_RATE`, `HARVESTER_CAPACITY` and `CRYSTAL_TILE_AMOUNT`. **No economy number is era-dependent.**
- **Every other structure is shared**: conyard, powerPlant, refinery, barracks, warFactory,
  commCenter, silo, sandbag. Only the defence emplacement and the air pad change with the era, which
  is why the base you build feels like the same base in all four.
- `EraDef` also carries `flavor` (situation copy, field directives, a tag) for C3/C4 briefings, and
  `paletteKey` for C2.

#### 2. Gating

`GameState.era` is one additive field, set once by `initSkirmish` from the new
`SkirmishOptions.era` (default `DEFAULT_ERA` = `'silicon'`) and never written again — the roster is
resolved at setup, so nothing can change era underneath a running battle.

- **One gate, at the top of `canBuild`:** `if (!eraAllows(state.era, type)) return false;`. Everything
  below it is the pre-C1 prereq test unchanged. Because `canBuild` is what `enqueue`, the sidebar's
  grey-out, the AI's `want()` and the AI's composition `add()` all ask, **the era filter reaches every
  one of them from a single line**. In `silicon` the roster is the whole type table, so the filter is
  always true and the function behaves exactly as it did.
- **The sidebar grid** additionally *hides* off-era types: `buildableStructuresFor(state)` /
  `buildableUnitsFor(state)` filter `BUILDABLE_STRUCTURES` / `BUILDABLE_UNITS` by era, in the type
  table's own order. The C1 types are appended to `rules.ts` **after** the shipped ones, so silicon's
  grid is byte-for-byte the pre-C1 list (asserted against the old build's own constants).
- **`__game.spawn` ignores gating entirely** — it calls `createUnit` / `createBuilding` directly and
  always did. Spawning a spider mech into 1917 works, which is the point of a debug hook.
- **The free opening scout is the era's line infantry** (`eraScoutUnit`), `minigunner` in silicon.

#### 3. New sim mechanics (three, all small)

- **`beam` projectile kind.** A zero-travel-time hit: `spawnProjectile` resolves the damage on the
  tick the shot is fired (at the target's current position — a beam cannot be out-run or intercepted)
  and pushes a round carrying the new **`Projectile.spent`** flag, `prev` at the muzzle and `pos` at
  the impact, which lingers `BEAM_LIFE` (4 ticks) purely so the renderer has a line to draw.
  `updateProjectiles` ages a spent round out and never moves, re-aims or re-damages it. `detonate`
  was split into `resolveHit` (damage + splash + effect) and `detonate` (`resolveHit` + mark dead);
  every existing call site is unchanged.
- **`UnitTypeDef.ignoresTerrainCost`.** Skips the `TERRAIN_COST` multiplier in `movement.ts`.
  **It is not a passability flag** — a hover tank still pathfinds normally and still cannot cross rock
  or cliff. False on all sixteen other types.
- **`airstrip`**, the 1943 pad. Deliberately *not* a new mechanism: it is a helipad variant
  (`produces: ['air']`, `divebomber.producedAt = 'airstrip'`), and V2's whole rearm cycle works on it
  unmodified because `air.ts` looks the pad up through `UNIT_TYPES[type].producedAt` rather than by
  name. 3x2 rather than 2x2, and 900cr rather than 1000.

#### 4. Stat tables

**Units** (all ground unless flagged; `build` is at full power; `prereq` is on top of `producedAt`):

| era | id | name | kind | cost | hp | armor | speed | turn | sight | radius | weapon | turret | build | producedAt | prereq | ammo/rearm | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trench | `rifleman` | Rifleman | infantry | 80 | 45 | none | 1.6 | 0.6 | 5 | 5 | `boltRifle` | no | 3s | barracks | barracks | — | crushable |
| trench | `stormtrooper` | Stormtrooper | infantry | 180 | 65 | none | 1.9 | 0.6 | 5 | 5 | `grenade` | no | 5s | barracks | barracks | — | crushable |
| trench | `landship` | Landship | vehicle | 1400 | 520 | heavy | 2.1 | 0.10 | 5 | 12 | `sixPounder` | no | 14s | warFactory | warFactory | — | crusher |
| trench | `fieldgun` | Field Gun | vehicle | 800 | 170 | light | 1.5 | 0.14 | 6 | 10 | `fieldHowitzer` | no | 11s | warFactory | warFactory+commCenter | — | — |
| steel | `riflesquad` | Rifle Squad | infantry | 120 | 60 | none | 1.8 | 0.6 | 5 | 5 | `squadRifles` | no | 3s | barracks | barracks | — | crushable |
| steel | `atgun` | AT Gun | vehicle | 500 | 140 | light | 1.6 | 0.06 | 6 | 9 | `atRound` | no | 7s | warFactory | warFactory | — | — |
| steel | `mediumtank43` | Medium Tank | vehicle | 900 | 400 | heavy | 3.0 | 0.16 | 6 | 11 | `tankGun75` | yes | 9s | warFactory | warFactory | — | crusher |
| steel | `heavytank` | Heavy Tank | vehicle | 1700 | 520 | heavy | 2.2 | 0.12 | 6 | 12 | `tankGun88` | yes | 15s | warFactory | warFactory+commCenter | — | crusher |
| steel | `divebomber` | Dive Bomber | **air** | 1000 | 170 | light | 5.2 | 0.30 | 8 | 10 | `bombRun` | no | 10s | airstrip | airstrip | **4 / 6s** | isAir |
| future | `plasmatrooper` | Plasma Trooper | infantry | 220 | 70 | none | 1.9 | 0.6 | 5 | 5 | `plasmaBolt` | no | 4s | barracks | barracks | — | crushable |
| future | `hovertank` | Hover Tank | vehicle | 1100 | 330 | heavy | 4.4 | 0.26 | 6 | 10 | `pulseCannon` | yes | 10s | warFactory | warFactory | — | crusher, **ignoresTerrainCost** |
| future | `spidermech` | Spider Mech | vehicle | 2000 | 480 | heavy | 2.4 | 0.14 | 7 | 12 | `twinRailgun` | yes | 16s | warFactory | warFactory+commCenter | — | crusher |
| future | `swarmdrone` | Swarm Drone | **air** | 350 | 70 | light | 6.0 | 0.40 | 7 | 7 | `droneBolt` | no | 4s | helipad | helipad | **0 (unlimited)** | isAir |
| future | `phaselancer` | Phase Lancer | vehicle | 1500 | 220 | light | 2.6 | 0.16 | 8 | 10 | `beamLance` | no | 13s | warFactory | warFactory+commCenter | — | — |

**Structures:**

| era | id | name | cost | hp | w x h | sight | power | build | prereq | weapon | produces | standalone |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| trench | `mgnest` | MG Nest | 350 | 340 | 1x1 | 7 | -5 | 8s | barracks | `nestMg` | — | yes |
| steel | `flaktower` | Flak Tower | 600 | 420 | 1x1 | 8 | -15 | 10s | barracks | `flakBurst` | — | yes |
| future | `lasertower` | Laser Tower | 800 | 620 | 1x1 | 8 | **-40** | 12s | barracks | `towerLaser` | — | yes |
| steel | `airstrip` | Airstrip | 900 | 500 | 3x2 | 5 | -10 | 14s | warFactory | — | air | no |

All four are `productionStructure: false`, so **`CHEAPEST_PRODUCTION` is still 400** and the defeat
rule is still ConYard / Barracks / War Factory (asserted).

**Weapons:**

| id | name | dmg | warhead | range | min | cd | projectile | speed | inacc | targetsAir | vsAir |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `boltRifle` | Bolt Rifle | 12 | `smallArms` | 4.5 | 0 | 20 | bullet | 24 | 3 | no | 1 |
| `grenade` | Stick Grenade | 22 | `frag` | 3.2 | 0 | 34 | arc | 11 | 5 | no | 1 |
| `sixPounder` | 6-Pounder | 30 | `cannon` | 4.5 | 0 | 45 | shell | 14 | 3 | no | 1 |
| `fieldHowitzer` | Field Howitzer | 90 | `heavyShell` | 7.5 | 2 | 62 | arc | 9 | 9 | no | 1 |
| `nestMg` | Nest MG | 15 | `smallArms` | 7 | 0 | 11 | bullet | 24 | 2 | no | 1 |
| `squadRifles` | Squad Rifles | 10 | `smallArms` | 5 | 0 | 11 | bullet | 24 | 3 | **yes** | 0.4 |
| `atRound` | AT Shot | 50 | `apHigh` | 6.5 | 0 | 45 | shell | 20 | 1 | no | 1 |
| `tankGun75` | 75mm Tank Gun | 36 | `cannon` | 5.5 | 0 | 30 | shell | 16 | 2 | no | 1 |
| `tankGun88` | 88mm Tank Gun | 55 | `ap` | 6 | 0 | 42 | shell | 18 | 2 | no | 1 |
| `bombRun` | Bomb Rack | 125 | `bomb` | 3.5 | 0 | 14 | arc | 12 | 4 | no | 1 |
| `flakBurst` | Flak Burst | 26 | `flak` | 7.5 | 0 | 9 | bullet | 26 | 2 | **yes** | 1.3 |
| `plasmaBolt` | Plasma Bolt | 26 | `plasma` | 5 | 0 | 26 | bullet | 14 | 2 | **yes** | 1 |
| `pulseCannon` | Pulse Cannon | 36 | `plasma` | 5.5 | 0 | 28 | shell | 18 | 2 | no | 1 |
| `twinRailgun` | Twin Railgun | 48 | `railSlug` | 6 | 0 | 34 | shell | 22 | 2 | no | 1 |
| `droneBolt` | Drone Bolt | 9 | `plasma` | 4 | 0 | 12 | bullet | 16 | 2 | no | 1 |
| `beamLance` | Phase Lance | 85 | `beam` | 9 | 2 | 62 | **beam** | 240 | 0 | no | 1 |
| `towerLaser` | Tower Laser | 42 | `laser` | 8.5 | 0 | 16 | **beam** | 240 | 0 | **yes** | 1 |

**Warheads** (the six shipped ones are untouched):

| id | name | none | light | heavy | structure | splash |
|---|---|---|---|---|---|---|
| `frag` | Fragmentation | 1.0 | 0.6 | 0.35 | 0.5 | 34 |
| `heavyShell` | Heavy Shell | 0.85 | 0.8 | 0.7 | 0.75 | 40 |
| `apHigh` | AP Shot | 0.25 | 1.0 | **1.15** | 0.5 | 0 |
| `bomb` | Bomb | 0.75 | 0.9 | 0.8 | 0.75 | 50 |
| `flak` | Flak | 0.85 | 0.9 | 0.35 | 0.3 | 10 |
| `plasma` | Plasma | 0.8 | 1.0 | 0.95 | 0.55 | 8 |
| `railSlug` | Rail Slug | 0.5 | 0.95 | 1.05 | 0.85 | 0 |
| `beam` | Phase Beam | 0.5 | 1.0 | 1.1 | 0.8 | 0 |
| `laser` | Laser | 0.9 | 1.0 | 0.8 | 0.5 | 0 |

#### 5. Who can shoot up, per era

Anti-air is `Weapon.targetsAir`, exactly as V2 defined it — no unit is special-cased.

| era | anti-air | aircraft |
|---|---|---|
| trench | **none at all** | none |
| steel | `flaktower` (1.3x), `riflesquad` (0.4x chip) | divebomber |
| silicon | minigunner (0.5x), rocketSoldier, buggy, gunship, guardTower — **unchanged** | gunship |
| future | `lasertower`, `plasmatrooper` | swarmdrone |

**Neither the dive bomber's bombs nor the swarm drone's bolt can engage aircraft** (`targetsAir:
false`): a bomber is not an interceptor, and the drone carries ground-attack munitions. The
consequence — a drone-vs-divebomber duel is a mutual no-op — is documented rather than special-cased;
the era's real answer to either is its tower.

#### 6. The AI, per era

Only three things in `ai.ts` became era-aware, and all three are `silicon`-identity by construction:

- **`buildPlanFor(era)`** replaces the fixed `BUILD_PLAN`. Six of its eight entries are shared; the
  pad entry (`helipad` / `airstrip`, still `only: ['normal','hard']`) is skipped entirely in 1917, and
  the defence entry asks for the era's own emplacement. Plans are built once per era and cached. In
  silicon the produced array is entry-for-entry the pre-C1 one.
- **The composition roll** now walks `ERAS[era].composition` in array order, using the same three tech
  phases the pre-C1 code branched on (`early` = no war factory, `late` = war factory, `tech` = + comm
  centre), the same `INFANTRY_SHARE` cut and the same `minWave` gate for siege weapons. Because the
  rows are walked in order and a zero weight is skipped before `canBuild` is asked, the *pool array* a
  phase produces in silicon is byte-identical, so the same RNG draw picks the same type.
- **The air purchase** buys `eraAirUnit(era)` instead of `'gunship'`, and the whole branch is skipped
  when the era has no aircraft. `AIR_WANTED` per difficulty is unchanged.

| era | composition (early / late / tech weights) |
|---|---|
| trench | rifleman 6/2/2 (share-gated), stormtrooper 3/3/3 (share-gated), landship 0/6/4, fieldgun 0/0/3 (wave 2+) |
| steel | riflesquad 6/2/2, atgun 0/3/3, mediumtank43 0/6/4, heavytank 0/0/5 |
| silicon | minigunner 6/2/2, rocketSoldier 3/3/3, lightTank 0/6/3, mediumTank 0/0/5, artillery 0/0/3 (wave 2+) — **the pre-C1 pool** |
| future | plasmatrooper 6/2/2, hovertank 0/6/4, spidermech 0/0/5, phaselancer 0/0/3 (wave 2+) |

**Measured, 20 sim-minutes, seed 1337, normal, immortal human base:**

| era | build timeline | waves (units) | harvested | peak army | first contact |
|---|---|---|---|---|---|
| trench | plant 0:08, refinery 0:28, barracks 0:39, factory 1:08, **nest 1:16**, comm 1:44 | 04:00 (5) / 07:08 (7) / 09:59 (16) / 12:32 (27) / 16:55 (34) | 48,710cr | 37 | 04:58 |
| steel | plant 0:08, refinery 0:28, barracks 0:39, factory 1:08, **strip 1:22, flak 1:33**, comm 2:01 | 04:00 (5) / 07:04 (9) / 10:28 (16) / 13:11 (23) / 15:52 (34) | 57,400cr | 37 | 05:01 |
| silicon | plant 0:08, refinery 0:28, barracks 0:39, factory 1:08, pad 1:22, tower 1:33, comm 2:01 | 04:00 (5) / 06:57 (10) / 09:49 (17) / 12:42 (26) / 17:01 (34) | 58,800cr | 37 | 04:58 |
| future | plant 0:08, refinery 0:28, barracks 0:39, factory 1:08, **pad 1:22, laser 1:35**, comm 2:05 | 04:00 (5) / 07:10 (8) / 10:04 (13) / 12:58 (18) / 17:11 (20) | 58,800cr | 27 | 04:58 |

Every era: five waves, first wave on silicon's own 04:00 clock, growing composition
(1917 finishes on 10 riflemen + 16 landships + 8 stormtroopers; 1943 on 13 medium + 10 heavy tanks +
4 AT guns + a bomber; 2077 on 7 mechs + 4 hover tanks + 7 lancers), a second refinery, no crash and
no starvation. **The 2077 army peaks lower (27 vs 34)** because its roster is the most expensive in
the game — it spends 64,924cr against silicon's 54,867 — which is a real difference in feel, not a
fault. **1917 pins against its storage ceiling instead** (ends 17,500/17,500cr with 7 silos): its
roster is the cheapest, so the Phase 7 late-game credit pin fires there rather than late-game
poverty.

#### 7. Balance, and how each target was met

Silicon numbers are quoted as the reference and **were not changed**.

| target | result |
|---|---|
| infantry line fights in silicon's time family | 1v1 at 3 tiles: rifleman **63** ticks, riflesquad **58**, minigunner **63** (reference), plasmatrooper **83** |
| era heavy armour beats era standard 1v1, 20-45% left | heavytank vs mediumtank43 **214/520 = 41%** (298 ticks); spidermech vs hovertank **206/480 = 43%** (208 ticks). Silicon reference: medium vs light **125/400 = 31%** |
| era tower kills 3 line infantry keeping >85% | mgnest **94%** (142 ticks), flaktower **95%** (111), guardTower **93%** (151, reference), lasertower **93%** (100) |
| artillery-class counters era armour, cost-adjusted | 2 fieldguns (1600cr) beat a landship (1400cr) from 8 tiles, 1 surviving on 84%; 4 AT guns (2000cr) beat a heavy tank (1700cr) in 105 ticks, 3 surviving; 2 phase lancers (3000cr) beat a spider mech (2000cr) in 130 ticks, **both** surviving on 69% |
| divebomber payload ≈ a mediumtank43 | analytic 4 x 125 x 0.8 = **400** = the tank's hp exactly; live run (arc bombs, splash falloff, ±4px scatter) deals **371** and leaves it on **29hp / 7%** |
| swarmdrone loses 1v1 to a strike aircraft | dies to a gunship in **13 ticks**, leaving it on 97% |
| 3 swarmdrones beat ground armour with no AA, cost-adjusted | 3 drones (1050cr) kill a hover tank (1100cr) in **156 ticks** without a scratch — the pulse cannon cannot shoot up |
| ... and AA answers them | lasertower kills 3 drones keeping **91%**; flaktower shoots a dive bomber down in **56 ticks**, keeping 33% |
| every era with air has AA; trench has neither | asserted from the weapon tables (table in §5) |
| economy identical in all eras | asserted on the type tables *and* on four full runs: 48.7k-58.8k harvested |
| hover ignores terrain speed only | 40 tiles of sand: hovertank **218 ticks against an ideal 218**; spidermech 457 against its own 400/460. Passability unchanged |

#### 8. Deviations / decisions

- **`silicon` era names the shipped roster and nothing else.** The four new structures and fourteen
  new units are appended to the type tables *after* the existing entries, so `BUILDING_TYPE_IDS` /
  `UNIT_TYPE_IDS` ordering — and therefore the silicon sidebar grid — is unchanged.
- **`UnitTypeDef` gained one required field**, `ignoresTerrainCost` (false on all nine existing types,
  matching how `isAir` / `captures` were added). `GameState.era`, `SkirmishOptions.era` and
  `Projectile.spent` are the other three additive fields. Nothing was renamed.
- **The spider mech's "dual weapon" is one weapon.** The sim has a single weapon slot per unit type
  and `Weapon.burst` has been declared-but-unread since Phase 1; `twinRailgun` therefore carries both
  barrels' damage on one trigger rather than firing two. Flagged rather than faked.
- **The field gun does not deploy/undeploy** (the C1 brief's call): it is simply slow (1.5 px/tick),
  fragile and long-ranged.
- **The 1943 pad is a new structure, not a re-used helipad.** An `airstrip` reads as the era and costs
  100cr less; the V2 rearm cycle needed **zero** changes because it resolves the pad through
  `producedAt`.
- **Beams are hitscan, and hitscan is new.** The alternative (a very fast travelling projectile) would
  have been interceptable by nothing and identical in effect, but would have needed a real speed and a
  render path that lags the impact. `spent` is the minimal way to keep a resolved round on screen.
- **The swarm drone has unlimited ammo** (`ammo: 0`), so `air.ts` is a complete no-op for it: it never
  returns to a pad, never docks and never rearms. That is what "cheap fragile air" buys.
- **Trench era towers can only kill infantry.** `nestMg` is `smallArms` (0.2x vs heavy), so an mgnest
  does nothing to a landship — deliberate, and the reason 1917 wants field guns.
- **`crusher` / `crushable` remain unimplemented** (a pre-existing gap: the flags have never been read
  by any system). The new heavies carry them for the day someone implements it, and no era copy claims
  crushing works.
- **Silicon artillery still loses to armour cost-adjusted** (2 artillery vs 1 medium tank). That is
  the shipped behaviour — `arc` shells commit to a point, Phase 7 checklist item 4 — and the harness
  measures it for reference only rather than changing it.

#### 9. Verified

`npm run build` clean (tsc --noEmit + vite). Six headless harnesses in the scratchpad (a **freshly
compiled CommonJS mirror** of `src/game` + `src/engine`, plus `src/render/sprites.ts` through a
software canvas, driven through the real tick order — including main.ts's end-of-tick `state.tick++`,
which the AI's decision phase depends on), **916/916 checks**. The regression harness compiles a
**second mirror from git HEAD** and A/Bs against it.

- **(a) silicon regression, 19 checks.** Seed 1337 / normal / 20 sim-minutes: the full sim signature
  (every entity's position, facing, hp, ammo, cargo, order and target; both build queues; credits,
  power, storage; the whole stat table; the AI's wave bookkeeping; remaining map crystal) is
  **identical to the pre-C1 build at every 4000-tick mark and at the end**, as are the wave clock
  (**04:00 / 06:57 / 09:49 / 12:42 / 17:01**) and gross inflow (**55,254cr**). Same for easy and hard
  at 10 minutes, and for seeds **355 / 245 / 1273**. The medium-vs-light duel still ends
  **125/400 hp in 309 ticks** — bit-identical to Phase 4, Phase 7, the stances phase, V2 and V3. The
  C1 build replays its own seed bit-identically.
- **(b) gating, 535 checks.** Every era: the roster partitions correctly, harvester + engineer are in
  all four, every shared structure is in all four, exactly one defence emplacement each, every unit's
  `producedAt` and every prereq is a structure the era can actually build, and every unit type in the
  game belongs to some era. `canBuild` returns exactly the era's membership for **all 23 unit types
  and all 14 structures in all four eras** with a full tech tree standing, `enqueue` refuses every
  off-era type and leaves the queue empty, and the sidebar lists are era-only. Silicon's two sidebar
  lists are asserted **against the pre-C1 build's own constants**, in order. `createUnit` /
  `createBuilding` (the `__game.spawn` path) create off-era types in every era. Over four 15-minute
  hard runs the AI **fielded only era units and built only era structures** in all four. Defaults:
  a bare `createGameState` and an option-less `initSkirmish` are both `silicon`; the free scout is the
  era's line infantry. `CHEAPEST_PRODUCTION` is still 400 and the production set is still
  `barracks,conyard,warFactory`.
- **(c) balance, 47 checks.** The table in §7, plus: the beam fires and damages **on the same tick**,
  deals exactly `85 x 1.1 = 93.5` to heavy armour, is marked `spent`, never damages twice while its
  visual lingers, and is cleaned up.
- **(d) AI per era, 87 checks.** The runs in §6. Each era builds refinery / barracks / war factory /
  two power plants / its own emplacement (and its pad where it has one), harvests **>20,000cr**,
  launches **5** waves that grow, reaches the human base by **05:01**, fields vehicles rather than only
  infantry, and is still playing at 20 minutes. Cross-era: identical first-wave clock, wave counts
  within 0 of silicon's, economies within 0.83-1.00x of silicon's. Easy and hard at 10 minutes in all
  four eras launch waves and field 23-49 units.
- **(e) sprites, 218 checks.** `auditSprites()` is now **1176 entries (was 566, +610 exactly as
  budgeted: 448 hulls + 128 turrets + 16 building frames + 18 icons)**, built in **59ms with 0 under
  20 opaque px**. Every new unit has 32 hull sprites (thinnest facing 236px, the rifleman) and every
  new turreted unit 32 turret sprites; every new structure has all four frames; and every sidebar icon
  is checked for **real ink** (231-863 px that are not the icon plate), so an empty drawer cannot pass.
  Every type named by every era roster resolves to art.
- **(f) perf, 10 checks.** 20 sim-minutes, normal, seed 1337 (budget 50 ms/tick):
  pre-C1 **0.0255 ms mean / 0.0440 p95**; C1 trench **0.0257 / 0.0446**, steel **0.0256 / 0.0416**,
  silicon **0.0236 / 0.0385**, future **0.0154 / 0.0270**. A 150-unit 2077 battle with 30 beam
  platforms and 30 drones runs at **0.120 ms mean / 0.267 p95 / 0.86 worst** over 600 ticks
  (budget 10 ms) with 101 dead.

#### 10. Handoff

**To C2 (art).** Every new type currently renders a *placeholder silhouette* built from the existing
shape vocabulary — readable, on-grid, house-coloured, non-blank, but not era art.

- **Hulls needing real art (14):** rifleman, stormtrooper, landship, fieldgun / riflesquad, atgun,
  mediumtank43, heavytank, divebomber / plasmatrooper, hovertank, spidermech, swarmdrone, phaselancer.
  **Turrets needing real art (4):** mediumtank43, heavytank, hovertank, spidermech.
  **Structures (4):** mgnest, flaktower, lasertower, airstrip. **Sidebar icons: all 18.**
- **The era towers share the Guard Tower's gun sprite.** `renderer.drawBuildings` composites
  `getTowerTurret(player, facing)` for any structure with `turret: true`, so mgnest / flaktower /
  lasertower currently wear a 1991 autocannon. Giving `getTowerTurret` a type parameter is the natural
  C2 change; the audit will need the extra entries.
- **Palette keys** are `EraDef.paletteKey`: `trenchMud`, `steelWinter`, `siliconDesert`, `futureNeon`.
  `SCHEMES` (the two house colours) is deliberately untouched — C2 should decide whether an era
  re-tints the terrain ramp (`SPRITE_PALETTE` / `C`), the house schemes, or both. `state.era` is
  readable from every render entry point.
- **Beam rendering.** `render/renderer.ts` has a placeholder branch: a 2px cyan line from
  `p.prev` (muzzle) to `p.pos` (impact) fading over `BEAM_LIFE` = 4 ticks, plus a 4px impact spark.
  The sim guarantees `prev`/`pos` are the endpoints and `spent === true`. C2 owns the real look
  (core + bloom + impact flash), and should key colour off the weapon (`p.weapon` is
  `beamLance` or `towerLaser`).
- **Bomb rendering.** `bombRun` is an `arc` projectile, so it already draws with the artillery
  shell/shadow path. `p.weapon === 'bombRun'` distinguishes a falling bomb from a howitzer shell if
  C2 wants a different sprite; the dive bomber itself wants a dive/pull-up read, which nothing in the
  sim expresses today.
- **Drone / bomber chrome.** V2's rotor sprite and ammo pips are keyed on `isAir` and `ammo > 0`, so
  the dive bomber inherits pips (4 of them) automatically and the swarm drone inherits **none**
  (unlimited ammo) — check that reads correctly.

**To C3 (campaign flow).** Era travels exactly like difficulty: a module-level choice in `main.ts`
handed to `initSkirmish` through `SkirmishOptions`.

- `SkirmishOptions.era?: EraId` (default `'silicon'`), consumed by `initSkirmish`, which writes
  `state.era` **before** placing anything. `main.ts` holds `let era: EraId = DEFAULT_ERA` and
  `newGame()` passes `{ ...campaignBattle, difficulty, era }`. A chrono mission config only needs to
  add an `era` field to the object it already hands over — exactly how V3's `CampaignBattleConfig`
  adds `aiCreditBonus` / `aiScaling` / `aiPrebuilt`, and it composes with all of them.
- **`__game.era(next?)`** reads `{ current, next, def }` and selects the era for the **next** mission
  (never mid-battle). It is the debug counterpart of `__game.ai(level)`.
- `EraDef.flavor` carries `situation` (2-3 lines), `directives` (bullet copy in the briefing's voice)
  and `tag`, all uppercase and 5x7-font-safe. `BRIEFING_CHARS` is computed from the copy, so a
  per-era briefing follows automatically. `label` (`THE GREAT TRENCH, 1917`) is the headline and
  `short` the HUD tag.
- Nothing about the V3 conquest campaign changed: it opens on `silicon` and is covered by the
  bit-identical proof.

#### 11. Known rough edges

- **No UI selects an era.** There is no title-screen or briefing affordance; `__game.era('trench')`
  then deploy is the only path today. That is C3's job by design.
- **Cross-era spawning is legal and occasionally silly.** `__game.spawn` ignores gating (deliberately),
  so a 1917 rifleman can be put in front of a gunship it is physically unable to shoot at
  (`boltRifle.targetsAir` is false). Nothing crashes; it just looks odd.
- **The era towers all use the Guard Tower gun sprite** (above).
- **A drone-vs-divebomber duel is a mutual no-op**: neither weapon can engage air.
- **`Weapon.burst` is still unread** and `crusher`/`crushable` are still unimplemented — both
  pre-existing, both now carried by C1 types too.
- **2077 is the expensive era.** Its AI peaks at 27 units against silicon's 34 on the same clock and
  spends its bank down to nothing; 1917 is the cheap era and pins against its storage ceiling. Both
  are in family and neither starves, but a C4 balance pass may want the army cap to be value-based
  rather than count-based (the Phase 6 handoff already flagged this).

### C2: era art

The second phase of the **CHRONO CAMPAIGN**: C1's fourteen units, four turrets, four structures and
eighteen icons stop being placeholder silhouettes and become real art, and the ground itself becomes
era-aware — so a 1917 battle *looks* like 1917 and a 2077 battle looks like 2077.

**Render-side only.** Touched: `render/sprites.ts` (the art), `render/renderer.ts` (era tower guns,
aircraft chrome, the projectile/impact layer), `render/ui.ts` (radar ramp per era) and `main.ts` (the
palette hook in `restart()`). **No file under `src/game` or `src/engine` was touched at all** —
verified by diff against a snapshot of the tree taken before this phase started, and by mtime (the
newest sim file predates the phase). No new dependency, no restructuring, `tsc --noEmit + vite build`
clean.

---

#### 1. Terrain: one drawer set, four ramps

`TerrainPalette` is the Phase 1 colour table lifted into a type, and the five terrain drawers now
take one as an argument. Four are declared, keyed **exactly** on `EraDef.paletteKey`:
`trenchMud` / `steelWinter` / `siliconDesert` / `futureNeon`.

- **`siliconDesert` *is* the shipped table**, value for value, and the shared drawing code is
  untouched — so 1991 is byte-identical rather than merely intended to be. Proved twice: the 20
  cached tile sprites hash to the pre-C2 build's `4f783d93…`, and the full composited 2304x2304
  terrain layer for seed 1337 hashes to `818a1467…` under both builds.
- **A per-era flourish pass (`terrainStyle`) runs last on each tile**, and `desert` is a no-op that
  pulls **zero** RNG draws. That is the mechanism behind the byte-identity: silicon's random stream
  cannot move because nothing new asks it for a number.
  - **`mud` (1917)** — shell craters: a churned dark ring with water standing in it, 1-2 per ground
    tile. Ramps are brown-olive grass, brown mud flats in place of sand, earth banks for cliff.
  - **`winter` (1943)** — snow drifts plus loose flecks, heaviest on rock. Pale grey-green ground,
    near-white frozen flats, snow lying on the stone.
  - **`neon` (2077)** — teal and violet mineral glints, with a vein or two through rock. Much darker
    ground overall.
- **Crystal is deliberately near-constant.** It is the economy, so the shard ramp is the same green
  in all four eras and the *style pass is skipped entirely on crystal tiles* — snow or mud lying on
  top of the shards is exactly what would make them stop reading. Only the ground under them and the
  glow strength move; `futureNeon` runs the glow at 0.30 alpha against the others' 0.14-0.16, which
  is the "the crystal here burns hot" line from the era's own briefing copy.
- **Caching**: one built set per palette in a `Map`, built **lazily** — a silicon-only session never
  pays for the other three. `initSprites()` clears the map and eagerly builds only the active
  palette, so boot cost is unchanged (0.67 ms against the pre-C2 0.51 ms).
- **The hook is `setTerrainPalette(key)` in `main.ts`**, called from the new `applyEraPalette()`
  immediately **before** `renderer.buildTerrain(state.map)` — at boot and in `restart()`, which is
  the one path every mission takes (skirmish, campaign battle, R after a defeat). `setTerrainPalette`
  only swaps which cached set `getTerrainSprite` serves; the dirty-tile API is untouched, and an era
  change is therefore an ordinary full re-composite. An unknown key falls back to the desert rather
  than throwing.
- **The radar follows the ground.** `ui.ts` had one hardcoded RGB-per-terrain table; it is now one
  table per palette, with `siliconDesert` holding the shipped constants verbatim. The minimap is
  already invalidated by `sidebar.reset()` on restart, so this needed no new plumbing.

#### 2. Units — 14 hulls + 4 turrets

Same vocabulary as Phase 6 (body-space rectangles rasterised at each of 16 facings, 2px art grid,
derived shadow + outline, cached per type/player/facing), so nothing about the rendering path
changed. **Era carries silhouette and material; the house scheme still carries the faction** — every
sprite keeps its olive/gold or slate/crimson trim exactly where the Phase 6 art puts it, so the
readability rules hold in all four time periods.

Materials are house-independent and used sparingly: `IRON` / `WOOD` (1917), `GUNMETAL` /
`WHITEWASH` (1943 winter camo streaks), and the 2077 energy set (`NEON_TEAL` plasma, `NEON_VIOLET`
phase, `MECH_HOT` reactor orange).

- **1917** — *rifleman*: greatcoat skirt, soup-plate helmet brim, bolt rifle at port with a timber
  stock and a bolt handle. *stormtrooper*: hunched under a coal-scuttle helmet with a neck guard, a
  satchel of grenades, one stick grenade cocked back over the shoulder and a trench club in the off
  hand. *landship*: **the lozenge** — tracks running right around a rhomboid frame that draws in at
  both ends, a sponson bulging from each flank with its gun raked forward, riveted strakes, a
  commander's cab and a steering tail. *fieldgun*: big spoked wheels (tyre, cross spokes, hub cap),
  split timber trail with spades, and a crew shield with a sighting slot.
- **1943** — *riflesquad*: **three men on one base**, a lead pair up front and a rifleman covering
  behind with the section radio, so it reads as a section rather than a soldier. *atgun*: low
  split-trail carriage behind a wide sloped shield. *mediumtank43*: road wheels showing through the
  track run, sloped glacis, hull machine gun, stowage box. *heavytank*: visibly longer and wider,
  four-plate engine grill, turret stowage bin. *divebomber*: **inverted gull wing** (inner section
  kinked forward, outer panels swept back), spatted fixed undercarriage, radial cowling, bomb on the
  centreline crutch.
- **2077** — *plasmatrooper*: bulky powered armour with pauldrons, a lit chest core, visor band and
  reactor pack. *hovertank*: chamfered slab riding a skirt, **no tracks anywhere**, segmented lift
  glow under the flanks and a brighter rear thruster wash. *spidermech*: four legs of thigh -> knee
  block -> foot, splayed well outside the chassis, so the body reads as lifted clear of the ground.
  *swarmdrone*: a stepped diamond with four stub vanes and lit tips — **no rotor**. *phaselancer*:
  almost all gun, a violet rail running the length of a low chassis fed by two capacitor banks.
- **Turrets** (`mediumtank43`, `heavytank`, `hovertank`, `spidermech`): rounded cast turret with a
  coax; angular welded turret with a long 88 and a double-baffle brake; a low disc mount with a lit
  charge ring; a twin railgun cradle with capacitors burning between the rails.

#### 3. Structures, and the tower gun that was shared

- **`getTowerTurret(player, dir, type = 'guardTower')`** — the C1 handoff's requested change. Each
  era's emplacement now has its own weapon: a water-cooled MG on a tripod with an ammo can (1917), a
  **quad flak mount** with four splayed elevated barrels (1943), and an emitter head of focusing
  rings around a lit lens (2077). The Guard Tower's shapes are unchanged **and keep their cache key**
  (`t|guardTower|p|d`), so 1991 is the pixel reference it was. `renderer.drawBuildings` passes
  `b.type`; the audit derives the list from `BUILDING_TYPES[type].turret` rather than a hand-kept one.
- **mgnest**: a horseshoe of sandbags (three staggered courses) around a dug-in pit with a black
  embrasure and timber baulks over the back. No metal anywhere on it.
- **flaktower**: an open steel gun deck on a concrete plinth — corner railings, deck plating,
  ammunition lockers and a range-finder post, with the quad barrels supplied by the turret sprite.
- **lasertower**: a slim pylon carrying a focusing crystal. **Two frames, and they are a power state,
  not an animation**: frame 0 is the cold dark tower, frame 1 is lit with its conduits burning and a
  wash of light on its own footing. `Renderer.buildingFrame` picks it off
  `state.players[b.player].lowPower`, which finally puts the Phase 4 rule ("a defence goes offline
  under `lowPower`") on screen. Constructing forces frame 0, so a half-built tower is dark too.
- **airstrip**: a graded 3x2 strip with the runway laid **across the middle of the footprint**, so a
  docked Dive Bomber — which `air.ts` parks on the structure's centre, exactly like a helipad —
  sits square on the runway. Hangar with an open mouth and a sandbagged revetment at the west end,
  fuel dump, ground-crew hut and windsock at the east, threshold bars and a dashed centre line.
- Constructing/selling states are the existing generic paths (`scaffoldOverlay`, the sink-and-fade),
  so all four new structures inherited them with no work.

#### 4. Aircraft chrome — `airChromeFor(type)`

V2 keyed the spinning rotor on `isAir`, which put a **helicopter disc over a 1943 propeller bomber**
and over a 2077 drone with no moving parts at all. `sprites.ts` now owns a render-side art table:
`rotor` (gunship, and the default for anything added later), `prop` (dive bomber) and `none` (swarm
drone). The propeller is a new 4-frame disc, cached per (player, frame) like the rotor and offset
along the hull's facing to sit at the **nose** rather than centred on the airframe; it freezes and
dims while docked, exactly as the rotor does. The sim knows nothing about any of this.

#### 5. Projectiles and impacts

- **Beams are a real laser now.** Four strokes along the muzzle -> impact line the sim already
  guarantees (`prev` / `pos` / `spent`, `BEAM_LIFE` = 4): a wide soft bloom, a second narrower bloom,
  a saturated mid stroke and a white-hot core, all fading with `life`. A collapsing 3-frame flare
  sits on the impact and a dimmer one back at the muzzle. Colour keys off `p.weapon` —
  **`towerLaser` cuts teal, `beamLance` is violet and 40% heavier on every stroke** (it is a siege
  weapon), and the Laser Tower's own crystal was re-tinted teal to match the beam it fires.
- **Bombs tumble.** A `bombRun` `arc` round draws an 8-frame tumbling bomb sprite (fins, body, yellow
  band, dark nose) instead of the howitzer shell, stepping off `state.tick` and offset by the round's
  id so a stick of bombs does not tumble in lockstep. The ground shadow is the existing arc path.
- **Energy rounds** are keyed on the **warhead**, not on a unit type: `plasma` (plasma bolt, pulse
  cannon, drone bolt) draws a glowing teal bolt with a soft trail, `railSlug` a violet-white slug.
  Three sizes, picked off the round's damage, so a 9-damage drone bolt is visibly not a 36-damage
  pulse shell.
- **Flak** rounds are a dark shell with a burning tracer element rather than a machine-gun streak,
  and burst into a **grey-white airburst puff** with a hot centre and shrapnel specks.
- **The impact tracker, and why it exists.** `Effect` carries no weapon id on an explosion, so a flak
  airburst and a bomb's heavier blast cannot be distinguished from any other splash by the effect
  alone — and putting a field on `Effect` would have been a sim change. Instead `Renderer` diffs
  `state.projectiles` **once per tick**, remembers each watched round's *committed* impact point
  (`Projectile.target`, so the burst lands where the shot lands rather than a tick short), and emits
  its own effect when the round leaves the array. It is strictly **additive** — the sim's own
  explosion still plays underneath — so a round the tracker misses degrades to exactly the pre-C2
  picture. Watched weapons are one table (`TRACKED_IMPACTS`): `flakBurst` -> puff, `bombRun` -> a
  5-frame shockwave ring sized off the warhead's 50px splash. Capped at 96 live effects and aged in
  the tracker rather than in `draw`, so a backgrounded tab cannot grow the list.
- **Muzzle flashes are untouched**, per the brief.

#### 6. Icons

All eighteen redrawn in the Phase 3 schematic style, era-legible at 34px: sandbag courses with a
black embrasure, four raked flak barrels, a pylon firing a teal beam, a runway with a hangar; a
brimmed helmet and a bolt rifle, a raised stick grenade, a rhomboid track frame, a spoked wheel
behind a shield, **three helmets for the rifle squad**, a tall AT shield with a whitewash streak,
two different tanks (the heavy is bigger and its 88 overhangs the plate), a gull-winged plane seen
nose-up, a lit visor and chest core, a skirt with a lift cushion, a legged walker with twin rails,
a diamond with four lit tips, and a violet rail. Four era inks were added to the icon palette
(`wood`, `earth`, `snow`, `teal`, `violet`); no shipped icon moved.

#### 7. `spriteAudit()` — **1373 entries (was 1176, +197)**

| group | count | note |
|---|---|---|
| terrain | 80 (+60) | 4 palettes x 5 types x 4 variants; keys are now `terrain\|<palette>\|t\|v` |
| unit hulls | 768 | unchanged in count, redrawn in content |
| turrets | 352 (+96) | 7 unit turrets + **4** tower guns x 2 players x 16 facings |
| rotor / prop | 8 / 8 (+8) | the propeller disc is new |
| buildings | 72 (+2) | the Laser Tower's second (lit) frame, both players |
| icons | 37 | unchanged in count, 18 redrawn |
| fx | 48 (+31) | 6 beam flares + 3 energy bolts + 4 flak puffs + 10 shockwaves + 8 bomb frames |

The audit switches through all four palettes and **restores the active one**, so running it never
leaves the world in 1917.

#### 8. Restart hygiene

Two new lines in `restart()`, both beside the existing cache resets: `applyEraPalette()` **before**
`renderer.buildTerrain` (the palette decides what the composite is made of), and the new
`renderer.resetFx()`, which drops the render-side impact effects and the rounds being watched for
them — both are keyed on `state.tick` and on projectile ids, and a new mission restarts both
numberings. The terrain palette cache itself is keyed on the palette, not on the mission, so it
deliberately survives; `initSprites()` clears it.

#### 9. Deviations / decisions

- **`game/eras.ts` was not touched**, so `EraDef.paletteKey` is still a `string`. The render side
  owns the `TerrainPaletteKey` union and validates the string, which keeps the whole phase off the
  sim. A typo'd key renders the desert instead of throwing.
- **The impact tracker is a render-side effect system** (above). The honest alternative was
  `Effect.weapon` on explosions — a one-field sim change — and it was rejected because the render
  side can already see everything it needs on the projectile.
- **The Laser Tower's power state re-uses `buildingFrameCount`** rather than adding a new art state.
  It is the only structure whose "frames" are not an animation, which is documented on both ends.
- **The radar ramp moved with the ground** (`ui.ts`). Not asked for, but a snowy 1943 map under a
  desert-coloured radar reads as a bug. Silicon's numbers are verbatim.
- **The hover tank's lift glow is segmented, not a full outline.** The first cut ran an unbroken
  bright teal band right around the hull and read as a selection box; it is now four dim patches
  plus a brighter rear wash and four bright vents.
- **The dive bomber still has no dive/pull-up read.** Nothing in the sim expresses a dive (the C1
  handoff said as much); it gets a prop disc and a bomb-carrying silhouette instead.
- **The title-screen backdrop uses whatever palette the last mission built.** It is composited at
  boot from the default era and rebuilt on restart, so selecting an era with `__game.era()` and
  returning to the title shows the *previous* era's ground until the next deploy.

#### 10. Verified

`npm run build` clean (tsc --noEmit + vite). Three headless harnesses in the scratchpad, driving a
freshly compiled CommonJS mirror of the real `src/render` + `src/game` through a pixel-accurate
software canvas, plus a **second mirror built from a pre-C2 snapshot of the tree** for the A/B:

- **(a) sprite audit.** **1373 entries, 0 blanks (< 20 opaque px), 0 duplicate keys.** Thinnest entry
  is the 32px muzzle flash the Phase 6 note already calls out by design (joined by the last beam
  flare frame at 32px). Thinnest new *entity* art: rifleman hull **308 px**, MG-nest gun **240 px**,
  dark Laser Tower **328 px**; fattest: landship hull **1700 px**, airstrip **3456 px**. All 18 new
  icons carry **338-822 px of real ink** (pixels that are not the icon plate), in family with the
  shipped icons' 355-664.
- **(b) silicon regression.** The 20 silicon tile sprites hash **`4f783d93…`** under both the pre-C2
  and the C2 build, and the full composited terrain layer (2304x2304, seed 1337) hashes
  **`818a1467…`** under both — byte-identical. The other three palettes each hash differently
  (`a694d047…` / `0d4c4519…` / `a3829cdc…`), i.e. every era really is a different ground.
  `turret|guardTower|*` keys and shapes are unchanged.
- **(c) render smoke, 18/18 checks.** For **every era**: the era's whole roster (every unit type x
  both players, facings, a loaded harvester, a docked aircraft with ammo pips and a rearm bar) and
  every structure in the roster x both players x **ready / constructing / selling**, with a
  mixed selection, over 6 interpolated frames at 1280x800 **and** 4 more at 640x480 with fog on, the
  debug overlay on, and after a `resetFx()`. Alongside them, one live round of **every draw path**:
  machine-gun tracer, flak shell, plasma bolt, drone bolt, pulse shell, rail slug, AP shell, homing
  rocket, howitzer arc, bomb arc, and four beams (both weapons, fresh and fading), plus muzzle
  flashes and explosions at four size classes. **Nothing throws, 0 NaN draw arguments and 0
  negative-size rects** across all of it. The impact tracker is exercised by removing the tracked
  rounds mid-run: it emits exactly one flak puff and one bomb blast per era (`bomb,flak`), draws
  them, and ages them back to **0** on schedule.
- **(d) perf** (medians of 5, software canvas — a browser is roughly twice as quick; the load-bearing
  figure is the A/B against the pre-C2 build in the same harness):
  - boot `initSprites()` **0.67 ms** (pre-C2 **0.51 ms**) — it still eagerly builds one palette only.
  - force **every** sprite: **57.8 ms for 1373** against the pre-C2 **51.9 ms for 1176** — +11% time
    for +17% sprites, and that includes building all four terrain palettes.
  - `buildTerrain` (the full 2304x2304 composite): **22.6 ms** same-era, **22.1 ms** on an era change
    with the new palette built cold, **21.5 ms** warm. **An era change costs the same as the terrain
    rebuild that already happens on every restart** — the palette build itself is ~0.45 ms, noise
    against the composite.
- **(e) main.ts wiring, 8/8** asserted against the source: `applyEraPalette()` precedes
  `renderer.buildTerrain` at boot **and** in `restart()`, `resetFx` / `invalidateFog` /
  `sidebar.reset` are all called on restart, the palette comes from `ERAS[state.era].paletteKey`, and
  the helper is defined once and used exactly twice.
- **(f) no sim touched.** `diff -r src/game` against the pre-C2 snapshot is **empty**, and the only
  files modified in the phase are `src/main.ts`, `src/render/sprites.ts`, `src/render/renderer.ts`,
  `src/render/ui.ts` and `SPEC.md`.

#### 11. Known rough edges

- **The impact tracker infers detonation from disappearance.** A round that vanishes for any other
  reason (its target died mid-flight, so it fizzled) still puffs. For flak that is arguably correct —
  a shell that misses still bursts — and for a bomb it is a blast on empty ground, which is what a
  jettisoned bomb looks like anyway.
- **A round whose whole flight fits between two rendered frames is missed**, and only the sim's own
  explosion plays. Unreachable at any sane frame rate (a bomb falls for several ticks).
- **The title backdrop lags the selected era** (above).
- **Terrain palettes are cached forever once built.** Four sets of twenty 24px tiles is ~46 KB of
  canvas; nothing evicts them.
- **The trench crater and winter drift passes are per-tile and unaware of their neighbours**, so a
  crater never spans two tiles and a drift never runs across a boundary. At 4 variants per type it
  reads as texture rather than as repetition, but a future pass could seed the flourish off the tile
  index instead.
- **`Weapon.burst` is still unread** and the spider mech still fires one trigger for two rails, so
  its twin railgun draws **one** slug (the C1 note stands).

#### 12. What to eyeball in the browser

Pick an era with `__game.era('trench' | 'steel' | 'future')` and then deploy (or press R) — the era
only takes effect on the **next** mission, and the terrain rebuilds with it.

1. **1917 — THE GREAT TRENCH.** The ground should read as churned brown mud with **shell craters**
   pocking the grass and standing water in them. Build a couple of **Landships**: the rhomboid track
   frame with a sponson gun on each flank is the shot — nothing else in the game is that shape. Then
   a **Field Gun** (spoked wheels, crew shield) and an **MG Nest** (sandbag horseshoe, black
   embrasure, water-cooled gun on top). Check the riflemen's greatcoats and soup-plate helmets at a
   24px tile, and that the radar is brown to match.
2. **1943 — THE STEEL WINTER.** Frosted grey-green ground, near-white frozen flats, **snow lying on
   the rock**. Build an **Airstrip** and a **Dive Bomber**: watch for the *propeller* disc at the
   nose (not a helicopter rotor), the inverted gull wing, and — the specific thing to check — that a
   rearming bomber **parks square on the runway** with its four ammo pips and gold rearm bar. Then
   watch a bomb run: tumbling bombs on the arc and a heavy shockwave ring on impact. A **Flak Tower**
   should show an open railed deck with four barrels fanned up, and its bursts should be grey-white
   airburst puffs in the air rather than ground explosions. Look for the whitewash streaks on the
   medium and heavy tanks.
3. **1991 — THE CRYSTAL DAWN.** **Must look exactly as it always has.** Same desert ramp, same radar,
   same Guard Tower gun, same tanks. If anything here reads as changed, that is a bug.
4. **2077 — THE LAST DAWN.** Dark ground with teal/violet mineral glints and a **noticeably brighter
   crystal glow**. Build a **Laser Tower** and then deliberately go into power deficit (sell a power
   plant): the tower should go **dark** — crystal unlit, conduits out — and light again when power
   comes back. Fire a **Phase Lancer** (violet beam, heavy, with a flare at both ends) next to a
   Laser Tower (teal beam, thinner) and confirm they read as different weapons. Check the **hover
   tank** has no tracks and a segmented glow under its skirt rather than an outline, the **spider
   mech** stands high on four jointed legs, and the **swarm drone** is a lit diamond with **no
   rotor**.
5. **Crystal in every era.** Fly over a crystal field in all four: the shards must stay obviously
   green and obviously the economy, whatever the ground under them is doing.
6. **Both houses in each era.** Every new sprite should still carry olive/gold for you and
   slate/crimson for The Order — era changes the shape and the material, never the faction read.
7. **The sidebar.** Each era's build grid should be eighteen readable new schematics; the rifle squad
   icon should show three helmets, and the heavy tank should be visibly the bigger of the two 1943
   tanks.

### C3: chrono campaign

The third phase of the **CHRONO CAMPAIGN**, and the one the first two were for: C1 built four
playable eras, C2 gave them their art and their ground, and C3 is the campaign that sends you
through them. A **timeline map** instead of a continent, thirteen **moments** instead of thirteen
territories, and a finale — the **ORIGIN MOMENT** — where the gate has torn and The Order fields
tech from every era at once.

New files: `game/chrono.ts` (pure data + logic — no rendering, no `GameState`) and
`render/chrono.ts` (the timeline screen). Touched: `game/{state,skirmish,eras}.ts`,
`game/systems/{production,ai}.ts`, `render/{title,briefing,debrief}.ts`, `main.ts`.
**`game/campaign.ts` and `render/{campaign,theater}.ts` were not touched at all**, nor were
`rules.ts`, `map.ts`, `constants.ts`, `pathfinding.ts`, `systems/{victory,combat,movement,orders,
harvest,air,capture,fog}.ts`, `render/{sprites,renderer,ui,hud}.ts` or `audio/sfx.ts`. Two sim
files gained one line each and one gained one table; everything else in the phase is new code or
render-side.

---

#### 1. The thirteen moments

Three per era plus the anomaly. The player starts holding **PRESENT DAY** (1991, the shipped game)
and unlocks **backward and forward** from it: one arm runs out through 1944 to 1916, the other
through 2061 to 2077, and the two only meet at the ORIGIN MOMENT.

| # | moment | id | era | year | seed | rock+cliff | gate depth | opened by |
|---|---|---|---|---|---|---|---|---|
| 1 | THE SALIENT | `salient` | trench | 1916 | 2400 | 21.0% | 5 | lastpush |
| 2 | WIRE HARVEST | `wire` | trench | 1917 | 2022 | 19.5% | 5 | lastpush |
| 3 | THE LAST PUSH | `lastpush` | trench | 1918 | 2861 | 18.2% | 4 | steeltide **or** airfield |
| 4 | STEEL TIDE | `steeltide` | steel | 1942 | 2251 | 15.5% | 3 | winterline |
| 5 | THE AIRFIELD | `airfield` | steel | 1943 | 2428 | 14.2% | 3 | winterline |
| 6 | WINTER LINE | `winterline` | steel | 1944 | 2986 | 12.8% | 2 | desertshield |
| 7 | DESERT SHIELD | `desertshield` | silicon | 1990 | 2314 | 10.2% | 1 | present |
| 8 | **PRESENT DAY** (anchor) | `present` | silicon | 1991 | 2747 | 8.8% | 0 | — (held from the start) |
| 9 | THE GLASS HOUR | `glasshour` | silicon | 1993 | 2054 | 11.5% | 1 | present |
| 10 | NEON SPRAWL | `neonsprawl` | future | 2061 | 2372 | 16.8% | 2 | glasshour |
| 11 | THE BROKEN SKY | `brokensky` | future | 2069 | 2274 | 22.2% | 2 | glasshour |
| 12 | THE LAST DAWN | `lastdawn` | future | 2077 | 2956 | 23.5% | 3 | neonsprawl **or** brokensky |
| 13 | **THE ORIGIN MOMENT** | `origin` | future | YEAR ZERO | 2439 | 24.8% | 4 | lastdawn **+ 10 moments held** |

- **The unlock graph is directed** — a timeline has a direction of travel — and a moment opens once
  **any** of the moments leading to it is held. Mostly linear inside an era, with a branch where an
  era offers two ways on (`winterline -> {steeltide, airfield}`, `glasshour -> {neonsprawl,
  brokensky}`, `lastpush -> {salient, wire}`) and an **era gate** wherever the chain crosses a time
  period (`present -> desertshield` stays in 1991, then `desertshield -> winterline` crosses to
  1943, `airfield -> lastpush` to 1917, `glasshour -> neonsprawl` to 2077). **Gate depth is BFS from
  the anchor, computed at module load, never hand-authored**, and `assertTimeline()` throws at load
  on a self-requirement, a dangling id, an unreachable moment, a duplicate id / name / seed, more
  than one anchor or more than one anomaly, or an era that has the wrong number of moments.
- **12 battles, exactly like V3.** The anchor is held from the first frame and never fought (it is
  the map that draws the title backdrop and it keeps a validated seed for a future "defend your own
  time" mission, the same trade V3 made for HARROW LANDING).
- **The ORIGIN MOMENT needs `ORIGIN_REQUIREMENT = 10` moments held** *and* THE LAST DAWN taken. Ten
  of thirteen is the anchor plus nine won battles, so the anomaly is always the end of a campaign
  rather than a shortcut through the middle of one — but two ordinary moments may still be
  outstanding when it opens, which is what forces the scaling decision in §3.
- **The thirteen seeds were validated to exactly the V2/V3 curated bar**: both start areas
  **338/338** tiles clear *and* buildable, **6** crystal fields, a complete start-to-start A* path,
  and all 6 fields reachable. They were chosen from a 1000-seed scan (**1000 valid, 0 rejected**) by
  spreading across rock density and rejecting any pair agreeing on more than 70% of its tiles —
  **minimum pairwise terrain difference 37.4%**. None collides with a curated skirmish seed
  (355/187/84/245) or a V3 territory seed (1059…1273).
- **Rock cover rises with distance from 1991, in years**: **8.8% at PRESENT DAY to 24.8% at the
  ORIGIN MOMENT**, monotonically across all thirteen. The ground itself gets worse the further from
  your own time you travel, which is the same trick V3 played west-to-east.

#### 2. Rules

- **Win -> the moment is secured. Lose -> nothing changes at all** beyond the counters: the moment
  stays enemy, you keep everything you hold, and the same insertion can be retried immediately.
  **A secured moment is never lost** — the same documented V1 simplification the conquest campaign
  made, and the same reason: the campaign is a ratchet, not a grind.
- **Secure all thirteen -> TIMELINE SECURED.**
- Save: `localStorage['crystal-dawn.chrono']`, versioned (`version: 1`), **its own slot**. The
  guarantees are V3's, verbatim: **anything wrong with it is a fresh timeline**, never a throw and
  never a half-restored one (bad JSON, a foreign version, unknown moment ids, a missing anchor, a
  `"victory"` that does not hold all thirteen — the result is recomputed from `secured`, not
  trusted). `current` is deliberately dropped on load. A storage that throws on read *or* write is
  a session-only campaign.

#### 3. Scaling — the exact formula

`chronoBattleConfig(cs, momentId)` is a **pure function of (moments held, era distance)** returning
an *extended `SkirmishOptions`*, so `main.ts` hands it straight to `initSkirmish`. It reuses the V3
scaling family — the same knobs, the same `makeAiScaling`, literally the same `resistanceOf` ladder
imported from `game/campaign.ts` — with one substitution.

`conquered = securedCount - 1` (the anchor is free). **`distance` is era steps from the present**
(`silicon` 0, `steel` / `future` 1, `trench` 2), *not* gate depth.

| knob | formula | at the ORIGIN MOMENT |
|---|---|---|
| `rank` (difficulty) | `distance*4 + conquered`; `<=3` easy, `<=13` normal, else hard | **hard** (rank 23) |
| `aiCreditBonus` | `conquered * 400 + distance * 900` | **+7100 cr** |
| `aiScaling.waveSize` | `1 + conquered*0.04 + distance*0.09` | **x1.710** |
| `aiScaling.waveInterval` | `max(0.50, 1 - conquered*0.025 - distance*0.06)` | **x0.545** (shorter = more pressure) |
| `aiScaling.armyCap` | `1 + conquered*0.03 + distance*0.06` | **x1.510** |
| `aiPrebuilt` | fort level `distance + floor(conquered/3)`, capped at 5 | **7 structures** (its own set) |
| `threat` (UI only) | `min(1, distance/3*0.6 + conquered/11*0.4)` | **1.00 -> OVERWHELMING** |

- **Why era distance and not gate depth.** THE SALIENT is five gates from the anchor and THE LAST
  DAWN only three; scaling on depth would make 1916 the hardest ground in the game and 2077 an
  afterthought. The fiction is that the further you travel *in time*, the worse the gate holds, and
  distance says that directly. Depth is still computed (it proves reachability and it is what the
  insertion plate calls `GATE DEPTH`), it just does not drive a single number.
- **Every term is non-decreasing in both inputs.** Verified exhaustively over all 12 ordinary
  moments x 12 held-counts x 7 axes: **0 decreases** as the timeline is taken, **0** as the era gets
  further from the present.
- **The ORIGIN MOMENT is pinned to the maximum rather than read off the live campaign.** It is
  configured at `MAX_CONQUERED` (11) whatever the player actually holds, and it sits one era step
  beyond the furthest era (`distance` 3). That is what makes it *provably* the hardest battle the
  campaign can produce: its count gate lets it be entered with two moments outstanding, so reading
  the live count would have let a last-fought 1917 moment out-scale the finale on credits. The
  anomaly does not care how much of the timeline you hold — it fields everything, always. Verified:
  **0 configurations anywhere exceed it on any axis**, and its configuration does not move between
  10, 11, 12 and 13 moments held.
- **The first insertion is a plain easy skirmish**: neutral scaling (`aiTuning` returns the shared
  `AI_DIFFICULTY.easy` object by identity), **+0 cr**, no pre-built defences, `LIGHT`.
- **Pre-built defences are the era's own emplacement** — an MG Nest in 1917, a Flak Tower in 1943,
  a Guard Tower in 1991, a Laser Tower in 2077 — so a fortified moment looks like its own time
  before a shot is fired. Levels 0-1 are empty, 2-3 are `plant + n towers`, 4-5 are
  `2 plants + refinery + n towers`. **Two plants at the top**, because the count is sized for the
  most expensive emplacement in the game (2077's Laser Tower drains 40 each against 1917's 5) rather
  than per era: measured, **no configured moment opens in a power deficit, in any era**.
- **The anomaly's garrison is its own set** and is the first thing you see: two plants, a refinery
  and **one emplacement from every era standing side by side** (`lasertower`, `flaktower`,
  `guardTower`, `mgnest`) — seven structures, one more than any ordinary level can reach.

#### 4. The temporal anomaly, and the one sim change C3 needed

The ORIGIN MOMENT is fought on 2077's map with 2077's palette, and **the player stays era-locked to
`future`** (v1; documented). The Order does not.

- **`GameState.anomaly`** is one new additive field, set once by `initSkirmish` from the new
  `SkirmishOptions.aiAnomaly` and never written again — exactly how C1's `era` behaves, and for the
  same reason (it is half of the "which types exist" question and nothing may change it under a
  running battle).
- **One line in `production.canBuild`**: the C1 era gate becomes
  `if (!eraAllows(state.era, type) && !(state.anomaly && player !== PLAYER_HUMAN)) return false;`.
  Because `canBuild` is what `enqueue`, the sidebar's grey-out, the AI's `want()` and the AI's
  composition `add()` all ask, lifting it there reaches every one of them — **for The Order only**.
  The human's sidebar lists come from `buildableUnitsFor` / `buildableStructuresFor`, which filter on
  the era and were not touched, so a 2077 grid is what the player gets. Verified in a live anomaly
  battle: the human cannot build (or even queue) a landship, an MG nest or a rifleman, and its two
  sidebar lists are 2077's exactly.
- **One line in `ai.rollWantedUnit`**: the rows come from the new `ANOMALY_COMPOSITION` table in
  `eras.ts` instead of `eraDef(state.era).composition`. Same walk, same three tech phases, same
  `INFANTRY_SHARE` cut, same `minWave` gate on siege weapons — C1 made compositions *data*, so a
  mixed table needed no plumbing at all. Twelve rows spanning all four eras: rifleman / riflesquad /
  rocketSoldier / plasmatrooper as infantry, landship / mediumtank43 / mediumTank / hovertank as the
  line, heavytank / spidermech as the heavies, phaselancer / fieldgun as the siege pair.
- Measured in a real 20-minute anomaly battle: The Order fielded **rifleman, riflesquad,
  rocketSoldier, plasmatrooper, landship, mediumtank43, mediumTank, hovertank, heavytank,
  spidermech, phaselancer, fieldgun and swarmdrone — thirteen types across all four eras**.
- **`state.anomaly` is false in every other battle in the game**, so both lines short-circuit to the
  pre-C3 behaviour. Proved by A/B, not by inspection (§7a).

#### 5. The timeline screen

`render/chrono.ts`, same discipline as `title.ts` / `campaign.ts`: render-side only, never sees a
`GameState`, animates off its own frame counter (the sim is frozen while the phase is `'chrono'`),
and `chronoLayout` / `chronoBands` / `momentAt` / `nodeCenter` / `chronoLabels` / `insertionLines` /
`insertionLayout` / `gateState` / `gateTag` are **pure**, so the headless smoke asserts geometry
directly.

- **`AppPhase` is now `'title' | 'campaign' | 'chrono' | 'briefing' | 'playing'`** and `nextPhase`
  gained one branch: `title --chrono--> chrono --enter--> briefing --start--> playing`. The two
  campaign phases are **siblings and neither can reach the other**: the only way across is the
  title. `ChronoAction` is deliberately its own type rather than a shared "campaign action" — `enter`
  and `invade` are different verbs into different modes, and keeping them apart is what makes
  `nextPhase` exhaustive without a mode flag.
- **Not a continent — a timeline.** A wide (deliberately non-square) rect carrying the 0..100
  timeline space, divided into **four era bands** washed in that era's C2 ground colour
  (`trenchMud` brown-olive, `steelWinter` pale grey, `siliconDesert` sand, `futureNeon` dark teal)
  with headers `1917 - THE GREAT TRENCH`, `1943 - THE STEEL WINTER`, `1991 - THE CRYSTAL DAWN`,
  `2077 - THE LAST DAWN` (derived from `EraDef.label`, never re-typed). A spine runs down the middle
  with a tick under every gate; the void behind it is three flat tones, the composited terrain layer
  drifting **sideways** at 5% (time running past, rather than the conquest map's sea floor) and 96
  deterministic sparks.
- **Moments are chrono gates**: a portal ring with an aperture. **Secured** gates burn gold with a
  filled hub, **open** ones are crimson with a **pulsing** outer ring, **locked** ones sit dark, and
  the **sealed** anomaly is violet with a bar across it and four spokes so it is never mistaken for
  an ordinary moment. The anchor carries a solid PRESENT pip. Battle scars (one tick per attempt,
  capped at five) sit under any moment that has been fought for. It is the same state language the
  conquest map uses, in this map's own vocabulary.
- **Streams** are the unlock edges, drawn as gentle cubics that leave a gate horizontally (time is
  the x axis). A stream out of ground you hold is drawn **lit gold** — a route you can actually
  travel — and unlit otherwise. `assertTimelineArt()` runs at load exactly like `assertTheater()`
  and throws if the bands do not tile the timeline without gaps, if a gate is drawn outside its own
  era's band, or if a stream passes within 4 units of a gate it does not touch (so the map can never
  lie about what unlocks what).
- **Insertion plate**: `INSERT INTO <NAME>` / `<year> - <ERA>` / `GATE DEPTH n - <LEVEL> GARRISON` /
  `ESTIMATED RESISTANCE: <LABEL>` / `ORDER RESERVES: +n CR` / `DEFENCES ALREADY STANDING` /
  `THE ORDER FIELDS EVERY ERA AT ONCE` (anomaly only) / `PREVIOUS ATTEMPTS: n`, with LAUNCH INSERTION
  and CANCEL. Modal over the map, Enter/Space launch, Escape dismisses — V3's behaviour exactly.
  Its geometry is computed **on demand**, never cached from `draw`, so a click never depends on a
  frame having been rendered first (the V3 lesson, inherited rather than relearned).
- **Progress** is `MOMENTS n/13   BATTLES n   WON n   GATES n` under the header; **RESET TIMELINE is
  double-confirm** (first click arms it to `CONFIRM WIPE?` in red, any other click disarms);
  **T MENU** returns to the title.
- **Two draw caches**, the V3.1 split: `bands` (washes, spine, band headers, unlit streams) keyed on
  the map rect's size alone, and `overlay` (gate rings, lit streams, labels, scars) keyed on the size
  plus a signature of the campaign. Per frame that leaves the void, two `drawImage`s, the pulse and
  the hover ring.
- **Label rules.** `chronoLabels` is pure and the harness asserts on it directly. The **era band
  headers are reserved first**, so a name can never land on `1943 - THE STEEL WINTER`. One name
  scale for the whole map (it must fit the narrowest band, else the map drops to scale 1). The tag
  is a second line only when it fits. The reserved rect is the whole block, scars included. Blocks
  are placed in timeline order, first *below* a gate in the upper lane and *above* one in the lower
  lane (so labels always fall toward the middle of the rect), then the opposite side, then a
  deterministic ring search, then an exhaustive grid scan — every candidate clamped inside the map
  rect before it is tested, so a label can never leave the window. A block that ends up far from its
  gate gets a leader line. Measured: **585 placements across 9 window sizes x 5 campaign states,
  0 collisions, 0 off-window, 1 tag drop** (THE ORIGIN MOMENT at 480x900).
- **Title screen.** An `[X] CHRONO CAMPAIGN` plate in teal, stacked directly under the gold
  `[C] CONQUEST CAMPAIGN` one so the two read as one "campaigns" block, plus the `X` key. The
  skirmish block above them is **unchanged in order, geometry and behaviour** (asserted against the
  pre-C3 build's own `buttons()` output at nine sizes); only `menuTop`'s reserved block height grew,
  and `MENU_FOOT` (40 px of slack under the last plate) is what keeps the footer hint clear at
  640x480 — the binding case, where the block now ends 22 px above it.
- **Briefing.** `briefingLines(momentBriefing | null)` is new and pure. **`null` returns
  `BRIEFING_LINES` by object identity**, so a skirmish and a conquest battle get the shipped copy
  with nothing moved; a chrono moment gets `TEMPORAL INSERTION: THE AIRFIELD, 1943` as the headline,
  `CHRONO GATE - THE STEEL WINTER, 1943` under it, and the era's **own** `flavor.situation` and
  `flavor.directives` — the copy C1 wrote for exactly this. The anomaly adds an `ANOMALY` block
  saying the gate has torn and The Order is fielding all four eras. `BRIEFING_CHARS` is unchanged
  and still exported; the typewriter now measures against `briefing.total`, which is the *active*
  copy set.
- **Debriefing.** `DebriefInfo` gained one optional field, `chrono`, whose presence swaps the two
  foot prompts through the existing pure `debriefPrompts`. A skirmish and a conquest battle get
  byte-identical strings **and byte-identical geometry** (asserted against the pre-C3 build).
  - won: `MOMENT SECURED - CLICK TO CONTINUE` / `T - RETURN TO COMMAND`
  - lost: `INSERTION FAILED - CLICK TO WITHDRAW` / `R - RETRY THIS MOMENT   T - COMMAND`
  - the mission line reads `MOMENT THE AIRFIELD - SECTOR 097C   NORMAL   TIME 11:06`
- **Campaign complete** reuses the debriefing's furniture again — same panel, rule, two-column
  YOU/ORDER table and literally `debriefRows()` — under a green **TIMELINE SECURED**, with
  `13 MOMENTS   n BATTLES   TIME mm:ss`. `R` starts a new timeline, `T` returns to the title.

#### 6. Wiring, and how the three modes stay apart

`main.ts` holds a **parallel** set of variables to V3's rather than a shared abstraction:
`chronoStorage` / `chrono` / `chronoBattle` / `chronoResolved`, `ChronoScreen`, and
`startChronoBattle` / `retryChronoBattle` / `leaveChronoBattle` mirroring their conquest
counterparts one function at a time.

- **Mutual exclusion is enforced at the three entry points.** `setMission` (skirmish) clears both
  battle configs, `setCampaignMission` clears the chrono one, `setChronoMission` clears the campaign
  one — and each also clears the other campaign's `current`. `newGame()` therefore has exactly one
  live branch: `chronoBattle ? {...chronoBattle, difficulty} : campaignBattle ? {...campaignBattle,
  difficulty, era} : {difficulty, era}`. **A chrono battle carries its own era**, so the
  module-level `era` (what `__game.era()` selects for skirmishes) is deliberately not applied to it.
- **The result latch is per mode.** Two independent `if (xBattle && !xResolved && result !==
  'playing')` blocks run after `updateVictory`, and only one can ever fire in a given battle. That is
  what makes each campaign's save untouched by the other's battles — verified both directions by
  byte-comparing the save file across a full battle of the other mode.
- **Restart hygiene needed no new cache reset.** The timeline screen holds only its selection and
  reset-arm state, cleared by `chronoScreen.reset()` whenever the map is entered; `restart()` gained
  one line (`chronoResolved = false`) beside V3's.
- **`__game`** gained **`chrono()`** (secured / enterable / the origin gate's shortfall / counters +
  the live battle configuration for all thirteen moments), **`chronoInvade(id)`**, **`chronoWin()`**
  and **`chronoReset()`**, mirroring V3's four exactly. `phase()` accepts `'chrono'`.

#### 7. Verified

`npm run build` clean (tsc --noEmit + vite build). Seven headless harnesses in the scratchpad,
driving a **freshly compiled CommonJS mirror of the real sources** (game + engine + render +
`main.ts` itself, booted through a stub DOM and a stub `localStorage`, with a recording 2D context, a
driven rAF clock and a spy on `drawPixelText` so the *actual strings* reaching the screen can be
asserted), plus a **second mirror compiled from git HEAD** for the A/B: **4,854 / 4,854 checks**.

- **(a) chrono logic, 202 checks.** Graph: 13 moments, 3/3/3/4 per era, one anchor, one anomaly,
  unique ids / names / seeds, every requirement resolving, every moment reachable from the anchor,
  gate depths `0/1/1/2/2/3/3/3/4/4/5/5`, era distances `0/1/1/2` and the anomaly strictly beyond all
  of them. Rules: a fresh timeline holds only the anchor and fronts on `desertshield, glasshour`;
  taking DESERT SHIELD opens `glasshour, winterline`; an illegal move counts nothing; a **loss leaves
  `secured` byte-identical**, keeps the moment enterable and records the attempt; resolving twice is
  a no-op; wins and losses both fold ticks and both stat blocks into the totals. The origin gate is
  walked moment by moment: it **never** opens under ten held, it needs THE LAST DAWN as well, and it
  opens at **exactly** ten — including the case with two moments still outstanding, and the case
  where the graph condition is met early and the count holds it shut (`SEALED - 4 MORE`). A legal
  12-battle walk reaches **13/13 -> `victory`**. Persistence: full round-trip, `current` never
  restored, **12 corrupt/hostile inputs** all give a fresh timeline, a **false `"victory"` is
  corrected** and a real one recognised, unknown ids and duplicates dropped, reset removes the key,
  and a storage that **throws on get, set and remove** (and a null storage) never throws out.
- **(b) chrono seeds, 125 checks.** All 13: **338/338** start tiles clear + buildable on both sides,
  **6** crystal fields, a complete start-to-start A* path (1-6 waypoints), 6/6 fields reachable,
  154k-181k crystal. Every seed regenerates bit-identically; minimum pairwise terrain difference
  **37.4%**; rock density **8.8% -> 24.8%** rising monotonically with distance from 1991; PRESENT DAY
  is the most open ground and the ORIGIN MOMENT the most broken; **no collision with any V2 curated
  seed or any V3 territory seed**.
- **(c) scaling + anomaly, 163 checks.** Exhaustive monotonicity over 12 moments x 12 held-counts x
  7 axes: **0** eases with land, **0** with distance, **0** configurations exceeding the ORIGIN
  MOMENT, and the anomaly's own configuration identical at 10/11/12/13 held. First insertion =
  easy / +0 cr / `LIGHT` / neutral scaling **by object identity**. Pre-built placement on every
  configured moment's real map: every extra found a legal tile, **0** overlapping footprints, **0**
  off-map tiles, **0** power deficits, `buildingsBuilt` / `unitsProduced` still **0** at t=0, every
  extra `ready`, `state.era` and `state.anomaly` matching the moment every time. In a live anomaly
  battle: `state.anomaly` set, era `future`, The Order opening on `5000 + 4000 + 7100`, and over 20
  sim-minutes it fielded **13 unit types across all four eras**; meanwhile the human's two sidebar
  lists are 2077's exactly, `canBuild` refuses it every off-era type and `enqueue` leaves its queue
  empty. An ordinary moment keeps the gate: no cross-era building, era roster intact.
- **(d) the whole loop through the real `main.ts`, 161 checks.** `X` on the title opens the timeline
  (with both campaign plates drawn); the header, progress line, all four era band headers, every gate
  name, T MENU and RESET TIMELINE reach the screen. Clicking a locked gate, the sealed anomaly or a
  held moment **starts nothing**; clicking an open one opens the plate **without counting an
  attempt**; LAUNCH lands on the briefing, counts the attempt and **saves immediately** while the
  conquest save is never written. The briefing carries `TEMPORAL INSERTION: DESERT SHIELD, 1990`, the
  era sub-head, the era's situation copy and the era's directives; two clicks deploy onto **seed 2314
  at easy in `silicon` with the silicon palette applied**. `chronoWin()` + one tick resolves **on the
  deciding tick**, and **60 further ticks do not re-resolve**; the debrief reads `MOMENT SECURED` and
  the click returns to the timeline with the front grown. A loss leaves `secured` byte-identical,
  records the attempt, reads `INSERTION FAILED`, and **`R` retries the same moment in the same era**.
  Cross-mode: a conquest battle fought mid-chrono leaves the **chrono save byte-identical**, and a
  chrono battle fought mid-conquest leaves the **conquest save byte-identical**; a skirmish writes
  neither and still shows the shipped debrief prompt. The remaining nine moments are then taken
  through `chronoInvade`, each **in its own era on its own seed**, the anomaly opens at twelve held,
  its battle opens with **seven Order structures and one emplacement from each era standing**, and
  the finale fires: **13/13 secured, `victory`, 12 battles won**, `TIMELINE SECURED` drawing with the
  debriefing table. `chronoReset()` empties it and removes the key while leaving the continent alone,
  and three live window resizes redraw with **0 NaN and 0 negative-size rects** across the whole run.
- **(e) regressions, 242 checks.** Measured against the **pre-C1/C2/C3 sources compiled from git
  HEAD**, under the identical harness. Seed 1337 normal 20 sim-min: **full sim signature identical**
  (`sha1 2eef7c73c540`) at every 4000-tick mark and at the end, same wave clock
  (**04:00 / 06:54 / 09:46 / 13:01 / 16:54**), same **54,857 cr** inflow, same 36 units, same 2
  refineries; identical again for easy and hard at 10 minutes and for seeds **355 / 245 / 1273**.
  The C3 build replays its own seed bit-identically. The medium-vs-light-tank duel ends
  **125/400 hp in 310 ticks** under both builds. The whole V3 conquest logic set re-asserted
  verbatim: 52 directed / **26 undirected** edges, symmetry, no self-loops, tier distribution
  `1/2/3/3/3/1`, no edge skipping a tier, **the id/seed list asserted verbatim**, the fresh front, a
  loss changing nothing, resolve-twice being a no-op, first-invasion (easy/+600/LIGHT) and stronghold
  (hard/+7400/5 prebuilt/x1.68/x0.565/x1.49/OVERWHELMING) configs, and 8 corrupt inputs. All
  **nineteen** `nextPhase` branches including the four new ones and the two cross-mode rejections.
  The skirmish debriefing's prompts, mission line and **panel geometry at three sizes** are identical
  to the pre-C3 build, as are the V3 prompts; the skirmish briefing copy and `BRIEFING_CHARS` are
  identical; and silicon's two sidebar lists still equal the pre-C1 constants, in order.
- **(f) render smoke, 3,949 checks.** Nine window sizes (640x480 up to 2560x1440 plus a tall
  480x900) x five campaign states (fresh / mid-with-scars / origin-sealed / nearly-done / complete):
  **585 label placements, 0 collisions, 0 off-window, 0 landing on an era band header, every glyph in
  the 5x7 font**. **900 frames, 0 throws, 0 NaN, 0 negative-size rects**, with hover, an open plate
  and an armed reset exercised, and every gate name plus the header, progress line and both controls
  read back through the font spy. Hit testing: **every gate hit-tests back to itself at every size**,
  including a ring of samples inside each ring; no two gates overlap; points off the map hit nothing;
  the ring is never smaller than 6 px. The plate at all nine sizes: panel on screen, LAUNCH and CANCEL
  non-overlapping and inside the panel, the target named, resistance stated, and the anomaly's plate
  carrying both its warnings. Routing: an open gate selects, CANCEL dismisses, LAUNCH enters, a
  locked or held gate does nothing, RESET is double-confirm and an unrelated click disarms it, T MENU
  leaves. Title: **eleven buttons at every size with 0 overlaps**, all on screen and clear of the
  footer hint, each hit-testing back to itself, both campaign plates drawing their labels and
  returning the right action, a click outside still deploying — and the **skirmish buttons' sizes and
  order identical to the pre-C3 build** at all nine sizes.
- **(g) perf, 12 checks.** Timeline screen at 1920x1080: **0.034 ms/frame mean, 0.092 p95, 0.291
  worst** against the theater map's 0.043 / 0.070 / 0.203 in the same harness — in family, and inside
  the 16.7 ms budget with room to spare (0.061 with the insertion plate up; 0.029 at 640x480).
  `enterable()` + `chronoBattleConfig()` together cost **0.31 us**, a save round trip **2.5 us**, and
  `chronoLabels()` **1.7 us** (paid on a cache miss, not per frame). Battle perf unchanged: 20
  sim-min on seed 1337 normal runs at **0.0213-0.0233 ms/tick** on the C3 build against
  **0.0218-0.0232** on the pre-C3 one over five interleaved runs — inside run-to-run noise, which is
  what "two short-circuiting boolean reads" predicts. The heaviest chrono battle, the anomaly at
  maximum scaling, runs at **0.033 ms/tick mean, 0.049 p95**; `initSkirmish` with its seven pre-built
  extras costs **0.64 ms** against 0.37 ms plain.

#### 8. Deviations / decisions

- **Scaling reads era distance, not gate depth** (§3). Documented rather than fudged: depth is still
  computed, asserted and displayed, it just is not the difficulty term.
- **The ORIGIN MOMENT's configuration is pinned to the maximum** rather than read off the live
  campaign (§3). The alternative — letting it float with `securedCount` — is what would have let a
  late 1917 fight out-scale the finale, because the count gate lets the anomaly open with two moments
  outstanding.
- **The player is era-locked even in the anomaly.** Only The Order fields mixed tech in v1. Letting
  the human build four eras' worth of hardware is a different (and much bigger) balance question —
  the sidebar would need paging, and every era's counters would have to hold against every other
  era's units. Flagged for a later phase.
- **The anomaly's AI keeps 2077's build plan and 2077's aircraft.** `buildPlanFor(era)` and
  `eraAirUnit(era)` are untouched, so it builds Laser Towers and flies Swarm Drones; the mixed
  roster is the *army composition* plus whatever the pre-built set puts on the map. Widening the
  plan too would have meant a second era-aware code path in `ai.ts` for one battle.
- **A secured moment is never lost**, exactly like V3's territories. Losing an insertion costs an
  attempt and nothing else.
- **The anchor has a validated seed it will never play**, the same trade V3 made for HARROW LANDING.
- **`X` opens the chrono campaign**, not `T` (which already means "menu" on both campaign maps) and
  not `C` (the conquest campaign). It is arbitrary but unambiguous, and it is on the plate.
- **`ChronoAction` is a separate type from `CampaignAction`** (§5), and `game/chrono.ts` imports
  `resistanceOf` / `CampaignStorage` / `defaultCampaignStorage` from `game/campaign.ts` rather than
  copying them. Shared *functions*, separate *state* — which is the line that makes "each campaign's
  save is untouched by the other's battles" easy to prove.
- **The timeline map rect is not square** (`chronoLayout` returns `mapW` / `mapH` and separate `ux` /
  `uy`), unlike `campaignLayout`. A timeline is wide; forcing it square would have wasted half the
  window and squashed the era bands.
- **The two campaigns share the title's difficulty buttons and ignore them.** The moment's distance
  and the held count drive the AI level, exactly as the conquest tier does; `__game.ai(level)` still
  overrides mid-battle.

#### 9. Known rough edges

- **Neither campaign can be entered from the other** — the title is the only way across. That is by
  construction (§5) but it does mean two clicks to switch modes.
- **`chronoWin()` is a live debug hook in the shipped build**, exactly as `campaignWin()` is.
- **The chrono campaign has one save slot and no difficulty selection**, the same limitation V3 has.
- **A moment's map never changes.** Retrying a failed insertion replays the identical terrain — it is
  *that* ground, at *that* moment — but a map you find awkward stays awkward.
- **The title backdrop still lags the selected era** (the C2 note stands), so entering the timeline
  from a fresh boot shows 1991's ground behind the void whatever moment you are about to fight.
- **THE ORIGIN MOMENT drops its year tag at 480x900** — the one tag drop in 585 placements. The gate
  ring, the name and the sealed bar all still read.
- **The anomaly is the only mixed-roster battle in the game.** There is no skirmish switch for it;
  `__game.chronoInvade('origin')` (with the timeline far enough along) is the only way to see it.

#### 10. What to eyeball in the browser

1. **Title screen** — the teal `[X] CHRONO CAMPAIGN` plate under the gold `[C] CONQUEST CAMPAIGN`
   one. Check at **640x480** that both plates are on screen, that the footer hint is not crowded, and
   that the skirmish block above them (SELECT DIFFICULTY, SELECT SECTOR, CLICK TO DEPLOY, the sector
   tag) is exactly where it was. Deploy a normal skirmish and confirm nothing about it moved.
2. **The timeline, fresh** — press `X`. It should read as **time running left to right**: four era
   bands in their own ground colours with `1917 - THE GREAT TRENCH` … `2077 - THE LAST DAWN` along
   the top, a spine with a tick under every gate, and thirteen rings on it. PRESENT DAY should be
   gold with a solid core in the middle of the 1991 band; DESERT SHIELD and THE GLASS HOUR should
   **pulse** either side of it; everything else dark. THE ORIGIN MOMENT sits alone at the top right
   with four spokes and a bar across it, tagged `YEAR ZERO - 9 MORE`.
3. **An insertion plate** — click THE GLASS HOUR. Read `INSERT INTO THE GLASS HOUR`,
   `1993 - THE CRYSTAL DAWN`, `GATE DEPTH 1 - EASY GARRISON`, `ESTIMATED RESISTANCE: LIGHT`. Click
   LAUNCH INSERTION and confirm the briefing header says
   `TEMPORAL INSERTION: THE GLASS HOUR, 1993` with 1991's situation copy under it.
4. **An era-correct battle** — fastest is `__game.chronoInvade('airfield')` after taking WINTER LINE
   (or just `__game.chronoInvade('winterline')` then `__game.chronoWin()` and on). The battle must
   open on **snow** with a 1943 sidebar (Rifle Squad, AT Gun, two tanks, Airstrip, Flak Tower) and the
   briefing must have said `TEMPORAL INSERTION: THE AIRFIELD, 1943`. Then do 1917 and 2077 and check
   the ground, the radar and the roster change with them.
5. **Mid-campaign timeline** — take five or six. The gold should read as **two arms spreading out of
   1991 in opposite directions**, with the streams out of held gates lit and the pulse jumping to the
   new front. Lose one on purpose and check the `n TRIED` tag and the scar ticks under the name.
6. **The ORIGIN gate** — with nine or ten moments held, watch the anomaly go from `LOCKED` to
   `YEAR ZERO - n MORE` (violet, barred) to **open and pulsing** at ten. Its plate should read hard,
   `+7100 CR`, `OVERWHELMING`, `DEFENCES ALREADY STANDING` **and**
   `THE ORDER FIELDS EVERY ERA AT ONCE`. In the battle itself, look at The Order's base at t=0: an MG
   Nest, a Flak Tower, a Guard Tower and a Laser Tower standing **side by side**. Then wait for a wave
   and confirm it is landships next to spider mechs — and check your own sidebar is still 2077 only.
7. **TIMELINE SECURED** — fastest is `__game.chronoInvade(id)` + `__game.chronoWin()` repeatedly. The
   map should be replaced by the green finale panel with the cumulative YOU/ORDER table and the total
   campaign time.
8. **The two campaigns do not touch** — take a territory in the conquest campaign, then a moment in
   the chrono one, then reload the page and check both maps still show exactly what you left. Then
   `RESET TIMELINE` (twice) and confirm the continent is untouched.

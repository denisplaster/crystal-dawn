/**
 * GameState — the single source of truth for the simulation.
 *
 * Phase 1 defines the shapes; later phases fill in behaviour. Fields are
 * intentionally declared up-front (optional where a later phase owns them) so
 * that Phases 2-5 extend this file rather than renaming things.
 */

import { makeRng, type Rng } from '../engine/rng';
import {
  BASE_STORAGE,
  FACTION_NAMES,
  MAP_H,
  MAP_W,
  PLAYER_COLORS,
  PLAYER_HUMAN,
  START_CREDITS,
  tileCenter,
  type PlayerId,
} from './constants';
import { DEFAULT_ERA, type EraId } from './eras';
import { generateMap } from './map';
import {
  BUILDING_TYPES,
  UNIT_TYPES,
  type BuildingTypeId,
  type UnitTypeId,
  type WeaponId,
} from './rules';
// Type-only: erased at build time, so this does not create an import cycle.
import type { AiState } from './systems/ai';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

export interface TilePos {
  tx: number;
  ty: number;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

export interface CrystalField {
  /** Field centre, in tiles. */
  tx: number;
  ty: number;
  /** Flat tile indices belonging to this field. */
  tiles: number[];
  /** Owner hint: which start position this field sits next to (-1 = neutral). */
  nearStart: number;
}

export interface MapData {
  w: number;
  h: number;
  /** Terrain enum value per tile. */
  terrain: Uint8Array;
  /** Art variant index per tile (stable, seeded). */
  variant: Uint8Array;
  /** 1 = ground units may enter. Derived from terrain; buildings clear it later. */
  passable: Uint8Array;
  /** 1 = a structure may be placed here. */
  buildable: Uint8Array;
  /** Remaining credits worth of crystal per tile (0 on non-crystal tiles). */
  crystal: Uint16Array;
  /** Static blockers placed by structures (building id, 0 = none). Phase 3 fills. */
  occupied: Uint16Array;
  /** Start position per player. */
  startTiles: TilePos[];
  crystalFields: CrystalField[];
  /** Seed the terrain was generated from. */
  seed: number;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderKind =
  | 'stop'
  | 'move'
  | 'attack'
  | 'attackMove'
  | 'guard'
  | 'harvest'
  | 'deliver'
  | 'enter'
  | 'repair'
  | 'capture'
  | 'deploy';

export interface Order {
  kind: OrderKind;
  /** World-space destination, when the order has one. */
  target?: Vec2;
  /** Target tile, for tile-granular orders (harvest, capture, placement). */
  tile?: TilePos;
  /** Entity id being acted upon (attack/enter/repair/capture). */
  targetId?: number;
  /** Queued via shift-click. */
  queued?: boolean;
  /**
   * Phase 4: this `attack` order was auto-acquired (attack-move engagement),
   * not commanded. Auto attacks are leashed and are dropped when the target
   * escapes; commanded attacks pursue until the target dies.
   *
   * A `move` order that carries a `targetId` is a *pursuit* move: combat drives
   * it toward the target and converts it back into an `attack` order on
   * arrival.
   */
  auto?: boolean;
}

export type HarvestState = 'seeking' | 'harvesting' | 'returning' | 'unloading';

// ---------------------------------------------------------------------------
// Stances (post-release)
// ---------------------------------------------------------------------------

/**
 * Per-unit engagement stance. Human-facing only: the AI never sets one, and an
 * **absent** field means `'offensive'`, so every unit that existed before this
 * feature behaves exactly as it did.
 *
 *   offensive  today's behaviour — free-fire acquisition in weapon range, and a
 *              commanded attack pursues its victim across the map.
 *   defensive  return fire in range, but leash to a held position: the unit may
 *              lean out at most `DEFENSIVE_LEASH` to bring a target into range
 *              and walks back when there is nothing to shoot. An order (move,
 *              attack, attack-move) overrides the leash while it is active.
 *   explore    never acquires a target on its own. When damaged it runs ~10
 *              tiles directly away from whatever hit it. An explicit attack
 *              order still works — player intent wins.
 *
 * Harvesters ignore stance entirely; their self-preservation is hardwired (see
 * `systems/harvest.ts`).
 */
export type UnitStance = 'explore' | 'defensive' | 'offensive';

export const UNIT_STANCES: readonly UnitStance[] = ['explore', 'defensive', 'offensive'];

export function isUnitStance(value: string): value is UnitStance {
  return value === 'explore' || value === 'defensive' || value === 'offensive';
}

/** A unit's effective stance. An absent field is `'offensive'`. */
export function stanceOf(u: Unit): UnitStance {
  return u.stance ?? 'offensive';
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Unit {
  id: number;
  type: UnitTypeId;
  player: PlayerId;
  /** World-space centre (floats). */
  pos: Vec2;
  /** Radians; 0 = east, increases clockwise (screen space, +y down). */
  facing: number;
  hp: number;
  maxHp: number;

  // --- movement (Phase 2) ---
  /** Current velocity in world px per tick. */
  vel: Vec2;
  /** Remaining waypoints, in tiles. */
  path?: TilePos[];
  /** Index of the waypoint currently being steered toward. */
  pathIndex?: number;
  /** Final goal of the current path (may differ from order target after blocking). */
  goal?: TilePos;
  /** Tick at which the path should be recomputed (throttle). */
  repathAt?: number;
  order?: Order;
  orderQueue?: Order[];
  /** Consecutive ticks the unit tried to move but barely did (Phase 2). */
  blockedTicks?: number;

  // --- combat (Phase 4) ---
  targetId?: number;
  /** Ticks remaining before the weapon may fire again. */
  cooldown?: number;
  /** Turret facing, if the unit type has an independent turret. */
  turretFacing?: number;

  // --- stance (post-release) ---
  /**
   * Engagement stance. Absent = `'offensive'`, i.e. the pre-stance behaviour.
   * Set only by the human (Z / X / C, or `__game.stance`); harvesters never
   * carry one.
   */
  stance?: UnitStance;
  /**
   * Defensive anchor: the world point the unit leashes to. Set when the stance
   * is chosen and re-anchored whenever the unit settles after an order (any
   * externally issued order clears it; the next idle tick re-anchors it here).
   */
  holdPos?: Vec2;
  /**
   * Tick before which a fleeing unit will not re-plan its escape (explore
   * stance and harvester panic). Stops continuous fire repathing every tick.
   */
  fleeAt?: number;

  // --- air (V2) ---
  /**
   * Rounds left in the pod. Initialised from `UNIT_TYPES[type].ammo` for units
   * that carry a finite load (the gunship); absent means "unlimited", which is
   * every ground unit.
   */
  ammo?: number;
  /**
   * Helipad this aircraft is flying to / sitting on. It is a soft reservation:
   * a pad is "free" when no other living aircraft names it here.
   */
  padId?: number;
  /** True while the aircraft is parked on its pad rearming. */
  docked?: boolean;
  /** Tick the rearm completes. Only set while `docked`. */
  rearmAt?: number;
  /**
   * "No helipad available" has already been announced for this aircraft, so the
   * EVA line is posted once rather than every tick it sits at the perimeter.
   */
  airNoted?: boolean;

  // --- engineer capture (V2) ---
  /**
   * Enemy structure this engineer is walking in to capture. It is the *durable*
   * intent, deliberately kept off the order: the movement system may complete or
   * abandon the approach order (arrival, give-up), and the capture system has to
   * survive that. Every externally issued order clears it (`assignOrder`,
   * `issueAttackOrder`, `stopUnits`), so a player order always wins.
   */
  captureId?: number;

  // --- harvester (Phase 3) ---
  cargo?: number;
  harvestState?: HarvestState;
  /** Refinery this harvester is bonded to. */
  refineryId?: number;
  /** Crystal tile currently being worked (also the search anchor once spent). */
  harvestTile?: TilePos;
  /** Countdown used by the harvest system (gather cadence / retry backoff). */
  harvestTimer?: number;
  /**
   * Post-release self-preservation: sim tick until which this harvester refuses
   * to (re)acquire crystal. Armed when it is shot at, and when a player order
   * takes it off the cycle.
   */
  dangerHoldUntil?: number;
  /**
   * Tile the harvester was standing on when it was last attacked (or was last
   * pulled off the cycle). The next field it picks is preferred to be at least
   * `SAFE_FIELD_TILES` away from it.
   */
  dangerTile?: TilePos;

  // --- bookkeeping ---
  /** Set when killed; removed at end of tick. */
  dead?: boolean;
  spawnTick?: number;
  /** Veterancy / misc counters reserved for Phase 7. */
  kills?: number;
}

export type BuildStatus = 'constructing' | 'ready' | 'selling';

export interface ProductionItem {
  /** Unit or building type id being produced. */
  type: UnitTypeId | BuildingTypeId;
  /** Ticks of work already applied. */
  progress: number;
  /** Total ticks required (adjusted for low power). */
  total: number;
  /** Credits already spent (drip-charged). */
  spent: number;
  /** True once complete and awaiting placement (structures). */
  ready?: boolean;
}

export interface Building {
  id: number;
  type: BuildingTypeId;
  player: PlayerId;
  /** Top-left tile of the footprint. */
  tx: number;
  ty: number;
  /** Footprint size in tiles (cached from the type table). */
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  status: BuildStatus;
  /** 0..1 while `status === 'constructing'`. */
  buildProgress: number;
  /** False when the player's power is in deficit (Phase 3). */
  powered: boolean;

  // --- production (Phase 3) ---
  queue?: ProductionItem[];
  rally?: Vec2;

  // --- defensive structures (Phase 4) ---
  targetId?: number;
  cooldown?: number;
  turretFacing?: number;

  /**
   * Phase 7: tick this structure finishes dismantling itself and dies. Set
   * together with `status = 'selling'`; the renderer reads it for the shrink
   * animation and `updateSelling` kills the building when the clock runs out.
   */
  sellAt?: number;

  dead?: boolean;
  spawnTick?: number;
}

export type ProjectileKind = 'bullet' | 'shell' | 'rocket' | 'arc' | 'beam';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  player: PlayerId;
  pos: Vec2;
  /** Previous tick position, for render interpolation / tracer length. */
  prev: Vec2;
  vel: Vec2;
  /** World-space impact point (for unguided shots). */
  target: Vec2;
  /** Homing target entity id. */
  targetId?: number;
  damage: number;
  /** Warhead id from rules.WARHEADS. */
  warhead: string;
  /** Splash radius in world px (0 = single target). */
  splash: number;
  /** Ticks before the projectile expires. */
  life: number;
  /** Firing entity, for kill credit. */
  sourceId?: number;
  /**
   * V2: the weapon that fired this round. The sim reads it back for the
   * air-targeting rules (`targetsAir` / `vsAirScale`), so — unlike `Effect.weapon`,
   * which is render-only — this one *is* gameplay state. Absent on rounds
   * spawned by test helpers, which then behave as ground-only.
   */
  weapon?: WeaponId;
  /**
   * C1: this round has already dealt its damage and is only still in the array
   * so the renderer can draw it (a `beam` hits on the tick it is fired). A spent
   * round never moves, never re-aims and never damages anything again — it just
   * ages `life` out. Absent on every travelling projectile.
   */
  spent?: boolean;
  /** Height above ground for arcing shots (render only). */
  arc?: number;
  /** Total flight distance in px, captured at launch (arc rendering). */
  travel?: number;
  dead?: boolean;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface BuildQueue {
  items: ProductionItem[];
  /** Type held ready and awaiting placement (structures only). */
  pendingPlacement?: BuildingTypeId;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: string;
  isAI: boolean;
  credits: number;
  /** Max credits that can be banked (ConYard + silos). */
  storage: number;
  /** Total power output of this player's plants. */
  powerProduced: number;
  /** Total power consumed by this player's structures. */
  powerDrain: number;
  /** Comm Center built and powered. */
  radar: boolean;
  /** Drain exceeds output. Halves build speed and kills radar (Phase 3). */
  lowPower: boolean;
  /** Separate queues per sidebar tab. */
  queues: {
    structures: BuildQueue;
    units: BuildQueue;
  };
  /** Defeated (all production structures lost). */
  defeated: boolean;
}

// ---------------------------------------------------------------------------
// Fog / messages / result
// ---------------------------------------------------------------------------

export interface FogState {
  /** 1 = ever seen by the human player. */
  explored: Uint8Array;
  /** 1 = currently within sight of a human unit/structure. */
  visible: Uint8Array;
  /** Master switch — Phase 4 turns it on; `reveal()` turns it off. */
  enabled: boolean;
  /**
   * Bumped by the fog system whenever a tile changed state. The renderer caches
   * an offscreen fog layer and only rebuilds it when this number moves.
   */
  version: number;
}

// ---------------------------------------------------------------------------
// Visual effects (Phase 4)
// ---------------------------------------------------------------------------

export type EffectKind = 'muzzle' | 'explosion';

/**
 * A short-lived decoration spawned by the sim (weapon fire, impacts, deaths)
 * and drawn by the renderer. It carries no gameplay meaning, but it is created
 * inside `tick()` from seeded RNG so replays stay identical.
 */
export interface Effect {
  kind: EffectKind;
  x: number;
  y: number;
  /** Radius in world px. */
  size: number;
  /** Tick the effect was spawned. */
  startTick: number;
  /** Lifetime in ticks. */
  life: number;
  /** Direction, for muzzle flashes. */
  facing?: number;
  /**
   * Weapon that produced a muzzle flash (Phase 6). Render-only: the audio
   * consumer picks the firing sound from it. The sim never reads it back.
   */
  weapon?: WeaponId;
}

export interface EvaMessage {
  text: string;
  /** Tick the message was posted. */
  tick: number;
  kind: 'info' | 'warning' | 'alert';
}

export type GameResult = 'playing' | 'won' | 'lost';

// ---------------------------------------------------------------------------
// Match statistics (post-release: debriefing)
// ---------------------------------------------------------------------------

/**
 * Per-player counters for the post-match debriefing screen.
 *
 * Every field is incremented **at the source of truth inside `tick()`** — the
 * system that actually performs the action — so the numbers are as deterministic
 * as the sim itself and cost one `++` each (no scans, no per-tick sampling).
 * Mission length is not tracked here: it is `state.tick`.
 *
 * The exact rules (documented in SPEC "Post-release: match debriefing"):
 *
 *   unitsProduced      a unit rolled out of a production building, including
 *                      the free harvester a Refinery brings. The two starting
 *                      units from `initSkirmish` are *not* counted — they were
 *                      issued, not produced — and neither is `__game.spawn`.
 *   unitsLost          a unit of this player died a real death. A *quiet* death
 *                      (an engineer consumed by a capture) is not a loss.
 *   unitsKilled        this player destroyed an enemy unit. Credit needs an
 *                      attributable source of a *different* player: a
 *                      friendly-fire death (own artillery splash) is the
 *                      victim's loss and nobody's kill, and a death with no
 *                      source at all (a debug hit, splash from a shot with no
 *                      firer) is a loss for the victim and unattributed.
 *   buildingsBuilt     a structure this player placed on the map. The starting
 *                      ConYard is not counted (same rule as starting units).
 *   buildingsLost      a structure of this player was *destroyed*. Selling and
 *                      losing it to a capture are not losses (they have their
 *                      own counters).
 *   buildingsRazed     this player destroyed an enemy structure. Same
 *                      attribution rule as `unitsKilled`.
 *   buildingsCaptured  this player took an enemy structure with an engineer.
 *   buildingsSold      this player dismantled one of their own structures.
 *   creditsHarvested   credits a refinery actually *banked* for this player,
 *                      i.e. what they received — overflow lost to a full silo
 *                      bank is not counted.
 *   creditsSpent       credits drip-charged by production. Nothing else spends
 *                      money in this game, and refunds are not subtracted.
 */
export interface PlayerStats {
  unitsProduced: number;
  unitsLost: number;
  unitsKilled: number;
  buildingsBuilt: number;
  buildingsLost: number;
  buildingsRazed: number;
  buildingsCaptured: number;
  buildingsSold: number;
  creditsHarvested: number;
  creditsSpent: number;
}

export function createPlayerStats(): PlayerStats {
  return {
    unitsProduced: 0,
    unitsLost: 0,
    unitsKilled: 0,
    buildingsBuilt: 0,
    buildingsLost: 0,
    buildingsRazed: 0,
    buildingsCaptured: 0,
    buildingsSold: 0,
    creditsHarvested: 0,
    creditsSpent: 0,
  };
}

// ---------------------------------------------------------------------------
// UI intent (armed cursor modes)
// ---------------------------------------------------------------------------

/** Cursor modes that make the next left click mean something other than "select". */
export type PendingOrderMode = 'attackMove';

/** Structure placement mode: a ghost footprint follows the cursor (Phase 3). */
export interface PlacementState {
  type: BuildingTypeId;
  /** Top-left tile of the ghost footprint. */
  tx: number;
  ty: number;
  /** Recomputed each tick; the renderer tints the ghost green/red from it. */
  valid: boolean;
}

export interface UiState {
  /** Armed by 'A'; the next left click issues this order kind. */
  pendingOrder: PendingOrderMode | null;
  /** Last control-group recall (Phase 6 uses it for double-tap camera snap). */
  lastGroupRecall: { group: number; tick: number } | null;
  /** Active structure placement, or null (human player only). */
  placement: PlacementState | null;
  /** Sidebar tab the human is looking at. */
  buildTab: 'structures' | 'units';
}

// ---------------------------------------------------------------------------
// GameState
// ---------------------------------------------------------------------------

export interface GameState {
  tick: number;
  /** Monotonic entity id counter. Never reused. */
  nextId: number;
  map: MapData;
  units: Unit[];
  buildings: Building[];
  projectiles: Projectile[];
  /** Render-only decorations (muzzle flashes, explosions). Phase 4. */
  effects: Effect[];
  players: [PlayerState, PlayerState];
  /** Entity ids selected by the human player. */
  selection: number[];
  /** Ctrl+1..9 control groups (index 0 = group 1). */
  controlGroups: number[][];
  /** Transient UI intent driven by input (Phase 2+). */
  ui: UiState;
  fog: FogState;
  result: GameResult;
  /**
   * Post-release: per-player match counters for the debriefing screen. Written
   * only by the systems that own each event, inside `tick()`; the debrief screen
   * reads them and never writes. Reset naturally by `createGameState`.
   */
  stats: [PlayerStats, PlayerStats];
  /** Seeded RNG owned by the sim. */
  rng: Rng;
  /** EVA ticker backlog (Phase 6 renders it). */
  messages: EvaMessage[];
  /**
   * Flat tile indices whose terrain art changed this tick (crystal depletion,
   * new footprints). The render side drains this queue — the sim never touches
   * the renderer.
   */
  dirtyTiles: number[];
  /**
   * Enemy-AI bookkeeping (Phase 5). Created by `initSkirmish`; absent until
   * then, which makes `updateAi` a no-op on a bare state.
   */
  ai?: AiState;
  /**
   * C1 (chrono campaign): the era this battle is fought in. Additive and always
   * present — `createGameState` opens on `DEFAULT_ERA` ('silicon', the shipped
   * roster), and `initSkirmish` overwrites it from `SkirmishOptions.era`.
   *
   * It is read by `production.canBuild` (availability gating on top of the
   * existing prereq system), by `ai.ts` (build plan + composition) and by the
   * render side (palette, sidebar list). Nothing writes it after setup.
   */
  era: EraId;
  /**
   * C3 (chrono campaign): **the ORIGIN MOMENT's temporal anomaly.** False in
   * every skirmish, every conquest battle and twelve of the thirteen chrono
   * moments; `initSkirmish` sets it from `SkirmishOptions.aiAnomaly`.
   *
   * It lifts the era roster gate **for The Order only** — `canBuild` stops
   * asking `eraAllows` for player 1, and the AI rolls its army from a mixed
   * composition table (`ANOMALY_COMPOSITION` in `eras.ts`) instead of the era's
   * own. The human stays era-locked: the sidebar's build lists are filtered by
   * `eraHasUnit` / `eraHasBuilding`, which this does not touch.
   */
  anomaly: boolean;
  /** Seed this game was created with. */
  seed: number;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function createPlayer(id: PlayerId): PlayerState {
  return {
    id,
    name: FACTION_NAMES[id] as string,
    color: PLAYER_COLORS[id] as string,
    isAI: id !== PLAYER_HUMAN,
    credits: START_CREDITS,
    storage: BASE_STORAGE,
    powerProduced: 0,
    powerDrain: 0,
    radar: false,
    lowPower: false,
    queues: {
      structures: { items: [] },
      units: { items: [] },
    },
    defeated: false,
  };
}

export function createGameState(seed: number): GameState {
  const gameRng = makeRng(seed);
  const map = generateMap(seed);
  const cells = MAP_W * MAP_H;

  return {
    tick: 0,
    nextId: 1,
    map,
    units: [],
    buildings: [],
    projectiles: [],
    effects: [],
    players: [createPlayer(0), createPlayer(1)],
    selection: [],
    controlGroups: Array.from({ length: 9 }, () => [] as number[]),
    ui: {
      pendingOrder: null,
      lastGroupRecall: null,
      placement: null,
      buildTab: 'structures',
    },
    fog: {
      explored: new Uint8Array(cells),
      visible: new Uint8Array(cells),
      enabled: false,
      version: 0,
    },
    result: 'playing',
    stats: [createPlayerStats(), createPlayerStats()],
    rng: gameRng,
    messages: [],
    dirtyTiles: [],
    era: DEFAULT_ERA,
    anomaly: false,
    seed,
  };
}

/** Allocate the next stable entity id. */
export function nextEntityId(state: GameState): number {
  return state.nextId++;
}

// ---------------------------------------------------------------------------
// Entity construction helpers
// ---------------------------------------------------------------------------

/** Create a unit at a tile centre and append it to the state. */
export function createUnit(
  state: GameState,
  type: UnitTypeId,
  tx: number,
  ty: number,
  player: PlayerId,
): Unit {
  const def = UNIT_TYPES[type];
  const unit: Unit = {
    id: nextEntityId(state),
    type,
    player,
    pos: { x: tileCenter(tx), y: tileCenter(ty) },
    facing: player === PLAYER_HUMAN ? 0 : Math.PI,
    hp: def.hp,
    maxHp: def.hp,
    vel: { x: 0, y: 0 },
    cooldown: 0,
    spawnTick: state.tick,
  };
  if (def.turret) unit.turretFacing = unit.facing;
  // Aircraft roll off the pad with a full pod.
  if (def.ammo > 0) unit.ammo = def.ammo;
  if (def.kind === 'harvester') {
    unit.cargo = 0;
    unit.harvestState = 'seeking';
  }
  state.units.push(unit);
  return unit;
}

/** Create a building with its top-left corner at (tx, ty) and append it. */
export function createBuilding(
  state: GameState,
  type: BuildingTypeId,
  tx: number,
  ty: number,
  player: PlayerId,
): Building {
  const def = BUILDING_TYPES[type];
  const building: Building = {
    id: nextEntityId(state),
    type,
    player,
    tx,
    ty,
    w: def.w,
    h: def.h,
    hp: def.hp,
    maxHp: def.hp,
    status: 'ready',
    buildProgress: 1,
    powered: true,
    spawnTick: state.tick,
  };
  if (def.produces) building.queue = [];
  if (def.weapon) building.cooldown = 0;
  state.buildings.push(building);
  setFootprintOccupied(state, building, true);
  return building;
}

/**
 * Queue a tile for a terrain-art redraw. The sim calls this; `main.ts` drains
 * `state.dirtyTiles` into the renderer after the systems have run, so no
 * simulation code ever holds a renderer reference.
 */
export function markMapTileDirty(state: GameState, tx: number, ty: number): void {
  if (tx < 0 || ty < 0 || tx >= state.map.w || ty >= state.map.h) return;
  state.dirtyTiles.push(ty * state.map.w + tx);
}

export function markMapRectDirty(
  state: GameState,
  tx: number,
  ty: number,
  w: number,
  h: number,
): void {
  for (let y = ty; y < ty + h; y++) {
    for (let x = tx; x < tx + w; x++) markMapTileDirty(state, x, y);
  }
}

/** Mark (or clear) the map tiles a structure blocks. */
export function setFootprintOccupied(
  state: GameState,
  building: Building,
  occupied: boolean,
): void {
  const map = state.map;
  for (let y = building.ty; y < building.ty + building.h; y++) {
    for (let x = building.tx; x < building.tx + building.w; x++) {
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
      map.occupied[y * map.w + x] = occupied ? building.id : 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Lookups (O(n) scans; Phase 2+ may add per-tick id maps if profiling demands)
// ---------------------------------------------------------------------------

export function findUnit(state: GameState, id: number): Unit | undefined {
  return state.units.find((u) => u.id === id);
}

export function findBuilding(state: GameState, id: number): Building | undefined {
  return state.buildings.find((b) => b.id === id);
}

export function findEntity(state: GameState, id: number): Unit | Building | undefined {
  return findUnit(state, id) ?? findBuilding(state, id);
}

/** Post an EVA ticker message (deduped against the immediately previous one). */
export function postMessage(
  state: GameState,
  text: string,
  kind: EvaMessage['kind'] = 'info',
): void {
  const last = state.messages[state.messages.length - 1];
  if (last && last.text === text && state.tick - last.tick < 40) return;
  state.messages.push({ text, tick: state.tick, kind });
  if (state.messages.length > 64) state.messages.shift();
}

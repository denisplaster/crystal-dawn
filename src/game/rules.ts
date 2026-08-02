/**
 * Balance data tables. Phase 1 only reads a little of this (hp, footprints),
 * but the full roster is defined now so later phases add behaviour, not data.
 *
 * Units: costs/roster per SPEC.md "Balance data". Phase 7 tunes the numbers.
 */

import { secondsToTicks } from './constants';

// ---------------------------------------------------------------------------
// Armor / warheads
// ---------------------------------------------------------------------------

export type ArmorClass = 'none' | 'light' | 'heavy' | 'structure';

export type WarheadId =
  | 'smallArms'
  | 'he'
  | 'ap'
  | 'rocket'
  | 'cannon'
  | 'apAuto'
  // C1 (chrono campaign) — era-exclusive warheads. Nothing above this line
  // moved; these are additions only.
  | 'frag'
  | 'heavyShell'
  | 'apHigh'
  | 'bomb'
  | 'flak'
  | 'plasma'
  | 'railSlug'
  | 'beam'
  | 'laser';

export interface Warhead {
  id: WarheadId;
  name: string;
  /** Damage multiplier per target armor class. */
  vs: Record<ArmorClass, number>;
  /** Splash radius in world px (0 = single target). */
  splash: number;
}

export const WARHEADS: Record<WarheadId, Warhead> = {
  smallArms: {
    id: 'smallArms',
    name: 'Small Arms',
    vs: { none: 1.0, light: 0.5, heavy: 0.2, structure: 0.25 },
    splash: 0,
  },
  he: {
    id: 'he',
    name: 'High Explosive',
    vs: { none: 0.9, light: 0.75, heavy: 0.5, structure: 0.7 },
    // Phase 7: 30 -> 50 px. A 30px burst only covered the tile it landed on, so
    // artillery was a single-target weapon with a slow shell; 50px reaches the
    // corners of a packed 3x3 squad (33.9px away) at ~32% falloff. Friendly
    // fire is deliberately kept.
    splash: 50,
  },
  ap: {
    id: 'ap',
    name: 'Armor Piercing',
    vs: { none: 0.4, light: 0.9, heavy: 1.0, structure: 0.6 },
    splash: 0,
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket',
    vs: { none: 0.5, light: 1.0, heavy: 1.0, structure: 0.9 },
    splash: 20,
  },
  cannon: {
    id: 'cannon',
    name: 'Cannon',
    vs: { none: 0.6, light: 0.9, heavy: 0.85, structure: 0.8 },
    splash: 12,
  },
  /**
   * Phase 7: the Guard Tower's round. `smallArms` (0.2x vs heavy) made a 500cr
   * tower irrelevant to armour; plain `ap` (0.4x vs none) would have made it
   * irrelevant to the infantry it is actually good at. This sits between them:
   * still an anti-infantry gun, but a light tank can no longer park in front of
   * one for free.
   */
  apAuto: {
    id: 'apAuto',
    name: 'AP Autocannon',
    vs: { none: 0.9, light: 1.0, heavy: 0.6, structure: 0.4 },
    splash: 0,
  },

  // --- C1: 1917 -----------------------------------------------------------
  /** Stormtrooper grenade: an anti-infantry burst that bounces off armour. */
  frag: {
    id: 'frag',
    name: 'Fragmentation',
    vs: { none: 1.0, light: 0.6, heavy: 0.35, structure: 0.5 },
    splash: 34,
  },
  /**
   * Field-gun shell. Deliberately flatter than `he` (0.5x vs heavy): the 1917
   * era has one vehicle and no rocket, so its towed gun has to be the answer to
   * armour rather than only to infantry.
   */
  heavyShell: {
    id: 'heavyShell',
    name: 'Heavy Shell',
    vs: { none: 0.85, light: 0.8, heavy: 0.7, structure: 0.75 },
    splash: 40,
  },

  // --- C1: 1943 -----------------------------------------------------------
  /** Towed AT round: the sharpest anti-armour multiplier in the game, and useless against men. */
  apHigh: {
    id: 'apHigh',
    name: 'AP Shot',
    vs: { none: 0.25, light: 1.0, heavy: 1.15, structure: 0.5 },
    splash: 0,
  },
  /** Dive-bomber payload: a wide burst that is at its best against buildings. */
  bomb: {
    id: 'bomb',
    name: 'Bomb',
    vs: { none: 0.75, light: 0.9, heavy: 0.8, structure: 0.75 },
    splash: 50,
  },
  /** Flak: shreds aircraft and infantry, barely scratches a tank. */
  flak: {
    id: 'flak',
    name: 'Flak',
    vs: { none: 0.85, light: 0.9, heavy: 0.35, structure: 0.3 },
    splash: 10,
  },

  // --- C1: 2077 -----------------------------------------------------------
  /** Plasma: energy weapons care very little what the target is made of. */
  plasma: {
    id: 'plasma',
    name: 'Plasma',
    vs: { none: 0.8, light: 1.0, heavy: 0.95, structure: 0.55 },
    splash: 8,
  },
  /** Rail slug: a solid shot that over-penetrates soft targets. */
  railSlug: {
    id: 'railSlug',
    name: 'Rail Slug',
    vs: { none: 0.5, light: 0.95, heavy: 1.05, structure: 0.85 },
    splash: 0,
  },
  /** Phase lance: the era's siege damage, and the only >1x multiplier vs heavy after `apHigh`. */
  beam: {
    id: 'beam',
    name: 'Phase Beam',
    vs: { none: 0.5, light: 1.0, heavy: 1.1, structure: 0.8 },
    splash: 0,
  },
  /** Laser emplacement: strong all-round, which is what the era's tower is sold on. */
  laser: {
    id: 'laser',
    name: 'Laser',
    vs: { none: 0.9, light: 1.0, heavy: 0.8, structure: 0.5 },
    splash: 0,
  },
};

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export type WeaponId =
  | 'machinegun'
  | 'rocketLauncher'
  | 'lightCannon'
  | 'mediumCannon'
  | 'howitzer'
  | 'towerGun'
  | 'gunshipRockets'
  // C1 (chrono campaign) — era-exclusive weapons. Nothing above this line moved.
  | 'boltRifle'
  | 'grenade'
  | 'sixPounder'
  | 'fieldHowitzer'
  | 'nestMg'
  | 'squadRifles'
  | 'atRound'
  | 'tankGun75'
  | 'tankGun88'
  | 'bombRun'
  | 'flakBurst'
  | 'plasmaBolt'
  | 'pulseCannon'
  | 'twinRailgun'
  | 'droneBolt'
  | 'beamLance'
  | 'towerLaser';

export interface Weapon {
  id: WeaponId;
  name: string;
  damage: number;
  warhead: WarheadId;
  /** Max range in tiles. */
  range: number;
  /** Minimum range in tiles (artillery). */
  minRange: number;
  /** Ticks between shots. */
  cooldown: number;
  /** Shots fired per trigger pull. */
  burst: number;
  /**
   * Projectile visual/behaviour class.
   *
   * C1 adds `beam`: a zero-travel-time hit. The damage lands on the tick the
   * shot is fired (there is nothing in flight to intercept or out-run) and the
   * round then lingers for a few ticks purely so the renderer has a line to
   * draw. See `spawnProjectile` / `BEAM_LIFE` in `systems/combat.ts`.
   */
  projectile: 'bullet' | 'shell' | 'rocket' | 'arc' | 'beam';
  /** Projectile speed in world px per tick (Infinity = hitscan tracer). */
  speed: number;
  /** Spread in world px applied to the aim point. */
  inaccuracy: number;
  /** Rockets track their target. */
  homing: boolean;
  /**
   * V2 (air units): can this weapon engage a unit whose type is `isAir`? A
   * weapon that cannot is invisible to air in *both* directions — it never
   * acquires one, a commanded attack on one is refused, and its projectiles
   * (including splash) pass straight through.
   */
  targetsAir: boolean;
  /**
   * Damage multiplier applied when the victim is an air unit. 1 = no penalty.
   * Only meaningful when `targetsAir` is true.
   */
  vsAirScale: number;
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  machinegun: {
    id: 'machinegun',
    name: 'Machine Gun',
    damage: 8,
    warhead: 'smallArms',
    range: 4.5,
    minRange: 0,
    cooldown: 10,
    burst: 1,
    projectile: 'bullet',
    speed: 24,
    inaccuracy: 3,
    homing: false,
    targetsAir: true,
    vsAirScale: 0.5,
  },
  rocketLauncher: {
    id: 'rocketLauncher',
    name: 'Rocket Launcher',
    damage: 30,
    warhead: 'rocket',
    range: 6,
    minRange: 0,
    cooldown: 40,
    burst: 1,
    projectile: 'rocket',
    speed: 9,
    inaccuracy: 2,
    homing: true,
    targetsAir: true,
    vsAirScale: 1,
  },
  lightCannon: {
    id: 'lightCannon',
    name: '75mm Cannon',
    damage: 25,
    warhead: 'ap',
    range: 5.5,
    minRange: 0,
    cooldown: 30,
    burst: 1,
    projectile: 'shell',
    speed: 16,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  mediumCannon: {
    id: 'mediumCannon',
    name: '105mm Cannon',
    damage: 40,
    warhead: 'cannon',
    range: 6,
    minRange: 0,
    cooldown: 38,
    burst: 1,
    projectile: 'shell',
    speed: 16,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  howitzer: {
    id: 'howitzer',
    name: '155mm Howitzer',
    damage: 60,
    warhead: 'he',
    range: 10,
    minRange: 2.5,
    cooldown: 70,
    burst: 1,
    projectile: 'arc',
    speed: 8,
    inaccuracy: 12,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  towerGun: {
    id: 'towerGun',
    name: 'Tower Gun',
    // Phase 7: 12 smallArms @ range 6 -> 22 apAuto @ range 7.5, cooldown 12->14.
    // Anti-infantry output is close to unchanged (12 -> 19.8 per shot but a
    // slower cadence); the real change is 2.4 -> 13.2 damage per shot vs heavy
    // armour, plus 1.5 tiles of standoff so the tower shoots first.
    damage: 22,
    warhead: 'apAuto',
    range: 7.5,
    minRange: 0,
    cooldown: 14,
    burst: 1,
    projectile: 'bullet',
    speed: 24,
    inaccuracy: 2,
    homing: false,
    targetsAir: true,
    vsAirScale: 1,
  },
  /**
   * V2: the Orca-style gunship's rocket pod. Six rockets per sortie, fired in a
   * fast salvo (12-tick cadence -> 3.6s to empty), then the aircraft has to go
   * home and rearm. Damage is set so a full pod is a **light tank kill and a
   * medium tank scare**: 6 x 55 x 1.0 (rocket vs heavy) = 330 damage against a
   * 300hp light tank and a 400hp medium.
   */
  gunshipRockets: {
    id: 'gunshipRockets',
    name: 'Rocket Pod',
    damage: 55,
    warhead: 'rocket',
    range: 5,
    minRange: 0,
    cooldown: 12,
    burst: 1,
    projectile: 'rocket',
    speed: 11,
    inaccuracy: 2,
    homing: true,
    targetsAir: true,
    vsAirScale: 1,
  },

  // =========================================================================
  // C1 — 1917
  // =========================================================================
  /** Rifleman's bolt-action: a minigunner's round at half the cadence. */
  boltRifle: {
    id: 'boltRifle',
    name: 'Bolt Rifle',
    damage: 12,
    warhead: 'smallArms',
    range: 4.5,
    minRange: 0,
    cooldown: 20,
    burst: 1,
    projectile: 'bullet',
    speed: 24,
    inaccuracy: 3,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Stormtrooper's stick grenade: short, arcing, and murder on packed infantry. */
  grenade: {
    id: 'grenade',
    name: 'Stick Grenade',
    damage: 22,
    warhead: 'frag',
    range: 3.2,
    minRange: 0,
    cooldown: 34,
    burst: 1,
    projectile: 'arc',
    speed: 11,
    inaccuracy: 5,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Landship sponson gun: modest, slow, and attached to something enormous. */
  sixPounder: {
    id: 'sixPounder',
    name: '6-Pounder',
    damage: 30,
    warhead: 'cannon',
    range: 4.5,
    minRange: 0,
    cooldown: 45,
    burst: 1,
    projectile: 'shell',
    speed: 14,
    inaccuracy: 3,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Field gun: shorter reach than the 1991 howitzer, and flatter against armour. */
  fieldHowitzer: {
    id: 'fieldHowitzer',
    name: 'Field Howitzer',
    damage: 90,
    warhead: 'heavyShell',
    range: 7.5,
    minRange: 2,
    cooldown: 62,
    burst: 1,
    projectile: 'arc',
    speed: 9,
    inaccuracy: 9,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** MG nest: the era's emplacement — pure anti-infantry, no answer to a landship. */
  nestMg: {
    id: 'nestMg',
    name: 'Nest MG',
    damage: 15,
    warhead: 'smallArms',
    range: 7,
    minRange: 0,
    cooldown: 11,
    burst: 1,
    projectile: 'bullet',
    speed: 24,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },

  // =========================================================================
  // C1 — 1943
  // =========================================================================
  /** Rifle squad: the era's line infantry. Plinks at aircraft like the minigunner does. */
  squadRifles: {
    id: 'squadRifles',
    name: 'Squad Rifles',
    damage: 10,
    warhead: 'smallArms',
    range: 5,
    minRange: 0,
    cooldown: 11,
    burst: 1,
    projectile: 'bullet',
    speed: 24,
    inaccuracy: 3,
    homing: false,
    targetsAir: true,
    vsAirScale: 0.4,
  },
  /** Towed AT gun: one shot, one hole. Traverse is the price (see `atgun.turnRate`). */
  atRound: {
    id: 'atRound',
    name: 'AT Shot',
    damage: 50,
    warhead: 'apHigh',
    range: 6.5,
    minRange: 0,
    cooldown: 45,
    burst: 1,
    projectile: 'shell',
    speed: 20,
    inaccuracy: 1,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** The 1943 workhorse gun. */
  tankGun75: {
    id: 'tankGun75',
    name: '75mm Tank Gun',
    damage: 36,
    warhead: 'cannon',
    range: 5.5,
    minRange: 0,
    cooldown: 30,
    burst: 1,
    projectile: 'shell',
    speed: 16,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Breakthrough gun: `ap` at 1.0x vs heavy is what makes the heavy tank a heavy tank. */
  tankGun88: {
    id: 'tankGun88',
    name: '88mm Tank Gun',
    damage: 55,
    warhead: 'ap',
    range: 6,
    minRange: 0,
    cooldown: 42,
    burst: 1,
    projectile: 'shell',
    speed: 18,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /**
   * Dive-bomber payload. Four bombs, and four of them is a medium tank:
   * 4 x 125 x 0.8 (bomb vs heavy) = 400 = `mediumtank43.hp` exactly. They fall
   * on a *point* (`arc`), so a bomb run on a moving column is a real skill
   * check, and the 50px burst is what makes it worth flying at all.
   */
  bombRun: {
    id: 'bombRun',
    name: 'Bomb Rack',
    damage: 125,
    warhead: 'bomb',
    range: 3.5,
    minRange: 0,
    cooldown: 14,
    burst: 1,
    projectile: 'arc',
    speed: 12,
    inaccuracy: 4,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Flak tower: the era's answer to the dive bomber, and decent against infantry. */
  flakBurst: {
    id: 'flakBurst',
    name: 'Flak Burst',
    damage: 26,
    warhead: 'flak',
    range: 7.5,
    minRange: 0,
    cooldown: 9,
    burst: 1,
    projectile: 'bullet',
    speed: 26,
    inaccuracy: 2,
    homing: false,
    targetsAir: true,
    vsAirScale: 1.3,
  },

  // =========================================================================
  // C1 — 2077
  // =========================================================================
  /** Plasma trooper: infantry that hurts armour, and the era's mobile anti-air. */
  plasmaBolt: {
    id: 'plasmaBolt',
    name: 'Plasma Bolt',
    damage: 26,
    warhead: 'plasma',
    range: 5,
    minRange: 0,
    cooldown: 26,
    burst: 1,
    projectile: 'bullet',
    speed: 14,
    inaccuracy: 2,
    homing: false,
    targetsAir: true,
    vsAirScale: 1,
  },
  /** Hover tank's repeater. */
  pulseCannon: {
    id: 'pulseCannon',
    name: 'Pulse Cannon',
    damage: 36,
    warhead: 'plasma',
    range: 5.5,
    minRange: 0,
    cooldown: 28,
    burst: 1,
    projectile: 'shell',
    speed: 18,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /**
   * Spider mech's paired rail guns. The sim has **one weapon slot per unit
   * type** (and `Weapon.burst` has been declared-but-unread since Phase 1), so
   * the walker's "dual weapon vs ground" is modelled as a single heavy weapon
   * carrying both barrels' damage — documented in SPEC "C1: era framework".
   */
  twinRailgun: {
    id: 'twinRailgun',
    name: 'Twin Railgun',
    damage: 48,
    warhead: 'railSlug',
    range: 6,
    minRange: 0,
    cooldown: 34,
    burst: 1,
    projectile: 'shell',
    speed: 22,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Swarm drone's ground-attack bolt: cheap, weak, and unlimited. */
  droneBolt: {
    id: 'droneBolt',
    name: 'Drone Bolt',
    damage: 9,
    warhead: 'plasma',
    range: 4,
    minRange: 0,
    cooldown: 12,
    burst: 1,
    projectile: 'bullet',
    speed: 16,
    inaccuracy: 2,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Phase lance: instant hit at 9 tiles, with a 2-tile blind spot up close. */
  beamLance: {
    id: 'beamLance',
    name: 'Phase Lance',
    damage: 85,
    warhead: 'beam',
    range: 9,
    minRange: 2,
    cooldown: 62,
    burst: 1,
    projectile: 'beam',
    speed: 240,
    inaccuracy: 0,
    homing: false,
    targetsAir: false,
    vsAirScale: 1,
  },
  /** Laser tower: the era's emplacement — long, fast and untroubled by armour class. */
  towerLaser: {
    id: 'towerLaser',
    name: 'Tower Laser',
    damage: 42,
    warhead: 'laser',
    range: 8.5,
    minRange: 0,
    cooldown: 16,
    burst: 1,
    projectile: 'beam',
    speed: 240,
    inaccuracy: 0,
    homing: false,
    targetsAir: true,
    vsAirScale: 1,
  },
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export type UnitTypeId =
  | 'minigunner'
  | 'rocketSoldier'
  | 'engineer'
  | 'harvester'
  | 'buggy'
  | 'lightTank'
  | 'mediumTank'
  | 'artillery'
  | 'gunship'
  // C1 (chrono campaign) — era-exclusive rosters. `harvester` and `engineer`
  // above are the temporal constants: they are available in every era.
  // 1917
  | 'rifleman'
  | 'stormtrooper'
  | 'landship'
  | 'fieldgun'
  // 1943
  | 'riflesquad'
  | 'atgun'
  | 'mediumtank43'
  | 'heavytank'
  | 'divebomber'
  // 2077
  | 'plasmatrooper'
  | 'hovertank'
  | 'spidermech'
  | 'swarmdrone'
  | 'phaselancer';

export type UnitKind = 'infantry' | 'vehicle' | 'harvester' | 'air';

export interface UnitTypeDef {
  id: UnitTypeId;
  name: string;
  /** Short label for the sidebar. */
  short: string;
  kind: UnitKind;
  cost: number;
  hp: number;
  armor: ArmorClass;
  /** Movement speed in world px per tick. */
  speed: number;
  /** Turn rate in radians per tick. */
  turnRate: number;
  /** Sight radius in tiles. */
  sight: number;
  /** Collision radius in world px. */
  radius: number;
  weapon: WeaponId | null;
  /** Independent turret (renders + aims separately from the hull). */
  turret: boolean;
  /** Ticks to build at full power. */
  buildTime: number;
  /** Structure that produces this unit. */
  producedAt: BuildingTypeId;
  /** Structures that must exist (and be alive) before this can be queued. */
  prereq: BuildingTypeId[];
  /** Can be run over by tracked vehicles. */
  crushable: boolean;
  /** Runs over crushable units. */
  crusher: boolean;
  /** Harvester haul capacity in credits (0 = not a harvester). */
  cargoCapacity: number;
  /**
   * V2: this unit flies. It ignores terrain passability and building footprints
   * entirely (no A* — straight-line flight), separates only from other air
   * units, and can only be shot at by weapons flagged `targetsAir`.
   */
  isAir: boolean;
  /**
   * Rounds carried before the unit must rearm at a pad. 0 = unlimited ammo,
   * which is every ground unit.
   */
  ammo: number;
  /** Ticks docked on a pad to refill `ammo` (0 when `ammo` is 0). */
  rearmTime: number;
  /**
   * V2: this unit captures enemy structures instead of shooting them. Right-
   * clicking an enemy building with one selected issues a `capture` order; on
   * contact the structure changes hands and the unit is consumed. A flag rather
   * than a type-name test, exactly like `isAir`.
   */
  captures: boolean;
  /**
   * C1: this unit ignores the per-terrain speed multiplier (`TERRAIN_COST`), so
   * sand and crystal cost it nothing. It is **not** a passability flag — a
   * hover tank still cannot cross rock or a cliff and still paths like every
   * other ground unit. False on everything except the 2077 hover tank.
   */
  ignoresTerrainCost: boolean;
}

export const UNIT_TYPES: Record<UnitTypeId, UnitTypeDef> = {
  minigunner: {
    id: 'minigunner',
    name: 'Minigunner',
    short: 'MG',
    kind: 'infantry',
    cost: 100,
    hp: 50,
    armor: 'none',
    speed: 1.9,
    turnRate: 0.6,
    sight: 5,
    radius: 5,
    weapon: 'machinegun',
    turret: false,
    buildTime: secondsToTicks(3),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  rocketSoldier: {
    id: 'rocketSoldier',
    name: 'Rocket Soldier',
    short: 'RKT',
    kind: 'infantry',
    // Phase 7: 300 -> 250. The cheap answer to an early tank push should be
    // buyable two-at-a-time off one harvester load.
    cost: 250,
    hp: 45,
    armor: 'none',
    speed: 1.7,
    turnRate: 0.6,
    sight: 5,
    radius: 5,
    weapon: 'rocketLauncher',
    turret: false,
    buildTime: secondsToTicks(5),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    short: 'ENG',
    kind: 'infantry',
    cost: 500,
    hp: 30,
    armor: 'none',
    speed: 1.8,
    turnRate: 0.6,
    sight: 4,
    radius: 5,
    weapon: null,
    turret: false,
    buildTime: secondsToTicks(7),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: true,
    ignoresTerrainCost: false,
  },
  harvester: {
    id: 'harvester',
    name: 'Harvester',
    short: 'HARV',
    kind: 'harvester',
    cost: 1400,
    hp: 600,
    armor: 'heavy',
    speed: 2.6,
    turnRate: 0.14,
    sight: 4,
    radius: 11,
    weapon: null,
    turret: false,
    buildTime: secondsToTicks(10),
    producedAt: 'warFactory',
    prereq: ['refinery'],
    crushable: false,
    crusher: true,
    cargoCapacity: 700,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  buggy: {
    id: 'buggy',
    name: 'Scout Buggy',
    short: 'BGY',
    kind: 'vehicle',
    cost: 700,
    hp: 140,
    armor: 'light',
    speed: 5.0,
    turnRate: 0.3,
    sight: 8,
    radius: 8,
    weapon: 'machinegun',
    turret: true,
    buildTime: secondsToTicks(6),
    producedAt: 'warFactory',
    prereq: ['warFactory'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  lightTank: {
    id: 'lightTank',
    name: 'Light Tank',
    short: 'LTNK',
    kind: 'vehicle',
    cost: 1000,
    hp: 300,
    armor: 'heavy',
    speed: 3.6,
    turnRate: 0.18,
    sight: 6,
    radius: 10,
    weapon: 'lightCannon',
    turret: true,
    buildTime: secondsToTicks(9),
    producedAt: 'warFactory',
    prereq: ['warFactory'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  mediumTank: {
    id: 'mediumTank',
    name: 'Medium Tank',
    short: 'MTNK',
    kind: 'vehicle',
    cost: 1600,
    hp: 400,
    armor: 'heavy',
    speed: 3.0,
    turnRate: 0.16,
    sight: 6,
    radius: 11,
    weapon: 'mediumCannon',
    turret: true,
    buildTime: secondsToTicks(13),
    producedAt: 'warFactory',
    prereq: ['warFactory', 'commCenter'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  artillery: {
    id: 'artillery',
    name: 'Artillery',
    short: 'ARTY',
    kind: 'vehicle',
    cost: 1200,
    hp: 200,
    armor: 'light',
    speed: 2.4,
    turnRate: 0.16,
    sight: 6,
    radius: 10,
    weapon: 'howitzer',
    turret: false,
    buildTime: secondsToTicks(11),
    producedAt: 'warFactory',
    prereq: ['warFactory', 'commCenter'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * V2: the air unit. Faster than the scout buggy (5.6 vs 5.0 px/tick), light
   * armour and modest hp, and it flies over everything — rock, cliffs, water,
   * its own base. Six rockets per sortie and then it *has* to go home: the
   * whole design is "a strike that has to be timed and rearmed", not a flying
   * tank. Only `targetsAir` weapons can touch it (rocket soldiers, guard
   * towers, other gunships, and machine guns at half damage).
   */
  gunship: {
    id: 'gunship',
    name: 'Gunship',
    short: 'AIR',
    kind: 'air',
    cost: 1200,
    hp: 190,
    armor: 'light',
    speed: 5.6,
    turnRate: 0.34,
    sight: 8,
    radius: 10,
    weapon: 'gunshipRockets',
    turret: false,
    buildTime: secondsToTicks(11),
    producedAt: 'helipad',
    prereq: ['helipad'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: true,
    ammo: 6,
    rearmTime: secondsToTicks(6),
    captures: false,
    ignoresTerrainCost: false,
  },

  // =========================================================================
  // C1 — 1917: THE GREAT TRENCH
  //
  // Four types, one of them a vehicle. The era is deliberately slow: nothing
  // here moves faster than 2.4 px/tick, nothing flies, and nothing can shoot
  // at anything that does.
  // =========================================================================
  /** Line infantry. A minigunner with a heavier round at half the cadence. */
  rifleman: {
    id: 'rifleman',
    name: 'Rifleman',
    short: 'RFL',
    kind: 'infantry',
    cost: 80,
    hp: 45,
    armor: 'none',
    speed: 1.6,
    turnRate: 0.6,
    sight: 5,
    radius: 5,
    weapon: 'boltRifle',
    turret: false,
    buildTime: secondsToTicks(3),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /** Short-range grenadier: the era's splash, and its answer to a packed trench. */
  stormtrooper: {
    id: 'stormtrooper',
    name: 'Stormtrooper',
    short: 'STRM',
    kind: 'infantry',
    cost: 180,
    hp: 65,
    armor: 'none',
    speed: 1.9,
    turnRate: 0.6,
    sight: 5,
    radius: 5,
    weapon: 'grenade',
    turret: false,
    buildTime: secondsToTicks(5),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * The era's only vehicle besides the harvester: enormous, slow, heavily
   * armoured, and armed with a gun that is merely adequate. It crushes.
   */
  landship: {
    id: 'landship',
    name: 'Landship',
    short: 'LSHP',
    kind: 'vehicle',
    cost: 1400,
    hp: 520,
    armor: 'heavy',
    speed: 2.1,
    turnRate: 0.10,
    sight: 5,
    radius: 12,
    weapon: 'sixPounder',
    turret: false,
    buildTime: secondsToTicks(14),
    producedAt: 'warFactory',
    prereq: ['warFactory'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * Towed field gun. It is *not* a deploy/undeploy unit (kept simple, per the
   * C1 brief) — it is simply slow, fragile and outranges everything else in
   * 1917 by three tiles.
   */
  fieldgun: {
    id: 'fieldgun',
    name: 'Field Gun',
    short: 'FGUN',
    kind: 'vehicle',
    cost: 800,
    hp: 170,
    armor: 'light',
    speed: 1.5,
    turnRate: 0.14,
    sight: 6,
    radius: 10,
    weapon: 'fieldHowitzer',
    turret: false,
    buildTime: secondsToTicks(11),
    producedAt: 'warFactory',
    prereq: ['warFactory', 'commCenter'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },

  // =========================================================================
  // C1 — 1943: THE STEEL WINTER
  // =========================================================================
  /** Line infantry, and the era's only mobile thing that can shoot upward. */
  riflesquad: {
    id: 'riflesquad',
    name: 'Rifle Squad',
    short: 'SQD',
    kind: 'infantry',
    cost: 120,
    hp: 60,
    armor: 'none',
    speed: 1.8,
    turnRate: 0.6,
    sight: 5,
    radius: 5,
    weapon: 'squadRifles',
    turret: false,
    buildTime: secondsToTicks(3),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * Towed anti-tank gun. Enormous single-target damage, a `turnRate` a third of
   * a tank's (the "slow traverse" — non-turreted, so the whole carriage swings
   * under the Phase 4 aim tolerance), and 0.25x against the infantry sent to
   * overrun it.
   */
  atgun: {
    id: 'atgun',
    name: 'AT Gun',
    short: 'ATG',
    kind: 'vehicle',
    cost: 500,
    hp: 140,
    armor: 'light',
    speed: 1.6,
    turnRate: 0.06,
    sight: 6,
    radius: 9,
    weapon: 'atRound',
    turret: false,
    buildTime: secondsToTicks(7),
    producedAt: 'warFactory',
    prereq: ['warFactory'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /** The workhorse. Cheaper and lighter than the 1991 medium tank. */
  mediumtank43: {
    id: 'mediumtank43',
    name: 'Medium Tank',
    short: 'MED',
    kind: 'vehicle',
    cost: 900,
    hp: 400,
    armor: 'heavy',
    speed: 3.0,
    turnRate: 0.16,
    sight: 6,
    radius: 11,
    weapon: 'tankGun75',
    turret: true,
    buildTime: secondsToTicks(9),
    producedAt: 'warFactory',
    prereq: ['warFactory'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /** Breakthrough armour: beats the medium 1v1 and costs nearly twice as much. */
  heavytank: {
    id: 'heavytank',
    name: 'Heavy Tank',
    short: 'HVY',
    kind: 'vehicle',
    cost: 1700,
    hp: 520,
    armor: 'heavy',
    speed: 2.2,
    turnRate: 0.12,
    sight: 6,
    radius: 12,
    weapon: 'tankGun88',
    turret: true,
    buildTime: secondsToTicks(15),
    producedAt: 'warFactory',
    prereq: ['warFactory', 'commCenter'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * Dive bomber. Reuses the V2 ammo/rearm framework wholesale — four bombs, then
   * it flies back to an **airstrip** (the era's pad) and rearms. Its bombs
   * cannot engage aircraft, which is what keeps the flak tower relevant.
   */
  divebomber: {
    id: 'divebomber',
    name: 'Dive Bomber',
    short: 'BMBR',
    kind: 'air',
    cost: 1000,
    hp: 170,
    armor: 'light',
    speed: 5.2,
    turnRate: 0.30,
    sight: 8,
    radius: 10,
    weapon: 'bombRun',
    turret: false,
    buildTime: secondsToTicks(10),
    producedAt: 'airstrip',
    prereq: ['airstrip'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: true,
    ammo: 4,
    rearmTime: secondsToTicks(6),
    captures: false,
    ignoresTerrainCost: false,
  },

  // =========================================================================
  // C1 — 2077: THE LAST DAWN
  // =========================================================================
  /** Energy infantry: hurts armour, and is the era's mobile anti-air. */
  plasmatrooper: {
    id: 'plasmatrooper',
    name: 'Plasma Trooper',
    short: 'PLSM',
    kind: 'infantry',
    cost: 220,
    hp: 70,
    armor: 'none',
    speed: 1.9,
    turnRate: 0.6,
    sight: 5,
    radius: 5,
    weapon: 'plasmaBolt',
    turret: false,
    buildTime: secondsToTicks(4),
    producedAt: 'barracks',
    prereq: ['barracks'],
    crushable: true,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * Fast skirmish armour. `ignoresTerrainCost` is the whole identity: sand and
   * crystal do not slow it, so it holds 4.4 px/tick over ground that costs a
   * tracked vehicle 13-20%. It still cannot cross rock or cliff.
   */
  hovertank: {
    id: 'hovertank',
    name: 'Hover Tank',
    short: 'HOVR',
    kind: 'vehicle',
    cost: 1100,
    hp: 330,
    armor: 'heavy',
    speed: 4.4,
    turnRate: 0.26,
    sight: 6,
    radius: 10,
    weapon: 'pulseCannon',
    turret: true,
    buildTime: secondsToTicks(10),
    producedAt: 'warFactory',
    prereq: ['warFactory'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: true,
  },
  /** Heavy walker. The era's breakthrough unit and its most expensive ground type. */
  spidermech: {
    id: 'spidermech',
    name: 'Spider Mech',
    short: 'MECH',
    kind: 'vehicle',
    cost: 2000,
    hp: 480,
    armor: 'heavy',
    speed: 2.4,
    turnRate: 0.14,
    sight: 7,
    radius: 12,
    weapon: 'twinRailgun',
    turret: true,
    buildTime: secondsToTicks(16),
    producedAt: 'warFactory',
    prereq: ['warFactory', 'commCenter'],
    crushable: false,
    crusher: true,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * Cheap fragile air. **No ammo limit** (`ammo: 0`), so it never rearms and the
   * whole V2 pad cycle is a no-op for it — the trade is that its bolt is
   * feeble and it cannot engage other aircraft at all.
   */
  swarmdrone: {
    id: 'swarmdrone',
    name: 'Swarm Drone',
    short: 'DRNE',
    kind: 'air',
    cost: 350,
    hp: 70,
    armor: 'light',
    speed: 6.0,
    turnRate: 0.40,
    sight: 7,
    radius: 7,
    weapon: 'droneBolt',
    turret: false,
    buildTime: secondsToTicks(4),
    producedAt: 'helipad',
    prereq: ['helipad'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: true,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
  /**
   * Long-range beam platform — the era's artillery-class answer to armour. The
   * beam is an instant-hit line (no shell to out-run), so unlike the 1991
   * howitzer it never misses a mover; the price is a 2-tile blind spot, light
   * armour and a 62-tick recharge.
   */
  phaselancer: {
    id: 'phaselancer',
    name: 'Phase Lancer',
    short: 'LNCR',
    kind: 'vehicle',
    cost: 1500,
    hp: 220,
    armor: 'light',
    speed: 2.6,
    turnRate: 0.16,
    sight: 8,
    radius: 10,
    weapon: 'beamLance',
    turret: false,
    buildTime: secondsToTicks(13),
    producedAt: 'warFactory',
    prereq: ['warFactory', 'commCenter'],
    crushable: false,
    crusher: false,
    cargoCapacity: 0,
    isAir: false,
    ammo: 0,
    rearmTime: 0,
    captures: false,
    ignoresTerrainCost: false,
  },
};

export const UNIT_TYPE_IDS = Object.keys(UNIT_TYPES) as UnitTypeId[];

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildingTypeId =
  | 'conyard'
  | 'powerPlant'
  | 'refinery'
  | 'barracks'
  | 'warFactory'
  | 'commCenter'
  | 'silo'
  | 'guardTower'
  | 'sandbag'
  | 'helipad'
  // C1 (chrono campaign) — era-exclusive structures. Everything else in the
  // list above is shared by all four eras; only the defence emplacement and the
  // aircraft pad change with the era.
  | 'mgnest'
  | 'flaktower'
  | 'lasertower'
  | 'airstrip';

export interface BuildingTypeDef {
  id: BuildingTypeId;
  name: string;
  short: string;
  cost: number;
  hp: number;
  armor: ArmorClass;
  /** Footprint in tiles. */
  w: number;
  h: number;
  /** Sight radius in tiles. */
  sight: number;
  /** Net power: positive produces, negative consumes. */
  power: number;
  /** Extra credit storage granted. */
  storage: number;
  /** Ticks to build at full power. */
  buildTime: number;
  /** Structures required before this can be queued. */
  prereq: BuildingTypeId[];
  /** Unit kinds this structure can produce (empty = none). */
  produces: UnitKind[];
  /** Enables the radar/minimap while powered. */
  radar: boolean;
  weapon: WeaponId | null;
  turret: boolean;
  /** Free unit granted on completion (Refinery ships a harvester). */
  freeUnit?: UnitTypeId;
  /** Can be placed away from an existing base (defensive walls/sandbags). */
  standalone: boolean;
  /** Counts toward "has production capability" for the victory check. */
  productionStructure: boolean;
}

export const BUILDING_TYPES: Record<BuildingTypeId, BuildingTypeDef> = {
  conyard: {
    id: 'conyard',
    name: 'Construction Yard',
    short: 'CY',
    cost: 5000,
    hp: 1500,
    armor: 'structure',
    w: 3,
    h: 3,
    sight: 6,
    power: 0,
    storage: 0,
    buildTime: secondsToTicks(30),
    prereq: [],
    produces: [],
    radar: false,
    weapon: null,
    turret: false,
    standalone: true,
    productionStructure: true,
  },
  powerPlant: {
    id: 'powerPlant',
    name: 'Power Plant',
    short: 'PWR',
    cost: 300,
    hp: 400,
    armor: 'structure',
    w: 2,
    h: 2,
    sight: 4,
    power: 100,
    storage: 0,
    buildTime: secondsToTicks(8),
    prereq: [],
    produces: [],
    radar: false,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: false,
  },
  refinery: {
    id: 'refinery',
    name: 'Refinery',
    short: 'REF',
    cost: 2000,
    hp: 900,
    armor: 'structure',
    w: 3,
    h: 2,
    sight: 5,
    power: -30,
    storage: 1000,
    buildTime: secondsToTicks(20),
    prereq: ['powerPlant'],
    produces: [],
    radar: false,
    weapon: null,
    turret: false,
    freeUnit: 'harvester',
    standalone: false,
    productionStructure: false,
  },
  barracks: {
    id: 'barracks',
    name: 'Barracks',
    short: 'BRK',
    cost: 400,
    hp: 500,
    armor: 'structure',
    w: 2,
    h: 2,
    sight: 4,
    power: -20,
    storage: 0,
    buildTime: secondsToTicks(10),
    prereq: ['powerPlant'],
    produces: ['infantry'],
    radar: false,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: true,
  },
  warFactory: {
    id: 'warFactory',
    name: 'War Factory',
    short: 'WF',
    cost: 2000,
    hp: 800,
    armor: 'structure',
    w: 3,
    h: 2,
    sight: 4,
    power: -30,
    storage: 0,
    buildTime: secondsToTicks(20),
    prereq: ['refinery'],
    produces: ['vehicle', 'harvester'],
    radar: false,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: true,
  },
  commCenter: {
    id: 'commCenter',
    name: 'Comm Center',
    short: 'COM',
    cost: 1500,
    hp: 600,
    armor: 'structure',
    w: 2,
    h: 2,
    sight: 8,
    power: -40,
    storage: 0,
    buildTime: secondsToTicks(17),
    prereq: ['refinery'],
    produces: [],
    radar: true,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: false,
  },
  silo: {
    id: 'silo',
    name: 'Silo',
    short: 'SILO',
    cost: 150,
    hp: 300,
    armor: 'structure',
    w: 2,
    h: 1,
    sight: 3,
    power: -10,
    storage: 1500,
    buildTime: secondsToTicks(6),
    prereq: ['refinery'],
    produces: [],
    radar: false,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: false,
  },
  guardTower: {
    id: 'guardTower',
    name: 'Guard Tower',
    short: 'TWR',
    cost: 500,
    hp: 400,
    armor: 'structure',
    w: 1,
    h: 1,
    sight: 7,
    power: -10,
    storage: 0,
    buildTime: secondsToTicks(10),
    prereq: ['barracks'],
    produces: [],
    radar: false,
    weapon: 'towerGun',
    turret: true,
    standalone: true,
    productionStructure: false,
  },
  /**
   * V2: the air pad. Produces the gunship exactly the way the barracks produces
   * infantry (`produces: ['air']` + `producedAt: 'helipad'`), and doubles as the
   * rearm point — an empty gunship flies back to a *free* pad and sits on it for
   * `rearmTime`. It is deliberately **not** a `productionStructure` for the
   * defeat rule: losing your pads is a setback, not a loss (the victory rule
   * stays ConYard / Barracks / War Factory only).
   */
  helipad: {
    id: 'helipad',
    name: 'Helipad',
    short: 'PAD',
    cost: 1000,
    hp: 500,
    armor: 'structure',
    w: 2,
    h: 2,
    sight: 5,
    power: -10,
    storage: 0,
    buildTime: secondsToTicks(14),
    prereq: ['warFactory'],
    produces: ['air'],
    radar: false,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: false,
  },
  sandbag: {
    id: 'sandbag',
    name: 'Sandbag Wall',
    short: 'BAG',
    cost: 50,
    hp: 150,
    armor: 'structure',
    w: 1,
    h: 1,
    sight: 2,
    power: 0,
    storage: 0,
    buildTime: secondsToTicks(2),
    prereq: [],
    produces: [],
    radar: false,
    weapon: null,
    turret: false,
    standalone: true,
    productionStructure: false,
  },

  // =========================================================================
  // C1 — era defence emplacements and the 1943 air pad.
  //
  // All four are `productionStructure: false`, so `CHEAPEST_PRODUCTION` is
  // still the Barracks at 400 and the defeat rule is untouched.
  // =========================================================================
  /** 1917: pure anti-infantry. It has no answer at all to a landship. */
  mgnest: {
    id: 'mgnest',
    name: 'MG Nest',
    short: 'NEST',
    cost: 350,
    hp: 340,
    armor: 'structure',
    w: 1,
    h: 1,
    sight: 7,
    power: -5,
    storage: 0,
    buildTime: secondsToTicks(8),
    prereq: ['barracks'],
    produces: [],
    radar: false,
    weapon: 'nestMg',
    turret: true,
    standalone: true,
    productionStructure: false,
  },
  /** 1943: the era's anti-air, and decent against infantry. Nearly useless vs armour. */
  flaktower: {
    id: 'flaktower',
    name: 'Flak Tower',
    short: 'FLAK',
    cost: 600,
    hp: 420,
    armor: 'structure',
    w: 1,
    h: 1,
    sight: 8,
    power: -15,
    storage: 0,
    buildTime: secondsToTicks(10),
    prereq: ['barracks'],
    produces: [],
    radar: false,
    weapon: 'flakBurst',
    turret: true,
    standalone: true,
    productionStructure: false,
  },
  /** 2077: strong against everything, and it drains four times a guard tower. */
  lasertower: {
    id: 'lasertower',
    name: 'Laser Tower',
    short: 'LASR',
    cost: 800,
    hp: 620,
    armor: 'structure',
    w: 1,
    h: 1,
    sight: 8,
    power: -40,
    storage: 0,
    buildTime: secondsToTicks(12),
    prereq: ['barracks'],
    produces: [],
    radar: false,
    weapon: 'towerLaser',
    turret: true,
    standalone: true,
    productionStructure: false,
  },
  /**
   * 1943: the helipad's era variant. Same contract in every respect that
   * matters — `produces: ['air']`, `producedAt: 'airstrip'` on the dive bomber,
   * and the V2 rearm cycle docks on it by looking up `producedAt` — it is just
   * a longer footprint and a slightly cheaper building.
   */
  airstrip: {
    id: 'airstrip',
    name: 'Airstrip',
    short: 'STRP',
    cost: 900,
    hp: 500,
    armor: 'structure',
    w: 3,
    h: 2,
    sight: 5,
    power: -10,
    storage: 0,
    buildTime: secondsToTicks(14),
    prereq: ['warFactory'],
    produces: ['air'],
    radar: false,
    weapon: null,
    turret: false,
    standalone: false,
    productionStructure: false,
  },
};

export const BUILDING_TYPE_IDS = Object.keys(BUILDING_TYPES) as BuildingTypeId[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isUnitType(id: string): id is UnitTypeId {
  return Object.prototype.hasOwnProperty.call(UNIT_TYPES, id);
}

export function isBuildingType(id: string): id is BuildingTypeId {
  return Object.prototype.hasOwnProperty.call(BUILDING_TYPES, id);
}

/** Damage after the warhead-vs-armor multiplier. */
export function damageAgainst(
  damage: number,
  warhead: WarheadId,
  armor: ArmorClass,
): number {
  return damage * WARHEADS[warhead].vs[armor];
}

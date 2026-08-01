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

export type WarheadId = 'smallArms' | 'he' | 'ap' | 'rocket' | 'cannon' | 'apAuto';

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
  | 'gunshipRockets';

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
  /** Projectile visual/behaviour class. */
  projectile: 'bullet' | 'shell' | 'rocket' | 'arc';
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
  | 'gunship';

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
  | 'helipad';

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

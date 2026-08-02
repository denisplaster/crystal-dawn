/**
 * Eras — the CHRONO CAMPAIGN's time periods (C1).
 *
 * A battle is fought in exactly one era, and the era decides **which types the
 * roster contains**: unit availability, structure availability, which structure
 * is the era's defence emplacement, which pad (if any) produces its aircraft,
 * and the weights the AI rolls its army composition from.
 *
 * Three rules keep this additive rather than a fork of the game:
 *
 *   1. **`silicon` is the shipped roster, exactly.** Its unit and building lists
 *      are today's `UNIT_TYPE_IDS` / `BUILDING_TYPE_IDS` minus nothing, and its
 *      composition table reproduces the pre-C1 `rollWantedUnit` pool *entry for
 *      entry, in order*, so a skirmish rolls the same types off the same RNG
 *      draws. Every existing mode is therefore provably untouched.
 *   2. **Availability is a filter on top of the existing prereq system**, never a
 *      replacement for it: `canBuild` asks the era first and then asks the
 *      prereqs exactly as before.
 *   3. **`harvester` and `engineer` are temporal constants.** They travel with
 *      the player, so they are available in every era and the economy is
 *      identical everywhere (same harvester, same refinery, same numbers).
 *
 * This file is pure data + lookups. It imports type ids from `rules.ts` and
 * nothing else, so `ai.ts`, `production.ts` and the render side can all read it
 * without an import cycle.
 */

import type { BuildingTypeId, UnitTypeId } from './rules';

export type EraId = 'trench' | 'steel' | 'silicon' | 'future';

export const ERA_IDS: readonly EraId[] = ['trench', 'steel', 'silicon', 'future'];

/** The era a battle runs in unless one is asked for. */
export const DEFAULT_ERA: EraId = 'silicon';

export function isEraId(v: string): v is EraId {
  return v === 'trench' || v === 'steel' || v === 'silicon' || v === 'future';
}

/**
 * One row of an era's AI composition model.
 *
 * The three weights are the AI's tech phases, which are the same three the
 * pre-C1 roll used: `early` before a War Factory stands, `late` once it does,
 * and `tech` once a Comm Center stands as well. A weight of 0 removes the type
 * from that phase's pool entirely (it is never even asked whether it could be
 * built), and the rows are rolled **in array order**, so the pool a given phase
 * produces is a pure function of this table.
 */
export interface EraUnitWeight {
  type: UnitTypeId;
  early: number;
  late: number;
  tech: number;
  /**
   * Cut from the pool once infantry are over `INFANTRY_SHARE` of the army. This
   * is the Phase 5 rule that stops one unit queue filling with cheap infantry.
   */
  infantry?: boolean;
  /** Not offered until the AI has launched this many waves (siege weapons). */
  minWave?: number;
}

export interface EraFlavor {
  /** Two or three lines of situation copy for the briefing. */
  situation: readonly string[];
  /** Field directives, in the briefing's existing bullet voice. */
  directives: readonly string[];
  /** One-line tag for the era-select / debriefing furniture. */
  tag: string;
}

export interface EraDef {
  id: EraId;
  /** Full briefing headline, e.g. "THE GREAT TRENCH, 1917". */
  label: string;
  /** Short tag for HUD chrome. */
  short: string;
  year: number;
  /** Units this era's factories may produce. */
  units: readonly UnitTypeId[];
  /** Structures this era may build (the ConYard is pre-placed as always). */
  buildings: readonly BuildingTypeId[];
  /** The era's defence emplacement — what the AI's build plan asks for. */
  defenseTower: BuildingTypeId;
  /** The era's aircraft pad, or null when the era has no air at all. */
  airPad: BuildingTypeId | null;
  /** The era's aircraft, or null. Bought outside the composition roll. */
  airUnit: UnitTypeId | null;
  /**
   * The era's line infantry — what the free opening scout is. `minigunner` in
   * silicon, i.e. the shipped opening exactly.
   */
  scoutUnit: UnitTypeId;
  /** AI army composition, rolled in array order. */
  composition: readonly EraUnitWeight[];
  /** C2 consumes this to pick the era's colour ramp / theater art. */
  paletteKey: string;
  flavor: EraFlavor;
}

/**
 * Units every era fields. They are the player's own column travelling through
 * time, which is also why the economy is identical in all four eras.
 */
export const TEMPORAL_UNITS: readonly UnitTypeId[] = ['harvester', 'engineer'];

/**
 * Structures every era builds. Only the defence emplacement and the air pad
 * change with the era; the base itself is the same base.
 */
export const SHARED_BUILDINGS: readonly BuildingTypeId[] = [
  'conyard',
  'powerPlant',
  'refinery',
  'barracks',
  'warFactory',
  'commCenter',
  'silo',
  'sandbag',
];

export const ERAS: Record<EraId, EraDef> = {
  trench: {
    id: 'trench',
    label: 'THE GREAT TRENCH, 1917',
    short: 'TRENCH',
    year: 1917,
    units: ['rifleman', 'stormtrooper', 'landship', 'fieldgun', ...TEMPORAL_UNITS],
    buildings: [...SHARED_BUILDINGS, 'mgnest'],
    defenseTower: 'mgnest',
    // No aviation: 1917 has no unit that leaves the ground, and consequently no
    // anti-air anywhere in the era.
    airPad: null,
    airUnit: null,
    scoutUnit: 'rifleman',
    composition: [
      { type: 'rifleman', early: 6, late: 2, tech: 2, infantry: true },
      { type: 'stormtrooper', early: 3, late: 3, tech: 3, infantry: true },
      { type: 'landship', early: 0, late: 6, tech: 4 },
      { type: 'fieldgun', early: 0, late: 0, tech: 3, minWave: 2 },
    ],
    paletteKey: 'trenchMud',
    flavor: {
      tag: 'MUD, WIRE AND GAS',
      situation: [
        'THE CHRONO GATE HAS PUT YOU BEHIND THE WESTERN LINE IN 1917.',
        'THE ORDER IS MINING CRYSTAL UNDER THE SALIENT AND FEEDING IT FORWARD',
        'THROUGH TIME. BREAK THE POSITION BEFORE THE SHIPMENT MOVES.',
      ],
      directives: [
        'NO AIRCRAFT EXIST IN THIS ERA - AND NEITHER DOES ANTI-AIR',
        'LANDSHIPS SOAK ENORMOUS PUNISHMENT - LEAD WITH THEM',
        'FIELD GUNS OUTRANGE EVERYTHING - SCREEN THEM WITH RIFLEMEN',
      ],
    },
  },

  steel: {
    id: 'steel',
    label: 'THE STEEL WINTER, 1943',
    short: 'STEEL',
    year: 1943,
    units: ['riflesquad', 'atgun', 'mediumtank43', 'heavytank', 'divebomber', ...TEMPORAL_UNITS],
    buildings: [...SHARED_BUILDINGS, 'flaktower', 'airstrip'],
    defenseTower: 'flaktower',
    airPad: 'airstrip',
    airUnit: 'divebomber',
    scoutUnit: 'riflesquad',
    composition: [
      { type: 'riflesquad', early: 6, late: 2, tech: 2, infantry: true },
      { type: 'atgun', early: 0, late: 3, tech: 3 },
      { type: 'mediumtank43', early: 0, late: 6, tech: 4 },
      { type: 'heavytank', early: 0, late: 0, tech: 5 },
    ],
    paletteKey: 'steelWinter',
    flavor: {
      tag: 'ARMOUR AND ARTILLERY',
      situation: [
        'WINTER, 1943. THE ORDER HOLDS A RAIL HEAD FEEDING CRYSTAL WEST.',
        'BOTH SIDES HAVE TANKS, GUNS AND AIRCRAFT - AND THIS TIME',
        'THE SKY IS CONTESTED.',
      ],
      directives: [
        'FLAK TOWERS ARE THE ONLY REAL ANSWER TO DIVE BOMBERS',
        'ANTI-TANK GUNS SHRED ARMOUR AND DO ALMOST NOTHING TO INFANTRY',
        'AIRSTRIPS ARM DIVE BOMBERS - FOUR BOMBS, THEN REARM',
      ],
    },
  },

  /**
   * The shipped roster, unchanged. Every id below is exactly what
   * `UNIT_TYPE_IDS` / `BUILDING_TYPE_IDS` held before C1, and the composition
   * reproduces the pre-C1 pool in order:
   *
   *   no war factory -> minigunner x6, rocketSoldier x3
   *   war factory    -> minigunner x2 (share permitting), rocketSoldier x3, lightTank x6
   *   + comm center  -> ... lightTank x3, mediumTank x5, artillery x3 (from wave 2)
   */
  silicon: {
    id: 'silicon',
    label: 'THE CRYSTAL DAWN, 1991',
    short: 'SILICON',
    year: 1991,
    units: [
      'minigunner',
      'rocketSoldier',
      'engineer',
      'harvester',
      'buggy',
      'lightTank',
      'mediumTank',
      'artillery',
      'gunship',
    ],
    buildings: [...SHARED_BUILDINGS, 'guardTower', 'helipad'],
    defenseTower: 'guardTower',
    airPad: 'helipad',
    airUnit: 'gunship',
    scoutUnit: 'minigunner',
    composition: [
      { type: 'minigunner', early: 6, late: 2, tech: 2, infantry: true },
      { type: 'rocketSoldier', early: 3, late: 3, tech: 3, infantry: true },
      { type: 'lightTank', early: 0, late: 6, tech: 3 },
      { type: 'mediumTank', early: 0, late: 0, tech: 5 },
      { type: 'artillery', early: 0, late: 0, tech: 3, minWave: 2 },
    ],
    paletteKey: 'siliconDesert',
    flavor: {
      tag: 'THE WAR YOU KNOW',
      situation: [
        'THE PRESENT DAY. THE ORDER IS DUG IN OVER A CRYSTAL FIELD',
        'AND HAS THE SAME TOYS YOU DO.',
      ],
      directives: [
        'HARVEST CRYSTAL - IT IS THE ONLY INCOME',
        'ROCKET SOLDIERS AND GUARD TOWERS ANSWER BOTH TANKS AND AIRCRAFT',
      ],
    },
  },

  future: {
    id: 'future',
    label: 'THE LAST DAWN, 2077',
    short: 'FUTURE',
    year: 2077,
    units: ['plasmatrooper', 'hovertank', 'spidermech', 'swarmdrone', 'phaselancer', ...TEMPORAL_UNITS],
    buildings: [...SHARED_BUILDINGS, 'lasertower', 'helipad'],
    defenseTower: 'lasertower',
    airPad: 'helipad',
    airUnit: 'swarmdrone',
    scoutUnit: 'plasmatrooper',
    composition: [
      { type: 'plasmatrooper', early: 6, late: 2, tech: 2, infantry: true },
      { type: 'hovertank', early: 0, late: 6, tech: 4 },
      { type: 'spidermech', early: 0, late: 0, tech: 5 },
      { type: 'phaselancer', early: 0, late: 0, tech: 3, minWave: 2 },
    ],
    paletteKey: 'futureNeon',
    flavor: {
      tag: 'ENERGY AND WALKERS',
      situation: [
        '2077. THE ORDER WON THIS WAR ONCE ALREADY.',
        'THE CRYSTAL HERE BURNS HOT ENOUGH TO POWER A CHRONO GATE,',
        'WHICH IS WHY THEY WILL NOT GIVE IT UP.',
      ],
      directives: [
        'HOVER TANKS IGNORE BROKEN GROUND - USE THE ROUGH LINE',
        'PLASMA TROOPERS AND LASER TOWERS ARE YOUR ANTI-AIR',
        'PHASE LANCERS FIRE INSTANTLY AT RANGE BUT CANNOT TRACK AIRCRAFT',
      ],
    },
  },
};

/**
 * C3 — the ORIGIN MOMENT's composition. **Not an era**: it is the table the AI
 * rolls from when `GameState.anomaly` is set, which happens in exactly one
 * battle in the game.
 *
 * The anomaly is a place where the chrono gate has torn and every war is
 * happening at once, so The Order's roster gate is lifted (`canBuild` stops
 * asking `eraAllows` for player 1) and its army is drawn from **all four
 * eras**: 1917 riflemen beside 2077 plasma troopers, landships beside spider
 * mechs. Everything else about the AI is unchanged — the same three tech
 * phases, the same infantry share cut, the same `minWave` gate on siege
 * weapons, the same array-order walk — because C1 made compositions data and
 * this is just another table.
 *
 * The player is **not** un-gated: the ORIGIN MOMENT is fought in `future`, and
 * a 2077 roster is what the sidebar offers.
 */
export const ANOMALY_COMPOSITION: readonly EraUnitWeight[] = [
  { type: 'rifleman', early: 3, late: 1, tech: 1, infantry: true },
  { type: 'riflesquad', early: 3, late: 1, tech: 1, infantry: true },
  { type: 'rocketSoldier', early: 2, late: 1, tech: 1, infantry: true },
  { type: 'plasmatrooper', early: 3, late: 2, tech: 2, infantry: true },
  { type: 'landship', early: 0, late: 4, tech: 3 },
  { type: 'mediumtank43', early: 0, late: 4, tech: 3 },
  { type: 'mediumTank', early: 0, late: 3, tech: 3 },
  { type: 'hovertank', early: 0, late: 4, tech: 3 },
  { type: 'heavytank', early: 0, late: 0, tech: 4 },
  { type: 'spidermech', early: 0, late: 0, tech: 5 },
  { type: 'phaselancer', early: 0, late: 0, tech: 3, minWave: 2 },
  { type: 'fieldgun', early: 0, late: 0, tech: 2, minWave: 2 },
];

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function eraDef(era: EraId): EraDef {
  return ERAS[era];
}

/** Is this unit type part of the era's roster? */
export function eraHasUnit(era: EraId, type: UnitTypeId): boolean {
  return ERAS[era].units.includes(type);
}

/** Is this structure part of the era's roster? */
export function eraHasBuilding(era: EraId, type: BuildingTypeId): boolean {
  return ERAS[era].buildings.includes(type);
}

/** Availability for either kind of id, for the one place that has both. */
export function eraAllows(era: EraId, type: UnitTypeId | BuildingTypeId): boolean {
  return (
    ERAS[era].units.includes(type as UnitTypeId) ||
    ERAS[era].buildings.includes(type as BuildingTypeId)
  );
}

/** The era's defence emplacement (guardTower in silicon). */
export function eraDefenseTower(era: EraId): BuildingTypeId {
  return ERAS[era].defenseTower;
}

/** The era's aircraft pad, or null (trench). */
export function eraAirPad(era: EraId): BuildingTypeId | null {
  return ERAS[era].airPad;
}

/** The era's aircraft, or null (trench). */
export function eraAirUnit(era: EraId): UnitTypeId | null {
  return ERAS[era].airUnit;
}

/** The era's line infantry — the free opening scout. */
export function eraScoutUnit(era: EraId): UnitTypeId {
  return ERAS[era].scoutUnit;
}

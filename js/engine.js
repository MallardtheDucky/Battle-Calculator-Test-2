// BattleEngine - pure simulation logic. No DOM access anywhere in this file.
// Import this file (or bundle it) from a Discord bot exactly as the browser
// UI does: BattleEngine.simulate(attacker, defender, battlefield, options)

import { makeRng, seedFromString } from "./rng.js";
import { commanderModifiers, rollCommanderFate } from "./commanders.js";

// melee/ranged/charge = base combat power per soldier
// defense    = per-soldier contribution to the side's overall mitigation
// armor      = personal protection; reduces this unit type's *share* of
//              casualties taken relative to its headcount (0 = unarmored,
//              ~0.8 = heavily armored)
// speed      = mobility; feeds flanking odds and how hard a rout is to
//              catch/escape
// cavVuln      = multiplier to casualties taken specifically from a
//                successful cavalry charge/flank
// pursuitPower = effectiveness chasing down a routing enemy
// fatigueRate  = how quickly this unit type tires relative to baseline
// category     = "infantry" | "ranged" | "cavalry" | "siege" - drives which
//                units count toward cavalry-flank/pursuit math and the
//                skirmish narration, so custom unit types plug into those
//                systems too instead of only the built-in keys.
//
// This registry is only the *default seed*. The running app treats it as
// fully editable and extensible at runtime (see js/ui.js's Unit Types tab
// and js/sync.js) - every field here can be retuned per-server, and new
// unique unit types can be added with the same shape. simulate() below
// always takes the live registry via options.unitTypes; DEFAULT_UNIT_TYPES
// is just the fallback for a bare `import { simulate }` with no options.
export const DEFAULT_UNIT_TYPES = {
  infantry:      { label: "Legionary Infantry",     category: "infantry", melee: 1.0,  ranged: 0.05, charge: 0.2,  defense: 1.0,  armor: 0.35, speed: 0.90, cavVuln: 1.0,  pursuitPower: 0.3,  fatigueRate: 1.0 },
  heavyInfantry: { label: "Heavy Legionary (Armored)", category: "infantry", melee: 1.35, ranged: 0.0,  charge: 0.3,  defense: 1.4,  armor: 0.75, speed: 0.60, cavVuln: 0.7,  pursuitPower: 0.2,  fatigueRate: 1.25 },
  spearmen:      { label: "Auxiliary Spearmen",      category: "infantry", melee: 0.95, ranged: 0.0,  charge: 0.15, defense: 1.15, armor: 0.40, speed: 0.85, cavVuln: 0.45, pursuitPower: 0.2,  fatigueRate: 1.0 },
  archers:       { label: "Archers & Slingers",      category: "ranged",   melee: 0.35, ranged: 1.3,  charge: 0.05, defense: 0.6,  armor: 0.15, speed: 0.95, cavVuln: 1.6,  pursuitPower: 0.15, fatigueRate: 0.9 },
  lightCavalry:  { label: "Numidian Light Cavalry",  category: "cavalry",  melee: 0.85, ranged: 0.0,  charge: 1.15, defense: 0.75, armor: 0.30, speed: 1.60, cavVuln: 0.5,  pursuitPower: 1.4,  fatigueRate: 1.1 },
  heavyCavalry:  { label: "Allied Heavy Cavalry",    category: "cavalry",  melee: 1.25, ranged: 0.0,  charge: 1.75, defense: 1.0,  armor: 0.65, speed: 1.30, cavVuln: 0.4,  pursuitPower: 1.2,  fatigueRate: 1.3 },
};

// Used only if a regiment references a unit type key that has since been
// deleted from the registry, so a stale save never crashes the sim.
const FALLBACK_UNIT_TYPE = { label: "Unknown Levy", category: "infantry", melee: 0.7, ranged: 0.0, charge: 0.1, defense: 0.7, armor: 0.2, speed: 0.85, cavVuln: 1.0, pursuitPower: 0.2, fatigueRate: 1.0 };

export const TERRAIN = {
  plains: { label: "Plains", cavalryMod: 0.20, rangedMod: 0.0, defenseMod: 0.0 },
  hills:  { label: "Hills / Broken Ground", cavalryMod: -0.30, rangedMod: 0.10, defenseMod: 0.15 },
  forest: { label: "Forest", cavalryMod: -0.45, rangedMod: -0.15, defenseMod: 0.10 },
  river:  { label: "River Crossing", cavalryMod: -0.20, rangedMod: 0.05, defenseMod: 0.25 },
  urban:  { label: "Urban / Siege", cavalryMod: -0.60, rangedMod: -0.10, defenseMod: 0.35 },
};

export const WEATHER = {
  clear: { label: "Clear", moraleMod: 0.0, rangedMod: 0.0, fatigueMod: 0.0 },
  rain:  { label: "Rain", moraleMod: -0.05, rangedMod: -0.25, fatigueMod: 0.15 },
  fog:   { label: "Fog", moraleMod: -0.05, rangedMod: -0.35, fatigueMod: 0.0, surpriseMod: 0.15 },
  snow:  { label: "Snow", moraleMod: -0.10, rangedMod: -0.10, fatigueMod: 0.30 },
  heat:  { label: "Extreme Heat", moraleMod: -0.05, rangedMod: 0.0, fatigueMod: 0.25 },
};

export const FORMATIONS = {
  line:      { label: "Line", offense: 0.0, defense: 0.0, flankVuln: 0.0 },
  aggressive:{ label: "Aggressive Advance", offense: 0.20, defense: -0.15, flankVuln: 0.10 },
  defensive: { label: "Defensive Hold", offense: -0.15, defense: 0.25, flankVuln: -0.10 },
  flanking:  { label: "Flanking Deployment", offense: 0.05, defense: -0.10, flankVuln: -0.20, flankBonus: 0.20 },
  ambush:    { label: "Ambush / Refused Line", offense: 0.10, defense: 0.05, flankVuln: -0.15, surpriseBonus: 0.20 },
};

// Formations the tactical AI may switch into mid-battle. Ambush is a
// pre-battle stance only (surprise works once, at deployment), so the AI
// never assigns it - a side can start there but drifts onto one of these
// once the fight actually opens.
const AI_FORMATIONS = ["line", "aggressive", "defensive", "flanking"];

// A regiment is the unit of organization within an army: a named block of
// troops of one unit type, with its own headcount and its own experience
// that grows (or is lost, if the regiment is wiped out) from battle to
// battle. Armies are a list of these rather than a flat headcount-per-type
// map, so individual regiments can be tracked, renamed, and leveled up.
let regimentCounter = 0;
export function makeRegiment({ id, name, unitTypeKey, count, experience = 30 } = {}) {
  return {
    id: id || `rgt_${Date.now().toString(36)}_${(regimentCounter++).toString(36)}`,
    name: name || "",
    unitTypeKey,
    count: Math.max(0, Math.round(count || 0)),
    experience: clamp(experience ?? 30, 0, 100),
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function typeDef(unitTypes, key) { return unitTypes[key] || FALLBACK_UNIT_TYPE; }

function aggregateUnits(regiments) {
  const out = {};
  for (const r of regiments) {
    if (r.count <= 0) continue;
    out[r.unitTypeKey] = (out[r.unitTypeKey] || 0) + r.count;
  }
  return out;
}

// Headcount-weighted average experience of all regiments of one unit type -
// this is what feeds the type's experience multiplier in computePower.
function weightedExperience(regiments, typeKey) {
  let wsum = 0, csum = 0;
  for (const r of regiments) {
    if (r.unitTypeKey !== typeKey || r.count <= 0) continue;
    wsum += r.experience * r.count;
    csum += r.count;
  }
  return csum > 0 ? wsum / csum : 30;
}

function totalTroops(army) { return totalRegimentTroops(army.regiments || []); }
function totalRegimentTroops(regiments) {
  return regiments.reduce((s, r) => s + Math.max(0, r.count || 0), 0);
}

function cloneArmyState(army) {
  const regiments = (army.regiments || []).map((r) => ({ ...r, count: Math.max(0, Math.round(r.count || 0)) }));
  return {
    name: army.name,
    regiments,
    units: aggregateUnits(regiments),
    morale: army.morale ?? 70,
    supply: army.supply ?? 80,
    fatigue: 0,
    quality: army.quality ?? 55,
    formation: army.formation ?? "line",
    commander: army.commander ?? null,
    status: "holding", // holding | shaken | routing | retreating | destroyed
    killed: 0, wounded: 0, captured: 0, routed: 0,
    overextended: false,
  };
}

// How many regiments a commander can effectively lead before coordination
// starts to suffer. Extra regiments beyond the limit don't stop fighting,
// but the whole army's offense/defense is diminished the further over the
// limit it runs - representing a single command structure stretched thin.
function commandOverextension(state) {
  const limit = state.commander?.commandLimit;
  if (!limit) return 0;
  const activeRegiments = state.regiments.filter((r) => r.count > 0).length;
  if (activeRegiments <= limit) return 0;
  return clamp((activeRegiments - limit) * 0.035, 0, 0.35);
}

// Rough composite-strength readout used only by the tactical AI to size up
// a matchup before terrain/weather/formation are locked in for the turn.
function estimateStrength(state, unitTypes) {
  let melee = 0, ranged = 0, cav = 0, cavSpeed = 0, total = 0;
  for (const [key, count] of Object.entries(state.units)) {
    if (count <= 0) continue;
    const def = typeDef(unitTypes, key);
    melee += count * def.melee;
    ranged += count * def.ranged;
    total += count;
    if (def.category === "cavalry") {
      cav += count;
      cavSpeed += count * def.speed;
    }
  }
  return { melee, ranged, cav, avgCavSpeed: cav > 0 ? cavSpeed / cav : 0, total };
}

const TACTIC_NARRATION = {
  aggressive: (n) => `${n} senses an opening and orders an aggressive advance.`,
  defensive: (n) => `${n} pulls the line back into a defensive hold.`,
  flanking: (n) => `${n} wheels the cavalry wide into a flanking deployment.`,
  line: (n) => `${n} reforms the army into a standard battle line.`,
};

// Commander tactical AI: each combat turn, before power is computed, every
// commander re-reads the matchup and scores the available formations. A
// commander's `tactics` stat governs how reliably they act on the correct
// read; traits (Aggressive, Cautious, Cavalry Specialist, Brilliant
// Strategist, etc.) bias which kind of read they favor. Mutates
// `state.formation` in place and returns a narrative line, or null if the
// formation didn't change this turn.
function runCommanderTactics(state, enemyState, terrainKey, role, rng, unitTypes) {
  const cmd = state.commander;
  if (!cmd || cmd.status === "killed" || cmd.status === "fled") return null;
  if (state.status === "routing" || state.status === "retreating") return null;

  const traits = cmd.traits || [];
  const tactics = cmd.stats?.tactics ?? 50;
  const t = TERRAIN[terrainKey];
  const own = estimateStrength(state, unitTypes);
  const enemy = estimateStrength(enemyState, unitTypes);
  const meleeRatio = own.melee / Math.max(1, enemy.melee);

  const scores = { line: 0.12, aggressive: 0, defensive: 0, flanking: 0 };

  if (own.cav > 0 && own.cav > enemy.cav * 1.25 && t.cavalryMod > -0.35) {
    scores.flanking += 0.40 + Math.min(0.25, (own.avgCavSpeed - enemy.avgCavSpeed) * 0.15);
  }
  if (meleeRatio < 0.85) scores.defensive += 0.35;
  if (state.morale < 45) scores.defensive += 0.30;
  if (state.fatigue > 55) scores.defensive += 0.20;
  if (role === "defender" && (state.fortification ?? 0) > 35) scores.defensive += 0.25;
  if (meleeRatio > 1.2 && state.morale > 55 && state.fatigue < 50) scores.aggressive += 0.40;
  if (own.ranged > enemy.ranged * 1.5 && state.morale > 50) scores.defensive += 0.15;

  if (traits.includes("aggressive") || traits.includes("reckless")) scores.aggressive += 0.20;
  if (traits.includes("defensive_bulwark") || traits.includes("cautious")) scores.defensive += 0.20;
  if (traits.includes("cavalry_specialist")) scores.flanking += 0.20;
  if (traits.includes("brilliant_strategist")) { scores.flanking += 0.10; scores.aggressive += 0.05; scores.defensive += 0.05; }

  // Inertia: a small bonus for staying put avoids flip-flopping every turn
  // over marginal score differences.
  if (state.formation in scores) scores[state.formation] += 0.15;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let choice = ranked[0][0];

  const misreadChance = clamp((55 - tactics) / 130, 0, 0.45);
  if (rng() < misreadChance && ranked.length > 1) {
    choice = rng() < 0.5 ? state.formation : ranked[1][0];
  }

  if (choice === state.formation || !AI_FORMATIONS.includes(choice)) return null;
  state.formation = choice;
  return TACTIC_NARRATION[choice]?.(cmd.name || `${state.name}'s commander`) ?? null;
}

// Effective combat power for one side this turn, split by melee/ranged/charge.
function computePower(state, enemyState, terrain, weather, role, rng, unitTypes) {
  const t = TERRAIN[terrain];
  const w = WEATHER[weather];
  const f = FORMATIONS[state.formation];
  const cmdMods = commanderModifiers(state.commander, terrain);

  const moraleMult = clamp(0.4 + state.morale / 100, 0.4, 1.4);
  const fatigueMult = clamp(1 - state.fatigue / 160, 0.5, 1.0);
  const qualityMult = 0.6 + state.quality / 100;

  let melee = 0, ranged = 0, charge = 0, defense = 0, cavalryMass = 0, rangedMass = 0;
  for (const [key, count] of Object.entries(state.units)) {
    if (count <= 0) continue;
    const def = typeDef(unitTypes, key);
    const expMult = 0.85 + weightedExperience(state.regiments, key) / 300;
    const scale = count * qualityMult * expMult * moraleMult * fatigueMult;
    melee += scale * def.melee;
    ranged += scale * def.ranged * (1 + t.rangedMod + w.rangedMod);
    let chg = scale * def.charge * (1 + t.cavalryMod);
    if (def.category === "cavalry") {
      chg *= (1 + cmdMods.cavalryEffect) * (0.8 + def.speed * 0.2);
      cavalryMass += count;
    }
    charge += chg;
    defense += scale * def.defense * (1 + def.armor * 0.4);
    if (def.category === "ranged") rangedMass += count;
  }

  defense *= 1 + t.defenseMod + f.defense + cmdMods.defense;
  if (role === "defender") defense *= 1 + (state.fortification ?? 0) / 200 * (1 + cmdMods.fortificationEffect);
  melee *= 1 + f.offense + cmdMods.offense;
  charge *= 1 + cmdMods.chargePower;

  const overextension = commandOverextension(state);
  state.overextended = overextension > 0;
  if (overextension > 0) {
    melee *= 1 - overextension;
    ranged *= 1 - overextension;
    charge *= 1 - overextension;
    defense *= 1 - overextension * 0.6;
  }

  return { melee, ranged, charge, defense, cavalryMass, rangedMass };
}

// Splits `loss` headcount taken by one unit type across that type's
// regiments, proportional to their current headcount, so individual
// regiments (not just the aggregate type total) shrink from casualties.
function distributeLossToRegiments(regiments, typeKey, loss, rng) {
  let remaining = Math.round(loss);
  if (remaining <= 0) return;
  const list = regiments.filter((r) => r.unitTypeKey === typeKey && r.count > 0);
  const totalCount = list.reduce((s, r) => s + r.count, 0);
  if (totalCount <= 0) return;
  list.forEach((r, i) => {
    if (remaining <= 0) return;
    const share = i === list.length - 1 ? remaining : Math.round((r.count / totalCount) * loss);
    const cut = Math.min(r.count, share, remaining);
    r.count -= cut;
    remaining -= cut;
  });
  if (remaining > 0) {
    for (const r of list) {
      if (remaining <= 0) break;
      const cut = Math.min(r.count, remaining);
      r.count -= cut;
      remaining -= cut;
    }
  }
}

function applyCasualties(state, amount, rng, opts = {}, unitTypes) {
  amount = Math.max(0, Math.round(amount));
  const alive = totalTroops(state);
  if (alive <= 0 || amount <= 0) return { killed: 0, wounded: 0, captured: 0 };
  amount = Math.min(amount, alive);

  // Distribute losses across unit types weighted by headcount, eased by
  // each type's armor and, during a cavalry charge, extra weight on
  // cavVuln (how exposed that type is to a charge).
  const entries = Object.entries(state.units).filter(([, c]) => c > 0);
  const weights = entries.map(([key, c]) => {
    const def = typeDef(unitTypes, key);
    const vulnBoost = opts.chargeWeighted ? def.cavVuln : 1;
    const armorEase = 1 / (1 + def.armor * 0.6);
    return c * vulnBoost * armorEase;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  let killed = 0, wounded = 0, captured = 0;
  entries.forEach(([key, c], i) => {
    const share = Math.round((weights[i] / totalWeight) * amount);
    const loss = Math.min(share, c);
    distributeLossToRegiments(state.regiments, key, loss, rng);
    const k = Math.round(loss * (opts.killRatio ?? 0.42));
    const wnd = Math.round(loss * (opts.woundRatio ?? 0.40));
    const cap = loss - k - wnd;
    killed += k; wounded += wnd; captured += Math.max(0, cap);
  });
  state.units = aggregateUnits(state.regiments);
  state.killed += killed;
  state.wounded += wounded;
  state.captured += captured;
  return { killed, wounded, captured };
}

function moraleShift(state, enemyState, myCasualtyRatio, winning, weatherMoraleMod) {
  const cmdMods = commanderModifiers(state.commander, state.terrain);
  let delta = -myCasualtyRatio * 140;
  delta += winning ? 3 : -6;
  delta += cmdMods.moraleRetention * 20;
  delta += (weatherMoraleMod ?? 0) * 20;
  if (state.supply < 30) delta -= 4;
  if (state.fatigue > 60) delta -= 3;
  state.morale = clamp(state.morale + delta, 0, 100);
}

function checkRoutStatus(state, rng) {
  const cmdMods = commanderModifiers(state.commander, state.terrain);
  const routResist = cmdMods.routResist * 25;
  const routThreshold = 24 - routResist;
  if (state.morale <= routThreshold && state.status !== "routing") {
    if (rng() < 0.55) { state.status = "routing"; return true; }
  } else if (state.morale <= 38 && state.status === "holding") {
    if (rng() < 0.4) { state.status = "shaken"; }
  } else if (state.morale > 45 && state.status === "shaken") {
    state.status = "holding";
  }
  return false;
}

function buildEvents({ attacker, defender, phase, atkCas, defCas, atkFlank, defFlank, atkBreakthrough, defBreakthrough, atkJustRouted, defJustRouted, atkCmdEvent, defCmdEvent, atkTactic, defTactic, terrain, weather }) {
  const events = [];
  const t = TERRAIN[terrain].label.toLowerCase();
  if (phase === "Deployment") {
    events.push(`${attacker.name} deploys for battle on the ${t}.`);
    events.push(`${defender.name} arrays its lines to meet them${defender.fortification ? ", behind prepared fortifications" : ""}.`);
    if (weather !== "clear") events.push(`${WEATHER[weather].label} sets in over the field.`);
    if (attacker.overextended) events.push(`${attacker.commander?.name ?? "Attacking command"} is stretched thin - too many regiments for one commander to coordinate cleanly.`);
    if (defender.overextended) events.push(`${defender.commander?.name ?? "Defending command"} is stretched thin - too many regiments for one commander to coordinate cleanly.`);
    return events;
  }
  if (phase === "Skirmishing") {
    events.push(`Archer and skirmisher fire opens the engagement, harassing the leading ranks.`);
    if (atkCas.killed + atkCas.wounded > 0 || defCas.killed + defCas.wounded > 0) {
      events.push(`Skirmishing causes light casualties on both sides.`);
    }
    return events;
  }
  if (atkTactic) events.push(atkTactic);
  if (defTactic) events.push(defTactic);
  events.push(
    atkCas.killed + atkCas.wounded + atkCas.captured >
    defCas.killed + defCas.wounded + defCas.captured
      ? `${defender.name}'s lines hold firmer, inflicting the heavier toll.`
      : `${attacker.name} presses the advantage, inflicting the heavier toll.`
  );
  if (atkFlank) events.push(`${attacker.name}'s cavalry drives around the flank, threatening to encircle.`);
  if (defFlank) events.push(`${defender.name}'s cavalry counters, striking at the exposed flank.`);
  if (atkBreakthrough) events.push(`Breakthrough! ${attacker.name} shatters a section of ${defender.name}'s line.`);
  if (defBreakthrough) events.push(`Breakthrough! ${defender.name} shatters a section of ${attacker.name}'s line.`);
  if (atkJustRouted) events.push(`${attacker.name}'s morale collapses, the army breaking apart under the strain.`);
  else if (attacker.status === "shaken") events.push(`${attacker.name}'s formation begins losing cohesion.`);
  if (defJustRouted) events.push(`${defender.name}'s morale collapses, the army breaking apart under the strain.`);
  else if (defender.status === "shaken") events.push(`${defender.name}'s formation begins losing cohesion.`);
  if (atkCmdEvent) events.push(`${attacker.commander?.name ?? "The attacking commander"} is ${atkCmdEvent} during the fighting.`);
  if (defCmdEvent) events.push(`${defender.commander?.name ?? "The defending commander"} is ${defCmdEvent} during the fighting.`);
  return events;
}

// Turns 1-3 are fixed beats (Deployment, Skirmishing, Initial Engagement).
// Every turn after that is "Main Battle" and repeats for as long as the
// fight needs - there is no scripted schedule of "turn 5 is the flank,
// turn 6 is the collapse". Whether a breakthrough, a morale collapse, or a
// grinding stalemate happens is decided fresh each turn from the actual
// state of both armies and their commanders, not from the turn counter.
function phaseForTurn(n) {
  if (n === 1) return "Deployment";
  if (n === 2) return "Skirmishing";
  if (n === 3) return "Initial Engagement";
  return "Main Battle";
}

// After the fight, surviving regiments gain experience - more from a long,
// hard-fought Main Battle than a battle that ended quickly. Regiments wiped
// out (count 0) gain nothing; they're gone.
function grantExperience(state, mainBattleTurns) {
  const gain = clamp(2 + mainBattleTurns * 0.4, 0, 14);
  for (const r of state.regiments) {
    if (r.count > 0) r.experience = clamp(r.experience + gain, 0, 100);
  }
}

function regimentSummary(regiments) {
  return regiments.map((r) => ({
    id: r.id, name: r.name, unitTypeKey: r.unitTypeKey,
    count: r.count, experience: Math.round(r.experience),
  }));
}

export function simulate(attackerIn, defenderIn, battlefield, options = {}) {
  const unitTypes = options.unitTypes || DEFAULT_UNIT_TYPES;
  const seed = options.seed ?? seedFromString(`${attackerIn.name}-${defenderIn.name}-${Date.now()}`);
  const rng = makeRng(seed);
  const terrain = battlefield.terrain ?? "plains";
  const weather = battlefield.weather ?? "clear";

  const attacker = cloneArmyState(attackerIn);
  const defender = cloneArmyState(defenderIn);
  attacker.terrain = terrain; defender.terrain = terrain;
  defender.fortification = battlefield.fortification ?? 0;

  const turns = [];
  const highlights = [];
  let outcome = null;
  // Safety ceiling only - a real battle almost always resolves via rout or
  // destruction well before this. It exists so an unusually stable, evenly
  // matched fight still terminates instead of looping forever.
  const maxTurns = options.maxTurns ?? 40;

  for (let n = 1; n <= maxTurns; n++) {
    const phase = phaseForTurn(n);

    if (n === 1) {
      // Run a no-op power computation once so overextension is flagged for
      // the deployment narration, without applying any casualties yet.
      computePower(attacker, defender, terrain, weather, "attacker", rng, unitTypes);
      computePower(defender, attacker, terrain, weather, "defender", rng, unitTypes);
      turns.push(snapshotTurn(n, phase, attacker, defender, buildEvents({ attacker, defender, phase, atkCas: {}, defCas: {}, terrain, weather })));
      continue;
    }

    const atkAlive = totalTroops(attacker);
    const defAlive = totalTroops(defender);
    if (atkAlive <= 0 || defAlive <= 0) break;
    if (attacker.status === "routing" || defender.status === "routing") break;

    const skirmish = phase === "Skirmishing";

    // Commanders re-read the field and may shift formation before power is
    // computed for this turn (not during the opening skirmish - that's
    // still archers finding their range, not a tactical crisis yet).
    let atkTactic = null, defTactic = null;
    if (!skirmish) {
      atkTactic = runCommanderTactics(attacker, defender, terrain, "attacker", rng, unitTypes);
      defTactic = runCommanderTactics(defender, attacker, terrain, "defender", rng, unitTypes);
    }

    const atkPower = computePower(attacker, defender, terrain, weather, "attacker", rng, unitTypes);
    const defPower = computePower(defender, attacker, terrain, weather, "defender", rng, unitTypes);

    const scaleFactor = skirmish ? 0.35 : 1.0;

    // Flank rolls (only once past skirmishing). Chance is built from the
    // attempting side's commander flank skill and formation flankBonus,
    // the defending side's formation flankVuln, and foul-weather surprise.
    const atkFlankMods = commanderModifiers(attacker.commander, terrain);
    const defFlankMods = commanderModifiers(defender.commander, terrain);
    const flankChance = (base, mineFormation, theirFormation, mods) => clamp(
      base + mods.flankChance + (FORMATIONS[mineFormation].flankBonus || 0) +
      (FORMATIONS[mineFormation].surpriseBonus || 0) + (FORMATIONS[theirFormation].flankVuln || 0) +
      (WEATHER[weather].surpriseMod || 0),
      0.02, 0.65
    );
    const atkFlank = !skirmish && rng() < flankChance(0.12, attacker.formation, defender.formation, atkFlankMods);
    const defFlank = !skirmish && rng() < flankChance(0.10, defender.formation, attacker.formation, defFlankMods);

    const atkOffense = (atkPower.melee + atkPower.ranged + atkPower.charge * (atkFlank ? 1.6 : 1)) * scaleFactor;
    const defOffense = (defPower.melee + defPower.ranged + defPower.charge * (defFlank ? 1.6 : 1)) * scaleFactor;

    const atkMitigated = atkOffense / Math.max(1, defPower.defense / 40);
    const defMitigated = defOffense / Math.max(1, atkPower.defense / 40);

    const noise = () => 0.85 + rng() * 0.3;
    // Tuned so a roughly even, undefended field battle produces single
    // digit percent casualties per Main Battle turn and a clear outcome
    // (rout or collapse) within roughly 4-8 combat turns. Raise it for
    // bloodier, faster fights; lower it for longer wars of attrition.
    const CASUALTY_COEFFICIENT = 0.34;
    const defCasAmt = atkMitigated * CASUALTY_COEFFICIENT * noise();
    const atkCasAmt = defMitigated * CASUALTY_COEFFICIENT * noise();

    const defBefore = totalTroops(defender);
    const atkBefore = totalTroops(attacker);
    const defCas = applyCasualties(defender, defCasAmt, rng, { chargeWeighted: atkFlank }, unitTypes);
    const atkCas = applyCasualties(attacker, atkCasAmt, rng, { chargeWeighted: defFlank }, unitTypes);

    attacker.fatigue = clamp(attacker.fatigue + 6 + WEATHER[weather].fatigueMod * 10 - commanderModifiers(attacker.commander, terrain).fatigueRate * 10, 0, 100);
    defender.fatigue = clamp(defender.fatigue + 6 + WEATHER[weather].fatigueMod * 10 - commanderModifiers(defender.commander, terrain).fatigueRate * 10, 0, 100);
    attacker.supply = clamp(attacker.supply - (1.2 + commanderModifiers(attacker.commander, terrain).supplyDrain * 5), 0, 100);
    defender.supply = clamp(defender.supply - (1.0 + commanderModifiers(defender.commander, terrain).supplyDrain * 5), 0, 100);

    const atkCasRatio = atkBefore > 0 ? (atkCas.killed + atkCas.wounded + atkCas.captured) / atkBefore : 0;
    const defCasRatio = defBefore > 0 ? (defCas.killed + defCas.wounded + defCas.captured) / defBefore : 0;
    moraleShift(attacker, defender, atkCasRatio, atkCasRatio < defCasRatio, WEATHER[weather].moraleMod);
    moraleShift(defender, attacker, defCasRatio, defCasRatio < atkCasRatio, WEATHER[weather].moraleMod);

    const atkJustRouted = checkRoutStatus(attacker, rng);
    const defJustRouted = checkRoutStatus(defender, rng);

    // A flank that lands alongside a heavy casualty swing reads as a real
    // breakthrough, not just a skirmish on the wing.
    const atkBreakthrough = atkFlank && defCasRatio > 0.08;
    const defBreakthrough = defFlank && atkCasRatio > 0.08;

    const atkCmdEvent = rollCommanderFate(attacker.commander, atkCasRatio > defCasRatio, rng);
    const defCmdEvent = rollCommanderFate(defender.commander, defCasRatio > atkCasRatio, rng);

    const events = buildEvents({ attacker, defender, phase, atkCas, defCas, atkFlank, defFlank, atkBreakthrough, defBreakthrough, atkJustRouted, defJustRouted, atkCmdEvent, defCmdEvent, atkTactic, defTactic, terrain, weather });

    if (atkBreakthrough) highlights.push(`Turn ${n}: ${attacker.name} breaks through on the flank.`);
    if (defBreakthrough) highlights.push(`Turn ${n}: ${defender.name} breaks through on the flank.`);
    if (atkJustRouted) highlights.push(`Turn ${n}: ${attacker.name}'s morale collapses.`);
    if (defJustRouted) highlights.push(`Turn ${n}: ${defender.name}'s morale collapses.`);
    if (atkCmdEvent) highlights.push(`Turn ${n}: ${attacker.commander?.name ?? "Attacking commander"} is ${atkCmdEvent}.`);
    if (defCmdEvent) highlights.push(`Turn ${n}: ${defender.commander?.name ?? "Defending commander"} is ${defCmdEvent}.`);

    turns.push(snapshotTurn(n, phase, attacker, defender, events, {
      casualties: { attacker: atkCas, defender: defCas },
      power: {
        attacker: { melee: Math.round(atkPower.melee), ranged: Math.round(atkPower.ranged), charge: Math.round(atkPower.charge), defense: Math.round(atkPower.defense) },
        defender: { melee: Math.round(defPower.melee), ranged: Math.round(defPower.ranged), charge: Math.round(defPower.charge), defense: Math.round(defPower.defense) },
      },
      flank: { attacker: atkFlank, defender: defFlank },
      breakthrough: { attacker: atkBreakthrough, defender: defBreakthrough },
    }));
  }

  // --- Retreat / Rout resolution -------------------------------------
  let loser = null, winner = null;
  if (attacker.status === "routing" && defender.status === "routing") {
    loser = rng() < 0.5 ? attacker : defender;
    winner = loser === attacker ? defender : attacker;
  } else if (attacker.status === "routing") { loser = attacker; winner = defender; }
  else if (defender.status === "routing") { loser = defender; winner = attacker; }
  else if (totalTroops(attacker) <= 0) { loser = attacker; winner = defender; }
  else if (totalTroops(defender) <= 0) { loser = defender; winner = attacker; }

  if (loser) {
    const retreatEvents = [`${loser.name}'s lines break. Units scatter from the field.`];
    const loserTroops = totalTroops(loser);
    const routedCount = Math.round(loserTroops * (0.35 + rng() * 0.25));
    loser.routed += routedCount;
    Object.keys(loser.units).forEach((key) => {
      const share = loserTroops > 0 ? loser.units[key] / loserTroops : 0;
      distributeLossToRegiments(loser.regiments, key, Math.round(routedCount * share), rng);
    });
    loser.units = aggregateUnits(loser.regiments);
    turns.push(snapshotTurn(turns.length + 1, "Retreat", attacker, defender, retreatEvents));

    // Pursuit: winner's cavalry mass, speed, and commander effect determine
    // extra casualties - faster cavalry runs down a rout harder. Any unit
    // type with category "cavalry" counts here, not just the built-ins, so
    // a custom cavalry-flavored unit participates too.
    const cavEntries = Object.entries(winner.units).filter(([k]) => typeDef(unitTypes, k).category === "cavalry");
    const winnerCav = cavEntries.reduce((s, [, c]) => s + c, 0);
    const winnerCavSpeed = winnerCav > 0
      ? cavEntries.reduce((s, [k, c]) => s + c * typeDef(unitTypes, k).speed, 0) / winnerCav
      : 0;
    const cmdMods = commanderModifiers(winner.commander, terrain);
    if (winnerCav > 0 && winner.status !== "routing") {
      const pursuitPower = winnerCav * (0.15 + cmdMods.cavalryEffect * 0.3) * (0.7 + winnerCavSpeed * 0.3);
      const pursuitCas = applyCasualties(loser, routedCount * clamp(pursuitPower / 100, 0.05, 0.55), rng, {
        killRatio: 0.55, woundRatio: 0.25,
      }, unitTypes);
      const pursuitEvents = [
        `${winner.name}'s cavalry rides down ${loser.name}'s routing formations.`,
        `Pursuit inflicts ${pursuitCas.killed + pursuitCas.wounded + pursuitCas.captured} further losses before the chase is called off.`,
      ];
      turns.push(snapshotTurn(turns.length + 1, "Pursuit", attacker, defender, pursuitEvents));
    }
    outcome = winner === attacker ? "attacker_victory" : "defender_victory";
  } else {
    // Battle ran out the clock without a clear rout - decide on remaining
    // strength and morale.
    const atkScore = totalTroops(attacker) * (attacker.morale / 100);
    const defScore = totalTroops(defender) * (defender.morale / 100);
    if (Math.abs(atkScore - defScore) < Math.max(atkScore, defScore) * 0.08) outcome = "stalemate";
    else outcome = atkScore > defScore ? "attacker_victory" : "defender_victory";
  }

  const mainBattleTurns = turns.filter((t) => t.phase === "Main Battle").length;
  grantExperience(attacker, mainBattleTurns);
  grantExperience(defender, mainBattleTurns);

  return {
    seed,
    outcome,
    terrain, weather,
    turns,
    report: buildReport(attackerIn, defenderIn, attacker, defender, outcome, turns, highlights),
  };
}

function snapshotTurn(n, phase, attacker, defender, events, detail = null) {
  return {
    number: n,
    phase,
    events,
    attacker: sideSnapshot(attacker),
    defender: sideSnapshot(defender),
    casualties: detail?.casualties ?? null,
    power: detail?.power ?? null,
    flank: detail?.flank ?? null,
    breakthrough: detail?.breakthrough ?? null,
  };
}

function sideSnapshot(state) {
  return {
    name: state.name,
    units: { ...state.units },
    regiments: regimentSummary(state.regiments),
    total: totalTroops(state),
    morale: Math.round(state.morale),
    supply: Math.round(state.supply),
    fatigue: Math.round(state.fatigue),
    status: state.status,
    formation: state.formation,
    overextended: !!state.overextended,
    commander: state.commander ? { name: state.commander.name, status: state.commander.status } : null,
  };
}

function buildReport(attackerIn, defenderIn, attacker, defender, outcome, turns, highlights) {
  const initial = (a) => totalRegimentTroops(a.regiments || []);
  const resultLabel = {
    attacker_victory: `${attackerIn.name} Victory`,
    defender_victory: `${defenderIn.name} Victory`,
    stalemate: "Stalemate - both sides withdraw",
  }[outcome];

  const side = (name, initialCount, state) => ({
    name,
    initial: initialCount,
    killed: state.killed,
    wounded: state.wounded,
    captured: state.captured,
    routed: state.routed,
    remaining: totalTroops(state),
    finalMorale: Math.round(state.morale),
    status: state.status,
    commander: state.commander
      ? { name: state.commander.name, status: state.commander.status }
      : null,
    // Post-battle regiments, with casualties applied and experience gained -
    // the UI persists these back onto a saved army so veterancy carries
    // forward into the next fight.
    regiments: regimentSummary(state.regiments),
    canContinueFighting: totalTroops(state) > initialCount * 0.15 && state.morale > 20,
  });

  const timeline = turns.map((t) => ({ turn: t.number, phase: t.phase, events: t.events }));
  const mainBattleTurns = turns.filter((t) => t.phase === "Main Battle").length;

  return {
    result: resultLabel,
    outcome,
    turnsElapsed: turns.length,
    mainBattleTurns,
    highlights,
    attacker: side(attackerIn.name, initial(attackerIn), attacker),
    defender: side(defenderIn.name, initial(defenderIn), defender),
    timeline,
    endedBecause:
      attacker.status === "routing" ? `${attackerIn.name} routed` :
      defender.status === "routing" ? `${defenderIn.name} routed` :
      totalTroops(attacker) <= 0 ? `${attackerIn.name} destroyed` :
      totalTroops(defender) <= 0 ? `${defenderIn.name} destroyed` :
      "Both sides disengaged after sustained losses",
  };
}

export const BattleEngine = { simulate, DEFAULT_UNIT_TYPES, TERRAIN, WEATHER, FORMATIONS, makeRegiment };
export default BattleEngine;

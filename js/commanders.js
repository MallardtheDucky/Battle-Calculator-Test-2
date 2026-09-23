export const TRAIT_LIBRARY = {
  aggressive: {
    name: "Aggressive",
    desc: "Presses attacks hard. Stronger charges and offense, weaker defense, bloodier fights.",
    mods: { offense: 0.15, chargePower: 0.25, defense: -0.10, casualtiesDealt: 0.08, casualtiesTaken: 0.08 },
  },
  defensive_bulwark: {
    name: "Defensive Bulwark",
    desc: "Builds a wall and holds it. Strong defense and cohesion, weaker offense.",
    mods: { defense: 0.20, cohesion: 0.15, offense: -0.10 },
  },
  cavalry_specialist: {
    name: "Cavalry Specialist",
    desc: "Reads the field for the decisive charge. Better cavalry effectiveness and flank maneuvers.",
    mods: { cavalryEffect: 0.25, flankChance: 0.15 },
  },
  inspiring: {
    name: "Inspiring",
    desc: "Troops rally to their voice. Better morale retention, lower rout chance.",
    mods: { moraleRetention: 0.20, routResist: 0.15 },
  },
  logistician: {
    name: "Logistician",
    desc: "Keeps the army fed and marching. Reduced supply and fatigue penalties.",
    mods: { supplyDrain: -0.25, fatigueRate: -0.15 },
  },
  cautious: {
    name: "Cautious",
    desc: "Never commits without a reason. Fewer reckless attacks, much better organized retreats.",
    mods: { retreatOrder: 0.30, recklessness: -0.20, offense: -0.05 },
  },
  brilliant_strategist: {
    name: "Brilliant Strategist",
    desc: "Sees the shape of the battle before it happens. Strong tactics and flanking bonus.",
    mods: { tactics: 0.20, flankChance: 0.20, terrainAdapt: 0.10 },
  },
  craven: {
    name: "Craven",
    desc: "Loses nerve under real pressure. Elevated chance of losing control of the formation when losing.",
    mods: { controlLoss: 0.25, moraleRetention: -0.10 },
  },
  reckless: {
    name: "Reckless",
    desc: "Commits everything, early. Strong opening aggression, risk of overextension later.",
    mods: { offense: 0.10, recklessness: 0.25, cohesion: -0.10 },
  },
  mountaineer: {
    name: "Mountaineer",
    desc: "At home on high, broken ground.", terrain: "hills",
    mods: { terrainBonus: 0.20 },
  },
  forester: {
    name: "Forester",
    desc: "At home in woodland.", terrain: "forest",
    mods: { terrainBonus: 0.20 },
  },
  plainsman: {
    name: "Plainsman",
    desc: "At home on open ground - ideal for cavalry and maneuver.", terrain: "plains",
    mods: { terrainBonus: 0.15, cavalryEffect: 0.10 },
  },
  martial_prodigy: {
    name: "Martial Prodigy",
    desc: "A dangerous fighter in their own right. Boosts morale when personally engaged; higher personal risk.",
    mods: { moraleRetention: 0.10, personalRisk: 0.15, offense: 0.05 },
  },
  siege_master: {
    name: "Siege Master",
    desc: "Knows fortifications inside and out - attacking or defending them.",
    mods: { fortificationEffect: 0.25 },
  },
};

// commandLimit = the number of regiments this commander can lead before
// coordination starts to suffer (see commandOverextension in engine.js).
// It's a small headcount, not a 0-100 stat, so it lives at the top level
// of the commander object rather than inside `stats`.
export function createCommander({ id, name, traitIds = [], stats = {}, experience = 50, commandLimit = 10 }) {
  const defaultStats = {
    martial: 50, leadership: 50, tactics: 50, strategy: 50,
    aggression: 50, caution: 50, cavalryCommand: 50, infantryCommand: 50,
    rangedCommand: 50, defense: 50, offense: 50, logistics: 50,
    moraleLeadership: 50, experience,
  };
  return {
    id: id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    stats: { ...defaultStats, ...stats },
    traits: traitIds.filter((id) => TRAIT_LIBRARY[id]),
    commandLimit: Math.max(1, Math.round(commandLimit)),
    status: "active", // active | wounded | killed | fled
  };
}

export function commanderModifiers(commander, terrain) {
  const mod = {
    offense: 0, defense: 0, chargePower: 0, cavalryEffect: 0, flankChance: 0,
    moraleRetention: 0, routResist: 0, supplyDrain: 0, fatigueRate: 0,
    retreatOrder: 0, recklessness: 0, tactics: 0, terrainAdapt: 0,
    controlLoss: 0, cohesion: 0, personalRisk: 0, fortificationEffect: 0,
    casualtiesDealt: 0, casualtiesTaken: 0,
  };
  if (!commander || commander.status === "killed" || commander.status === "fled") {
    return mod; // leaderless army gets none of these bonuses
  }
  const woundedPenalty = commander.status === "wounded" ? 0.5 : 1;

  for (const id of commander.traits) {
    const t = TRAIT_LIBRARY[id];
    if (!t) continue;
    if (t.terrain && t.terrain !== terrain) continue; // terrain trait not active here
    for (const [k, v] of Object.entries(t.mods)) {
      if (k in mod) mod[k] += v * woundedPenalty;
    }
  }
  const s = commander.stats;
  mod.offense += ((s.offense - 50) / 250) * woundedPenalty;
  mod.defense += ((s.defense - 50) / 250) * woundedPenalty;
  mod.tactics += ((s.tactics - 50) / 200) * woundedPenalty;
  mod.moraleRetention += ((s.moraleLeadership - 50) / 250) * woundedPenalty;
  mod.cavalryEffect += ((s.cavalryCommand - 50) / 300) * woundedPenalty;
  mod.flankChance += ((s.strategy - 50) / 400) * woundedPenalty;
  mod.supplyDrain -= ((s.logistics - 50) / 300) * woundedPenalty;
  return mod;
}

export function rollCommanderFate(commander, sideLosing, rng) {
  if (!commander || commander.status !== "active") return null;
  const risk = commander.traits.includes("martial_prodigy") ? 0.06 : 0.02;
  const base = sideLosing ? risk * 1.8 : risk;
  const roll = rng();
  if (roll < base * 0.15) {
    commander.status = "killed";
    return "killed";
  }
  if (roll < base) {
    commander.status = "wounded";
    return "wounded";
  }
  if (sideLosing && commander.traits.includes("craven") && rng() < 0.12) {
    commander.status = "fled";
    return "fled";
  }
  return null;
}

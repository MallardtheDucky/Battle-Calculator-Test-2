import { simulate, DEFAULT_UNIT_TYPES, TERRAIN, WEATHER, FORMATIONS, makeRegiment } from "./engine.js";
import { createCommander, TRAIT_LIBRARY } from "./commanders.js";
import {
  getRoomId, setRoomId, clearRoomId, readCache,
  readLocalOnly, writeLocalOnly, createRoom, pullRoom, pushRoom,
  SESSION_KEY, resetAllLocalData,
} from "./sync.js";

function escapeAttr(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function slugify(s) { return (s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")) || "unit"; }
function cloneUnitTypes(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = { ...v };
  return out;
}
function hashStringToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Global app state (not the battle engine's internal state - this is just
// what the UI has typed in). unitTypes and presets are the parts that sync
// across devices via a shared room; everything else (the two armies/
// commanders currently being edited, the battlefield setup, which tab is
// open) is saved to this browser's localStorage instead (see saveSession
// below), so a reload comes back to where you left off.
const appState = {
  unitTypes: cloneUnitTypes(DEFAULT_UNIT_TYPES),
  armies: { A: defaultArmy("Army A"), B: defaultArmy("Army B") },
  commanders: { A: createCommander({ name: "Commander A" }), B: createCommander({ name: "Commander B" }) },
  battlefield: { terrain: "plains", weather: "clear", fortification: 0, seed: "" },
  attackerSide: "A",
  result: null,
  turnIndex: 0,
  playTimer: null,
  presets: {},
  roomId: "",
};

function defaultArmy(name) {
  return {
    name,
    regiments: [
      makeRegiment({ unitTypeKey: "infantry", name: "1st Legionary Cohort", count: 3000, experience: 35 }),
      makeRegiment({ unitTypeKey: "archers", name: "Slinger Detachment", count: 800, experience: 30 }),
      makeRegiment({ unitTypeKey: "lightCavalry", name: "Numidian Riders", count: 400, experience: 30 }),
    ],
    quality: 55, morale: 72, supply: 80, formation: "line",
  };
}

// Local session snapshot: which tab is open, both armies/commanders, and
// the battlefield setup. Restored on load so a page refresh doesn't lose
// in-progress work. Saved (debounced) on any input/change/click anywhere
// in the app - see scheduleSessionSave below.
let activeTabId = "armies";

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (!saved) return;
    if (saved.armies) appState.armies = saved.armies;
    if (saved.commanders) appState.commanders = saved.commanders;
    if (saved.battlefield) appState.battlefield = saved.battlefield;
    if (saved.attackerSide) appState.attackerSide = saved.attackerSide;
    if (saved.activeTab) activeTabId = saved.activeTab;
  } catch {
    /* corrupt or unavailable - just start fresh */
  }
}
loadSession();

let sessionSaveTimer = null;
let resetting = false;
function scheduleSessionSave() {
  if (resetting) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        activeTab: activeTabId,
        armies: appState.armies,
        commanders: appState.commanders,
        battlefield: appState.battlefield,
        attackerSide: appState.attackerSide,
      }));
    } catch {}
  }, 400);
}
document.addEventListener("input", scheduleSessionSave);
document.addEventListener("change", scheduleSessionSave);
document.addEventListener("click", scheduleSessionSave);

// Calculator/Debug used to be staff-gated behind a Discord-role passcode;
// that gate has been removed for now - every tab is open.
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

function activateTab(tab) {
  activeTabId = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
}

// Registries of per-side render callbacks, so a sync pull or a unit-type
// edit can refresh just the bits of the DOM that depend on it instead of
// tearing down the whole page.
const presetSelectRefreshers = {};
const commandSummaryUpdaters = {};

function refreshAllPresetSelects() {
  Object.values(presetSelectRefreshers).forEach((fn) => fn && fn());
}
function refreshAllUnitTypeSelects() {
  document.querySelectorAll(".regimentType").forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = Object.entries(appState.unitTypes)
      .map(([key, def]) => `<option value="${key}">${escapeHtml(def.label)}</option>`).join("");
    if (appState.unitTypes[cur]) sel.value = cur;
  });
}
function refreshAllCommandSummaries() {
  Object.values(commandSummaryUpdaters).forEach((fn) => fn && fn());
}

function buildRegimentRow(side, rgt, renderRegiments) {
  const row = document.createElement("div");
  row.className = "regiment-row";
  const typeOptions = Object.entries(appState.unitTypes)
    .map(([key, def]) => `<option value="${key}" ${key === rgt.unitTypeKey ? "selected" : ""}>${escapeHtml(def.label)}</option>`)
    .join("");
  row.innerHTML = `
    <input type="text" class="regimentName" placeholder="Regiment name" value="${escapeAttr(rgt.name)}" />
    <select class="regimentType">${typeOptions}</select>
    <input type="number" class="regimentCount" min="0" step="25" value="${rgt.count}" />
    <span class="regimentExpWrap"><input type="range" class="regimentExp" min="0" max="100" value="${rgt.experience}" /><output>${rgt.experience}</output></span>
    <button type="button" class="removeRegimentBtn" title="Remove regiment">✕</button>
  `;
  row.querySelector(".regimentName").addEventListener("input", (e) => { rgt.name = e.target.value; });
  row.querySelector(".regimentType").addEventListener("change", (e) => { rgt.unitTypeKey = e.target.value; });
  row.querySelector(".regimentCount").addEventListener("input", (e) => {
    rgt.count = Math.max(0, parseInt(e.target.value || "0", 10));
    commandSummaryUpdaters[side]?.();
  });
  const expInput = row.querySelector(".regimentExp");
  const expOut = row.querySelector(".regimentExpWrap output");
  expInput.addEventListener("input", () => {
    rgt.experience = parseInt(expInput.value, 10);
    expOut.textContent = expInput.value;
  });
  row.querySelector(".removeRegimentBtn").addEventListener("click", () => {
    const idx = appState.armies[side].regiments.indexOf(rgt);
    if (idx >= 0) appState.armies[side].regiments.splice(idx, 1);
    renderRegiments();
  });
  return row;
}

function buildArmyForm(side) {
  const tpl = document.getElementById("armyFormTemplate").content.cloneNode(true);
  const root = tpl.querySelector(".army-form");
  root.querySelector(".side-letter").textContent = side;
  const nameInput = root.querySelector(".armyName");
  nameInput.value = appState.armies[side].name;
  nameInput.addEventListener("input", () => (appState.armies[side].name = nameInput.value || `Army ${side}`));

  const regimentsWrap = root.querySelector(".regiment-rows");
  const commandSummaryEl = root.querySelector(".commandSummary");

  function updateCommandSummary() {
    const regiments = appState.armies[side].regiments;
    const activeRegiments = regiments.filter((r) => (r.count || 0) > 0).length;
    const total = regiments.reduce((s, r) => s + Math.max(0, r.count || 0), 0);
    const cmd = appState.commanders[side];
    const limit = cmd?.commandLimit ?? 10;
    const over = activeRegiments > limit;
    commandSummaryEl.innerHTML = `${activeRegiments} regiment${activeRegiments === 1 ? "" : "s"} · ${total.toLocaleString()} troops` +
      (over
        ? ` - <span class="warn">over ${escapeHtml(cmd?.name || "commander")}'s command limit of ${limit}; coordination penalty in battle</span>`
        : ` · within command limit of ${limit}`);
  }
  commandSummaryUpdaters[side] = updateCommandSummary;

  function renderRegiments() {
    regimentsWrap.innerHTML = "";
    appState.armies[side].regiments.forEach((rgt) => {
      regimentsWrap.appendChild(buildRegimentRow(side, rgt, renderRegiments));
    });
    updateCommandSummary();
  }
  renderRegiments();

  root.querySelector(".addRegimentBtn").addEventListener("click", () => {
    const firstType = Object.keys(appState.unitTypes)[0];
    appState.armies[side].regiments.push(makeRegiment({ unitTypeKey: firstType, name: "", count: 0, experience: 30 }));
    renderRegiments();
  });

  ["quality", "morale", "supply"].forEach((field) => {
    const input = root.querySelector(`.${field}`);
    const output = input.nextElementSibling;
    input.value = appState.armies[side][field];
    output.textContent = input.value;
    input.addEventListener("input", () => {
      appState.armies[side][field] = parseInt(input.value, 10);
      output.textContent = input.value;
    });
  });

  const formationSelect = root.querySelector(".formation");
  for (const [key, def] of Object.entries(FORMATIONS)) {
    const opt = document.createElement("option");
    opt.value = key; opt.textContent = def.label;
    formationSelect.appendChild(opt);
  }
  formationSelect.value = appState.armies[side].formation;
  formationSelect.addEventListener("change", () => (appState.armies[side].formation = formationSelect.value));

  // Save/load now talks to the shared roster (appState.presets), which is
  // synced across every device in the room instead of living only in this
  // browser's localStorage.
  const slotInput = root.querySelector(".slotName");
  const loadSelect = root.querySelector(".loadArmySelect");
  function refreshLoadOptions() {
    const cur = loadSelect.value;
    loadSelect.innerHTML = '<option value="">Load from shared roster…</option>';
    Object.keys(appState.presets).sort().forEach((slot) => {
      const opt = document.createElement("option");
      opt.value = slot; opt.textContent = slot;
      loadSelect.appendChild(opt);
    });
    if (appState.presets[cur]) loadSelect.value = cur;
  }
  refreshLoadOptions();
  presetSelectRefreshers[side] = refreshLoadOptions;

  root.querySelector(".saveArmyBtn").addEventListener("click", () => {
    const slot = slotInput.value.trim();
    if (!slot) return;
    appState.presets[slot] = {
      army: JSON.parse(JSON.stringify(appState.armies[side])),
      commander: JSON.parse(JSON.stringify(appState.commanders[side])),
      savedAt: Date.now(),
    };
    queueSync();
    refreshAllPresetSelects();
  });
  root.querySelector(".loadArmyBtn").addEventListener("click", () => {
    const data = appState.presets[loadSelect.value];
    if (!data) return;
    appState.armies[side] = JSON.parse(JSON.stringify(data.army));
    if (data.commander) appState.commanders[side] = JSON.parse(JSON.stringify(data.commander));
    rebuildSideForms(side);
  });
  root.querySelector(".deleteArmyBtn").addEventListener("click", () => {
    const slot = loadSelect.value;
    if (!slot || !appState.presets[slot]) return;
    if (!confirm(`Delete "${slot}" from the shared roster for everyone?`)) return;
    delete appState.presets[slot];
    queueSync();
    refreshAllPresetSelects();
  });

  return root;
}

function rebuildSideForms(side) {
  const armyHost = document.getElementById(`armyForm${side}`);
  armyHost.innerHTML = "";
  armyHost.appendChild(buildArmyForm(side));
  const cmdHost = document.getElementById(`commanderForm${side}`);
  cmdHost.innerHTML = "";
  cmdHost.appendChild(buildCommanderForm(side));
}

document.getElementById("armyFormA").appendChild(buildArmyForm("A"));
document.getElementById("armyFormB").appendChild(buildArmyForm("B"));

const STAT_FIELDS = [
  ["martial", "Martial Skill"], ["leadership", "Leadership"], ["tactics", "Tactical Ability"],
  ["strategy", "Strategic Ability"], ["aggression", "Aggression"], ["caution", "Caution"],
  ["cavalryCommand", "Cavalry Command"], ["infantryCommand", "Infantry Command"],
  ["rangedCommand", "Ranged Command"], ["defense", "Defensive Ability"],
  ["offense", "Offensive Ability"], ["logistics", "Logistics"],
  ["moraleLeadership", "Morale Leadership"], ["experience", "Experience"],
];

function buildCommanderForm(side) {
  const tpl = document.getElementById("commanderFormTemplate").content.cloneNode(true);
  const root = tpl.querySelector(".commander-form");
  root.querySelector(".side-letter").textContent = side;
  const cmd = appState.commanders[side];

  const nameInput = root.querySelector(".cmdName");
  nameInput.value = cmd.name;
  nameInput.addEventListener("input", () => {
    cmd.name = nameInput.value || `Commander ${side}`;
    commandSummaryUpdaters[side]?.();
  });

  const limitInput = root.querySelector(".cmdLimit");
  limitInput.value = cmd.commandLimit;
  limitInput.addEventListener("input", () => {
    cmd.commandLimit = Math.max(1, parseInt(limitInput.value || "1", 10));
    commandSummaryUpdaters[side]?.();
  });

  const statGrid = root.querySelector(".stat-grid");
  STAT_FIELDS.forEach(([key, label]) => {
    const wrap = document.createElement("label");
    wrap.innerHTML = `${label} <input type="range" min="0" max="100" value="${cmd.stats[key]}" data-stat="${key}" />`;
    wrap.querySelector("input").addEventListener("input", (e) => {
      cmd.stats[key] = parseInt(e.target.value, 10);
    });
    statGrid.appendChild(wrap);
  });

  const traitGrid = root.querySelector(".trait-grid");
  Object.entries(TRAIT_LIBRARY).forEach(([id, trait]) => {
    const chip = document.createElement("div");
    chip.className = "trait-chip" + (cmd.traits.includes(id) ? " selected" : "");
    chip.innerHTML = `<span class="trait-name">${trait.name}${trait.terrain ? ` (${trait.terrain})` : ""}</span><span class="trait-desc">${trait.desc}</span>`;
    chip.addEventListener("click", () => {
      const idx = cmd.traits.indexOf(id);
      if (idx >= 0) {
        cmd.traits.splice(idx, 1);
      } else {
        if (cmd.traits.length >= 3) return;
        cmd.traits.push(id);
      }
      chip.classList.toggle("selected");
    });
    traitGrid.appendChild(chip);
  });

  return root;
}

document.getElementById("commanderFormA").appendChild(buildCommanderForm("A"));
document.getElementById("commanderFormB").appendChild(buildCommanderForm("B"));

// Unit Types tab - every stat here is editable, defaults included, and
// custom types can be added/removed. Edits sync to the shared room.
const UNIT_STAT_FIELDS = [
  ["melee", "Melee"], ["ranged", "Ranged"], ["charge", "Charge"], ["defense", "Defense"],
  ["armor", "Armor"], ["speed", "Speed"], ["cavVuln", "Cavalry Vuln."],
  ["pursuitPower", "Pursuit Power"], ["fatigueRate", "Fatigue Rate"],
];
const CATEGORY_OPTIONS = [
  ["infantry", "Infantry"], ["ranged", "Ranged"], ["cavalry", "Cavalry"], ["siege", "Siege"],
];

function buildUnitTypeRow(key) {
  const def = appState.unitTypes[key];
  const row = document.createElement("div");
  row.className = "unittype-row";
  const categoryOptions = CATEGORY_OPTIONS
    .map(([val, label]) => `<option value="${val}" ${def.category === val ? "selected" : ""}>${label}</option>`).join("");
  row.innerHTML = `
    <div class="unittype-head">
      <input type="text" class="utLabel" value="${escapeAttr(def.label)}" />
      <select class="utCategory">${categoryOptions}</select>
      ${def.custom ? `<button type="button" class="deleteUnitTypeBtn">Delete</button>` : `<span class="hint">built-in</span>`}
    </div>
    <div class="unittype-stats"></div>
  `;
  const statsWrap = row.querySelector(".unittype-stats");
  UNIT_STAT_FIELDS.forEach(([field, label]) => {
    const wrap = document.createElement("label");
    wrap.innerHTML = `${label} <input type="number" step="0.05" class="utStat" value="${def[field]}" />`;
    const input = wrap.querySelector("input");
    input.addEventListener("change", () => {
      def[field] = parseFloat(input.value) || 0;
      queueSync();
    });
    statsWrap.appendChild(wrap);
  });
  row.querySelector(".utLabel").addEventListener("change", (e) => {
    def.label = e.target.value.trim() || key;
    queueSync();
    refreshAllUnitTypeSelects();
  });
  row.querySelector(".utCategory").addEventListener("change", (e) => {
    def.category = e.target.value;
    queueSync();
  });
  const delBtn = row.querySelector(".deleteUnitTypeBtn");
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      if (!confirm(`Delete unit type "${def.label}"? Any regiments using it will fall back to a generic levy stat block.`)) return;
      delete appState.unitTypes[key];
      queueSync();
      renderUnitTypesTab();
      refreshAllUnitTypeSelects();
    });
  }
  return row;
}

function renderUnitTypesTab() {
  const wrap = document.getElementById("unitTypesList");
  wrap.innerHTML = "";
  Object.keys(appState.unitTypes).forEach((key) => wrap.appendChild(buildUnitTypeRow(key)));
}
renderUnitTypesTab();

document.getElementById("addUnitTypeBtn").addEventListener("click", () => {
  const name = prompt('Name for the new unit type (e.g. "War Elephants"):');
  if (!name || !name.trim()) return;
  let key = slugify(name);
  let n = 1;
  while (appState.unitTypes[key]) key = `${slugify(name)}_${n++}`;
  appState.unitTypes[key] = {
    label: name.trim(), category: "infantry",
    melee: 1.0, ranged: 0.0, charge: 0.2, defense: 1.0, armor: 0.3, speed: 0.9,
    cavVuln: 1.0, pursuitPower: 0.3, fatigueRate: 1.0, custom: true,
  };
  queueSync();
  renderUnitTypesTab();
  refreshAllUnitTypeSelects();
});

// Shared sync (jsonblob-backed room). See js/sync.js for the storage
// details; this section just wires it into the UI and the status bar.
const syncStatusText = document.getElementById("syncStatusText");
const roomCodeInput = document.getElementById("roomCodeInput");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const createRoomBtn = document.getElementById("createRoomBtn");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");

function setSyncStatus(text, cls) {
  syncStatusText.textContent = text;
  syncStatusText.className = `sync-status ${cls || ""}`;
}

function refreshSyncControls() {
  if (appState.roomId) {
    roomCodeInput.value = appState.roomId;
    roomCodeInput.disabled = true;
    joinRoomBtn.classList.add("hidden");
    createRoomBtn.classList.add("hidden");
    leaveRoomBtn.classList.remove("hidden");
  } else {
    roomCodeInput.value = "";
    roomCodeInput.disabled = false;
    joinRoomBtn.classList.remove("hidden");
    createRoomBtn.classList.remove("hidden");
    leaveRoomBtn.classList.add("hidden");
  }
}

function mergeRoomData(data) {
  if (data.unitTypes && Object.keys(data.unitTypes).length) appState.unitTypes = data.unitTypes;
  if (data.presets) appState.presets = data.presets;
  renderUnitTypesTab();
  refreshAllUnitTypeSelects();
  refreshAllPresetSelects();
  refreshAllCommandSummaries();
}

async function initSync() {
  appState.roomId = getRoomId();
  refreshSyncControls();
  if (appState.roomId) {
    setSyncStatus("Connecting to shared roster…", "loading");
    try {
      const data = await pullRoom(appState.roomId);
      mergeRoomData(data);
      setSyncStatus(`Synced to room ${appState.roomId}.`, "synced");
    } catch (err) {
      const cached = readCache(appState.roomId);
      if (cached) {
        mergeRoomData(cached);
        setSyncStatus(`Offline - showing the last-synced copy of room ${appState.roomId}.`, "error");
      } else {
        setSyncStatus(`Could not reach the shared room (${err.message}). Working locally for now.`, "error");
      }
    }
  } else {
    const local = readLocalOnly();
    if (local) mergeRoomData(local);
    setSyncStatus("Local only - create or join a room to share your roster across devices.", "local");
  }
}

let syncTimer = null;
function queueSync() {
  if (appState.roomId) setSyncStatus("Saving to shared roster…", "loading");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const payload = { unitTypes: appState.unitTypes, presets: appState.presets };
    if (appState.roomId) {
      try {
        await pushRoom(appState.roomId, payload);
        setSyncStatus(`Synced to room ${appState.roomId}.`, "synced");
      } catch (err) {
        setSyncStatus(`Could not save to the shared room (${err.message}). Retrying on your next change.`, "error");
      }
    } else {
      writeLocalOnly(payload);
    }
  }, 700);
}

joinRoomBtn.addEventListener("click", async () => {
  const id = roomCodeInput.value.trim();
  if (!id) return;
  setRoomId(id);
  await initSync();
});
roomCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoomBtn.click(); });

createRoomBtn.addEventListener("click", async () => {
  setSyncStatus("Creating a new shared room…", "loading");
  try {
    const payload = { unitTypes: appState.unitTypes, presets: appState.presets };
    const id = await createRoom(payload);
    appState.roomId = id;
    refreshSyncControls();
    setSyncStatus(`Shared room created: ${id} - give this code to your players so everyone stays in sync.`, "synced");
  } catch (err) {
    setSyncStatus(`Could not create a shared room (${err.message}).`, "error");
  }
});

leaveRoomBtn.addEventListener("click", () => {
  clearRoomId();
  appState.roomId = "";
  refreshSyncControls();
  setSyncStatus("Local only - create or join a room to share your roster across devices.", "local");
});

initSync();

const terrainSelect = document.getElementById("terrainSelect");
Object.entries(TERRAIN).forEach(([key, def]) => {
  const opt = document.createElement("option"); opt.value = key; opt.textContent = def.label;
  terrainSelect.appendChild(opt);
});
terrainSelect.value = appState.battlefield.terrain;
terrainSelect.addEventListener("change", () => (appState.battlefield.terrain = terrainSelect.value));

const weatherSelect = document.getElementById("weatherSelect");
Object.entries(WEATHER).forEach(([key, def]) => {
  const opt = document.createElement("option"); opt.value = key; opt.textContent = def.label;
  weatherSelect.appendChild(opt);
});
weatherSelect.value = appState.battlefield.weather;
weatherSelect.addEventListener("change", () => (appState.battlefield.weather = weatherSelect.value));

document.getElementById("attackerSideSelect").addEventListener("change", (e) => {
  appState.attackerSide = e.target.value;
});

const fortRange = document.getElementById("fortificationRange");
fortRange.addEventListener("input", () => {
  appState.battlefield.fortification = parseInt(fortRange.value, 10);
  document.getElementById("fortificationOut").textContent = fortRange.value;
});

document.getElementById("seedInput").addEventListener("input", (e) => {
  appState.battlefield.seed = e.target.value;
});

document.getElementById("goToBattleBtn").addEventListener("click", () => activateTab("battle"));

// Battle playback (text-only: turn header, per-side stat/regiment blocks,
// and a narrated event log - no animated battlefield graphics)
const startBtn = document.getElementById("startBattleBtn");
const nextBtn = document.getElementById("nextTurnBtn");
const playBtn = document.getElementById("playBtn");
const simAllBtn = document.getElementById("simulateAllBtn");
const resetBtn = document.getElementById("resetBattleBtn");
const turnHeader = document.getElementById("turnHeader");
const sideStatsEl = document.getElementById("sideStats");
const eventLogEl = document.getElementById("eventLog");
const reportEl = document.getElementById("battleReport");

function armiesForBattle() {
  const attackerKey = appState.attackerSide;
  const defenderKey = attackerKey === "A" ? "B" : "A";
  const attacker = { ...appState.armies[attackerKey], commander: appState.commanders[attackerKey] };
  const defender = { ...appState.armies[defenderKey], commander: appState.commanders[defenderKey] };
  return { attacker, defender };
}

startBtn.addEventListener("click", () => {
  const { attacker, defender } = armiesForBattle();
  const seed = appState.battlefield.seed?.trim()
    ? hashStringToInt(appState.battlefield.seed.trim())
    : undefined;
  appState.result = simulate(attacker, defender, appState.battlefield, { seed, unitTypes: appState.unitTypes });
  appState.turnIndex = 0;
  reportEl.classList.add("hidden");
  eventLogEl.innerHTML = "";
  nextBtn.disabled = false; playBtn.disabled = false; simAllBtn.disabled = false; resetBtn.disabled = false;
  startBtn.disabled = true;
  showTurn(0);
  renderCalculator();
  renderDebug();
});

function showTurn(i) {
  const turn = appState.result.turns[i];
  if (!turn) return;
  turnHeader.textContent = `Turn ${turn.number} · ${turn.phase.toUpperCase()}`;
  sideStatsEl.innerHTML = [turn.attacker, turn.defender].map(sideBlock).join("");
  turn.events.forEach((ev) => {
    const div = document.createElement("div");
    div.textContent = `• ${ev}`;
    eventLogEl.prepend(div);
  });
  if (i >= appState.result.turns.length - 1) {
    showReport();
    stopAutoPlay();
    nextBtn.disabled = true; playBtn.disabled = true;
  }
}

const STANCE_LABELS = { line: "Line", aggressive: "Aggressive", defensive: "Defensive", flanking: "Flanking", ambush: "Ambush" };

function sideBlock(side) {
  const regimentLines = (side.regiments || [])
    .filter((r) => r.count > 0)
    .map((r) => {
      const typeLabel = appState.unitTypes[r.unitTypeKey]?.label || r.unitTypeKey;
      const name = r.name || typeLabel;
      return `<div class="regiment-line"><span>${escapeHtml(name)}</span><span>${escapeHtml(typeLabel)} · ${r.count.toLocaleString()} · vet ${r.experience}%</span></div>`;
    })
    .join("") || `<div class="regiment-line hint">No regiments remain.</div>`;
  return `<div class="side-stat-block">
    <h4>${escapeHtml(side.name)}${side.overextended ? ` <span class="warn">(overextended)</span>` : ""}</h4>
    <div>Troops: ${side.total.toLocaleString()}</div>
    <div>Morale: ${side.morale}% · Fatigue: ${side.fatigue}% · Supply: ${side.supply}%</div>
    <div class="status-${side.status}">${side.status} · stance: ${STANCE_LABELS[side.formation] ?? side.formation}</div>
    ${side.commander ? `<div>Cmdr ${escapeHtml(side.commander.name)}: ${side.commander.status}</div>` : ""}
    <div class="regiment-list">${regimentLines}</div>
  </div>`;
}

nextBtn.addEventListener("click", () => {
  appState.turnIndex = Math.min(appState.turnIndex + 1, appState.result.turns.length - 1);
  showTurn(appState.turnIndex);
});

playBtn.addEventListener("click", () => {
  if (appState.playTimer) { stopAutoPlay(); return; }
  playBtn.textContent = "Pause";
  appState.playTimer = setInterval(() => {
    if (appState.turnIndex >= appState.result.turns.length - 1) { stopAutoPlay(); return; }
    appState.turnIndex++;
    showTurn(appState.turnIndex);
  }, 1600);
});

function stopAutoPlay() {
  clearInterval(appState.playTimer);
  appState.playTimer = null;
  playBtn.textContent = "Auto-Play";
}

simAllBtn.addEventListener("click", () => {
  stopAutoPlay();
  appState.turnIndex = appState.result.turns.length - 1;
  showTurn(appState.turnIndex);
});

resetBtn.addEventListener("click", () => {
  stopAutoPlay();
  appState.result = null;
  turnHeader.textContent = "";
  sideStatsEl.innerHTML = "";
  eventLogEl.innerHTML = "";
  reportEl.classList.add("hidden");
  nextBtn.disabled = true; playBtn.disabled = true; simAllBtn.disabled = true; resetBtn.disabled = true;
  startBtn.disabled = false;
});

function showReport() {
  const r = appState.result.report;
  reportEl.classList.remove("hidden");
  reportEl.innerHTML = `
    <h3>${r.result}</h3>
    <p class="hint">${r.turnsElapsed} turns (${r.mainBattleTurns} of them Main Battle) · ended because: ${r.endedBecause}</p>
    <div class="report-grid">
      ${[r.attacker, r.defender].map(reportSide).join("")}
    </div>
    <p class="hint">Applying results updates that side's regiments here with battle losses and the veterancy they earned. Save the army to the shared roster afterward to keep it for next time.</p>
    <div class="battle-controls">
      <button id="applyResultsA">Apply results to Army A</button>
      <button id="applyResultsB">Apply results to Army B</button>
    </div>
    ${r.highlights.length ? `<h3>Highlights</h3><div class="mono-block">${r.highlights.map((h) => "  • " + h).join("\n")}</div>` : ""}
    <h3>Timeline</h3>
    <div class="mono-block">${r.timeline.map((t) => `Turn ${t.turn} · ${t.phase}\n${t.events.map((e) => "  • " + e).join("\n")}`).join("\n\n")}</div>
  `;
  document.getElementById("applyResultsA").addEventListener("click", (e) => applyResultsTo("A", e.target));
  document.getElementById("applyResultsB").addEventListener("click", (e) => applyResultsTo("B", e.target));
}

function applyResultsTo(side, btn) {
  const attackerKey = appState.attackerSide;
  const defenderKey = attackerKey === "A" ? "B" : "A";
  const sideReport = side === attackerKey ? appState.result.report.attacker : appState.result.report.defender;
  appState.armies[side].regiments = sideReport.regiments.map((r) => ({
    id: r.id, name: r.name, unitTypeKey: r.unitTypeKey, count: r.count, experience: r.experience,
  }));
  rebuildSideForms(side);
  if (btn) { btn.textContent = "Applied ✓"; btn.disabled = true; }
}

function reportSide(s) {
  return `<div class="report-side">
    <h4>${escapeHtml(s.name)}</h4>
    <dl>
      <dt>Initial</dt><dd>${s.initial.toLocaleString()}</dd>
      <dt>Killed</dt><dd>${s.killed.toLocaleString()}</dd>
      <dt>Wounded</dt><dd>${s.wounded.toLocaleString()}</dd>
      <dt>Captured</dt><dd>${s.captured.toLocaleString()}</dd>
      <dt>Routed</dt><dd>${s.routed.toLocaleString()}</dd>
      <dt>Remaining</dt><dd>${s.remaining.toLocaleString()}</dd>
      <dt>Final morale</dt><dd>${s.finalMorale}%</dd>
      <dt>Commander</dt><dd>${s.commander ? `${escapeHtml(s.commander.name)} (${s.commander.status})` : "-"}</dd>
      <dt>Can keep fighting?</dt><dd>${s.canContinueFighting ? "Yes" : "No"}</dd>
    </dl>
  </div>`;
}

// Calculator mode - raw numeric breakdown per turn: troop state, this-turn
// casualties by kind, melee/ranged/charge/defense power, and flank/
// breakthrough rolls, so a fight can be adjudicated by hand.
function casLine(cas) {
  if (!cas) return "n/a";
  return `killed=${cas.killed} wounded=${cas.wounded} captured=${cas.captured}`;
}

function powerLine(p) {
  if (!p) return "n/a";
  return `melee=${p.melee} ranged=${p.ranged} charge=${p.charge} defense=${p.defense}`;
}

function renderCalculator() {
  const out = document.getElementById("calculatorOutput");
  if (!appState.result) { out.textContent = "Run a battle first."; return; }
  out.textContent = appState.result.turns.map((t) => {
    const lines = [`TURN ${t.number} (${t.phase})`];
    lines.push(`  ${t.attacker.name}: troops=${t.attacker.total} morale=${t.attacker.morale} fatigue=${t.attacker.fatigue} supply=${t.attacker.supply} status=${t.attacker.status} formation=${t.attacker.formation}${t.attacker.overextended ? " OVEREXTENDED" : ""}`);
    lines.push(`  ${t.defender.name}: troops=${t.defender.total} morale=${t.defender.morale} fatigue=${t.defender.fatigue} supply=${t.defender.supply} status=${t.defender.status} formation=${t.defender.formation}${t.defender.overextended ? " OVEREXTENDED" : ""}`);
    if (t.power) {
      lines.push(`  ${t.attacker.name} power: ${powerLine(t.power.attacker)}`);
      lines.push(`  ${t.defender.name} power: ${powerLine(t.power.defender)}`);
    }
    if (t.casualties) {
      lines.push(`  ${t.attacker.name} casualties this turn: ${casLine(t.casualties.attacker)}`);
      lines.push(`  ${t.defender.name} casualties this turn: ${casLine(t.casualties.defender)}`);
    }
    if (t.flank) {
      lines.push(`  Flank attempts: ${t.attacker.name}=${t.flank.attacker} ${t.defender.name}=${t.flank.defender}`);
    }
    if (t.breakthrough && (t.breakthrough.attacker || t.breakthrough.defender)) {
      lines.push(`  Breakthrough: ${t.attacker.name}=${t.breakthrough.attacker} ${t.defender.name}=${t.breakthrough.defender}`);
    }
    return lines.join("\n");
  }).join("\n\n") + `\n\nSeed: ${appState.result.seed}\nOutcome: ${appState.result.outcome}\nMain Battle turns: ${appState.result.report.mainBattleTurns}`;
}

// Debug mode - full raw JSON + Discord export
function renderDebug() {
  const out = document.getElementById("debugOutput");
  out.textContent = appState.result ? JSON.stringify(appState.result, null, 2) : "No battle run yet.";
}

document.getElementById("copyDebugBtn").addEventListener("click", () => {
  if (!appState.result) return;
  navigator.clipboard?.writeText(JSON.stringify(appState.result, null, 2));
});

document.getElementById("copyDiscordBtn").addEventListener("click", () => {
  if (!appState.result) return;
  const r = appState.result.report;
  const text =
    `**${r.result}**\n` +
    `*${r.turnsElapsed} turns - ${r.endedBecause}*\n\n` +
    `**${r.attacker.name}**\n` +
    `Initial: ${r.attacker.initial} | Killed: ${r.attacker.killed} | Wounded: ${r.attacker.wounded} | Captured: ${r.attacker.captured} | Routed: ${r.attacker.routed} | Remaining: ${r.attacker.remaining}\n\n` +
    `**${r.defender.name}**\n` +
    `Initial: ${r.defender.initial} | Killed: ${r.defender.killed} | Wounded: ${r.defender.wounded} | Captured: ${r.defender.captured} | Routed: ${r.defender.routed} | Remaining: ${r.defender.remaining}\n`;
  navigator.clipboard?.writeText(text);
});

// Reset Everything: wipes all local storage this app uses and reloads, so
// the person comes back to a completely clean slate (fresh armies/
// commanders/battlefield, no room joined, no cached roster). Does not
// touch the shared room's copy on jsonblob.com - other players stay synced.
document.getElementById("resetEverythingBtn").addEventListener("click", () => {
  const ok = confirm(
    "Reset everything?\n\nThis clears both armies, both commanders, the battlefield setup, and leaves your shared room on this device. It does not delete the shared roster from other players' devices. This cannot be undone."
  );
  if (!ok) return;
  resetting = true;
  clearTimeout(sessionSaveTimer);
  clearRoomId();
  resetAllLocalData();
  location.reload();
});

// Restore whichever tab was open before the last reload.
activateTab(activeTabId);

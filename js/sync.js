// Shared, cross-device storage for the unit-type registry and saved army
// presets. Everyone who enters the same Room Code reads and writes the
// same document, so adding a unit type or saving an army on one PC shows
// up for everyone else in the Discord server on theirs.
//
// Backend: jsonblob.com - a free, no-signup, CORS-enabled JSON document
// store. It's a fine fit for a small RP-server roster (nobody needs an
// account, "Room Code" *is* the document ID), but it's a hosted third
// party with no uptime guarantee and no real conflict resolution beyond
// last-write-wins. If you outgrow it, swap the four functions below
// (createRoom/pullRoom/pushRoom/BLOB_BASE) for Firebase, Supabase, or a
// small Worker - nothing else in the app needs to change.
//
// Every write also updates a localStorage cache keyed by room ID, so the
// app still has last-known data if the network call fails, and still
// functions (in local-only mode) if no room has been set up yet.

const BLOB_BASE = "https://jsonblob.com/api/jsonBlob";
const ROOM_KEY = "foa_room_id_v1";
const CACHE_PREFIX = "foa_cache_v1_";
const LOCAL_ONLY_KEY = "foa_local_only_v1";

export function getRoomId() {
  return (localStorage.getItem(ROOM_KEY) || "").trim();
}

export function setRoomId(id) {
  localStorage.setItem(ROOM_KEY, (id || "").trim());
}

export function clearRoomId() {
  localStorage.removeItem(ROOM_KEY);
}

function cacheKey(roomId) {
  return CACHE_PREFIX + roomId;
}

export function readCache(roomId) {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(roomId)) || "null");
  } catch {
    return null;
  }
}

function writeCache(roomId, data) {
  try {
    localStorage.setItem(cacheKey(roomId), JSON.stringify(data));
  } catch {
    /* storage full or unavailable - not fatal, cloud copy still holds */
  }
}

// --- Local-only fallback (no room configured yet) ----------------------
export function readLocalOnly() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_ONLY_KEY) || "null");
  } catch {
    return null;
  }
}
export function writeLocalOnly(data) {
  try {
    localStorage.setItem(LOCAL_ONLY_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function emptyRoomData() {
  return { unitTypes: {}, presets: {}, updatedAt: 0 };
}

// Creates a brand-new shared document, seeded with `initialData`, and
// remembers its ID as the active room. Returns the new room ID.
export async function createRoom(initialData) {
  const res = await fetch(BLOB_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(initialData),
  });
  if (!res.ok) throw new Error(`Could not create a shared room (server said ${res.status})`);
  const loc = res.headers.get("Location") || res.headers.get("location");
  const id = loc ? loc.split("/").filter(Boolean).pop() : null;
  if (!id) throw new Error("Shared room was created but no room ID came back");
  setRoomId(id);
  writeCache(id, initialData);
  return id;
}

export async function pullRoom(roomId) {
  const res = await fetch(`${BLOB_BASE}/${encodeURIComponent(roomId)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Sync fetch failed (server said ${res.status}) - check the room code`);
  const data = await res.json();
  writeCache(roomId, data);
  return data;
}

export async function pushRoom(roomId, data) {
  const payload = { ...data, updatedAt: Date.now() };
  const res = await fetch(`${BLOB_BASE}/${encodeURIComponent(roomId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Sync push failed (server said ${res.status})`);
  writeCache(roomId, payload);
  return payload;
}

export function exportJSON(data) {
  return JSON.stringify(data, null, 2);
}

export function importJSON(text) {
  return JSON.parse(text);
}

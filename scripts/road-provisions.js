const MODULE_ID = "road-provisions";
const SETTING_DATA = "trackerData";
const SETTING_LAST_DAY = "lastProcessedDay";
const SETTING_FOOD_NAMES = "foodItemNames";
const SETTING_WATER_NAMES = "waterItemNames";
const WWN_SYSTEM_ID = "wwn";
const EPSILON = 1e-8;
const DEFAULT_FOOD_NAMES = "Rations, 1 week; Rations; Ration";
const DEFAULT_WATER_NAMES = "Waterskin, 1 gallon; Water; Waterskin; Water Skin";

const DEFAULT_DATA = {
  mode: "travel",
  defaults: {
    foodPerDay: 1,
    waterPerDay: 1,
    waterMultiplier: 1,
    moneyPerDay: 0,
    currencyDenomination: "sp"
  },
  members: []
};

function clone(value) {
  return foundry.utils.deepClone(value);
}

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampMin(value, minimum = 0) {
  return Math.max(minimum, num(value, minimum));
}

function roundFraction(value) {
  return Math.round(clampMin(value) * 1_000_000) / 1_000_000;
}

function isWWN() {
  return game.system?.id === WWN_SYSTEM_ID;
}

function dayOrdinal(worldTime = game.time.worldTime) {
  const c = game.time.calendar.timeToComponents(worldTime);
  try {
    const sinceEpoch = game.time.calendar.difference(worldTime, 0);
    return game.time.calendar.componentsToUnit(sinceEpoch, "day", { roundFn: "floor" });
  } catch (_err) {
    return `${c.year}:${c.day}`;
  }
}

function dayLabel(worldTime = game.time.worldTime) {
  const c = game.time.calendar.timeToComponents(worldTime);
  const months = game.time.calendar?.months?.values ?? [];
  const month = months[c.month];
  const monthName = month?.name || month?.abbreviation || `Month ${c.month + 1}`;
  const dayOfMonth = c.dayOfMonth + 1;
  const hh = String(c.hour ?? 0).padStart(2, "0");
  const mm = String(c.minute ?? 0).padStart(2, "0");
  return `${monthName} ${dayOfMonth}, Year ${c.year} ${hh}:${mm}`;
}

function dayKey(worldTime = game.time.worldTime) {
  const c = game.time.calendar.timeToComponents(worldTime);
  return `${c.year}:${c.day}`;
}

async function getData() {
  const stored = game.settings.get(MODULE_ID, SETTING_DATA) || {};
  const merged = foundry.utils.mergeObject(clone(DEFAULT_DATA), stored, { inplace: false, recursive: true });

  delete merged.defaults.quantityPath;
  delete merged.defaults.currencyPath;

  // Global item aliases live in Foundry's module settings rather than the
  // tracker window. They are copied into runtime defaults for the matcher only.
  merged.defaults.foodNames = String(game.settings.get(MODULE_ID, SETTING_FOOD_NAMES) || DEFAULT_FOOD_NAMES);
  merged.defaults.waterNames = String(game.settings.get(MODULE_ID, SETTING_WATER_NAMES) || DEFAULT_WATER_NAMES);

  merged.defaults.foodPerDay = clampMin(merged.defaults.foodPerDay, 0);
  merged.defaults.waterPerDay = clampMin(merged.defaults.waterPerDay, 0);
  merged.defaults.waterMultiplier = clampMin(merged.defaults.waterMultiplier ?? 1, 0);
  merged.defaults.moneyPerDay = clampMin(merged.defaults.moneyPerDay, 0);
  merged.defaults.currencyDenomination = merged.defaults.currencyDenomination === "gp" ? "gp" : "sp";

  for (const member of merged.members ?? []) {
    delete member.quantityPath;
    delete member.currencyPath;
    member.enabled = member.enabled !== false;
    member.foodPerDay = clampMin(member.foodPerDay ?? merged.defaults.foodPerDay, 0);
    member.waterPerDay = clampMin(member.waterPerDay ?? merged.defaults.waterPerDay, 0);
    member.moneyPerDay = clampMin(member.moneyPerDay ?? merged.defaults.moneyPerDay, 0);
    member.foodRemainder = roundFraction(member.foodRemainder ?? 0);
    member.waterRemainder = roundFraction(member.waterRemainder ?? 0);
    member.foodItemName ??= "";
    member.waterItemName ??= "";
    if (!Array.isArray(member.carrierUuids)) {
      member.carrierUuids = member.carrierUuid ? [member.carrierUuid] : [];
    }
    member.carrierUuids = [...new Set(member.carrierUuids.map((u) => String(u || "").trim()).filter(Boolean))];
    delete member.carrierUuid;
  }

  return merged;
}

async function setData(data) {
  const stored = clone(data);
  // These are runtime copies sourced from normal Foundry module settings.
  delete stored.defaults?.foodNames;
  delete stored.defaults?.waterNames;
  for (const member of stored.members ?? []) delete member.carrierUuid;
  return game.settings.set(MODULE_ID, SETTING_DATA, stored);
}

async function resolveUuidActor(uuid) {
  if (!uuid) return null;
  let doc = null;
  try {
    doc = await foundry.utils.fromUuid(uuid);
  } catch (_err) {
    return null;
  }
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  if (doc.actor) return doc.actor;
  return null;
}

async function resolveActor(member) {
  return resolveUuidActor(member?.uuid);
}

function parseAliases(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  // Commas are part of canonical WWN item names (for example
  // "Rations, 1 week"), so only semicolons/newlines separate aliases.
  return raw
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeItemName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function itemMatchScore(itemName, aliases) {
  const normalized = normalizeItemName(itemName);
  let best = Number.POSITIVE_INFINITY;

  for (const alias of aliases) {
    const a = normalizeItemName(alias);
    if (!a) continue;
    if (normalized === a) best = Math.min(best, 0);
    else if (normalized.startsWith(`${a} `)) best = Math.min(best, 1);
    else if (` ${normalized} `.includes(` ${a} `)) best = Math.min(best, 2);
  }

  return best;
}

function getAliases(member, kind, defaults) {
  const nameKey = kind === "food" ? "foodItemName" : "waterItemName";
  const explicit = String(member?.[nameKey] || "").trim();
  if (explicit) return parseAliases(explicit);
  return parseAliases(kind === "food" ? defaults.foodNames : defaults.waterNames);
}

function findMatchingItems(actor, member, kind, defaults) {
  if (!actor) return [];
  const idKey = kind === "food" ? "foodItemId" : "waterItemId";
  if (member?.[idKey]) {
    const byId = actor.items.get(member[idKey]);
    if (byId) return [byId];
  }

  const aliases = getAliases(member, kind, defaults);
  return actor.items
    .map((item) => ({ item, score: itemMatchScore(item.name, aliases) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name))
    .map(({ item }) => item);
}

function hasNumericPath(document, path) {
  if (!foundry.utils.hasProperty(document, path)) return false;
  const value = foundry.utils.getProperty(document, path);
  return Number.isFinite(Number(value));
}

function firstNumericPath(document, paths) {
  for (const path of paths) {
    if (hasNumericPath(document, path)) {
      return { path, value: num(foundry.utils.getProperty(document, path)) };
    }
  }
  return null;
}

/**
 * Detect the WWN consumable stock field.
 *
 * WWN 2.x uses an unusual charged-item shape for gear such as rations: the
 * sheet presents a capacity and an amount already expended. In observed worlds
 * that is `system.charges.value` (capacity) plus `system.charges.current`
 * (expended). Road Provisions converts that to an internal "remaining units"
 * value so food and water can share the same allocator.
 *
 * Other charge/uses shapes are still supported as conventional remaining-charge
 * counters, followed by quantity as a compatibility fallback.
 */
function getConsumableAccessor(item) {
  const wwnCapacity = firstNumericPath(item, [
    "system.charges.value",
    "system.charges.max",
    "system.charges.maximum",
    "system.maxCharges",
    "system.chargesMax"
  ]);
  const wwnExpended = firstNumericPath(item, [
    "system.charges.current",
    "system.charges.current.value",
    "system.charges.used",
    "system.charges.expended",
    "system.charges.spent"
  ]);

  // Native WWN charged-item semantics: capacity / expended.
  if (wwnCapacity && wwnExpended && wwnCapacity.path !== wwnExpended.path) {
    const capacity = clampMin(wwnCapacity.value, 0);
    const expended = Math.min(capacity, clampMin(wwnExpended.value, 0));
    return {
      path: wwnExpended.path,
      value: Math.max(0, capacity - expended),
      unit: "charges",
      maxPath: wwnCapacity.path,
      max: capacity,
      chargeMode: "expended",
      storedValue: expended
    };
  }

  const current = firstNumericPath(item, [
    "system.charges.remaining",
    "system.uses.value",
    "system.uses.current",
    "system.uses.current.value",
    "system.charge.value",
    "system.charge.current",
    "system.charges.value",
    "system.charges"
  ]);

  if (current) {
    const maximum = firstNumericPath(item, [
      "system.charges.max",
      "system.charges.maximum",
      "system.charges.max.value",
      "system.uses.max",
      "system.uses.maximum",
      "system.charge.max",
      "system.charge.maximum",
      "system.maxCharges",
      "system.chargesMax"
    ]);
    return {
      path: current.path,
      value: current.value,
      unit: "charges",
      maxPath: maximum?.path ?? null,
      max: maximum?.value ?? null,
      chargeMode: "remaining",
      storedValue: current.value
    };
  }

  const quantity = firstNumericPath(item, ["system.quantity.value", "system.quantity"]);
  if (quantity) {
    return {
      path: quantity.path,
      value: quantity.value,
      unit: "quantity",
      maxPath: null,
      max: null,
      chargeMode: null,
      storedValue: quantity.value
    };
  }

  return null;
}

async function setConsumableAmount(item, accessor, amount) {
  if (!accessor?.path) throw new Error(`No WWN consumable field detected on ${item.name}`);
  const remaining = Math.max(0, amount);

  if (accessor.unit === "charges" && accessor.chargeMode === "expended") {
    const capacity = clampMin(accessor.max, 0);
    const expended = Math.max(0, capacity - Math.min(capacity, remaining));
    await item.update({ [accessor.path]: expended });
    return;
  }

  await item.update({ [accessor.path]: remaining });
}

function normalizeKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numericLeafAccessor(document, path) {
  if (!foundry.utils.hasProperty(document, path)) return null;
  const value = foundry.utils.getProperty(document, path);
  if (Number.isFinite(Number(value))) return { path, value: num(value) };
  if (value && typeof value === "object") {
    for (const leaf of ["value", "current", "amount"]) {
      const leafPath = `${path}.${leaf}`;
      if (hasNumericPath(document, leafPath)) {
        return { path: leafPath, value: num(foundry.utils.getProperty(document, leafPath)) };
      }
    }
  }
  return null;
}

function collectNumericLeaves(value, prefix = "system", depth = 0, out = []) {
  if (depth > 7 || value == null) return out;
  if (Number.isFinite(Number(value)) && typeof value !== "object") {
    out.push({ path: prefix, value: num(value) });
    return out;
  }
  if (typeof value !== "object" || Array.isArray(value)) return out;

  for (const [key, child] of Object.entries(value)) {
    collectNumericLeaves(child, `${prefix}.${key}`, depth + 1, out);
  }
  return out;
}

function currencyPathScore(path, denomination) {
  const lower = path.toLowerCase();
  const parts = lower.split(".").map(normalizeKey);
  const denomTokens = denomination === "gp" ? new Set(["gp", "gold", "goldpiece", "goldpieces"]) : new Set(["sp", "silver", "silverpiece", "silverpieces"]);

  if (parts.some((p) => ["bank", "banked", "total", "treasure", "treasurevalue"].includes(p))) return -1000;

  let score = 0;
  const last = parts.at(-1);
  const parent = parts.at(-2);
  if (denomTokens.has(last)) score += 100;
  if (denomTokens.has(parent) && ["value", "current", "amount"].includes(last)) score += 95;
  if (parts.some((p) => denomTokens.has(p))) score += 25;
  if (parts.some((p) => ["currency", "currencies", "coin", "coins"].includes(p))) score += 30;
  if (parts.some((p) => ["carried", "inventory", "purse"].includes(p))) score += 10;
  return score;
}

/** Detect WWN carried coin without requiring a user-entered data path. */
function getCurrencyAccessor(actor, denomination = "sp") {
  const denom = denomination === "gp" ? "gp" : "sp";
  const desired = denom === "gp"
    ? new Set(["gp", "gold", "goldpiece", "goldpieces"])
    : new Set(["sp", "silver", "silverpiece", "silverpieces"]);

  for (const root of ["system.currency", "system.currencies", "system.coins", "system.wealth.currency", "system.wealth.coins"]) {
    const obj = foundry.utils.getProperty(actor, root);
    if (!obj || typeof obj !== "object") continue;
    for (const key of Object.keys(obj)) {
      if (!desired.has(normalizeKey(key))) continue;
      const accessor = numericLeafAccessor(actor, `${root}.${key}`);
      if (accessor) return accessor;
    }
  }

  const directCandidates = denom === "gp"
    ? ["system.currency.gp", "system.currencies.gp", "system.coins.gp", "system.gp", "system.gold"]
    : ["system.currency.sp", "system.currencies.sp", "system.coins.sp", "system.sp", "system.silver"];
  for (const path of directCandidates) {
    const accessor = numericLeafAccessor(actor, path);
    if (accessor) return accessor;
  }

  // Last-resort schema scan for WWN 2.x data model changes. Derived bank/total
  // fields are heavily penalized so only carried currency is selected.
  const leaves = collectNumericLeaves(actor.system ?? {}, "system");
  const ranked = leaves
    .map((entry) => ({ ...entry, score: currencyPathScore(entry.path, denom) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return ranked[0] ? { path: ranked[0].path, value: ranked[0].value } : null;
}

async function setCurrency(actor, accessor, amount) {
  if (!accessor?.path) throw new Error("No WWN currency field detected");
  await actor.update({ [accessor.path]: Math.max(0, amount) });
}

async function supplySourcesForMember(member) {
  const actor = await resolveActor(member);
  const carriers = [];
  const sources = [];
  const seenActors = new Set();

  if (actor) {
    sources.push({ actor, sourceRank: 0, sourceType: "self", label: actor.name });
    seenActors.add(actor.uuid);
  }

  const carrierUuids = Array.isArray(member.carrierUuids)
    ? member.carrierUuids
    : member.carrierUuid ? [member.carrierUuid] : [];

  for (const uuid of carrierUuids) {
    const carrier = await resolveUuidActor(uuid);
    if (!carrier || seenActors.has(carrier.uuid)) continue;
    seenActors.add(carrier.uuid);
    carriers.push(carrier);
    sources.push({
      actor: carrier,
      sourceRank: sources.length,
      sourceType: "carrier",
      label: carrier.name
    });
  }

  return { actor, carriers, sources };
}

async function resourceEntriesForMember(member, kind, defaults) {
  const { actor, carriers, sources } = await supplySourcesForMember(member);
  const entries = [];
  const seen = new Set();

  for (const source of sources) {
    for (const item of findMatchingItems(source.actor, member, kind, defaults)) {
      const key = item.uuid || `${source.actor.uuid}.${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        item,
        kind,
        accessor: getConsumableAccessor(item),
        sourceActor: source.actor,
        sourceRank: source.sourceRank,
        sourceType: source.sourceType,
        sourceLabel: source.label
      });
    }
  }

  return { actor, carriers, entries };
}

async function snapshotMember(member, defaults) {
  const foodData = await resourceEntriesForMember(member, "food", defaults);
  const waterData = await resourceEntriesForMember(member, "water", defaults);
  const actor = foodData.actor ?? waterData.actor;
  const carriers = foodData.carriers?.length ? foodData.carriers : (waterData.carriers ?? []);
  const currency = actor ? getCurrencyAccessor(actor, defaults.currencyDenomination) : null;

  return {
    member,
    actor,
    carriers,
    foodEntries: foodData.entries,
    waterEntries: waterData.entries,
    currency,
    money: currency?.value ?? NaN
  };
}

function positiveModulo(value, divisor) {
  if (!divisor) return 0;
  const r = value % divisor;
  return Math.abs(r) < EPSILON ? 0 : r;
}

function consumptionPriority(entry, currentValue) {
  const max = num(entry.accessor?.max, 0);
  let isPartial = false;
  let partialRemaining = Number.POSITIVE_INFINITY;

  if (max > 0 && currentValue > 0) {
    if (entry.accessor?.chargeMode === "expended") {
      // WWN capacity/expended items are partial whenever some, but not all,
      // capacity remains. This makes a 7/5 ration (2 remaining) get finished
      // before a fresh 7/0 ration.
      isPartial = currentValue < max - EPSILON;
      partialRemaining = isPartial ? currentValue : Number.POSITIVE_INFINITY;
    } else {
      // Conventional remaining-charge counters may represent stacked bundles
      // whose current value is larger than one bundle maximum. Finish the
      // partial bundle before opening another full one.
      const remainder = positiveModulo(currentValue, max);
      isPartial = remainder > EPSILON;
      partialRemaining = isPartial ? remainder : Number.POSITIVE_INFINITY;
    }
  }

  return {
    isPartial,
    partialRemaining,
    unitRank: entry.accessor?.unit === "charges" ? 0 : 1,
    sourceRank: entry.sourceRank,
    currentValue
  };
}

function sortForConsumption(entries, states) {
  return [...entries]
    .filter((entry) => entry.accessor && (states.get(entry.item.uuid)?.amount ?? entry.accessor.value) > 0)
    .sort((a, b) => {
      const av = states.get(a.item.uuid)?.amount ?? a.accessor.value;
      const bv = states.get(b.item.uuid)?.amount ?? b.accessor.value;
      const ap = consumptionPriority(a, av);
      const bp = consumptionPriority(b, bv);
      if (ap.isPartial !== bp.isPartial) return ap.isPartial ? -1 : 1;
      if (ap.partialRemaining !== bp.partialRemaining) return ap.partialRemaining - bp.partialRemaining;
      // Prefer actual charged containers/bundles over quantity-only fallbacks.
      // This is especially important for water, where one charge represents
      // one gallon and the empty container should remain in inventory.
      if (ap.unitRank !== bp.unitRank) return ap.unitRank - bp.unitRank;
      if (ap.sourceRank !== bp.sourceRank) return ap.sourceRank - bp.sourceRank;
      return ap.currentValue - bp.currentValue;
    });
}

function mutableStateFor(entry, states) {
  const key = entry.item.uuid;
  let state = states.get(key);
  if (!state) {
    state = {
      item: entry.item,
      accessor: entry.accessor,
      original: clampMin(entry.accessor?.value, 0),
      amount: clampMin(entry.accessor?.value, 0),
      changed: false
    };
    states.set(key, state);
  }
  return state;
}

function allocateUnits(entries, requested, states) {
  let remaining = Math.max(0, Math.floor(requested + EPSILON));
  const allocations = [];

  // Re-sort after finishing a partial bundle. This means a 10/7 ration stack
  // contributes its 3-charge partial bundle first, then the normal source
  // preference is reconsidered before opening another full bundle.
  while (remaining > 0) {
    const sorted = sortForConsumption(entries, states);
    const entry = sorted[0];
    if (!entry) break;

    const state = mutableStateFor(entry, states);
    const available = Math.max(0, Math.floor(state.amount + EPSILON));
    if (!available) break;

    const priority = consumptionPriority(entry, state.amount);
    const partialCap = priority.isPartial
      ? Math.max(1, Math.floor(priority.partialRemaining + EPSILON))
      : available;
    const used = Math.min(available, remaining, partialCap);

    state.amount -= used;
    state.changed = state.changed || used > 0;
    remaining -= used;

    const previous = allocations.find((a) => a.entry.item.uuid === entry.item.uuid);
    if (previous) previous.used += used;
    else allocations.push({ entry, used });
  }

  return { requested, consumed: requested - remaining, missing: remaining, allocations };
}

function wholeAndRemainder(total) {
  const safe = clampMin(total, 0);
  const whole = Math.floor(safe + EPSILON);
  return { whole, remainder: roundFraction(safe - whole) };
}

async function applySupplies(rows, days, waterMultiplier, data) {
  const warnings = [];
  const states = new Map();
  const multiplier = clampMin(waterMultiplier, 0);

  for (const row of rows) {
    if (!row.apply) continue;
    const snap = await snapshotMember(row.member, data.defaults);
    if (!snap.actor) {
      warnings.push(`${row.member.name}: actor/token could not be resolved.`);
      continue;
    }

    const food = wholeAndRemainder(clampMin(row.member.foodRemainder, 0) + clampMin(row.foodPerDay, 0) * days);
    const water = wholeAndRemainder(clampMin(row.member.waterRemainder, 0) + clampMin(row.waterPerDay, 0) * multiplier * days);

    const foodResult = allocateUnits(snap.foodEntries, food.whole, states);
    const waterResult = allocateUnits(snap.waterEntries, water.whole, states);

    row.member.foodRemainder = food.remainder;
    row.member.waterRemainder = water.remainder;

    if (food.whole > 0 && !snap.foodEntries.length) {
      warnings.push(`${snap.actor.name}: no matching ration Item found on the character or supply carrier.`);
    } else if (food.whole > 0 && snap.foodEntries.every((entry) => !entry.accessor)) {
      warnings.push(`${snap.actor.name}: matching ration Items have no detectable WWN charges/quantity.`);
    }
    if (foodResult.missing > 0) warnings.push(`${snap.actor.name}: short ${foodResult.missing} food.`);

    if (water.whole > 0 && !snap.waterEntries.length) {
      warnings.push(`${snap.actor.name}: no matching water Item found on the character or supply carrier.`);
    } else if (water.whole > 0 && snap.waterEntries.every((entry) => !entry.accessor)) {
      warnings.push(`${snap.actor.name}: matching water Items have no detectable WWN charges/quantity.`);
    }
    if (waterResult.missing > 0) warnings.push(`${snap.actor.name}: short ${waterResult.missing} water.`);
  }

  for (const state of states.values()) {
    if (!state.changed || Math.abs(state.amount - state.original) < EPSILON) continue;
    try {
      await setConsumableAmount(state.item, state.accessor, state.amount);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to update ${state.item.name}`, err);
      warnings.push(`${state.item.name}: could not update stock.`);
    }
  }

  await setData(data);
  return warnings;
}

async function applyMoney(rows, days, data) {
  const warnings = [];
  const denom = String(data.defaults.currencyDenomination || "sp").toUpperCase();

  for (const row of rows) {
    if (!row.apply) continue;
    const snap = await snapshotMember(row.member, data.defaults);
    if (!snap.actor) {
      warnings.push(`${row.member.name}: actor/token could not be resolved.`);
      continue;
    }

    // A supplied settlement day satisfies the fractional requirement as well.
    row.member.foodRemainder = 0;
    row.member.waterRemainder = 0;

    const cost = clampMin(row.moneyPerDay, 0) * days;
    if (!cost) continue;
    if (!snap.currency || !Number.isFinite(snap.money)) {
      warnings.push(`${snap.actor.name}: carried ${denom} field could not be detected.`);
      continue;
    }

    await setCurrency(snap.actor, snap.currency, snap.money - cost);
    if (snap.money < cost) warnings.push(`${snap.actor.name}: short ${cost - snap.money} ${denom}.`);
  }

  await setData(data);
  return warnings;
}

function readDailyRows(dialog, members) {
  const form = dialog.form;
  return members.map((member, index) => ({
    member,
    apply: !!form.elements[`apply-${index}`]?.checked,
    foodPerDay: clampMin(form.elements[`food-${index}`]?.value ?? member.foodPerDay, 0),
    waterPerDay: clampMin(form.elements[`water-${index}`]?.value ?? member.waterPerDay, 0),
    moneyPerDay: clampMin(form.elements[`money-${index}`]?.value ?? member.moneyPerDay, 0)
  }));
}

function readWaterMultiplier(dialog, fallback = 1) {
  return clampMin(dialog.form.elements["water-multiplier"]?.value ?? fallback, 0);
}

function stockLine(entry) {
  const item = entry.item;
  const accessor = entry.accessor;
  if (!accessor) return `${esc(item.name)} <span class="rp-muted">(no stock field · ${esc(entry.sourceLabel)})</span>`;

  let amount;
  if (accessor.unit === "charges") {
    const max = num(accessor.max, 0);
    const unitLabel = entry.kind === "water" ? "gal" : "charges";
    if (max > 0) {
      if (accessor.chargeMode === "expended") {
        amount = `${esc(accessor.value)}/${esc(max)} ${unitLabel} left <span class="rp-muted">(${esc(accessor.storedValue)} used)</span>`;
      } else {
        amount = `${esc(accessor.value)}/${esc(max)} ${unitLabel} left`;
      }
    } else {
      amount = `${esc(accessor.value)} ${unitLabel}`;
    }
  } else {
    amount = `${esc(accessor.value)} qty`;
  }

  return `<strong>${amount}</strong> ${esc(item.name)} <span class="rp-muted">· ${esc(entry.sourceLabel)}</span>`;
}

function stockText(entries) {
  if (!entries?.length) return `<span class="rp-missing">Not found</span>`;
  return entries.map(stockLine).join("<br>");
}

function carrierText(snap) {
  const carriers = snap.carriers ?? [];
  if (!carriers.length) return "";
  return `<div class="rp-subline"><i class="fa-solid fa-horse"></i> ${carriers.map((c) => esc(c.name)).join(" · ")}</div>`;
}

async function showDailyPrompt(days = 1, worldTime = game.time.worldTime) {
  if (!game.user.isGM || !isWWN()) return;
  const data = await getData();
  const members = data.members.filter((m) => m.enabled !== false);
  if (!members.length) {
    ui.notifications.warn("Road Provisions: no tracked tokens are enabled.");
    return;
  }

  const snaps = [];
  for (const m of members) snaps.push(await snapshotMember(m, data.defaults));

  const denom = String(data.defaults.currencyDenomination || "sp").toUpperCase();
  const bodyRows = snaps.map((s, i) => {
    const m = s.member;
    const fpd = m.foodPerDay ?? data.defaults.foodPerDay;
    const wpd = m.waterPerDay ?? data.defaults.waterPerDay;
    const mpd = m.moneyPerDay ?? data.defaults.moneyPerDay;
    const foodText = s.actor ? stockText(s.foodEntries) : `<span class="rp-missing">Actor missing</span>`;
    const waterText = s.actor ? stockText(s.waterEntries) : `<span class="rp-missing">Actor missing</span>`;
    const moneyText = Number.isFinite(s.money) ? s.money : "—";

    return `<tr>
      <td><input type="checkbox" name="apply-${i}" checked></td>
      <td><strong>${esc(m.name)}</strong>${carrierText(s)}</td>
      <td class="rp-stock">${foodText}</td>
      <td>
        <input type="number" step="0.25" min="0" name="food-${i}" value="${esc(fpd)}">
        <div class="rp-subline">carry ${esc(roundFraction(m.foodRemainder ?? 0))}</div>
      </td>
      <td class="rp-stock">${waterText}</td>
      <td>
        <input type="number" step="0.25" min="0" name="water-${i}" value="${esc(wpd)}">
        <div class="rp-subline">carry ${esc(roundFraction(m.waterRemainder ?? 0))}</div>
      </td>
      <td>${esc(moneyText)} ${denom}</td>
      <td><input type="number" step="0.01" min="0" name="money-${i}" value="${esc(mpd)}"></td>
    </tr>`;
  }).join("");

  const content = `<div class="rp-daily">
    <div class="rp-day-summary">
      <div><strong>${esc(dayLabel(worldTime))}</strong> — ${days} day${days === 1 ? "" : "s"} to process.</div>
      <label class="rp-water-multiplier">Water demand
        <input type="number" name="water-multiplier" min="0" step="0.5" value="${esc(data.defaults.waterMultiplier)}">
        <span>× (1 normal · 2 hot · 3 desert)</span>
      </label>
    </div>
    <p>Travel consumes whole WWN supply units. Charged water containers use <strong>1 charge = 1 gallon</strong>; charged rations use one remaining charge per ration-day. Fractional daily needs are carried forward automatically, and partially-used containers/bundles are consumed first.</p>
    <div class="rp-table-wrap"><table>
      <thead><tr><th>Use</th><th>Character</th><th>Food on hand</th><th>Food/day</th><th>Water on hand</th><th>Water/day</th><th>Carried ${denom}</th><th>${denom}/day</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table></div>
  </div>`;

  const DialogV2 = foundry.applications.api.DialogV2;
  const result = await DialogV2.wait({
    window: { title: "Road Provisions — WWN New Day" },
    content,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "supplies",
        icon: "fa-solid fa-utensils",
        label: "Deduct Rations & Water",
        default: data.mode === "travel",
        callback: async (_event, _button, dialog) => {
          const rows = readDailyRows(dialog, members);
          const waterMultiplier = readWaterMultiplier(dialog, data.defaults.waterMultiplier);
          const warnings = await applySupplies(rows, days, waterMultiplier, data);
          return { action: "supplies", warnings };
        }
      },
      {
        action: "money",
        icon: "fa-solid fa-coins",
        label: `Charge ${denom} Instead`,
        default: data.mode === "settlement",
        callback: async (_event, _button, dialog) => {
          const rows = readDailyRows(dialog, members);
          const warnings = await applyMoney(rows, days, data);
          return { action: "money", warnings };
        }
      },
      {
        action: "skip",
        icon: "fa-solid fa-forward",
        label: "Skip This Day",
        callback: async () => ({ action: "skip", warnings: [] })
      }
    ]
  });

  if (result?.warnings?.length) {
    ui.notifications.warn(`Road Provisions: ${result.warnings.join(" ")}`);
  } else if (result?.action) {
    const msg = result.action === "supplies"
      ? "WWN provisions deducted."
      : result.action === "money"
        ? `settlement costs charged in ${denom}.`
        : "day skipped.";
    ui.notifications.info(`Road Provisions: ${msg}`);
  }
}

function carrierChoicesFor(memberUuid, selectedUuids = []) {
  const selected = new Set(Array.isArray(selectedUuids) ? selectedUuids : [selectedUuids].filter(Boolean));
  const choices = [];
  const seen = new Set([memberUuid]);

  for (const actor of game.actors?.contents ?? []) {
    if (!actor?.uuid || seen.has(actor.uuid)) continue;
    seen.add(actor.uuid);
    choices.push({
      uuid: actor.uuid,
      name: `${actor.name} (${actor.type || "Actor"})`,
      selected: selected.has(actor.uuid)
    });
  }

  for (const token of canvas?.scene?.tokens ?? []) {
    if (!token?.actor || !token.uuid || seen.has(token.uuid)) continue;
    // Linked tokens are already represented by their world Actor above.
    if (token.actorLink && token.actor?.uuid && seen.has(token.actor.uuid)) continue;
    seen.add(token.uuid);
    choices.push({
      uuid: token.uuid,
      name: `${token.name || token.actor.name} (scene token)`,
      selected: selected.has(token.uuid)
    });
  }

  choices.sort((a, b) => a.name.localeCompare(b.name));
  return choices;
}

class RoadProvisionsConfig extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "road-provisions-config",
      title: "Road Provisions — Worlds Without Number",
      template: `modules/${MODULE_ID}/templates/config.html`,
      width: 1120,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
      resizable: true
    });
  }

  async getData() {
    const data = await getData();
    const members = [];

    for (const m of data.members) {
      const snap = await snapshotMember(m, data.defaults);
      members.push({
        ...m,
        carrierOptions: carrierChoicesFor(m.uuid, m.carrierUuids),
        foodStock: snap.actor ? stockText(snap.foodEntries) : `<span class="rp-missing">Actor missing</span>`,
        waterStock: snap.actor ? stockText(snap.waterEntries) : `<span class="rp-missing">Actor missing</span>`
      });
    }

    return {
      ...data,
      members,
      isTravel: data.mode === "travel",
      isSettlement: data.mode === "settlement",
      usesSP: data.defaults.currencyDenomination !== "gp",
      usesGP: data.defaults.currencyDenomination === "gp",
      currentDay: dayLabel(),
      systemId: game.system.id,
      systemVersion: game.system.version ?? "unknown",
      isWWN: isWWN()
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='add-selected']").on("click", this._addSelected.bind(this));
    html.find("[data-action='remove-member']").on("click", this._removeMember.bind(this));
    html.find("[data-action='prompt-now']").on("click", this._promptNow.bind(this));
  }

  async _saveForm() {
    const raw = this._getSubmitData();
    const existing = await getData();
    const expanded = foundry.utils.expandObject(raw);
    const next = clone(existing);

    next.mode = expanded.mode || existing.mode;
    next.defaults = foundry.utils.mergeObject(existing.defaults, expanded.defaults || {}, { inplace: false });
    next.defaults.foodPerDay = clampMin(next.defaults.foodPerDay, 0);
    next.defaults.waterPerDay = clampMin(next.defaults.waterPerDay, 0);
    next.defaults.waterMultiplier = clampMin(next.defaults.waterMultiplier ?? 1, 0);
    next.defaults.moneyPerDay = clampMin(next.defaults.moneyPerDay, 0);
    next.defaults.currencyDenomination = next.defaults.currencyDenomination === "gp" ? "gp" : "sp";

    for (let i = 0; i < next.members.length; i++) {
      const patch = expanded.members?.[i] || {};
      next.members[i] = foundry.utils.mergeObject(next.members[i], patch, { inplace: false });
      next.members[i].enabled = raw[`members.${i}.enabled`] === true || raw[`members.${i}.enabled`] === "true" || raw[`members.${i}.enabled`] === "on";
      next.members[i].foodPerDay = clampMin(next.members[i].foodPerDay ?? next.defaults.foodPerDay, 0);
      next.members[i].waterPerDay = clampMin(next.members[i].waterPerDay ?? next.defaults.waterPerDay, 0);
      next.members[i].moneyPerDay = clampMin(next.members[i].moneyPerDay ?? next.defaults.moneyPerDay, 0);
      next.members[i].foodRemainder = roundFraction(next.members[i].foodRemainder ?? 0);
      next.members[i].waterRemainder = roundFraction(next.members[i].waterRemainder ?? 0);

      const carrierSelect = this.element?.[0]?.querySelector(`select[data-member-carriers="${i}"]`);
      next.members[i].carrierUuids = carrierSelect
        ? Array.from(carrierSelect.selectedOptions).map((o) => o.value).filter(Boolean)
        : (next.members[i].carrierUuids ?? []);
      delete next.members[i].carrierUuid;
    }

    await setData(next);
    return next;
  }

  async _updateObject(_event, _formData) {
    await this._saveForm();
    ui.notifications.info("Road Provisions settings saved.");
    this.render();
  }

  async _addSelected(event) {
    event.preventDefault();
    await this._saveForm();
    const selected = canvas?.tokens?.controlled || [];
    if (!selected.length) return ui.notifications.warn("Select one or more tokens on the canvas first.");

    const data = await getData();
    let added = 0;
    for (const token of selected) {
      const uuid = token.document.actorLink && token.actor ? token.actor.uuid : token.document.uuid;
      if (data.members.some((m) => m.uuid === uuid)) continue;
      data.members.push({
        uuid,
        name: token.name || token.actor?.name || "Token",
        enabled: true,
        foodPerDay: data.defaults.foodPerDay,
        waterPerDay: data.defaults.waterPerDay,
        moneyPerDay: data.defaults.moneyPerDay,
        foodItemName: "",
        waterItemName: "",
        carrierUuids: [],
        foodRemainder: 0,
        waterRemainder: 0
      });
      added++;
    }

    await setData(data);
    ui.notifications.info(`Road Provisions: added ${added} token${added === 1 ? "" : "s"}.`);
    this.render();
  }

  async _removeMember(event) {
    event.preventDefault();
    await this._saveForm();
    const index = Number(event.currentTarget.dataset.index);
    const data = await getData();
    if (!Number.isInteger(index) || !data.members[index]) return;
    data.members.splice(index, 1);
    await setData(data);
    this.render();
  }

  async _promptNow(event) {
    event.preventDefault();
    await this._saveForm();
    if (!isWWN()) return ui.notifications.error("Road Provisions is specifically for the Worlds Without Number system (id: wwn).");
    await showDailyPrompt(1, game.time.worldTime);
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_DATA, {
    name: "Tracker Data",
    scope: "world",
    config: false,
    type: Object,
    default: clone(DEFAULT_DATA)
  });

  game.settings.register(MODULE_ID, SETTING_LAST_DAY, {
    name: "Last Processed Calendar Day",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, SETTING_FOOD_NAMES, {
    name: "Ration Item Names",
    hint: "Semicolon-separated item names/words that count as food. Matching uses normalized whole names/words.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_FOOD_NAMES
  });

  game.settings.register(MODULE_ID, SETTING_WATER_NAMES, {
    name: "Water Item Names",
    hint: "Semicolon-separated item names/words that count as water. The default 'Water' alias matches names such as '20 Gallon Half-Barrel of Water'.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_WATER_NAMES
  });

  game.settings.registerMenu(MODULE_ID, "tracker", {
    name: "Road Provisions (WWN)",
    label: "Open Tracker",
    hint: "Track WWN rations, water, supply carriers, and settlement expenses against the world's game clock.",
    icon: "fa-solid fa-campground",
    type: RoadProvisionsConfig,
    restricted: true
  });
});


async function migrateLegacySettings() {
  const raw = clone(game.settings.get(MODULE_ID, SETTING_DATA) || {});
  const legacyFood = String(raw.defaults?.foodNames || "").trim();
  const legacyWater = String(raw.defaults?.waterNames || "").trim();

  if (legacyFood && game.settings.get(MODULE_ID, SETTING_FOOD_NAMES) === DEFAULT_FOOD_NAMES) {
    const migrated = legacyFood === "Rations, Ration" ? DEFAULT_FOOD_NAMES : legacyFood;
    await game.settings.set(MODULE_ID, SETTING_FOOD_NAMES, migrated);
  }
  if (legacyWater && game.settings.get(MODULE_ID, SETTING_WATER_NAMES) === DEFAULT_WATER_NAMES) {
    const migrated = legacyWater === "Water, Waterskin, Water Skin" ? DEFAULT_WATER_NAMES : legacyWater;
    await game.settings.set(MODULE_ID, SETTING_WATER_NAMES, migrated);
  }

  const data = await getData();
  await setData(data);
}

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;

  if (!isWWN()) {
    ui.notifications.error("Road Provisions: this build is specifically for Worlds Without Number (system id: wwn).", { permanent: true });
    return;
  }

  await migrateLegacySettings();

  const last = game.settings.get(MODULE_ID, SETTING_LAST_DAY);
  if (!last) await game.settings.set(MODULE_ID, SETTING_LAST_DAY, dayKey());

  game.modules.get(MODULE_ID).api = {
    openTracker: () => new RoadProvisionsConfig().render(true),
    promptNow: (days = 1) => showDailyPrompt(Math.max(1, num(days, 1))),
    getData,
    setData,
    detectConsumable: getConsumableAccessor,
    detectCurrency: getCurrencyAccessor,
    matchingItems: findMatchingItems
  };
});

Hooks.on("updateWorldTime", async (worldTime, dt) => {
  if (!game.user.isGM || !isWWN() || dt <= 0) return;

  const previousTime = worldTime - dt;
  const oldKey = dayKey(previousTime);
  const newKey = dayKey(worldTime);
  if (oldKey === newKey) return;

  const activeGMs = game.users.filter((u) => u.active && u.isGM).sort((a, b) => a.id.localeCompare(b.id));
  if (activeGMs[0]?.id !== game.user.id) return;

  const last = game.settings.get(MODULE_ID, SETTING_LAST_DAY);
  if (last === newKey) return;

  let days = 1;
  try {
    const oldOrd = dayOrdinal(previousTime);
    const newOrd = dayOrdinal(worldTime);
    if (typeof oldOrd === "number" && typeof newOrd === "number") days = Math.max(1, Math.floor(newOrd - oldOrd));
  } catch (_err) {
    // One-day fallback for custom calendars that cannot provide a numeric difference.
  }

  await game.settings.set(MODULE_ID, SETTING_LAST_DAY, newKey);
  await showDailyPrompt(days, worldTime);
});

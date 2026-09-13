const MODULE_ID = "road-provisions";
const SETTING_DATA = "trackerData";
const SETTING_LAST_DAY = "lastProcessedDay";
const WWN_SYSTEM_ID = "wwn";

const DEFAULT_DATA = {
  mode: "travel",
  defaults: {
    foodPerDay: 1,
    waterPerDay: 1,
    moneyPerDay: 0,
    foodNames: "Rations, Ration",
    waterNames: "Water, Waterskin, Water Skin",
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
  try {
    return game.time.calendar.format(worldTime, "timestamp");
  } catch (_err) {
    const c = game.time.calendar.timeToComponents(worldTime);
    return `Year ${c.year}, Day ${c.day + 1}`;
  }
}

function dayKey(worldTime = game.time.worldTime) {
  const c = game.time.calendar.timeToComponents(worldTime);
  return `${c.year}:${c.day}`;
}

async function getData() {
  const stored = game.settings.get(MODULE_ID, SETTING_DATA) || {};
  const merged = foundry.utils.mergeObject(clone(DEFAULT_DATA), stored, { inplace: false, recursive: true });

  // v1.0 migration: remove generic-system path settings from the active configuration.
  delete merged.defaults.quantityPath;
  delete merged.defaults.currencyPath;
  for (const member of merged.members ?? []) {
    delete member.quantityPath;
    delete member.currencyPath;
  }
  return merged;
}

async function setData(data) {
  return game.settings.set(MODULE_ID, SETTING_DATA, data);
}

async function resolveActor(member) {
  if (!member?.uuid) return null;
  let doc = null;
  try {
    doc = await foundry.utils.fromUuid(member.uuid);
  } catch (_err) {
    return null;
  }
  if (!doc) return null;
  if (doc.documentName === "Actor") return doc;
  if (doc.actor) return doc.actor;
  return null;
}

function parseAliases(text) {
  return String(text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function findItem(actor, member, kind, defaults) {
  const idKey = kind === "food" ? "foodItemId" : "waterItemId";
  const nameKey = kind === "food" ? "foodItemName" : "waterItemName";
  if (member[idKey]) {
    const byId = actor.items.get(member[idKey]);
    if (byId) return byId;
  }

  const explicit = String(member[nameKey] || "").trim();
  const aliases = explicit
    ? [explicit]
    : parseAliases(kind === "food" ? defaults.foodNames : defaults.waterNames);

  const lowered = aliases.map((a) => a.toLowerCase());
  return actor.items.find((i) => lowered.includes(i.name.toLowerCase()))
    ?? actor.items.find((i) => lowered.some((a) => i.name.toLowerCase().includes(a)))
    ?? null;
}

function hasNumericPath(document, path) {
  if (!foundry.utils.hasProperty(document, path)) return false;
  const value = foundry.utils.getProperty(document, path);
  return Number.isFinite(Number(value));
}

/**
 * WWN has historically represented consumables such as rations with charges.
 * The 2.0 line has gone through schema changes, so detect the native field that
 * actually exists on the Item rather than hard-coding one alpha's shape.
 */
function getConsumableAccessor(item) {
  const chargePaths = [
    "system.charges.value",
    "system.charges.current",
    "system.charges.current.value",
    "system.uses.value",
    "system.uses.current",
    "system.charges"
  ];
  for (const path of chargePaths) {
    if (hasNumericPath(item, path)) {
      return { path, value: num(foundry.utils.getProperty(item, path)), unit: "charges" };
    }
  }

  const quantityPaths = ["system.quantity.value", "system.quantity"];
  for (const path of quantityPaths) {
    if (hasNumericPath(item, path)) {
      return { path, value: num(foundry.utils.getProperty(item, path)), unit: "quantity" };
    }
  }

  return null;
}

async function setConsumableAmount(item, accessor, amount) {
  if (!accessor?.path) throw new Error(`No WWN consumable field detected on ${item.name}`);
  await item.update({ [accessor.path]: Math.max(0, amount) });
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
      if (hasNumericPath(document, leafPath)) return { path: leafPath, value: num(foundry.utils.getProperty(document, leafPath)) };
    }
  }
  return null;
}

/** Detect WWN carried coin without requiring a user-entered data path. */
function getCurrencyAccessor(actor, denomination = "sp") {
  const denom = denomination === "gp" ? "gp" : "sp";
  const desired = denom === "gp"
    ? new Set(["gp", "gold", "goldpiece", "goldpieces"])
    : new Set(["sp", "silver", "silverpiece", "silverpieces"]);

  // Known/likely WWN roots, checked before the generic fallback scan.
  for (const root of ["system.currency", "system.coins", "system.wealth.currency"]) {
    const obj = foundry.utils.getProperty(actor, root);
    if (!obj || typeof obj !== "object") continue;
    for (const key of Object.keys(obj)) {
      if (!desired.has(normalizeKey(key))) continue;
      const accessor = numericLeafAccessor(actor, `${root}.${key}`);
      if (accessor) return accessor;
    }
  }

  // Direct candidates cover older WWN sheets and simple data models.
  const directCandidates = denom === "gp"
    ? ["system.currency.gp", "system.gp", "system.gold"]
    : ["system.currency.sp", "system.sp", "system.silver"];
  for (const path of directCandidates) {
    const accessor = numericLeafAccessor(actor, path);
    if (accessor) return accessor;
  }

  return null;
}

async function setCurrency(actor, accessor, amount) {
  if (!accessor?.path) throw new Error("No WWN currency field detected");
  await actor.update({ [accessor.path]: Math.max(0, amount) });
}

async function snapshotMember(member, defaults) {
  const actor = await resolveActor(member);
  if (!actor) return { member, actor: null, food: null, water: null, currency: null };

  const food = findItem(actor, member, "food", defaults);
  const water = findItem(actor, member, "water", defaults);
  const foodAccessor = food ? getConsumableAccessor(food) : null;
  const waterAccessor = water ? getConsumableAccessor(water) : null;
  const currency = getCurrencyAccessor(actor, defaults.currencyDenomination);

  return {
    member,
    actor,
    food,
    water,
    foodAccessor,
    waterAccessor,
    foodQty: foodAccessor?.value ?? 0,
    waterQty: waterAccessor?.value ?? 0,
    currency,
    money: currency?.value ?? NaN
  };
}

async function applySupplies(rows, days, defaults) {
  const results = [];
  for (const row of rows) {
    if (!row.apply) continue;
    const snap = await snapshotMember(row.member, defaults);
    if (!snap.actor) {
      results.push(`${row.member.name}: actor/token could not be resolved.`);
      continue;
    }

    const foodNeed = Math.max(0, num(row.foodPerDay) * days);
    const waterNeed = Math.max(0, num(row.waterPerDay) * days);

    if (foodNeed > 0) {
      if (!snap.food) results.push(`${snap.actor.name}: no ration/food Item found.`);
      else if (!snap.foodAccessor) results.push(`${snap.actor.name}: ${snap.food.name} has no detectable WWN charges or quantity.`);
      else {
        await setConsumableAmount(snap.food, snap.foodAccessor, snap.foodQty - foodNeed);
        if (snap.foodQty < foodNeed) results.push(`${snap.actor.name}: short ${foodNeed - snap.foodQty} food.`);
      }
    }

    if (waterNeed > 0) {
      if (!snap.water) results.push(`${snap.actor.name}: no water Item found.`);
      else if (!snap.waterAccessor) results.push(`${snap.actor.name}: ${snap.water.name} has no detectable WWN charges or quantity.`);
      else {
        await setConsumableAmount(snap.water, snap.waterAccessor, snap.waterQty - waterNeed);
        if (snap.waterQty < waterNeed) results.push(`${snap.actor.name}: short ${waterNeed - snap.waterQty} water.`);
      }
    }
  }
  return results;
}

async function applyMoney(rows, days, defaults) {
  const results = [];
  const denom = String(defaults.currencyDenomination || "sp").toUpperCase();

  for (const row of rows) {
    if (!row.apply) continue;
    const snap = await snapshotMember(row.member, defaults);
    if (!snap.actor) {
      results.push(`${row.member.name}: actor/token could not be resolved.`);
      continue;
    }

    const cost = Math.max(0, num(row.moneyPerDay) * days);
    if (!cost) continue;
    if (!snap.currency || !Number.isFinite(snap.money)) {
      results.push(`${snap.actor.name}: carried ${denom} field could not be detected.`);
      continue;
    }

    await setCurrency(snap.actor, snap.currency, snap.money - cost);
    if (snap.money < cost) results.push(`${snap.actor.name}: short ${cost - snap.money} ${denom}.`);
  }
  return results;
}

function readDailyRows(dialog, members) {
  const form = dialog.form;
  return members.map((member, index) => ({
    member,
    apply: !!form.elements[`apply-${index}`]?.checked,
    foodPerDay: num(form.elements[`food-${index}`]?.value, member.foodPerDay),
    waterPerDay: num(form.elements[`water-${index}`]?.value, member.waterPerDay),
    moneyPerDay: num(form.elements[`money-${index}`]?.value, member.moneyPerDay)
  }));
}

function stockText(item, accessor) {
  if (!item) return "Not found";
  if (!accessor) return `${esc(item.name)} (no stock field)`;
  const suffix = accessor.unit === "charges" ? "charges" : "qty";
  return `${esc(accessor.value)} ${suffix} (${esc(item.name)})`;
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
    const foodText = s.actor ? stockText(s.food, s.foodAccessor) : "Actor missing";
    const waterText = s.actor ? stockText(s.water, s.waterAccessor) : "Actor missing";
    const moneyText = Number.isFinite(s.money) ? s.money : "—";

    return `<tr>
      <td><input type="checkbox" name="apply-${i}" checked></td>
      <td><strong>${esc(m.name)}</strong></td>
      <td>${foodText}</td>
      <td><input type="number" step="1" min="0" name="food-${i}" value="${esc(fpd)}"></td>
      <td>${waterText}</td>
      <td><input type="number" step="1" min="0" name="water-${i}" value="${esc(wpd)}"></td>
      <td>${esc(moneyText)} ${denom}</td>
      <td><input type="number" step="0.01" min="0" name="money-${i}" value="${esc(mpd)}"></td>
    </tr>`;
  }).join("");

  const content = `<div class="rp-daily">
    <p><strong>${esc(dayLabel(worldTime))}</strong> — ${days} day${days === 1 ? "" : "s"} to process.</p>
    <p>For road travel, deduct carried rations/water. In a settlement or other safe supply point, charge coin instead. You can override each character's usage before applying it.</p>
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
          const warnings = await applySupplies(rows, days, data.defaults);
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
          const warnings = await applyMoney(rows, days, data.defaults);
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

class RoadProvisionsConfig extends foundry.appv1.api.FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "road-provisions-config",
      title: "Road Provisions — Worlds Without Number",
      template: `modules/${MODULE_ID}/templates/config.html`,
      width: 900,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
      resizable: true
    });
  }

  async getData() {
    const data = await getData();
    return {
      ...data,
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
    next.defaults.foodPerDay = Math.max(0, num(next.defaults.foodPerDay, 1));
    next.defaults.waterPerDay = Math.max(0, num(next.defaults.waterPerDay, 1));
    next.defaults.moneyPerDay = Math.max(0, num(next.defaults.moneyPerDay, 0));
    next.defaults.currencyDenomination = next.defaults.currencyDenomination === "gp" ? "gp" : "sp";

    for (let i = 0; i < next.members.length; i++) {
      const patch = expanded.members?.[i] || {};
      next.members[i] = foundry.utils.mergeObject(next.members[i], patch, { inplace: false });
      next.members[i].enabled = raw[`members.${i}.enabled`] === true || raw[`members.${i}.enabled`] === "true" || raw[`members.${i}.enabled`] === "on";
      next.members[i].foodPerDay = Math.max(0, num(next.members[i].foodPerDay, next.defaults.foodPerDay));
      next.members[i].waterPerDay = Math.max(0, num(next.members[i].waterPerDay, next.defaults.waterPerDay));
      next.members[i].moneyPerDay = Math.max(0, num(next.members[i].moneyPerDay, next.defaults.moneyPerDay));
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
        waterItemName: ""
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
    if (!isWWN()) return ui.notifications.error("Road Provisions v1.1 is specifically for the Worlds Without Number system (id: wwn).");
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

  game.settings.registerMenu(MODULE_ID, "tracker", {
    name: "Road Provisions (WWN)",
    label: "Open Tracker",
    hint: "Track WWN rations, water, and settlement expenses against the world's game clock.",
    icon: "fa-solid fa-campground",
    type: RoadProvisionsConfig,
    restricted: true
  });
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;

  if (!isWWN()) {
    ui.notifications.error("Road Provisions: this build is specifically for Worlds Without Number (system id: wwn).", { permanent: true });
    return;
  }

  const last = game.settings.get(MODULE_ID, SETTING_LAST_DAY);
  if (!last) await game.settings.set(MODULE_ID, SETTING_LAST_DAY, dayKey());

  game.modules.get(MODULE_ID).api = {
    openTracker: () => new RoadProvisionsConfig().render(true),
    promptNow: (days = 1) => showDailyPrompt(Math.max(1, num(days, 1))),
    getData,
    setData,
    detectConsumable: getConsumableAccessor,
    detectCurrency: getCurrencyAccessor
  };
});

Hooks.on("updateWorldTime", async (worldTime, dt) => {
  if (!game.user.isGM || !isWWN() || dt <= 0) return;

  const previousTime = worldTime - dt;
  const oldKey = dayKey(previousTime);
  const newKey = dayKey(worldTime);
  if (oldKey === newKey) return;

  // Only one active GM processes each calendar transition.
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
    // One-day fallback if a custom calendar cannot provide a numeric difference.
  }

  // Mark before showing the modal to prevent duplicate simultaneous GM hooks.
  await game.settings.set(MODULE_ID, SETTING_LAST_DAY, newKey);
  await showDailyPrompt(days, worldTime);
});

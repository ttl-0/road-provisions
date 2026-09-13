# Road Provisions for Worlds Without Number — Foundry VTT v14

Road Provisions is a GM-focused Foundry VTT v14 module built specifically for the **Worlds Without Number** Foundry system (`wwn`). It tracks daily rations, water, and settlement expenses using the world's in-game calendar.

## What it does

- Watches Foundry's official world time/calendar.
- When the game calendar advances into a new day, the active GM receives a daily upkeep prompt.
- Choose one of three outcomes:
  - **Deduct Rations & Water** for wilderness/road travel.
  - **Charge SP/GP Instead** when the party is somewhere supplies can reasonably be bought.
  - **Skip This Day** for any day where upkeep should not matter.
- Add/remove tracked characters by selecting Tokens on the canvas.
- Toggle individual PCs on/off without removing them.
- Override each character's ration use, water use, settlement cost, ration item name, and water item name.
- Override consumption directly in the daily prompt before applying it.
- Handles linked Actors and specific unlinked Token Actors.
- Handles multi-day clock jumps.
- Prevents duplicate prompts when multiple GMs are online.

## WWN-specific resource handling

The WWN Foundry system has historically represented consumables such as **rations** with item **charges** rather than only with stack quantity. Road Provisions therefore:

1. Looks for the configured ration/water item by name.
2. Detects a native WWN charge field on that item and deducts charges when present.
3. Falls back to the item's quantity field for custom WWN inventory items that do not use charges.

The detector supports several charge/quantity layouts so the module is less brittle across the WWN 2.0 development line.

Default aliases:

- Rations: `Rations, Ration`
- Water: `Water, Waterskin, Water Skin`

If your water item has a different name, set it globally or override it for a single PC.

## WWN currency

Settlement expenses are deducted from the character's **carried** WWN currency. Choose SP (the normal WWN standard) or GP in the tracker. The module detects the actor's native WWN currency field instead of asking you to enter a Foundry data path.

If the PC cannot afford the full amount, their detected carried currency is reduced to zero and the GM receives a shortage warning.

## Installation

1. Copy the `road-provisions` folder into your Foundry user-data `Data/modules/` folder.
2. Restart Foundry if it is running.
3. Enable **Road Provisions for Worlds Without Number** in your WWN world.
4. Open **Game Settings → Configure Settings → Road Provisions (WWN) → Open Tracker**.
5. Select your party tokens on the canvas and click **Add Selected Tokens**.
6. Set the settlement cost you want to use. It defaults to 0 so the module does not assume your campaign's lodging/living standard.

## Daily workflow

When the in-game day rolls over, the GM sees each tracked PC with:

- ration stock found on the actor,
- ration consumption per day,
- water stock found on the actor,
- water consumption per day,
- carried SP/GP,
- settlement cost per day.

All per-day values are editable in that dialog before the deduction happens.

## Macro/API helpers

After Foundry's `ready` hook:

```js
game.modules.get("road-provisions").api.openTracker();
```

```js
game.modules.get("road-provisions").api.promptNow(1);
```

For troubleshooting, the API also exposes the WWN field detectors:

```js
game.modules.get("road-provisions").api.detectConsumable(item);
game.modules.get("road-provisions").api.detectCurrency(actor, "sp");
```

## Version notes

Version 1.1.0 is the WWN-specific rewrite of the original system-agnostic build. It removes D&D-style quantity/currency path settings and uses WWN-aware runtime detection instead.

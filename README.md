# Road Provisions for Worlds Without Number — Foundry VTT v14

Road Provisions is a GM-focused Foundry VTT v14 module built specifically for the **Worlds Without Number** Foundry system (`wwn`). It tracks daily rations, water, and settlement expenses using Foundry's in-game calendar.

## Daily workflow

When Foundry's world clock crosses into a new calendar day, the active GM gets a prompt for the tracked party. The GM can:

- **Deduct Rations & Water** for wilderness/road travel.
- **Charge SP/GP Instead** when the party is somewhere supplies can reasonably be bought.
- **Skip This Day** without changing inventory, money, or fractional consumption.

A manual **Test Daily Prompt** button is available from the tracker.

## WWN ration and water handling

The module is designed around WWN charged items such as:

- `Rations, 1 week`
- `Waterskin, 1 gallon`

For charged items it detects both current and maximum charges when the WWN data model exposes them. When several matching items are available, it prefers a **partially-used bundle before a full bundle**. It then prefers the character's own stock before their supply carrier when otherwise equivalent.

Item matching is word/name based. It does not use loose substring matching, so an alias such as `Ration` will not accidentally match an item like `Exoskeleton Integration`.

Default item names are semicolon-separated because WWN item names themselves can contain commas:

```text
Rations, 1 week; Rations; Ration
Waterskin, 1 gallon; Water; Waterskin; Water Skin
```

## Fractional daily needs

Food and water requirements may be fractional. For example, a character who needs only half the normal food and water can be configured as:

```text
Rations/day: 0.5
Water/day:   0.5
```

The module keeps a per-character fractional remainder rather than writing fractional charges to WWN Items. At a 0.5 daily rate, the first day carries 0.5 forward and the second day consumes one whole charge.

The tracker displays each character's currently carried fraction for troubleshooting.

## Water demand multiplier

WWN's normal water requirement is treated as **1 ENC/person/day** by default. A `Waterskin, 1 gallon` can therefore represent one normal person-day of water when it has one usable charge.

The tracker has a default water-demand multiplier and every daily prompt has an override:

- `1` — normal conditions
- `2` — hot/high-demand conditions
- `3` — desert/extreme conditions
- Other numeric values are allowed.

The multiplier applies only to water. A character with a base water requirement of `0.5` under a `×3` multiplier has an effective need of `1.5` per day, which naturally alternates whole-charge consumption through the fractional accumulator.

## Supply carriers / minions

Each tracked PC can be assigned one optional **Supply Carrier / Minion**. The carrier can be a world Actor or an unlinked token in the current scene.

When travel supplies are deducted, the module checks both the PC and the assigned carrier. The same carrier may be assigned to multiple PCs, which supports shared pack animals or wagons.

Shared stock is transaction-safe within a daily deduction: if several PCs draw from the same mule, the module keeps one mutable stock plan so the same last ration cannot be counted for multiple characters.

## Settlement days

Settlement expenses are deducted from the PC's carried WWN currency. SP is the default, with GP available as an option.

Choosing **Charge SP/GP Instead** treats the day's food and water as externally supplied and clears any fractional food/water remainder for the selected character. Choosing **Skip This Day** leaves fractional remainders untouched.

Currency detection first checks known WWN-style currency locations and then performs a conservative schema scan that excludes likely bank/total/treasure values. This is intended to tolerate WWN 2.x beta data-model changes.

## Installation

1. Put this repository in `Data/modules/road-provisions/`, or install it from your GitHub release manifest.
2. Restart Foundry if needed.
3. Enable **Road Provisions for Worlds Without Number** in the WWN world.
4. Open **Game Settings → Configure Settings → Road Provisions (WWN) → Open Tracker**.
5. Select the party tokens and click **Add Selected Tokens**.
6. Configure per-character food/water rates and optional supply carriers.

## Macro/API helpers

After Foundry's `ready` hook:

```js
game.modules.get("road-provisions").api.openTracker();
```

```js
game.modules.get("road-provisions").api.promptNow(1);
```

Troubleshooting helpers:

```js
game.modules.get("road-provisions").api.detectConsumable(item);
game.modules.get("road-provisions").api.detectCurrency(actor, "sp");
game.modules.get("road-provisions").api.matchingItems(actor, member, "food", defaults);
```

## Current feature update

- Fixed calendar display by using Foundry v14 calendar components directly.
- Replaced unsafe substring resource matching with whole-name/word matching.
- Added current/max charge detection and partial-bundle-first consumption.
- Added fractional food/water requirements with per-PC carry-forward state.
- Added a configurable daily water multiplier for hot/desert travel.
- Added per-PC supply carriers/minions, including support for a shared carrier.
- Improved WWN 2.x carried-currency detection.
- Updated the daily prompt to show stock source, carrier, and fractional carry state.

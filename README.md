# Crystal Dawn

A Tiberian Dawn–style 2D real-time strategy game that runs in the browser. Two factions, crystal
harvesting, base building, fog of war, air power, and a skirmish AI that builds, expands, and
attacks in growing waves. All art is original procedural pixel art drawn in code — no binary
assets, no external content.

Built with Vite + TypeScript + Canvas 2D. No runtime dependencies.

## Play

```bash
npm install
npm run dev
```

Open http://localhost:5189, pick a difficulty and a sector, and deploy.

**Objective:** destroy all enemy structures. You lose when you have no production buildings left
and no way to rebuild.

## Controls

| Input | Action |
|---|---|
| Left drag / click | Box select / select one |
| Right click | Move / attack / capture (engineer on enemy building) |
| Shift + order | Queue orders |
| A + click | Attack-move |
| Ctrl+1..9 / 1..9 | Set / recall control group |
| Z / X / C | Stance: explore (flees) / defensive (holds) / offensive |
| S | Sell selected structure (50% refund) · Stop for units |
| H / F1 | Field manual (all controls) |
| O | Toggle objectives panel |
| M | Mute · F debug overlay · R restart after defeat |

## Notes

- 20 Hz fixed-timestep deterministic simulation (seeded RNG, no `Math.random` in sim code);
  rendering interpolates at display rate.
- `SPEC.md` is the build contract: architecture, balance tables, and a full change log of every
  build phase, deviation, and post-release fix.
- `window.__game` exposes a debug/test API (spawn, give, reveal, speed, stance, capture, …).
- `npm run build` runs strict TypeScript checks plus the production build.

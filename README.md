[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/idzeko50-netizen/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/idzeko50-netizen/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Sokoban solver — push-optimal, room by room

A Node 22 program (`main.ts`, stdlib only, no network) that solves a set of
generated Sokoban levels in as few pushes as possible.

How it works: every generated level is a one-square-wide hallway with one to
four rooms off it, each holding 3–4 boxes and as many goals behind a single
door. A box pushed out of a door into the hallway can never come back, so
every box stays in its room and the rooms solve independently. The solver
splits a level into rooms, solves each room on its own with a breadth-first
search over pushes (the first solution found uses the fewest pushes), and
stitches the rooms together with walks along the hallway. The search prunes
dead squares (a box there can never reach a goal) and frozen 2×2 blocks, and
treats the player's whole reachable region as one state. All budgets are
counted in work (states searched), never in wall-clock time, so two runs
write identical bytes.

Practice-set score: **1,000,000** — every instance solved in exactly its
push-optimal count P* (13, 16, 29, 47, 60 pushes). The house baseline
plain-astar 1.0.0 scores 200,000 on the same set.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

One run answers all five instances (`/output/<id>/solution.txt`) in well
under the 60-second wall budget (about 0.7 s on the practice set).

See BUILD-NOTE.md for the build record: which repos were studied, what was
authored, per-instance scores, and the determinism check.

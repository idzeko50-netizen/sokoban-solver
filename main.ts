// Room-by-room push-optimal Sokoban solver.
//
// Strategy. Every generated level is a one-square-wide hallway with one to
// four rooms off it, each room holding 3-4 boxes and as many goals behind a
// single door. A box pushed out of a door into the hallway can never come
// back, so every box stays in its room and the rooms solve independently:
// the level's push optimum is the sum of its rooms' optima. This program
// therefore splits a level into rooms, solves each room on its own with a
// breadth-first search over pushes (so the first solution found uses the
// fewest pushes), and stitches the rooms' move strings together with walks
// along the hallway. All budgets are counted in work (states searched),
// never in wall-clock time, so two runs write identical bytes.
//
// The push search. A state is the boxes' squares plus the player's
// reachable region, named by its lowest square: any two player squares in
// the same region are the same state. From a state, every push the player
// can reach is one edge (cost 1), so breadth-first order is push-optimal.
// Two prunings keep the search small, and neither removes a solvable state:
//   - dead squares: a square from which no sequence of pushes, ignoring the
//     other boxes, can ever reach a goal (found by pulling backwards from
//     the goals). A box on one is lost.
//   - frozen 2x2 blocks: four squares of walls and boxes, one of them a box
//     off its goal, that no push can ever break apart.
// The search is plain breadth-first search with a transposition table; it
// knows no other heuristic. Rooms here are tiny (a 6x6 slot, 3-4 boxes),
// so this is fast and exact.
//
// Determinism. Iteration order is fixed everywhere (squares in index order,
// directions u, d, l, r), the search cuts off on a state count, and the
// program reads no clock, no randomness and no environment value except
// the input/output directories. Two executions write identical bytes.
//
// Original work: this file was written from scratch for this competition.
// The algorithm family (push search, dead squares, frozen blocks, room
// splitting) is the standard one used by the public Sokoban solvers named
// in the kit's RULES.txt (Festival, Sokolution, Takaken) and by the kit's
// own reference search; no code from any of them is copied or vendored.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** States one room search may keep before it gives up (work, not time). */
const ROOM_STATES = 250_000;
/** States the whole-level fallback search may keep before it gives up. */
const LEVEL_STATES = 250_000;

/** The four directions: [dx, dy, letter], in fixed order u, d, l, r. */
const DIRS: readonly (readonly [number, number, string])[] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goal = new Uint8Array(size);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, size, wall, goal, boxes, player };
}

/**
 * The squares a box can ever stand on and still reach a goal: start from
 * the goals and pull backwards. A box at y can be pulled to x (one step
 * towards the goal side) when the square beyond y is open floor for the
 * player to stand on; a square never reached this way is dead.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, size, wall, goal } = level;
  const live = new Uint8Array(size);
  const queue: number[] = [];
  for (let i = 0; i < size; i++) {
    if (goal[i]) {
      live[i] = 1;
      queue.push(i);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const behind = y - d;
      if (behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from` with the boxes in
 * `occupied` in the way, stamping them in `seen` with `stamp`; returns the
 * lowest square of the region (the region's name in a state key).
 */
function flood(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    // Neighbours, in fixed order so the fill is deterministic.
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (wall[up] === 0 && occupied[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    if (wall[down] === 0 && occupied[down] === 0 && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (wall[left] === 0 && occupied[left] === 0 && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    if (wall[right] === 0 && occupied[right] === 0 && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` is caught in a frozen 2x2 block:
 * four squares of walls and boxes, one of them a box off its goal. No push
 * can ever move a box out of such a block, so the state is dead.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  // The four 2x2 blocks that contain t, named by their top-left square.
  const tops = [t, t - 1, t - w, t - w - 1];
  for (const a of tops) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= level.size) continue;
    const filled =
      (wall[a] || occupied[a]) &&
      (wall[b] || occupied[b]) &&
      (wall[c] || occupied[c]) &&
      (wall[d] || occupied[d]);
    if (!filled) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/**
 * A state's key: the region's lowest square followed by the boxes' squares.
 * A number while size ** (boxes + 1) stays under 2 ** 53 (always true for a
 * room: at most 5 squares on a board of at most 255), else a string.
 */
function keyOf(boxes: number[], low: number, size: number, numeric: boolean): number | string {
  if (numeric) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}:${boxes.join(',')}`;
}

/** The shortest walk from `from` to `to` around walls and boxes, in LURD letters. */
function walkPath(level: Level, occupied: Uint8Array, from: number, to: number): string | null {
  if (from === to) return '';
  const { w, wall, size } = level;
  const prev = new Int32Array(size).fill(-1);
  const how = new Int8Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const [dx, dy] = DIRS[k]!;
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = k;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = DIRS[how[p]!]![2] + s;
  return s;
}

/** The square the player stands on after walking `moves` (LURD) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) {
    if (ch === 'u') p -= w;
    else if (ch === 'd') p += w;
    else if (ch === 'l') p -= 1;
    else if (ch === 'r') p += 1;
  }
  return p;
}

/**
 * Push-optimal solution of `level` by breadth-first search over pushes:
 * {pushes, moves} (moves in LURD, lower case), or null when the search
 * gives up (maxStates states kept) or the level cannot be solved. The
 * first solved state breadth-first search meets uses the fewest pushes.
 */
function solvePushes(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, size, wall, goal } = level;
  const live = liveSquares(level);
  for (const b of level.boxes) if (!live[b]) return null;
  const numericKey = Math.pow(size, level.boxes.length + 1) < 2 ** 53;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  // The states in breadth-first order: boxes, player square, parent index,
  // and the direction of the push that made the state (-1 for the start).
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sDir: number[] = [-1];
  const index = new Map<number | string, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = flood(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  index.set(keyOf(level.boxes, startLow, size, numericKey), 0);

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head]!;
    const player = sPlayer[head]!;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    flood(level, occupied, player, seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k]!;
        const d = dy * w + dx;
        const behind = b - d;
        const t = b + d;
        if (seen[behind] !== here) continue; // player cannot reach the push square
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        // The child's region is flood-filled into `mark`, a second stamp
        // array: the parent's region in `seen` must survive untouched, as
        // the push-square checks below still read it.
        const low = flood(level, occupied, b, mark, ++stamp, stack);
        const key = keyOf(next, low, size, numericKey);
        occupied[t] = 0;
        occupied[b] = 1;
        if (index.has(key)) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, sBoxes.length);
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(head);
        sDir.push(k);
        if (solved(next)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const k = DIRS.findIndex(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    const walk = walkPath(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null; // cannot happen: the push square was reachable
    moves += walk + DIRS[k]![2];
    player = from;
    boxes = nextBoxes.slice();
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  /** The door square: the room square touching the hallway row. */
  door: number;
  /** The hallway square just outside the door; the player starts here. */
  outside: number;
}

/**
 * Split a level into rooms: cut the hallway row's dead squares out of the
 * floor (a box there reaches no goal), and each remaining floor component
 * holding boxes is a room. Returns null when the level is no set of rooms
 * (a box starts in the hallway, a goal lies outside every room, or some
 * room holds a different count of boxes and goals).
 */
function findRooms(level: Level): Room[] | null {
  const { w, size, wall, goal, boxes, player } = level;
  const live = liveSquares(level);
  const hallRow = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = hallRow * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;

  const part = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], door: -1, outside: -1 });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (let g = 0; g < size; g++) {
    if (!goal[g]) continue;
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;

  const kept: Room[] = [];
  for (const room of rooms) {
    if (room.boxes.length === 0) continue;
    // The door is the room's one square touching the hallway row; the
    // square just outside it, in the hallway row, is where the player
    // enters from.
    let door = -1;
    let outside = -1;
    for (const s of room.squares) {
      for (const [dx, dy] of DIRS) {
        const q = s + dy * w + dx;
        if (Math.floor(q / w) === hallRow && !wall[q]) {
          door = s;
          outside = q;
        }
      }
    }
    if (door < 0) return null;
    room.door = door;
    room.outside = outside;
    kept.push(room);
  }
  return kept;
}

/**
 * Solve a whole level: room by room when it splits into rooms, else one
 * push search over the whole level. Returns the move string, or '' when
 * the search gives up (an empty answer is valid and scores 0).
 */
function solveLevel(level: Level): string {
  const rooms = findRooms(level);
  if (rooms === null) {
    const whole = solvePushes(level, LEVEL_STATES);
    return whole === null ? '' : whole.moves;
  }

  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  const occupied = new Uint8Array(level.size);

  for (const room of rooms) {
    if (room.boxes.every((b) => level.goal[b])) continue; // already solved
    // The room on its own board: only its squares and the hallway square
    // outside its door are open; the player starts outside the door, as
    // the generator's own room check does.
    const subWall = new Uint8Array(level.size).fill(1);
    for (const s of room.squares) subWall[s] = 0;
    subWall[room.outside] = 0;
    const subGoal = new Uint8Array(level.size);
    for (const g of room.goals) subGoal[g] = 1;
    const sub: Level = {
      w: level.w,
      h: level.h,
      size: level.size,
      wall: subWall,
      goal: subGoal,
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player: room.outside,
    };
    const solved = solvePushes(sub, ROOM_STATES);
    if (solved === null) {
      // A room the search could not finish: fall back to one search over
      // the whole level before giving up on the instance.
      const whole = solvePushes(level, LEVEL_STATES);
      return whole === null ? '' : whole.moves;
    }
    // Walk from where the player stands to the room's door, then play the
    // room's moves. The other rooms' boxes stand as walls for the walk.
    for (const b of boxes) occupied[b] = 1;
    const walk = walkPath(level, occupied, player, room.outside);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return ''; // cannot happen on generated levels
    const roomMoves = walk + solved.moves;
    moves += roomMoves;
    player = endOf(level.w, player, roomMoves);
    // The room's boxes now sit on its goals.
    const done = new Set(room.goals);
    boxes = boxes.filter((b) => !room.boxes.includes(b));
    for (const g of room.goals) boxes.push(g);
    boxes.sort((a, b) => a - b);
    void done;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

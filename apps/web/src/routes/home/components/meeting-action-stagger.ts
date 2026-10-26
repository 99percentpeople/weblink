export interface ActionArcRow {
  radius: number;
  start: number;
  end: number;
}

const TAU = Math.PI * 2;
const EPSILON = 1e-7;
// The buttons are axis-aligned 48px squares, including their labels.
const CLEARANCE = 50;

const isCircle = (row: ActionArcRow) =>
  row.end - row.start >= TAU - EPSILON;

function rowAngles(
  row: ActionArcRow,
  count: number,
): number[] {
  const closed = isCircle(row);
  const span = closed
    ? TAU
    : Math.min(
        row.end - row.start,
        (TAU * (count - 1)) / count,
      );
  const start = closed
    ? -Math.PI / 2
    : (row.start + row.end - span) / 2;
  return Array.from(
    { length: count },
    (_, index) =>
      start +
      (count === 1
        ? 0
        : (span * index) / (closed ? count : count - 1)),
  );
}

function point(radius: number, angle: number) {
  return {
    x: radius * Math.cos(angle),
    y: radius * Math.sin(angle),
    angle,
  };
}

type Slot = ReturnType<typeof point>;

function separated(a: Slot, b: Slot): boolean {
  return (
    Math.abs(a.x - b.x) >= CLEARANCE - EPSILON ||
    Math.abs(a.y - b.y) >= CLEARANCE - EPSILON
  );
}

/** Place inner controls between outer controls, retaining their action order. */
export function staggerActionRows(
  rows: readonly ActionArcRow[],
  counts: readonly number[],
): number[][] | undefined {
  const angles = rows.map((row, index) =>
    rowAngles(row, counts[index]),
  );
  if (rows.length === 1) return angles;
  const [inner, outer] = rows;
  const [inside, outside] = angles;
  const outerSlots = outside.map((angle) =>
    point(outer.radius, angle),
  );
  const gaps = outside
    .slice(0, isCircle(outer) ? undefined : -1)
    .map(
      (angle, index) =>
        (angle + (outside[index + 1] ?? outside[0] + TAU)) /
        2,
    );
  const halfCell =
    inside.length === 1
      ? (inner.end - inner.start) / 2
      : (inside[1] - inside[0]) / 2;
  const choices = inside.map((target) => {
    const nearest = gaps
      .map(
        (angle) =>
          angle + Math.round((target - angle) / TAU) * TAU,
      )
      .sort((a, b) => {
        const difference =
          Math.abs(a - target) - Math.abs(b - target);
        return Math.abs(difference) < EPSILON
          ? a - b
          : difference;
      })
      .slice(0, 2);
    // Prefer the gaps; partial offsets and the original position let the
    // viewport edge or a neighbouring inner control constrain the stagger.
    const candidates = [
      ...nearest,
      ...nearest.map((angle) => (angle + target) / 2),
      target,
    ];
    return [...new Set(candidates)]
      .filter(
        (angle) =>
          Math.abs(angle - target) <= halfCell + EPSILON &&
          (isCircle(inner) ||
            (angle >= inner.start - EPSILON &&
              angle <= inner.end + EPSILON)),
      )
      .map((angle) => point(inner.radius, angle))
      .filter((slot) =>
        outerSlots.every((other) => separated(slot, other)),
      );
  });
  if (choices.some((slots) => !slots.length)) return;
  const selected: Slot[] = [];
  // Bound the search during drag/resize. A wider row gap remains available
  // when a very constrained set of slots cannot be packed quickly.
  let remaining = 256;
  const place = (index: number): boolean => {
    if (index === choices.length) return true;
    for (const slot of choices[index]) {
      if (--remaining < 0) return false;
      if (
        !selected.every((other) => separated(slot, other))
      )
        continue;
      selected.push(slot);
      if (place(index + 1)) return true;
      selected.pop();
    }
    return false;
  };
  if (place(0))
    return [selected.map((slot) => slot.angle), outside];
}

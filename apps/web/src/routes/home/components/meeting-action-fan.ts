import { staggerActionRows } from "./meeting-action-stagger";

export interface ActionFanSpace {
  width: number;
  height: number;
  x: number;
  y: number;
  size: number;
}

export interface ActionFanLayout {
  shape: "circle" | "fan";
  points: { x: number; y: number }[];
  radius: number;
  path: string;
}

// Match the 3rem action targets; diagonal clearance keeps their hit areas apart.
const ITEM_SIZE = 48;
const STEP = Math.ceil(ITEM_SIZE * Math.SQRT2) + 4;
const INNER_RADIUS = 70;
const COMPACT_FAN_RADIUS = INNER_RADIUS + STEP / 2;
const TAU = Math.PI * 2;
const PADDING = ITEM_SIZE / 2 + 6;
const EPSILON = 1e-7;

interface Arc {
  start: number;
  end: number;
}

interface Row extends Arc {
  radius: number;
}

interface Placement {
  rows: Row[];
  counts: number[];
  total: number;
  angles?: number[][];
}

interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function circlePath(
  x: number,
  y: number,
  radius: number,
  sweep = 1,
): string {
  return `M ${x + radius} ${y} A ${radius} ${radius} 0 1 ${sweep} ${x - radius} ${y} A ${radius} ${radius} 0 1 ${sweep} ${x + radius} ${y} Z`;
}

/** Give every occupied row the same width and rounded ends. */
function ringPath(
  radius: number,
  padding: number,
  start: number,
  end: number,
): string {
  if (end - start < 0.001)
    return circlePath(
      Math.cos(start) * radius,
      Math.sin(start) * radius,
      padding,
    );
  const inner = radius - padding;
  const outer = radius + padding;
  if (end - start >= TAU - 0.001)
    return `${circlePath(0, 0, outer)} ${circlePath(0, 0, inner, 0)}`;
  const point = (r: number, angle: number) =>
    `${Math.cos(angle) * r} ${Math.sin(angle) * r}`;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)} A ${padding} ${padding} 0 0 1 ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} A ${padding} ${padding} 0 0 1 ${point(outer, start)} Z`;
}

const isCircle = (arc: Arc) =>
  arc.end - arc.start >= TAU - EPSILON;

/** One continuous surface across both layers, with rounded side edges. */
function mergedRingPath(
  inner: Row,
  outer: Row,
  inside: number[],
  outside: number[],
): string {
  const innerRadius = inner.radius - PADDING;
  const outerRadius = outer.radius + PADDING;
  if (isCircle(inner) && isCircle(outer))
    return `${circlePath(0, 0, outerRadius)} ${circlePath(0, 0, innerRadius, 0)}`;
  const outerStart = outside[0];
  const outerEnd = outside.at(-1)!;
  const innerStart = Math.min(
    inside[0],
    Math.max(inner.start, outerStart),
  );
  const innerEnd = Math.max(
    inside.at(-1)!,
    Math.min(inner.end, outerEnd),
  );
  const point = (
    radius: number,
    angle: number,
    tangent = 0,
  ) => ({
    x: radius * Math.cos(angle) - tangent * Math.sin(angle),
    y: radius * Math.sin(angle) + tangent * Math.cos(angle),
  });
  const xy = (p: { x: number; y: number }) =>
    `${p.x} ${p.y}`;
  const outerEndCap = point(
    outer.radius,
    outerEnd,
    PADDING,
  );
  const innerEndCap = point(
    inner.radius,
    innerEnd,
    PADDING,
  );
  const innerStartCap = point(
    inner.radius,
    innerStart,
    -PADDING,
  );
  const outerStartCap = point(
    outer.radius,
    outerStart,
    -PADDING,
  );
  const side = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    fromAngle: number,
    toAngle: number,
    direction: number,
  ) => {
    const length =
      Math.hypot(to.x - from.x, to.y - from.y) / 3;
    const a = point(direction * length, fromAngle);
    const b = point(-direction * length, toAngle);
    return `C ${xy({ x: from.x + a.x, y: from.y + a.y })} ${xy({ x: to.x + b.x, y: to.y + b.y })} ${xy(to)}`;
  };
  return [
    `M ${xy(point(outerRadius, outerStart))}`,
    `A ${outerRadius} ${outerRadius} 0 ${outerEnd - outerStart > Math.PI ? 1 : 0} 1 ${xy(point(outerRadius, outerEnd))}`,
    `A ${PADDING} ${PADDING} 0 0 1 ${xy(outerEndCap)}`,
    side(outerEndCap, innerEndCap, outerEnd, innerEnd, -1),
    `A ${PADDING} ${PADDING} 0 0 1 ${xy(point(innerRadius, innerEnd))}`,
    `A ${innerRadius} ${innerRadius} 0 ${innerEnd - innerStart > Math.PI ? 1 : 0} 0 ${xy(point(innerRadius, innerStart))}`,
    `A ${PADDING} ${PADDING} 0 0 1 ${xy(innerStartCap)}`,
    side(
      innerStartCap,
      outerStartCap,
      innerStart,
      outerStart,
      1,
    ),
    `A ${PADDING} ${PADDING} 0 0 1 ${xy(point(outerRadius, outerStart))} Z`,
  ].join(" ");
}

/** Intersect a row with the viewport inset once for its buttons and caps. */
function visibleArcs(
  radius: number,
  bounds: Bounds,
): Arc[] {
  const cuts = [0, TAU];
  const add = (angle: number) =>
    cuts.push(((angle % TAU) + TAU) % TAU);
  for (const x of [bounds.left, bounds.right]) {
    if (Math.abs(x) >= radius) continue;
    const angle = Math.acos(x / radius);
    add(angle);
    add(-angle);
  }
  for (const y of [bounds.top, bounds.bottom]) {
    if (Math.abs(y) >= radius) continue;
    const angle = Math.asin(y / radius);
    add(angle);
    add(Math.PI - angle);
  }
  cuts.sort((a, b) => a - b);
  const arcs: Arc[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const start = cuts[i - 1];
    const end = cuts[i];
    if (end - start < EPSILON) continue;
    const middle = (start + end) / 2;
    const x = Math.cos(middle) * radius;
    const y = Math.sin(middle) * radius;
    if (
      x < bounds.left - EPSILON ||
      x > bounds.right + EPSILON ||
      y < bounds.top - EPSILON ||
      y > bounds.bottom + EPSILON
    )
      continue;
    const previous = arcs.at(-1);
    if (
      previous &&
      Math.abs(previous.end - start) < EPSILON
    )
      previous.end = end;
    else arcs.push({ start, end });
  }
  const first = arcs[0];
  const last = arcs.at(-1);
  if (
    arcs.length > 1 &&
    first.start === 0 &&
    last!.end === TAU
  ) {
    last!.end = first.end + TAU;
    arcs.shift();
  }
  return arcs;
}

function capacity(row: Row): number {
  const step = 2 * Math.asin(STEP / (2 * row.radius));
  const closed = Math.floor(TAU / step + EPSILON);
  return isCircle(row)
    ? closed
    : Math.min(
        closed,
        Math.floor((row.end - row.start) / step + EPSILON) +
          1,
      );
}

function fitRows(
  rows: Row[],
  count: number,
  preferredSplit: boolean,
): Placement | undefined {
  const capacities = rows.map(capacity);
  if (rows.length === 1) {
    const total = Math.min(count, capacities[0]);
    return { rows, counts: [total], total };
  }
  const [inner, outer] = capacities;
  if (preferredSplit) {
    // Reserve about two thirds for the outer row before choosing a radius.
    // Filling the inner row first can otherwise win just by fitting sooner.
    for (
      let total = Math.min(count, inner + outer);
      total >= 3;
      total--
    ) {
      const inside = Math.round(total / 3);
      if (inside <= inner && total - inside <= outer)
        return {
          rows,
          counts: [inside, total - inside],
          total,
        };
    }
    return;
  }
  // Relax the preferred split only if the viewport cannot fit all actions.
  const total = Math.min(
    count,
    inner + outer,
    outer * 2 - 1,
  );
  if (total < 3) return;
  const minimum = Math.max(1, total - outer);
  const maximum = Math.min(
    inner,
    Math.floor((total - 1) / 2),
  );
  const inside = Math.max(
    minimum,
    Math.min(maximum, Math.round(total / 3)),
  );
  return { rows, counts: [inside, total - inside], total };
}

function placementCost(placement: Placement): number {
  const outer = placement.rows.at(-1)!;
  if (placement.rows.every(isCircle))
    return outer.radius + (placement.rows.length - 1) * 12;
  // A large single arc leaves all the space nearer the dot empty. Let a
  // second row fill it even when its outer edge reaches a little farther.
  const emptySpace =
    placement.rows.length === 1
      ? Math.max(0, outer.radius - COMPACT_FAN_RADIUS)
      : 0;
  return outer.radius + emptySpace * 2;
}

function prefer(
  candidate: Placement,
  best: Placement | undefined,
): boolean {
  if (!best || candidate.total !== best.total)
    return !best || candidate.total > best.total;
  return (
    placementCost(candidate) < placementCost(best) - EPSILON
  );
}

/** Try compact staggered layers before wider spacing; refine the first fit. */
function findPlacement(
  count: number,
  limit: number,
  arcsAt: (radius: number) => Arc[],
  direction: number,
  preferredSplit = true,
): Placement | undefined {
  let best: Placement | undefined;
  for (const rowGap of [
    0,
    ITEM_SIZE + 6,
    ITEM_SIZE + 12,
    STEP,
  ]) {
    const rowCount = rowGap === 0 ? 1 : 2;
    let rowBest: Placement | undefined;
    if (rowCount === 2 && count < 3) continue;
    const minimum = INNER_RADIUS + rowGap;
    if (minimum > limit) continue;
    const at = (radius: number, required: number) => {
      let fit: Placement | undefined;
      let alignment = -Infinity;
      for (const outer of arcsAt(radius)) {
        const inners =
          rowCount === 1
            ? [outer]
            : arcsAt(radius - rowGap);
        for (let inner of inners) {
          if (rowCount === 2) {
            // Keep both rows in the same connected part of the viewport.
            // A full inner circle follows the outer sector when it is clipped.
            if (isCircle(inner) && !isCircle(outer))
              inner = outer;
            const shift =
              Math.round(
                (outer.start +
                  outer.end -
                  inner.start -
                  inner.end) /
                  (2 * TAU),
              ) * TAU;
            inner = {
              start: inner.start + shift,
              end: inner.end + shift,
            };
            if (
              Math.min(inner.end, outer.end) <
              Math.max(inner.start, outer.start)
            )
              continue;
          }
          const rows = [
            ...(rowCount === 2
              ? [{ ...inner, radius: radius - rowGap }]
              : []),
            { ...outer, radius },
          ];
          const candidate = fitRows(
            rows,
            count,
            preferredSplit,
          );
          if (!candidate || candidate.total < required)
            continue;
          candidate.angles = staggerActionRows(
            rows,
            candidate.counts,
          );
          if (!candidate.angles) continue;
          const facing = Math.cos(
            (outer.start + outer.end) / 2 - direction,
          );
          if (
            !fit ||
            candidate.total > fit.total ||
            (candidate.total === fit.total &&
              facing > alignment)
          ) {
            fit = candidate;
            alignment = facing;
          }
        }
      }
      return fit;
    };
    const increment = STEP / 12;
    for (
      let radius = minimum;
      ;
      radius = Math.min(limit, radius + increment)
    ) {
      // Do collision/offset work only for a count that can improve this row.
      let candidate = at(
        radius,
        Math.max(
          best?.total ?? 1,
          (rowBest?.total ?? 0) + 1,
        ),
      );
      if (candidate && prefer(candidate, rowBest)) {
        let low = Math.max(minimum, radius - increment);
        let high = radius;
        const total = candidate.total;
        for (
          let i = 0;
          i < 20 && high - low > EPSILON;
          i++
        ) {
          const middle = (low + high) / 2;
          const fit = at(middle, total);
          if (fit && fit.total >= total) {
            candidate = fit;
            high = middle;
          } else low = middle;
        }
        if (prefer(candidate, rowBest)) rowBest = candidate;
      }
      if (candidate?.total === count || radius === limit)
        break;
      // Use the same cost bound as selection, so a compact second row is
      // still considered beyond the single row's unpenalized radius.
      if (
        best?.total === count &&
        radius >= placementCost(best)
      )
        break;
    }
    if (rowBest && prefer(rowBest, best)) best = rowBest;
  }
  return best;
}

function renderPlacement(
  placement: Placement,
): ActionFanLayout {
  const points: ActionFanLayout["points"] = [];
  placement.rows.forEach((row, index) => {
    const angles = placement.angles![index];
    for (const angle of angles) {
      points.push({
        x: Math.cos(angle) * row.radius,
        y: Math.sin(angle) * row.radius,
      });
    }
  });
  const first = placement.rows[0];
  const angles = placement.angles![0];
  const path =
    placement.rows.length > 1
      ? mergedRingPath(
          first,
          placement.rows[1],
          angles,
          placement.angles![1],
        )
      : ringPath(
          first.radius,
          PADDING,
          angles[0],
          isCircle(first) && angles.length > 1
            ? angles[0] + TAU
            : angles.at(-1)!,
        );
  return {
    shape: placement.rows.every(isCircle)
      ? "circle"
      : "fan",
    points,
    radius: placement.rows.at(-1)!.radius + PADDING,
    path,
  };
}

/** Prefer complete rings; otherwise fit up to two annular rows to the viewport. */
export function layoutActionFan(
  count: number,
  space: ActionFanSpace | undefined,
): ActionFanLayout | undefined {
  if (!space || count < 1) return;
  const cx = space.x + space.size / 2;
  const cy = space.y + space.size / 2;
  const bounds: Bounds = {
    left: PADDING - cx,
    right: space.width - cx - PADDING,
    top: PADDING - cy,
    bottom: space.height - cy - PADDING,
  };
  if (
    bounds.left >= bounds.right ||
    bounds.top >= bounds.bottom
  )
    return;
  const direction = Math.atan2(
    space.height / 2 - cy,
    space.width / 2 - cx,
  );
  const circleLimit = Math.min(
    -bounds.left,
    bounds.right,
    -bounds.top,
    bounds.bottom,
  );
  const circle = findPlacement(
    count,
    circleLimit,
    () => [{ start: -Math.PI / 2, end: (Math.PI * 3) / 2 }],
    direction,
  );
  if (circle?.total === count)
    return renderPlacement(circle);
  const limit = Math.hypot(
    Math.max(Math.abs(bounds.left), Math.abs(bounds.right)),
    Math.max(Math.abs(bounds.top), Math.abs(bounds.bottom)),
  );
  const arcsAt = (radius: number) =>
    visibleArcs(radius, bounds);
  const fan = findPlacement(
    count,
    limit,
    arcsAt,
    direction,
  );
  if (fan?.total === count) return renderPlacement(fan);
  // Keep every action reachable before paginating just to preserve a ratio.
  const fallback = findPlacement(
    count,
    limit,
    arcsAt,
    direction,
    false,
  );
  const placement =
    fallback && (!fan || fallback.total > fan.total)
      ? fallback
      : fan;
  return placement ? renderPlacement(placement) : undefined;
}

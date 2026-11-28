import type { LayoutFile, Vec3 } from './types';

/**
 * Reid (+X anterior, +Y left, +Z superior) to the scene.
 * Scene is right-handed: +X patient's right, +Y superior, +Z posterior.
 * The face points toward -Z, so a camera in front of the face looks along +Z.
 */
export function reidToScene(v: Vec3): Vec3 {
  return [-v[1], v[2], -v[0]];
}

/** Schematic position. `anatomic` is 0 at the spread layout and 1 at the clustered one. */
export function nodePosition(layout: LayoutFile, id: string, anatomic: number): Vec3 {
  const fixed = layout.fixed[id];
  const spread = layout.spread[id] ?? fixed;
  const clustered = layout.anatomic[id] ?? spread;
  if (!spread) return [0, 0, 0];
  if (!layout.spread[id] || anatomic <= 0) return spread;
  if (anatomic >= 1) return clustered ?? spread;
  const from = spread;
  const to = clustered ?? spread;
  return [
    from[0] + (to[0] - from[0]) * anatomic,
    from[1] + (to[1] - from[1]) * anatomic,
    from[2] + (to[2] - from[2]) * anatomic,
  ];
}

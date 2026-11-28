import type { GraphEdge, GraphFile } from './types';

/**
 * Nodes reached by walking edges in both directions.
 * `stopIds` are included, then not expanded, so an eye does not pull in every muscle.
 */
export function connectedIds(graph: GraphFile, startId: string, stopIds: ReadonlySet<string> = new Set()): string[] {
  if (!graph.nodes.some((node) => node.id === startId)) return [];
  const seen = new Set<string>([startId]);
  const queue = [startId];
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const from = outgoing.get(edge.from) ?? [];
    from.push(edge.to);
    outgoing.set(edge.from, from);
    const to = incoming.get(edge.to) ?? [];
    to.push(edge.from);
    incoming.set(edge.to, to);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id !== startId && stopIds.has(id)) continue;
    for (const next of [...(outgoing.get(id) ?? []), ...(incoming.get(id) ?? [])]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

/**
 * Canals reached by walking only excitatory drive edges upstream.
 * This is the canal a muscle "comes from" when several canals also inhibit the same nucleus.
 */
/**
 * Downstream excitatory links only (sign > 0), including zero-weight nerve tubes.
 * Inhibitory edges are left out, so a canal click does not light the opposing pathway.
 */
export function excitatoryChain(graph: GraphFile, startId: string, stopIds: ReadonlySet<string> = new Set()): string[] {
  if (!graph.nodes.some((node) => node.id === startId)) return [];
  const seen = new Set<string>([startId]);
  const queue = [startId];
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.sign <= 0) continue;
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id !== startId && stopIds.has(id)) continue;
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}

export function excitatoryCanals(graph: GraphFile, startId: string, canalIds: ReadonlySet<string>): string[] {
  const canals = new Set<string>();
  const seen = new Set<string>();
  const queue = [startId];
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!(edge.weight > 0) || edge.sign <= 0) continue;
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (canalIds.has(id)) {
      canals.add(id);
      continue;
    }
    for (const edge of incoming.get(id) ?? []) queue.push(edge.from);
  }
  return [...canals];
}

/**
 * Layered layout for the check flow chart. Checks are steps: every step without precursors
 * hangs off an implicit start node (the target itself); a step with precursors sits one
 * column to the right of the furthest one it waits on. Steps nothing waits on are end nodes.
 */
export interface FlowStep {
  id: string;
  name: string;
  type: 'ping' | 'tcp' | 'http';
  enabled?: boolean;
  depends_on?: string[] | undefined;
}

export interface FlowNode {
  id: string;
  label: string;
  type: FlowStep['type'] | 'start';
  /** Column index; the start node is column 0. */
  column: number;
  /** Row index within the column. */
  row: number;
  enabled: boolean;
  /** True when no other step waits on this one. */
  terminal: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  columns: number;
  /** Tallest column, in rows. */
  rows: number;
}

export const FLOW_START_ID = '__start__';

/**
 * Computes columns from dependency depth and packs each column top to bottom in step order.
 * Dependencies on unknown IDs are ignored so a half-edited draft still renders.
 */
export function layoutFlow(steps: readonly FlowStep[], startLabel: string): FlowLayout {
  const known = new Set(steps.map((step) => step.id));
  const depth = new Map<string, number>();
  const edges: FlowEdge[] = [];
  const waitedOn = new Set<string>();
  for (const step of steps) {
    const precursors = (step.depends_on ?? []).filter((id) => known.has(id) && depth.has(id));
    const column = precursors.length
      ? Math.max(...precursors.map((id) => depth.get(id)!)) + 1
      : 1;
    depth.set(step.id, column);
    if (precursors.length === 0) edges.push({ from: FLOW_START_ID, to: step.id });
    for (const id of precursors) {
      edges.push({ from: id, to: step.id });
      waitedOn.add(id);
    }
  }
  const rowsByColumn = new Map<number, number>();
  const nextRow = (column: number): number => {
    const row = rowsByColumn.get(column) ?? 0;
    rowsByColumn.set(column, row + 1);
    return row;
  };
  const nodes: FlowNode[] = [
    {
      id: FLOW_START_ID,
      label: startLabel,
      type: 'start',
      column: 0,
      row: nextRow(0),
      enabled: true,
      terminal: steps.length === 0,
    },
    ...steps.map((step) => {
      const column = depth.get(step.id)!;
      return {
        id: step.id,
        label: step.name || step.id || 'Untitled',
        type: step.type,
        column,
        row: nextRow(column),
        enabled: step.enabled ?? true,
        terminal: !waitedOn.has(step.id),
      };
    }),
  ];
  return {
    nodes,
    edges,
    columns: Math.max(...rowsByColumn.keys()) + 1,
    rows: Math.max(...rowsByColumn.values()),
  };
}

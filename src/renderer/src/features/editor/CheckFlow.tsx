import { useMemo } from 'react';
import { FLOW_START_ID, layoutFlow, type FlowNode, type FlowStep } from '@core/flow';

const NODE_W = 150;
const NODE_H = 40;
const COL_GAP = 56;
const ROW_GAP = 14;
const PAD = 12;

const centre = (node: FlowNode) => ({
  x: PAD + node.column * (NODE_W + COL_GAP),
  y: PAD + node.row * (NODE_H + ROW_GAP),
});

/**
 * Flow chart of a check list as steps: the target is the single start node, every step with no
 * precursor branches off it, and steps that wait on others sit to the right of them. Steps
 * nothing waits on are the end nodes.
 */
export function CheckFlow({
  steps,
  startLabel,
  selectedId,
  onSelect,
}: {
  steps: readonly FlowStep[];
  startLabel: string;
  selectedId?: string | undefined;
  onSelect?(id: string): void;
}) {
  const layout = useMemo(() => layoutFlow(steps, startLabel), [steps, startLabel]);
  const positions = new Map(layout.nodes.map((node) => [node.id, centre(node)]));
  const width = PAD * 2 + layout.columns * NODE_W + (layout.columns - 1) * COL_GAP;
  const height = PAD * 2 + layout.rows * NODE_H + (layout.rows - 1) * ROW_GAP;
  const ends = layout.nodes.filter((node) => node.terminal && node.id !== FLOW_START_ID).length;
  return (
    <div className="check-flow" aria-label="Check flow">
      <div className="check-flow-scroll">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${steps.length} steps, ${layout.columns - 1} stages, ${ends} end ${ends === 1 ? 'node' : 'nodes'}`}
        >
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 8 8"
              refX="8"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0L8 4L0 8z" className="flow-arrow-head" />
            </marker>
          </defs>
          {layout.edges.map((edge) => {
            const from = positions.get(edge.from)!;
            const to = positions.get(edge.to)!;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const bend = (x2 - x1) / 2;
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                className="flow-edge"
                d={`M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                markerEnd="url(#flow-arrow)"
              />
            );
          })}
          {layout.nodes.map((node) => {
            const { x, y } = positions.get(node.id)!;
            const selectable = node.type !== 'start' && onSelect;
            const classes = [
              'flow-node',
              `flow-${node.type}`,
              node.enabled ? '' : 'flow-disabled',
              node.terminal ? 'flow-end' : '',
              node.id === selectedId ? 'flow-selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <g
                key={node.id}
                className={classes}
                transform={`translate(${x} ${y})`}
                {...(selectable
                  ? { role: 'button', tabIndex: 0, onClick: () => onSelect(node.id) }
                  : {})}
                {...(selectable
                  ? {
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.key === 'Enter' || event.key === ' ') onSelect(node.id);
                      },
                    }
                  : {})}
              >
                <rect width={NODE_W} height={NODE_H} rx={node.type === 'start' ? NODE_H / 2 : 8} />
                {node.type !== 'start' && (
                  <text className="flow-type" x={10} y={15}>
                    {node.type.toUpperCase()}
                  </text>
                )}
                <text className="flow-label" x={10} y={node.type === 'start' ? 25 : 30}>
                  <title>{node.label}</title>
                  {node.label.length > 20 ? `${node.label.slice(0, 19)}…` : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p className="check-flow-caption">
        One start node, {layout.columns - 1} stage{layout.columns - 1 === 1 ? '' : 's'},{' '}
        {ends} end node{ends === 1 ? '' : 's'}. A step runs only after every step feeding it
        passes; disabled steps are dimmed.
      </p>
    </div>
  );
}

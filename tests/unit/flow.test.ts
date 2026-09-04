import { describe, expect, it } from 'vitest';
import { FLOW_START_ID, layoutFlow, type FlowStep } from '@core/flow';
import { placeholderUsages } from '@core/templates';

const steps: FlowStep[] = [
  { id: 'ping', name: 'Ping', type: 'ping' },
  { id: 'rdp', name: 'RDP', type: 'tcp', depends_on: ['ping'] },
  { id: 'ssh', name: 'SSH', type: 'tcp', depends_on: ['ping'] },
  { id: 'web', name: 'Web', type: 'http', depends_on: ['rdp', 'ssh'], enabled: false },
  { id: 'dns', name: 'DNS', type: 'tcp' },
];

describe('layoutFlow', () => {
  it('hangs roots off the start node and places each step after its furthest precursor', () => {
    const layout = layoutFlow(steps, '10.0.0.1');
    const at = (id: string) => layout.nodes.find((node) => node.id === id)!;
    expect(at(FLOW_START_ID)).toMatchObject({ column: 0, row: 0, type: 'start', label: '10.0.0.1' });
    expect(at('ping')).toMatchObject({ column: 1, row: 0, terminal: false });
    expect(at('dns')).toMatchObject({ column: 1, row: 1, terminal: true });
    expect(at('rdp')).toMatchObject({ column: 2, row: 0 });
    expect(at('ssh')).toMatchObject({ column: 2, row: 1 });
    expect(at('web')).toMatchObject({ column: 3, row: 0, terminal: true, enabled: false });
    expect(layout.columns).toBe(4);
    expect(layout.rows).toBe(2);
    expect(layout.edges).toEqual([
      { from: FLOW_START_ID, to: 'ping' },
      { from: 'ping', to: 'rdp' },
      { from: 'ping', to: 'ssh' },
      { from: 'rdp', to: 'web' },
      { from: 'ssh', to: 'web' },
      { from: FLOW_START_ID, to: 'dns' },
    ]);
  });

  it('ignores dependencies on unknown or later steps so a draft still renders', () => {
    const layout = layoutFlow(
      [
        { id: 'a', name: 'A', type: 'ping', depends_on: ['b', 'ghost'] },
        { id: 'b', name: 'B', type: 'ping' },
      ],
      'host',
    );
    expect(layout.nodes.map((node) => [node.id, node.column])).toEqual([
      [FLOW_START_ID, 0],
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('renders an empty draft as a lone start node', () => {
    const layout = layoutFlow([], 'host');
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]?.terminal).toBe(true);
    expect(layout.columns).toBe(1);
  });
});

describe('placeholderUsages', () => {
  it('reports every field that reads a placeholder', () => {
    const usages = placeholderUsages({
      checks: [
        {
          id: 'web',
          name: 'Web {{name}}',
          type: 'http',
          url: 'https://{{host}}:{{vars.web_port}}/',
          method: 'GET',
          expected_status: 200,
          headers: { Host: '{{vars.vhost}}' },
          verify_tls: true,
          follow_redirects: true,
          enabled: true,
          tags: [],
        },
      ],
    });
    expect(usages).toEqual([
      { name: 'name', checkId: 'web', checkName: 'Web {{name}}', field: 'name', value: 'Web {{name}}' },
      {
        name: 'host',
        checkId: 'web',
        checkName: 'Web {{name}}',
        field: 'url',
        value: 'https://{{host}}:{{vars.web_port}}/',
      },
      {
        name: 'vars.web_port',
        checkId: 'web',
        checkName: 'Web {{name}}',
        field: 'url',
        value: 'https://{{host}}:{{vars.web_port}}/',
      },
      {
        name: 'vars.vhost',
        checkId: 'web',
        checkName: 'Web {{name}}',
        field: 'headers.Host',
        value: '{{vars.vhost}}',
      },
    ]);
  });
});

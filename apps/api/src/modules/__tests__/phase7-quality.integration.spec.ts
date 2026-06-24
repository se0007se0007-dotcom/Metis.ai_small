/**
 * Phase 7 Quality Integration Tests — structural verification.
 */
import { SchemaValidatorService } from '../execution/schema-validator.service';
import { AdapterInvocationService } from '../capability-registry/adapter-invocation.service';

describe('Phase 7.3 — SchemaValidator', () => {
  const v = new SchemaValidatorService();

  it('validates a valid AP invoice input', () => {
    const schema = {
      type: 'object',
      required: ['invoiceNumber', 'amount'],
      properties: {
        invoiceNumber: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
      },
    };
    const r = v.validate({ invoiceNumber: 'INV-001', amount: 100 }, schema);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('catches missing required field', () => {
    const schema = {
      type: 'object',
      required: ['amount'],
      properties: { amount: { type: 'number' } },
    };
    const r = v.validate({}, schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('amount');
  });

  it('catches type mismatch', () => {
    const schema = { type: 'object', properties: { amount: { type: 'number' } } };
    const r = v.validate({ amount: 'not-a-number' }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('type');
  });

  it('catches numeric bounds violation', () => {
    const schema = {
      type: 'object',
      properties: { score: { type: 'number', minimum: 0, maximum: 1 } },
    };
    const r = v.validate({ score: 1.5 }, schema);
    expect(r.valid).toBe(false);
  });

  it('validates enum', () => {
    const schema = {
      type: 'object',
      properties: { severity: { type: 'string', enum: ['LOW', 'HIGH'] } },
    };
    const r1 = v.validate({ severity: 'LOW' }, schema);
    const r2 = v.validate({ severity: 'MAYBE' }, schema);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(false);
  });
});

describe('Phase 7.1 — AdapterInvocation', () => {
  it('registers and invokes a handler', async () => {
    const svc = new AdapterInvocationService();
    svc.register('test-adapter', async (input) => ({
      success: true,
      output: { echoed: input.value },
      adapter: 'test-adapter',
    }));

    const r = await svc.invoke(
      { tenantId: 't1', userId: 'u1', role: 'OPERATOR' } as any,
      'test-adapter',
      { value: 42 },
    );
    expect(r.success).toBe(true);
    expect(r.output.echoed).toBe(42);
  });

  it('accepts both prefixed and raw keys', async () => {
    const svc = new AdapterInvocationService();
    svc.register('my-adapter', async () => ({ success: true, output: {}, adapter: 'my-adapter' }));
    const r1 = await svc.invoke({} as any, 'my-adapter', {});
    const r2 = await svc.invoke({} as any, 'adapter:my-adapter', {});
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });

  it('throws NotFoundException for unknown adapter', async () => {
    const svc = new AdapterInvocationService();
    await expect(svc.invoke({} as any, 'missing', {})).rejects.toThrow();
  });
});

describe('Phase 7.2 — DAG Planner', () => {
  // Inline the planExecutionLevels logic from WorkflowRunnerService for unit testing
  function planLevels(nodes: Array<{ id: string; dependsOn?: string[] }>): string[][] {
    const hasAny = nodes.some((n) => n.dependsOn && n.dependsOn.length > 0);
    if (!hasAny) return nodes.map((n) => [n.id]);
    const remaining = new Set(nodes.map((n) => n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const levels: string[][] = [];
    const completed = new Set<string>();
    while (remaining.size > 0) {
      const level: string[] = [];
      for (const nid of remaining) {
        const n = byId.get(nid)!;
        if ((n.dependsOn ?? []).every((d) => completed.has(d))) level.push(nid);
      }
      if (level.length === 0) throw new Error('cycle');
      for (const id of level) {
        completed.add(id);
        remaining.delete(id);
      }
      levels.push(level);
    }
    return levels;
  }

  it('produces linear levels when no dependsOn', () => {
    const levels = planLevels([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(levels).toEqual([['a'], ['b'], ['c']]);
  });

  it('groups parallel-eligible nodes at same level', () => {
    const levels = planLevels([
      { id: 'start' },
      { id: 'a', dependsOn: ['start'] },
      { id: 'b', dependsOn: ['start'] },
      { id: 'c', dependsOn: ['a', 'b'] },
    ]);
    expect(levels[0]).toEqual(['start']);
    expect(levels[1].sort()).toEqual(['a', 'b']);
    expect(levels[2]).toEqual(['c']);
  });

  it('detects cycles', () => {
    expect(() =>
      planLevels([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ]),
    ).toThrow();
  });
});

describe('Phase 7.4 — Heuristic Planner', () => {
  it('picks AP domain for invoice intent and returns DAG edges', async () => {
    const { HeuristicPlannerAdapter } = await import(
      '../builder/llm-planner/heuristic-planner-adapter'
    );
    const p = new HeuristicPlannerAdapter();
    const r = await p.suggest({
      intent: '인보이스 OCR 처리 후 자동 승인',
      availableCapabilities: [
        {
          key: 'adapter:ocr-mock',
          kind: 'ADAPTER',
          label: 'OCR Mock',
          category: 'ocr',
          tags: ['ocr', 'invoice'],
          id: '1',
          sourceType: 'AdapterRegistration',
          sourceId: 'a1',
        } as any,
        {
          key: 'agent:ap-agent',
          kind: 'AGENT',
          label: 'AP Processor',
          category: 'business',
          tags: ['business', 'invoice', 'approve'],
          id: '2',
          sourceType: 'AgentDefinition',
          sourceId: 'a2',
        } as any,
      ],
      hints: { domain: 'ap' },
    });
    expect(r.domain).toBe('ap');
    expect(r.selectedCapabilityKeys.length).toBeGreaterThan(0);
    // At least one node should have dependsOn set (DAG format)
    const hasDependsOn = r.nodeOrder.some((n) => n.dependsOn && n.dependsOn.length > 0);
    expect(hasDependsOn).toBe(true);
  });

  it('returns warning when no capabilities match', async () => {
    const { HeuristicPlannerAdapter } = await import(
      '../builder/llm-planner/heuristic-planner-adapter'
    );
    const p = new HeuristicPlannerAdapter();
    const r = await p.suggest({ intent: 'completely unrelated task', availableCapabilities: [] });
    expect(r.warnings).toBeDefined();
    expect(r.selectedCapabilityKeys.length).toBe(0);
  });
});

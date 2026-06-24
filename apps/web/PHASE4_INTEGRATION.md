# Phase 4 Integration Guide: API Hooks & Shared Components

## Quick Start

### 1. Add Providers to Root Layout

**File: `src/app/layout.tsx`**

```tsx
import { Providers } from '@/lib/providers';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <Providers>
          <YourAppShell>{children}</YourAppShell>
        </Providers>
      </body>
    </html>
  );
}
```

### 2. Import and Use Hooks in Page Components

```tsx
'use client';

import { useExecutions, useExecution } from '@/lib/api-hooks';
import { DataTable, SearchToolbar, DetailPanel } from '@/components/shared';
import { useState } from 'react';

export default function ExecutionsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState({ status: '' });

  const { data, isLoading, error } = useExecutions(filters);
  const { data: execution } = useExecution(selectedId);

  if (error) return <div>Error: {error.message}</div>;

  return (
    <div className="space-y-4">
      <SearchToolbar
        placeholder="Search executions..."
        filters={[
          {
            id: 'status',
            label: 'Status',
            value: filters.status,
            options: [
              { id: 'all', label: 'All', value: '' },
              { id: 'running', label: 'Running', value: 'RUNNING' },
              { id: 'succeeded', label: 'Succeeded', value: 'SUCCEEDED' },
              { id: 'failed', label: 'Failed', value: 'FAILED' },
            ],
            onValueChange: (value) => setFilters({ ...filters, status: value }),
          },
        ]}
      />

      <DataTable
        columns={[
          { key: 'id', header: 'ID', width: '200px' },
          { key: 'status', header: 'Status', width: '120px' },
          { key: 'workflowKey', header: 'Workflow', width: '200px' },
          {
            key: 'startedAt',
            header: 'Started At',
            render: (value) => new Date(value as string).toLocaleString(),
          },
        ]}
        data={data?.items || []}
        isLoading={isLoading}
        selectedRowId={selectedId}
        onRowClick={(row) => setSelectedId(row.id)}
      />

      {selectedId && execution && (
        <DetailPanel
          title={`Execution ${selectedId}`}
          onClose={() => setSelectedId(null)}
          metadata={{
            Status: execution.status,
            'Started At': execution.startedAt,
            'Ended At': execution.endedAt,
            'Latency (ms)': execution.latencyMs,
            'Cost (USD)': execution.costUsd,
          }}
          jsonData={execution}
        />
      )}
    </div>
  );
}
```

## File Structure

```
src/
├── lib/
│   ├── api-client.ts          (existing)
│   ├── api-hooks.ts           (NEW - React Query hooks)
│   └── providers.tsx          (NEW - QueryClient provider)
├── components/
│   └── shared/
│       ├── DataTable.tsx      (NEW - Reusable table)
│       ├── DetailPanel.tsx    (NEW - Inspector panel)
│       ├── SearchToolbar.tsx  (NEW - Search/filter bar)
│       ├── Timeline.tsx       (NEW - Event timeline)
│       └── MetricComparisonCard.tsx (NEW - Metric comparison)
└── app/
    └── layout.tsx             (MODIFY - Add Providers)
```

## Hooks API Reference

### Execution Hooks

```tsx
// Get paginated executions with optional filters
const { data, isLoading } = useExecutions({ status: 'RUNNING', page: 1 });

// Get single execution details
const { data: execution } = useExecution(id);

// Get execution trace/timeline events
const { data: trace } = useExecutionTrace(id);

// Create new execution
const { mutate: createExec } = useCreateExecution();
createExec({ workflowKey: 'test' });

// Kill running execution
const { mutate: killExec } = useKillExecution();
killExec(executionId);

// Get stats (cached, refetches every 10s)
const { data: stats } = useExecutionStats();
```

### Pack Hooks

```tsx
// List all packs
const { data: packs } = usePacks({ keyword: 'ai', status: 'PUBLISHED' });

// Get single pack details
const { data: pack } = usePack(packId);

// Get pack versions
const { data: versions } = usePackVersions(packId);

// Import new pack
const { mutate: importPack } = useImportPack();
importPack({ sourceType: 'GITHUB', sourceUrl: 'https://github.com/...' });
```

### Connector Hooks

```tsx
// List all connectors
const { data: connectors } = useConnectors();

// Get connector details
const { data: connector } = useConnector(connectorId);

// Create connector
const { mutate: createConnector } = useCreateConnector();
createConnector({ name: 'My Connector', type: 'HTTP' });

// Update connector
const { mutate: updateConnector } = useUpdateConnector();
updateConnector({ id: connectorId, data: { status: 'ACTIVE' } });

// Delete connector
const { mutate: deleteConnector } = useDeleteConnector();
deleteConnector(connectorId);

// Health check
const { mutate: checkHealth } = useHealthCheck();
checkHealth(connectorId);
```

### Release Engineering Hooks

#### Replay

```tsx
// List replay datasets
const { data: datasets } = useReplayDatasets(pageNumber);

// Get dataset details
const { data: dataset } = useReplayDataset(datasetId);

// Create replay dataset
const { mutate: createDataset } = useCreateReplayDataset();
createDataset({ name: 'Production Cases', filter: { limit: 1000 } });

// Start replay run
const { mutate: startRun } = useStartReplayRun();
startRun({ datasetId, candidateVersionId });

// Get replay runs
const { data: runs } = useReplayRuns({ status: 'COMPLETED' });

// Mark cases as golden
const { mutate: markGolden } = useMarkGolden();
markGolden({ datasetId, body: { caseIds: [...], isGolden: true } });
```

#### Shadow

```tsx
// List shadow configurations
const { data: configs } = useShadowConfigs();

// Get config details (metrics auto-refetch every 10s)
const { data: metrics } = useShadowConfigMetrics(configId);

// Create shadow config
const { mutate: createShadow } = useCreateShadowConfig();
createShadow({
  name: 'Control vs Candidate v2',
  controlVersionId: 'v1',
  candidateVersionId: 'v2',
  samplingRate: 0.1,
});

// Toggle shadow config on/off
const { mutate: toggleShadow } = useToggleShadowConfig();
toggleShadow(configId);

// Get shadow pairs (actual vs expected results)
const { data: pairs } = useShadowPairs({ configId, status: 'DIVERGED' });
```

#### Canary

```tsx
// List canary deployments
const { data: canaries } = useCanaryDeployments({ status: 'ACTIVE' });

// Get canary details (auto-refetch every 10s)
const { data: canary } = useCanaryDeployment(canaryId);

// Create canary deployment
const { mutate: createCanary } = useCreateCanaryDeployment();
createCanary({
  name: 'Canary Deployment v2.1',
  packId: 'pack-123',
  stableVersionId: 'v2.0',
  candidateVersionId: 'v2.1',
  initialTrafficPct: 5,
  maxTrafficPct: 100,
  incrementStepPct: 10,
});

// Start canary
const { mutate: startCanary } = useStartCanary();
startCanary(canaryId);

// Promote canary to stable
const { mutate: promoteCanary } = usePromoteCanary();
promoteCanary(canaryId);

// Rollback canary
const { mutate: rollbackCanary } = useRollbackCanary();
rollbackCanary(canaryId);
```

### Governance Hooks

```tsx
// Get audit logs with filtering
const { data: logs } = useAuditLogs({
  action: 'CANARY_PROMOTE',
  correlationId: 'trace-123',
  page: 1,
});

// Get all policies
const { data: policies } = usePolicies();
```

## Component API Reference

### DataTable

```tsx
<DataTable
  columns={[
    {
      key: 'id',
      header: 'ID',
      width: '200px',
      sortable: true,
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      render: (value, row) => <StatusBadge status={value as string} />,
    },
  ]}
  data={items}
  isLoading={isLoading}
  isEmpty={items.length === 0}
  emptyMessage="No executions found"
  selectedRowId={selectedId}
  onRowClick={(row) => setSelectedId(row.id)}
/>
```

### DetailPanel

```tsx
<DetailPanel
  title="Execution Details"
  onClose={() => setPanel(null)}
  metadata={{ Status: 'RUNNING', Duration: '45s' }}
  jsonData={executionObject}
  tabs={[
    { id: 'overview', label: 'Overview', content: <div>...</div> },
    { id: 'logs', label: 'Logs', content: <div>...</div> },
  ]}
/>
```

### SearchToolbar

```tsx
<SearchToolbar
  searchValue={search}
  onSearchChange={setSearch}
  placeholder="Search executions..."
  filters={[
    {
      id: 'status',
      label: 'Status',
      value: statusFilter,
      options: [
        { id: 'all', label: 'All', value: '' },
        { id: 'running', label: 'Running', value: 'RUNNING' },
      ],
      onValueChange: setStatusFilter,
    },
  ]}
  actions={<button>Export</button>}
/>
```

### Timeline

```tsx
<Timeline
  events={[
    {
      id: '1',
      timestamp: '2026-04-05T10:30:00Z',
      status: 'success',
      title: 'Execution started',
      detail: 'workflow:main',
      duration: 5000,
    },
    {
      id: '2',
      timestamp: '2026-04-05T10:35:00Z',
      status: 'running',
      title: 'Processing step 2',
      duration: 3500,
    },
  ]}
  isLoading={false}
/>
```

### MetricComparisonCard

```tsx
<MetricComparisonCard
  label="Success Rate"
  unit="%"
  baselineValue={95.2}
  candidateValue={96.8}
  baselineLabel="v2.0"
  candidateLabel="v2.1"
  invertComparison={false}
  showChart={true}
/>
```

## Styling

All components use Metis design tokens from `tailwind.config.ts`:

- **Backgrounds**: `bg-dark-800`, `bg-dark-900`, `bg-navy-light`
- **Borders**: `border-dark-600`
- **Text**: `text-white`, `text-gray-300`, `text-muted`
- **Accent**: `text-accent` / `border-accent` (#00B4D8)
- **Status**: `text-success`, `text-danger`, `text-warning`, `text-purple`

## Error Handling

```tsx
const { data, error, isLoading } = useExecutions();

if (error) {
  return (
    <div className="bg-danger/20 border border-danger text-danger p-4 rounded">
      Failed to load: {error.message}
      {error instanceof Error && error.cause && (
        <p className="text-xs mt-2">{String(error.cause)}</p>
      )}
    </div>
  );
}
```

## Query Invalidation

Mutations automatically invalidate related query keys:

- `useCreateExecution()` invalidates: `executionList`, `executionStats`
- `useImportPack()` invalidates: `packList`
- `useInstallPack()` invalidates: `installations`
- `useUpdateConnector()` invalidates: `connector`, `connectorList`
- etc.

Manual invalidation if needed:

```tsx
const queryClient = useQueryClient();
queryClient.invalidateQueries({ queryKey: ['executions', 'list'] });
```

## Performance Tips

1. **Reduce Re-renders**: Use `selectedId` state to control which detail panel shows
2. **Lazy Load**: Use conditional queries with `enabled: !!id`
3. **Pagination**: Implement with `page` param in hooks, add pagination UI to DataTable
4. **Search**: Debounce search input before updating filter state
5. **Infinite Scroll**: Create `useExecutionsInfinite()` hook for large lists

## Next Steps

1. Integrate Providers into root layout.tsx
2. Build execution monitor page
3. Build pack manager with import dialog
4. Build release engineering dashboards
5. Add pagination controls
6. Add infinite scroll support
7. Create specialized hooks for each feature area (optional)
8. Add WebSocket integration for real-time updates (optional)

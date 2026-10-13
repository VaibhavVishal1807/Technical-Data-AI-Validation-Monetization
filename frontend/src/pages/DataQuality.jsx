/**
 * Data Quality: every check run on the CSV, with how many rows it hit, how it
 * is detected, how it is handled and why. All numbers come from the API,
 * which computes them from the data at startup.
 */
import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '../api';
import {
  BlockSkeleton, EmptyState, KpiCard, KpiGrid, KpiSkeleton, PageHead, PageState, Section,
} from '../components/Common';
import DataTable from '../components/DataTable';
import { StatusBadge, TagBadge } from '../components/Badges';
import { fmtInt, fmtNumber, fmtPct } from '../format';

const ORIGINS = [
  { key: 'ALL', label: 'All checks' },
  { key: 'BRIEF', label: 'From the brief' },
  { key: 'DISCOVERED', label: 'Discovered' },
  { key: 'INTEGRITY', label: 'Integrity' },
];
const ORIGIN_LABEL = { BRIEF: 'Brief', DISCOVERED: 'Discovered', INTEGRITY: 'Integrity' };

function DetailValue({ value }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    if (typeof value[0] === 'object') {
      return (
        <ul className="list-disc pl-4">
          {value.map((v, i) => <li key={i}>{v.x && v.y ? `${v.x} vs ${v.y}: r = ${v.r}` : JSON.stringify(v)}</li>)}
        </ul>
      );
    }
    return value.join(', ');
  }
  if (typeof value === 'number') return fmtNumber(value, Number.isInteger(value) ? 0 : 2);
  return String(value);
}

function Check({ check }) {
  const found = check.status === 'FOUND';
  const details = Object.entries(check.details || {});
  return (
    <div className="grid gap-4 border-b border-border px-6 py-6 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={found ? 'warning' : 'ok'}>{found ? 'Found' : 'Pass'}</StatusBadge>
        <TagBadge className={check.origin === 'BRIEF' ? 'text-foreground' : undefined}>{ORIGIN_LABEL[check.origin]}</TagBadge>
        <h3 className="text-base font-semibold">{check.title}</h3>
        <span className="ml-auto text-sm font-medium whitespace-nowrap">
          {check.level === 'dataset' ? 'dataset-level' : `${fmtInt(check.count)} / ${fmtInt(check.total)} ${check.level === 'report' ? 'reports' : 'rows'}`}
          {check.pct !== null && check.level !== 'dataset' && <span className="text-muted-foreground"> ({fmtPct(check.pct)})</span>}
        </span>
      </div>
      <dl className="grid gap-4 md:grid-cols-3">
        {[['Detection', check.detection], ['Handling', check.handling], ['Why', check.rationale]].map(([term, text]) => (
          <div key={term} className="grid content-start gap-2">
            <dt className="text-label">{term}</dt>
            <dd className="text-sm">{text}</dd>
          </div>
        ))}
      </dl>
      {(details.length > 0 || check.examples.length > 0) && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          {details.map(([k, v]) => <span key={k}><code className="text-foreground">{k}</code>: <DetailValue value={v} /></span>)}
          {check.examples.length > 0 && <span>examples: {check.examples.join(', ')}</span>}
        </div>
      )}
    </div>
  );
}

const PROFILE_COLUMNS = [
  { id: 'column', header: 'Column', accessorFn: (p) => p.column, cell: ({ row }) => <code>{row.original.column}</code> },
  { id: 'min', header: 'Min', accessorFn: (p) => p.min, meta: { numeric: true }, cell: ({ row }) => fmtNumber(row.original.min, 2) },
  { id: 'max', header: 'Max', accessorFn: (p) => p.max, meta: { numeric: true }, cell: ({ row }) => fmtNumber(row.original.max, 2) },
  { id: 'mean', header: 'Mean', accessorFn: (p) => p.mean, meta: { numeric: true }, cell: ({ row }) => fmtNumber(row.original.mean, 2) },
  { id: 'missing', header: 'Missing', accessorFn: (p) => p.missing, meta: { numeric: true, hint: 'Empty or "nan" values in the source file' }, cell: ({ row }) => fmtInt(row.original.missing) },
];

export default function DataQuality() {
  const quality = useApi('/data-quality');
  const { data } = quality;
  const [origin, setOrigin] = useState('ALL');
  const checks = (data?.checks || []).filter((c) => origin === 'ALL' || c.origin === origin);
  const categories = [...new Set(checks.map((c) => c.category))];
  const s = data?.summary;

  return (
    <>
      <PageHead
        title="Data quality"
        subtitle="Every check run on the source CSV. Rows are never deleted: problems are flagged, counted and handled explicitly."
      />
      <PageState {...quality} skeleton={<><KpiSkeleton count={5} /><BlockSkeleton height={200} /></>}>
        {s && (
          <>
            <KpiGrid>
              <KpiCard label="Rows loaded" value={fmtInt(s.rows_total)} caption={`${s.reports_total} reports × 20 snapshots`} />
              <KpiCard label="Rows dropped" value="0" caption="Nothing is silently removed" />
              <KpiCard label="Rows with at least one flag" value={fmtInt(s.rows_with_any_flag)} caption="Includes latency breaches (the alert signal)" />
              <KpiCard label="Excluded from cost totals" value={fmtInt(s.rows_excluded_from_cost_totals)} caption="Negative credit rows, kept and flagged" />
              <KpiCard label="Checks with findings" value={`${s.checks_with_findings} / ${s.checks_run}`} caption="The rest passed" />
            </KpiGrid>

            <div className="flex flex-wrap items-center gap-4">
              <Tabs value={origin} onValueChange={setOrigin}>
                <TabsList aria-label="Filter checks by origin">
                  {ORIGINS.map((o) => <TabsTrigger key={o.key} value={o.key} className="px-2">{o.label}</TabsTrigger>)}
                </TabsList>
              </Tabs>
              <span className="text-xs text-muted-foreground">"From the brief" = the injected anomalies named in the case study.</span>
            </div>

            {categories.length === 0 && <Section><EmptyState>No checks in this group</EmptyState></Section>}
            {categories.map((cat) => (
              <Section flush key={cat} title={cat}>
                {checks.filter((c) => c.category === cat).map((c) => <Check key={c.id} check={c} />)}
              </Section>
            ))}

            <Section flush title="Column profile" description={`Source file: ${data.source_file}`}>
              <DataTable
                label="Column profile"
                columns={PROFILE_COLUMNS}
                data={data.column_profile}
                getRowId={(p) => p.column}
                emptyText="No columns profiled"
              />
            </Section>
          </>
        )}
      </PageState>
    </>
  );
}

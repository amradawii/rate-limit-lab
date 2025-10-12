type ScenarioId =
  | 'boundary-burst'
  | 'steady-traffic'
  | 'page-load-burst'
  | 'spoofed-xff'
  | 'ipv6-rotation';

interface SimulatedEvent {
  index: number;
  atMs: number;
  key: string;
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface SimulatedRow {
  id: string;
  label: string;
  note: string;
  total: number;
  allowedCount: number;
  rejectedCount: number;
  peakPerSecond: number;
  events: SimulatedEvent[];
}

interface ScenarioReport {
  id: ScenarioId;
  title: string;
  kind: 'algorithm' | 'key';
  policySummary: string;
  problem: string;
  solution: string;
  rows: SimulatedRow[];
}

const TABS: readonly { id: ScenarioId; label: string }[] = [
  { id: 'boundary-burst', label: 'Boundary burst' },
  { id: 'steady-traffic', label: 'Steady traffic' },
  { id: 'page-load-burst', label: 'Page load burst' },
  { id: 'spoofed-xff', label: 'Spoofed X-Forwarded-For' },
  { id: 'ipv6-rotation', label: 'IPv6 rotation' },
];

const tabsContainer = document.getElementById('scenario-tabs') as HTMLElement;
const problemEl = document.getElementById('scenario-problem') as HTMLElement;
const solutionEl = document.getElementById('scenario-solution') as HTMLElement;
const policyEl = document.getElementById('scenario-policy') as HTMLElement;
const rowsContainer = document.getElementById('scenario-rows') as HTMLElement;

const liveAlgorithmSelect = document.getElementById('live-algorithm') as HTMLSelectElement;
const liveFireBtn = document.getElementById('live-fire-btn') as HTMLButtonElement;
const liveSummary = document.getElementById('live-summary') as HTMLElement;
const liveTableBody = document.getElementById('live-table-body') as HTMLElement;

let activeScenario: ScenarioId = 'boundary-burst';

function renderTabs(): void {
  tabsContainer.innerHTML = '';
  for (const tab of TABS) {
    const isSelected = tab.id === activeScenario;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.role = 'tab';
    btn.dataset.scenario = tab.id;
    btn.setAttribute('aria-selected', String(isSelected));
    btn.className = isSelected
      ? 'cursor-pointer rounded bg-teal-700 px-3 py-1.5 text-[14px] font-medium text-white'
      : 'cursor-pointer rounded bg-stone-100 px-3 py-1.5 text-[14px] font-medium text-stone-700 hover:bg-stone-200';
    btn.textContent = tab.label;
    btn.addEventListener('click', () => {
      void selectScenario(tab.id);
    });
    tabsContainer.appendChild(btn);
  }
}

function renderReport(report: ScenarioReport): void {
  problemEl.textContent = report.problem;
  solutionEl.textContent = report.solution;
  policyEl.textContent = report.policySummary;
  rowsContainer.innerHTML = '';

  for (const row of report.rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'grid items-center gap-3 py-3 md:grid-cols-12';
    rowEl.dataset.rowId = row.id;

    const meta = document.createElement('div');
    meta.className = 'md:col-span-4';
    const title = document.createElement('div');
    title.className = 'text-[14px] font-semibold text-stone-900';
    title.textContent = row.label;
    const note = document.createElement('div');
    note.className = 'text-xs text-stone-500';
    note.textContent = row.note;
    meta.append(title, note);

    const strip = document.createElement('div');
    strip.className = 'flex flex-wrap items-center gap-1 md:col-span-6';
    for (const ev of row.events) {
      const cell = document.createElement('span');
      cell.className = ev.allowed
        ? 'inline-block h-3.5 w-3.5 rounded-[2px] bg-emerald-600'
        : 'inline-block h-3.5 w-3.5 rounded-[2px] bg-rose-600';
      cell.title = `#${ev.index + 1} at ${ev.atMs} ms (${ev.key}) — ${
        ev.allowed ? `allowed, ${ev.remaining} remaining` : `429, retry after ${ev.retryAfterMs} ms`
      }`;
      strip.appendChild(cell);
    }

    const stats = document.createElement('div');
    stats.className = 'flex flex-col text-right font-mono text-xs text-stone-700 md:col-span-2';
    const allowedLine = document.createElement('span');
    allowedLine.className = 'font-medium text-stone-900';
    allowedLine.textContent = `allowed ${row.allowedCount} of ${row.total}`;
    const peakLine = document.createElement('span');
    peakLine.className = 'text-stone-500';
    peakLine.textContent = `peak ${row.peakPerSecond}/s`;
    stats.append(allowedLine, peakLine);

    rowEl.append(meta, strip, stats);
    rowsContainer.appendChild(rowEl);
  }
}

async function selectScenario(scenario: ScenarioId): Promise<void> {
  activeScenario = scenario;
  renderTabs();
  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  if (!res.ok) {
    throw new Error(`Simulation request failed with status ${res.status}`);
  }
  const report = (await res.json()) as ScenarioReport;
  renderReport(report);
}

async function fireLiveBurst(): Promise<void> {
  const algorithm = liveAlgorithmSelect.value;
  liveFireBtn.disabled = true;
  liveTableBody.innerHTML = '';
  liveSummary.textContent = `Firing 15 requests at /api/limited/${algorithm}...`;

  let allowed = 0;
  let rejected = 0;

  try {
    for (let i = 1; i <= 15; i++) {
      const res = await fetch(`/api/limited/${algorithm}`);
      if (res.status === 200) allowed++;
      else rejected++;

      const tr = document.createElement('tr');
      const statusClass =
        res.status === 200 ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700';

      const cells = [
        { text: String(i), cls: 'py-1 pr-3 text-stone-500' },
        { text: String(res.status), cls: `py-1 pr-3 ${statusClass}` },
        { text: res.headers.get('RateLimit-Policy') ?? '—', cls: 'py-1 pr-3' },
        { text: res.headers.get('RateLimit') ?? '—', cls: 'py-1 pr-3' },
        { text: res.headers.get('Retry-After') ?? '—', cls: 'py-1 pr-3' },
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.className = c.cls;
        td.textContent = c.text;
        tr.appendChild(td);
      }
      liveTableBody.appendChild(tr);
    }
    liveSummary.textContent = `Completed 15 requests against /api/limited/${algorithm}: ${allowed} allowed (200), ${rejected} rejected (429).`;
  } finally {
    liveFireBtn.disabled = false;
  }
}

liveFireBtn.addEventListener('click', () => {
  void fireLiveBurst();
});

void selectScenario(activeScenario);

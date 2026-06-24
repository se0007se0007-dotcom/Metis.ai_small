/* Metis FinOps Dashboard — L5 경험 계층 (vanilla JS + Chart.js) */
const API = "";  // control plane 이 같은 origin 에서 서빙
const REFRESH_MS = 5000;
let currentView = "overview";
let selectedRun = null;

const PALETTE = ["#4f8ff7", "#9d6ef7", "#3fb97a", "#e3b341", "#f85149", "#39c5cf", "#ff8c69", "#b0b8c4"];
const fmt$ = (v, d = 4) => v == null ? "—" : "$" + Number(v).toFixed(d);
const fmtN = v => v == null ? "—" : Number(v).toLocaleString();
const fmtTok = v => v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : fmtN(v);
const fmtT = ts => new Date(ts * 1000).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function jget(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}
async function jpost(path, body) {
  const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

/* ---------------- chart helpers ---------------- */
Chart.defaults.color = "#8b96a8";
Chart.defaults.borderColor = "rgba(45,54,70,.6)";
Chart.defaults.font.family = '"Pretendard","Malgun Gothic","Segoe UI",sans-serif';
const charts = {};

// 도넛 조각 위에 % 라벨을 그리는 인라인 플러그인 (외부 plugin 의존성 없음 — 폐쇄망 안전)
const donutPct = {
  id: "donutPct",
  afterDraw(chart) {
    if (chart.config.type !== "doughnut") return;
    const meta = chart.getDatasetMeta(0);
    const data = chart.data.datasets[0].data || [];
    const total = data.reduce((a, b) => a + (b || 0), 0);
    if (!total) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    meta.data.forEach((arc, i) => {
      const pct = (data[i] || 0) / total * 100;
      if (pct < 5) return;            // 너무 얇은 조각은 생략
      const pos = arc.tooltipPosition();
      ctx.fillText(pct.toFixed(0) + "%", pos.x, pos.y);
    });
    ctx.restore();
  }
};

const donutTooltipPct = {
  callbacks: {
    label(c) {
      const total = c.dataset.data.reduce((a, b) => a + (b || 0), 0) || 1;
      return ` ${c.label}: ${fmt$(c.parsed, 4)} (${(c.parsed / total * 100).toFixed(1)}%)`;
    }
  }
};

// 버킷 크기에 따라 시각 라벨 포맷 변경 (1시간 이하: HH:MM:SS, 그 이상: MM/DD HH:MM)
function fmtBucket(ts, bucket) {
  const d = new Date(ts * 1000);
  if (bucket >= 3600)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}시`;
  if (bucket >= 300)
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return fmtT(ts);
}

function upsertChart(id, cfg) {
  if (charts[id]) {
    charts[id].data = cfg.data;
    if (cfg.options) Object.assign(charts[id].options, cfg.options);
    charts[id].update("none");
    return charts[id];
  }
  charts[id] = new Chart(document.getElementById(id), cfg);
  return charts[id];
}

/* ---------------- nav ---------------- */
document.querySelectorAll(".nav-item").forEach(el => el.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".view").forEach(x => x.classList.remove("active"));
  el.classList.add("active");
  currentView = el.dataset.view;
  document.getElementById("view-" + currentView).classList.add("active");
  refresh(true);
}));

/* ---------------- 임베드 모드 (metis 하위메뉴 임베드: 자체 사이드바 숨김 + view 고정) ----------------
   metis 가 iframe 으로 ?embed=1&view=overview 형태로 호출하면 자체 chrome 을 숨기고 해당 뷰만 표시 */
window.addEventListener("load", function () {
  try {
    const p = new URLSearchParams(location.search);
    if (p.get("embed") === "1") document.body.classList.add("embed");
    const v = p.get("view");
    if (v) {
      const it = document.querySelector('.nav-item[data-view="' + v + '"]');
      if (it) it.click();
    }
  } catch (e) {
    /* ignore */
  }
});

/* ================= 개요 ================= */
async function renderOverview() {
  const ov = await jget("/api/overview");
  document.getElementById("k-cost").innerHTML = fmt$(ov.today_cost, 2);
  document.getElementById("k-calls").textContent = `호출 ${fmtN(ov.today_calls)}건`;
  document.getElementById("k-burn").innerHTML = fmt$(ov.burn_per_min, 4) + "<small>/min</small>";
  document.getElementById("k-savings").innerHTML = fmt$(ov.today_savings, 2);
  const denom = ov.today_savings + ov.today_cost;
  document.getElementById("k-savings-pct").textContent =
    denom > 0 ? `미적용 가정 대비 ${(ov.today_savings / denom * 100).toFixed(0)}% 절감` : "";
  document.getElementById("k-cop").innerHTML = ov.cost_of_pass == null ? "—" : fmt$(ov.cost_of_pass, 4);
  document.getElementById("k-pass").textContent =
    ov.finished_runs ? `완료 ${ov.finished_runs} · 통과 ${ov.passed_runs}` : "";
  document.getElementById("k-active").textContent = fmtN(ov.active_runs);
  document.getElementById("k-killed").textContent = fmtN(ov.killed_today);
  document.getElementById("k-down").textContent = fmtN(ov.downgrades_today);
  document.getElementById("k-tokens").textContent = fmtTok(ov.today_tokens);
  const up = Math.floor(ov.uptime_s);
  document.getElementById("uptime").textContent = `가동 ${Math.floor(up / 60)}분 ${up % 60}초`;

  // 지출 추이 (stacked bar, 기간 선택 + 적응형 버킷)
  const group = document.getElementById("ov-group").value;
  const mins = document.getElementById("ov-mins").value;
  const ss = await jget(`/api/spend_series?group=${group}&minutes=${mins}`);
  const bsz = ss.bucket || 60;
  const buckets = [...new Set(ss.rows.map(r => r.bucket))].sort((a, b) => a - b);
  const groups = [...new Set(ss.rows.map(r => r.g))];
  const dsMap = {};
  groups.forEach(g => dsMap[g] = buckets.map(() => 0));
  ss.rows.forEach(r => { dsMap[r.g][buckets.indexOf(r.bucket)] = r.c; });
  const groupKo = { tenant: "테넌트별", agent: "에이전트별", model: "모델별", provider: "프로바이더별" }[group];
  document.getElementById("ov-series-sub").textContent =
    `${groupKo} · ${bsz >= 3600 ? bsz / 3600 + "시간" : bsz / 60 + "분"} 버킷`;
  upsertChart("ch-spend", {
    type: "bar",
    data: {
      labels: buckets.map(b => fmtBucket(b, bsz)),
      datasets: groups.map((g, i) => ({ label: g, data: dsMap[g], backgroundColor: PALETTE[i % PALETTE.length], stack: "s" }))
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 10 } }, y: { stacked: true, title: { display: true, text: "USD" } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } }
    }
  });

  // 모델 donut (기간 선택 + % 라벨)
  const mmins = document.getElementById("ov-model-mins").value;
  const ms = await jget(`/api/spend_series?group=model&minutes=${mmins}`);
  const agg = {};
  ms.rows.forEach(r => agg[r.g] = (agg[r.g] || 0) + r.c);
  const entries = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  upsertChart("ch-model-donut", {
    type: "doughnut",
    data: {
      labels: entries.map(e => e[0]),
      datasets: [{ data: entries.map(e => e[1]), backgroundColor: PALETTE, borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "58%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
                 tooltip: donutTooltipPct }
    },
    plugins: [donutPct]
  });

  renderAlertFeed("ov-alerts", (await jget("/api/alerts?limit=30")).rows);

  // 절감 구성 (기간 선택 + % 라벨 + 표)
  const shours = document.getElementById("ov-sav-hours").value;
  const sv = await jget(`/api/savings?hours=${shours}`);
  const KIND = {
    semantic_cache: ["시맨틱 캐시", "#3fb97a"],
    prompt_cache: ["프롬프트(prefix) 캐시", "#4f8ff7"],
    routing_downshift: ["3티어 라우팅 강등", "#e3b341"],
    skill_packer: ["스킬패커(툴 동적로딩)", "#9d6ef7"],
  };
  upsertChart("ch-ov-savings", {
    type: "doughnut",
    data: {
      labels: sv.by_kind.map(r => (KIND[r.savings_kind] || [r.savings_kind])[0]),
      datasets: [{ data: sv.by_kind.map(r => r.s),
                   backgroundColor: sv.by_kind.map(r => (KIND[r.savings_kind] || [null, "#8b96a8"])[1]),
                   borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "58%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } },
                 tooltip: donutTooltipPct }
    },
    plugins: [donutPct]
  });
  const totS = sv.by_kind.reduce((a, r) => a + r.s, 0);
  const rowsHtml = sv.by_kind
    .slice().sort((a, b) => b.s - a.s)
    .map(r => `<tr><td>${esc((KIND[r.savings_kind] || [r.savings_kind])[0])}</td>
      <td class="num" style="color:var(--green)"><b>${fmt$(r.s, 4)}</b></td>
      <td class="num">${totS ? (r.s / totS * 100).toFixed(1) : 0}%</td>
      <td class="num">${fmtN(r.n)}</td></tr>`).join("");
  document.querySelector("#ov-savings-table tbody").innerHTML =
    (rowsHtml || '<tr><td colspan="4" class="empty">절감 데이터 없음</td></tr>') +
    `<tr style="border-top:2px solid var(--border)"><td><b>합계</b> <span style="color:var(--muted);font-size:11px">(캐시 히트율 ${(sv.cache_hit_rate * 100).toFixed(1)}%)</span></td>
      <td class="num" style="color:var(--green)"><b>${fmt$(totS, 4)}</b></td>
      <td class="num">100%</td>
      <td class="num">${fmtN(sv.by_kind.reduce((a, r) => a + r.n, 0))}</td></tr>`;
}

function renderAlertFeed(elId, rows) {
  const el = document.getElementById(elId);
  if (!rows.length) { el.innerHTML = '<div class="empty">알림 없음</div>'; return; }
  el.innerHTML = rows.map(a => `
    <div class="alert-item">
      <div class="sev ${esc(a.severity)}"></div>
      <div class="t">${fmtT(a.ts)}</div>
      <div>${esc(a.message)}</div>
    </div>`).join("");
}

/* ================= 에이전트 정책 ================= */
async function renderAgents() {
  const d = await jget("/api/agents");
  const gateBadge = g => {
    if (!g) return '<span class="badge b-gray">대상 없음</span>';
    const q = g.avg_quality != null ? ` ${g.avg_quality.toFixed(2)}` : "";
    if (g.status === "approved") return `<span class="badge b-green">승인${q} · ${g.samples}건</span>`;
    if (g.status === "rejected") return `<span class="badge b-red">보류(품질미달)${q} · ${g.samples}건</span>`;
    return `<span class="badge b-blue">카나리 수집중 · ${g.samples}건</span>`;
  };
  document.querySelector("#agents-table tbody").innerHTML = d.rows.map(a => `
    <tr>
      <td><b>${esc(a.agent)}</b></td>
      <td style="white-space:normal;max-width:230px;color:var(--muted)">${esc(a.description)}</td>
      <td><button class="btn" data-toggle-cache="${esc(a.agent)}" data-val="${a.semantic_cache ? 0 : 1}"
            style="border:none;background:none;padding:0;cursor:pointer">
            ${a.semantic_cache
              ? `<span class="badge b-green">✓ 적용 (TTL ${a.cache_ttl}s)</span>`
              : '<span class="badge b-gray">미적용</span>'}</button></td>
      <td>${a.primary_model ? `${esc(a.primary_model)} → ${esc(a.downgrade_target || "—")}` : "—"}</td>
      <td>${gateBadge(a.gate)}</td>
      <td><button class="btn" data-toggle-down="${esc(a.agent)}" data-val="${a.downgrade_enabled ? 0 : 1}"
            style="border:none;background:none;padding:0;cursor:pointer">
            ${a.downgrade_enabled ? '<span class="badge b-blue">활성</span>' : '<span class="badge b-gray">비활성</span>'}</button></td>
      <td><button class="btn" data-toggle-cx="${esc(a.agent)}" data-val="${a.complexity_routing ? 0 : 1}"
            style="border:none;background:none;padding:0;cursor:pointer">
            ${a.complexity_routing ? '<span class="badge b-purple">활성 (≤0.3 강등)</span>' : '<span class="badge b-gray">비활성</span>'}</button></td>
      <td class="num">${a.tool_registry_tokens ? fmtTok(a.tool_registry_tokens) + " tok" : "—"}</td>
      <td class="num">${fmt$(a.max_cost_per_run, 2)} · ${a.max_steps}스텝</td>
      <td class="num">${fmtN(a.runs_24h)}</td>
      <td class="num">${a.avg_quality_24h != null ? a.avg_quality_24h.toFixed(2) : "—"}</td>
    </tr>`).join("") || '<tr><td colspan="11" class="empty">에이전트 없음</td></tr>';

  document.querySelectorAll("[data-toggle-cache]").forEach(b => b.onclick = async () => {
    await jpost("/api/agents/update", { agent: b.dataset.toggleCache, semantic_cache: b.dataset.val === "1" });
    renderAgents();
  });
  document.querySelectorAll("[data-toggle-down]").forEach(b => b.onclick = async () => {
    await jpost("/api/agents/update", { agent: b.dataset.toggleDown, downgrade_enabled: b.dataset.val === "1" });
    renderAgents();
  });
  document.querySelectorAll("[data-toggle-cx]").forEach(b => b.onclick = async () => {
    await jpost("/api/agents/update", { agent: b.dataset.toggleCx, complexity_routing: b.dataset.val === "1" });
    renderAgents();
  });
}

/* ================= 개발자 ================= */
async function renderDeveloper() {
  const agentSel = document.getElementById("dev-agent");
  const rr = await jget("/api/runs/recent?limit=40" + (agentSel.value ? `&agent=${encodeURIComponent(agentSel.value)}` : ""));
  // agent 옵션 채우기 (한 번만 갱신)
  const stats = await jget("/api/run_stats?hours=24");
  const agents = stats.rows.map(r => r.agent);
  if (agentSel.options.length - 1 !== agents.length) {
    const cur = agentSel.value;
    agentSel.innerHTML = '<option value="">전체</option>' + agents.map(a => `<option>${esc(a)}</option>`).join("");
    agentSel.value = cur;
  }
  const tb = document.querySelector("#dev-runs tbody");
  tb.innerHTML = rr.rows.map(r => {
    const st = r.status === "success" ? '<span class="badge b-green">성공</span>'
      : r.status === "killed" ? '<span class="badge b-red">차단</span>'
      : r.status === "failure" ? '<span class="badge b-yellow">실패</span>'
      : '<span class="badge b-blue">실행중</span>';
    const q = r.quality_score == null ? "—"
      : `<span style="color:${r.quality_passed ? "var(--green)" : "var(--red)"}">${r.quality_score.toFixed(2)}</span>`;
    return `<tr class="clickable" data-run="${esc(r.run_id)}">
      <td style="font-family:monospace;font-size:11px">${esc(r.run_id)}</td>
      <td>${esc(r.agent)}</td><td>${st}</td>
      <td class="num">${r.steps}</td><td class="num">${fmtTok(r.total_tokens)}</td>
      <td class="num">${fmt$(r.total_cost)}</td><td class="num">${q}</td></tr>`;
  }).join("") || '<tr><td colspan="7" class="empty">run 없음</td></tr>';
  tb.querySelectorAll("tr.clickable").forEach(tr => tr.addEventListener("click", () => {
    selectedRun = tr.dataset.run;
    renderRunDetail();
  }));
  if (!selectedRun && rr.rows.length) { selectedRun = rr.rows[0].run_id; }
  renderRunDetail();
}

async function renderRunDetail() {
  if (!selectedRun) return;
  const d = await jget("/api/runs/detail?run_id=" + encodeURIComponent(selectedRun));
  if (!d.run) return;
  document.getElementById("wf-title").textContent =
    `${d.run.run_id} · ${d.run.agent} · ${d.run.status}` + (d.run.kill_reason ? ` (${d.run.kill_reason})` : "");

  // 토큰 5종 구성
  const sum = k => d.steps.reduce((a, s) => a + (s[k] || 0), 0);
  upsertChart("ch-tokens", {
    type: "bar",
    data: {
      labels: ["input", "output", "cache_read", "cache_write", "reasoning"],
      datasets: [{
        data: [sum("input_tokens"), sum("output_tokens"), sum("cache_read_tokens"), sum("cache_write_tokens"), sum("reasoning_tokens")],
        backgroundColor: ["#4f8ff7", "#9d6ef7", "#3fb97a", "#e3b341", "#f85149"]
      }]
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: "tokens" } } }
    }
  });
  document.getElementById("dev-run-meta").innerHTML =
    `총 비용 <b>${fmt$(d.run.total_cost)}</b> · 절감 <b style="color:var(--green)">${fmt$(d.steps.reduce((a, s) => a + (s.savings_usd || 0), 0))}</b>` +
    ` · 스텝 ${d.run.steps} · 품질 ${d.run.quality_score == null ? "—" : d.run.quality_score.toFixed(2)}`;

  // 워터폴
  const wf = document.getElementById("waterfall");
  if (!d.steps.length) { wf.innerHTML = '<div class="empty">스텝 없음</div>'; return; }
  const maxC = Math.max(...d.steps.map(s => s.cost_usd), 1e-9);
  wf.innerHTML = d.steps.map(s => {
    const cls = s.cache_hit ? "cache" : s.routing_action === "downgrade" ? "downgrade" : "";
    const badges =
      (s.cache_hit ? '<span class="badge b-green">캐시</span>' : "") +
      (s.routing_action === "downgrade" ? `<span class="badge b-yellow">강등 ${esc(s.requested_model)}→${esc(s.model)}</span>` : "") +
      (s.reasoning_tokens ? '<span class="badge b-purple">reasoning</span>' : "");
    return `<div class="wf-row">
      <div class="wf-label">#${s.step} <b style="color:var(--text)">${esc(s.model)}</b> ${badges}</div>
      <div class="wf-bar-area"><div class="wf-bar ${cls}" style="width:${Math.max(1, s.cost_usd / maxC * 100)}%"></div></div>
      <div class="wf-cost">${fmt$(s.cost_usd, 5)}</div>
    </div>`;
  }).join("");
}

/* ================= 운영 ================= */
async function renderOps() {
  // 예산 게이지 — 그룹(테넌트별/에이전트별)으로 나눠 표시. 임계값은 막대 위 호버 툴팁으로(컴팩트).
  const bs = await jget("/api/budgets");
  const budgetRow = b => {
    const max = b.hard_limit || b.downgrade_limit || b.soft_limit || 1;
    const pct = Math.min(100, b.spent / max * 100);
    const cls = b.spent >= (b.downgrade_limit || Infinity) ? "crit" : b.spent >= (b.soft_limit || Infinity) ? "warn" : "";
    const ticks = [
      { v: b.soft_limit, label: "소프트" },
      { v: b.downgrade_limit, label: "강등" },
      { v: b.hard_limit, label: "하드", hard: true },
    ].filter(t => t.v).sort((a, z) => a.v - z.v);
    const marks = ticks.map(t =>
      `<div class="bar-mark ${t.hard ? "hard" : ""}" style="left:${Math.min(99.5, t.v / max * 100)}%"></div>`
    ).join("");
    const thresholds = ticks.map(t => `${t.label} ${fmt$(t.v, 0)}`).join(" · ");
    return `<div class="budget-row" title="임계: ${thresholds}">
      <div class="top"><span><b>${esc(b.scope_id)}</b></span>
        <span>${fmt$(b.spent, 2)} / ${fmt$(b.hard_limit, 0)} <span style="color:var(--muted);font-size:10.5px">(${thresholds})</span></span></div>
      <div class="bar-wrap">
        <div class="bar-fill ${cls}" style="width:${pct}%"></div>
        ${marks}
      </div></div>`;
  };
  const tenants = bs.rows.filter(b => b.scope_type === "tenant");
  const agents = bs.rows.filter(b => b.scope_type === "agent");
  const section = (title, rows) => rows.length
    ? `<div class="bg-group">${title}</div>` + rows.map(budgetRow).join("") : "";
  // 개요처럼 드롭다운으로 그룹 선택 (기본: 테넌트별). 전체 선택 시 두 그룹 모두 표시.
  const bgSel = document.getElementById("budget-group").value;
  let html = "";
  if (bgSel === "tenant") html = section("테넌트별", tenants);
  else if (bgSel === "agent") html = section("에이전트별", agents);
  else html = section("테넌트별", tenants) + section("에이전트별", agents);
  document.getElementById("budget-list").innerHTML = html || '<div class="empty">예산 설정 없음</div>';

  // p50/p95/p99 (세로 막대)
  const st = await jget("/api/run_stats?hours=24");
  upsertChart("ch-pct", {
    type: "bar",
    data: {
      labels: st.rows.map(r => r.agent),
      datasets: [
        { label: "p50", data: st.rows.map(r => r.p50), backgroundColor: "#4f8ff7" },
        { label: "p95", data: st.rows.map(r => r.p95), backgroundColor: "#e3b341" },
        { label: "p99", data: st.rows.map(r => r.p99), backgroundColor: "#f85149" }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { y: { title: { display: true, text: "USD/run" } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } }
    }
  });

  // 통제 이벤트
  const al = await jget("/api/alerts?limit=40");
  renderAlertFeed("ops-alerts", al.rows.filter(a => ["circuit_breaker", "budget_hard", "budget_soft", "config_change", "anomaly", "quality_guard"].includes(a.kind)));

  // GPU
  const g = await jget("/api/gpu?minutes=30");
  document.getElementById("gpu-idle").textContent = fmt$(g.idle_cost_per_hour, 2);
  document.getElementById("gpu-nodes").innerHTML = g.latest.map(n => `
    <div class="gpu-node">
      <div class="top"><b>${esc(n.node)}</b><span style="color:var(--muted)">$${n.cost_per_hour}/h · 큐 ${n.queue_depth}</span></div>
      <div class="mini-bars">
        <div class="mini-bar"><div class="lbl">GPU ${(n.gpu_util * 100).toFixed(0)}%</div><div class="mini-track"><div class="mini-fill" style="width:${n.gpu_util * 100}%"></div></div></div>
        <div class="mini-bar"><div class="lbl">MEM ${(n.mem_util * 100).toFixed(0)}%</div><div class="mini-track"><div class="mini-fill" style="width:${n.mem_util * 100}%;background:var(--accent2)"></div></div></div>
        <div class="mini-bar"><div class="lbl">KV캐시 ${(n.kv_cache_util * 100).toFixed(0)}%</div><div class="mini-track"><div class="mini-fill" style="width:${n.kv_cache_util * 100}%;background:var(--yellow)"></div></div></div>
      </div></div>`).join("");

  const byNode = {};
  g.series.forEach(r => { (byNode[r.node] = byNode[r.node] || []).push(r); });
  upsertChart("ch-gpu", {
    type: "line",
    data: {
      labels: (Object.values(byNode)[0] || []).map(r => fmtT(r.ts)),
      datasets: Object.entries(byNode).map(([n, rows], i) => ({
        label: n, data: rows.map(r => r.gpu_util * 100), borderColor: PALETTE[i], pointRadius: 0, borderWidth: 1.5, tension: .3
      }))
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { y: { min: 0, max: 100, title: { display: true, text: "util %" } }, x: { ticks: { maxTicksLimit: 6 } } },
      plugins: { legend: { display: false } }
    }
  });

  // killed runs
  const rr = await jget("/api/runs/recent?limit=100");
  const killed = rr.rows.filter(r => r.status === "killed").slice(0, 12);
  document.querySelector("#ops-killed tbody").innerHTML = killed.map(r => `
    <tr><td style="font-family:monospace;font-size:11px">${esc(r.run_id)}</td>
    <td>${esc(r.agent)}</td><td>${esc(r.tenant)}</td><td style="white-space:normal">${esc(r.kill_reason || "")}</td>
    <td class="num">${r.steps}</td><td class="num">${fmt$(r.total_cost)}</td></tr>`).join("")
    || '<tr><td colspan="6" class="empty">차단된 run 없음</td></tr>';
}

/* ================= 재무 ================= */
async function renderFinance() {
  const sb = await jget("/api/showback?hours=24");
  document.querySelector("#fin-showback tbody").innerHTML = sb.rows.map(r => `
    <tr><td><b>${esc(r.tenant)}</b></td><td class="num">${fmt$(r.cost, 3)}</td>
    <td class="num" style="color:var(--green)">${fmt$(r.savings, 3)}</td>
    <td class="num">${fmtTok(r.tokens)}</td><td class="num">${fmtN(r.calls)}</td>
    <td class="num">${(r.share * 100).toFixed(1)}%</td></tr>`).join("")
    || '<tr><td colspan="6" class="empty">데이터 없음</td></tr>';

  const sv = await jget("/api/savings?hours=24");
  const kindLabel = { semantic_cache: "시맨틱 캐시", prompt_cache: "프롬프트(prefix) 캐시",
                      routing_downshift: "라우팅 강등", skill_packer: "스킬패커(툴 동적로딩)" };
  upsertChart("ch-savings", {
    type: "doughnut",
    data: {
      labels: sv.by_kind.map(r => kindLabel[r.savings_kind] || r.savings_kind),
      datasets: [{ data: sv.by_kind.map(r => r.s), backgroundColor: ["#3fb97a", "#4f8ff7", "#e3b341", "#9d6ef7"], borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "58%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } }, tooltip: donutTooltipPct }
    },
    plugins: [donutPct]
  });
  document.getElementById("fin-cache-rate").textContent =
    `시맨틱 캐시 히트율(24h): ${(sv.cache_hit_rate * 100).toFixed(1)}% · 절감 합계 ${fmt$(sv.by_kind.reduce((a, r) => a + r.s, 0), 3)}`;

  const st = await jget("/api/run_stats?hours=24");
  document.querySelector("#fin-cop tbody").innerHTML = st.rows.map(r => {
    const copWarn = r.pass_rate != null && r.pass_rate < 0.8;
    return `<tr><td><b>${esc(r.agent)}</b></td><td class="num">${r.runs}</td>
    <td class="num" style="color:${copWarn ? "var(--red)" : "var(--text)"}">${r.pass_rate == null ? "—" : (r.pass_rate * 100).toFixed(0) + "%"}</td>
    <td class="num">${r.avg_quality == null ? "—" : r.avg_quality.toFixed(2)}</td>
    <td class="num">${fmt$(r.p50)}</td>
    <td class="num"><b>${r.cost_of_pass == null ? "—" : fmt$(r.cost_of_pass)}</b></td></tr>`;
  }).join("") || '<tr><td colspan="6" class="empty">데이터 없음</td></tr>';

  // 품질-비용 폐루프
  const qcSel = document.getElementById("qc-agent");
  if (qcSel.options.length - 1 !== st.rows.length) {
    const cur = qcSel.value;
    qcSel.innerHTML = '<option value="">전체 에이전트</option>' + st.rows.map(r => `<option>${esc(r.agent)}</option>`).join("");
    qcSel.value = cur;
  }
  const qc = await jget("/api/quality_cost?hours=24" + (qcSel.value ? `&agent=${encodeURIComponent(qcSel.value)}` : ""));
  const changeLines = {
    id: "changeLines",
    afterDraw(chart) {
      const xs = chart.scales.x;
      (qc.config_changes || []).forEach(c => {
        let idx = -1;
        for (let i = 0; i < (qc.rows || []).length; i++) if (qc.rows[i].bucket >= c.ts) { idx = i; break; }
        if (idx < 0) return;
        const x = xs.getPixelForValue(idx);
        const ctx = chart.ctx;
        ctx.save();
        ctx.strokeStyle = "#f85149"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x, chart.chartArea.top); ctx.lineTo(x, chart.chartArea.bottom); ctx.stroke();
        ctx.fillStyle = "#f85149"; ctx.font = "10px sans-serif";
        ctx.fillText("구성변경", x + 4, chart.chartArea.top + 12);
        ctx.restore();
      });
    }
  };
  if (charts["ch-qc"]) { charts["ch-qc"].destroy(); delete charts["ch-qc"]; }
  charts["ch-qc"] = new Chart(document.getElementById("ch-qc"), {
    type: "line",
    data: {
      labels: qc.rows.map(r => fmtT(r.bucket)),
      datasets: [
        { label: "평균 품질", data: qc.rows.map(r => r.q), yAxisID: "y", borderColor: "#3fb97a", pointRadius: 0, borderWidth: 2, tension: .3 },
        { label: "run당 평균 비용", data: qc.rows.map(r => r.c), yAxisID: "y1", borderColor: "#e3b341", pointRadius: 0, borderWidth: 2, tension: .3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: {
        y: { min: 0, max: 1, title: { display: true, text: "품질" } },
        y1: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "USD/run" } },
        x: { ticks: { maxTicksLimit: 8 } }
      },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } }
    },
    plugins: [changeLines]
  });

  // 모델 단가 마스터 (런타임 수정 — metis-ai ModelPrice 이식)
  const mp = await jget("/api/model_prices");
  document.querySelector("#fin-prices tbody").innerHTML = mp.rows.map(r => `
    <tr data-price-model="${esc(r.model)}">
      <td><b>${esc(r.model)}</b>${r.active ? "" : ' <span class="badge b-gray">비활성</span>'}</td>
      <td><span class="badge ${({premium:"b-purple",standard:"b-blue",economy:"b-green"})[r.tier] || "b-gray"}">${esc(r.tier)}</span></td>
      <td class="num"><input data-f="input_usd" type="number" step="0.01" value="${r.input_usd}" style="width:74px"></td>
      <td class="num"><input data-f="output_usd" type="number" step="0.01" value="${r.output_usd}" style="width:74px"></td>
      <td class="num"><input data-f="cache_read_usd" type="number" step="0.001" value="${r.cache_read_usd}" style="width:74px"></td>
      <td class="num"><input data-f="cache_write_usd" type="number" step="0.001" value="${r.cache_write_usd}" style="width:74px"></td>
      <td style="font-size:11.5px;color:var(--muted)">${esc(r.downgrade_to || "—")}</td>
      <td><button class="btn" data-price-save="${esc(r.model)}">저장</button></td>
    </tr>`).join("") || '<tr><td colspan="8" class="empty">데이터 없음</td></tr>';
  document.querySelectorAll("[data-price-save]").forEach(b => b.onclick = async () => {
    const tr = b.closest("tr");
    const body = { model: b.dataset.priceSave };
    tr.querySelectorAll("input[data-f]").forEach(i => body[i.dataset.f] = parseFloat(i.value));
    await jpost("/api/model_prices/update", body);
    b.textContent = "✓ 반영됨";
    setTimeout(() => { b.textContent = "저장"; }, 1500);
  });

  upsertChart("ch-cost-savings", {
    type: "bar",
    data: {
      labels: sv.series.map(r => fmtT(r.bucket)),
      datasets: [
        { label: "실비용", data: sv.series.map(r => r.cost), backgroundColor: "#4f8ff7", stack: "s" },
        { label: "절감액(회피 비용)", data: sv.series.map(r => r.savings), backgroundColor: "#3fb97a", stack: "s" }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { stacked: true, ticks: { maxTicksLimit: 12 } }, y: { stacked: true, title: { display: true, text: "USD/5min" } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } }
    }
  });
}

document.getElementById("btn-focus").addEventListener("click", () => {
  window.open(API + "/api/export/focus?hours=24", "_blank");
});

/* ================= 거버넌스 (Patent 3) ================= */
const CACHE_DEC_KO = {
  ALLOW: ["허용", "캐시 재사용 가능"],
  DENY_SENSITIVE_DATA: ["민감데이터 차단", "PII/기밀 — 재사용 금지"],
  DENY_HIGH_RISK: ["고위험 차단", "리스크 임계 초과 — 재사용 금지"],
  CACHE_DISABLED: ["캐시 비활성", "에이전트 정책상 캐시 OFF"],
};
async function renderGovernance() {
  const d = await jget("/api/governance?hours=24");
  document.getElementById("gv-compliance").textContent = (d.compliance * 100).toFixed(1) + "%";
  document.getElementById("gv-leaks").innerHTML = d.sensitive_leaks > 0
    ? `<span style="color:var(--red)">민감 캐시 누출 ${d.sensitive_leaks}건 ⚠</span>`
    : `<span style="color:var(--green)">민감 캐시 누출 0건 ✓</span>`;
  document.getElementById("gv-denied").textContent = fmtN(d.denied);
  document.getElementById("gv-escal").textContent = fmtN(d.escalations);
  document.getElementById("gv-total").textContent = fmtN(d.total);

  document.querySelector("#gv-cache-table tbody").innerHTML = d.cache_decisions.map(r => {
    const k = CACHE_DEC_KO[r.d] || [r.d, ""];
    const color = r.d.startsWith("DENY") ? "var(--red)" : r.d === "ALLOW" ? "var(--green)" : "var(--muted)";
    return `<tr><td style="color:${color};font-weight:600">${esc(k[0])}</td><td style="color:var(--muted)">${esc(k[1])}</td><td class="num">${fmtN(r.n)}</td></tr>`;
  }).join("") || '<tr><td colspan="3" class="empty">데이터 없음</td></tr>';

  const cls = d.by_class;
  upsertChart("gv-class-chart", {
    type: "bar",
    data: {
      labels: cls.map(r => r.d),
      datasets: [
        { label: "호출 수", data: cls.map(r => r.n), backgroundColor: "#4f8ff7", yAxisID: "y" },
        { label: "비용(USD)", data: cls.map(r => r.c), backgroundColor: "#9d6ef7", yAxisID: "y1" },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      scales: { y: { title: { display: true, text: "호출" } },
                y1: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "USD" } } },
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10 } } }
    }
  });

  const p = d.policy;
  document.getElementById("gv-policy").innerHTML =
    `거버넌스 엔진: <b style="color:${p.enabled ? "var(--green)" : "var(--red)"}">${p.enabled ? "활성" : "비활성"}</b><br>` +
    `캐시 재사용 금지 등급: <b>${esc(p.sensitive_classes)}</b><br>` +
    `고위험 캐시 차단 임계: <b>${p.high_risk_threshold}</b><br>` +
    `강등 방어(상향) 임계: <b>${p.escalate_risk_threshold}</b> · 안전 최소 티어: <b>${esc(p.safe_min_tier)}</b>`;
  document.getElementById("gv-safe-tier").value = p.safe_min_tier;

  renderAlertFeed("gv-events", d.events.map(e => ({ ts: e.ts, severity: e.severity, message: e.message })));
}
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "gv-toggle") {
    jget("/api/governance?hours=1").then(d => {
      jpost("/api/governance/update", { enabled: !d.policy.enabled }).then(() => refresh(true));
    });
  }
});

/* ================= 예측·이상감지 (metis-ai 지능 계층) ================= */
const ANOM_KO = { quality_drift: ["📉 품질 드리프트", "b-yellow"], token_spike: ["💥 토큰 스파이크", "b-yellow"],
                  latency_trend: ["🐢 지연 추세", "b-blue"], error_surge: ["🚨 에러 서지", "b-red"],
                  governance_pattern: ["🛡️ 거버넌스 패턴", "b-purple"] };

async function renderIntel() {
  // 1) 월말 예측
  const fc = await jget("/api/forecast");
  document.getElementById("fc-actual").textContent = fmt$(fc.current_month_actual, 2);
  document.getElementById("fc-days").textContent = `${fc.month} · ${fc.days_elapsed.toFixed(0)}/${fc.days_total}일 경과 · 일평균 ${fmt$(fc.avg_daily_cost, 2)}`;
  document.getElementById("fc-proj").textContent = fmt$(fc.projected_month_total, 2);
  document.getElementById("fc-mom").textContent = fc.mom_pct == null ? "전월 데이터 없음"
    : `전월(${fmt$(fc.previous_month_total, 2)}) 대비 ${fc.mom_pct > 0 ? "+" : ""}${fc.mom_pct}%`;
  document.getElementById("fc-savings").textContent = fmt$(fc.current_month_savings, 2);
  document.getElementById("fc-conf").textContent = (fc.confidence * 100).toFixed(0) + "%";

  // 2) 권고
  const recs = (await jget("/api/recommendations?refresh=1")).rows;
  document.getElementById("rec-list").innerHTML = recs.filter(r => r.status === "pending").map(r => `
    <div class="alert-item" style="align-items:flex-start">
      <div class="sev info"></div>
      <div style="flex:1">
        <b>${esc(r.title)}</b>
        ${r.est_saving_usd > 0 ? `<span class="badge b-green">~${fmt$(r.est_saving_usd, 4)} 절감</span>` : ""}<br>
        <span style="color:var(--muted)">${esc(r.body)}</span><br>
        ${r.action ? `<button class="btn primary" data-rec-apply="${r.id}" style="margin-top:6px">적용</button>` : ""}
        <button class="btn" data-rec-dismiss="${r.id}" style="margin-top:6px">무시</button>
      </div>
    </div>`).join("") || '<div class="empty">대기 중인 권고 없음 — 정책이 최적 상태입니다</div>';
  document.querySelectorAll("[data-rec-apply]").forEach(b => b.onclick = async () => {
    await jpost(`/api/recommendations/${b.dataset.recApply}/apply`);
    renderIntel();
  });
  document.querySelectorAll("[data-rec-dismiss]").forEach(b => b.onclick = async () => {
    await jpost(`/api/recommendations/${b.dataset.recDismiss}/dismiss`);
    renderIntel();
  });

  // 3) 이상감지
  const an = (await jget("/api/anomalies?hours=24")).rows;
  document.querySelector("#anomaly-table tbody").innerHTML = an.map(a => {
    const k = ANOM_KO[a.kind] || [a.kind, "b-gray"];
    return `<tr><td><span class="badge ${k[1]}">${k[0]}</span></td>
      <td>${esc(a.agent)}</td><td style="white-space:normal">${esc(a.message)}</td></tr>`;
  }).join("") || '<tr><td colspan="3" class="empty">감지된 이상 없음 ✓</td></tr>';

  // 4) 품질 가드레일 (조회는 자동원복 없이 — 원복은 백그라운드 루프/품질 게시 시점에 수행)
  const qg = await jget("/api/quality_guard?hours=24&auto=0");
  document.querySelector("#guard-table tbody").innerHTML = qg.rows.map(f => `
    <tr><td><b>${esc(f.agent)}</b></td>
      <td class="num">${f.high_q.toFixed(2)} (${f.high_n}건)</td>
      <td class="num" style="color:var(--red)">${f.low_q.toFixed(2)} (${f.low_n}건)</td>
      <td class="num" style="color:var(--red)"><b>-${f.drop_pct}%</b></td>
      <td>${f.reverted ? '<span class="badge b-red">자동 원복됨</span>'
            : `<button class="btn" data-guard-revert="${esc(f.agent)}">수동 원복</button>`}</td></tr>`).join("")
    || '<tr><td colspan="5" class="empty">품질 회귀 없음 ✓ (강등이 품질을 해치지 않음)</td></tr>';
  document.getElementById("guard-meta").textContent =
    `하락 임계 ${qg.drop_threshold_pct}% · 자동 원복 ${qg.auto_revert_default ? "ON" : "OFF"} (METIS_AUTO_REVERT)`;
  document.querySelectorAll("[data-guard-revert]").forEach(b => b.onclick = async () => {
    await jpost(`/api/quality_guard/${encodeURIComponent(b.dataset.guardRevert)}/revert`);
    renderIntel();
  });
}

document.getElementById("wf-run").addEventListener("click", async () => {
  const body = {
    cache_ttl_multiplier: parseFloat(document.getElementById("wf-ttl").value),
    downgrade_aggressive: document.getElementById("wf-down").checked,
    skill_trim_ratio: parseFloat(document.getElementById("wf-trim").value),
    hours: 24,
  };
  const w = await jpost("/api/whatif", body);
  document.getElementById("wf-result").innerHTML =
    `월 환산 기준선 <b>${fmt$(w.baseline_monthly_est, 2)}</b> → 시나리오 <b style="color:var(--green)">${fmt$(w.scenario_monthly_est, 2)}</b>` +
    ` <span class="badge b-green">절감 ${fmt$(w.savings_monthly_est, 2)}/월</span><br>` +
    `<span style="color:var(--muted);font-size:12px">캐시 TTL ${fmt$(w.breakdown.semantic_cache_ttl, 2)}` +
    ` · 전면 강등 ${fmt$(w.breakdown.routing_downshift_all, 2)}` +
    ` · 스킬패커 압축 ${fmt$(w.breakdown.skill_packer_trim, 2)}` +
    ` (윈도우 ${w.window_hours}h 실측 기반)</span>`;
});

/* ================= 인사이트 ================= */
async function renderInsights() {
  const ins = await jget("/api/insights");
  document.getElementById("insight-list").innerHTML = ins.rows.map(i => `
    <div class="insight ${esc(i.severity)}">
      <div class="ic">${i.icon}</div>
      <div><h4>${esc(i.title)}</h4><p>${esc(i.body)}</p></div>
    </div>`).join("");
}

/* ================= refresh loop ================= */
async function refresh(force) {
  try {
    if (currentView === "testagent") {
      document.getElementById("conn-dot").classList.add("ok");
      return; // 정적 폼 — 자동 갱신 불필요
    }
    if (currentView === "overview") await renderOverview();
    if (currentView === "agents") await renderAgents();
    if (currentView === "developer") await renderDeveloper();
    if (currentView === "ops") await renderOps();
    if (currentView === "finance") await renderFinance();
    if (currentView === "governance") await renderGovernance();
    if (currentView === "intel") await renderIntel();
    if (currentView === "insights") await renderInsights();
    document.getElementById("conn-dot").classList.add("ok");
    document.getElementById("conn-text").textContent = "Control Plane 연결됨";
  } catch (e) {
    document.getElementById("conn-dot").classList.remove("ok");
    document.getElementById("conn-text").textContent = "연결 끊김 — 재시도 중";
    console.error(e);
  }
}
/* ================= 테스트 에이전트 (네이티브) ================= */
const QA_SAMPLES = {
  py: { name: "sample_order.py", code: `"""주문 금액 계산 모듈 (데모 — 의도적 버그 포함)."""

def add(a=2, b=3):
    """두 수를 더한다.

    >>> add(1, 2)
    3
    """
    return a + b

def risky_parse(expr="1+1"):
    return eval(expr)   # 보안 위험

def buggy_average(nums=[]):   # 가변 기본 인자
    return sum(nums) / len(nums)
` },
  java: { name: "OrderService.java", code: `/** 주문 처리 서비스 (데모 — 의도적 이슈 포함). */
public class OrderService {

    /** 두 금액을 더한다. */
    public static int add(int a, int b) {
        return a + b;
    }

    public static boolean isVip(String grade) {
        return grade == "VIP";   // 버그: 문자열 == 비교
    }

    public static void process(String order) {
        try {
            System.out.println("processing: " + order);
        } catch (Exception e) {
        }
    }

    public static void main(String[] args) {
        System.out.println("sum=" + add(1, 2));
    }
}
` },
  c: { name: "payment.c", code: `/* 결제 금액 계산 (데모 — 의도적 취약점 포함) */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* 두 금액을 더한다 */
int add(int a, int b) {
    return a + b;
}

void copy_name(char *dst, const char *src) {
    strcpy(dst, src);   /* 경계 검사 없음 */
}

int main(void) {
    char name[16];
    int *buf = malloc(64);   /* free 없음 - 누수 */
    copy_name(name, "customer-001");
    printf("sum=%d name=%s\\n", add(1, 2), name);
    return 0;
}
` }
};
let qaReportId = null, qaRunId = null;

function qaSetSample(k) {
  document.getElementById("qa-code").value = QA_SAMPLES[k].code;
  document.getElementById("qa-fname").textContent = QA_SAMPLES[k].name;
  document.getElementById("qa-lang").textContent = { py: "Python", java: "Java", c: "C" }[k];
}
document.getElementById("qa-sample-py").onclick = () => qaSetSample("py");
document.getElementById("qa-sample-java").onclick = () => qaSetSample("java");
document.getElementById("qa-sample-c").onclick = () => qaSetSample("c");

document.getElementById("qa-file").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  document.getElementById("qa-fname").textContent = f.name;
  const ext = f.name.split(".").pop().toLowerCase();
  document.getElementById("qa-lang").textContent = { py: "Python", java: "Java", c: "C", h: "C" }[ext] || "자동감지";
  const r = new FileReader();
  r.onload = () => document.getElementById("qa-code").value = r.result;
  r.readAsText(f);
});

document.getElementById("qa-run").onclick = async () => {
  const code = document.getElementById("qa-code").value.trim();
  if (!code) { alert("코드를 입력하세요"); return; }
  const btn = document.getElementById("qa-run");
  btn.disabled = true;
  document.getElementById("qa-status").innerHTML =
    '<span class="spinner"></span>분석 중… (정적분석 → 컴파일/격리실행 → LLM 리뷰 3스텝 → 보고서 생성, 실 LLM 사용 시 30초 내외)';
  try {
    const r = await fetch("/api/qa/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: document.getElementById("qa-fname").textContent || "uploaded.py", code })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    qaReportId = d.report_id;
    qaRunId = d.run_id;
    document.getElementById("qa-status").textContent = "";
    document.getElementById("qa-report-area").style.display = "block";
    document.getElementById("qa-lang").textContent = { python: "Python", java: "Java", c: "C" }[d.language] || d.language;
    document.getElementById("qa-meta").innerHTML =
      `<span>Run ID <b style="color:var(--text)">${esc(d.run_id)}</b></span>` +
      `<span>언어 <b style="color:var(--text)">${esc(d.language)}</b></span>` +
      `<span>소요 <b style="color:var(--text)">${d.elapsed_s}s</b></span>` +
      `<span>LLM 비용 <b style="color:var(--text)">${d.cost_usd != null ? "$" + d.cost_usd.toFixed(6) : "—"}</b></span>` +
      `<span>모드 <b style="color:var(--text)">${esc(d.mode)}</b></span>`;
    document.getElementById("qa-report").innerHTML = marked.parse(d.markdown);
  } catch (e) {
    document.getElementById("qa-status").textContent = "오류: " + e.message;
  } finally {
    btn.disabled = false;
  }
};
document.getElementById("qa-docx").onclick = () => {
  if (qaReportId) window.open(`/api/qa/report/${qaReportId}/download?fmt=docx`, "_blank");
};
document.getElementById("qa-md").onclick = () => {
  if (qaReportId) window.open(`/api/qa/report/${qaReportId}/download?fmt=md`, "_blank");
};
document.getElementById("qa-goto-run").onclick = () => {
  if (!qaRunId) return;
  selectedRun = qaRunId;
  document.querySelector('.nav-item[data-view="developer"]').click();
};

document.getElementById("ov-group").addEventListener("change", () => refresh(true));
document.getElementById("ov-mins").addEventListener("change", () => refresh(true));
document.getElementById("ov-model-mins").addEventListener("change", () => refresh(true));
document.getElementById("ov-sav-hours").addEventListener("change", () => refresh(true));
document.getElementById("dev-agent").addEventListener("change", () => { selectedRun = null; refresh(true); });
document.getElementById("budget-group").addEventListener("change", () => refresh(true));
document.getElementById("qc-agent").addEventListener("change", () => refresh(true));
document.getElementById("gv-safe-tier").addEventListener("change", (e) => {
  jpost("/api/governance/update", { safe_min_tier: e.target.value }).then(() => refresh(true));
});
refresh(true);
setInterval(refresh, REFRESH_MS);

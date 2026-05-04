/* ===========================================
   AutoTrack — Customer-side logic
   - Rendering vehicles + history
   - Inspection date alerts
   - Repair pattern analytics
   - Fraud / anomaly detection
   - Add / Edit / Archive vehicles
   =========================================== */

/* ---------- TYPICAL PART LIFESPANS (Rwanda driving conditions) ---------- */
const PART_LIFESPANS_KM = {
  'engine oil':    { min: 5000,  max: 10000  },
  'oil filter':    { min: 5000,  max: 10000  },
  'air filter':    { min: 15000, max: 30000  },
  'brake pads':    { min: 30000, max: 70000  },
  'brake fluid':   { min: 40000, max: 80000  },
  'spark plugs':   { min: 30000, max: 100000 },
  'timing belt':   { min: 60000, max: 100000 },
  'battery':       { min: 60000, max: 90000  },
  'tires':         { min: 40000, max: 60000  }
};

function classifyPart(description) {
  const d = (description || '').toLowerCase();
  for (const key of Object.keys(PART_LIFESPANS_KM)) {
    if (d.includes(key)) return key;
  }
  return null;
}

/* ---------- DATE / DISPLAY HELPERS ---------- */
function daysBetween(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}
function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtMoney(n) { return '$' + Number(n || 0).toFixed(0); }

function vehicleMeta(v) { return getVehicleTypeMeta(v.type); }
function vehicleIcon(v) { return vehicleMeta(v).icon; }
function vehicleMileageLabel(v) {
  const meta = vehicleMeta(v);
  return `${(v.lastMileage || 0).toLocaleString()} ${meta.mileageUnit}`;
}

/* ---------- INSPECTION ALERTS ---------- */
function inspectionStatus(car) {
  const meta = vehicleMeta(car);
  if (!meta.needsRNP) return { level: 'na', label: 'No tech control required', days: null };
  const d = daysBetween(car.inspectionExpiryDate);
  if (d === null) return { level: 'unknown', label: 'No inspection date on file', days: null };
  if (d < 0)      return { level: 'expired', label: `Expired ${Math.abs(d)} days ago`, days: d };
  if (d === 0)    return { level: 'urgent',  label: 'Expires today',                  days: d };
  if (d <= 7)     return { level: 'urgent',  label: `Expires in ${d} day${d>1?'s':''}`, days: d };
  if (d <= 30)    return { level: 'warning', label: `Expires in ${d} days`,            days: d };
  return            { level: 'ok',      label: `Valid until ${fmtDate(car.inspectionExpiryDate)}`, days: d };
}

function renderInspectionAlerts(customer) {
  const container = document.getElementById('inspectionAlerts');
  if (!container) return;
  const cars = getCarsForCustomer(customer.email);
  const due = cars
    .map(c => ({ car: c, status: inspectionStatus(c) }))
    .filter(x => ['expired', 'urgent', 'warning'].includes(x.status.level));

  if (!due.length) { container.innerHTML = ''; updateAlertsBadge(customer); return; }

  container.innerHTML = due.map(({ car, status }) => {
    const palette = {
      expired: { bg: '#fef2f2', border: '#fecaca', accent: '#b91c1c', icon: '🚨' },
      urgent:  { bg: '#fff7ed', border: '#fed7aa', accent: '#c2410c', icon: '⚠️' },
      warning: { bg: '#fefce8', border: '#fde68a', accent: '#a16207', icon: '🟡' }
    }[status.level];

    return `
      <div style="background:${palette.bg};border:1px solid ${palette.border};border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <div style="font-size:22px;line-height:1;">${palette.icon}</div>
        <div style="flex:1;min-width:200px;">
          <p style="margin:0;font-weight:700;color:${palette.accent};">
            Tech control: ${status.label}
          </p>
          <p style="margin:2px 0 0;font-size:13px;color:#475569;">
            ${car.brand} ${car.model} (${car.plate}) — RNP inspection due ${fmtDate(car.inspectionExpiryDate)}
          </p>
        </div>
        <button onclick="openCustomerCar('${car.id}')" class="btn-secondary text-xs">View Vehicle</button>
      </div>
    `;
  }).join('');

  updateAlertsBadge(customer);
}

function updateAlertsBadge(customer) {
  const badge = document.getElementById('alertsBadge');
  if (!badge) return;
  const cars = getCarsForCustomer(customer.email);
  let count = 0;
  for (const car of cars) {
    const s = inspectionStatus(car);
    if (['expired', 'urgent', 'warning'].includes(s.level)) count++;
    count += detectAnomalies(car, getRepairsForCar(car.id)).length;
  }
  badge.textContent = String(count);
  badge.style.display = count ? 'inline-block' : 'none';
}

/* ---------- REPAIR PATTERNS / ANOMALY DETECTION ---------- */
function detectAnomalies(car, repairs) {
  const anomalies = [];
  const byPart = {};

  for (const r of repairs) {
    for (const item of (r.items || [])) {
      const part = classifyPart(item.description);
      if (!part) continue;
      if (!byPart[part]) byPart[part] = [];
      byPart[part].push({ repair: r, item });
    }
  }

  for (const [part, occurrences] of Object.entries(byPart)) {
    if (occurrences.length < 2) continue;
    occurrences.sort((a, b) => (a.repair.mileage || 0) - (b.repair.mileage || 0));
    const lifespan = PART_LIFESPANS_KM[part];
    if (!lifespan) continue;

    for (let i = 1; i < occurrences.length; i++) {
      const prev = occurrences[i - 1].repair;
      const curr = occurrences[i].repair;
      const kmDiff = (curr.mileage || 0) - (prev.mileage || 0);
      if (kmDiff > 0 && kmDiff < lifespan.min * 0.5) {
        anomalies.push({
          part, kmDiff, expected: lifespan.min, prev, curr,
          severity: kmDiff < lifespan.min * 0.25 ? 'high' : 'medium'
        });
      }
    }
  }
  return anomalies;
}

function aggregateRepairCounts(repairs) {
  const counts = {};
  for (const r of repairs) {
    for (const item of (r.items || [])) {
      const part = classifyPart(item.description) || item.description;
      counts[part] = (counts[part] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
}

function renderAnomalyCard(customer) {
  const container = document.getElementById('anomalyCard');
  if (!container) return;
  const cars = getCarsForCustomer(customer.email);
  let allAnomalies = [];
  for (const car of cars) {
    const repairs = getRepairsForCar(car.id);
    const found = detectAnomalies(car, repairs);
    found.forEach(a => allAnomalies.push({ car, ...a }));
  }

  if (!allAnomalies.length) { container.innerHTML = ''; return; }

  container.innerHTML = `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:14px;padding:18px;">
      <p style="margin:0 0 10px;font-weight:700;color:#991b1b;display:flex;align-items:center;gap:8px;">
        🚩 ${allAnomalies.length} unusual repair pattern${allAnomalies.length>1?'s':''} detected
      </p>
      <p style="margin:0 0 12px;font-size:13px;color:#7f1d1d;">
        These may indicate billing errors or repairs that weren't actually done. Always ask your garage for the old part as proof.
      </p>
      ${allAnomalies.map(a => `
        <div style="background:white;border-radius:10px;padding:12px;margin-bottom:8px;">
          <p style="margin:0;font-weight:600;font-size:14px;color:#1e293b;">
            ${a.car.brand} ${a.car.model} (${a.car.plate}) — ${a.part} replaced too soon
          </p>
          <p style="margin:4px 0 0;font-size:12px;color:#64748b;">
            Replaced ${a.kmDiff.toLocaleString()} km after the previous one. Typical interval: ${a.expected.toLocaleString()}+ km.
          </p>
          <p style="margin:6px 0 0;font-size:12px;color:#475569;">
            • ${fmtDate(a.prev.date)} — ${fmtMoney(a.prev.totalCost)} at ${a.prev.garageId}<br/>
            • ${fmtDate(a.curr.date)} — ${fmtMoney(a.curr.totalCost)} at ${a.curr.garageId}
          </p>
        </div>
      `).join('')}
    </div>
  `;
}

/* ---------- DASHBOARD ---------- */
function renderCustomerDashboard(customer) {
  const cars = getCarsForCustomer(customer.email);
  const allRepairs = cars.flatMap(c => getRepairsForCar(c.id));
  const totalSpent = allRepairs.reduce((sum, r) => sum + Number(r.totalCost || 0), 0);

  document.getElementById('customerStatVehicles').textContent = cars.length;
  document.getElementById('customerStatSpent').textContent = fmtMoney(totalSpent);
  document.getElementById('customerStatRepairs').textContent = allRepairs.length;

  const tbody = document.getElementById('customerRecentRepairs');
  if (!allRepairs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-gray-400 text-sm">No repairs on record yet.</td></tr>`;
  } else {
    const recent = [...allRepairs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
    tbody.innerHTML = recent.map(r => {
      const car = getCarById(r.carId);
      const statusClass = r.status === 'Completed' ? 'status-completed' : r.status === 'In Progress' ? 'status-progress' : 'status-pending';
      return `
        <tr class="hover:bg-gray-50 cursor-pointer" onclick="openCustomerCar('${r.carId}')">
          <td class="px-6 py-4 font-medium">${car ? vehicleIcon(car) + ' ' + car.brand + ' ' + car.model : '—'}</td>
          <td class="px-6 py-4">${r.title}</td>
          <td class="px-6 py-4 text-gray-500">${fmtDate(r.date)}</td>
          <td class="px-6 py-4 font-semibold">${fmtMoney(r.totalCost)}</td>
          <td class="px-6 py-4"><span class="status-badge ${statusClass}">${r.status}</span></td>
        </tr>
      `;
    }).join('');
  }

  renderInspectionAlerts(customer);
  renderAnomalyCard(customer);
}

/* ---------- VEHICLE LIST ---------- */
function renderCustomerVehicles(customer) {
  const activeCars   = getCarsForCustomer(customer.email);
  const allCars      = getCarsForCustomer(customer.email, { includeArchived: true });
  const archivedCars = allCars.filter(c => c.archived);

  document.getElementById('customerVehiclesSubtitle').textContent =
    `${activeCars.length} active vehicle${activeCars.length === 1 ? '' : 's'} linked to your account`;

  const grid = document.getElementById('customerVehiclesGrid');
  if (!activeCars.length) {
    grid.innerHTML = `
      <div class="col-span-3 bg-white rounded-2xl p-10 text-center border border-dashed border-gray-200">
        <p class="text-gray-500 text-sm mb-2">No active vehicles yet.</p>
        <p class="text-gray-400 text-xs mb-4">Add a vehicle yourself, or ask your garage to register it with <strong>${customer.email}</strong> as the owner email.</p>
        <button onclick="openAddVehicleForm()" class="btn-primary text-sm">+ Add Your First Vehicle</button>
      </div>`;
  } else {
    grid.innerHTML = activeCars.map(car => renderVehicleCard(car)).join('');
  }

  // Archived section
  const archSection = document.getElementById('customerArchivedSection');
  if (archSection) {
    if (archivedCars.length) {
      archSection.style.display = '';
      document.getElementById('customerArchivedCount').textContent =
        `${archivedCars.length} archived vehicle${archivedCars.length === 1 ? '' : 's'}`;
      const archGrid = document.getElementById('customerArchivedGrid');
      archGrid.innerHTML = archivedCars.map(car => renderVehicleCard(car, { archived: true })).join('');
    } else {
      archSection.style.display = 'none';
    }
  }
}

function renderVehicleCard(car, opts = {}) {
  const status = inspectionStatus(car);
  const repairs = getRepairsForCar(car.id);
  const meta = vehicleMeta(car);

  let badge = '';
  if (opts.archived) {
    badge = `<span class="status-badge" style="background:#f1f5f9;color:#475569;">Archived</span>`;
  } else if (status.level === 'expired') {
    badge = `<span class="status-badge" style="background:#fee2e2;color:#b91c1c;">Inspection ${status.label}</span>`;
  } else if (status.level === 'urgent') {
    badge = `<span class="status-badge" style="background:#fff7ed;color:#c2410c;">Inspection ${status.label}</span>`;
  } else if (status.level === 'warning') {
    badge = `<span class="status-badge" style="background:#fefce8;color:#a16207;">${status.label}</span>`;
  } else if (status.level === 'na') {
    badge = `<span class="status-badge" style="background:#f1f5f9;color:#475569;">${meta.label}</span>`;
  } else if (status.level === 'unknown') {
    badge = `<span class="status-badge" style="background:#f1f5f9;color:#475569;">No inspection date</span>`;
  } else {
    badge = `<span class="status-badge status-completed">Inspection valid</span>`;
  }

  return `
    <div class="card card-padded bg-white rounded-2xl border border-gray-100 shadow-sm p-5 ${opts.archived ? 'opacity-75' : ''}">
      <div class="flex items-start justify-between mb-4">
        <div class="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center" style="font-size:26px;line-height:1;">
          ${meta.icon}
        </div>
        ${badge}
      </div>
      <h3 class="font-bold text-gray-900">${car.brand} ${car.model}</h3>
      <p class="text-gray-500 text-sm">${car.year || '—'} · ${car.color || '—'} · <span class="text-xs">${meta.label}</span></p>
      <div class="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
        <span class="bg-gray-100 text-gray-700 text-xs font-bold px-3 py-1 rounded-full">${car.plate || '—'}</span>
        <span class="text-xs text-gray-400">${repairs.length} repair${repairs.length === 1 ? '' : 's'}</span>
      </div>
      <div class="flex gap-2 mt-3 flex-wrap">
        <button onclick="openCustomerCar('${car.id}')" class="btn-secondary text-xs flex-1">View</button>
        ${opts.archived
          ? `<button onclick="onRestoreVehicle('${car.id}')" class="btn-primary text-xs flex-1">Restore</button>
             ${repairs.length === 0 ? `<button onclick="onDeleteVehicleHard('${car.id}')" class="text-xs text-red-500 hover:underline">Delete</button>` : ''}`
          : `<button onclick="openEditVehicleForm('${car.id}')" class="btn-secondary text-xs">Edit</button>
             <button onclick="onArchiveVehicle('${car.id}')" class="text-xs text-red-500 hover:underline">Archive</button>`
        }
      </div>
    </div>
  `;
}

/* ---------- VEHICLE DETAIL ---------- */
let _currentCustomerCarId = null;

function openCustomerCar(carId) {
  _currentCustomerCarId = carId;
  showPage('customer-vehicle-detail');
  renderCustomerVehicleDetail();
}

function renderCustomerVehicleDetail() {
  const car = getCarById(_currentCustomerCarId);
  if (!car) return;
  const meta = vehicleMeta(car);

  document.getElementById('custCarTitle').textContent = `${meta.icon} ${car.brand} ${car.model}`;
  document.getElementById('custCarSubtitle').textContent =
    `${car.plate || '—'} · ${car.year || '—'} · ${car.color || '—'} · ${vehicleMileageLabel(car)} · ${meta.label}`;

  // Edit/archive buttons
  const actionsBox = document.getElementById('custCarActions');
  if (actionsBox) {
    const repairs = getRepairsForCar(car.id);
    actionsBox.innerHTML = `
      <button onclick="openEditVehicleForm('${car.id}')" class="btn-secondary text-xs">Edit Vehicle</button>
      ${car.archived
        ? `<button onclick="onRestoreVehicle('${car.id}')" class="btn-primary text-xs">Restore</button>
           ${repairs.length === 0 ? `<button onclick="onDeleteVehicleHard('${car.id}')" class="text-xs text-red-500 hover:underline">Hard Delete</button>` : ''}`
        : `<button onclick="onArchiveVehicle('${car.id}')" class="text-xs text-red-500 hover:underline">Archive</button>`}
    `;
  }

  // Inspection card
  const status = inspectionStatus(car);
  const inspBox = document.getElementById('custInspectionCard');
  const inspPalette = {
    ok:      { bg: '#f0fdf4', border: '#bbf7d0', accent: '#15803d', icon: '✅' },
    warning: { bg: '#fefce8', border: '#fde68a', accent: '#a16207', icon: '🟡' },
    urgent:  { bg: '#fff7ed', border: '#fed7aa', accent: '#c2410c', icon: '⚠️' },
    expired: { bg: '#fef2f2', border: '#fecaca', accent: '#b91c1c', icon: '🚨' },
    unknown: { bg: '#f1f5f9', border: '#e2e8f0', accent: '#475569', icon: 'ℹ️' },
    na:      { bg: '#f1f5f9', border: '#e2e8f0', accent: '#475569', icon: '➖' }
  }[status.level];
  inspBox.innerHTML = `
    <div style="background:${inspPalette.bg};border:1px solid ${inspPalette.border};border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      <div style="font-size:22px;">${inspPalette.icon}</div>
      <div style="flex:1;min-width:200px;">
        <p style="margin:0;font-weight:700;color:${inspPalette.accent};">Tech Control (RNP) — ${status.label}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#475569;">
          ${status.level === 'na'
              ? 'This vehicle type does not require road inspection.'
              : (car.inspectionExpiryDate
                  ? 'Expiry date: ' + fmtDate(car.inspectionExpiryDate)
                  : 'No expiry date on file. Edit the vehicle to add one.')}
        </p>
      </div>
    </div>
  `;

  // Patterns card
  const repairs = getRepairsForCar(car.id);
  const counts = aggregateRepairCounts(repairs);
  const anomalies = detectAnomalies(car, repairs);
  const patternsBox = document.getElementById('custPatternsCard');

  if (!counts.length) {
    patternsBox.innerHTML = '';
  } else {
    patternsBox.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <p class="text-sm font-semibold text-gray-700 mb-3">Repair patterns on this vehicle</p>
        <div class="space-y-2 mb-4">
          ${counts.map(([part, n]) => {
            const isAnomalous = anomalies.some(a => a.part === part);
            return `
              <div class="flex items-center justify-between text-sm">
                <span class="capitalize">${part}</span>
                <div class="flex items-center gap-2">
                  <span class="font-semibold">${n}×</span>
                  ${isAnomalous
                    ? '<span class="text-xs text-red-600 font-semibold">⚠️ unusual frequency</span>'
                    : '<span class="text-xs text-gray-400">normal</span>'}
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ${anomalies.length ? `
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px;font-size:12px;color:#7f1d1d;">
            <strong>⚠️ Note:</strong> ${anomalies.length} part${anomalies.length>1?'s':''} replaced more frequently than expected.
            Ask your garage for the old part next time as proof of work.
          </div>` : ''}
      </div>
    `;
  }

  // History timeline
  const tl = document.getElementById('custHistoryTimeline');
  document.getElementById('custHistoryTitle').textContent = `Repair History (${repairs.length} record${repairs.length === 1 ? '' : 's'})`;

  if (!repairs.length) {
    tl.innerHTML = `<p class="text-gray-400 text-sm text-center py-6">No repair records yet.</p>`;
    return;
  }

  tl.innerHTML = repairs.map((r, i) => {
    const dotColor = r.status === 'Completed' ? '#10b981' : r.status === 'In Progress' ? '#eab308' : '#94a3b8';
    const itemRows = (r.items || []).map(it => `
      <tr>
        <td class="px-3 py-2 ${it.type === 'Labor' ? 'text-orange-600' : 'text-blue-600'} font-medium">${it.type}</td>
        <td class="px-3 py-2">${it.description}</td>
        <td class="px-3 py-2">${it.qty}</td>
        <td class="px-3 py-2 text-right">${fmtMoney(it.qty * it.unitCost)}</td>
      </tr>
    `).join('');
    return `
      <div class="flex gap-4 ${i < repairs.length - 1 ? 'pb-8' : ''}">
        <div class="flex flex-col items-center">
          <div class="timeline-dot" style="background:${dotColor}"></div>
          ${i < repairs.length - 1 ? '<div class="timeline-line"></div>' : ''}
        </div>
        <div class="flex-1 bg-gray-50 rounded-xl p-4 -mt-1">
          <div class="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div>
              <p class="font-semibold text-gray-900">${r.title}</p>
              <p class="text-xs text-gray-400 mt-0.5">${fmtDate(r.date)} · ${(r.mileage || 0).toLocaleString()} ${vehicleMeta(car).mileageUnit} · ${r.technician || 'Garage'}</p>
            </div>
            <div class="flex items-center gap-2">
              <span class="status-badge ${r.status === 'Completed' ? 'status-completed' : r.status === 'In Progress' ? 'status-progress' : 'status-pending'}">${r.status}</span>
              <span class="font-bold text-gray-900">${fmtMoney(r.totalCost)}</span>
            </div>
          </div>
          ${itemRows ? `
            <div class="table-wrap">
              <table class="w-full text-xs border border-gray-200 rounded-lg overflow-hidden" style="min-width:480px">
                <thead class="bg-gray-100">
                  <tr>
                    <th class="px-3 py-2 text-left font-semibold text-gray-500">Type</th>
                    <th class="px-3 py-2 text-left font-semibold text-gray-500">Description</th>
                    <th class="px-3 py-2 text-left font-semibold text-gray-500">Qty</th>
                    <th class="px-3 py-2 text-right font-semibold text-gray-500">Cost</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 bg-white">${itemRows}</tbody>
              </table>
            </div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

/* ---------- ALERTS PAGE ---------- */
function renderCustomerAlertsPage(customer) {
  const container = document.getElementById('customerAlertsFull');
  const cars = getCarsForCustomer(customer.email);

  const inspections = cars.map(c => ({ car: c, status: inspectionStatus(c) }));
  const dueInspections = inspections.filter(x => ['expired', 'urgent', 'warning'].includes(x.status.level));

  let allAnomalies = [];
  for (const car of cars) {
    detectAnomalies(car, getRepairsForCar(car.id))
      .forEach(a => allAnomalies.push({ car, ...a }));
  }

  if (!dueInspections.length && !allAnomalies.length) {
    container.innerHTML = `
      <div class="bg-green-50 border border-green-200 rounded-2xl p-6 text-center">
        <p class="text-2xl mb-2">✅</p>
        <p class="font-semibold text-green-800">All clear!</p>
        <p class="text-sm text-green-700 mt-1">No upcoming inspections or unusual repair patterns.</p>
      </div>`;
    return;
  }

  let html = '';
  if (dueInspections.length) {
    html += `<h2 class="text-sm font-semibold text-gray-500 uppercase mb-2">Inspections Due</h2>`;
    html += dueInspections.map(({ car, status }) => `
      <div class="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:bg-gray-50" onclick="openCustomerCar('${car.id}')">
        <p class="font-semibold">${vehicleIcon(car)} ${car.brand} ${car.model} (${car.plate || '—'})</p>
        <p class="text-sm text-gray-600 mt-1">RNP inspection ${status.label.toLowerCase()} — due ${fmtDate(car.inspectionExpiryDate)}</p>
      </div>
    `).join('');
  }
  if (allAnomalies.length) {
    html += `<h2 class="text-sm font-semibold text-gray-500 uppercase mb-2 mt-6">Unusual Repair Patterns</h2>`;
    html += allAnomalies.map(a => `
      <div class="bg-white rounded-xl border border-red-200 p-4 cursor-pointer hover:bg-gray-50" onclick="openCustomerCar('${a.car.id}')">
        <p class="font-semibold">🚩 ${a.car.brand} ${a.car.model} (${a.car.plate || '—'})</p>
        <p class="text-sm text-gray-600 mt-1">${a.part} replaced ${a.kmDiff.toLocaleString()} km after the previous one (typical: ${a.expected.toLocaleString()}+ km)</p>
      </div>
    `).join('');
  }
  container.innerHTML = html;
}

/* ===========================================================
   ADD / EDIT VEHICLE — shared form for both customer & garage
   =========================================================== */

let _editingVehicleId = null;        // null = adding new
let _vehicleFormCallerRole = null;   // 'customer' | 'garage' (controls which fields show + redirect)

function openAddVehicleForm() {
  _editingVehicleId = null;
  _vehicleFormCallerRole = 'customer';
  showPage('customer-vehicle-form');
  populateVehicleForm(null);
}

function openEditVehicleForm(carId) {
  _editingVehicleId = carId;
  const cu = getCurrentUser();
  _vehicleFormCallerRole = cu ? cu.role : 'customer';
  showPage(_vehicleFormCallerRole === 'garage' ? 'addcar' : 'customer-vehicle-form');
  populateVehicleForm(getCarById(carId));
  // Update title for garage form
  const garageTitle = document.getElementById('garageAddCarTitle');
  if (garageTitle && _vehicleFormCallerRole === 'garage') {
    garageTitle.textContent = carId ? 'Edit Vehicle' : 'Add New Vehicle';
  }
}

function populateVehicleForm(car) {
  // Build the vehicle type dropdown options
  const typeOptions = Object.entries(VEHICLE_TYPES)
    .map(([k, v]) => `<option value="${k}" ${car && car.type === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`)
    .join('');

  // Customer form
  const custForm = document.getElementById('customerVehicleForm');
  if (custForm) {
    custForm.innerHTML = renderVehicleFormHTML(car, 'customer', typeOptions);
    attachVehicleFormHandlers('customer');
  }

  // Garage form (re-renders the inner HTML so it has the type field)
  const garageForm = document.getElementById('garageVehicleForm');
  if (garageForm) {
    garageForm.innerHTML = renderVehicleFormHTML(car, 'garage', typeOptions);
    attachVehicleFormHandlers('garage');
  }

  // Title
  const custTitle = document.getElementById('customerVehicleFormTitle');
  if (custTitle) custTitle.textContent = car ? 'Edit Vehicle' : 'Add a Vehicle';
}

function renderVehicleFormHTML(car, role, typeOptions) {
  const isEdit = !!car;
  return `
    <div class="form-grid-2 grid grid-cols-2 gap-5 mb-5">
      <div class="col-span-2">
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Vehicle Type *</label>
        <select name="type" id="vfType" required onchange="onVehicleTypeChange()">${typeOptions}</select>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Brand / Make *</label>
        <input type="text" name="brand" placeholder="e.g. Toyota" value="${isEdit ? esc(car.brand) : ''}" required/>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Model *</label>
        <input type="text" name="model" placeholder="e.g. Corolla" value="${isEdit ? esc(car.model) : ''}" required/>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Year</label>
        <input type="number" name="year" placeholder="e.g. 2019" min="1900" max="2099" value="${isEdit && car.year ? car.year : ''}"/>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Color</label>
        <input type="text" name="color" placeholder="e.g. Silver" value="${isEdit ? esc(car.color) : ''}"/>
      </div>
      <div id="vfPlateBox">
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Plate Number <span id="vfPlateRequired">*</span></label>
        <input type="text" name="plate" placeholder="e.g. RAB 123A" class="font-mono uppercase" value="${isEdit ? esc(car.plate) : ''}"/>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">VIN / Identification (optional)</label>
        <input type="text" name="vin" placeholder="VIN or frame number" value="${isEdit ? esc(car.vin) : ''}"/>
      </div>
      <div>
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Last Mileage <span id="vfMileageUnit">(km)</span></label>
        <input type="number" name="lastMileage" placeholder="0" min="0" value="${isEdit && car.lastMileage ? car.lastMileage : ''}"/>
      </div>
      <div id="vfRnpBox">
        <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Tech Control Expiry (RNP)</label>
        <input type="date" name="inspectionExpiryDate" value="${isEdit && car.inspectionExpiryDate ? car.inspectionExpiryDate : ''}"/>
        <p class="text-[11px] text-gray-400 mt-1">You'll get reminders before this date.</p>
      </div>
    </div>

    ${role === 'garage' ? `
      <hr class="my-5 border-gray-100"/>
      <p class="text-sm font-semibold text-gray-700 mb-4">Owner Information</p>
      <div class="form-grid-2 grid grid-cols-2 gap-5 mb-5">
        <div>
          <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Owner Name *</label>
          <input type="text" name="ownerName" placeholder="Full name" value="${isEdit ? esc(car.ownerName) : ''}" required/>
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Owner Email *</label>
          <input type="email" name="ownerEmail" placeholder="owner@example.com" value="${isEdit ? esc(car.ownerEmail) : ''}" required/>
          <p class="text-[11px] text-gray-400 mt-1">Used to link this vehicle to the customer's account.</p>
        </div>
        <div>
          <label class="block text-xs font-semibold text-gray-500 mb-1.5 uppercase">Phone Number</label>
          <input type="tel" name="ownerPhone" placeholder="+250 788 000 000" value="${isEdit ? esc(car.ownerPhone) : ''}"/>
        </div>
      </div>
    ` : ''}

    <div class="flex gap-3 flex-wrap">
      <button type="button" onclick="cancelVehicleForm()" class="btn-secondary">Cancel</button>
      <button type="submit" class="btn-primary">${isEdit ? 'Save Changes' : 'Save Vehicle'}</button>
    </div>
  `;
}

/* HTML escape (for safe value="" interpolation) */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

function onVehicleTypeChange() {
  const sel = document.getElementById('vfType');
  if (!sel) return;
  const meta = getVehicleTypeMeta(sel.value);
  // Mileage unit label
  const unit = document.getElementById('vfMileageUnit');
  if (unit) unit.textContent = `(${meta.mileageUnit})`;
  // RNP box visibility
  const rnpBox = document.getElementById('vfRnpBox');
  if (rnpBox) rnpBox.style.display = meta.needsRNP ? '' : 'none';
  // Plate required marker
  const plateReq = document.getElementById('vfPlateRequired');
  if (plateReq) plateReq.textContent = meta.needsPlate ? '*' : '(optional)';
}

function attachVehicleFormHandlers(role) {
  const form = document.getElementById(role === 'customer' ? 'customerVehicleFormEl' : 'garageVehicleFormEl');
  if (!form) return;

  // Initial visibility tweak
  setTimeout(onVehicleTypeChange, 0);

  form.onsubmit = (event) => {
    event.preventDefault();
    handleVehicleFormSubmit(role);
  };
}

async function handleVehicleFormSubmit(role) {
  const formId = role === 'customer' ? 'customerVehicleFormEl' : 'garageVehicleFormEl';
  const form = document.getElementById(formId);
  if (!form) return;
  const fd = new FormData(form);

  const fields = {
    type:                 fd.get('type'),
    brand:                fd.get('brand'),
    model:                fd.get('model'),
    year:                 fd.get('year'),
    color:                fd.get('color'),
    plate:                fd.get('plate'),
    vin:                  fd.get('vin'),
    lastMileage:          fd.get('lastMileage'),
    inspectionExpiryDate: fd.get('inspectionExpiryDate'),
  };

  const errBox = document.getElementById(role === 'customer' ? 'customerVehicleFormError' : 'garageVehicleFormError');
  if (errBox) errBox.classList.remove('show');

  try {
    if (_editingVehicleId) {
      // EDIT mode
      if (role === 'garage') {
        fields.ownerName  = fd.get('ownerName');
        fields.ownerEmail = fd.get('ownerEmail');
        fields.ownerPhone = fd.get('ownerPhone');
      }
      await updateVehicle(_editingVehicleId, fields);
      _editingVehicleId = null;
      if (role === 'customer') {
        showPage('customer-vehicles');
        renderCustomerVehicles(getCurrentCustomer());
      } else {
        showPage('cars');
        renderGarageVehiclesList();
      }
      return;
    }

    // ADD mode
    if (role === 'customer') {
      const customer = getCurrentCustomer();
      fields.ownerName  = customer.fullName;
      fields.ownerEmail = customer.email;
      fields.ownerPhone = customer.phone || '';
      fields.addedBy    = 'customer';
      fields.garageId   = null;
      await addVehicle(fields);
      showPage('customer-vehicles');
      renderCustomerVehicles(customer);
    } else {
      const store = getCurrentStore();
      fields.ownerName  = fd.get('ownerName');
      fields.ownerEmail = fd.get('ownerEmail');
      fields.ownerPhone = fd.get('ownerPhone');
      fields.addedBy    = 'garage';
      fields.garageId   = store.id;

      // Claim flow: if a vehicle with this plate already exists, prompt
      const existing = findVehicleByPlate(fields.plate);
      if (existing && !existing.archived) {
        const ownerNote = existing.ownerEmail
          ? `Owner email on file: ${existing.ownerEmail}`
          : 'No owner email on file';
        const ok = confirm(
          `A vehicle with plate ${existing.plate} already exists.\n` +
          `${existing.brand} ${existing.model} (${existing.year || '—'})\n` +
          `${ownerNote}\n\n` +
          `Click OK to link (claim) this existing vehicle to your garage instead of creating a duplicate. Cancel to abort.`
        );
        if (!ok) return;
        await claimVehicle(existing.id, store.id);
        // Optionally update fields the garage typed
        const updates = {};
        ['ownerName','ownerEmail','ownerPhone','lastMileage','inspectionExpiryDate']
          .forEach(k => { if (fields[k]) updates[k] = fields[k]; });
        if (Object.keys(updates).length) await updateVehicle(existing.id, updates);
        showPage('cars');
        renderGarageVehiclesList();
        return;
      }

      await addVehicle(fields);
      showPage('cars');
      renderGarageVehiclesList();
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    } else {
      alert(err.message);
    }
  }
}

function cancelVehicleForm() {
  _editingVehicleId = null;
  const cu = getCurrentUser();
  if (cu && cu.role === 'customer') showPage('customer-vehicles');
  else                              showPage('cars');
}

/* ---------- ARCHIVE / RESTORE / HARD-DELETE handlers ---------- */
async function onArchiveVehicle(carId) {
  const car = getCarById(carId);
  if (!car) return;
  if (!confirm(`Archive ${car.brand} ${car.model} (${car.plate || 'no plate'})?\n\nIt will disappear from your active vehicles list, but all its repair history will be kept and can be restored later.`)) return;
  try {
    await archiveVehicle(carId);
    refreshAfterMutation();
  } catch (err) {
    alert(err.message);
  }
}

async function onRestoreVehicle(carId) {
  try {
    await restoreVehicle(carId);
    refreshAfterMutation();
  } catch (err) {
    alert(err.message);
  }
}

async function onDeleteVehicleHard(carId) {
  const car = getCarById(carId);
  if (!car) return;
  if (!confirm(`Permanently delete ${car.brand} ${car.model}?\n\nThis cannot be undone. (Allowed only because it has no repair records.)`)) return;
  try {
    await deleteVehicleHard(carId);
    refreshAfterMutation();
  } catch (err) {
    alert(err.message);
  }
}

function refreshAfterMutation() {
  const cu = getCurrentUser();
  if (!cu) return;
  if (cu.role === 'customer') {
    renderCustomerVehicles(cu.user);
    updateAlertsBadge(cu.user);
    if (document.getElementById('page-customer-dashboard').classList.contains('active')) {
      renderCustomerDashboard(cu.user);
    }
    if (document.getElementById('page-customer-vehicle-detail').classList.contains('active')) {
      // If the current vehicle was hard-deleted, bounce back
      if (!getCarById(_currentCustomerCarId)) showPage('customer-vehicles');
      else renderCustomerVehicleDetail();
    }
  } else {
    renderGarageVehiclesList();
  }
}

/* ---------- GARAGE-SIDE VEHICLE LIST RENDERING ---------- */
function renderGarageVehiclesList() {
  const store = getCurrentStore();
  if (!store) return;

  const active   = getCarsForGarage(store.id);
  const archived = getCarsForGarage(store.id, { includeArchived: true }).filter(c => c.archived);

  const grid = document.getElementById('garageVehiclesGrid');
  const subtitle = document.getElementById('garageVehiclesSubtitle');
  if (subtitle) subtitle.textContent = `${active.length} vehicle${active.length === 1 ? '' : 's'} registered`;

  if (!grid) return;

  if (!active.length) {
    grid.innerHTML = `
      <div class="col-span-3 bg-white rounded-2xl p-10 text-center border border-dashed border-gray-200">
        <p class="text-gray-500 text-sm mb-3">No vehicles registered yet.</p>
        <button onclick="openGarageAddVehicle()" class="btn-primary text-sm">+ Add Your First Vehicle</button>
      </div>`;
  } else {
    grid.innerHTML = active.map(car => renderGarageVehicleCard(car)).join('') +
      `<div class="card card-padded bg-white rounded-2xl border border-dashed border-gray-200 p-5 cursor-pointer flex flex-col items-center justify-center text-center" onclick="openGarageAddVehicle()" style="min-height:180px;">
        <div class="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mb-3">
          <svg class="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        </div>
        <p class="text-sm font-medium text-gray-500">Add New Vehicle</p>
      </div>`;
  }

  const archSection = document.getElementById('garageArchivedSection');
  if (archSection) {
    if (archived.length) {
      archSection.style.display = '';
      document.getElementById('garageArchivedCount').textContent =
        `${archived.length} archived vehicle${archived.length === 1 ? '' : 's'}`;
      const archGrid = document.getElementById('garageArchivedGrid');
      archGrid.innerHTML = archived.map(car => renderGarageVehicleCard(car, { archived: true })).join('');
    } else {
      archSection.style.display = 'none';
    }
  }
}

function renderGarageVehicleCard(car, opts = {}) {
  const meta = vehicleMeta(car);
  const repairs = getRepairsForCar(car.id);
  const status = inspectionStatus(car);
  const badge = opts.archived
    ? `<span class="status-badge" style="background:#f1f5f9;color:#475569;">Archived</span>`
    : status.level === 'expired'
        ? `<span class="status-badge" style="background:#fee2e2;color:#b91c1c;">RNP ${status.label}</span>`
    : status.level === 'urgent'
        ? `<span class="status-badge" style="background:#fff7ed;color:#c2410c;">RNP ${status.label}</span>`
    : status.level === 'warning'
        ? `<span class="status-badge" style="background:#fefce8;color:#a16207;">${status.label}</span>`
        : `<span class="status-badge status-completed">Active</span>`;

  return `
    <div class="card card-padded bg-white rounded-2xl border border-gray-100 shadow-sm p-5 ${opts.archived ? 'opacity-75' : ''}">
      <div class="flex items-start justify-between mb-4">
        <div class="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center" style="font-size:26px;line-height:1;">${meta.icon}</div>
        ${badge}
      </div>
      <h3 class="font-bold text-gray-900">${car.brand} ${car.model}</h3>
      <p class="text-gray-500 text-sm">${car.year || '—'} · ${car.color || '—'} · <span class="text-xs">${meta.label}</span></p>
      <div class="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
        <span class="bg-gray-100 text-gray-700 text-xs font-bold px-3 py-1 rounded-full">${car.plate || '—'}</span>
        <span class="text-xs text-gray-400">${repairs.length} repair${repairs.length === 1 ? '' : 's'}</span>
      </div>
      <p class="text-xs text-gray-400 mt-2">Owner: ${car.ownerName || '—'}</p>
      <div class="flex gap-2 mt-3 flex-wrap">
        <button onclick="openEditVehicleForm('${car.id}')" class="btn-secondary text-xs flex-1">Edit</button>
        ${opts.archived
          ? `<button onclick="onRestoreVehicle('${car.id}')" class="btn-primary text-xs flex-1">Restore</button>
             ${repairs.length === 0 ? `<button onclick="onDeleteVehicleHard('${car.id}')" class="text-xs text-red-500 hover:underline">Delete</button>` : ''}`
          : `<button onclick="onArchiveVehicle('${car.id}')" class="text-xs text-red-500 hover:underline">Archive</button>`}
      </div>
    </div>`;
}

function openGarageAddVehicle() {
  _editingVehicleId = null;
  _vehicleFormCallerRole = 'garage';
  showPage('addcar');
  populateVehicleForm(null);
  const garageTitle = document.getElementById('garageAddCarTitle');
  if (garageTitle) garageTitle.textContent = 'Add New Vehicle';
}

/* ---------- CUSTOMER PDF (full vehicle history) ---------- */
function generateCustomerVehiclePDF() {
  const car = getCarById(_currentCustomerCarId);
  if (!car) return;
  const repairs = getRepairsForCar(car.id);
  const customer = getCurrentCustomer();
  const meta = vehicleMeta(car);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFillColor(37, 99, 235);
  doc.rect(0, 0, 220, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text('AutoTrack — Vehicle History', 14, 18);

  doc.setTextColor(40, 40, 40);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');

  doc.setFillColor(245, 247, 250);
  doc.roundedRect(14, 36, 182, 38, 3, 3, 'F');
  doc.setFont(undefined, 'bold');
  doc.text('Vehicle Information', 20, 46);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.text(`${meta.label}: ${car.brand} ${car.model}`, 20, 54);
  doc.text(`Plate: ${car.plate || '—'}`, 20, 61);
  doc.text(`Year / Color: ${car.year || '—'} · ${car.color || '—'}`, 20, 68);
  doc.text(`Owner: ${customer.fullName}`, 105, 54);
  doc.text(`Email: ${customer.email}`, 105, 61);
  const inspText = meta.needsRNP
    ? `Inspection: ${car.inspectionExpiryDate ? fmtDate(car.inspectionExpiryDate) : '—'}`
    : 'Inspection: N/A';
  doc.text(inspText, 105, 68);

  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text(`Repair History (${repairs.length} records)`, 14, 84);

  const rows = [];
  for (const r of repairs) {
    rows.push([fmtDate(r.date), r.title, (r.mileage || 0).toLocaleString() + ' ' + meta.mileageUnit, r.status, fmtMoney(r.totalCost)]);
  }

  doc.autoTable({
    startY: 90,
    head: [['Date', 'Service', 'Mileage', 'Status', 'Cost']],
    body: rows.length ? rows : [['—', 'No repairs yet', '—', '—', '—']],
    foot: [['', '', '', 'TOTAL', fmtMoney(repairs.reduce((s, r) => s + Number(r.totalCost || 0), 0))]],
    headStyles: { fillColor: [37, 99, 235], fontSize: 9 },
    footStyles: { fillColor: [240, 245, 255], fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 4: { halign: 'right' } },
    margin: { left: 14, right: 14 }
  });

  const anomalies = detectAnomalies(car, repairs);
  if (anomalies.length) {
    const y = doc.lastAutoTable.finalY + 10;
    doc.setFillColor(254, 242, 242);
    doc.roundedRect(14, y, 182, 8 + anomalies.length * 14, 3, 3, 'F');
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(153, 27, 27);
    doc.text('Unusual Repair Patterns', 20, y + 6);
    doc.setFont(undefined, 'normal');
    doc.setFontSize(9);
    doc.setTextColor(127, 29, 29);
    anomalies.forEach((a, i) => {
      doc.text(`• ${a.part} replaced ${a.kmDiff.toLocaleString()} km after previous (typical: ${a.expected.toLocaleString()}+ km)`,
        20, y + 14 + i * 5);
    });
  }

  doc.setFillColor(37, 99, 235);
  doc.rect(0, 285, 220, 15, 'F');
  doc.setTextColor(255);
  doc.setFontSize(8);
  doc.text('AutoTrack · Generated ' + new Date().toLocaleDateString(), 14, 294);

  doc.save(`vehicle-history-${(car.plate || car.id).replace(/\s+/g, '')}.pdf`);

  const toast = document.getElementById('pdfToast');
  toast.classList.remove('hidden');
  toast.classList.add('flex');
  setTimeout(() => { toast.classList.add('hidden'); toast.classList.remove('flex'); }, 3000);
}

/* ---------- ROUTING HOOK ---------- */
/* Called by script.js's showPage() when a customer page is opened */
function onCustomerPageShow(pageName) {
  const customer = getCurrentCustomer();
  if (!customer) return;
  if (pageName === 'customer-dashboard')      renderCustomerDashboard(customer);
  if (pageName === 'customer-vehicles')       renderCustomerVehicles(customer);
  if (pageName === 'customer-vehicle-detail') renderCustomerVehicleDetail();
  if (pageName === 'customer-alerts')         renderCustomerAlertsPage(customer);
  if (pageName === 'customer-vehicle-form')   populateVehicleForm(_editingVehicleId ? getCarById(_editingVehicleId) : null);
}

/* Hook for garage pages */
function onGaragePageShow(pageName) {
  if (pageName === 'dashboard') renderGarageDashboard(getCurrentStore());
  if (pageName === 'cars')      renderGarageVehiclesList();
  if (pageName === 'addcar')    populateVehicleForm(_editingVehicleId ? getCarById(_editingVehicleId) : null);
  if (pageName === 'cardetail') renderGarageCarDetail();
  if (pageName === 'repairs')   renderGarageRepairsList();
  if (pageName === 'addrepair') populateGarageRepairForm();
}

/* ===========================================================
   GARAGE DASHBOARD — stats + recent repairs
   =========================================================== */
function renderGarageDashboard(store) {
  if (!store) return;
  const cars = getCarsForGarage(store.id);

  // Repairs at THIS garage
  const ourRepairs = _cache.repairs.filter(r => r.garageId === store.id);

  const totalCars   = cars.length;
  const openRepairs = ourRepairs.filter(r => r.status === 'In Progress' || r.status === 'Pending').length;
  const completed   = ourRepairs.filter(r => r.status === 'Completed').length;

  const now        = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const revenueThisMonth = ourRepairs
    .filter(r => new Date(r.date) >= monthStart && r.status === 'Completed')
    .reduce((sum, r) => sum + Number(r.totalCost || 0), 0);
  const carsThisMonth = cars.filter(c => new Date(c.createdAt || 0) >= monthStart).length;

  // Stats
  const statsBox = document.getElementById('garageDashboardStats');
  if (statsBox) {
    statsBox.innerHTML = [
      _statCardHtml({ label: 'Total Cars',   value: totalCars,
                      sub: `${carsThisMonth ? '+'+carsThisMonth : 'No new'} this month`, tint: 'blue',   icon: 'car'    }),
      _statCardHtml({ label: 'Open Repairs', value: openRepairs,
                      sub: 'In progress',                                tint: 'yellow', icon: 'clock'  }),
      _statCardHtml({ label: 'Completed',    value: completed,
                      sub: 'All time',                                   tint: 'green',  icon: 'check'  }),
      _statCardHtml({ label: 'Revenue',      value: '$' + revenueThisMonth.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                      sub: 'This month',                                 tint: 'purple', icon: 'dollar' })
    ].join('');
  }

  // Recent repairs (top 5 by date)
  const recent = [...ourRepairs].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  const tbody = document.getElementById('garageDashboardRecentRepairs');
  if (!tbody) return;
  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-6 py-8 text-center text-gray-400 text-sm">No repairs logged yet — register a vehicle and click "Log Repair" to get started.</td></tr>`;
  } else {
    tbody.innerHTML = recent.map(r => {
      const car = getCarById(r.carId);
      const statusClass = r.status === 'Completed' ? 'status-completed'
                       : r.status === 'In Progress' ? 'status-progress'
                       : 'status-pending';
      return `
        <tr class="hover:bg-gray-50 cursor-pointer" onclick="openGarageCarDetail('${r.carId}')">
          <td class="px-6 py-4 font-medium">${car ? esc(car.brand + ' ' + car.model) : '—'}</td>
          <td class="px-6 py-4 text-gray-500">${car ? esc(car.plate || '—') : '—'}</td>
          <td class="px-6 py-4">${esc(r.title)}</td>
          <td class="px-6 py-4 text-gray-500">${fmtDate(r.date)}</td>
          <td class="px-6 py-4 font-semibold">${fmtMoney(r.totalCost)}</td>
          <td class="px-6 py-4"><span class="status-badge ${statusClass}">${esc(r.status)}</span></td>
        </tr>`;
    }).join('');
  }
}

function _statCardHtml({ label, value, sub, tint, icon }) {
  const icons = {
    car:    '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0M3 17V9l3-6h12l3 6v8"/>',
    clock:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>',
    check:  '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
    dollar: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
  };
  const tints = {
    blue:   { bg: '#eff6ff', text: '#2563eb', sub: '#16a34a' },
    yellow: { bg: '#fefce8', text: '#ca8a04', sub: '#ca8a04' },
    green:  { bg: '#f0fdf4', text: '#16a34a', sub: '#16a34a' },
    purple: { bg: '#faf5ff', text: '#9333ea', sub: '#9333ea' }
  };
  const t = tints[tint];
  return `
    <div class="card card-padded bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
      <div class="flex items-center justify-between mb-3">
        <p class="text-sm text-gray-500 font-medium">${esc(label)}</p>
        <div class="w-9 h-9 rounded-xl flex items-center justify-center" style="background:${t.bg};">
          <svg class="w-5 h-5" fill="none" stroke="${t.text}" viewBox="0 0 24 24">${icons[icon]}</svg>
        </div>
      </div>
      <p class="stat-card-value text-3xl font-bold text-gray-900">${esc(value)}</p>
      <p class="text-xs mt-1" style="color:${t.sub};">${esc(sub)}</p>
    </div>`;
}

/* ===========================================================
   GARAGE — ALL REPAIRS LIST
   =========================================================== */
function renderGarageRepairsList() {
  const store = getCurrentStore();
  if (!store) return;

  let repairs = _cache.repairs.filter(r => r.garageId === store.id);

  // Filters
  const search       = (document.getElementById('garageRepairsSearch')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('garageRepairsStatus')?.value || '';
  const dateFilter   = document.getElementById('garageRepairsDate')?.value || '';

  if (search) {
    repairs = repairs.filter(r => {
      const car = getCarById(r.carId);
      const carText = car ? (car.brand + ' ' + car.model + ' ' + (car.plate || '')) : '';
      return (r.title || '').toLowerCase().includes(search)
          || (r.technician || '').toLowerCase().includes(search)
          || carText.toLowerCase().includes(search);
    });
  }
  if (statusFilter) repairs = repairs.filter(r => r.status === statusFilter);
  if (dateFilter === 'week') {
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    repairs = repairs.filter(r => new Date(r.date) >= weekAgo);
  } else if (dateFilter === 'month') {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    repairs = repairs.filter(r => new Date(r.date) >= monthStart);
  }

  repairs.sort((a, b) => new Date(b.date) - new Date(a.date));

  const subtitle = document.getElementById('garageRepairsSubtitle');
  if (subtitle) subtitle.textContent = `${repairs.length} record${repairs.length === 1 ? '' : 's'}`;

  const tbody = document.getElementById('garageRepairsList');
  if (!tbody) return;
  if (!repairs.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-12 text-center text-gray-400 text-sm">No repairs match your filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = repairs.map(r => {
    const car = getCarById(r.carId);
    const statusClass = r.status === 'Completed' ? 'status-completed'
                     : r.status === 'In Progress' ? 'status-progress'
                     : 'status-pending';
    return `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-4 font-medium cursor-pointer text-blue-600 hover:underline" onclick="openGarageCarDetail('${r.carId}')">${car ? esc(car.brand + ' ' + car.model) : '—'}</td>
        <td class="px-6 py-4 text-gray-500 font-mono text-xs">${car ? esc(car.plate || '—') : '—'}</td>
        <td class="px-6 py-4">${esc(r.title)}</td>
        <td class="px-6 py-4 text-gray-500">${esc(r.technician || '—')}</td>
        <td class="px-6 py-4 text-gray-500">${fmtDate(r.date)}</td>
        <td class="px-6 py-4 font-semibold text-right">${fmtMoney(r.totalCost)}</td>
        <td class="px-6 py-4"><span class="status-badge ${statusClass}">${esc(r.status)}</span></td>
        <td class="px-6 py-4"><button onclick="generateRepairPDF('${r.id}')" class="text-xs text-green-600 font-medium hover:underline">PDF</button></td>
      </tr>`;
  }).join('');
}

/* ===========================================================
   GARAGE — CAR DETAIL
   =========================================================== */
let _currentGarageCarId = null;

function openGarageCarDetail(carId) {
  _currentGarageCarId = carId;
  showPage('cardetail');
  renderGarageCarDetail();
}

function renderGarageCarDetail() {
  const car = getCarById(_currentGarageCarId);
  if (!car) { showPage('cars'); return; }
  const meta = getVehicleTypeMeta(car.type);

  document.getElementById('garageCarTitle').textContent    = `${meta.icon} ${car.brand} ${car.model}`;
  document.getElementById('garageCarSubtitle').textContent =
    `${car.plate || '—'} · ${car.year || '—'} · ${car.color || '—'} · Owner: ${car.ownerName || '—'}`;

  // Fields panel
  const fields = document.getElementById('garageCarFields');
  if (fields) {
    fields.innerHTML = `
      <div><p class="text-gray-400 text-xs mb-1">Brand / Make</p><p class="font-semibold">${esc(car.brand)}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Model</p><p class="font-semibold">${esc(car.model)}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Year</p><p class="font-semibold">${esc(car.year || '—')}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Color</p><p class="font-semibold">${esc(car.color || '—')}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Plate Number</p><p class="font-semibold bg-gray-100 inline-block px-2 py-0.5 rounded font-mono">${esc(car.plate || '—')}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">VIN</p><p class="font-semibold text-gray-500">${esc(car.vin || '—')}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Owner</p><p class="font-semibold">${esc(car.ownerName || '—')}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Phone</p><p class="font-semibold">${esc(car.ownerPhone || '—')}</p></div>
      <div><p class="text-gray-400 text-xs mb-1">Last Mileage</p><p class="font-semibold">${(car.lastMileage || 0).toLocaleString()} ${meta.mileageUnit}</p></div>
    `;
  }

  // Action buttons
  const actions = document.getElementById('garageCarActions');
  if (actions) {
    actions.innerHTML = `
      <button onclick="openGarageAddRepair('${car.id}')" class="btn-primary text-center flex items-center justify-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        Log New Repair
      </button>
      <button onclick="generateCarHistoryPDF('${car.id}')" class="btn-green text-center flex items-center justify-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
        Export PDF
      </button>
      <button onclick="openEditVehicleForm('${car.id}')" class="btn-secondary text-center">Edit Car Info</button>
    `;
  }

  // History timeline
  const repairs = getRepairsForCar(car.id);
  document.getElementById('garageCarHistoryTitle').textContent =
    `Repair History (${repairs.length} record${repairs.length === 1 ? '' : 's'})`;
  const tl = document.getElementById('garageCarHistory');
  if (!tl) return;
  if (!repairs.length) {
    tl.innerHTML = `<p class="text-gray-400 text-sm text-center py-6">No repair records yet — click "Log New Repair" to add one.</p>`;
    return;
  }
  tl.innerHTML = repairs.map((r, i) => {
    const dotColor = r.status === 'Completed' ? '#10b981'
                  : r.status === 'In Progress' ? '#eab308'
                  : '#94a3b8';
    const statusClass = r.status === 'Completed' ? 'status-completed'
                     : r.status === 'In Progress' ? 'status-progress'
                     : 'status-pending';
    const itemRows = (r.items || []).map(it => `
      <tr>
        <td class="px-3 py-2 ${it.type === 'Labor' ? 'text-orange-600' : 'text-blue-600'} font-medium">${esc(it.type)}</td>
        <td class="px-3 py-2">${esc(it.description || '')}</td>
        <td class="px-3 py-2">${esc(it.qty ?? 1)}</td>
        <td class="px-3 py-2 text-right">${fmtMoney((it.qty || 0) * (it.unitCost || 0))}</td>
      </tr>`).join('');
    return `
      <div class="flex gap-4 ${i < repairs.length - 1 ? 'pb-8' : ''}">
        <div class="flex flex-col items-center">
          <div class="timeline-dot" style="background:${dotColor}"></div>
          ${i < repairs.length - 1 ? '<div class="timeline-line"></div>' : ''}
        </div>
        <div class="flex-1 bg-gray-50 rounded-xl p-4 -mt-1">
          <div class="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div>
              <p class="font-semibold text-gray-900">${esc(r.title)}</p>
              <p class="text-xs text-gray-400 mt-0.5">${fmtDate(r.date)} · ${(r.mileage || 0).toLocaleString()} ${meta.mileageUnit} · Tech: ${esc(r.technician || '—')}</p>
            </div>
            <div class="flex items-center gap-2">
              <span class="status-badge ${statusClass}">${esc(r.status)}</span>
              <span class="font-bold text-gray-900">${fmtMoney(r.totalCost)}</span>
            </div>
          </div>
          ${itemRows ? `
            <div class="table-wrap">
              <table class="w-full text-xs border border-gray-200 rounded-lg overflow-hidden" style="min-width:480px">
                <thead class="bg-gray-100">
                  <tr>
                    <th class="px-3 py-2 text-left font-semibold text-gray-500">Type</th>
                    <th class="px-3 py-2 text-left font-semibold text-gray-500">Description</th>
                    <th class="px-3 py-2 text-left font-semibold text-gray-500">Qty</th>
                    <th class="px-3 py-2 text-right font-semibold text-gray-500">Cost</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-100 bg-white">${itemRows}</tbody>
              </table>
            </div>` : ''}
          <div class="flex gap-2 mt-3">
            <button onclick="generateRepairPDF('${r.id}')" class="text-xs text-green-600 hover:underline ml-auto">Print PDF</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ===========================================================
   GARAGE — LOG REPAIR FORM
   =========================================================== */
let _currentGarageRepairCarId = null;

function openGarageAddRepair(carId) {
  // If no carId, default to the first vehicle (or block if no vehicles)
  if (!carId) {
    const store = getCurrentStore();
    const cars  = store ? getCarsForGarage(store.id) : [];
    if (!cars.length) {
      alert('Add a vehicle first before logging a repair.');
      showPage('cars');
      return;
    }
    carId = cars[0].id;
  }
  _currentGarageRepairCarId = carId;
  showPage('addrepair');
  populateGarageRepairForm();
}

function populateGarageRepairForm() {
  const store = getCurrentStore();
  if (!store) return;
  const cars = getCarsForGarage(store.id);

  // If no vehicles, redirect to cars page
  if (!cars.length) {
    alert('Add a vehicle first before logging a repair.');
    showPage('cars');
    return;
  }

  // Pick a default car if none selected yet
  if (!_currentGarageRepairCarId || !cars.find(c => c.id === _currentGarageRepairCarId)) {
    _currentGarageRepairCarId = cars[0].id;
  }
  const car = getCarById(_currentGarageRepairCarId);

  // Vehicle dropdown
  const carSelect = document.getElementById('grfCarId');
  if (carSelect) {
    carSelect.innerHTML = cars.map(c =>
      `<option value="${c.id}" ${c.id === _currentGarageRepairCarId ? 'selected' : ''}>${esc(c.brand + ' ' + c.model + ' — ' + (c.plate || 'no plate'))}</option>`
    ).join('');
    carSelect.onchange = () => {
      _currentGarageRepairCarId = carSelect.value;
      const c = getCarById(carSelect.value);
      if (c) {
        document.getElementById('garageRepairSubtitle').textContent = `${c.brand} ${c.model} — ${c.plate || '—'}`;
        const m = document.querySelector('#garageRepairFormEl [name="mileage"]');
        if (m) m.value = c.lastMileage || '';
      }
    };
  }

  // Subtitle
  document.getElementById('garageRepairSubtitle').textContent = `${car.brand} ${car.model} — ${car.plate || '—'}`;

  // Reset form fields
  const form = document.getElementById('garageRepairFormEl');
  if (form) {
    form.querySelector('[name="date"]').value       = new Date().toISOString().slice(0, 10);
    form.querySelector('[name="title"]').value      = '';
    form.querySelector('[name="mileage"]').value    = car.lastMileage || '';
    form.querySelector('[name="status"]').value     = 'In Progress';
    form.querySelector('[name="technician"]').value = '';
    form.querySelector('[name="notes"]').value      = '';
  }
  const err = document.getElementById('garageRepairFormError');
  if (err) err.classList.remove('show');

  // Reset items rows: clear and seed two empty ones
  const tbody = document.getElementById('repairRows');
  if (tbody) {
    tbody.innerHTML = '';
    addRepairRow();
    addRepairRow();
    updateTotal();
  }
}

async function handleGarageRepairSubmit() {
  const form = document.getElementById('garageRepairFormEl');
  const fd   = new FormData(form);
  const errBox = document.getElementById('garageRepairFormError');
  errBox.classList.remove('show');

  const car = getCarById(fd.get('carId') || _currentGarageRepairCarId);
  if (!car) { errBox.textContent = 'Pick a vehicle.'; errBox.classList.add('show'); return; }

  // Collect items
  const items = [];
  document.querySelectorAll('#repairRows tr').forEach(tr => {
    const type = tr.querySelector('select')?.value || 'Part';
    const desc = tr.querySelector('input[type="text"]')?.value || '';
    const qty  = parseFloat(tr.querySelector('.qty-input')?.value)   || 0;
    const unit = parseFloat(tr.querySelector('.price-input')?.value) || 0;
    if (desc.trim() && (qty > 0 || unit > 0)) {
      items.push({ type, description: desc.trim(), qty, unitCost: unit });
    }
  });

  const totalCost = items.reduce((s, it) => s + it.qty * it.unitCost, 0);
  const store = getCurrentStore();

  try {
    await addRepair({
      carId:      car.id,
      garageId:   store.id,
      date:       fd.get('date'),
      mileage:    fd.get('mileage'),
      status:     fd.get('status'),
      title:      fd.get('title'),
      technician: fd.get('technician'),
      totalCost,
      notes:      fd.get('notes'),
      items
    });
    _currentGarageCarId = car.id;
    showPage('cardetail');
    renderGarageCarDetail();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
}

function cancelGarageRepair() {
  if (_currentGarageCarId) {
    showPage('cardetail');
    renderGarageCarDetail();
  } else {
    showPage('repairs');
    renderGarageRepairsList();
  }
}

/* ===========================================================
   GARAGE PDFs — single repair + full car history
   =========================================================== */
function generateRepairPDF(repairId) {
  const repair = _cache.repairs.find(r => r.id === repairId);
  if (!repair) { alert('Repair not found.'); return; }
  const car = getCarById(repair.carId);
  if (!car) { alert('Vehicle not found.'); return; }
  const store = getCurrentStore();
  const meta  = getVehicleTypeMeta(car.type);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFillColor(37, 99, 235);
  doc.rect(0, 0, 220, 30, 'F');
  doc.setTextColor(255);
  doc.setFontSize(18); doc.setFont(undefined, 'bold');
  doc.text('AutoTrack — Repair Report', 14, 18);

  doc.setTextColor(40); doc.setFontSize(10); doc.setFont(undefined, 'normal');
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(14, 36, 182, 38, 3, 3, 'F');
  doc.setFont(undefined, 'bold');
  doc.text('Vehicle Information', 20, 46);
  doc.setFont(undefined, 'normal'); doc.setFontSize(9);
  doc.text(`${meta.label}: ${car.brand} ${car.model}`, 20, 54);
  doc.text(`Plate: ${car.plate || '—'}`, 20, 61);
  doc.text(`Year / Color: ${car.year || '—'} · ${car.color || '—'}`, 20, 68);
  doc.text(`Owner: ${car.ownerName || '—'}`, 105, 54);
  doc.text(`Phone: ${car.ownerPhone || '—'}`, 105, 61);
  doc.text(`Mileage: ${(repair.mileage || car.lastMileage || 0).toLocaleString()} ${meta.mileageUnit}`, 105, 68);

  doc.setFontSize(11); doc.setFont(undefined, 'bold');
  doc.text(`Repair: ${repair.title}`, 14, 84);
  doc.setFont(undefined, 'normal'); doc.setFontSize(9);
  doc.text(`Date: ${fmtDate(repair.date)}`, 14, 91);
  doc.text(`Technician: ${repair.technician || '—'}`, 80, 91);
  doc.text(`Status: ${repair.status}`, 150, 91);

  const body = (repair.items || []).map(it => [
    it.type, it.description || '', String(it.qty ?? 1),
    fmtMoney(it.unitCost), fmtMoney((it.qty || 0) * (it.unitCost || 0))
  ]);
  doc.autoTable({
    startY: 97,
    head:   [['Type', 'Description', 'Qty', 'Unit Cost', 'Total']],
    body:   body.length ? body : [['—', 'No line items', '—', '—', '—']],
    foot:   [['', '', '', 'TOTAL', fmtMoney(repair.totalCost)]],
    headStyles: { fillColor: [37, 99, 235], fontSize: 9 },
    footStyles: { fillColor: [240, 245, 255], fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 4: { halign: 'right' }, 3: { halign: 'right' } },
    margin: { left: 14, right: 14 }
  });

  if (repair.notes) {
    const finalY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(9); doc.setTextColor(100);
    doc.text('Notes: ' + repair.notes, 14, finalY, { maxWidth: 182 });
  }

  doc.setFillColor(37, 99, 235);
  doc.rect(0, 285, 220, 15, 'F');
  doc.setTextColor(255); doc.setFontSize(8);
  const garageName = store ? store.storeName : 'AutoTrack';
  doc.text(`${garageName} · Generated ${new Date().toLocaleDateString()}`, 14, 294);

  doc.save(`repair-${(car.plate || car.id).replace(/\s+/g, '')}-${repair.date}.pdf`);
}

function generateCarHistoryPDF(carId) {
  const car = getCarById(carId);
  if (!car) return;
  const repairs = getRepairsForCar(car.id);
  const store = getCurrentStore();
  const meta  = getVehicleTypeMeta(car.type);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFillColor(37, 99, 235);
  doc.rect(0, 0, 220, 30, 'F');
  doc.setTextColor(255); doc.setFontSize(18); doc.setFont(undefined, 'bold');
  doc.text('AutoTrack — Vehicle History', 14, 18);

  doc.setTextColor(40); doc.setFontSize(10); doc.setFont(undefined, 'normal');
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(14, 36, 182, 38, 3, 3, 'F');
  doc.setFont(undefined, 'bold');
  doc.text('Vehicle Information', 20, 46);
  doc.setFont(undefined, 'normal'); doc.setFontSize(9);
  doc.text(`${meta.label}: ${car.brand} ${car.model}`, 20, 54);
  doc.text(`Plate: ${car.plate || '—'}`, 20, 61);
  doc.text(`Year / Color: ${car.year || '—'} · ${car.color || '—'}`, 20, 68);
  doc.text(`Owner: ${car.ownerName || '—'}`, 105, 54);
  doc.text(`Phone: ${car.ownerPhone || '—'}`, 105, 61);
  doc.text(`Last Mileage: ${(car.lastMileage || 0).toLocaleString()} ${meta.mileageUnit}`, 105, 68);

  doc.setFontSize(11); doc.setFont(undefined, 'bold');
  doc.text(`Repair History (${repairs.length} record${repairs.length === 1 ? '' : 's'})`, 14, 84);

  const rows = repairs.map(r => [
    fmtDate(r.date), r.title,
    (r.mileage || 0).toLocaleString() + ' ' + meta.mileageUnit,
    r.status, fmtMoney(r.totalCost)
  ]);
  doc.autoTable({
    startY: 90,
    head:   [['Date', 'Service', 'Mileage', 'Status', 'Cost']],
    body:   rows.length ? rows : [['—', 'No repairs yet', '—', '—', '—']],
    foot:   [['', '', '', 'TOTAL', fmtMoney(repairs.reduce((s, r) => s + Number(r.totalCost || 0), 0))]],
    headStyles: { fillColor: [37, 99, 235], fontSize: 9 },
    footStyles: { fillColor: [240, 245, 255], fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 4: { halign: 'right' } },
    margin: { left: 14, right: 14 }
  });

  doc.setFillColor(37, 99, 235);
  doc.rect(0, 285, 220, 15, 'F');
  doc.setTextColor(255); doc.setFontSize(8);
  const garageName = store ? store.storeName : 'AutoTrack';
  doc.text(`${garageName} · Generated ${new Date().toLocaleDateString()}`, 14, 294);

  doc.save(`vehicle-history-${(car.plate || car.id).replace(/\s+/g, '')}.pdf`);
}

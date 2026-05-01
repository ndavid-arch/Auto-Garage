/* ===========================================
   AutoTrack — Car Repair Tracker JS
   =========================================== */

/* ---------- AUTH SHELL / APP SHELL TOGGLE ---------- */
let activeSignupRole = 'garage';
let activeLoginRole  = 'garage';

function selectRole(form, role) {
  if (form === 'signup') {
    activeSignupRole = role;
    document.querySelectorAll('#auth-signup .role-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.role === role));
    document.querySelectorAll('.signup-form-role').forEach(f =>
      f.style.display = (f.dataset.role === role) ? 'block' : 'none');
  } else {
    activeLoginRole = role;
    document.querySelectorAll('#auth-login .role-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.role === role));
  }
  document.querySelectorAll('.auth-error').forEach(e => e.classList.remove('show'));
}

function showAuthShell() {
  document.getElementById('authShell').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('appShell').style.display = 'none';
}

function showAppShell(currentUser) {
  document.getElementById('authShell').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('appShell').style.display = 'flex';
  applyUserToUI(currentUser);
  applyRoleToSidebar(currentUser.role);
}

function showAuthPage(name) {
  document.querySelectorAll('.auth-page').forEach(p => p.classList.remove('active'));
  document.getElementById('auth-' + name)?.classList.add('active');
  // Reset error messages
  document.querySelectorAll('.auth-error').forEach(e => e.classList.remove('show'));
}

function applyUserToUI(currentUser) {
  if (!currentUser) return;
  const { role, user } = currentUser;
  const displayName = role === 'garage' ? user.storeName : user.fullName;
  const ownerName   = role === 'garage' ? user.ownerName : user.fullName;
  const subtitle    = role === 'garage' ? 'Repair Management' : 'My Vehicles';

  document.getElementById('sidebarStoreName').textContent = displayName;
  document.getElementById('sidebarOwnerName').textContent = ownerName;
  document.getElementById('splashStoreName').textContent  = displayName;

  // Sidebar subtitle
  const subEl = document.querySelector('#sidebar .px-6.py-5 .flex-1 p:last-child');
  if (subEl) subEl.textContent = subtitle;

  // Greeting strip on garage dashboard
  const greetEl = document.getElementById('greetingStoreName');
  if (greetEl) greetEl.textContent = displayName;

  // Greeting strip on customer dashboard
  const greetCust = document.getElementById('customerGreetingName');
  if (greetCust) greetCust.textContent = (user.fullName || '').split(' ')[0] || 'there';

  // Avatar initials
  const initials = ownerName.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  document.getElementById('sidebarAvatar').textContent = initials || 'U';

  // Footer role label
  const roleLabel = document.querySelector('#sidebar .px-4.py-4 .text-xs.text-gray-400');
  if (roleLabel) roleLabel.textContent = role === 'garage' ? 'Admin' : 'Car Owner';
}

/* Show different sidebar items + start page depending on role */
function applyRoleToSidebar(role) {
  document.querySelectorAll('.nav-link').forEach(l => {
    const visibleRoles = (l.dataset.roles || 'garage').split(',');
    l.style.display = visibleRoles.includes(role) ? 'flex' : 'none';
  });
}

/* ---------- SPLASH ---------- */
function playSplash(user, then) {
  const splash = document.getElementById('splash');
  const name = user.storeName || user.fullName || 'Welcome';
  document.getElementById('splashStoreName').textContent = name;
  splash.classList.add('show');
  splash.classList.remove('fade');

  setTimeout(() => splash.classList.add('fade'), 1500);
  setTimeout(() => {
    splash.classList.remove('show', 'fade');
    if (typeof then === 'function') then();
  }, 1900);
}

/* ---------- AUTH FORM HANDLERS ---------- */
async function handleSignup(event, role) {
  event.preventDefault();
  const fd = new FormData(event.target);
  const errBox = document.getElementById('signupError');
  errBox.classList.remove('show');

  try {
    const fields = role === 'garage'
      ? {
          storeName: fd.get('storeName'),
          ownerName: fd.get('ownerName'),
          email:     fd.get('email'),
          phone:     fd.get('phone') || '',
          password:  fd.get('password')
        }
      : {
          fullName: fd.get('fullName'),
          email:    fd.get('email'),
          phone:    fd.get('phone') || '',
          password: fd.get('password')
        };

    const user = await signup(role, fields);
    const currentUser = { role, user };
    window._currentUser = currentUser;
    await loadUserData(user, role);
    showAppShell(currentUser);
    playSplash(user, () => showPage(role === 'garage' ? 'dashboard' : 'customer-dashboard'));
    event.target.reset();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const fd = new FormData(event.target);
  const errBox = document.getElementById('loginError');
  errBox.classList.remove('show');

  try {
    const user = await login(activeLoginRole, {
      email:    fd.get('email'),
      password: fd.get('password')
    });
    const currentUser = { role: activeLoginRole, user };
    window._currentUser = currentUser;
    await loadUserData(user, activeLoginRole);
    showAppShell(currentUser);
    playSplash(user, () => showPage(activeLoginRole === 'garage' ? 'dashboard' : 'customer-dashboard'));
    event.target.reset();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
}

async function handleLogout() {
  const cu = getCurrentUser();
  const label = cu && cu.role === 'customer' ? 'your customer account' : 'your garage account';
  if (!confirm(`Log out of ${label}?`)) return;
  await logout();
  showAuthShell();
  showAuthPage('landing');
}

/* ---------- PAGE NAVIGATION ---------- */
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + name);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.remove('active');
    if (l.dataset.page === name) l.classList.add('active');
  });

  // Customer pages need rendering
  if (name.startsWith('customer-') && typeof onCustomerPageShow === 'function') {
    onCustomerPageShow(name);
  }

  // Garage pages that need dynamic rendering
  if (typeof onGaragePageShow === 'function') {
    onGaragePageShow(name);
  }

  // Close mobile sidebar on nav
  closeSidebar();
  window.scrollTo(0, 0);
}

/* ---------- MOBILE SIDEBAR ---------- */
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('show');
  document.body.classList.toggle('sidebar-open', sidebar.classList.contains('open'));
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.remove('open');
  overlay.classList.remove('show');
  document.body.classList.remove('sidebar-open');
}

/* ---------- DYNAMIC REPAIR ROWS ---------- */
function addRepairRow() {
  const tbody = document.getElementById('repairRows');
  const row = document.createElement('tr');
  row.className = 'repair-row border-b border-gray-50';
  row.innerHTML = `
    <td class="py-2 pr-2"><select style="padding:6px 8px;font-size:13px;"><option>Part</option><option>Labor</option></select></td>
    <td class="py-2 pr-2"><input type="text" placeholder="Description" style="font-size:13px;"/></td>
    <td class="py-2 pr-2"><input type="number" placeholder="1" min="1" style="font-size:13px;" class="qty-input" oninput="calcRow(this)"/></td>
    <td class="py-2 pr-2"><input type="number" placeholder="0.00" style="font-size:13px;" class="price-input" oninput="calcRow(this)"/></td>
    <td class="py-2 text-right font-semibold row-total">$0.00</td>
    <td class="py-2 pl-2"><button onclick="removeRow(this)" class="text-red-400 hover:text-red-600 text-lg leading-none">&times;</button></td>
  `;
  tbody.appendChild(row);
}

function removeRow(btn) {
  btn.closest('tr').remove();
  updateTotal();
}

function calcRow(input) {
  const row = input.closest('tr');
  const qty = parseFloat(row.querySelector('.qty-input').value) || 0;
  const price = parseFloat(row.querySelector('.price-input').value) || 0;
  row.querySelector('.row-total').textContent = '$' + (qty * price).toFixed(2);
  updateTotal();
}

function updateTotal() {
  let total = 0;
  document.querySelectorAll('.row-total').forEach(el => {
    total += parseFloat(el.textContent.replace('$', '')) || 0;
  });
  const grandTotal = document.getElementById('grandTotal');
  if (grandTotal) grandTotal.textContent = '$' + total.toFixed(2);
}

/* ---------- PDF GENERATION ---------- */
function generatePDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  // Header bar
  doc.setFillColor(37, 99, 235);
  doc.rect(0, 0, 220, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.text('AutoTrack — Repair Report', 14, 18);

  doc.setTextColor(40, 40, 40);
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');

  // Vehicle info box
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(14, 36, 182, 38, 3, 3, 'F');
  doc.setFont(undefined, 'bold');
  doc.text('Vehicle Information', 20, 46);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);

  doc.text('Brand / Make:', 20, 54);
  doc.text('Toyota Corolla', 65, 54);

  doc.text('Plate Number:', 20, 61);
  doc.setFont(undefined, 'bold');
  doc.text('RAB 123A', 65, 61);
  doc.setFont(undefined, 'normal');

  doc.text('Year / Color:', 20, 68);
  doc.text('2019 · Silver', 65, 68);

  doc.text('Owner:', 105, 54);
  doc.text('Kalisa Jean', 130, 54);

  doc.text('Phone:', 105, 61);
  doc.text('+250 788 123 456', 130, 61);

  doc.text('Mileage:', 105, 68);
  doc.text('82,450 km', 130, 68);

  // Repair info
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.text('Repair: Oil Change + Air Filter Replacement', 14, 84);
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.text('Date: April 25, 2026', 14, 91);
  doc.text('Technician: Jean Mechanic', 80, 91);
  doc.text('Status: Completed', 150, 91);

  // Items table
  doc.autoTable({
    startY: 97,
    head: [['Type', 'Description', 'Qty', 'Unit Cost', 'Total']],
    body: [
      ['Part',  'Engine Oil 5W-30 (4L)',           '1',  '$40.00', '$40.00'],
      ['Part',  'Air Filter (Denso)',              '1',  '$20.00', '$20.00'],
      ['Labor', 'Oil drain, refill & filter install', '1h', '$25.00', '$25.00'],
    ],
    foot: [['', '', '', 'TOTAL', '$85.00']],
    headStyles: { fillColor: [37, 99, 235], fontSize: 9 },
    footStyles: { fillColor: [240, 245, 255], fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 9 },
    columnStyles: { 4: { halign: 'right' }, 3: { halign: 'right' } },
    margin: { left: 14, right: 14 }
  });

  const finalY = doc.lastAutoTable.finalY + 10;

  // Notes
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text('Notes: Routine maintenance service. Next oil change recommended at 87,000 km.', 14, finalY);

  // Signature lines
  doc.setDrawColor(200);
  doc.line(14, finalY + 25, 80, finalY + 25);
  doc.line(120, finalY + 25, 196, finalY + 25);
  doc.setFontSize(8);
  doc.text('Technician Signature', 14, finalY + 30);
  doc.text('Customer Signature', 120, finalY + 30);

  // Footer
  doc.setFillColor(37, 99, 235);
  doc.rect(0, 285, 220, 15, 'F');
  doc.setTextColor(255);
  doc.setFontSize(8);
  doc.text('AutoTrack Repair Management · Generated ' + new Date().toLocaleDateString(), 14, 294);

  doc.save('repair-RAB123A-2026-04-25.pdf');

  // Toast
  const toast = document.getElementById('pdfToast');
  toast.classList.remove('hidden');
  toast.classList.add('flex');
  setTimeout(() => {
    toast.classList.add('hidden');
    toast.classList.remove('flex');
  }, 3000);
}

/* ---------- INIT ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  // Close sidebar when clicking overlay
  const overlay = document.getElementById('sidebarOverlay');
  if (overlay) overlay.addEventListener('click', closeSidebar);

  // Close sidebar on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSidebar();
  });

  // Route based on Supabase session state
  try {
    const currentUser = await fetchCurrentUserFromSupabase();
    if (currentUser) {
      window._currentUser = currentUser;
      await loadUserData(currentUser.user, currentUser.role);
      showAppShell(currentUser);
      showPage(currentUser.role === 'garage' ? 'dashboard' : 'customer-dashboard');
    } else {
      showAuthShell();
      showAuthPage('landing');
    }
  } catch (err) {
    console.error('AutoTrack init failed:', err);
    showAuthShell();
    showAuthPage('landing');
  }
});

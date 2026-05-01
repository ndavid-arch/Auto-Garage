/* ===========================================
   AutoTrack — Auth, Profiles, Vehicles, Repairs
   Backed by Supabase (db.js loads first).

   Reads (getCarsForCustomer, getCarById, etc.) are SYNC — they
   read from _cache populated by loadUserData().
   Mutations (addVehicle, updateVehicle, ...) are ASYNC — they
   push to Supabase and update the cache.
   =========================================== */

/* ---------- VEHICLE TYPE CATALOG (Rwanda-relevant) ----------
   Each type: icon, mileageUnit (km|hours), needsRNP (does it need
   road tech control?), needsPlate (do we require a plate number?). */
const VEHICLE_TYPES = {
  sedan:      { label: 'Sedan / Hatchback',  icon: '🚗', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  suv:        { label: 'SUV',                icon: '🚙', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  pickup:     { label: 'Pickup / Truck',     icon: '🛻', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  minibus:    { label: 'Minibus / Coaster',  icon: '🚐', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  bus:        { label: 'Bus',                icon: '🚌', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  motorcycle: { label: 'Motorcycle (Moto)',  icon: '🏍️', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  tricycle:   { label: 'Tricycle',           icon: '🛺', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  lorry:      { label: 'Lorry / Heavy Truck', icon: '🚚', mileageUnit: 'km',    needsRNP: true,  needsPlate: true  },
  excavator:  { label: 'Excavator',          icon: '🚜', mileageUnit: 'hours', needsRNP: false, needsPlate: false },
  tractor:    { label: 'Tractor',            icon: '🚜', mileageUnit: 'hours', needsRNP: false, needsPlate: false },
  other:      { label: 'Other',              icon: '🔧', mileageUnit: 'km',    needsRNP: false, needsPlate: false }
};

function getVehicleTypeMeta(type) {
  return VEHICLE_TYPES[type] || VEHICLE_TYPES.sedan;
}

/* ---------- AUTH — STORE (GARAGE) ---------- */
async function signupStore({ storeName, ownerName, email, phone, password }) {
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');

  const cleanEmail = email.trim().toLowerCase();
  const { data: auth, error: authErr } = await sb.auth.signUp({
    email: cleanEmail,
    password,
    options: { data: { role: 'garage' } }
  });
  if (authErr) throw new Error(authErr.message);
  if (!auth.user) throw new Error('Signup failed — please try again.');

  const { data, error } = await sb.from('stores').insert({
    id:         auth.user.id,
    store_name: storeName.trim(),
    owner_name: ownerName.trim(),
    email:      cleanEmail,
    phone:      (phone || '').trim()
  }).select().single();
  if (error) throw new Error(error.message);

  return { ...snakeToCamel(data), role: 'garage' };
}

async function loginStore({ email, password }) {
  const { error } = await sb.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password
  });
  if (error) throw new Error(error.message);

  const { data: { user } } = await sb.auth.getUser();
  const { data: store, error: pErr } = await sb
    .from('stores').select('*').eq('id', user.id).maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!store) throw new Error('No garage account found with this email.');
  return { ...snakeToCamel(store), role: 'garage' };
}

/* ---------- AUTH — CUSTOMER ---------- */
async function signupCustomer({ fullName, email, phone, password }) {
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');

  const cleanEmail = email.trim().toLowerCase();
  const { data: auth, error: authErr } = await sb.auth.signUp({
    email: cleanEmail,
    password,
    options: { data: { role: 'customer' } }
  });
  if (authErr) throw new Error(authErr.message);
  if (!auth.user) throw new Error('Signup failed — please try again.');

  const { data, error } = await sb.from('customers').insert({
    id:               auth.user.id,
    full_name:        fullName.trim(),
    email:            cleanEmail,
    phone:            (phone || '').trim(),
    notify_by_email:  true
  }).select().single();
  if (error) throw new Error(error.message);

  return { ...snakeToCamel(data), role: 'customer' };
}

async function loginCustomer({ email, password }) {
  const { error } = await sb.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password
  });
  if (error) throw new Error(error.message);

  const { data: { user } } = await sb.auth.getUser();
  const { data: customer, error: pErr } = await sb
    .from('customers').select('*').eq('id', user.id).maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!customer) throw new Error('No customer account found with this email.');
  return { ...snakeToCamel(customer), role: 'customer' };
}

/* ---------- UNIFIED ENTRY POINTS ---------- */
async function signup(role, fields) {
  if (role === 'garage')   return signupStore(fields);
  if (role === 'customer') return signupCustomer(fields);
  throw new Error('Unknown account role: ' + role);
}

async function login(role, credentials) {
  if (role === 'garage')   return loginStore(credentials);
  if (role === 'customer') return loginCustomer(credentials);
  throw new Error('Unknown account role: ' + role);
}

/* ---------- SESSION ---------- */
/* Async — talks to Supabase. Used only at page load (init flow). */
async function fetchCurrentUserFromSupabase() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;

  const { data: store } = await sb
    .from('stores').select('*').eq('id', user.id).maybeSingle();
  if (store) return { role: 'garage', user: snakeToCamel(store) };

  const { data: customer } = await sb
    .from('customers').select('*').eq('id', user.id).maybeSingle();
  if (customer) return { role: 'customer', user: snakeToCamel(customer) };

  return null;
}

/* Sync — reads from window._currentUser, populated after init/signup/login. */
function getCurrentUser() {
  return window._currentUser || null;
}
function getCurrentStore() {
  const cu = window._currentUser;
  return (cu && cu.role === 'garage') ? cu.user : null;
}
function getCurrentCustomer() {
  const cu = window._currentUser;
  return (cu && cu.role === 'customer') ? cu.user : null;
}
function isLoggedIn() { return !!window._currentUser; }

async function logout() {
  await sb.auth.signOut();
  clearCache();
  window._currentUser = null;
}

/* ---------- READ HELPERS — SYNC, read from _cache ---------- */
function getCars()    { return _cache.cars; }
function getRepairs() { return _cache.repairs; }

/* getCarsForCustomer: by default skips archived. Pass { includeArchived: true }
   to get them all (used to render the archived section). */
function getCarsForCustomer(email, opts = {}) {
  if (!email) return [];
  const e = email.toLowerCase();
  return _cache.cars.filter(c =>
    (c.ownerEmail || '').toLowerCase() === e &&
    (opts.includeArchived ? true : !c.archived)
  );
}

function getCarsForGarage(garageId, opts = {}) {
  return _cache.cars.filter(c =>
    c.garageId === garageId &&
    (opts.includeArchived ? true : !c.archived)
  );
}

function getRepairsForCar(carId) {
  return _cache.repairs
    .filter(r => r.carId === carId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getCarById(id) {
  return _cache.cars.find(c => c.id === id) || null;
}

/* Find a vehicle by plate (case+space-insensitive). Used for the claim flow. */
function findVehicleByPlate(plate) {
  if (!plate) return null;
  const norm = String(plate).replace(/\s+/g, '').toLowerCase();
  return _cache.cars.find(c =>
    String(c.plate || '').replace(/\s+/g, '').toLowerCase() === norm
  ) || null;
}

/* ---------- VEHICLE CRUD — ASYNC, persists to Supabase ---------- */
async function addVehicle({
  type, brand, model, year, color, plate, vin,
  ownerName, ownerEmail, ownerPhone,
  lastMileage, inspectionExpiryDate,
  garageId = null, addedBy = 'garage'
}) {
  const meta = getVehicleTypeMeta(type);
  if (!brand || !brand.trim()) throw new Error('Brand is required.');
  if (!model || !model.trim()) throw new Error('Model is required.');
  if (meta.needsPlate && (!plate || !plate.trim())) {
    throw new Error('Plate number is required for this vehicle type.');
  }

  const row = {
    type:                   type || 'sedan',
    added_by:               addedBy,
    archived:               false,
    archived_at:            null,
    garage_id:              garageId || null,
    brand:                  brand.trim(),
    model:                  model.trim(),
    year:                   year ? Number(year) : null,
    color:                  (color || '').trim(),
    plate:                  (plate || '').trim().toUpperCase(),
    vin:                    (vin || '').trim(),
    owner_name:             (ownerName || '').trim(),
    owner_email:            (ownerEmail || '').trim().toLowerCase(),
    owner_phone:            (ownerPhone || '').trim(),
    last_mileage:           lastMileage ? Number(lastMileage) : 0,
    inspection_expiry_date: meta.needsRNP ? (inspectionExpiryDate || null) : null
  };

  const { data, error } = await sb.from('cars').insert(row).select().single();
  if (error) throw new Error(error.message);

  const vehicle = snakeToCamel(data);
  _cache.cars.push(vehicle);
  return vehicle;
}

async function updateVehicle(id, fields) {
  const updatable = [
    'type','brand','model','year','color','plate','vin',
    'ownerName','ownerEmail','ownerPhone',
    'lastMileage','inspectionExpiryDate','garageId'
  ];
  const update = {};
  for (const k of updatable) {
    if (fields[k] === undefined) continue;
    let v = fields[k];
    if      (k === 'plate')      v = String(v || '').trim().toUpperCase();
    else if (k === 'ownerEmail') v = String(v || '').trim().toLowerCase();
    else if (k === 'year' || k === 'lastMileage') {
      v = (v === '' || v == null) ? null : Number(v);
    }
    update[k.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())] = v;
  }
  update.updated_at = new Date().toISOString();

  const { data, error } = await sb.from('cars')
    .update(update).eq('id', id).select().single();
  if (error) throw new Error(error.message);

  const vehicle = snakeToCamel(data);
  const i = _cache.cars.findIndex(c => c.id === id);
  if (i >= 0) _cache.cars[i] = vehicle;
  else _cache.cars.push(vehicle);
  return vehicle;
}

async function archiveVehicle(id) {
  const { data, error } = await sb.from('cars')
    .update({ archived: true, archived_at: new Date().toISOString() })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  const v = snakeToCamel(data);
  const i = _cache.cars.findIndex(c => c.id === id);
  if (i >= 0) _cache.cars[i] = v;
  return v;
}

async function restoreVehicle(id) {
  const { data, error } = await sb.from('cars')
    .update({ archived: false, archived_at: null })
    .eq('id', id).select().single();
  if (error) throw new Error(error.message);
  const v = snakeToCamel(data);
  const i = _cache.cars.findIndex(c => c.id === id);
  if (i >= 0) _cache.cars[i] = v;
  return v;
}

/* Hard-delete is allowed only when the vehicle has zero repairs.
   The "I just typed it wrong, let me delete" escape hatch. */
async function deleteVehicleHard(id) {
  const repairs = _cache.repairs.filter(r => r.carId === id);
  if (repairs.length > 0) {
    throw new Error('This vehicle has repair history — please archive instead. Hard-delete is only allowed for vehicles with no repair records.');
  }
  const { error } = await sb.from('cars').delete().eq('id', id);
  if (error) throw new Error(error.message);
  _cache.cars = _cache.cars.filter(c => c.id !== id);
  return true;
}

/* Garage "claims" an existing customer-added vehicle when the garage
   tries to add a vehicle whose plate already exists. */
async function claimVehicle(carId, garageId) {
  const { data, error } = await sb.from('cars')
    .update({ garage_id: garageId, claimed_at: new Date().toISOString() })
    .eq('id', carId).select().single();
  if (error) throw new Error(error.message);
  const v = snakeToCamel(data);
  const i = _cache.cars.findIndex(c => c.id === carId);
  if (i >= 0) _cache.cars[i] = v;
  else _cache.cars.push(v);
  return v;
}

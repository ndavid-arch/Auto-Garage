/* ===========================================
   AutoTrack — Supabase Client + In-Memory Cache
   Loads BEFORE auth.js. Exposes:
     - sb               (the Supabase client)
     - _cache           ({ cars, repairs, ready })
     - loadUserData()   fetch a user's data into the cache
     - clearCache()     wipe on logout
     - snakeToCamel()   normalize DB rows
   =========================================== */

const SUPABASE_URL      = 'https://uqfdnakijuybeqlqyuqb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxZmRuYWtpanV5YmVxbHF5dXFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MDkzNDYsImV4cCI6MjA5Mjk4NTM0Nn0.0bryxEBb_sp4pVq85GM5SrERLJXA7eF5gpwGocM34fE';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* The rest of the app reads from this cache (sync). It is populated
   by loadUserData() at login/init, and kept in sync by the mutation
   functions in auth.js (addVehicle, archiveVehicle, etc.). */
const _cache = {
  cars:    [],
  repairs: [],
  ready:   false
};

/* ---------- snake_case ↔ camelCase mapping ----------
   Supabase columns are snake_case (owner_email), the rest of our
   code uses camelCase (ownerEmail). These two helpers bridge them. */
function snakeToCamel(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

function camelToSnake(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/[A-Z]/g, ch => '_' + ch.toLowerCase())] = v;
  }
  return out;
}

/* ---------- Load all data the logged-in user can see ---------- */
async function loadUserData(user, role) {
  _cache.cars    = [];
  _cache.repairs = [];
  _cache.ready   = false;

  /* CARS — customers see vehicles where ownerEmail matches.
            garages see vehicles linked to their garageId. */
  let carsQuery = sb.from('cars').select('*');
  if (role === 'customer') {
    carsQuery = carsQuery.ilike('owner_email', user.email);
  } else {
    carsQuery = carsQuery.eq('garage_id', user.id);
  }
  const { data: cars, error: carsErr } = await carsQuery;
  if (carsErr) throw new Error('Failed to load vehicles: ' + carsErr.message);
  _cache.cars = (cars || []).map(snakeToCamel);

  /* REPAIRS — fetch all repairs (with their items) for those cars. */
  const carIds = _cache.cars.map(c => c.id);
  if (carIds.length) {
    const { data: repairs, error: repErr } = await sb
      .from('repairs')
      .select('*, repair_items(*)')
      .in('car_id', carIds);
    if (repErr) throw new Error('Failed to load repair history: ' + repErr.message);
    _cache.repairs = (repairs || []).map(r => ({
      ...snakeToCamel(r),
      items: (r.repair_items || []).map(snakeToCamel)
    }));
  }

  _cache.ready = true;
}

function clearCache() {
  _cache.cars    = [];
  _cache.repairs = [];
  _cache.ready   = false;
}

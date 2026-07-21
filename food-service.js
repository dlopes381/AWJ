// FoodService — thin client for the Open Food Facts public API (world.openfoodfacts.org).
// Pure data/service layer: no DOM access, no app state. Loaded via <script src>
// (not a module) so it attaches itself to window, matching this app's plain-script style.
(function(){
  const API_BASE = 'https://world.openfoodfacts.org';
  const FDC_API_BASE = 'https://api.nal.usda.gov/fdc/v1';
  const FDC_KEY_STORAGE = 'awj:fdcApiKey';
  const SEARCH_CACHE_KEY = 'awj:foodSearchCache';
  const FDC_SEARCH_CACHE_KEY = 'awj:fdcSearchCache';
  const DETAIL_CACHE_KEY = 'awj:foodDetailCache';
  const RECENT_KEY = 'awj:foodRecent';
  const CUSTOM_KEY = 'awj:foodCustom';
  const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // OFF/FDC data changes rarely; avoids re-hitting the API for repeated queries in one session
  const MAX_RECENT = 30;
  const PAGE_SIZE = 20;

  function readJSON(key, fallback){
    try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch(e){ return fallback; }
  }
  function writeJSON(key, val){
    try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){}
  }

  function parseServingGrams(servingSize){
    if(!servingSize) return null;
    const m = String(servingSize).match(/([\d.]+)\s*(g|ml)\b/i);
    return m ? parseFloat(m[1]) : null;
  }

  // Normalizes an Open Food Facts product object into the shape the rest of the app uses.
  function normalizeProduct(p){
    const n = p.nutriments || {};
    const per100 = {
      calories: n['energy-kcal_100g'] ?? n['energy-kcal'] ?? 0,
      protein: n.proteins_100g ?? 0,
      carbs: n.carbohydrates_100g ?? 0,
      fat: n.fat_100g ?? 0,
      fiber: n.fiber_100g ?? 0,
      sugar: n.sugars_100g ?? 0,
      sodium: (n.sodium_100g ?? 0) * 1000, // g -> mg
    };
    return {
      id: p.code,
      barcode: p.code,
      name: p.product_name || p.generic_name || 'Unknown food',
      brand: (p.brands || '').split(',')[0].trim(),
      servingSize: p.serving_size || '',
      servingGrams: parseServingGrams(p.serving_size),
      per100,
      imageUrl: p.image_front_small_url || p.image_small_url || p.image_url || '',
    };
  }

  const FIELDS = 'code,product_name,generic_name,brands,serving_size,nutriments,image_front_small_url,image_small_url';

  async function searchOFF(query, page){
    const cacheKey = `${query.toLowerCase()}|${page}`;
    const cache = readJSON(SEARCH_CACHE_KEY, {});
    const hit = cache[cacheKey];
    if(hit && Date.now() - hit.ts < SEARCH_CACHE_TTL_MS) return hit.data;

    const url = `${API_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`OFF search failed (${res.status})`);
    const json = await res.json();
    const products = (json.products || []).filter(p=>p.product_name).map(normalizeProduct);
    const data = { products, hasMore: (page * PAGE_SIZE) < (json.count || 0) };

    cache[cacheKey] = { ts: Date.now(), data };
    writeJSON(SEARCH_CACHE_KEY, cache);
    return data;
  }

  function getFdcApiKey(){
    return (localStorage.getItem(FDC_KEY_STORAGE) || '').trim();
  }
  function setFdcApiKey(key){
    if(key) localStorage.setItem(FDC_KEY_STORAGE, key.trim());
    else localStorage.removeItem(FDC_KEY_STORAGE);
  }

  const FDC_NUTRIENT_IDS = { calories: 1008, protein: 1003, carbs: 1005, fat: 1004, fiber: 1079, sugar: 2000, sodium: 1093 };

  // Normalizes a USDA FoodData Central "Branded Food" search result. FDC reports
  // foodNutrients per 100g/100mL (same basis as OFF's per100 fields), so it drops
  // into the same shape everything else in this service already expects.
  function normalizeFdcFood(f){
    const nutrientVal = (id) => (f.foodNutrients || []).find(n=>n.nutrientId===id)?.value ?? 0;
    const per100 = {
      calories: nutrientVal(FDC_NUTRIENT_IDS.calories),
      protein: nutrientVal(FDC_NUTRIENT_IDS.protein),
      carbs: nutrientVal(FDC_NUTRIENT_IDS.carbs),
      fat: nutrientVal(FDC_NUTRIENT_IDS.fat),
      fiber: nutrientVal(FDC_NUTRIENT_IDS.fiber),
      sugar: nutrientVal(FDC_NUTRIENT_IDS.sugar),
      sodium: nutrientVal(FDC_NUTRIENT_IDS.sodium),
    };
    // FDC's servingSizeUnit is sometimes an abbreviation like "GRM"/"MLT" rather than "g"/"ml"
    const unitLower = (f.servingSizeUnit||'').toLowerCase();
    const displayUnit = unitLower.startsWith('g') ? 'g' : unitLower.startsWith('ml') ? 'ml' : '';
    const servingGrams = displayUnit ? f.servingSize : null;
    return {
      id: `fdc:${f.fdcId}`,
      barcode: f.gtinUpc || '',
      name: f.description || 'Unknown food',
      brand: f.brandOwner || f.brandName || '',
      servingSize: servingGrams ? `${servingGrams}${displayUnit}` : '',
      servingGrams,
      per100,
      imageUrl: '', // FDC doesn't provide product photos
      source: 'fdc',
    };
  }

  async function searchFDC(query){
    const key = getFdcApiKey();
    if(!key) return { products: [] }; // no key configured — silently contributes nothing, OFF results still show

    const cacheKey = query.toLowerCase();
    const cache = readJSON(FDC_SEARCH_CACHE_KEY, {});
    const hit = cache[cacheKey];
    if(hit && Date.now() - hit.ts < SEARCH_CACHE_TTL_MS) return hit.data;

    const url = `${FDC_API_BASE}/foods/search?query=${encodeURIComponent(query)}&dataType=Branded&pageSize=20&api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`FDC search failed (${res.status})`);
    const json = await res.json();
    const products = (json.foods || []).map(normalizeFdcFood);
    const data = { products };

    cache[cacheKey] = { ts: Date.now(), data };
    writeJSON(FDC_SEARCH_CACHE_KEY, cache);
    return data;
  }

  // Merges both sources: FDC first (better restaurant/branded coverage when a key is
  // configured), then Open Food Facts (better packaged-goods coverage + photos). Each
  // source's own failure is isolated — one API being down doesn't blank out the other.
  async function searchFoods(query, page){
    page = page || 1;
    query = (query || '').trim();
    if(!query) return { products: [], page, hasMore: false };

    const [offResult, fdcResult] = await Promise.allSettled([
      searchOFF(query, page),
      page===1 ? searchFDC(query) : Promise.resolve({ products: [] }),
    ]);

    if(offResult.status==='rejected' && fdcResult.status==='rejected') throw offResult.reason;

    const fdcProducts = fdcResult.status==='fulfilled' ? fdcResult.value.products : [];
    const offProducts = offResult.status==='fulfilled' ? offResult.value.products : [];
    return {
      products: [...fdcProducts, ...offProducts],
      page,
      hasMore: offResult.status==='fulfilled' ? offResult.value.hasMore : false,
    };
  }

  async function searchByBarcode(barcode){
    barcode = (barcode || '').trim();
    if(!barcode) return null;

    const cache = readJSON(DETAIL_CACHE_KEY, {});
    if(cache[barcode]) return cache[barcode];

    const url = `${API_BASE}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`;
    const res = await fetch(url);
    if(!res.ok) throw new Error(`Lookup failed (${res.status})`);
    const json = await res.json();
    if(json.status !== 1 || !json.product) return null;

    const food = normalizeProduct(json.product);
    cache[barcode] = food;
    writeJSON(DETAIL_CACHE_KEY, cache);
    return food;
  }

  // quantity is in the given unit: 'g'/'ml' treated as grams directly (close enough for
  // tracked foods/drinks, ~1g/ml), 'serving' multiplies by the food's parsed serving size.
  function calculateNutrition(food, quantity, unit){
    const qtyGrams = unit === 'serving' ? quantity * (food.servingGrams || 100) : quantity;
    const factor = qtyGrams / 100;
    const round = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
    return {
      calories: Math.round((food.per100.calories || 0) * factor),
      protein: round((food.per100.protein || 0) * factor, 1),
      carbs: round((food.per100.carbs || 0) * factor, 1),
      fat: round((food.per100.fat || 0) * factor, 1),
      fiber: round((food.per100.fiber || 0) * factor, 1),
      sugar: round((food.per100.sugar || 0) * factor, 1),
      sodium: Math.round((food.per100.sodium || 0) * factor),
      qtyGrams,
    };
  }

  function getRecentFoods(){
    return readJSON(RECENT_KEY, []);
  }

  function getFrequentFoods(limit){
    return [...getRecentFoods()].sort((a,b)=> (b.useCount||0) - (a.useCount||0)).slice(0, limit || 8);
  }

  function recordUsage(food){
    const existing = getRecentFoods();
    const prevCount = existing.find(f=>f.id===food.id)?.useCount || 0;
    const list = existing.filter(f=>f.id !== food.id);
    list.unshift(Object.assign({}, food, { lastUsed: Date.now(), useCount: prevCount + 1 }));
    writeJSON(RECENT_KEY, list.slice(0, MAX_RECENT));
  }

  // User-entered foods that aren't in Open Food Facts. Same shape as a normalized OFF
  // product (id/name/brand/servingSize/servingGrams/per100/imageUrl) plus `custom:true`,
  // so they work everywhere a searched food does (detail view, recent/frequent, meal add).
  function getCustomFoods(){
    return readJSON(CUSTOM_KEY, []);
  }

  function searchCustomFoods(query){
    const q = (query || '').trim().toLowerCase();
    if(!q) return [];
    return getCustomFoods().filter(f=> f.name.toLowerCase().includes(q) || (f.brand||'').toLowerCase().includes(q));
  }

  function saveCustomFood(food){
    const list = getCustomFoods();
    const id = food.id || ('custom:' + Math.random().toString(36).slice(2,10) + Date.now().toString(36));
    const normalized = Object.assign({}, food, { id, custom: true });
    const idx = list.findIndex(f=>f.id===id);
    if(idx>=0) list[idx] = normalized; else list.unshift(normalized);
    writeJSON(CUSTOM_KEY, list);
    return normalized;
  }

  function deleteCustomFood(id){
    writeJSON(CUSTOM_KEY, getCustomFoods().filter(f=>f.id!==id));
  }

  window.FoodService = {
    searchFoods, searchByBarcode, calculateNutrition,
    getRecentFoods, getFrequentFoods, recordUsage,
    getCustomFoods, searchCustomFoods, saveCustomFood, deleteCustomFood,
    getFdcApiKey, setFdcApiKey,
  };
})();

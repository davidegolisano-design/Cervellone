// Supabase Edge Function. All writes go through one serialized database command.
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return response({ error: 'Metodo non consentito' }, 405);
  try {
    if (Number(req.headers.get('content-length') || 0) > 180000) return response({ error: 'File troppo grande' }, 413);
    const raw = await req.text();
    if (raw.length > 180000) return response({ error: 'File troppo grande' }, 413);
    const body = JSON.parse(raw);
    if (!body || typeof body.action !== 'string' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return response({ error: 'Richiesta non valida' }, 400);
    if (body.action !== 'create' && !/^\d{6}$/.test(body.data.pin || '')) return response({ error: 'Inserisci un PIN di 6 cifre' }, 400);
    if (body.data.secret && !/^[0-9a-f-]{36}$/.test(body.data.secret)) return response({ error: 'Credenziale non valida' }, 400);
    const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const ipHash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
    const base = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const r = await fetch(`${base}/rest/v1/rpc/cervellone_api`, {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_action: body.action, p_data: body.data, p_ip: ipHash })
    });
    const result = await r.json();
    if (!r.ok) {
      // Expose deliberate validation messages, never database internals.
      const message = result.code === 'P0001' ? result.message : result.code === '23505' ? 'Questo nome è già utilizzato' : 'Richiesta non valida. Controlla i dati e riprova.';
      return response({ error: message }, 400);
    }
    return response(result, result.rateLimited ? 429 : result.error ? 400 : 200);
  } catch {
    return response({ error: 'Connessione non disponibile. Riprova.' }, 503);
  }
});

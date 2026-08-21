/* =========================================================================
   Ganga Home · servidor de sincronización del tablero de control
   Cloudflare Worker + base D1 (SQLite).

   Por qué D1 y no KV: KV tarda hasta un minuto en propagar un cambio entre
   regiones y no permite "actualizar sólo si nadie más lo tocó". D1 es
   consistente al instante y deja hacer UPDATE ... WHERE rev = ?, que es lo
   que evita que dos personas cargando el mismo Excel al mismo tiempo se
   pisen los datos.

   Binding necesario: DB  ->  base de datos D1
   Variable opcional: ORIGENES -> lista separada por comas de sitios
                                  autorizados. Si no está, sólo se acepta
                                  el tablero publicado en GitHub Pages.
   ========================================================================= */

const ORIGENES_POR_DEFECTO = [
  'https://lucasbarranco-blip.github.io',
  'http://localhost:8899',
  'http://127.0.0.1:8899'
];

const ESQUEMA = `
create table if not exists reportes (
  clave       text primary key,
  sector      text,
  etiqueta    text,
  autor       text,
  origen      text,
  rev         integer not null default 0,
  actualizado text,
  filas       text,
  meta        text
);`;

function origenesOk(env){
  return (env.ORIGENES ? env.ORIGENES.split(',') : ORIGENES_POR_DEFECTO)
    .map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
}

function cors(req, env){
  const permitidos = origenesOk(env);
  const o = (req.headers.get('Origin') || '').replace(/\/$/, '');
  const ok = permitidos.includes(o);
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? o : permitidos[0],
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    }
  };
}

function json(data, status, headers){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) }
  });
}

/* El token viaja en la URL. Ojo: el tablero es una página pública, así que el
   token también lo es. No es un secreto criptográfico: sirve para que la
   dirección del Worker no quede utilizable por cualquiera que la adivine, y
   el control de origen es la barrera real. */
function tokenOk(req, env, url){
  if(!env.TOKEN) return true;
  const t = url.searchParams.get('t') || req.headers.get('X-Token') || '';
  return t === env.TOKEN;
}

let esquemaListo = false;
async function asegurarEsquema(env){
  if(esquemaListo) return;
  await env.DB.exec(ESQUEMA.replace(/\n\s*/g, ' ').trim());
  esquemaListo = true;
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);
    const c = cors(req, env);

    if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.headers });

    if(!env.DB) return json({ error: 'Falta conectar la base de datos D1 al Worker (binding "DB")' }, 500, c.headers);
    if(!c.ok)   return json({ error: 'Origen no autorizado' }, 403, c.headers);
    if(!tokenOk(req, env, url)) return json({ error: 'Token inválido' }, 403, c.headers);

    try{
      await asegurarEsquema(env);
      const ruta = url.pathname.replace(/\/+$/, '').split('/').pop();

      /* ---- índice: liviano, es lo que se pide cada 20 segundos ---- */
      if(ruta === 'index'){
        const { results } = await env.DB.prepare(
          'select clave, rev, actualizado, autor, origen from reportes').all();
        const out = {};
        (results || []).forEach(x => {
          out[x.clave] = {
            rev: Number(x.rev) || 0,
            ts: Date.parse(x.actualizado || '') || 0,
            by: x.autor || '',
            src: x.origen || ''
          };
        });
        return json(out, 200, c.headers);
      }

      /* ---- traer conjuntos completos ---- */
      if(ruta === 'get'){
        const body = await req.json().catch(() => ({}));
        const claves = Array.isArray(body.claves) ? body.claves.slice(0, 50) : [];
        if(!claves.length) return json([], 200, c.headers);
        const huecos = claves.map(() => '?').join(',');
        const { results } = await env.DB.prepare(
          `select * from reportes where clave in (${huecos})`).bind(...claves).all();
        return json(results || [], 200, c.headers);
      }

      /* ---- guardar ----
         modo "nuevo": lo crea sólo si todavía no existe.
         modo "cas"  : lo pisa sólo si la versión sigue siendo la que leímos.
         Devuelve {aplicado:true/false}: en false, el cliente vuelve a leer,
         combina con lo que haya y reintenta. */
      if(ruta === 'put'){
        const body = await req.json().catch(() => ({}));
        const p = body.payload || {};
        if(!p.clave) return json({ error: 'Falta la clave' }, 400, c.headers);
        const ahora = new Date().toISOString();
        const vals = [p.sector || '', p.etiqueta || '', p.autor || '', p.origen || '',
                      Number(p.rev) || 0, ahora, p.filas || '', JSON.stringify(p.meta || {})];

        if(body.modo === 'nuevo'){
          const r = await env.DB.prepare(
            `insert or ignore into reportes
             (clave, sector, etiqueta, autor, origen, rev, actualizado, filas, meta)
             values (?,?,?,?,?,?,?,?,?)`).bind(p.clave, ...vals).run();
          return json({ aplicado: (r.meta && r.meta.changes) > 0 }, 200, c.headers);
        }

        const r = await env.DB.prepare(
          `update reportes set sector=?, etiqueta=?, autor=?, origen=?, rev=?, actualizado=?, filas=?, meta=?
           where clave=? and rev=?`)
          .bind(...vals, p.clave, Number(body.revEsperada) || 0).run();
        return json({ aplicado: (r.meta && r.meta.changes) > 0 }, 200, c.headers);
      }

      /* ---- borrar ---- */
      if(ruta === 'del'){
        const body = await req.json().catch(() => ({}));
        if(!body.clave) return json({ error: 'Falta la clave' }, 400, c.headers);
        await env.DB.prepare('delete from reportes where clave=?').bind(body.clave).run();
        return json({ ok: true }, 200, c.headers);
      }

      /* ---- diagnóstico: sirve para confirmar que quedó bien instalado ---- */
      if(ruta === 'salud' || ruta === '' || ruta === undefined){
        const { results } = await env.DB.prepare(
          'select count(*) as n, coalesce(sum(length(filas)),0) as bytes from reportes').all();
        return json({
          ok: true,
          servidor: 'ganga-sync',
          conjuntos: (results[0] || {}).n || 0,
          bytesGuardados: (results[0] || {}).bytes || 0
        }, 200, c.headers);
      }

      return json({ error: 'Ruta desconocida: ' + ruta }, 404, c.headers);

    }catch(e){
      return json({ error: String(e && e.message || e).slice(0, 300) }, 500, c.headers);
    }
  }
};

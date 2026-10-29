const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const crypto = require("crypto");
const verifactu = require("./verifactu");

const app = express();

app.use(cors());

// Solo se publica lo que la web necesita (páginas, imágenes y vídeos). Todo lo demás queda privado:
// código (server.js), datos (data/), dependencias, Excel/PDF internos y las fichas de cata
// (cata/<codigo>.pdf), que solo se ven desde ficha-cata.html a través de /api/cata/:codigo.
const EXTENSIONES_PUBLICAS = [".html", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico", ".mp4", ".webm"];
const CARPETAS_PRIVADAS = ["node_modules", "data", "cata"];

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/webhook/")) return next();

  let ruta;
  try {
    ruta = decodeURIComponent(req.path).toLowerCase();
  } catch (error) {
    return res.status(404).end();
  }

  const primeraCarpeta = ruta.split("/")[1] || "";
  const extension = path.extname(ruta);

  if (CARPETAS_PRIVADAS.includes(primeraCarpeta) || (extension && !EXTENSIONES_PUBLICAS.includes(extension))) {
    return res.status(404).end();
  }

  next();
});

app.use(express.static(__dirname, { dotfiles: "deny" }));

//-------------------------------------------------------------------------------------------------ABRE - STRIPE--------------------------------------------------------------------------------------------//
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
//-------------------------------------------------------------------------------------------------CIERRA - STRIPE--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - WEBHOOK DE STRIPE (va ANTES de express.json(): necesita el body sin parsear para verificar la firma)--------------------------------------------------------------------------------------------//

app.post("/webhook/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    const firma = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, firma, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error("Firma de webhook de Stripe inválida:", error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      await confirmarPagoPedido(event.data.object);
    } else if (event.type === "checkout.session.expired") {
      await cancelarPedidoExpirado(event.data.object);
    }

    res.json({ received: true });

  } catch (error) {
    console.error("Error procesando el webhook de Stripe:", error);
    res.status(500).json({ error: "Error interno procesando el webhook" });
  }
});

//-------------------------------------------------------------------------------------------------CIERRA - WEBHOOK DE STRIPE--------------------------------------------------------------------------------------------//

app.use(express.json());

//-------------------------------------------------------------------------------------------------ABRE - CATÁLOGO (PRECIOS Y FICHAS, VIVE EN GIT)--------------------------------------------------------------------------------------------//

const CATALOGO_FILE = path.join(__dirname, "data", "lotes.json");
const PESOS_VALIDOS = ["250", "500", "1000"];
const ESTADOS_VALIDOS = ["activo", "archivado"];

// El café llega ya tostado de Colombia: el tueste es un dato fijo de cada lote, no lo elige el cliente.
const TUESTES = {
  "suave": "Suave",
  "medio": "Medio",
  "medio-plus": "Medio +",
  "medio-alto": "Medio-alto",
  "alto": "Alto"
};

function etiquetaTueste(lote) {
  return TUESTES[lote.tueste] || "";
}

// Ficha de cata en PDF de cada lote: cata/dm-2026-001.pdf (código del lote en minúsculas).
const CATA_DIR = path.join(__dirname, "cata");

function rutaFichaCata(codigo) {
  return path.join(CATA_DIR, `${String(codigo).toLowerCase()}.pdf`);
}

function leerCatalogo() {
  const raw = fs.readFileSync(CATALOGO_FILE, "utf-8");
  return JSON.parse(raw);
}

function guardarCatalogoLocal(datos) {
  // Este archivo vive en el disco de Render, que NO es permanente: el cambio se ve
  // de inmediato en la web, pero se pierde si el servicio se reinicia. Hay que subir
  // el JSON actualizado a GitHub (carpeta data/lotes.json) para que sea definitivo.
  fs.writeFileSync(CATALOGO_FILE, JSON.stringify(datos, null, 2));
}

function requiereAdmin(req, res, next) {
  const token = req.get("x-admin-token");

  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }

  next();
}

app.put("/api/catalogo", requiereAdmin, (req, res) => {
  try {
    const datos = req.body;

    for (const codigo of Object.keys(datos)) {
      const lote = datos[codigo];

      if (!lote || typeof lote.proceso !== "string" || !lote.proceso.trim()) {
        return res.status(400).json({ error: `Falta el proceso del lote "${codigo}"` });
      }

      if (!ESTADOS_VALIDOS.includes(lote.estado)) {
        return res.status(400).json({ error: `Estado inválido en el lote "${codigo}"` });
      }

      if (lote.tueste && !TUESTES[lote.tueste]) {
        return res.status(400).json({ error: `Tueste inválido en el lote "${codigo}"` });
      }

      const formatosConPrecio = Object.keys(lote.precios || {}).filter(peso =>
        PESOS_VALIDOS.includes(peso) && Number.isFinite(Number(lote.precios[peso])) && Number(lote.precios[peso]) > 0
      );

      if (formatosConPrecio.length === 0) {
        return res.status(400).json({ error: `El lote "${codigo}" necesita al menos un precio válido` });
      }

      lote.codigo = codigo;
    }

    guardarCatalogoLocal(datos);
    res.json({ success: true, catalogo: datos });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo guardar el catálogo" });
  }
});

//-------------------------------------------------------------------------------------------------CIERRA - CATÁLOGO--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - ENVÍO (GASTOS DE ENVÍO, SOLO PENÍNSULA POR AHORA)--------------------------------------------------------------------------------------------//

// Los portes van al 21% (tipo general), distinto del 10% del café: nunca se mezclan en la misma línea de IVA.
const IVA_ENVIO_TIPO = 0.21;

// umbralGratis: importe del café (con su IVA del 10% incluido) a partir del cual no se cobra envío.
// tarifaBase: coste del envío sin IVA cuando no se llega al umbral. Son valores de partida, editables
// desde el panel admin en cuanto haya tarifas reales de transportista (MRW, SEUR, InPost...).
async function leerConfigEnvio() {
  return redisGet("config_envio", { umbralGratis: 60, tarifaBase: 8 });
}

app.get("/api/config-envio", async (req, res) => {
  try {
    res.json(await leerConfigEnvio());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo leer la configuración de envío" });
  }
});

app.put("/api/config-envio", requiereAdmin, async (req, res) => {
  try {
    const umbralGratis = Number(req.body.umbralGratis);
    const tarifaBase = Number(req.body.tarifaBase);

    if (!Number.isFinite(umbralGratis) || umbralGratis < 0) {
      return res.status(400).json({ error: "El importe mínimo para envío gratis no es válido" });
    }
    if (!Number.isFinite(tarifaBase) || tarifaBase < 0) {
      return res.status(400).json({ error: "La tarifa de envío no es válida" });
    }

    const config = { umbralGratis, tarifaBase };
    await redisSet("config_envio", config);
    res.json({ success: true, config });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo guardar la configuración de envío" });
  }
});

// A partir del total del café (con IVA), calcula si hay portes y su importe (base + 21% IVA).
function calcularEnvio(totalCafeConIva, config) {
  if (totalCafeConIva >= config.umbralGratis) {
    return { gratuito: true, base: 0, iva: 0, total: 0 };
  }

  const base = Number(config.tarifaBase);
  const iva = Math.round(base * IVA_ENVIO_TIPO * 100) / 100;
  const total = Math.round((base + iva) * 100) / 100;

  return { gratuito: false, base, iva, total };
}

//-------------------------------------------------------------------------------------------------CIERRA - ENVÍO--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - STOCK Y PEDIDOS (UPSTASH REDIS, INSTANTÁNEO Y PERMANENTE)--------------------------------------------------------------------------------------------//

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisConfigurado() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGet(key, porDefecto) {
  if (!redisConfigurado()) return porDefecto;

  const response = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });

  if (!response.ok) throw new Error(`Redis GET "${key}" falló`);

  const data = await response.json();
  return data.result ? JSON.parse(data.result) : porDefecto;
}

async function redisSet(key, valor) {
  if (!redisConfigurado()) throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN no configurados");

  const response = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "text/plain" },
    body: JSON.stringify(valor)
  });

  if (!response.ok) throw new Error(`Redis SET "${key}" falló`);
}

// Cualquier comando de Redis (INCR, RPUSH, LRANGE, SET ... NX PX, EVAL...) enviado como array JSON.
async function redisComando(...args) {
  if (!redisConfigurado()) throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN no configurados");

  const response = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.map(String))
  });

  if (!response.ok) throw new Error(`Redis ${args[0]} falló`);

  const data = await response.json();
  return data.result;
}

// Ejecuta fn() en exclusiva entre todas las peticiones (p. ej. dos pagos confirmados a la vez).
async function conBloqueo(clave, fn, { esperaMs = 15000, duracionMs = 30000 } = {}) {
  const token = crypto.randomUUID();
  const limite = Date.now() + esperaMs;

  while ((await redisComando("SET", clave, token, "NX", "PX", duracionMs)) !== "OK") {
    if (Date.now() > limite) throw new Error(`No se pudo obtener el bloqueo "${clave}"`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  try {
    return await fn();
  } finally {
    // Solo se libera si sigue siendo nuestro (si caducó, otro proceso puede tenerlo ya).
    await redisComando("EVAL", "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, clave, token);
  }
}

// stockReal: { "DM-2026-001": { "250": 10, "500": 20, "1000": 12 }, ... } -> unidades físicas reales
// reservado: misma forma -> unidades vendidas y pagadas pero aún no enviadas
async function leerStockReal() { return redisGet("stock_real", {}); }
async function leerReservado() { return redisGet("stock_reservado", {}); }
async function leerPedidos() { return redisGet("pedidos", []); }
async function leerMovimientos() { return redisGet("movimientos", []); }
// clientes: { "DNI/CIF normalizado": { tipo, nombre, apellidos, dni, ..., facturas: [...] }, ... }
async function leerClientes() { return redisGet("clientes", {}); }

function vacioParaCodigo(mapa, codigo) {
  return mapa[codigo] || { "250": 0, "500": 0, "1000": 0 };
}

async function registrarMovimiento(movimiento) {
  const movimientos = await leerMovimientos();
  movimientos.push({ fecha: new Date().toISOString(), ...movimiento });
  await redisSet("movimientos", movimientos);
}

async function construirLotesConStock() {
  const catalogo = leerCatalogo();

  let stockReal = {};
  let reservado = {};

  try {
    stockReal = await leerStockReal();
    reservado = await leerReservado();
  } catch (error) {
    console.error("No se pudo leer el stock en vivo, se muestra todo sin stock:", error);
  }

  const lotes = {};

  for (const codigo of Object.keys(catalogo)) {
    const real = vacioParaCodigo(stockReal, codigo);
    const res_ = vacioParaCodigo(reservado, codigo);

    const stock = {};
    for (const peso of PESOS_VALIDOS) {
      const r = Number(real[peso] || 0);
      const rv = Number(res_[peso] || 0);
      stock[peso] = { real: r, reservado: rv, disponible: Math.max(0, r - rv) };
    }

    lotes[codigo] = { ...catalogo[codigo], fichaCata: fs.existsSync(rutaFichaCata(codigo)), stock };
  }

  return lotes;
}

// Público: solo expone "disponible" (nunca las unidades reales/reservadas) para no filtrar el inventario interno.
app.get("/api/lotes", async (req, res) => {
  try {
    const lotesCompletos = await construirLotesConStock();
    const lotes = {};

    for (const codigo of Object.keys(lotesCompletos)) {
      const { stock, ...resto } = lotesCompletos[codigo];
      const stockPublico = {};

      for (const peso of PESOS_VALIDOS) {
        stockPublico[peso] = stock[peso].disponible;
      }

      lotes[codigo] = { ...resto, stock: stockPublico };
    }

    res.json(lotes);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo leer el inventario" });
  }
});

// Ficha de cata para el visor de cata.html. Solo responde a lotes del catálogo (el código nunca se usa
// como ruta libre) y a peticiones del visor: abrir la URL directamente en el navegador no devuelve el PDF.
app.get("/api/cata/:codigo", (req, res) => {
  const catalogo = leerCatalogo();
  const lote = catalogo[req.params.codigo];

  if (!lote || req.get("x-visor-cata") !== "1") {
    return res.status(404).json({ error: "Ficha de cata no disponible" });
  }

  const ruta = rutaFichaCata(lote.codigo);
  if (!fs.existsSync(ruta)) {
    return res.status(404).json({ error: "Ficha de cata no disponible" });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(ruta);
});

// Dirección corta que llevan los QR impresos (fichas, empaques): aurinegracafe.com/lote/DM-2026-001.
// Es fija a propósito: si algún día cambia la página de la ficha, se cambia aquí y los QR ya impresos siguen valiendo.
app.get("/lote/:codigo", (req, res) => {
  const codigo = String(req.params.codigo).trim().toUpperCase();
  const catalogo = leerCatalogo();

  if (!catalogo[codigo]) {
    return res.redirect(302, "/pasaporte.html");
  }

  res.redirect(302, `/ficha-cata.html?lote=${encodeURIComponent(codigo)}`);
});

// Privado: detalle real/reservado/disponible para el panel de administración.
app.get("/api/lotes-admin", requiereAdmin, async (req, res) => {
  try {
    res.json(await construirLotesConStock());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo leer el inventario" });
  }
});

app.put("/api/stock", requiereAdmin, async (req, res) => {
  try {
    const { codigo, peso, real } = req.body;

    if (!codigo || !PESOS_VALIDOS.includes(String(peso))) {
      return res.status(400).json({ error: "Lote o formato inválido" });
    }

    const unidades = Number(real);
    if (!Number.isInteger(unidades) || unidades < 0) {
      return res.status(400).json({ error: "El stock real debe ser un número entero mayor o igual a 0" });
    }

    const stockReal = await leerStockReal();
    stockReal[codigo] = vacioParaCodigo(stockReal, codigo);
    const anterior = Number(stockReal[codigo][peso] || 0);
    stockReal[codigo][peso] = unidades;

    await redisSet("stock_real", stockReal);

    if (anterior !== unidades) {
      await registrarMovimiento({
        codigo,
        peso,
        tipo: "ajuste_manual",
        campo: "real",
        anterior,
        nuevo: unidades,
        diferencia: unidades - anterior
      });
    }

    res.json({ success: true });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo actualizar el stock" });
  }
});

// Paso único de "pruebas -> operación real": borra pedidos, reservas, movimientos, clientes y los
// contadores de documentos del año (para que la primera factura real sea FACT-AAAA-0001) y fija el
// inventario inicial. Devuelve una copia de todo lo borrado para guardarla antes de perderlo.
const CLAVES_CONTADORES = ["fact", "alb", "ped", "fm"]; // fm: facturas de mayoristas emitidas desde el ERP

async function redisDel(key) {
  if (!redisConfigurado()) throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN no configurados");

  const response = await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });

  if (!response.ok) throw new Error(`Redis DEL "${key}" falló`);
}

app.post("/api/iniciar-operacion", requiereAdmin, async (req, res) => {
  try {
    // Con VERI*FACTU las facturas emitidas y sus registros no se pueden borrar ni renumerar.
    if (VERIFACTU.activo) {
      return res.status(400).json({ error: "Con VERI*FACTU activo no se pueden borrar pedidos, facturas ni contadores." });
    }

    const { confirmacion, stockInicial } = req.body;

    if (confirmacion !== "EMPEZAR") {
      return res.status(400).json({ error: 'Escribe EMPEZAR para confirmar' });
    }

    const catalogo = leerCatalogo();
    const nuevoStock = {};

    for (const codigo of Object.keys(catalogo)) {
      nuevoStock[codigo] = { "250": 0, "500": 0, "1000": 0 };

      for (const peso of PESOS_VALIDOS) {
        const unidades = Number((stockInicial && stockInicial[codigo] && stockInicial[codigo][peso]) || 0);
        if (!Number.isInteger(unidades) || unidades < 0) {
          return res.status(400).json({ error: `Stock inválido en ${codigo} (${peso} g): debe ser un entero mayor o igual a 0` });
        }
        nuevoStock[codigo][peso] = unidades;
      }
    }

    const año = new Date().getFullYear();
    const clavesContador = CLAVES_CONTADORES.map(p => `contador_${p}_${año}`);

    const backup = {
      generadoEn: new Date().toISOString(),
      motivo: "Copia antes de iniciar la operación real (datos de pruebas)",
      stock_real: await leerStockReal(),
      stock_reservado: await leerReservado(),
      pedidos: await leerPedidos(),
      movimientos: await leerMovimientos(),
      clientes: await leerClientes(),
      contadores: {}
    };

    for (const clave of clavesContador) {
      backup.contadores[clave] = await redisGet(clave, null);
    }

    const fecha = new Date().toISOString();
    const movimientos = [];

    for (const codigo of Object.keys(nuevoStock)) {
      for (const peso of PESOS_VALIDOS) {
        if (nuevoStock[codigo][peso] > 0) {
          movimientos.push({
            fecha,
            codigo,
            peso,
            tipo: "inventario_inicial",
            campo: "real",
            anterior: 0,
            nuevo: nuevoStock[codigo][peso],
            diferencia: nuevoStock[codigo][peso]
          });
        }
      }
    }

    await redisSet("stock_real", nuevoStock);
    await redisSet("stock_reservado", {});
    await redisSet("pedidos", []);
    await redisSet("movimientos", movimientos);
    await redisSet("clientes", {});
    for (const clave of clavesContador) {
      await redisDel(clave);
    }

    res.json({ success: true, backup });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo iniciar la operación" });
  }
});

app.get("/api/movimientos", requiereAdmin, async (req, res) => {
  try {
    const movimientos = await leerMovimientos();
    res.json(movimientos.slice().reverse()); // más recientes primero
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron leer los movimientos" });
  }
});

app.get("/api/pedidos", requiereAdmin, async (req, res) => {
  try {
    const pedidos = await leerPedidos();
    res.json(pedidos.slice().reverse()); // más recientes primero
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron leer los pedidos" });
  }
});

// Solo se pueden borrar pedidos que nunca llegaron a pagarse (intentos abandonados o caducados):
// un pedido pagado tiene factura, stock reservado y puede tener albarán, así que no se elimina nunca.
app.delete("/api/pedidos/:id", requiereAdmin, async (req, res) => {
  try {
    const pedidos = await leerPedidos();
    const index = pedidos.findIndex(p => p.id === req.params.id);

    if (index === -1) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    if (pedidos[index].estadoPago === "pagado" || pedidos[index].estadoPago === "pagado_sin_stock") {
      return res.status(400).json({ error: "No se puede eliminar un pedido ya pagado." });
    }

    pedidos.splice(index, 1);
    await redisSet("pedidos", pedidos);

    res.json({ success: true });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo eliminar el pedido" });
  }
});

// Ficha única por cliente (identificada por DNI/NIF/CIF), con su historial de facturas.
app.get("/api/clientes", requiereAdmin, async (req, res) => {
  try {
    const clientes = await leerClientes();
    res.json(clientes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron leer los clientes" });
  }
});

app.post("/api/pedidos/:id/enviar", requiereAdmin, async (req, res) => {
  try {
    const pedidos = await leerPedidos();
    const pedido = pedidos.find(p => p.id === req.params.id);

    if (!pedido) {
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    if (pedido.estadoPago !== "pagado") {
      return res.status(400).json({ error: "Este pedido todavía no tiene el pago confirmado, no se puede enviar" });
    }

    if (pedido.estadoPreparacion === "enviado") {
      return res.status(400).json({ error: "Este pedido ya estaba marcado como enviado" });
    }

    const stockReal = await leerStockReal();
    const reservado = await leerReservado();
    const movimientos = await leerMovimientos();

    for (const item of pedido.items) {
      stockReal[item.lote] = vacioParaCodigo(stockReal, item.lote);
      reservado[item.lote] = vacioParaCodigo(reservado, item.lote);

      const anterior = Number(stockReal[item.lote][item.peso] || 0);
      const nuevo = Math.max(0, anterior - item.cantidad);

      stockReal[item.lote][item.peso] = nuevo;
      reservado[item.lote][item.peso] = Math.max(0, Number(reservado[item.lote][item.peso] || 0) - item.cantidad);

      movimientos.push({
        fecha: new Date().toISOString(),
        codigo: item.lote,
        peso: item.peso,
        tipo: "envio",
        campo: "real",
        anterior,
        nuevo,
        diferencia: nuevo - anterior,
        pedidoId: pedido.id
      });
    }

    pedido.estadoPreparacion = "enviado";
    pedido.fechaEnvio = new Date().toISOString();

    try {
      pedido.albaran = { numero: await generarNumeroDocumento("ALB"), fecha: new Date().toISOString() };
      const pdfAlbaran = await construirAlbaranPDF(pedido);
      await enviarAlbaranPorEmail(pedido, pdfAlbaran);
    } catch (error) {
      console.error(`No se pudo generar/enviar el albarán del pedido ${pedido.id}:`, error);
    }

    await redisSet("stock_real", stockReal);
    await redisSet("stock_reservado", reservado);
    await redisSet("pedidos", pedidos);
    await redisSet("movimientos", movimientos);

    res.json({ success: true, pedido });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo marcar el pedido como enviado" });
  }
});

app.get("/api/pedidos/:id/factura", requiereAdmin, async (req, res) => {
  try {
    const pedidos = await leerPedidos();
    const pedido = pedidos.find(p => p.id === req.params.id);

    if (!pedido || !pedido.factura) {
      return res.status(404).json({ error: "Este pedido todavía no tiene factura generada" });
    }

    const pdf = await construirFacturaPDF(pedido);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pedido.factura.numero}.pdf"`);
    res.send(pdf);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo generar la factura" });
  }
});

app.get("/api/pedidos/:id/albaran", requiereAdmin, async (req, res) => {
  try {
    const pedidos = await leerPedidos();
    const pedido = pedidos.find(p => p.id === req.params.id);

    if (!pedido || !pedido.albaran) {
      return res.status(404).json({ error: "Este pedido todavía no tiene albarán generado" });
    }

    const pdf = await construirAlbaranPDF(pedido);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${pedido.albaran.numero}.pdf"`);
    res.send(pdf);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo generar el albarán" });
  }
});

//-------------------------------------------------------------------------------------------------CIERRA - STOCK Y PEDIDOS--------------------------------------------------------------------------------------------//

const resend = new Resend(process.env.RESEND_API_KEY);

//-------------------------------------------------------------------------------------------------ABRE - FACTURACIÓN (FACTURAS Y ALBARANES EN PDF)--------------------------------------------------------------------------------------------//

const EMPRESA = {
  nombre: "D’Medina Global Trade, S.L.",
  nombreComercial: "AURINEGRA",
  cif: "B05653621",
  direccion: "Calle San Pedro del Pinatar, 24, 28939 Arroyomolinos, Madrid",
  email: "info@aurinegracafe.com",
  telefono: "+34 660 736 866"
};

// Remitente de todos los emails (facturas, albaranes, solicitudes). El dominio tiene que estar verificado en Resend.
const REMITENTE_EMAIL = `${EMPRESA.nombreComercial} <${EMPRESA.email}>`;

const IVA_TIPO = 0.10; // Los precios del catálogo ya incluyen este IVA

// Identidad visual de los PDF (factura/albarán), a juego con la web.
const LOGO_PATH = path.join(__dirname, "logo.png");
const COLOR_GOLD = "#a9822f";   // versión del dorado de la web ajustada para que se lea bien en fondo blanco impreso
const COLOR_BLACK = "#11100f";
const COLOR_MUTED = "#6b6459";

async function redisIncr(key) {
  if (!redisConfigurado()) throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN no configurados");

  const response = await fetch(`${REDIS_URL}/incr/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });

  if (!response.ok) throw new Error(`Redis INCR "${key}" falló`);

  const data = await response.json();
  return data.result;
}

// Numeración correlativa por año y tipo de documento (FACT / ALB). Nunca se reutiliza ni se salta un número.
async function generarNumeroDocumento(prefijo) {
  const año = new Date().getFullYear();
  const contador = await redisIncr(`contador_${prefijo.toLowerCase()}_${año}`);
  return `${prefijo}-${año}-${String(contador).padStart(4, "0")}`;
}

function desglosarIva(totalConIva) {
  const base = totalConIva / (1 + IVA_TIPO);
  const iva = totalConIva - base;
  return {
    base: Math.round(base * 100) / 100,
    iva: Math.round(iva * 100) / 100
  };
}

function totalPedido(pedido) {
  return pedido.items.reduce((suma, item) => suma + Number(item.precioUnitario) * Number(item.cantidad), 0);
}

function etiquetaPeso(peso) {
  return peso === "1000" || Number(peso) === 1000 ? "1 kg" : `${peso} g`;
}

// DNI/NIE/CIF normalizado -> clave única de la ficha de cliente (no se duplica aunque cambien mayúsculas/guiones).
function claveCliente(cliente) {
  return String((cliente && cliente.dni) || "").trim().toUpperCase().replace(/[-\s]/g, "");
}

// Se llama solo tras confirmarse el pago: crea o actualiza la ficha del cliente y añade la factura a su historial.
async function actualizarFichaCliente(pedido) {
  const cliente = pedido.cliente;
  const clave = claveCliente(cliente);
  if (!clave) return;

  const clientes = await leerClientes();
  const existente = clientes[clave] || { primeraCompra: new Date().toISOString(), facturas: [] };

  // Base/IVA del cliente suman café (10%) + envío (21%) cuando lo hay: el desglose por tipo
  // exacto vive en el PDF de la factura, aquí solo se guarda el total a efectos de historial.
  const totalCafe = Number(totalPedido(pedido).toFixed(2));
  const { base: baseCafe, iva: ivaCafe } = desglosarIva(totalCafe);
  const envio = pedido.envio && !pedido.envio.gratuito ? pedido.envio : null;

  const total = Number((totalCafe + (envio ? envio.total : 0)).toFixed(2));
  const base = Number((baseCafe + (envio ? envio.base : 0)).toFixed(2));
  const iva = Number((ivaCafe + (envio ? envio.iva : 0)).toFixed(2));

  clientes[clave] = {
    ...existente,
    tipo: cliente.tipoCliente === "empresa" ? "empresa" : "particular",
    nombre: cliente.nombre || "",
    apellidos: cliente.apellidos || "",
    dni: cliente.dni,
    telefono: cliente.telefono || "",
    email: cliente.email || "",
    direccion: cliente.direccion || "",
    codigoPostal: cliente.codigoPostal || "",
    localidad: cliente.localidad || "",
    provincia: cliente.provincia || "",
    ultimaCompra: new Date().toISOString(),
    facturas: [
      ...(existente.facturas || []),
      {
        numero: pedido.factura.numero,
        fecha: pedido.factura.fecha,
        pedidoId: pedido.id,
        base,
        iva,
        total
      }
    ]
  };

  await redisSet("clientes", clientes);
}

function generarPdfBuffer(dibujar) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const partes = [];

    doc.on("data", parte => partes.push(parte));
    doc.on("end", () => resolve(Buffer.concat(partes)));
    doc.on("error", reject);

    dibujar(doc);
    doc.end();
  });
}

function dibujarCabeceraEmpresa(doc, tituloDocumento, numero, fecha) {
  const logoExiste = fs.existsSync(LOGO_PATH);
  const xTexto = logoExiste ? 106 : 50;
  let y = 50;

  if (logoExiste) {
    try {
      doc.image(LOGO_PATH, 50, 44, { width: 46 });
    } catch (error) {
      console.error("No se pudo insertar el logo en el PDF:", error.message);
    }
  }

  doc.font("Times-Bold").fontSize(20).fillColor(COLOR_GOLD).text(EMPRESA.nombreComercial, xTexto, y);
  y += 25;

  doc.font("Helvetica").fontSize(8.5).fillColor(COLOR_MUTED);
  [EMPRESA.nombre, `CIF: ${EMPRESA.cif}`, EMPRESA.direccion, `${EMPRESA.email} · ${EMPRESA.telefono}`].forEach(linea => {
    doc.text(linea, xTexto, y);
    y += 11;
  });

  let yDer = 50;
  doc.font("Times-Bold").fontSize(16).fillColor(COLOR_BLACK).text(tituloDocumento, 50, yDer, { align: "right" });
  yDer += 22;
  doc.font("Helvetica").fontSize(10).fillColor(COLOR_MUTED);
  doc.text(`Nº: ${numero}`, 50, yDer, { align: "right" });
  yDer += 14;
  // Fecha en hora de Madrid (el servidor de Render va en UTC): debe coincidir con la fecha de expedición registrada.
  doc.text(`Fecha: ${new Date(fecha).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" })}`, 50, yDer, { align: "right" });
  yDer += 14;

  doc.y = Math.max(y, yDer, 108) + 8;
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(COLOR_GOLD).lineWidth(1.3).stroke();
  doc.y += 16;
  doc.lineWidth(1);
  doc.font("Helvetica").fillColor(COLOR_BLACK);
}

function dibujarDatosCliente(doc, cliente, ancho = 495) {
  const c = cliente || {};
  const esEmpresa = c.tipoCliente === "empresa";

  doc.font("Times-Bold").fontSize(11).fillColor(COLOR_GOLD).text("Datos del cliente", 50, doc.y, { width: ancho });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor(COLOR_BLACK)
    .text(`${c.nombre || ""} ${c.apellidos || ""}`.trim(), { width: ancho })
    .text(`${esEmpresa ? "CIF" : "DNI/NIE"}: ${c.dni || "—"}`, { width: ancho })
    .text(c.direccion || "", { width: ancho })
    .text(`${c.codigoPostal || ""} ${c.localidad || ""} (${c.provincia || ""})`, { width: ancho })
    .text(`${c.email || ""} · ${c.telefono || ""}`, { width: ancho });
  doc.moveDown(1.5);
}

// Código QR de VERI*FACTU (Orden HAC/1177/2024): al inicio de la factura, entre 30 y 40 mm, con la leyenda.
const LADO_QR = 99; // 35 mm en puntos PDF

async function qrFacturaPng(factura) {
  if (!qrImprimible(factura)) return null;
  return QRCode.toBuffer(factura.verifactu.qr, { errorCorrectionLevel: "M", margin: 0, width: 400 });
}

function dibujarQrVerifactu(doc, png, y) {
  const x = 545 - LADO_QR;
  doc.image(png, x, y, { width: LADO_QR, height: LADO_QR });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_BLACK).text("VERI*FACTU", x - 10, y + LADO_QR + 4, { width: LADO_QR + 20, align: "center" });
  doc.font("Helvetica").fontSize(6.5).fillColor(COLOR_MUTED)
    .text("Factura verificable en la sede electrónica de la AEAT", x - 10, doc.y + 1, { width: LADO_QR + 20, align: "center" });
  return doc.y;
}

// Pasa de los items/envío del pedido a líneas genéricas de factura: descripción, cantidad,
// precio unitario SIN IVA, tipo de IVA de esa línea y total CON IVA. El café va al 10%, el
// envío (si lo hay) va al 21%: cada línea lleva su propio tipo, nunca se mezclan en una sola.
function construirLineasFactura(pedido) {
  const lineas = pedido.items.map(item => {
    const precioConIva = Number(item.precioUnitario);
    return {
      descripcion: `${item.nombre} · Lote ${item.lote} · ${etiquetaPeso(item.peso)} · ${item.molienda} · ${item.tueste}`,
      cantidad: item.cantidad,
      precioUnitarioSinIva: Math.round((precioConIva / (1 + IVA_TIPO)) * 100) / 100,
      tipoIva: IVA_TIPO,
      totalConIva: precioConIva * item.cantidad
    };
  });

  if (pedido.envio && !pedido.envio.gratuito) {
    lineas.push({
      descripcion: "Gastos de envío (Península)",
      cantidad: 1,
      precioUnitarioSinIva: pedido.envio.base,
      tipoIva: IVA_ENVIO_TIPO,
      totalConIva: pedido.envio.total
    });
  }

  return lineas;
}

function construirLineasAlbaran(pedido) {
  return pedido.items.map(item => ({
    descripcion: `${item.nombre} · Lote ${item.lote} · ${etiquetaPeso(item.peso)} · ${item.molienda} · ${item.tueste}`,
    cantidad: item.cantidad
  }));
}

// lineas: [{ descripcion, cantidad, precioUnitarioSinIva?, tipoIva?, totalConIva? }]
function dibujarTablaItems(doc, lineas, { conPrecios }) {
  const x = 50;
  const anchoDesc = conPrecios ? 195 : 350;
  const anchoCant = 40;
  const anchoPrecio = 95;
  const anchoIva = 35;
  const anchoTotal = 75;

  const colCant = x + anchoDesc;
  const colPrecio = colCant + anchoCant;
  const colIva = colPrecio + anchoPrecio;
  const colTotal = colIva + anchoIva;

  function cabeceraTabla() {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_GOLD);
    doc.text("Producto", x, y, { width: anchoDesc });
    doc.text("Cant.", colCant, y, { width: anchoCant, align: "right" });
    if (conPrecios) {
      doc.text("Precio (sin IVA)", colPrecio, y, { width: anchoPrecio, align: "right" });
      doc.text("IVA", colIva, y, { width: anchoIva, align: "right" });
      doc.text("Total", colTotal, y, { width: anchoTotal, align: "right" });
    }
    // Altura fija de 2 líneas: si alguna etiqueta de cabecera llega a partirse en dos renglones,
    // nunca choca con la línea divisoria de abajo.
    doc.y = y + 24;
    doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor(COLOR_GOLD).stroke();
    doc.y += 8;
    doc.font("Helvetica").fillColor(COLOR_BLACK);
  }

  cabeceraTabla();

  lineas.forEach(linea => {
    if (doc.y > 680) {
      doc.addPage();
      doc.y = 50;
      cabeceraTabla();
    }

    const y = doc.y;
    const alturaDesc = doc.heightOfString(linea.descripcion, { width: anchoDesc });

    doc.font("Helvetica").fontSize(9).fillColor(COLOR_BLACK).text(linea.descripcion, x, y, { width: anchoDesc });
    doc.text(String(linea.cantidad), colCant, y, { width: anchoCant, align: "right" });

    if (conPrecios) {
      doc.text(`${linea.precioUnitarioSinIva.toFixed(2)} €`, colPrecio, y, { width: anchoPrecio, align: "right" });
      doc.text(`${Math.round(linea.tipoIva * 100)}%`, colIva, y, { width: anchoIva, align: "right" });
      doc.text(`${linea.totalConIva.toFixed(2)} €`, colTotal, y, { width: anchoTotal, align: "right" });
    }

    doc.y = y + Math.max(alturaDesc, 14) + 6;
  });

  doc.moveDown(0.3);
  doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor(COLOR_GOLD).stroke();
  doc.moveDown(0.8);
}

// Tabla de desglose de IVA: una fila por cada tipo aplicado (% · Base imponible · Cuota IVA · Total)
// y una fila final de TOTAL que suma todos los tipos. Es la forma correcta de facturar cuando
// una misma factura mezcla conceptos a distinto tipo (aquí: café al 10% y envío al 21%).
function dibujarDesgloseIva(doc, grupos) {
  const x = 50;
  const anchoPct = 60;
  const anchoBase = 150;
  const anchoIva = 150;
  const colPct = x;
  const colBase = colPct + anchoPct;
  const colIva = colBase + anchoBase;
  const colTotal = colIva + anchoIva;
  const anchoTotal = 545 - colTotal;

  const yCab = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_GOLD);
  doc.text("% IVA", colPct, yCab, { width: anchoPct });
  doc.text("Base imponible", colBase, yCab, { width: anchoBase, align: "right" });
  doc.text("Cuota IVA", colIva, yCab, { width: anchoIva, align: "right" });
  doc.text("Total", colTotal, yCab, { width: anchoTotal, align: "right" });
  doc.y = yCab + 14;
  doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor(COLOR_GOLD).stroke();
  doc.y += 8;

  let totalBase = 0, totalIva = 0, totalGeneral = 0;

  grupos.forEach(grupo => {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_BLACK);
    doc.text(`${Math.round(grupo.pct * 100)}%`, colPct, y, { width: anchoPct });
    doc.text(`${grupo.base.toFixed(2)} €`, colBase, y, { width: anchoBase, align: "right" });
    doc.text(`${grupo.iva.toFixed(2)} €`, colIva, y, { width: anchoIva, align: "right" });
    doc.text(`${grupo.total.toFixed(2)} €`, colTotal, y, { width: anchoTotal, align: "right" });
    doc.y = y + 16;

    totalBase += grupo.base;
    totalIva += grupo.iva;
    totalGeneral += grupo.total;
  });

  doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor(COLOR_GOLD).stroke();
  doc.y += 6;

  const yTotal = doc.y;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_GOLD);
  doc.text("TOTAL", colPct, yTotal, { width: anchoPct });
  doc.text(`${totalBase.toFixed(2)} €`, colBase, yTotal, { width: anchoBase, align: "right" });
  doc.text(`${totalIva.toFixed(2)} €`, colIva, yTotal, { width: anchoIva, align: "right" });
  doc.text(`${totalGeneral.toFixed(2)} €`, colTotal, yTotal, { width: anchoTotal, align: "right" });
  doc.y = yTotal + 22;
  doc.font("Helvetica").fillColor(COLOR_BLACK);
}

async function construirFacturaPDF(pedido) {
  const qrPng = await qrFacturaPng(pedido.factura);

  return generarPdfBuffer(doc => {
    dibujarCabeceraEmpresa(doc, "FACTURA", pedido.factura.numero, pedido.factura.fecha);

    // Con QR, la referencia del pedido y los datos del cliente se estrechan para dejarle sitio a la derecha.
    const yInicio = doc.y;
    const anchoTexto = qrPng ? 495 - LADO_QR - 25 : 495;
    const yFinQr = qrPng ? dibujarQrVerifactu(doc, qrPng, yInicio) : 0;
    doc.y = yInicio;

    if (pedido.numeroPedido) {
      doc.font("Helvetica").fontSize(9).fillColor(COLOR_MUTED).text(`Pedido: ${pedido.numeroPedido}`, 50, yInicio, { width: anchoTexto, align: qrPng ? "left" : "right" });
      doc.moveDown(1);
    }

    dibujarDatosCliente(doc, pedido.cliente, anchoTexto);
    doc.y = Math.max(doc.y, yFinQr + 12);

    const lineas = construirLineasFactura(pedido);
    dibujarTablaItems(doc, lineas, { conPrecios: true });

    const totalCafe = totalPedido(pedido);
    const { base: baseCafe, iva: ivaCafe } = desglosarIva(totalCafe);

    const envio = pedido.envio && !pedido.envio.gratuito ? pedido.envio : null;

    const grupos = [{ pct: IVA_TIPO, base: baseCafe, iva: ivaCafe, total: totalCafe }];
    if (envio) {
      grupos.push({ pct: IVA_ENVIO_TIPO, base: envio.base, iva: envio.iva, total: envio.total });
    }

    dibujarDesgloseIva(doc, grupos);

    if (pedido.envio && pedido.envio.gratuito) {
      doc.font("Helvetica").fontSize(8).fillColor(COLOR_MUTED).text(
        "Envío gratuito aplicado por importe de pedido.", 50, doc.y, { width: 495 }
      );
      doc.moveDown(1);
    }

    doc.font("Helvetica").fontSize(8).fillColor(COLOR_MUTED).text(
      "Factura emitida conforme al Reglamento por el que se regulan las obligaciones de facturación (RD 1619/2012). Conserve este documento a efectos fiscales.",
      50, doc.y, { width: 495 }
    );
  });
}

async function construirAlbaranPDF(pedido) {
  return generarPdfBuffer(doc => {
    dibujarCabeceraEmpresa(doc, "ALBARÁN DE ENTREGA", pedido.albaran.numero, pedido.albaran.fecha);

    doc.font("Helvetica").fontSize(9).fillColor(COLOR_MUTED);
    if (pedido.numeroPedido) doc.text(`Pedido: ${pedido.numeroPedido}`, { align: "right" });
    if (pedido.factura) doc.text(`Factura: ${pedido.factura.numero}`, { align: "right" });
    doc.moveDown(1);

    dibujarDatosCliente(doc, pedido.cliente);
    dibujarTablaItems(doc, construirLineasAlbaran(pedido), { conPrecios: false });

    doc.moveDown(3);
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_BLACK).text("Recibido conforme:", 50, doc.y);
    doc.moveDown(3);
    doc.moveTo(50, doc.y).lineTo(250, doc.y).strokeColor(COLOR_MUTED).stroke();
    doc.fontSize(8).fillColor(COLOR_MUTED).text("Firma y fecha", 50, doc.y + 4);
  });
}

async function enviarFacturaPorEmail(pedido, pdfBuffer) {
  const email = pedido.cliente && pedido.cliente.email;
  if (!email) return;

  await resend.emails.send({
    from: REMITENTE_EMAIL,
    to: email,
    subject: `Factura ${pedido.factura.numero} · ${EMPRESA.nombreComercial}`,
    html: `
      <p>Hola ${(pedido.cliente && pedido.cliente.nombre) || ""},</p>
      <p>Gracias por tu compra en ${EMPRESA.nombreComercial}. Adjuntamos la factura de tu pedido.</p>
      <p>Te avisaremos en cuanto el pedido salga hacia tu dirección.</p>
    `,
    attachments: [{ filename: `${pedido.factura.numero}.pdf`, content: pdfBuffer }]
  });
}

async function enviarAlbaranPorEmail(pedido, pdfBuffer) {
  const email = pedido.cliente && pedido.cliente.email;
  if (!email) return;

  await resend.emails.send({
    from: REMITENTE_EMAIL,
    to: email,
    subject: `Tu pedido va en camino · ${EMPRESA.nombreComercial}`,
    html: `
      <p>Hola ${(pedido.cliente && pedido.cliente.nombre) || ""},</p>
      <p>Tu pedido ya ha salido hacia tu dirección. Adjuntamos el albarán de entrega.</p>
    `,
    attachments: [{ filename: `${pedido.albaran.numero}.pdf`, content: pdfBuffer }]
  });
}

//-------------------------------------------------------------------------------------------------CIERRA - FACTURACIÓN--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - VERI*FACTU (REGISTRO DE FACTURAS EN LA AEAT)--------------------------------------------------------------------------------------------//

// Este servidor es el sistema de facturación de la empresa (RD 1007/2023): las facturas de la tienda (FACT) y las de
// mayoristas que pide el ERP (FM) se numeran aquí y, con VERIFACTU_ACTIVO=1, cada una genera un registro de alta
// encadenado (una única cadena de huellas para todas las series) que se remite a la AEAT desde una cola.
// Sin VERIFACTU_ACTIVO todo funciona como antes: solo numeración, sin registro ni QR.
//
// Variables de entorno: VERIFACTU_ACTIVO=1, VERIFACTU_ENTORNO=pruebas|produccion,
// VERIFACTU_CERT_PATH (Secret File de Render con el .p12/.pfx) o VERIFACTU_CERT_BASE64, VERIFACTU_CERT_PASSWORD.
const VERIFACTU = {
  activo: process.env.VERIFACTU_ACTIVO === "1",
  entorno: process.env.VERIFACTU_ENTORNO === "produccion" ? "produccion" : "pruebas",
  sistema: {
    nombreRazon: EMPRESA.nombre,
    nif: EMPRESA.cif,
    nombre: "AURINEGRA FACTURACION",
    id: "AU",
    version: "1.0",
    numeroInstalacion: process.env.VERIFACTU_INSTALACION || "RENDER-1"
  }
};
const SERIES_RESERVADAS = ["FACT", "ALB", "PED"];

// Las claves de Redis llevan el entorno: la cadena de pruebas y la de producción son independientes,
// así que al pasar a producción la primera factura real empieza su propia cadena (PrimerRegistro).
function vfClave(nombre) {
  return `verifactu_${VERIFACTU.entorno}_${nombre}`;
}

// El QR solo se imprime con el entorno de producción: el de pruebas no sirve para que el cliente coteje la factura.
function qrImprimible(factura) {
  return Boolean(factura && factura.verifactu && factura.verifactu.entorno === "produccion");
}

function certificadoVerifactu() {
  const ruta = process.env.VERIFACTU_CERT_PATH;
  const base64 = process.env.VERIFACTU_CERT_BASE64;
  const pfx = base64 ? Buffer.from(base64, "base64") : (ruta && fs.existsSync(ruta) ? fs.readFileSync(ruta) : null);

  if (!pfx) throw new Error("Falta el certificado electrónico (VERIFACTU_CERT_PATH o VERIFACTU_CERT_BASE64)");
  return { pfx, passphrase: process.env.VERIFACTU_CERT_PASSWORD || "" };
}

// registro: { id, tipo: "alta" | "anulacion", numSerie, fechaExpedicion, tipoFactura, importeTotal, huella, xml,
//             estado: "pendiente" | "Correcto" | "AceptadoConErrores" | "Incorrecto", error, csv, creado, enviado }
async function leerRegistroVerifactu(id) { return redisGet(vfClave(`registro:${id}`), null); }
async function guardarRegistroVerifactu(registro) { await redisSet(vfClave(`registro:${registro.id}`), registro); }

// Añade un registro al final de la cadena. Debe llamarse dentro del bloqueo de la cadena (vfClave("lock_cadena")).
async function encadenarRegistro(construir, datosRegistro) {
  const ahora = new Date();
  const anterior = await redisGet(vfClave("ultimo"), null);
  const { huella, xml } = construir({
    nifEmisor: EMPRESA.cif,
    marcaTemporal: verifactu.marcaTemporal(ahora),
    huellaAnterior: anterior ? anterior.huella : "",
    anterior,
    sistema: VERIFACTU.sistema
  });

  const id = await redisComando("INCR", vfClave("contador_registros"));
  await guardarRegistroVerifactu({ id, ...datosRegistro, huella, xml, estado: "pendiente", creado: ahora.toISOString() });
  await redisComando("RPUSH", vfClave("cola"), id);
  await redisSet(vfClave("ultimo"), {
    nifEmisor: EMPRESA.cif, numSerie: datosRegistro.numSerie, fechaExpedicion: datosRegistro.fechaExpedicion, huella, registroId: id
  });
  return { id, huella };
}

// Emite una factura: siguiente número de su serie y, con VERI*FACTU, su registro de alta.
// datos: { serie, tipoFactura, descripcion, destinatario, desglose: [{ tipo, base, cuota, tipoRE?, cuotaRE?, exencion? }],
//          cuotaTotal, importeTotal, facturasRectificadas? }  (importes en céntimos)
// idempotencia: clave opcional para que un reintento del ERP no emita la misma factura dos veces.
async function emitirFactura(datos, idempotencia = null) {
  const factura = await conBloqueo(vfClave("lock_cadena"), async () => {
    if (idempotencia) {
      const previa = await redisGet(`factura_emitida:${idempotencia}`, null);
      if (previa) return previa;
    }

    const ahora = new Date();
    const numero = await generarNumeroDocumento(datos.serie);
    const fechaExpedicion = verifactu.fechaMadrid(ahora);
    const emitida = { numero, fecha: ahora.toISOString(), fechaExpedicion };

    if (VERIFACTU.activo) {
      const { id, huella } = await encadenarRegistro(
        base => verifactu.registroAlta({ ...base, ...datos, nombreEmisor: EMPRESA.nombre, numSerie: numero, fechaExpedicion }),
        { tipo: "alta", numSerie: numero, fechaExpedicion, tipoFactura: datos.tipoFactura, importeTotal: datos.importeTotal }
      );
      await redisSet(vfClave(`factura:${numero}`), id);
      emitida.verifactu = {
        registroId: id,
        huella,
        entorno: VERIFACTU.entorno,
        qr: verifactu.urlQR({ nifEmisor: EMPRESA.cif, numSerie: numero, fechaExpedicion, importeTotal: datos.importeTotal, entorno: VERIFACTU.entorno })
      };
    }

    if (idempotencia) await redisSet(`factura_emitida:${idempotencia}`, emitida);
    return emitida;
  });

  procesarColaVerifactu().catch(error => console.error("VERI*FACTU: error procesando la cola:", error.message));
  return factura;
}

// Datos de registro de la factura de un pedido de la tienda: café al 10 % y, si lo hay, envío al 21 %,
// con los mismos importes redondeados que aparecen en el PDF.
function datosFacturaPedido(pedido) {
  const totalCafe = Number(totalPedido(pedido).toFixed(2));
  const { base, iva } = desglosarIva(totalCafe);
  const desglose = [{ tipo: 10, base: verifactu.aCentimos(base), cuota: verifactu.aCentimos(iva) }];
  const envio = pedido.envio && !pedido.envio.gratuito ? pedido.envio : null;
  if (envio) desglose.push({ tipo: 21, base: verifactu.aCentimos(envio.base), cuota: verifactu.aCentimos(envio.iva) });

  const cuotaTotal = desglose.reduce((suma, d) => suma + d.cuota, 0);
  const c = pedido.cliente || {};
  return {
    serie: "FACT",
    tipoFactura: "F1",
    descripcion: "Venta de café en la tienda online",
    destinatario: { nombre: `${c.nombre || ""} ${c.apellidos || ""}`.trim(), nif: claveCliente(c) },
    desglose,
    cuotaTotal,
    importeTotal: desglose.reduce((suma, d) => suma + d.base, 0) + cuotaTotal
  };
}

// Anula el registro de una factura expedida por error (no sustituye a una rectificativa).
async function anularFactura(numSerie) {
  if (!VERIFACTU.activo) throw new Error("VERI*FACTU no está activo");

  const resultado = await conBloqueo(vfClave("lock_cadena"), async () => {
    const idAlta = await redisGet(vfClave(`factura:${numSerie}`), null);
    const alta = idAlta && await leerRegistroVerifactu(idAlta);
    if (!alta) throw Object.assign(new Error("No hay registro de esa factura"), { status: 404 });
    if (alta.anulada) throw Object.assign(new Error("La factura ya estaba anulada"), { status: 400 });

    const { id } = await encadenarRegistro(
      base => verifactu.registroAnulacion({ ...base, numSerie, fechaExpedicion: alta.fechaExpedicion }),
      { tipo: "anulacion", numSerie, fechaExpedicion: alta.fechaExpedicion }
    );
    await guardarRegistroVerifactu({ ...alta, anulada: id });
    return { registroId: id };
  });

  procesarColaVerifactu().catch(error => console.error("VERI*FACTU: error procesando la cola:", error.message));
  return resultado;
}

// Envía a la AEAT los registros en cola, respetando el TiempoEsperaEnvio que indique la AEAT
// (o antes, si se acumulan 1000). Un fallo de comunicación deja los registros en cola para el siguiente intento.
let enviandoVerifactu = false;

async function procesarColaVerifactu() {
  if (!VERIFACTU.activo || !redisConfigurado() || enviandoVerifactu) return;
  enviandoVerifactu = true;

  try {
    const ids = (await redisComando("LRANGE", vfClave("cola"), 0, verifactu.MAX_REGISTROS_POR_ENVIO - 1)) || [];
    const esperaHasta = Number(await redisGet(vfClave("espera_hasta"), 0));
    if (ids.length === 0 || (Date.now() < esperaHasta && ids.length < verifactu.MAX_REGISTROS_POR_ENVIO)) return;

    const registros = (await Promise.all(ids.map(leerRegistroVerifactu))).filter(Boolean);
    let respuesta;
    try {
      const sobre = verifactu.sobreEnvio({ nombreRazon: EMPRESA.nombre, nif: EMPRESA.cif }, registros.map(r => r.xml));
      respuesta = await verifactu.enviar(sobre, { entorno: VERIFACTU.entorno, certificado: certificadoVerifactu() });
    } catch (error) {
      await redisSet(vfClave("espera_hasta"), Date.now() + verifactu.ESPERA_POR_DEFECTO_S * 1000);
      await redisSet(vfClave("ultimo_error"), { fecha: new Date().toISOString(), error: error.message });
      console.error("VERI*FACTU: no se pudo enviar a la AEAT, se reintentará:", error.message);
      return;
    }

    const lineas = new Map(respuesta.lineas.map(l => [`${l.operacion === "Anulacion" ? "anulacion" : "alta"}|${l.numSerie}`, l]));
    const sinRespuesta = [];
    for (const registro of registros) {
      const linea = lineas.get(`${registro.tipo}|${registro.numSerie}`);
      if (!linea) {
        sinRespuesta.push(registro.id);
        continue;
      }
      // Un duplicado significa que la AEAT ya tenía ese registro (p. ej. de un envío anterior sin respuesta).
      const estado = linea.codigoError === "3000" && linea.estadoDuplicado
        ? (linea.estadoDuplicado === "Correcta" ? "Correcto" : linea.estadoDuplicado === "AceptadaConErrores" ? "AceptadoConErrores" : "Incorrecto")
        : linea.estado;
      await guardarRegistroVerifactu({
        ...registro, estado, codigoError: linea.codigoError, error: linea.error, csv: respuesta.csv, enviado: new Date().toISOString()
      });
      if (estado === "Incorrecto") console.error(`VERI*FACTU: registro ${registro.numSerie} rechazado: ${linea.codigoError} ${linea.error}`);
    }

    // Se sacan de la cola los enviados; los que no vinieron en la respuesta vuelven al final.
    await redisComando("LTRIM", vfClave("cola"), ids.length, -1);
    if (sinRespuesta.length) await redisComando("RPUSH", vfClave("cola"), ...sinRespuesta);
    await redisSet(vfClave("espera_hasta"), Date.now() + respuesta.esperaSegundos * 1000);
    await redisSet(vfClave("ultimo_envio"), { fecha: new Date().toISOString(), estado: respuesta.estadoEnvio, csv: respuesta.csv, registros: registros.length });
    await redisSet(vfClave("ultimo_error"), null);
  } finally {
    enviandoVerifactu = false;
  }
}

if (VERIFACTU.activo) {
  console.log(`VERI*FACTU activo (entorno: ${VERIFACTU.entorno})`);
  setInterval(() => procesarColaVerifactu().catch(error => console.error("VERI*FACTU:", error.message)), 60 * 1000);
}

// Estado para el ERP/panel: cola, último envío y los últimos registros (sin el XML).
app.get("/api/verifactu/estado", requiereAdmin, async (req, res) => {
  try {
    const total = Number(await redisGet(vfClave("contador_registros"), 0));
    const ids = [];
    for (let id = total; id > 0 && ids.length < 200; id--) ids.push(id);
    const crudos = ids.length ? await redisComando("MGET", ...ids.map(id => vfClave(`registro:${id}`))) : [];
    const registros = crudos.filter(Boolean).map(texto => {
      const { xml, ...resumen } = JSON.parse(texto);
      return resumen;
    });

    res.json({
      activo: VERIFACTU.activo,
      entorno: VERIFACTU.entorno,
      enCola: Number(await redisComando("LLEN", vfClave("cola"))),
      ultimoEnvio: await redisGet(vfClave("ultimo_envio"), null),
      ultimoError: await redisGet(vfClave("ultimo_error"), null),
      registros
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo leer el estado de VERI*FACTU" });
  }
});

app.post("/api/verifactu/enviar", requiereAdmin, async (req, res) => {
  try {
    await redisSet(vfClave("espera_hasta"), 0);
    await procesarColaVerifactu();
    res.json({ success: true, enCola: Number(await redisComando("LLEN", vfClave("cola"))) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/verifactu/anular", requiereAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await anularFactura(String((req.body || {}).numero || ""))) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

function validarFacturaErp(d) {
  if (!d || typeof d !== "object") return "Faltan los datos de la factura";
  if (!/^[\w-]{8,64}$/.test(String(d.idempotencia || ""))) return "Falta la clave de idempotencia";
  if (!/^[A-Z0-9]{1,10}$/.test(String(d.serie || "")) || SERIES_RESERVADAS.includes(d.serie)) return "Serie no válida";
  if (!["F1", "F2", "R1", "R2", "R3", "R4", "R5"].includes(d.tipoFactura)) return "Tipo de factura no válido";
  if (d.tipoFactura.startsWith("R") && !(Array.isArray(d.facturasRectificadas) && d.facturasRectificadas.length)) {
    return "Una rectificativa debe indicar la factura rectificada";
  }
  const dest = d.destinatario;
  if (d.tipoFactura !== "F2" && !(dest && dest.nombre && (dest.nif || (dest.pais && dest.id)))) return "Faltan los datos del destinatario";
  if (!Array.isArray(d.desglose) || d.desglose.length < 1 || d.desglose.length > 12) return "El desglose debe tener entre 1 y 12 líneas";

  const enteros = d.desglose.flatMap(l => [l.base, l.cuota || 0, l.cuotaRE || 0]).concat([d.cuotaTotal, d.importeTotal]);
  if (!enteros.every(Number.isInteger)) return "Los importes deben ir en céntimos (enteros)";
  const cuotas = d.desglose.reduce((s, l) => s + (l.cuota || 0) + (l.cuotaRE || 0), 0);
  const bases = d.desglose.reduce((s, l) => s + l.base, 0);
  if (cuotas !== d.cuotaTotal || bases + cuotas !== d.importeTotal) return "Los totales no cuadran con el desglose";
  return null;
}

// El ERP emite aquí las facturas de mayoristas: así toda la facturación comparte numeración, cadena y envío a la AEAT.
app.post("/api/facturas-erp", requiereAdmin, async (req, res) => {
  try {
    const d = req.body;
    const error = validarFacturaErp(d);
    if (error) return res.status(400).json({ error });

    const factura = await emitirFactura({
      serie: d.serie,
      tipoFactura: d.tipoFactura,
      descripcion: String(d.descripcion || "Venta de café").slice(0, 500),
      destinatario: d.destinatario,
      desglose: d.desglose,
      cuotaTotal: d.cuotaTotal,
      importeTotal: d.importeTotal,
      tipoRectificativa: d.tipoRectificativa,
      facturasRectificadas: d.facturasRectificadas
    }, `erp-${d.idempotencia}`);
    res.json(factura);
  } catch (error) {
    console.error("No se pudo emitir la factura del ERP:", error);
    res.status(500).json({ error: "No se pudo emitir la factura" });
  }
});

//-------------------------------------------------------------------------------------------------CIERRA - VERI*FACTU--------------------------------------------------------------------------------------------//


/**-------------------------------------------------------------------------------------------------ABRE - EMAIL IONOS--------------------------------------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: "smtp.ionos.es",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});
//-------------------------------------------------------------------------------------------------CIERRA - EMAIL IONOS--------------------------------------------------------------------------------------------*/


//-------------------------------------------------------------------------------------------------ABRE - VALIDACIÓN DE DATOS DEL CLIENTE--------------------------------------------------------------------------------------------//

function validarDniNie(valor) {
  const v = String(valor || "").trim().toUpperCase().replace(/[-\s]/g, "");
  const dniRegex = /^(\d{8})([A-Z])$/;
  const nieRegex = /^([XYZ])(\d{7})([A-Z])$/;
  const letras = "TRWAGMYFPDXBNJZSQVHLCKE";
  let numero, letra;

  if (dniRegex.test(v)) {
    const m = v.match(dniRegex);
    numero = parseInt(m[1], 10);
    letra = m[2];
  } else if (nieRegex.test(v)) {
    const m = v.match(nieRegex);
    const prefijo = { X: "0", Y: "1", Z: "2" }[m[1]];
    numero = parseInt(prefijo + m[2], 10);
    letra = m[3];
  } else {
    return false;
  }

  return letras[numero % 23] === letra;
}

// Validación de formato del CIF (letra de tipo de entidad + 7 dígitos + dígito/letra de control).
// No recalcula el dígito de control (depende del tipo de entidad): solo valida el formato.
function validarCif(valor) {
  const v = String(valor || "").trim().toUpperCase().replace(/[-\s]/g, "");
  return /^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(v);
}

function validarClienteServidor(cliente) {
  if (!cliente || typeof cliente !== "object") return "Faltan los datos de envío y facturación";

  const esEmpresa = cliente.tipoCliente === "empresa";

  const requeridos = esEmpresa
    ? ["nombre", "dni", "telefono", "email", "direccion", "codigoPostal", "localidad", "provincia"]
    : ["nombre", "apellidos", "dni", "telefono", "email", "direccion", "codigoPostal", "localidad", "provincia"];

  for (const campo of requeridos) {
    if (!cliente[campo] || !String(cliente[campo]).trim()) {
      return `Falta el campo "${campo}" en los datos de envío/facturación`;
    }
  }

  if (esEmpresa) {
    if (!validarCif(cliente.dni)) return "El CIF no es válido";
  } else if (!validarDniNie(cliente.dni)) {
    return "El DNI/NIF/NIE no es válido";
  }

  if (!/^[67]\d{8}$/.test(String(cliente.telefono).replace(/[\s-]/g, ""))) return "El teléfono móvil no es válido";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(cliente.email).trim())) return "El email no es válido";
  if (!/^(0[1-9]|[1-4]\d|5[0-2])\d{3}$/.test(String(cliente.codigoPostal).trim())) return "El código postal no es válido";

  return null;
}

//-------------------------------------------------------------------------------------------------CIERRA - VALIDACIÓN DE DATOS DEL CLIENTE--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - CONFIRMACIÓN DE PAGO (solo se llama desde el webhook, nunca desde el navegador)--------------------------------------------------------------------------------------------//

// Stripe confirma que el pago se ha cobrado de verdad: aquí (y solo aquí) se reserva el stock y se registra el movimiento.
async function confirmarPagoPedido(session) {
  const pedidos = await leerPedidos();
  const pedido = pedidos.find(p => p.id === session.id);

  if (!pedido) {
    console.error(`Webhook: no se encontró el pedido para la sesión ${session.id}`);
    return;
  }

  if (pedido.estadoPago === "pagado") {
    return; // Stripe puede reenviar el mismo evento más de una vez: no reservamos dos veces
  }

  const stockReal = await leerStockReal();
  const reservado = await leerReservado();
  const movimientos = await leerMovimientos();

  // Revalidamos stock por si ha cambiado entre que se creó la sesión y que se confirmó el pago
  const faltantes = [];
  for (const item of pedido.items) {
    const real = Number(vacioParaCodigo(stockReal, item.lote)[item.peso] || 0);
    const yaReservado = Number(vacioParaCodigo(reservado, item.lote)[item.peso] || 0);
    const disponible = Math.max(0, real - yaReservado);

    if (item.cantidad > disponible) {
      faltantes.push(`${item.lote} / ${item.peso} g (necesita ${item.cantidad}, disponible ${disponible})`);
    }
  }

  if (faltantes.length > 0) {
    pedido.estadoPago = "pagado_sin_stock";
    pedido.avisoStock = `Pago confirmado pero sin stock suficiente: ${faltantes.join("; ")}. Revisar manualmente.`;
    await redisSet("pedidos", pedidos);
    console.error(`ATENCIÓN: el pedido ${pedido.id} se ha pagado pero no hay stock suficiente. Revisar a mano.`);
    return;
  }

  for (const item of pedido.items) {
    reservado[item.lote] = vacioParaCodigo(reservado, item.lote);
    const anterior = Number(reservado[item.lote][item.peso] || 0);
    reservado[item.lote][item.peso] = anterior + item.cantidad;

    movimientos.push({
      fecha: new Date().toISOString(),
      codigo: item.lote,
      peso: item.peso,
      tipo: "reserva",
      campo: "reservado",
      anterior,
      nuevo: anterior + item.cantidad,
      diferencia: item.cantidad,
      pedidoId: pedido.id,
      observaciones: "Reserva creada al confirmarse el pago"
    });
  }

  pedido.estadoPago = "pagado";
  pedido.estadoPreparacion = pedido.estadoPreparacion || "pendiente";
  pedido.referenciaPago = {
    proveedor: "stripe",
    sessionId: session.id,
    paymentIntentId: session.payment_intent || null
  };

  try {
    // Si Stripe reenvía el evento tras un fallo a medias, la clave del pedido evita emitir otra factura.
    pedido.factura = await emitirFactura(datosFacturaPedido(pedido), `pedido-${pedido.id}`);
    const pdfFactura = await construirFacturaPDF(pedido);
    await enviarFacturaPorEmail(pedido, pdfFactura);
    await actualizarFichaCliente(pedido);
  } catch (error) {
    console.error(`No se pudo generar/enviar la factura del pedido ${pedido.id}:`, error);
  }

  await redisSet("stock_reservado", reservado);
  await redisSet("movimientos", movimientos);
  await redisSet("pedidos", pedidos);
}

// La sesión de pago caducó sin que el cliente pagara: como ya no se reserva nada al crearla, solo hay que marcar el pedido.
async function cancelarPedidoExpirado(session) {
  const pedidos = await leerPedidos();
  const pedido = pedidos.find(p => p.id === session.id);

  if (!pedido || pedido.estadoPago !== "pendiente_pago") return;

  pedido.estadoPago = "cancelado";
  await redisSet("pedidos", pedidos);
}

//-------------------------------------------------------------------------------------------------CIERRA - CONFIRMACIÓN DE PAGO--------------------------------------------------------------------------------------------//

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { carrito, cliente } = req.body;

    if (!Array.isArray(carrito) || carrito.length === 0) {
      return res.status(400).json({ error: "El carrito está vacío" });
    }

    const errorCliente = validarClienteServidor(cliente);
    if (errorCliente) {
      return res.status(400).json({ error: errorCliente });
    }

    const catalogo = leerCatalogo();
    const stockReal = await leerStockReal();
    const reservado = await leerReservado();

    // unidades necesarias por lote + formato en este pedido (varias líneas pueden compartir el mismo lote/formato)
    const unidadesNecesarias = {}; // "CODIGO|peso" -> unidades

    const lineItems = carrito.map(item => {
      const lote = catalogo[item.lote];

      if (!lote || lote.estado !== "activo") {
        throw new Error(`El lote "${item.lote}" ya no está disponible`);
      }

      const precioUnitario = Number(lote.precios[item.peso]);

      if (!Number.isFinite(precioUnitario)) {
        throw new Error(`El formato de ${item.peso} g no existe para el lote "${item.lote}"`);
      }

      const cantidad = Number(item.cantidad);

      if (!Number.isInteger(cantidad) || cantidad < 1) {
        throw new Error(`Cantidad inválida para el lote "${item.lote}"`);
      }

      const clave = `${item.lote}|${item.peso}`;
      unidadesNecesarias[clave] = (unidadesNecesarias[clave] || 0) + cantidad;

      return {
        precioUnitario,
        cantidad,
        item,
        lote,
        lineItem: {
          price_data: {
            currency: "eur",
            product_data: {
              name: item.nombre,
              description: [`Lote ${lote.codigo}`, lote.proceso, `${item.peso} g`, item.molienda, etiquetaTueste(lote) && `Tueste ${etiquetaTueste(lote)}`].filter(Boolean).join(" · ")
            },
            unit_amount: Math.round(precioUnitario * 100)
          },
          quantity: cantidad
        }
      };
    });

    for (const clave of Object.keys(unidadesNecesarias)) {
      const [codigoLote, peso] = clave.split("|");
      const real = Number(vacioParaCodigo(stockReal, codigoLote)[peso] || 0);
      const yaReservado = Number(vacioParaCodigo(reservado, codigoLote)[peso] || 0);
      const disponible = Math.max(0, real - yaReservado);

      if (unidadesNecesarias[clave] > disponible) {
        return res.status(409).json({
          error: `No hay stock suficiente del lote "${codigoLote}" en formato ${peso} g. Disponible: ${disponible} unidades.`
        });
      }
    }

    // El importe del café (con su 10% de IVA) decide si hay portes: nunca nos fiamos de lo que
    // calculó el navegador, se recalcula aquí con los precios reales del catálogo.
    const totalCafe = lineItems.reduce((suma, li) => suma + li.precioUnitario * li.cantidad, 0);
    const configEnvio = await leerConfigEnvio();
    const envio = calcularEnvio(totalCafe, configEnvio);

    const stripeLineItems = lineItems.map(li => li.lineItem);

    if (!envio.gratuito) {
      stripeLineItems.push({
        price_data: {
          currency: "eur",
          product_data: {
            name: "Gastos de envío",
            description: "Envío a Península (IVA 21% incluido)"
          },
          unit_amount: Math.round(envio.total * 100)
        },
        quantity: 1
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: stripeLineItems,
      mode: "payment",
      customer_email: cliente.email,
      success_url: "https://cafedmedina-web.onrender.com/success.html",
      cancel_url: "https://cafedmedina-web.onrender.com/cancel.html",
      metadata: {
        nombre: cliente.nombre,
        apellidos: cliente.apellidos,
        dni: cliente.dni,
        telefono: cliente.telefono,
        direccion: cliente.direccion,
        codigoPostal: cliente.codigoPostal,
        localidad: cliente.localidad,
        provincia: cliente.provincia
      }
    });

    // IMPORTANTE: aquí NO se reserva stock ni se crea movimiento todavía.
    // El pedido queda "pendiente_pago" hasta que Stripe confirme el cobro por webhook
    // (evento checkout.session.completed) — así nunca se bloquea stock por pagos
    // abandonados o fallidos.
    //
    // numeroPedido es solo una referencia legible (PED-2026-0001...) para mostrar al cliente
    // y en el panel admin: el id real de Stripe (cs_test_... / cs_live_...) nunca debe mostrarse.
    const pedidos = await leerPedidos();
    pedidos.push({
      id: session.id,
      numeroPedido: await generarNumeroDocumento("PED"),
      fecha: new Date().toISOString(),
      estadoPago: "pendiente_pago",
      estadoPreparacion: "pendiente",
      cliente,
      items: lineItems.map(li => ({
        nombre: li.item.nombre,
        proceso: li.lote.proceso,
        lote: li.lote.codigo,
        peso: li.item.peso,
        molienda: li.item.molienda,
        tueste: etiquetaTueste(li.lote),
        cantidad: li.cantidad,
        precioUnitario: li.precioUnitario
      })),
      envio
    });
    await redisSet("pedidos", pedidos);

    res.json({ id: session.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || "Error creando el pago" });
  }
});



app.post("/contacto", async (req, res) => {

  try {

    const {
      nombre,
      empresa,
      email,
      telefono,
      pais,
      tipo,
      volumen,
      mensaje
    } = req.body;

    await resend.emails.send({

      from: REMITENTE_EMAIL,

      to: EMPRESA.email,

      subject: "Nueva solicitud comercial AURINEGRA",

      html: `
        <h2>Nueva solicitud comercial</h2>

        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Empresa:</strong> ${empresa}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Teléfono:</strong> ${telefono}</p>
        <p><strong>País:</strong> ${pais}</p>
        <p><strong>Tipo:</strong> ${tipo}</p>
        <p><strong>Volumen:</strong> ${volumen}</p>

        <hr>

        <p>${mensaje}</p>
      `
    });

    res.status(200).json({
      success: true
    });

  } catch(error){

    console.log(error);

    res.status(500).json({
      error: error.message
    });

  }

});



const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Tienda funcionando en puerto ${PORT}`);
});

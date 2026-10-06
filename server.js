const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();

app.use(cors());
app.use(express.static(__dirname));

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

// stockReal: { "DM-2026-001": { "250": 10, "500": 20, "1000": 12 }, ... } -> unidades físicas reales
// reservado: misma forma -> unidades vendidas y pagadas pero aún no enviadas
async function leerStockReal() { return redisGet("stock_real", {}); }
async function leerReservado() { return redisGet("stock_reservado", {}); }
async function leerPedidos() { return redisGet("pedidos", []); }
async function leerMovimientos() { return redisGet("movimientos", []); }

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

    lotes[codigo] = { ...catalogo[codigo], stock };
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
  nombreComercial: "Café D’Medina",
  cif: "B05653621",
  direccion: "Calle San Pedro del Pinatar, 24, 28939 Arroyomolinos, Madrid",
  email: "info@cafedmedina.com",
  telefono: "+34 660 736 866"
};

const IVA_TIPO = 0.10; // Los precios del catálogo ya incluyen este IVA

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
  doc.fontSize(18).fillColor("#000").text(EMPRESA.nombreComercial);
  doc.fontSize(9).fillColor("#555")
    .text(EMPRESA.nombre)
    .text(`CIF: ${EMPRESA.cif}`)
    .text(EMPRESA.direccion)
    .text(`${EMPRESA.email} · ${EMPRESA.telefono}`);

  doc.fontSize(16).fillColor("#000").text(tituloDocumento, 50, 50, { align: "right" });
  doc.fontSize(10).fillColor("#555")
    .text(`Nº: ${numero}`, { align: "right" })
    .text(`Fecha: ${new Date(fecha).toLocaleDateString("es-ES")}`, { align: "right" });

  doc.moveDown(2);
  doc.fillColor("#000");
}

function dibujarDatosCliente(doc, cliente) {
  const c = cliente || {};
  doc.fontSize(11).text("Datos del cliente", { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10)
    .text(`${c.nombre || ""} ${c.apellidos || ""}`)
    .text(`DNI/NIE: ${c.dni || "—"}`)
    .text(c.direccion || "")
    .text(`${c.codigoPostal || ""} ${c.localidad || ""} (${c.provincia || ""})`)
    .text(`${c.email || ""} · ${c.telefono || ""}`);
  doc.moveDown(1.5);
}

function dibujarTablaItems(doc, pedido, { conPrecios }) {
  const x = 50;
  const anchoDesc = conPrecios ? 230 : 350;
  const colCant = x + anchoDesc;
  const colPrecio = colCant + 70;
  const colTotal = colPrecio + 80;

  function cabeceraTabla() {
    const y = doc.y;
    doc.fontSize(9).fillColor("#888");
    doc.text("Producto", x, y, { width: anchoDesc });
    doc.text("Cant.", colCant, y, { width: 60, align: "right" });
    if (conPrecios) {
      doc.text("Precio ud.", colPrecio, y, { width: 70, align: "right" });
      doc.text("Total", colTotal, y, { width: 70, align: "right" });
    }
    doc.y = y + 14;
    doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
    doc.y += 8;
    doc.fillColor("#000");
  }

  cabeceraTabla();

  pedido.items.forEach(item => {
    if (doc.y > 680) {
      doc.addPage();
      doc.y = 50;
      cabeceraTabla();
    }

    const y = doc.y;
    const desc = `${item.nombre} · Lote ${item.lote} · ${etiquetaPeso(item.peso)} · ${item.molienda} · ${item.tueste}`;
    const alturaDesc = doc.heightOfString(desc, { width: anchoDesc });

    doc.fontSize(9).text(desc, x, y, { width: anchoDesc });
    doc.text(String(item.cantidad), colCant, y, { width: 60, align: "right" });

    if (conPrecios) {
      doc.text(`${Number(item.precioUnitario).toFixed(2)} €`, colPrecio, y, { width: 70, align: "right" });
      doc.text(`${(item.precioUnitario * item.cantidad).toFixed(2)} €`, colTotal, y, { width: 70, align: "right" });
    }

    doc.y = y + Math.max(alturaDesc, 14) + 6;
  });

  doc.moveDown(0.3);
  doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor("#ccc").stroke();
  doc.moveDown(0.8);
}

async function construirFacturaPDF(pedido) {
  return generarPdfBuffer(doc => {
    dibujarCabeceraEmpresa(doc, "FACTURA", pedido.factura.numero, pedido.factura.fecha);
    doc.fontSize(9).fillColor("#555").text(`Pedido: ${pedido.id}`, { align: "right" });
    doc.moveDown(1);

    dibujarDatosCliente(doc, pedido.cliente);
    dibujarTablaItems(doc, pedido, { conPrecios: true });

    const total = totalPedido(pedido);
    const { base, iva } = desglosarIva(total);

    const xEtq = 350, xVal = 465;

    function filaTotal(etiqueta, valor, negrita) {
      const y = doc.y;
      doc.fontSize(negrita ? 12 : 10).fillColor("#000");
      doc.text(etiqueta, xEtq, y, { width: 110, align: "right" });
      doc.text(valor, xVal, y, { width: 80, align: "right" });
      doc.y = y + (negrita ? 18 : 15);
    }

    filaTotal("Base imponible:", `${base.toFixed(2)} €`);
    filaTotal(`IVA (${Math.round(IVA_TIPO * 100)}%):`, `${iva.toFixed(2)} €`);
    filaTotal("TOTAL:", `${total.toFixed(2)} €`, true);

    doc.moveDown(2);
    doc.fontSize(8).fillColor("#888").text(
      "Factura emitida conforme al Reglamento por el que se regulan las obligaciones de facturación (RD 1619/2012). Conserve este documento a efectos fiscales.",
      50, doc.y, { width: 495 }
    );
  });
}

async function construirAlbaranPDF(pedido) {
  return generarPdfBuffer(doc => {
    dibujarCabeceraEmpresa(doc, "ALBARÁN DE ENTREGA", pedido.albaran.numero, pedido.albaran.fecha);
    doc.fontSize(9).fillColor("#555").text(`Pedido: ${pedido.id}`, { align: "right" });
    if (pedido.factura) {
      doc.text(`Factura: ${pedido.factura.numero}`, { align: "right" });
    }
    doc.moveDown(1);

    dibujarDatosCliente(doc, pedido.cliente);
    dibujarTablaItems(doc, pedido, { conPrecios: false });

    doc.moveDown(3);
    doc.fontSize(10).fillColor("#000").text("Recibido conforme:", 50, doc.y);
    doc.moveDown(3);
    doc.moveTo(50, doc.y).lineTo(250, doc.y).strokeColor("#888").stroke();
    doc.fontSize(8).fillColor("#888").text("Firma y fecha", 50, doc.y + 4);
  });
}

async function enviarFacturaPorEmail(pedido, pdfBuffer) {
  const email = pedido.cliente && pedido.cliente.email;
  if (!email) return;

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: email,
    subject: `Factura ${pedido.factura.numero} · Café D’Medina`,
    html: `
      <p>Hola ${(pedido.cliente && pedido.cliente.nombre) || ""},</p>
      <p>Gracias por tu compra en Café D’Medina. Adjuntamos la factura de tu pedido.</p>
      <p>Te avisaremos en cuanto el pedido salga hacia tu dirección.</p>
    `,
    attachments: [{ filename: `${pedido.factura.numero}.pdf`, content: pdfBuffer }]
  });
}

async function enviarAlbaranPorEmail(pedido, pdfBuffer) {
  const email = pedido.cliente && pedido.cliente.email;
  if (!email) return;

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: email,
    subject: "Tu pedido va en camino · Café D’Medina",
    html: `
      <p>Hola ${(pedido.cliente && pedido.cliente.nombre) || ""},</p>
      <p>Tu pedido ya ha salido hacia tu dirección. Adjuntamos el albarán de entrega.</p>
    `,
    attachments: [{ filename: `${pedido.albaran.numero}.pdf`, content: pdfBuffer }]
  });
}

//-------------------------------------------------------------------------------------------------CIERRA - FACTURACIÓN--------------------------------------------------------------------------------------------//


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

function validarClienteServidor(cliente) {
  if (!cliente || typeof cliente !== "object") return "Faltan los datos de envío y facturación";

  const requeridos = ["nombre", "apellidos", "dni", "telefono", "email", "direccion", "codigoPostal", "localidad", "provincia"];
  for (const campo of requeridos) {
    if (!cliente[campo] || !String(cliente[campo]).trim()) {
      return `Falta el campo "${campo}" en los datos de envío/facturación`;
    }
  }

  if (!validarDniNie(cliente.dni)) return "El DNI/NIF/NIE no es válido";
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
    pedido.factura = { numero: await generarNumeroDocumento("FACT"), fecha: new Date().toISOString() };
    const pdfFactura = await construirFacturaPDF(pedido);
    await enviarFacturaPorEmail(pedido, pdfFactura);
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
              description: `Lote ${lote.codigo} · ${lote.proceso} · ${item.peso} g · ${item.molienda} · ${item.tueste}`
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

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems.map(li => li.lineItem),
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
    const pedidos = await leerPedidos();
    pedidos.push({
      id: session.id,
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
        tueste: li.item.tueste,
        cantidad: li.cantidad,
        precioUnitario: li.precioUnitario
      }))
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

      from: "onboarding@resend.dev",

      /*to: "info@cafedmedina.com",*/
      to: "juliana.medina416@gmail.com",

      subject: "Nueva solicitud comercial Café D’Medina",

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

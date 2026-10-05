const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const { Resend } = require("resend");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());

//-------------------------------------------------------------------------------------------------ABRE - INVENTARIO POR LOTE (PRIVADO)--------------------------------------------------------------------------------------------//

const LOTES_FILE = path.join(__dirname, "data", "lotes.json");
const PESOS_VALIDOS = ["250", "500", "1000"];
const ESTADOS_VALIDOS = ["activo", "agotado", "archivado"];

function leerLotes() {
  const raw = fs.readFileSync(LOTES_FILE, "utf-8");
  return JSON.parse(raw);
}

function guardarLotes(datos) {
  fs.writeFileSync(LOTES_FILE, JSON.stringify(datos, null, 2));
}

function requiereAdmin(req, res, next) {
  const token = req.get("x-admin-token");

  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }

  next();
}

app.get("/api/lotes", (req, res) => {
  try {
    res.json(leerLotes());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo leer el inventario" });
  }
});

app.put("/api/lotes", requiereAdmin, (req, res) => {
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

      if (!Number.isFinite(Number(lote.stockKg)) || Number(lote.stockKg) < 0) {
        return res.status(400).json({ error: `Stock inválido en el lote "${codigo}"` });
      }

      const formatosConPrecio = Object.keys(lote.precios || {}).filter(peso =>
        PESOS_VALIDOS.includes(peso) && Number.isFinite(Number(lote.precios[peso])) && Number(lote.precios[peso]) > 0
      );

      if (formatosConPrecio.length === 0) {
        return res.status(400).json({ error: `El lote "${codigo}" necesita al menos un precio válido` });
      }

      lote.codigo = codigo;
    }

    guardarLotes(datos);
    res.json({ success: true, lotes: datos });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudo guardar el inventario" });
  }
});

//-------------------------------------------------------------------------------------------------CIERRA - INVENTARIO POR LOTE (PRIVADO)--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - STRIPE TEST--------------------------------------------------------------------------------------------//
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
//-------------------------------------------------------------------------------------------------CIERRA - STRIPE TEST--------------------------------------------------------------------------------------------//

const resend = new Resend(process.env.RESEND_API_KEY);


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


app.post("/create-checkout-session", async (req, res) => {
  try {
    const { carrito } = req.body;

    if (!Array.isArray(carrito) || carrito.length === 0) {
      return res.status(400).json({ error: "El carrito está vacío" });
    }

    const lotes = leerLotes();

    // kg necesarios por lote en este pedido (varias líneas pueden compartir el mismo lote)
    const kgNecesariosPorLote = {};

    const lineItems = carrito.map(item => {
      const lote = lotes[item.lote];

      if (!lote || lote.estado !== "activo") {
        throw new Error(`El lote "${item.lote}" ya no está disponible`);
      }

      const precioUnitario = Number(lote.precios[item.peso]);

      if (!Number.isFinite(precioUnitario)) {
        throw new Error(`El formato de ${item.peso} g no existe para el lote "${item.lote}"`);
      }

      const cantidad = Number(item.cantidad);

      if (!Number.isFinite(cantidad) || cantidad < 1) {
        throw new Error(`Cantidad inválida para el lote "${item.lote}"`);
      }

      const kgLinea = (Number(item.peso) / 1000) * cantidad;
      kgNecesariosPorLote[item.lote] = (kgNecesariosPorLote[item.lote] || 0) + kgLinea;

      return {
        price_data: {
          currency: "eur",
          product_data: {
            name: item.nombre,
            description: `Lote ${lote.codigo} · ${lote.proceso} · ${item.peso} g · ${item.molienda} · ${item.tueste}`
          },
          unit_amount: Math.round(precioUnitario * 100)
        },
        quantity: cantidad
      };
    });

    for (const codigoLote of Object.keys(kgNecesariosPorLote)) {
      const lote = lotes[codigoLote];

      if (kgNecesariosPorLote[codigoLote] > lote.stockKg + 1e-9) {
        return res.status(409).json({
          error: `No hay stock suficiente del lote "${codigoLote}". Disponible: ${lote.stockKg} kg.`
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: "https://cafedmedina-web.onrender.com/success.html",
      cancel_url: "https://cafedmedina-web.onrender.com/cancel.html",
      shipping_address_collection: {
        allowed_countries: ["ES"]
      },
      phone_number_collection: {
        enabled: true
      }
    });

    // Reservamos el stock al crear la sesión de pago (no espera confirmación de Stripe)
    for (const codigoLote of Object.keys(kgNecesariosPorLote)) {
      lotes[codigoLote].stockKg = Number((lotes[codigoLote].stockKg - kgNecesariosPorLote[codigoLote]).toFixed(3));
      lotes[codigoLote].stockVendidoKg = Number(((lotes[codigoLote].stockVendidoKg || 0) + kgNecesariosPorLote[codigoLote]).toFixed(3));

      if (lotes[codigoLote].stockKg <= 0) {
        lotes[codigoLote].estado = "agotado";
      }
    }
    guardarLotes(lotes);

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

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

//-------------------------------------------------------------------------------------------------ABRE - TABLA DE PRECIOS PRIVADA--------------------------------------------------------------------------------------------//

const PRECIOS_FILE = path.join(__dirname, "data", "precios.json");
const PROCESOS_VALIDOS = ["lavado", "honey", "natural"];
const PESOS_VALIDOS = ["250", "500", "1000"];

function leerPrecios() {
  const raw = fs.readFileSync(PRECIOS_FILE, "utf-8");
  return JSON.parse(raw);
}

function guardarPrecios(datos) {
  fs.writeFileSync(PRECIOS_FILE, JSON.stringify(datos, null, 2));
}

function requiereAdmin(req, res, next) {
  const token = req.get("x-admin-token");

  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }

  next();
}

app.get("/api/precios", (req, res) => {
  try {
    res.json(leerPrecios());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron leer los precios" });
  }
});

app.put("/api/precios", requiereAdmin, (req, res) => {
  try {
    const datos = req.body;

    for (const proceso of PROCESOS_VALIDOS) {
      const entrada = datos[proceso];

      if (!entrada || typeof entrada.lote !== "string" || !entrada.lote.trim()) {
        return res.status(400).json({ error: `Falta el lote de "${proceso}"` });
      }

      for (const peso of PESOS_VALIDOS) {
        const precio = Number(entrada.precios && entrada.precios[peso]);

        if (!Number.isFinite(precio) || precio <= 0) {
          return res.status(400).json({ error: `Precio inválido en "${proceso}" / ${peso}g` });
        }
      }
    }

    guardarPrecios(datos);
    res.json({ success: true, precios: datos });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "No se pudieron guardar los precios" });
  }
});

//-------------------------------------------------------------------------------------------------CIERRA - TABLA DE PRECIOS PRIVADA--------------------------------------------------------------------------------------------//

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

    const lineItems = carrito.map(item => ({
      price_data: {
        currency: "eur",
        product_data: {
          name: item.nombre,
          description: `${item.peso} g · ${item.proceso} · ${item.molienda} · ${item.tostion}`
        },
        unit_amount: Math.round(item.precio * 100)
      },
      quantity: item.cantidad
    }));

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

    res.json({ id: session.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error creando el pago" });
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

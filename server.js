const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();

app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());

//-------------------------------------------------------------------------------------------------ABRE - STRIPE TEST--------------------------------------------------------------------------------------------//
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
//-------------------------------------------------------------------------------------------------CIERRA - STRIPE TEST--------------------------------------------------------------------------------------------//

//-------------------------------------------------------------------------------------------------ABRE - EMAIL IONOS--------------------------------------------------------------------------------------------//
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
//-------------------------------------------------------------------------------------------------CIERRA - EMAIL IONOS--------------------------------------------------------------------------------------------//


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

    await transporter.sendMail({
      from: `"Café D'Medina" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER,
      replyTo: email,
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

    res.status(200).json({ success: true });

  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "Error enviando email" });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Tienda funcionando en puerto ${PORT}`);
});

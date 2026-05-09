const express = require("express");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());



//TEST
const stripe = Stripe("sk_test_51TUB833gq8inlL2zCJNSzI24FlD5k6lnVsgYqwgEkdF5R3jvPMBmjNh5HYgCeAT70g1BGJNoDrrRrHRxRUIfehq700T3HNrbM1");

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
      //success_url: "http://localhost:3000/success.html",//
      //cancel_url: "http://localhost:3000/cancel.html",//
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

app.use(express.static("."));

app.listen(3000, () => {
  //console.log("Tienda funcionando en http://localhost:3000/tienda.html");//
  console.log("Tienda funcionando en https://cafedmedina-web.onrender.com/tienda.html");
});

const endpointSecret = "whsec_TU_WEBHOOK_SECRET";

app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  } catch (err) {
    console.log("Error webhook:", err.message);
    return response.sendStatus(400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    console.log("💰 Pago completado");
    console.log("Email cliente:", session.customer_details.email);
    console.log("Total:", session.amount_total / 100 + "€");
  }

  response.json({received: true});
});


//const endpointSecret = "whsec_TU_WEBHOOK_SECRET";

//app.post('/webhook', express.raw({type: 'application/json'}), (request, response) => {
  //const sig = request.headers['stripe-signature'];

 // let event;

  //try {
   // event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
  //} catch (err) {
   // console.log("Error webhook:", err.message);
   // return response.sendStatus(400);
  //}

 // if (event.type === 'checkout.session.completed') {
   // const session = event.data.object;

    //console.log("💰 Pago completado");
   // console.log("Email cliente:", session.customer_details.email);
    //console.log("Total:", session.amount_total / 100 + "€");
 // }

  //response.json({received: true});
//});
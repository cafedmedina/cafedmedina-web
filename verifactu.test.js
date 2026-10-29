// Pruebas del módulo VERI*FACTU con los ejemplos de la especificación de la AEAT: node verifactu.test.js
const assert = require("assert");
const vf = require("./verifactu");

// Ejemplo 1 de la especificación de huella (primer registro de alta)
assert.strictEqual(vf.huellaAlta({
  nifEmisor: "89890001K", numSerie: "12345678/G33", fechaExpedicion: "01-01-2024", tipoFactura: "F1",
  cuotaTotal: 1235, importeTotal: 12345, huellaAnterior: "", marcaTemporal: "2024-01-01T19:20:30+01:00"
}), "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60");

// Formatos
assert.strictEqual(vf.importe(12345), "123.45");
assert.strictEqual(vf.importe(-5), "-0.05");
assert.strictEqual(vf.importe(100), "1.00");
assert.strictEqual(vf.aCentimos(58.18), 5818);
assert.strictEqual(vf.aCentimos(0.29 * 3), 87);
assert.strictEqual(vf.fechaMadrid(new Date("2026-10-27T23:30:00Z")), "28-10-2026"); // ya es día 28 en Madrid
assert.strictEqual(vf.marcaTemporal(new Date("2026-07-01T10:00:00Z")), "2026-07-01T12:00:00+02:00");
assert.strictEqual(vf.marcaTemporal(new Date("2026-12-01T10:00:00Z")), "2026-12-01T11:00:00+01:00");

// QR: los valores van codificados en la URL
assert.strictEqual(
  vf.urlQR({ nifEmisor: "89890001K", numSerie: "12345678&G33", fechaExpedicion: "01-01-2024", importeTotal: 24140, entorno: "pruebas" }),
  "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.40"
);

// Registro de alta: la huella del XML es la calculada y se encadena con el anterior
const sistema = { nombreRazon: "Empresa & Cía", nif: "B05653621", nombre: "AURINEGRA", id: "AU", version: "1.0", numeroInstalacion: "1" };
const alta = vf.registroAlta({
  nifEmisor: "B05653621", nombreEmisor: "D’Medina Global Trade, S.L.", numSerie: "FACT-2027-0001",
  fechaExpedicion: "02-01-2027", tipoFactura: "F1", descripcion: "Venta de café",
  destinatario: { nombre: "Ana López", nif: "12345678Z" },
  desglose: [{ tipo: 10, base: 5818, cuota: 582 }, { tipo: 21, base: 413, cuota: 87 }],
  cuotaTotal: 669, importeTotal: 6900, anterior: { nifEmisor: "B05653621", numSerie: "FACT-2026-0099", fechaExpedicion: "31-12-2026", huella: "ABC" },
  sistema, marcaTemporal: "2027-01-02T10:00:00+01:00"
});
assert.match(alta.xml, new RegExp(`<sum1:Huella>${alta.huella}</sum1:Huella>`));
assert.match(alta.xml, /<sum1:RegistroAnterior>.*<sum1:Huella>ABC<\/sum1:Huella>/);
assert.match(alta.xml, /<sum1:TipoImpositivo>10.00<\/sum1:TipoImpositivo><sum1:BaseImponibleOimporteNoSujeto>58.18/);
assert.match(alta.xml, /Empresa &amp; Cía/);
// Orden de elementos exigido por el XSD
const orden = ["IDVersion", "IDFactura", "NombreRazonEmisor", "TipoFactura", "DescripcionOperacion", "Destinatarios",
  "Desglose", "CuotaTotal", "ImporteTotal", "Encadenamiento", "SistemaInformatico", "FechaHoraHusoGenRegistro", "TipoHuella", "Huella"];
// (Huella aparece también dentro de Encadenamiento: la propia del registro es la última)
const posiciones = orden.map(n => n === "Huella" ? alta.xml.lastIndexOf(`<sum1:${n}>`) : alta.xml.indexOf(`<sum1:${n}>`));
assert.deepStrictEqual([...posiciones].sort((a, b) => a - b), posiciones, "orden de elementos del RegistroAlta");

// Respuesta de la AEAT
const respuesta = vf.interpretarRespuesta(`<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>
<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="r" xmlns:tik="s"><tikR:CSV>A-1</tikR:CSV>
<tikR:TiempoEsperaEnvio>120</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>ParcialmenteCorrecto</tikR:EstadoEnvio>
<tikR:RespuestaLinea><tikR:IDFactura><tik:NumSerieFactura>FACT-2027-0001</tik:NumSerieFactura></tikR:IDFactura>
<tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion><tikR:EstadoRegistro>Correcto</tikR:EstadoRegistro></tikR:RespuestaLinea>
<tikR:RespuestaLinea><tikR:IDFactura><tik:NumSerieFactura>FACT-2027-0002</tik:NumSerieFactura></tikR:IDFactura>
<tikR:Operacion><tik:TipoOperacion>Alta</tik:TipoOperacion></tikR:Operacion><tikR:EstadoRegistro>Incorrecto</tikR:EstadoRegistro>
<tikR:CodigoErrorRegistro>1104</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>NumSerie &amp; mal</tikR:DescripcionErrorRegistro></tikR:RespuestaLinea>
</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>`);
assert.strictEqual(respuesta.esperaSegundos, 120);
assert.strictEqual(respuesta.lineas.length, 2);
assert.deepStrictEqual([respuesta.lineas[1].estado, respuesta.lineas[1].codigoError, respuesta.lineas[1].error], ["Incorrecto", "1104", "NumSerie & mal"]);
assert.throws(() => vf.interpretarRespuesta("<Envelope><Body><Fault><faultcode>env:Client</faultcode><faultstring>Certificado no válido</faultstring></Fault></Body></Envelope>"), /Certificado no válido/);

console.log("verifactu: todas las pruebas correctas");

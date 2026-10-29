// VERI*FACTU: registros de facturación (RD 1007/2023 y Orden HAC/1177/2024).
//
// Este módulo no guarda nada: calcula la huella encadenada, construye el XML de los registros
// y del envío, lo remite al servicio web de la AEAT con el certificado de la empresa, interpreta
// la respuesta y genera la URL del código QR. El encadenamiento y la cola viven en server.js (Redis).

const crypto = require("crypto");
const https = require("https");

const NS_LR = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd";
const NS_SF = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

const RUTA_SOAP = "/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP";
const ENDPOINTS = {
  pruebas: "https://prewww1.aeat.es" + RUTA_SOAP,
  produccion: "https://www1.agenciatributaria.gob.es" + RUTA_SOAP
};
const HOSTS_QR = {
  pruebas: "https://prewww2.aeat.es",
  produccion: "https://www2.agenciatributaria.gob.es"
};

const MAX_REGISTROS_POR_ENVIO = 1000;
const ESPERA_POR_DEFECTO_S = 60;
const ZONA = "Europe/Madrid";

//-------------------------------------------------------------------------------------------------FORMATOS--------------------------------------------------------------------------------------------//

// Importe en céntimos (entero) -> "1234.50". La huella y el XML deben llevar exactamente el mismo texto.
function importe(centimos) {
  if (!Number.isInteger(centimos)) throw new Error(`Importe en céntimos no entero: ${centimos}`);
  const signo = centimos < 0 ? "-" : "";
  const abs = Math.abs(centimos);
  return `${signo}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// Euros (número con decimales) -> céntimos, redondeando mitades hacia fuera.
function aCentimos(euros) {
  const n = Number(euros);
  if (!Number.isFinite(n)) throw new Error(`Importe no válido: ${euros}`);
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7);
}

function porcentaje(tipo) {
  return Number(tipo).toFixed(2);
}

function partesMadrid(fecha) {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset"
  }).formatToParts(fecha);
  return Object.fromEntries(partes.map(p => [p.type, p.value]));
}

// Fecha de expedición en hora de Madrid: "29-10-2026".
function fechaMadrid(fecha = new Date()) {
  const p = partesMadrid(fecha);
  return `${p.day}-${p.month}-${p.year}`;
}

// FechaHoraHusoGenRegistro: "2026-10-29T19:20:30+01:00" (hora de Madrid con su desfase).
function marcaTemporal(fecha = new Date()) {
  const p = partesMadrid(fecha);
  const desfase = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${desfase}`;
}

function escaparXml(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function el(nombre, contenido) {
  return `<sum1:${nombre}>${contenido}</sum1:${nombre}>`;
}

function txt(nombre, valor) {
  return el(nombre, escaparXml(valor));
}

//-------------------------------------------------------------------------------------------------HUELLA--------------------------------------------------------------------------------------------//

function sha256(cadena) {
  return crypto.createHash("sha256").update(cadena, "utf8").digest("hex").toUpperCase();
}

function huellaAlta(r) {
  return sha256([
    `IDEmisorFactura=${r.nifEmisor.trim()}`,
    `NumSerieFactura=${r.numSerie.trim()}`,
    `FechaExpedicionFactura=${r.fechaExpedicion.trim()}`,
    `TipoFactura=${r.tipoFactura.trim()}`,
    `CuotaTotal=${importe(r.cuotaTotal)}`,
    `ImporteTotal=${importe(r.importeTotal)}`,
    `Huella=${(r.huellaAnterior || "").trim()}`,
    `FechaHoraHusoGenRegistro=${r.marcaTemporal.trim()}`
  ].join("&"));
}

function huellaAnulacion(r) {
  return sha256([
    `IDEmisorFacturaAnulada=${r.nifEmisor.trim()}`,
    `NumSerieFacturaAnulada=${r.numSerie.trim()}`,
    `FechaExpedicionFacturaAnulada=${r.fechaExpedicion.trim()}`,
    `Huella=${(r.huellaAnterior || "").trim()}`,
    `FechaHoraHusoGenRegistro=${r.marcaTemporal.trim()}`
  ].join("&"));
}

//-------------------------------------------------------------------------------------------------XML DE LOS REGISTROS--------------------------------------------------------------------------------------------//

// anterior: null si es el primer registro del sistema, o { nifEmisor, numSerie, fechaExpedicion, huella }.
function xmlEncadenamiento(anterior) {
  if (!anterior) return el("Encadenamiento", el("PrimerRegistro", "S"));
  return el("Encadenamiento", el("RegistroAnterior",
    txt("IDEmisorFactura", anterior.nifEmisor) +
    txt("NumSerieFactura", anterior.numSerie) +
    txt("FechaExpedicionFactura", anterior.fechaExpedicion) +
    txt("Huella", anterior.huella)
  ));
}

// sistema: { nombreRazon, nif, nombre, id, version, numeroInstalacion }
function xmlSistemaInformatico(s) {
  return el("SistemaInformatico",
    txt("NombreRazon", s.nombreRazon) +
    txt("NIF", s.nif) +
    txt("NombreSistemaInformatico", s.nombre) +
    txt("IdSistemaInformatico", s.id) +
    txt("Version", s.version) +
    txt("NumeroInstalacion", s.numeroInstalacion) +
    txt("TipoUsoPosibleSoloVerifactu", "S") +
    txt("TipoUsoPosibleMultiOT", "N") +
    txt("IndicadorMultiplesOT", "N")
  );
}

// destinatario: { nombre, nif } (España) o { nombre, pais, idType, id } (extranjero: IDType 02 = NIF-IVA)
function xmlDestinatario(d) {
  const id = d.nif
    ? txt("NIF", d.nif)
    : el("IDOtro", txt("CodigoPais", d.pais) + txt("IDType", d.idType || "02") + txt("ID", d.id));
  return el("Destinatarios", el("IDDestinatario", txt("NombreRazon", d.nombre) + id));
}

// linea: { tipo, base, cuota, tipoRE?, cuotaRE?, exencion?, claveRegimen? } (importes en céntimos)
function xmlDetalle(l) {
  let xml = txt("Impuesto", "01") + txt("ClaveRegimen", l.claveRegimen || "01");
  if (l.exencion) {
    xml += txt("OperacionExenta", l.exencion) + txt("BaseImponibleOimporteNoSujeto", importe(l.base));
  } else {
    xml += txt("CalificacionOperacion", "S1") +
      txt("TipoImpositivo", porcentaje(l.tipo)) +
      txt("BaseImponibleOimporteNoSujeto", importe(l.base)) +
      txt("CuotaRepercutida", importe(l.cuota));
    if (l.cuotaRE) {
      xml += txt("TipoRecargoEquivalencia", porcentaje(l.tipoRE)) + txt("CuotaRecargoEquivalencia", importe(l.cuotaRE));
    }
  }
  return el("DetalleDesglose", xml);
}

// Datos completos de una factura emitida -> { huella, xml } del RegistroAlta.
function registroAlta(r) {
  const huella = huellaAlta(r);
  let xml = txt("IDVersion", "1.0") +
    el("IDFactura", txt("IDEmisorFactura", r.nifEmisor) + txt("NumSerieFactura", r.numSerie) +
      txt("FechaExpedicionFactura", r.fechaExpedicion)) +
    txt("NombreRazonEmisor", r.nombreEmisor);
  if (r.subsanacion) xml += txt("Subsanacion", "S");
  xml += txt("TipoFactura", r.tipoFactura);
  if (r.tipoFactura.startsWith("R")) {
    xml += txt("TipoRectificativa", r.tipoRectificativa || "I");
    xml += el("FacturasRectificadas", (r.facturasRectificadas || []).map(f =>
      el("IDFacturaRectificada", txt("IDEmisorFactura", r.nifEmisor) + txt("NumSerieFactura", f.numSerie) +
        txt("FechaExpedicionFactura", f.fechaExpedicion))).join(""));
  }
  xml += txt("DescripcionOperacion", String(r.descripcion).slice(0, 500));
  if (r.destinatario) xml += xmlDestinatario(r.destinatario);
  xml += el("Desglose", r.desglose.map(xmlDetalle).join("")) +
    txt("CuotaTotal", importe(r.cuotaTotal)) +
    txt("ImporteTotal", importe(r.importeTotal)) +
    xmlEncadenamiento(r.anterior) +
    xmlSistemaInformatico(r.sistema) +
    txt("FechaHoraHusoGenRegistro", r.marcaTemporal) +
    txt("TipoHuella", "01") +
    txt("Huella", huella);
  return { huella, xml: el("RegistroAlta", xml) };
}

function registroAnulacion(r) {
  const huella = huellaAnulacion(r);
  const xml = txt("IDVersion", "1.0") +
    el("IDFactura", txt("IDEmisorFacturaAnulada", r.nifEmisor) + txt("NumSerieFacturaAnulada", r.numSerie) +
      txt("FechaExpedicionFacturaAnulada", r.fechaExpedicion)) +
    xmlEncadenamiento(r.anterior) +
    xmlSistemaInformatico(r.sistema) +
    txt("FechaHoraHusoGenRegistro", r.marcaTemporal) +
    txt("TipoHuella", "01") +
    txt("Huella", huella);
  return { huella, xml: el("RegistroAnulacion", xml) };
}

function sobreEnvio(obligado, registrosXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sum="${NS_LR}" xmlns:sum1="${NS_SF}">` +
    `<soapenv:Header/><soapenv:Body><sum:RegFactuSistemaFacturacion>` +
    `<sum:Cabecera>${el("ObligadoEmision", txt("NombreRazon", obligado.nombreRazon) + txt("NIF", obligado.nif))}</sum:Cabecera>` +
    registrosXml.map(x => `<sum:RegistroFactura>${x}</sum:RegistroFactura>`).join("") +
    `</sum:RegFactuSistemaFacturacion></soapenv:Body></soapenv:Envelope>`;
}

//-------------------------------------------------------------------------------------------------ENVÍO Y RESPUESTA--------------------------------------------------------------------------------------------//

// Lectura sencilla por nombre de etiqueta, sin importar el prefijo de namespace que use la AEAT.
function etiqueta(xml, nombre) {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`));
  return m ? m[1].trim() : null;
}

function etiquetas(xml, nombre) {
  const re = new RegExp(`<(?:[\\w-]+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`, "g");
  return [...xml.matchAll(re)].map(m => m[1]);
}

function desescaparXml(texto) {
  return String(texto ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function interpretarRespuesta(xml) {
  const fallo = etiqueta(xml, "Fault");
  if (fallo !== null) {
    const error = new Error(`La AEAT rechazó el envío: ${desescaparXml(etiqueta(fallo, "faultstring") || fallo)}`);
    error.reintentable = /Server/i.test(etiqueta(fallo, "faultcode") || "");
    throw error;
  }
  const estadoEnvio = etiqueta(xml, "EstadoEnvio");
  if (!estadoEnvio) throw Object.assign(new Error("Respuesta de la AEAT no reconocida"), { reintentable: true });
  return {
    estadoEnvio,
    csv: etiqueta(xml, "CSV"),
    esperaSegundos: Number(etiqueta(xml, "TiempoEsperaEnvio")) || ESPERA_POR_DEFECTO_S,
    lineas: etiquetas(xml, "RespuestaLinea").map(linea => {
      const duplicado = etiqueta(linea, "RegistroDuplicado");
      return {
        numSerie: desescaparXml(etiqueta(linea, "NumSerieFactura")),
        operacion: etiqueta(linea, "TipoOperacion"),
        estado: etiqueta(linea, "EstadoRegistro"),
        codigoError: etiqueta(linea, "CodigoErrorRegistro"),
        error: desescaparXml(etiqueta(linea, "DescripcionErrorRegistro")),
        estadoDuplicado: duplicado ? etiqueta(duplicado, "EstadoRegistroDuplicado") : null
      };
    })
  };
}

// certificado: { pfx: Buffer, passphrase }
function enviar(xml, { entorno, certificado }) {
  const url = new URL(ENDPOINTS[entorno] || ENDPOINTS.pruebas);
  const cuerpo = Buffer.from(xml, "utf8");
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "POST",
      pfx: certificado.pfx, passphrase: certificado.passphrase,
      headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": '""', "Content-Length": cuerpo.length },
      timeout: 60000
    }, res => {
      const partes = [];
      res.on("data", p => partes.push(p));
      res.on("end", () => {
        const texto = Buffer.concat(partes).toString("utf8");
        if (res.statusCode === 200 || res.statusCode === 500) {
          try { resolve(interpretarRespuesta(texto)); } catch (error) { reject(error); }
        } else {
          reject(Object.assign(new Error(`La AEAT respondió HTTP ${res.statusCode}` +
            (res.statusCode === 401 || res.statusCode === 403 ? " (revisa el certificado)" : "")), { reintentable: res.statusCode >= 500 }));
        }
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("La AEAT no respondió a tiempo"), { reintentable: true })));
    req.on("error", error => reject(Object.assign(error, { reintentable: error.reintentable ?? true })));
    req.end(cuerpo);
  });
}

//-------------------------------------------------------------------------------------------------CÓDIGO QR--------------------------------------------------------------------------------------------//

function urlQR({ nifEmisor, numSerie, fechaExpedicion, importeTotal, entorno }) {
  const params = { nif: nifEmisor, numserie: numSerie, fecha: fechaExpedicion, importe: importe(importeTotal) };
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${HOSTS_QR[entorno] || HOSTS_QR.pruebas}/wlpl/TIKE-CONT/ValidarQR?${query}`;
}

module.exports = {
  MAX_REGISTROS_POR_ENVIO, ESPERA_POR_DEFECTO_S,
  importe, aCentimos, fechaMadrid, marcaTemporal,
  huellaAlta, huellaAnulacion, registroAlta, registroAnulacion, sobreEnvio,
  interpretarRespuesta, enviar, urlQR
};

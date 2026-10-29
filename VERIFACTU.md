# VERI*FACTU en la web de AURINEGRA

Desde el **1 de enero de 2027** (RD-ley 15/2025, sociedades), todas las facturas de D’Medina Global Trade, S.L. deben emitirse con un sistema de facturación que cumpla el RD 1007/2023 y la Orden HAC/1177/2024. El sistema de facturación es este servidor (`server.js` + `verifactu.js`):

- **Tienda online**: cada pago confirmado en Stripe genera la factura `FACT-AAAA-NNNN`.
- **Mayoristas**: el ERP pide la factura a `POST /api/facturas-erp` y la web la numera `FM-AAAA-NNNN`.

Cada factura genera un **registro de alta** con huella SHA-256 encadenada a la anterior. Hay una única cadena para todas las series. Los registros se guardan en Redis y se envían a la AEAT desde una cola. Si la AEAT no responde, se reintentan solos, y una venta nunca se bloquea porque la AEAT esté caída. En producción, el PDF lleva al principio el **código QR** de cotejo con la leyenda «VERI*FACTU».

Mientras `VERIFACTU_ACTIVO` no valga `1`, la web funciona exactamente como antes.

## 1. Subir el código

Sube a GitHub y espera a que Render despliegue:

- `server.js` (modificado)
- `verifactu.js` (nuevo)
- `verifactu.test.js` (nuevo, pruebas: `node verifactu.test.js`)
- `package.json` y `package-lock.json` (nueva dependencia `qrcode`)

Con `VERIFACTU_ACTIVO` sin definir no cambia nada visible. Sí cambia una cosa: la fecha de las facturas se imprime en hora de Madrid. Antes, una compra entre medianoche y la 1-2 de la mañana salía con la fecha del día anterior.

## 2. Certificado electrónico en Render

1. En Render → el servicio → **Environment** → **Secret Files**, añade el archivo `.p12`/`.pfx` de la empresa con el nombre `certificado.p12`. Quedará en `/etc/secrets/certificado.p12`.
2. Añade estas variables de entorno:

| Variable | Valor |
|---|---|
| `VERIFACTU_CERT_PATH` | `/etc/secrets/certificado.p12` |
| `VERIFACTU_CERT_PASSWORD` | la contraseña del certificado |

> Si al enviar aparece un error tipo *"unsupported"* o *"mac verify failure"*, el `.p12` usa un cifrado antiguo que Node 20 ya no admite. Vuelve a exportarlo con OpenSSL 3:
> `openssl pkcs12 -legacy -in original.p12 -nodes -out temporal.pem`
> `openssl pkcs12 -export -in temporal.pem -out certificado.p12`
> Después borra `temporal.pem`, porque contiene la clave privada sin cifrar.

## 3. Pruebas con la AEAT (noviembre-diciembre 2026)

| Variable | Valor |
|---|---|
| `VERIFACTU_ACTIVO` | `1` |
| `VERIFACTU_ENTORNO` | `pruebas` |

Con esto, cada factura se registra y se envía al **entorno de pruebas** de la AEAT, que no tiene validez fiscal. Las facturas de los clientes salen **sin QR**, igual que ahora.

Para comprobarlo:

1. Haz una compra de prueba o emite una factura de mayorista desde el ERP.
2. En el ERP abre **VERI*FACTU**. Los registros deben pasar de «En cola» a **Correcto** en uno o dos minutos.
3. Si salen como **Incorrecto**, el error de la AEAT indica el campo que falla. Revísalo antes de pasar a producción.

La cadena de pruebas y la de producción van separadas en Redis. Las pruebas no contaminan la cadena real.

## 4. Paso a producción (1 de enero de 2027)

Cambia `VERIFACTU_ENTORNO` a `produccion` y vuelve a desplegar. La primera factura de producción abre su propia cadena. Desde entonces:

- Las facturas llevan el QR y la leyenda VERI*FACTU.
- «Iniciar operación» del admin queda bloqueado: con VERI*FACTU no se pueden borrar facturas ni reiniciar contadores.
- Una factura expedida por error se **anula** desde el ERP (VERI*FACTU → Anular). Una factura correcta que hay que corregir se **rectifica**: el sistema ya admite los tipos R1-R5, pero falta la pantalla en el ERP.

> **Importante:** quien opta por VERI*FACTU debe mantenerlo todo el año natural. Activa producción el 1/1/2027, no antes, salvo que la asesoría indique otra cosa.

## 5. Plan de Render

El plan gratuito de Render **duerme el servidor** tras 15 minutos sin visitas. Mientras duerme, la cola no se envía hasta la siguiente visita o pago. La AEAT acepta esos registros, pero con el aviso de que la fecha de generación no es la actual. Para enviar al momento, usa un plan de pago (Starter) desde el paso 4.

## 6. Declaración responsable del sistema informático

El productor del sistema es la propia empresa, porque el software se ha desarrollado para su propio uso. Por eso tiene que firmar una **declaración responsable** (art. 13 RD 1007/2023 y art. 15 Orden HAC/1177/2024) y tenerla disponible. Plantilla para revisar con la asesoría:

---

**DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN**

1. **Nombre del sistema**: AURINEGRA FACTURACION
2. **Código identificador del sistema (IdSistemaInformatico)**: AU
3. **Versión**: 1.0
4. **Componentes y funcionalidades**:
   - Servidor web Node.js (`server.js`, `verifactu.js`) alojado en Render, con base de datos Upstash Redis. Emite y numera las facturas de la tienda online (serie FACT) y de clientes mayoristas (serie FM), genera los registros de facturación con huella SHA-256 encadenada, los remite a la AEAT por servicio web y genera el código QR.
   - Aplicación ERP local (Python/Flask) que prepara las facturas de mayoristas y las solicita al servidor. El ERP no numera ni registra facturas.
5. **Tipo de uso**: exclusivamente como sistema VERI*FACTU (TipoUsoPosibleSoloVerifactu = S). No multiusuario (TipoUsoPosibleMultiOT = N); un único obligado tributario.
6. **Productor**: D’Medina Global Trade, S.L., NIF B05653621, Calle San Pedro del Pinatar, 24, 28939 Arroyomolinos (Madrid).
7. **Declaración**: el productor declara que este sistema informático cumple lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, General Tributaria, en el Reglamento aprobado por el Real Decreto 1007/2023, de 5 de diciembre, y en la Orden HAC/1177/2024, de 17 de octubre, y en sus especificaciones técnicas.
8. **Fecha y lugar**: ____________________, a ___ de __________ de 20__

Firma: ______________________ (representante legal)

---

## Referencia técnica

- Huella de alta: `IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=DD-MM-AAAA&TipoFactura=…&CuotaTotal=0.00&ImporteTotal=0.00&Huella=<anterior>&FechaHoraHusoGenRegistro=AAAA-MM-DDThh:mm:ss+01:00`, en SHA-256 hexadecimal y mayúsculas. Se ha verificado con el ejemplo oficial de la AEAT en `verifactu.test.js`.
- Servicio web: `https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`. En pruebas: `https://prewww1.aeat.es/...`.
- QR: `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=…&numserie=…&fecha=…&importe=…`, de 35 mm y con nivel de corrección M.
- Endpoints de administración (cabecera `x-admin-token`):
  - `GET /api/verifactu/estado`
  - `POST /api/verifactu/enviar`
  - `POST /api/verifactu/anular` (`{ "numero": "…" }`)
  - `POST /api/facturas-erp`

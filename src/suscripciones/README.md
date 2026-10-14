# `suscripciones`

## 1. Propósito

Modelo de datos y lógica base de la suscripción mensual (prueba gratis de 14 días, después pago por
Google Play). Es dueño exclusivo de las tablas `suscripciones`, `compras`, `pagos_historial` y
`eventos_tienda`. El plan completo por etapas vive en `docs/suscripcion/flujo_suscripcion.md` (histórico, versionado
en git); el contrato con el frontend está en `src/features/suscripcion/README.md` del repo
`c:\dev\ticket` y en `src/shared/api/suscripcion.ts`.

**Estado: etapa 6 de 6, cierre para producción (RTDN de Google Play por Pub/Sub push; compra con el verificador REAL de Google Play, el modo simulado se conserva para desarrollo y tests).** Existen las tablas, las entidades, la prueba de 14 días (cuentas nuevas y
existentes), el estado efectivo, `SuscripcionesService.snapshot()` con el historial real,
`GET /me/suscripcion` y el campo opcional `suscripcion` en auth (login, register y `GET /me`).
Desde la etapa 3 el servidor **bloquea** (403 `SUSCRIPCION_REQUERIDA`) `POST /tickets` y
`POST/PATCH/DELETE /productos` con la suscripción no activa. Desde la etapa 4a existen
`POST /me/suscripcion/validar-compra` y `POST /me/suscripcion/restaurar`, validados por un verificador
**simulado** (por defecto) o, con `VALIDACION_TIENDA=google`, por el **real** (etapa 4b: Google Play
Developer API, acknowledge real, `cuenta_ofuscada` por HMAC y monto real). Desde la etapa 5 existe
`POST /tienda/google/rtdn` (notificaciones RTDN de Google Play): ver la sección 2.5.

## 2. Estructura real

```
src/suscripciones/
├── suscripciones.module.ts        # forFeature de las 4 entidades; registra el controller; exporta SuscripcionesService y SuscripcionActivaGuard
├── suscripciones.controller.ts    # GET /me/suscripcion, POST /me/suscripcion/validar-compra y /restaurar
├── suscripciones.service.ts       # crearPrueba(), snapshot(), estaBloqueada(), assertPuedeEscribir(), obtenerFila() (pública), historial() (privado), MAX_HISTORIAL
├── compra-suscripcion.service.ts  # CompraSuscripcionService: validarCompra(), restaurarCompras(), procesarCompra() (privado); MENSAJE_*
├── config-suscripcion.ts          # leerConfigSuscripcion() (pura, fail-fast), CONFIG_SUSCRIPCION
├── rtdn/                          # Etapa 5 (ver 2.5)
│   ├── rtdn.controller.ts         # POST /tienda/google/rtdn (sin JwtAuthGuard, @SkipThrottle)
│   ├── rtdn.service.ts            # idempotencia, re-consulta a Google, localización de la compra, aplicación del estado
│   ├── rtdn.types.ts              # SobrePubSub (interface), decodificarMensaje(), nombres de tipo, huellaToken()
│   ├── transicion.ts              # transicionDesdeGoogle(): función PURA con la tabla de transiciones
│   ├── pubsub-auth.ts             # VERIFICADOR_PUSH, VerificadorPushOidc, VerificadorPushDesactivado
│   ├── fuente-estado-google.ts    # FUENTE_ESTADO_GOOGLE, FuenteEstadoReal, FuenteEstadoSimulada
│   └── reconciliacion.service.ts  # ReconciliacionService: revisión de respaldo (F6)
├── cuenta-ofuscada.ts             # calcularCuentaOfuscada() (HMAC-SHA256 hex, pura), CuentaOfuscadaService (exportado)
├── dto/                           # ValidarCompraDto, RestaurarComprasDto, CompraRestaurarDto
├── verificadores/
│   ├── verificador-tienda.interface.ts  # VerificadorTienda, ResultadoVerificacion, VERIFICADOR_TIENDA
│   ├── verificador-simulado.ts          # VerificadorSimulado (por prefijo del token), MONTO_SIMULADO, MONEDA_SIMULADA
│   ├── verificador-google.ts            # VerificadorGoogle (etapa 4b), MENSAJE_TIENDA_NO_DISPONIBLE, dineroANumero()
│   └── google-play-api.ts               # GooglePlayApi (interfaz mockeable) y GooglePlayApiReal (@googleapis/androidpublisher)
├── bloqueo.ts                     # MENSAJE_SUSCRIPCION_REQUERIDA, ESTADOS_BLOQUEADOS, esEstadoBloqueado(): funciones puras
├── guards/
│   └── suscripcion-activa.guard.ts  # SuscripcionActivaGuard (va siempre DESPUÉS de JwtAuthGuard)
├── estado-efectivo.ts             # estadoEfectivo(fila, ahora): función pura (tabla 1.3 del plan)
├── fechas.ts                      # aIsoNegocio, finDePrueba, periodoNegocio, sumarUnMesNegocio, ZONA_NEGOCIO_OFFSET_MIN
├── entities/
│   ├── suscripcion.entity.ts
│   ├── compra.entity.ts
│   ├── pago-historial.entity.ts
│   └── evento-tienda.entity.ts
└── interfaces/
    └── suscripcion-response.interface.ts   # SuscripcionSnapshot y tipos (contrato con el frontend)
```

`SuscripcionesModule` no importa `AuthModule` (lo hace al revés: `AuthModule` importa
`SuscripcionesModule`, y lo contrario crearía un ciclo). `SuscripcionesController` usa `JwtAuthGuard`
y `@CurrentUser()` importándolos por archivo, igual que `ProductosController`. Lo consume
`AuthService`: `register()` (`crearPrueba`, en la misma transacción que el alta del usuario) y
`login()`/`register()`/`toMeResponse()` (`snapshot`).

Tests: `fechas.spec.ts`, `estado-efectivo.spec.ts`, `suscripciones.service.spec.ts`,
`suscripciones.controller.spec.ts`, `bloqueo.spec.ts`, `guards/suscripcion-activa.guard.spec.ts`
(unitarios, sin BD), `test/suscripcion-prueba.e2e-spec.ts`, `test/suscripcion-lectura.e2e-spec.ts` y
`test/suscripcion-bloqueo.e2e-spec.ts` (Postgres real). Etapa 4a: `config-suscripcion.spec.ts`,
`verificadores/verificador-simulado.spec.ts`, `compra-suscripcion.service.spec.ts` (unitarios) y los
e2e `test/suscripcion-compra.e2e-spec.ts`, `test/suscripcion-compra-errores.e2e-spec.ts` y
`test/suscripcion-restaurar.e2e-spec.ts` (tres archivos para no pasar de 10 llamadas por endpoint en
cada suite: el throttle es de 10 por minuto). Etapa 4b: `cuenta-ofuscada.spec.ts`,
`verificadores/verificador-google.spec.ts` (con `GooglePlayApi` siempre mockeada: nunca hay red ni
credenciales), y los e2e `test/suscripcion-cuenta-ofuscada.e2e-spec.ts` y
`test/suscripcion-google-falso.e2e-spec.ts` (este último sobrescribe `VERIFICADOR_TIENDA` con un
`VerificadorGoogle` sobre una API falsa). Etapa 5: `rtdn/transicion.spec.ts`, `rtdn/pubsub-auth.spec.ts`,
`rtdn/rtdn.types.spec.ts` (decodificación y `FuenteEstadoSimulada`), `rtdn/rtdn.service.spec.ts`,
`rtdn/reconciliacion.service.spec.ts` y el e2e `test/suscripcion-rtdn.e2e-spec.ts` (sobrescribe
`FUENTE_ESTADO_GOOGLE` y `VERIFICADOR_PUSH`; nunca se llama a Google).

## 2.1 Endpoint

### `GET /me/suscripcion`

- Guard: `JwtAuthGuard`. Sin body, sin DTO y **sin `@Throttle` propio** (aplica el global de 60/min).
- Éxito `200`: `SuscripcionSnapshot` (10 claves, snake_case, fechas `aIsoNegocio`, `ahora_servidor`
  dentro del JSON). Sin token o con token inválido: `401`.
- Si `snapshot()` falla sale el `500`: el cliente lo trata como `errorServidor` y nunca bloquea.
- El mismo snapshot viaja en el campo opcional `suscripcion` de `POST /auth/login`,
  `POST /auth/register` y `GET /me` (ver `src/auth/README.md`).

## 2.2 Bloqueo de escrituras (etapa 3)

Con el estado **efectivo** `prueba_vencida`, `vencida` o `pago_en_proceso` (`ESTADOS_BLOQUEADOS`) se
rechazan con `403` y el cuerpo exacto
`{ statusCode: 403, message: 'SUSCRIPCION_REQUERIDA: tu suscripción no está activa', error: 'Forbidden' }`
(el código va AL INICIO del `message` porque el cliente lo busca con `includes`):

- `POST /tickets`.
- `POST /productos`, `PATCH /productos/:id`, `DELETE /productos/:id`.

**No se bloquean:** `GET /productos`, `GET /productos/catalogo`, `GET /reportes/*`, `GET /me`,
`GET /me/suscripcion` ni auth.

Reglas:

- **Solo cuenta la hora del servidor** (`ahora = new Date()`), nunca la del teléfono.
- **Sin ventana de tolerancia ni excepción de "venta en curso"** (decisión del dueño del producto): un
  ticket empezado antes del vencimiento y guardado después da 403; no existe `borrador_iniciado_en`
  (con `forbidNonWhitelisted` el campo da `400`). El borrador se conserva en el teléfono y se guarda
  tras pagar.
- Al volver a `activa` (u otro estado no bloqueado) se desbloquea sin pasos extra: el estado efectivo se
  recalcula en cada petición.

API:

- `esEstadoBloqueado(estado): boolean` (`bloqueo.ts`, pura).
- `SuscripcionesService.estaBloqueada(usuario: Pick<Usuario,'id'|'createdAt'>, ahora = new Date()):
  Promise<boolean>`: **una sola consulta** (`findOne` por `usuario_id`, usa el UNIQUE), no carga el
  historial ni llama a `snapshot()`. Repara una cuenta sin fila (helper privado `obtenerFila`,
  compartido con `snapshot()`).
- `SuscripcionesService.assertPuedeEscribir(usuario, ahora = new Date()): Promise<void>`: lanza
  `ForbiddenException(MENSAJE_SUSCRIPCION_REQUERIDA)` si está bloqueada.
- `SuscripcionActivaGuard` (`guards/`): lee `request.user`, lanza `UnauthorizedException` si falta,
  llama a `assertPuedeEscribir` y devuelve `true`. **Nunca devuelve `false`**: si lo hiciera Nest
  respondería "Forbidden resource" y el cliente no reconocería el código. Debe ir siempre después de
  `JwtAuthGuard`.

Dónde se aplica: `@UseGuards(JwtAuthGuard, SuscripcionActivaGuard)` en `TicketsController.create` y en
`ProductosController.create/update/remove`. Opción elegida: `SuscripcionesModule` **exporta** el guard y
`TicketsModule` y `ProductosModule` importan `SuscripcionesModule` (en vez de declarar el guard como
provider en cada módulo). El guard corre antes que `ParseUUIDPipe` y que el `ValidationPipe`: una cuenta
bloqueada recibe 403 aunque el `:id` o el body sean inválidos (orden 403 → validación).

## 2.3 Compra de la suscripción (etapa 4a simulado, etapa 4b real)

Los dos endpoints llevan `JwtAuthGuard` y `@Throttle({ default: { limit: 10, ttl: 60000 } })`
(10 por minuto cada uno). **Nunca** llevan `SuscripcionActivaGuard`: una cuenta bloqueada tiene que
poder pagar. Respuestas: `200` con el `SuscripcionSnapshot`; `400` (DTO inválido,
`PRODUCTO_INVALIDO` o `COMPRA_RECHAZADA`); `401`; `409` `TIENDA_EN_USO`; `429`; `503` `TIENDA_NO_DISPONIBLE` (solo con el verificador real). Los mensajes
llevan el código al inicio (`MENSAJE_TIENDA_EN_USO`, `MENSAJE_PRODUCTO_INVALIDO`,
`MENSAJE_COMPRA_RECHAZADA` en `compra-suscripcion.service.ts`).

### `POST /me/suscripcion/validar-compra`

Body (exactamente tres campos; cualquier otro da 400): `{ "tienda": "google_play", "producto_id":
"<PRODUCTO_SUSCRIPCION_ID>", "token_compra": "..." }` (`tienda` solo `google_play`; `producto_id`
1 a 100 caracteres; `token_compra` 1 a 2048).

### `POST /me/suscripcion/restaurar`

Body: `{ "tienda": "google_play", "compras": [{ "producto_id", "token_compra" }] }` (hasta 10
compras; se admite el arreglo vacío). Cada compra se procesa como en `validar-compra`, con los
tokens repetidos deduplicados (D9): una compra inválida (400) se ignora; si ninguna fue propia
(aplicada, ya propia o ignorada por D2) y hubo al menos una de otra cuenta, `409`; en cualquier otro
caso `200` con el snapshot final (un arreglo vacío o solo con compras inválidas devuelve el snapshot
actual sin cambios).

### Verificador simulado (`VALIDACION_TIENDA=simulada`)

Decide por el prefijo del token, no llama a la tienda y su `reconocer` no hace nada. `orderId` =
`SIM-` + los 24 primeros hex del SHA-256 del token (determinista).

| Prefijo | Resultado |
|---|---|
| `mock-compra-` (incluye `mock-compra-a-medias-`) | `activa`, `periodoInicio` = ahora, `periodoFin` = ahora + 1 mes (zona de negocio), renovación sí, 99.00 MXN |
| `mock-pendiente-` | `pendiente`, sin fechas, monto ni moneda, sin renovación |
| `mock-tienda-en-uso-` | como `mock-compra-` pero con `cuentaOfuscada = 'cuenta-simulada-ajena'` (da 409) |
| cualquier otro | `rechazada` (400 `COMPRA_RECHAZADA`) |

### Configuración (fail-fast, `config-suscripcion.ts`)

Una configuración inválida hace fallar el arranque (patrón de `MailService`). Una variable vacía
cuenta como ausente.

- `VALIDACION_TIENDA`: ausente fuera de producción = `simulada` (con un `Logger.warn`); ausente o
  `simulada` con `NODE_ENV=production` = error; cualquier otro valor = error con la lista de
  admitidos (`simulada`, `google`). El modo por defecto es `simulada`; `google` solo se activa a mano.
- `PRODUCTO_SUSCRIPCION_ID`: ausente fuera de producción = `PENDIENTE` (el id provisional); ausente o
  `PENDIENTE` en producción o con `google` = error. El id real es `ticket_mensual`; el simulado del
  backend necesita `PRODUCTO_SUSCRIPCION_ID=ticket_mensual` en su `.env` porque el frontend ya envía
  ese id.
- Con `VALIDACION_TIENDA=google` (en cualquier entorno) son obligatorias: `GOOGLE_SERVICE_ACCOUNT_JSON`
  (el JSON de la cuenta de servicio en base64, en una sola línea; se decodifica y se exige
  `client_email` y `private_key`), `PLAY_PACKAGE_NAME`, `SUSCRIPCION_HMAC_SECRETO` (32 caracteres o
  más) y un `PRODUCTO_SUSCRIPCION_ID` distinto de `PENDIENTE`.
- `SUSCRIPCION_HMAC_SECRETO`: obligatorio (32 o más) en producción y con `google`; en otro caso,
  ausente = constante de desarrollo (`HMAC_SECRETO_DESARROLLO`) con un `Logger.warn`.
- Los mensajes de error nunca incluyen el valor de la variable ni fragmentos del JSON.
- El paquete `@googleapis/androidpublisher@42.2.0` (versión exacta) exige **Node >= 22**.

### Algoritmo (`CompraSuscripcionService.procesarCompra`)

1. `producto_id` distinto de `PRODUCTO_SUSCRIPCION_ID`: 400 `PRODUCTO_INVALIDO`.
2. `obtenerFila` repara la cuenta sin fila de suscripción.
3. **Idempotencia:** busca la compra por (`tienda`, `purchase_token`): de otra cuenta, 409; propia y
   no `pendiente`, se devuelve el snapshot sin verificar ni abrir transacción; propia y `pendiente`,
   se vuelve a verificar (D8).
4. `verificador.verificar(...)` **fuera** de la transacción (un `TIENDA_NO_DISPONIBLE` sale aquí sin
   tocar la BD): `rechazada` = 400 (E12: si la compra propia estaba `pendiente`, antes pasa a `expirada`
   y, si era lo que mantenía a la cuenta en `pago_en_proceso` y no queda otra pendiente, la cuenta
   vuelve a `prueba_vencida`/`prueba_terminada` si nunca pagó (`acceso_hasta` NULL) o a
   `vencida`/`cancelada` si ya había pagado, con `estado_desde` = ahora); `cuentaOfuscada` no nula y
   distinta del HMAC de `usuario.id` = 409 (E8: nula = se acepta y se liga a quien la envía).
5. Transacción con `SELECT ... FOR UPDATE` (`pessimistic_write`) sobre la fila de `suscripciones`;
   relee la compra dentro de la transacción y calcula el estado efectivo.
6. **Carrera:** una violación `23505` del UNIQUE (`tienda`, `purchase_token`) se captura, se relee la
   compra fuera de la transacción y se responde 409 (de otra cuenta) o ok (propia).
   Con `autoRenovacion = false` (cancelada con tiempo restante) queda `activa`, `proximo_cobro` NULL y
   `renovacion_automatica = false`. Si `yaReconocida`, se guarda `reconocida_en = now()` sin llamar a
   `reconocer`. Un monto o moneda `null` inserta 0 (el CHECK exige >= 0) con un `Logger.warn`.
7. Tras el commit, si la compra quedó `confirmada` con `reconocida_en` NULL se llama a
   `verificador.reconocer` y se marca `reconocida_en = now()`. Si falla, se registra con
   `Logger.error` y NO se rompe la activación; se reintenta al reenviar el token.

### Reglas del dueño del producto (4a)

- **D1, pago pendiente (OXXO):** solo pasa a `pago_en_proceso` (bloquea) si la cuenta YA no tenía
  días (estado efectivo `prueba_vencida`, `vencida` o `pago_en_proceso`). Con días (prueba vigente,
  `activa` o `cancelada` vigente) NO cambia la suscripción: solo se guarda la compra `pendiente` y la
  cuenta sigue con normalidad. Las compras pendientes no generan fila en `pagos_historial`. Al pasar
  a `pago_en_proceso` se fija `tienda = google_play`, `renovacion_automatica = false`,
  `proximo_cobro = NULL`, `motivo = NULL`, `acceso_hasta` sin cambios.
- **D2, no se cobra dos veces un mes vigente:** si llega un token NUEVO que la tienda da como
  `activa` mientras el estado efectivo es `activa` o `cancelada` (con `acceso_hasta` futuro), NO se
  aplica: no se inserta en `compras` ni en `pagos_historial`, no se cambia la suscripción y no se
  llama a `reconocer`; se registra un `Logger.warn` con el usuario y el `orderId` (nunca el token) y
  se responde 200 con el snapshot actual. **En la 4b, al no hacer acknowledge, Google reembolsa
  automáticamente esa compra a los 3 días.** Pagar durante la PRUEBA sí está permitido: la prueba no
  cuenta como mes pagado; el mes empieza ese día y los días de prueba restantes se pierden
  (`prueba_inicio` y `prueba_fin` no se tocan). Una compra propia `pendiente` que se confirma tarde
  (D8) NO está sujeta a D2: es el mismo pago.
- **D3, mes pagado y monto:** de `periodoInicio` (el momento del pago) al mismo día y hora del mes
  siguiente en la zona de negocio (`sumarUnMesNegocio`: 31 de enero, 28 de febrero).
  `acceso_hasta = proximo_cobro = periodoFin`. Una fila `pagado` en el historial por compra
  confirmada, `INSERT ... ON CONFLICT ("tienda","external_id") DO NOTHING`, con monto PROVISIONAL de
  99.00 MXN (`MONTO_SIMULADO`, `MONEDA_SIMULADA`, marcados `// TEMPORAL: precio real en 4b`).
- **D8:** un token propio `pendiente` que se reenvía se vuelve a verificar. **D9:** `restaurar`
  aplica las compras propias y solo responde 409 si ninguna es propia y al menos una es ajena.
- El monto de 99.00 MXN es solo del verificador simulado. Con el real (E3) el monto es el total que
  pagó el cliente (`orders.get` > `total`).

## 2.4 Verificador real de Google Play (etapa 4b)

`VerificadorGoogle` consulta `purchases.subscriptionsv2.get` a través de `GooglePlayApi` (interfaz con
`obtenerSuscripcion`, `reconocer` y `obtenerPedido`; implementación `GooglePlayApiReal` con scope
`https://www.googleapis.com/auth/androidpublisher` y timeout de 10 s por llamada). Usa el `lineItem`
cuyo `productId` es el producto pedido (si no existe, `rechazada`). Nunca se registran el token, las
credenciales ni la respuesta cruda (solo el código HTTP).

| `subscriptionState` (`SUBSCRIPTION_STATE_*`) | Resultado |
|---|---|
| `ACTIVE` | `activa`, `autoRenovacion` = `autoRenewingPlan.autoRenewEnabled` |
| `CANCELED` con `expiryTime` futuro | `activa`, `autoRenovacion = false` |
| `CANCELED` con `expiryTime` pasado | `rechazada` |
| `PENDING` | `pendiente` |
| `IN_GRACE_PERIOD` y `ON_HOLD` | `rechazada` (E5) |
| `PAUSED`, `EXPIRED`, `PENDING_PURCHASE_CANCELED`, `UNSPECIFIED` | `rechazada` |

- **E5, cobro fallido:** en Play Console, gracia en 0 días (Google mantiene 1 día obligatorio) y
  suspensión (account hold) activada. `IN_GRACE_PERIOD` y `ON_HOLD` nunca activan una cuenta (cuentan
  como `rechazada` al validar o restaurar). La recuperación con "Pago recibido" llega por RTDN (etapa
  5, sección 2.5).
- **Campos:** `orderId` = `lineItem.latestSuccessfulOrderId` (`subscriptionsv2` no tiene
  `latestOrderId`: ese campo solo existe en la API v1 antigua, así que no hay respaldo); `periodoFin`
  = `lineItem.expiryTime` (E2: fechas de Google, no `sumarUnMesNegocio`, que queda solo para el
  simulado); `periodoInicio` = `startTime`, que es el momento en que se concedió la suscripción (alta
  original), no el inicio del período en curso; `cuentaOfuscada` =
  `externalAccountIdentifiers.obfuscatedExternalAccountId` o `null`; `yaReconocida` =
  `acknowledgementState === ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`.
- **Monto (E3):** `orders.get(orderId).total` (units + nanos con 2 decimales y su `currencyCode`);
  si falla o no viene, `autoRenewingPlan.recurringPrice` con `Logger.warn`; si tampoco hay, `null`.
- **Compras de prueba (E14):** una `testPurchase` se acepta y se registra en el log (usuario y
  `orderId`, sin el token).
- **Errores de Google:** `400`, `404` y `410` = `rechazada`. Red, timeout, `401`, `403`, `429` y
  `5xx` = `503 TIENDA_NO_DISPONIBLE: no pudimos confirmar el pago con la tienda, intenta de nuevo`;
  un error de red NUNCA se convierte en `rechazada`. El cliente (la app) trata el 503 como
  "sigue confirmando".
- **Acknowledge solo en el servidor (E6):** `reconocer` llama a `purchases.subscriptions.acknowledge`
  (`packageName`, `subscriptionId` = producto, `token`). Si Google responde 400 o 409 se relee la
  compra y, si ya figura reconocida, cuenta como éxito. La app NO debe reconocer (en Android su
  `terminarTransaccion` no hace nada): reconocer desde el cliente rompería D2. Sin acknowledge Google
  reembolsa a los 3 días.
- **`cuenta_ofuscada` (HMAC):** `HMAC-SHA256(usuario.id, SUSCRIPCION_HMAC_SECRETO)` en hexadecimal (64
  caracteres, el máximo de `obfuscatedAccountId`). Se calcula (no se guarda), se expone en `GET /me`
  (no en login ni register) y es lo que la app pasa a Google al comprar. **El secreto NO se rota
  nunca:** cambiarlo rompería la correspondencia con las compras ya hechas.

### Limitaciones conocidas (actualizadas en la etapa 5)

- Resueltas por la etapa 5: cancelaciones, reembolsos, cobros fallidos y renovaciones ya llegan por RTDN
  (sección 2.5) y hay una revisión de respaldo (F6) si se pierde un aviso.
- `periodoInicio` de una compra validada es el `startTime` original (ver arriba); las renovaciones por
  RTDN usan `order.createTime` (respaldo `eventTimeMillis`) para `cobrado_en`.
- La revisión de respaldo guarda la última revisión en memoria: se reinicia con el proceso y no se
  comparte entre instancias.
- Dos suscripciones a la vez (R-2) solo se detectan con `Logger.warn`; no se resuelve automáticamente.
- Un reembolso sin "Revocar" en Play Console puede volver a cobrar el mes siguiente (ver 2.5).
- Siguen pendientes: App Store, el precio legal definitivo (`$XXX.00`) y las pruebas con Google real.

## 2.5 RTDN de Google Play por Pub/Sub push (etapa 5)

`POST /tienda/google/rtdn`: lo llama Pub/Sub, no la app. Sin `JwtAuthGuard`, con `@SkipThrottle()` y
`@HttpCode(200)`; respuesta vacía. El body se tipa con la interface `SobrePubSub` (no con un DTO) para que
el `ValidationPipe` global (`forbidNonWhitelisted`) no rechace campos que Pub/Sub añada. El límite de
body de 1 MB sigue vigente; el `ThrottlerGuard` global no aplica a esta ruta (`@SkipThrottle`).

### Orden de las comprobaciones y códigos HTTP

1. **OIDC** (`VERIFICADOR_PUSH`); si falla, **401 sin tocar la BD** (no se guarda ninguna fila).
2. `messageId = message.messageId ?? message.message_id`; si falta o mide más de 100 caracteres, **400**.
3. `RtdnService.procesar`: idempotencia, decodificación y aplicación.

| Código | Cuándo |
|---|---|
| 200 | procesado, ignorado, duplicado, compra desconocida, mensaje inválido, de prueba, `token_invalido` |
| 400 | sin `messageId` (o de más de 100 caracteres) |
| 401 | el token OIDC falta, tiene mal formato o no es válido |
| 503 | Google (o sus certificados) no disponible, o un error transitorio de BD (Pub/Sub reintenta) |
| 500 | error inesperado (Pub/Sub reintenta; el evento queda en `error`) |

Pub/Sub confirma la entrega con 102, 200, 201, 202 o 204; cualquier otro código hace que reintente.

### Verificación OIDC (F10, F12, F13)

`VerificadorPushOidc` (`rtdn/pubsub-auth.ts`): extrae el JWT con `^Bearer (.+)$`, llama a
`verifyIdToken({ idToken, audience: PUBSUB_PUSH_AUDIENCIA })` (la librería valida firma, `exp` e `iss`
= `https://accounts.google.com`) y exige `email === PUBSUB_PUSH_EMAIL` y `email_verified === true`. Todo lo
demás es 401; si falla la red al obtener los certificados de Google, 503. Nunca se registra el header ni el
token. Se usa `auth.OAuth2` exportado por `@googleapis/androidpublisher` (`google-auth-library` 11.2.0
transitiva): no se instaló nada.

- **Producción:** `PUBSUB_PUSH_AUDIENCIA` y `PUBSUB_PUSH_EMAIL` son obligatorias (fail-fast).
- **Modo `google` fuera de producción:** opcionales; si faltan, aviso al arrancar y 401 a todo.
- **Modo `simulada` (nunca en producción):** no se verifica el OIDC (aviso al arrancar) y el estado de
  Google se simula (`FuenteEstadoSimulada`), para probar con `curl`.

### Idempotencia y `eventos_tienda`

`INSERT INTO eventos_tienda (tienda, message_id, tipo, payload) VALUES ('google_play',$1,$2,$3) ON CONFLICT
(message_id) DO NOTHING RETURNING id`. Si el `message_id` ya existía: con `procesado_en` no nulo, 200 sin
hacer nada; con `procesado_en` nulo, se vuelve a procesar (el procesamiento es idempotente). Al terminar
se actualizan `procesado_en = now()`, `resultado`, `usuario_id`, `compra_id` y `error = null`. Un error
transitorio deja `resultado = 'error'`, `error` con un texto SIN token y `procesado_en` nulo, y responde
503 para que Pub/Sub reintente. `tipo`: `SUBSCRIPTION_<NOMBRE>`, `VOIDED_PURCHASE`, `TEST`,
`ONE_TIME_PRODUCT`, `PENDING_REFUND_REVIEW` o `DESCONOCIDO`.

- **F8:** en `payload` el `purchaseToken` (y `linkedPurchaseToken`, `expiredPurchaseToken`) se sustituye por
  `sha256:<16 hex>`. Nunca se guarda el token ni el payload crudo; un mensaje no decodificable guarda
  `{"invalido":true}`.
- **F9:** `eventos_tienda` se conserva sin borrado (bitácora de auditoría; crece una fila por aviso).
- Resultados: `aplicado`, `sin_cambios`, `ignorado`, `prueba`, `mensaje_invalido`, `paquete_ajeno`
  (`packageName` distinto de `PLAY_PACKAGE_NAME`), `compra_desconocida`, `token_invalido` (Google
  400/404/410), `rechazada` / `conflicto` (compra nueva que `validar-compra` habría rechazado),
  `d2_ignorada`, `error`.

### Procesamiento

Se decodifica `message.data` (base64 a JSON). `testNotification` es `prueba` (F11);
`oneTimeProductNotification`, `pendingRefundReviewNotification`, un `voidedPurchaseNotification` con
`productType` distinto de 1 y los tipos sin uso (11 `PAUSE_SCHEDULE_CHANGED` y desconocidos) son
`ignorado`. Para una suscripción **siempre se vuelve a consultar el estado** a Google
(`FUENTE_ESTADO_GOOGLE`: `purchases.subscriptionsv2.get`); del aviso solo se usa el motivo (`REVOKED` o
voided = reembolso). Así el orden de llegada de los avisos no importa. Un 400/404/410 es
`token_invalido` (200); red, timeout, 401, 403, 429 o 5xx es 503.

La compra se localiza por (`google_play`, `purchaseToken`):

- **No existe (F5):** se busca al dueño en este orden: compra registrada con `linkedPurchaseToken`,
  compra registrada con `outOfAppPurchaseContext.expiredPurchaseToken`, y usuario cuyo HMAC
  (`CuentaOfuscadaService`) coincide con `obfuscatedExternalAccountId` o con
  `expiredExternalAccountIdentifiers`. Con dueño se llama a
  `CompraSuscripcionService.aplicarCompraDeTienda` (las mismas reglas de `validar-compra`: D1, D2, E8, E12,
  carrera `23505` y acknowledge en el servidor); un 400 es `rechazada`, un 409 `conflicto`; una compra que D2
  no aplica es `d2_ignorada` (y la compra vieja `linked` no se toca). Si se aplicó y vino
  `linkedPurchaseToken`, la compra vieja pasa a `expirada` sin tocar la suscripción. Sin dueño:
  `compra_desconocida` y nada más (también para reembolsos de tokens desconocidos).
- **Existe y está `pendiente`:** se delega en `aplicarCompraDeTienda` (D8 / E12).
- **Existe (confirmada, expirada o reembolsada):** se aplica la tabla siguiente.

### Tabla de transiciones (`transicionDesdeGoogle`, función pura)

Se aplica en una transacción con `lock pessimistic_write` sobre la fila de `suscripciones` (primero
`suscripciones`, después `compras`). Las llamadas a Google (`orders.get`, acknowledge) van FUERA de la
transacción. `estado_desde` solo cambia si cambia el estado; si nada cambia, `sin_cambios`.
`otraCompraVigente` = otra compra confirmada del usuario con `periodo_fin > ahora` (F7).

| Estado de Google (re-consultado) | compras | suscripciones | pagos_historial |
|---|---|---|---|
| `ACTIVE` (PURCHASED, RENEWED, RECOVERED, RESTARTED, DEFERRED, PRICE_*, ITEMS_CHANGED, CANCELLATION_SCHEDULED) | `confirmada`, `periodo_fin` = `expiryTime`, `order_id` = `latestSuccessfulOrderId` | `activa`, renovación = `autoRenewEnabled`, `acceso_hasta` = expiry, `proximo_cobro` = expiry si renueva (si no, null), tienda `google_play`, `motivo` null. Si la fila está en `vencida`/`reembolso`, solo se reactiva con un pedido NUEVO no registrado (F3) | si `latestSuccessfulOrderId` no está registrado: fila `pagado` (monto = total de `orders.get`, respaldo `recurringPrice`, si no 0 con warn; `cobrado_en` = `order.createTime`, respaldo `eventTimeMillis` o ahora; `periodo` = `periodoNegocio(cobrado_en)`), `ON CONFLICT DO NOTHING` |
| `CANCELED` con expiry futuro (F4) | `confirmada`, `periodo_fin` = expiry | `cancelada`, renovación false, `proximo_cobro` null, `acceso_hasta` = expiry, `motivo` null (si `otraCompraVigente`, no se toca) | solo si trae un pedido nuevo no registrado (desviación respecto al plan, ver sección 8 de `docs/suscripcion/flujo_suscripcion.md`) |
| `ON_HOLD` o `IN_GRACE_PERIOD` (F1, F2) | sin cambio | si no hay `otraCompraVigente`: `vencida`, `cobro_fallido`, renovación false, `proximo_cobro` null, `acceso_hasta` sin cambio | fila `fallido` con `external_id` = `fallido-${compra.id}-${periodo}`, `periodo` y `cobrado_en` = `acceso_hasta` anterior (o ahora), monto = `recurringPrice` o 0. Se conserva aunque luego llegue `RECOVERED` |
| `EXPIRED`, o `CANCELED` con expiry pasado | `expirada` | si no hay `otraCompraVigente` ni `replacementCancellation`: `vencida`, renovación false, `proximo_cobro` null, `acceso_hasta` = expiry; `motivo` = `reembolso` si ya lo era, `cobro_fallido` si `systemInitiatedCancellation` o si ya estaba en `vencida`/`cobro_fallido`, si no `cancelada` | — |
| `PAUSED` (pausa desactivada) | sin cambio | si no hay `otraCompraVigente`: `vencida`/`cancelada` | — |
| `PENDING` o `PENDING_PURCHASE_CANCELED` | se delega (D8 / E12) si la compra está `pendiente`; si no, `ignorado` | | |
| `UNSPECIFIED` o sin `lineItem` del producto | — | — | `ignorado` |
| **Reembolso** (`voidedPurchaseNotification` con `productType` 1, o `REVOKED`), con cualquier estado de Google | `reembolsada` | `vencida`/`reembolso`, renovación false, `proximo_cobro` null, aunque Google siga en `ACTIVE` (si hay `otraCompraVigente`, no se toca la cuenta) | el pago con `external_id` = `orderId` pasa a `reembolsado` |

### Decisiones del dueño (F1 a F14)

- **F1** `ON_HOLD` / `IN_GRACE_PERIOD` = `vencida`/`cobro_fallido`; la cuenta se bloquea en cuanto llega el aviso.
- **F2** El cobro fallido se anota como `fallido`; si Google lo recupera, la fila `fallido` se conserva y se
  añade `pagado`.
- **F3** Cualquier reembolso bloquea SIEMPRE. Un pedido NUEVO pagado (otro `latestSuccessfulOrderId` no
  registrado) con `ACTIVE` es un pago real y reactiva. Un aviso sin pedido nuevo nunca quita el motivo
  `reembolso`. `refundType` 2 se registra y se trata igual. **El dueño debe elegir siempre "Reembolsar y
  revocar" en Play Console:** un reembolso sin revocar deja la suscripción viva en Google y puede volver a
  cobrar el mes siguiente (el pago nuevo reactivaría la cuenta).
- **F4** Cancelar con días pagados: `cancelada` hasta `expiryTime`; `RESTARTED` la reactiva sin cobro nuevo.
- **F5** Compras que llegan por aviso: ver "Procesamiento".
- **F6** Revisión de respaldo (abajo).
- **F7** Dos compras a la vez: los avisos negativos de una compra vieja no tocan la cuenta si otra compra
  confirmada sigue vigente; si quedan dos activas, solo `Logger.warn` (riesgo R-2).
- **F8** Tokens como `sha256:<16 hex>` en `payload`. **F9** `eventos_tienda` sin borrado.
- **F10** OIDC y variables (arriba). **F11** `prueba` e `ignorado` con 200. **F12** Modo `simulada`.
- **F13** Sin dependencias nuevas. **F14** Sin cambios de código en el frontend (solo su README).

### Revisión de respaldo (F6)

`ReconciliacionService.revisarSiHaceFalta`, solo en modo `google`. Se dispara cuando el cliente consulta
`GET /me/suscripcion` o el campo `suscripcion` de auth (login, register, `GET /me`), y SOLO si el snapshot
dice `activa` con renovación y `acceso_hasta + 1 hora < ahora`; máximo UNA vez cada 24 horas por usuario
(un `Map` en memoria que se reinicia con el proceso). Va en segundo plano (sin `await`, con `catch` y log),
no cambia la respuesta en curso, re-consulta la compra confirmada más reciente y aplica la misma tabla con
tipo `RECONCILIACION`. Las cuentas al día nunca generan consultas a Google. No crea fila en
`eventos_tienda`; solo log. Es un servicio aparte, llamado desde `SuscripcionesController` y
`AuthService.snapshotSeguro`, porque `SuscripcionesService` se construye con `new` en sus specs (en esos dos
constructores el servicio es un parámetro opcional en el tipo para no romper los specs; Nest siempre lo inyecta).

### Configuración de Pub/Sub y Play Console (tareas manuales, no son código)

1. Crear un tema de Pub/Sub y, en Play Console (Monetización > Configuración de monetización >
   Notificaciones en tiempo real para desarrolladores), indicarlo y elegir todas las notificaciones de
   suscripciones y compras anuladas. La cuenta `google-play-developer-notifications@system.gserviceaccount.com`
   necesita el rol Publicador en el tema.
2. Crear una cuenta de servicio para firmar el push (su correo es `PUBSUB_PUSH_EMAIL`) y una suscripción
   **push** al tema con endpoint `https://<dominio-público>/tienda/google/rtdn`, con autenticación habilitada
   para esa cuenta y como audiencia la URL del endpoint (es `PUBSUB_PUSH_AUDIENCIA`).
3. Plazo de confirmación razonable (por ejemplo 30 s) y política de reintento con retroceso.
4. Enviar la notificación de prueba desde Play Console y comprobar `resultado = 'prueba'` en
   `eventos_tienda`.
5. Play Console: gracia en 0 días (Google mantiene 1 día silencioso), suspensión (account hold) activada,
   pausa desactivada; al reembolsar, elegir siempre "Reembolsar y revocar".

### Probar en local (modo `simulada`, sin OIDC)

Con `VALIDACION_TIENDA` vacía y fuera de producción: crear una compra con `validar-compra` (token
`mock-compra-…`) y enviar `curl -X POST localhost:3000/tienda/google/rtdn -H "content-type: application/json" -d
'{"message":{"data":"<base64>","messageId":"m5-1"},"subscription":"projects/x/subscriptions/y"}'` con el
base64 de `{"version":"1.0","packageName":"com.canales.ticket","eventTimeMillis":"1760000000000",
"subscriptionNotification":{"version":"1.0","notificationType":5,"purchaseToken":"mock-compra-…"}}`.
Tipo 5 deja la cuenta en `vencida`/`cobro_fallido`; 1 la reactiva (pedido `SIM-…-R1`); 3 cancela; 13
expira; 12 revoca. Repetir el `messageId` no cambia nada.

## 3. Reglas de negocio

### Prueba de 14 días

- Toda cuenta recibe una prueba sin tarjeta, controlada por el servidor. `prueba_inicio` es el
  momento del registro (`usuario.createdAt`) o, en las cuentas existentes, el de la migración.
- `prueba_fin` = **las 23:59:59 del día 14 contando el día de inicio** en la zona de negocio, es
  decir día de inicio + 13 días. Ejemplo: inicio `2026-03-03T09:12:00-06:00` →
  `2026-03-16T23:59:59-06:00`. Lo calcula `finDePrueba(inicio)`; la migración de datos usa la
  fórmula SQL equivalente (el e2e comprueba que coinciden).
- `prueba_fin` nunca cambia al pagar (los días restantes de prueba se pierden, pero la fecha se
  conserva).
- Cuentas existentes: **backfill** (`BackfillPruebaSuscripciones`). Reciben 14 días desde el día de
  la migración, que cuenta como el día 1.
- Alta en `register`: dentro de la misma transacción que el `save` del usuario, con
  `prueba_inicio = usuario.createdAt`. `crearPrueba()` es idempotente
  (`INSERT ... ON CONFLICT ("usuario_id") DO NOTHING`).
- Si una cuenta no tiene fila (carrera o fallo anterior), `snapshot()` y `estaBloqueada()` la crean con
  `prueba_inicio = usuario.createdAt` y vuelven a leer (`obtenerFila`).

### Estado efectivo (`estadoEfectivo`)

El servidor guarda un `estado` y calcula el **efectivo** en cada lectura con la hora del servidor;
no hay proceso que actualice filas por el paso del tiempo. Comparación estricta (`ahora > fecha`),
igual que `yaPaso` del frontend.

| Estado guardado | Condición | Efectivo | `motivo` |
|---|---|---|---|
| `prueba` | `ahora > prueba_fin` | `prueba_vencida` | `prueba_terminada` |
| `cancelada` | `acceso_hasta` no nulo y `ahora > acceso_hasta` | `vencida` | `cancelada` |
| `activa` sin renovación | `acceso_hasta` no nulo y `ahora > acceso_hasta` | `vencida` | `cancelada` |
| `activa` con renovación | — (no vence por fecha; depende de la tienda, riesgo R-3) | `activa` | `null` |
| cualquier otro | — | el guardado | el guardado |

### Snapshot (`SuscripcionesService.snapshot`)

Devuelve los 10 campos exactos de `SuscripcionSnapshot` (`estado`, `prueba_inicio`, `prueba_fin`,
`acceso_hasta`, `proximo_cobro`, `renovacion_automatica`, `tienda`, `motivo`, `ahora_servidor`,
`historial`). Reglas: `estado` es el efectivo; `proximo_cobro` solo si el efectivo es `activa` con
renovación; `renovacion_automatica` es `false` si el efectivo no es `activa`; `motivo` solo con
`prueba_vencida`/`vencida`; fechas con `aIsoNegocio`.

**`historial`** (etapa 2): los últimos `MAX_HISTORIAL = 24` pagos de la cuenta en `pagos_historial`,
ordenados por `cobrado_en` DESC y `created_at` DESC como desempate (lo cubre
`IDX_pagos_historial_usuario_cobrado`). Cada elemento: `{ id: external_id, periodo, cobrado_en
(aIsoNegocio), monto (number, por el `numericTransformer`), moneda (sin espacios), estado }`. No
existe `GET /me/suscripcion/historial`: el historial solo viaja dentro del snapshot.

### Fechas y zona de negocio (riesgo R-7)

- Contrato: snake_case, fechas ISO 8601 con zona `-06:00` y **sin milisegundos**
  (`2026-03-16T23:59:59-06:00`), igual que `aIsoNegocio` del frontend.
- `fechas.ts` usa un **desfase fijo** `ZONA_NEGOCIO_OFFSET_MIN = -360` (idéntico al frontend); en
  SQL (backfill y consultas) se usa la zona con nombre `America/Mexico_City`. Son equivalentes
  desde 2022 porque México central no tiene horario de verano.
- **Riesgo R-7:** si México volviera a tener horario de verano, ambos criterios divergirían
  (el desfase fijo del backend y del frontend seguiría en -06:00, la migración y el cálculo de
  `periodo` por SQL no). Habría que cambiar el desfase por la zona real en `fechas.ts`, en el
  frontend y revisar los datos ya guardados.

### No existe período de gracia

El backend **nunca** produce `estado: 'gracia'` ni `gracia_fin`. Un cobro fallido será `vencida` con
`motivo: 'cobro_fallido'` (llega en etapas posteriores). Un test del servicio verifica que el
snapshot no contiene "gracia".

## 4. Restricciones de BD (migraciones `1787710000000` y `1787720000000`)

Valores enumerados como `varchar` + CHECK (no enums de Postgres) para no romper el contrato con el
frontend. Los CHECK se nombran `CHK_*` (no `CK_*`), como `CHK_productos_costo`. Todas las
columnas de fecha son `timestamptz`; las PK son `uuid DEFAULT gen_random_uuid()`.

### `suscripciones` (1 por cuenta)

| Columna | Tipo | Nulo | Default |
|---|---|---|---|
| `id` | uuid | NOT NULL | `gen_random_uuid()` |
| `usuario_id` | uuid | NOT NULL | — |
| `estado` | varchar(20) | NOT NULL | `'prueba'` |
| `prueba_inicio`, `prueba_fin` | timestamptz | NOT NULL | — |
| `acceso_hasta`, `proximo_cobro` | timestamptz | NULL | — |
| `renovacion_automatica` | boolean | NOT NULL | `false` |
| `tienda` | varchar(20) | NULL | — |
| `motivo` | varchar(20) | NULL | — |
| `estado_desde` | timestamptz | NOT NULL | `now()` |
| `created_at`, `updated_at` | timestamptz | NOT NULL | `now()` |

Constraints: `PK_suscripciones`, `UQ_suscripciones_usuario_id`, `FK_suscripciones_usuario_id` →
`usuarios(id)` ON DELETE CASCADE, `CHK_suscripciones_estado` (`prueba`, `prueba_vencida`,
`activa`, `cancelada`, `vencida`, `pago_en_proceso`), `CHK_suscripciones_prueba`
(`prueba_fin > prueba_inicio`), `CHK_suscripciones_tienda` (`google_play`, `app_store`),
`CHK_suscripciones_motivo` (`prueba_terminada`, `cancelada`, `cobro_fallido`, `reembolso`).
Índices: ninguno extra (el UNIQUE de `usuario_id` sirve).

### `compras` (una por suscripción de la tienda)

Columnas: `id`, `usuario_id`, `suscripcion_id`, `tienda` varchar(20), `producto_id` varchar(100),
`purchase_token` text, `order_id` varchar(100) NULL, `estado` varchar(20) DEFAULT `'pendiente'`,
`periodo_inicio`/`periodo_fin`/`reconocida_en` timestamptz NULL, `created_at`, `updated_at`.

Constraints: `PK_compras`, `UQ_compras_tienda_purchase_token` (`tienda`, `purchase_token`),
`FK_compras_usuario_id` → `usuarios(id)` CASCADE, `FK_compras_suscripcion_id` →
`suscripciones(id)` CASCADE, `CHK_compras_tienda`, `CHK_compras_estado` (`pendiente`, `confirmada`,
`reembolsada`, `expirada`). Índices: `IDX_compras_usuario_id`, `IDX_compras_suscripcion_id`.
Riesgo R-8: el UNIQUE sobre `purchase_token` (text) tiene el límite de tamaño de entrada de un
B-tree (~2,7 KB); el DTO de la etapa 4 lo limitará a 2048 caracteres.

### `pagos_historial` (un cobro por fila)

Columnas: `id`, `usuario_id`, `compra_id` NULL, `tienda`, `external_id` varchar(100), `periodo`
char(7), `cobrado_en`, `monto` numeric(10,2) (entidad con `numericTransformer`), `moneda` char(3)
DEFAULT `'MXN'`, `estado` varchar(20), `created_at`.

Constraints: `PK_pagos_historial`, `UQ_pagos_historial_tienda_external_id` (`tienda`,
`external_id`), `FK_pagos_historial_usuario_id` → `usuarios(id)` CASCADE,
`FK_pagos_historial_compra_id` → `compras(id)` **SET NULL**, `CHK_pagos_historial_tienda`,
`CHK_pagos_historial_periodo` (`^[0-9]{4}-(0[1-9]|1[0-2])$`), `CHK_pagos_historial_monto`
(`>= 0`), `CHK_pagos_historial_estado` (`pagado`, `reembolsado`, `fallido`). Índice:
`IDX_pagos_historial_usuario_cobrado` (`usuario_id`, `cobrado_en` DESC). `periodo` se calcula con
`periodoNegocio(cobrado_en)`.

### `eventos_tienda` (bitácora de notificaciones RTDN, etapa 5)

Columnas: `id`, `tienda` DEFAULT `'google_play'`, `message_id` varchar(100), `tipo` varchar(60)
NULL, `payload` jsonb, `usuario_id` NULL, `compra_id` NULL, `recibido_en` DEFAULT `now()`,
`procesado_en` NULL, `resultado` varchar(40) NULL, `error` text NULL.

Constraints: `PK_eventos_tienda`, `UQ_eventos_tienda_message_id` (idempotencia por `messageId` de
Pub/Sub), `FK_eventos_tienda_usuario_id` → `usuarios(id)` **SET NULL**,
`FK_eventos_tienda_compra_id` → `compras(id)` **SET NULL**, `CHK_eventos_tienda_tienda`. Índice:
`IDX_eventos_tienda_recibido_en`.

## 5. Decisiones y gotchas

- **Backfill y su `down`.** `BackfillPruebaSuscripciones` es idempotente (`NOT EXISTS`). Su `down`
  borra todas las filas con `estado = 'prueba'`, sin poder distinguir las del backfill de las de
  registros posteriores. Es aceptable porque el `down` de `CreateSuscripcionesTables` elimina las
  tablas completas; al revertir de a una migración, hay que saber que se pierden esas filas.
- **Sin relación inversa en `Usuario`.** Las relaciones (`@OneToOne`/`@ManyToOne` con
  `@JoinColumn` y `onDelete`) se declaran solo en las entidades hijas. Una inversa rompería
  `buildUsuario()` de `auth.service.spec.ts` (`tsc` compila también los specs).
- **Precisión de `prueba_inicio`.** En un registro, `prueba_inicio` es `usuario.createdAt` tal como
  lo lee Node (milisegundos), mientras `usuarios.created_at` guarda microsegundos; pueden diferir
  por menos de 1 ms. No tiene consecuencias.
- **`crearPrueba` usa SQL parametrizado** con `ON CONFLICT ("usuario_id") DO NOTHING` (el query
  builder con `.orIgnore()` emitiría un `ON CONFLICT DO NOTHING` sin destino, que además ignoraría
  cualquier otra violación única).
- **`synchronize: false`**: las entidades documentan columnas, los CHECK y los UNIQUE viven solo
  en las migraciones. Entidades registradas a mano en `data-source.ts` y `app.module.ts`.
- **Montos:** `numeric(10,2)` con `numericTransformer` (llega a Node como `number`).

## 6. Pendientes por etapa

- **Etapa 2 (hecha):** `GET /me/suscripcion`, `historial` real (máx. 24, de `pagos_historial`) y
  campo opcional `suscripcion` en login/register/`GET /me`.
- **Etapa 3 (hecha):** `SuscripcionActivaGuard` y `403 SUSCRIPCION_REQUERIDA` en `POST /tickets` y
  `POST/PATCH/DELETE /productos`. Sin `borrador_iniciado_en` ni ventana (descartados).
- **Etapa 4a (hecha):** `validar-compra` y `restaurar` con el verificador simulado, `409
  TIENDA_EN_USO`, idempotencia, lock y `23505`. Servicio aparte (`CompraSuscripcionService`).
- **Etapa 4b (hecha):** `VerificadorGoogle` (Google Play Developer API), acknowledge real,
  `cuenta_ofuscada` (HMAC, `SUSCRIPCION_HMAC_SECRETO`) en `GET /me`, monto real del historial y modo
  `google` en la configuración. Pendiente del dueño: el precio definitivo y las pruebas con teléfono.
- **Etapa 5 (hecha):** RTDN de Google Play por Pub/Sub push (`eventos_tienda`), OIDC, transiciones F1–F7 y
  revisión de respaldo (F6). Pendiente del dueño: configurar Pub/Sub y Play Console y probar con Google real.
- **Etapa 6 (hecha, 2026-10-14):** retiro del mock del frontend y cierre para producción. Backend: el modo
  simulado (`VerificadorSimulado`, `FuenteEstadoSimulada`, `VerificadorPushDesactivado` y los valores por
  defecto de desarrollo) se conserva solo para desarrollo y tests (ya falla al arrancar en producción);
  `test/setup-e2e.ts` fuerza `VALIDACION_TIENDA=simulada` para que los e2e nunca usen Google real;
  variable `TRUST_PROXY` (`src/trust-proxy.ts`, aplicada en `bootstrap()`); `.env.example` documenta
  `NODE_ENV`, `PORT`, `DB_SSL` y `TRUST_PROXY`. Checklist de despliegue en la sección 7.

## 7. Despliegue a producción (Render + Neon)

Backend en Render, base de datos en Neon. Solo existe un usuario real (el dueño); recibirá 14 días de
prueba desde el día en que se apliquen las migraciones. El build y la subida a Google Play los hace el
dueño (el frontend necesita `EXPO_PUBLIC_API_URL=https://<servicio>.onrender.com` en EAS antes del build).

### Variables de entorno de Render

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` (activa los chequeos fail-fast de correo, suscripción y Pub/Sub). |
| `VALIDACION_TIENDA` | `google` (`simulada` o vacía en producción hace fallar el arranque). |
| `PRODUCTO_SUSCRIPCION_ID` | `ticket_mensual`. |
| `PLAY_PACKAGE_NAME` | `com.canales.ticket`. |
| `SUSCRIPCION_HMAC_SECRETO` | 32 caracteres o más, generado UNA vez y **nunca rotado** (cambiarlo rompe la correspondencia con las compras ya hechas). |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON de la cuenta de servicio de Google, en base64 y en una sola línea. |
| `PUBSUB_PUSH_AUDIENCIA` | Audiencia del token OIDC del push (la URL del endpoint RTDN). |
| `PUBSUB_PUSH_EMAIL` | Correo de la cuenta de servicio que firma el push. |
| `TRUST_PROXY` | `1` (Render pone un proxy delante; así `req.ip` y el throttle usan la IP real). |
| `DB_SSL` | `true` (Neon exige TLS). |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | Los de Neon. |
| `JWT_SECRET` | Secreto largo y propio de producción. |
| `BREVO_API_KEY`, `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME` | Correo de recuperación de contraseña. |

`PORT` lo inyecta Render. No se versionan valores reales en ningún archivo.

### Migraciones

`ts-node` es dependencia de desarrollo, así que en producción se compila y se ejecuta la migración sobre
`dist`:

```
npm run build
npx typeorm migration:run -d dist/database/data-source.js
```

1. **Antes**, crear un respaldo de Neon (branch o snapshot).
2. El único usuario existente recibe 14 días de prueba desde la fecha de la migración (ese día cuenta como
   el día 1; ver la sección 3).

### Pub/Sub y Play Console

1. Tema y suscripción push de Pub/Sub apuntando a `https://<servicio>.onrender.com/tienda/google/rtdn`,
   con el correo de la cuenta de servicio y la audiencia que se pusieron en `PUBSUB_PUSH_EMAIL` y
   `PUBSUB_PUSH_AUDIENCIA` (detalle en la sección 2.5, "Configuración de Pub/Sub y Play Console").
2. Play Console: producto `ticket_mensual` con plan base `mensual` (renovación automática mensual, MXN, sin
   oferta de prueba gratis), período de gracia en 0 días, suspensión (account hold) activada, pausa
   desactivada, y las cuentas de prueba como license testers.
3. **Riesgo:** en el plan gratuito de Render el servicio se duerme tras un rato sin tráfico; el primer aviso de
   Pub/Sub puede tardar en despertarlo. Pub/Sub reintenta, y la revisión de respaldo (F6) cubre un aviso
   perdido, pero para producción se recomienda un plan sin suspensión.

### Orden recomendado

1. Desplegar el backend en Render (con las variables de arriba).
2. Migrar (respaldo de Neon antes).
3. Configurar Pub/Sub y Play Console.
4. Build del dueño con `EXPO_PUBLIC_API_URL` apuntando a Render.
5. Pruebas en el teléfono (checklist de la sección j del README de suscripción del frontend).
6. Merge a `main`.

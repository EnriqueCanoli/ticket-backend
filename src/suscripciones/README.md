# `suscripciones`

## 1. Propósito

Modelo de datos y lógica base de la suscripción mensual (prueba gratis de 14 días, después pago por
Google Play). Es dueño exclusivo de las tablas `suscripciones`, `compras`, `pagos_historial` y
`eventos_tienda`. El plan completo por etapas vive en `flujo_suscripcion.md` (raíz del repo, versionado
en git); el contrato con el frontend está en `src/features/suscripcion/README.md` del repo
`c:\dev\ticket` y en `src/shared/api/suscripcion.ts`.

**Estado: etapa 4b de 6 (compra con el verificador REAL de Google Play, el simulado se conserva).** Existen las tablas, las entidades, la prueba de 14 días (cuentas nuevas y
existentes), el estado efectivo, `SuscripcionesService.snapshot()` con el historial real,
`GET /me/suscripcion` y el campo opcional `suscripcion` en auth (login, register y `GET /me`).
Desde la etapa 3 el servidor **bloquea** (403 `SUSCRIPCION_REQUERIDA`) `POST /tickets` y
`POST/PATCH/DELETE /productos` con la suscripción no activa. Desde la etapa 4a existen
`POST /me/suscripcion/validar-compra` y `POST /me/suscripcion/restaurar`, validados por un verificador
**simulado** (por defecto) o, con `VALIDACION_TIENDA=google`, por el **real** (etapa 4b: Google Play
Developer API, acknowledge real, `cuenta_ofuscada` por HMAC y monto real). **Todavía no hay** RTDN
(etapa 5): ver "Limitaciones conocidas hasta la etapa 5".

## 2. Estructura real

```
src/suscripciones/
├── suscripciones.module.ts        # forFeature de las 4 entidades; registra el controller; exporta SuscripcionesService y SuscripcionActivaGuard
├── suscripciones.controller.ts    # GET /me/suscripcion, POST /me/suscripcion/validar-compra y /restaurar
├── suscripciones.service.ts       # crearPrueba(), snapshot(), estaBloqueada(), assertPuedeEscribir(), obtenerFila() (pública), historial() (privado), MAX_HISTORIAL
├── compra-suscripcion.service.ts  # CompraSuscripcionService: validarCompra(), restaurarCompras(), procesarCompra() (privado); MENSAJE_*
├── config-suscripcion.ts          # leerConfigSuscripcion() (pura, fail-fast), CONFIG_SUSCRIPCION
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
`VerificadorGoogle` sobre una API falsa).

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
  como `rechazada` al validar o restaurar). La recuperación con "Pago recibido" llegará por RTDN en la
  etapa 5.
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

### Limitaciones conocidas hasta la etapa 5

- Sin RTDN: una cuenta `activa` con renovación no refleja cancelaciones, reembolsos ni cobros
  fallidos hasta que se vuelva a validar (la fila no vence por fecha mientras renueve).
- `IN_GRACE_PERIOD`/`ON_HOLD` solo se detectan al validar o restaurar, no al ocurrir.
- `periodoInicio` de una renovación valida de nuevo es el `startTime` original (ver arriba).
- Sin reconciliación periódica ni eventos de la tienda (`eventos_tienda` sigue sin uso).

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

### `eventos_tienda` (bitácora de notificaciones, etapa 5)

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
- **Etapa 5:** RTDN de Pub/Sub (`eventos_tienda`).
- **Etapa 6:** retiro del mock del frontend e integración final.

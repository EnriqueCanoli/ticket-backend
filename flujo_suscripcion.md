# Plan por etapas: suscripción mensual en el backend

> Documento de trabajo para implementar en el backend (NestJS 11 + TypeORM + Postgres) la suscripción
> mensual que el frontend (Expo SDK 57 + expo-router, rama `feature/suscripcion`) ya implementó contra una
> fuente simulada temporal. Se usa una etapa por prompt. **Este documento no implementa nada.**
>
> - Backend: `C:\Users\Papeleria Aldana\Desktop\ticket-backend`.
> - Frontend: `C:\dev\ticket`. Su fuente del contrato es `src/features/suscripcion/README.md` (secciones
>   b y j), `src/shared/api/suscripcion.ts` y `flujo_subscripcion.md` (con "subscripcion", así se llama
>   el archivo del frontend; este documento lleva "suscripcion").
> - Fecha de redacción: 2026-10-11.
> - Marca de verificación: todo lo que cite métodos, campos o comportamientos de Google (Play Developer
>   API, RTDN, Pub/Sub, Play Console) está sujeto a **verificar en la documentación oficial** antes de
>   implementarlo. No se ha comprobado ninguno de ellos al escribir este plan.

## Índice

- [0. Cómo usar este documento](#0-cómo-usar-este-documento)
- [1. Resumen del flujo y de los estados](#1-resumen-del-flujo-y-de-los-estados)
- [2. Contrato con el frontend](#2-contrato-con-el-frontend)
- [3. Modelo de datos](#3-modelo-de-datos)
- [4. Variables de entorno nuevas](#4-variables-de-entorno-nuevas)
- [5. Etapas](#5-etapas)
  - [Etapa 1. Modelo de datos y prueba de 14 días](#etapa-1-modelo-de-datos-y-prueba-de-14-días)
  - [Etapa 2. Lectura del estado](#etapa-2-lectura-del-estado)
  - [Etapa 3. Bloqueo en el servidor](#etapa-3-bloqueo-en-el-servidor)
  - [Etapa 4. Compra con Google Play (4a simulada, 4b real)](#etapa-4-compra-con-google-play)
  - [Etapa 5. Notificaciones RTDN](#etapa-5-notificaciones-rtdn-pubsub-push)
  - [Etapa 6. Retiro del mock e integración final](#etapa-6-retiro-del-mock-e-integración-final)
- [6. Riesgos y decisiones abiertas](#6-riesgos-y-decisiones-abiertas)
- [7. Futuro: App Store](#7-futuro-app-store)
- [8. Registro de decisiones](#8-registro-de-decisiones)

---

## 0. Cómo usar este documento

1. **Una etapa por prompt, en orden (1, 2, 3, 4a, 4b, 5, 6).** Cada etapa deja el backend desplegable y
   los tests en verde. No se adelanta trabajo de una etapa posterior.
2. **Una sola rama y un commit por etapa.** Todo el trabajo del backend va en la rama
   `feature/suscripcion` del backend, que se crea al empezar la etapa 1 desde `main`
   (`git switch -c feature/suscripcion`). Hoy el backend está en `main`. Cada etapa termina con un commit
   (la 4 puede cerrar con dos, uno por subetapa). El frontend sigue en su propia rama
   `feature/suscripcion` (`C:\dev\ticket`); sus cambios de cada etapa se hacen en esa rama.
3. **Antes de cada etapa, volver a verificar el contrato contra el frontend.** Leer de nuevo:
   `src/shared/api/suscripcion.ts` (tipos `SuscripcionSnapshot`, `PagoHistorial`, `ValidarCompraInput`,
   `RestaurarComprasInput`, códigos `SUSCRIPCION_REQUERIDA` y `TIENDA_EN_USO`, función `tieneCodigo`),
   `src/shared/api/compras.ts`, `src/shared/api/tickets.ts`, `src/shared/api/auth.ts` y el README de
   `src/features/suscripcion/`. Comparar con la sección 2 de este documento.
4. **Si el contrato del frontend cambió, se actualiza primero la sección 2 de este documento** (y la 3 si
   afecta a datos) y se deja una fila en la sección 8. Solo después se implementa la etapa.
5. **Reglas del repo que no se negocian** (ver `CLAUDE.md` del backend):
   - Nunca aceptar `usuario_id` del cliente; se toma de `@CurrentUser()`.
   - `synchronize: false`: todo cambio de esquema es una migración en `src/database/migrations/` con
     nombre `<timestamp-ms>-<PascalCase>.ts`. Las de este plan parten de `1787710000000`.
   - Cada entidad nueva se registra en `src/database/data-source.ts` **y** en `src/app.module.ts`.
   - `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` sin `transform`: un campo no
     declarado en un DTO da 400. Los DTO anidados necesitan `@ValidateNested` + `@Type`.
   - Los guards se ejecutan **antes** que los pipes: un guard no ve el body validado (relevante en la
     etapa 3).
6. **Comandos de verificación** de cada etapa:
   - Migraciones: `npx typeorm-ts-node-commonjs -d src/database/data-source.ts migration:run`.
   - Tipos: `npx tsc --noEmit -p tsconfig.json`.
   - Tests: `npm test` y `npm run test:e2e`.
   - Lint solo para revisar: `npx eslint "src/**/*.ts"`. **No usar `npm run lint`**, que aplica `--fix` y
     modifica archivos.
7. **Documentación al cerrar cada etapa:** README del módulo tocado (agente `readme-sync`), `CLAUDE.md`
   del backend (agente `claude-md-sync`, que solo se invoca cuando el usuario lo pide por nombre) y
   `src/features/suscripcion/README.md` del frontend.
8. **Plantilla de prompt para cada etapa:** "Ejecuta la etapa N de `flujo_suscripcion.md`. Primero
   verifica el contrato contra el frontend (sección 0, punto 3). Trabaja en la rama `feature/suscripcion`
   del backend. Cierra con un commit". Escribir siempre en castellano estándar, sin voseo.

---

## 1. Resumen del flujo y de los estados

### 1.1 Flujo en una frase

La cuenta nueva (y, por migración, la existente) recibe una **prueba de 14 días sin tarjeta** controlada
por el servidor. Al terminar, Ticket y Productos se bloquean (Vendido y Usuario no; los reportes nunca).
El usuario paga una **suscripción mensual en Google Play**; la app envía el `purchaseToken` al servidor,
que lo valida con la tienda, lo reconoce (acknowledge) y activa la cuenta. Desde entonces la tienda cobra
y notifica al servidor (RTDN por Pub/Sub) las renovaciones, cancelaciones, cobros fallidos y reembolsos.
El cliente solo consulta `GET /me/suscripcion` y deriva lo que muestra.

### 1.2 Estados del servidor frente a los del cliente

El servidor expone seis valores en `estado` (`EstadoServidorSuscripcion` en el frontend). El cliente
deriva los estados E0–E8 (**sin E6**, eliminado el 2026-10-11) en `src/shared/utils/subscriptionState.ts`
(`derivarEstado`).

| `estado` del servidor | Condición adicional | Estado del cliente | ¿Bloquea Ticket y Productos? |
|---|---|---|---|
| (sin dato / desconocido) | — | E0 `verificando` | No |
| `prueba` | quedan 4 o más días (contando hoy) | E1 `en_prueba` | No |
| `prueba` | quedan 3, 2 o 1 días | E2 `prueba_por_terminar` | No |
| `prueba` | `ahora > prueba_fin` (lo deriva el cliente) | E3 `prueba_vencida` | Sí |
| `prueba_vencida` | — | E3 `prueba_vencida` | Sí |
| `activa` | `renovacion_automatica = true` | E4 `activa` | No |
| `activa` | `renovacion_automatica = false` | E5 `cancelada_vigente` | No |
| `cancelada` | `acceso_hasta` no vencido o `null` | E5 `cancelada_vigente` | No |
| `cancelada` / `activa` sin renovación | `ahora > acceso_hasta` (lo deriva el cliente) | E7 `vencida` | Sí |
| `vencida` | cualquier `motivo` | E7 `vencida` | Sí |
| `pago_en_proceso` | — | E8 `pago_en_proceso` | Sí |

Notas:

- **E1 frente a E2** lo deriva el cliente con `prueba_fin` y `ahora_servidor`: días restantes =
  (día calendario de `prueba_fin` − día calendario de hoy) + 1, en UTC−6. Registro el 3 de marzo, fin el
  16 de marzo: 14 el día 1, 4 el día 11 (E1), 3/2/1 los días 12/13/14 (E2), E3 desde el 17 a las 00:00.
- **Vencimientos locales:** el cliente también aplica `prueba_fin` y `acceso_hasta` contra el reloj
  corregido con `ahora_servidor`, salvo con `errorServidor` (un error de nuestro servidor nunca bloquea).
- **Cobro fallido** (sin período de gracia): la cuenta pasa a `vencida` con `motivo = cobro_fallido`
  desde el primer cobro fallido, y el cliente la trata como E7. Si la tienda recupera el cobro, vuelve a
  `activa` y el cliente muestra "Pago recibido" una vez.
- **Compatibilidad (nota, no es contrato):** el frontend todavía sabe leer un `estado: 'gracia'` y un
  campo `gracia_fin` de datos antiguos (los convierte con `normalizarSnapshot`). El backend **nunca** debe
  enviar ninguno de los dos.

### 1.3 Estado efectivo (lo calcula el servidor)

El servidor guarda un `estado` y, además, calcula un **estado efectivo** en cada lectura y en cada
decisión de bloqueo, con la hora del servidor (`ahora`). No hay un proceso que "actualice" las filas por
el paso del tiempo; el efectivo se deriva:

| Estado guardado | Condición | Estado efectivo | `motivo` efectivo |
|---|---|---|---|
| `prueba` | `ahora > prueba_fin` | `prueba_vencida` | `prueba_terminada` |
| `cancelada` | `acceso_hasta` no nulo y `ahora > acceso_hasta` | `vencida` | `cancelada` |
| `activa` con `renovacion_automatica = false` | `acceso_hasta` no nulo y `ahora > acceso_hasta` | `vencida` | `cancelada` |
| `activa` con `renovacion_automatica = true` | — (no vence por fecha; depende de los eventos de la tienda, ver riesgo R-3) | `activa` | `null` |
| cualquier otro | — | el guardado | el guardado |

El efectivo es el que se devuelve en `GET /me/suscripcion` y en el campo `suscripcion` de auth, y el que
decide el **403 `SUSCRIPCION_REQUERIDA`**: está bloqueada la cuenta cuyo estado efectivo es
`prueba_vencida`, `vencida` o `pago_en_proceso` (E3, E7, E8). Se implementa como una función pura
(`estadoEfectivo(fila, ahora)`) con tests de tabla.

---

## 2. Contrato con el frontend

Debe coincidir **exactamente** con `src/shared/api/suscripcion.ts` del frontend. Convenciones comunes:

- Autenticación: `Authorization: Bearer <access_token>` (`JwtAuthGuard`). El usuario sale de
  `@CurrentUser()`; ningún DTO declara `usuario_id`.
- Nombres de campo en `snake_case`. Fechas en ISO 8601 **con zona** `-06:00`
  (por ejemplo `2026-03-16T23:59:59-06:00`), producidas con una función única
  `aIsoNegocio(date)` del backend (equivalente a la del frontend, `subscriptionDates.ts`). En base de
  datos todo es `timestamptz`.
- Errores en el formato del filtro `HttpErrorsFilter` / Nest: `{ statusCode, message, error }`.
- **Cómo viaja el código de error (compromiso fijado):** el código va **al inicio del `message`**, seguido
  de dos puntos y un texto legible. El frontend lo detecta con `tieneCodigo`, que hace
  `error.messages.some(m => m.includes(CODIGO))` (`ApiError` conserva solo `status` y `messages`). El
  usuario ve el mensaje completo porque `BuscarProductoScreen` muestra `error.messages.join(' ')`.
  Por eso los textos deben ser aptos para el usuario final. **No se usa un campo `code` aparte** (exigiría
  ampliar `ApiError`).

### 2.1 `GET /me/suscripcion`

- Autenticación: Bearer JWT. Sin body ni parámetros. Respuesta `200` con `SuscripcionSnapshot`.
- Consume: `shared/api/suscripcion.ts:getSuscripcion` → `subscriptionStore.ts:refreshSubscription`.
- `ahora_servidor` va **dentro del JSON** del snapshot (no como cabecera) y es obligatorio.
- `historial` va incluido (no existe `GET /me/suscripcion/historial`; el frontend decidió no crearlo).

Campos (los 10 de `SuscripcionSnapshot`):

| Campo | Tipo | Valores |
|---|---|---|
| `estado` | string | `prueba`, `prueba_vencida`, `activa`, `cancelada`, `vencida`, `pago_en_proceso` |
| `prueba_inicio` | string ISO | siempre presente |
| `prueba_fin` | string ISO | siempre presente (obligatorio para el cliente) |
| `acceso_hasta` | string ISO o `null` | fin del mes pagado |
| `proximo_cobro` | string ISO o `null` | `null` si canceló |
| `renovacion_automatica` | boolean | distingue E4 de E5 |
| `tienda` | `google_play`, `app_store` o `null` | `null` antes de la primera compra |
| `motivo` | `prueba_terminada`, `cancelada`, `cobro_fallido`, `reembolso` o `null` | solo con `prueba_vencida` o `vencida` |
| `ahora_servidor` | string ISO | hora del servidor al responder |
| `historial` | `PagoHistorial[]` | pagos más recientes primero (propuesta: máximo 24) |

`PagoHistorial`: `id` (string), `periodo` (`YYYY-MM`), `cobrado_en` (ISO), `monto` (number), `moneda`
(string), `estado` (`pagado`, `reembolsado`, `fallido`).

Ejemplo: cuenta registrada el 3 de marzo, consultada el 10 de marzo a las 10:00.

```json
{
  "estado": "prueba",
  "prueba_inicio": "2026-03-03T09:12:00-06:00",
  "prueba_fin": "2026-03-16T23:59:59-06:00",
  "acceso_hasta": null,
  "proximo_cobro": null,
  "renovacion_automatica": false,
  "tienda": null,
  "motivo": null,
  "ahora_servidor": "2026-03-10T10:00:00-06:00",
  "historial": []
}
```

Ejemplo: cuenta activa (pagó el 14 de marzo durante la prueba; los días restantes de prueba se pierden y
el ciclo empieza el día del pago, pero `prueba_fin` se conserva).

```json
{
  "estado": "activa",
  "prueba_inicio": "2026-03-03T09:12:00-06:00",
  "prueba_fin": "2026-03-16T23:59:59-06:00",
  "acceso_hasta": "2026-04-14T14:05:00-06:00",
  "proximo_cobro": "2026-04-14T14:05:00-06:00",
  "renovacion_automatica": true,
  "tienda": "google_play",
  "motivo": null,
  "ahora_servidor": "2026-03-20T08:00:00-06:00",
  "historial": [
    { "id": "GPA.3301-1234-5678-90123", "periodo": "2026-03", "cobrado_en": "2026-03-14T14:05:00-06:00", "monto": 99, "moneda": "MXN", "estado": "pagado" }
  ]
}
```

Ejemplo: cobro fallido de la renovación (bloqueada, E7). No existe ningún campo extra para este caso.

```json
{
  "estado": "vencida",
  "prueba_inicio": "2026-03-03T09:12:00-06:00",
  "prueba_fin": "2026-03-16T23:59:59-06:00",
  "acceso_hasta": "2026-04-14T14:05:00-06:00",
  "proximo_cobro": null,
  "renovacion_automatica": false,
  "tienda": "google_play",
  "motivo": "cobro_fallido",
  "ahora_servidor": "2026-04-15T09:00:00-06:00",
  "historial": [
    { "id": "fallido-2026-04", "periodo": "2026-04", "cobrado_en": "2026-04-14T14:05:00-06:00", "monto": 99, "moneda": "MXN", "estado": "fallido" },
    { "id": "GPA.3301-1234-5678-90123", "periodo": "2026-03", "cobrado_en": "2026-03-14T14:05:00-06:00", "monto": 99, "moneda": "MXN", "estado": "pagado" }
  ]
}
```

Ejemplo: pago diferido por confirmar (OXXO, E8): `estado: "pago_en_proceso"`, `tienda: "google_play"`,
`acceso_hasta: null`, `proximo_cobro: null`, `renovacion_automatica: false`, `motivo: null`.

Errores: `401` (lo maneja `authenticatedRequest`: refresca y reintenta). Un `5xx` nunca bloquea al cliente.

### 2.2 `POST /me/suscripcion/validar-compra`

- Autenticación: Bearer JWT. Consume: `purchaseFlowStore.ts:validarConServidor` y
  `revisarComprasPendientes` → `shared/api/suscripcion.ts:validarCompra`.
- Request (`ValidarCompraInput`), con un DTO que declare **exactamente** estos tres campos:

```json
{ "tienda": "google_play", "producto_id": "suscripcion_mensual", "token_compra": "kdhfgsd.AO-J1OyXYZ" }
```

  - `tienda`: el tipo del frontend admite `google_play` y `app_store`; en este plan solo se acepta
    `google_play` (`@IsIn(['google_play'])`), cualquier otro valor da 400.
  - `producto_id`: debe ser igual a `PRODUCTO_SUSCRIPCION_ID` del servidor (hoy el frontend envía el
    marcador `'PENDIENTE'` en `src/shared/constants/subscription.ts`; se sustituye por el id real en la
    etapa 4b).
  - `token_compra`: `purchaseToken` de Android. `@IsString @IsNotEmpty @MaxLength(2048)`.
- Respuesta `200` con el snapshot nuevo: `estado: "activa"` (con `acceso_hasta` y `proximo_cobro` un mes
  después, `renovacion_automatica: true`, `tienda: "google_play"`) o `estado: "pago_en_proceso"`. Con
  cualquier otro estado el cliente se queda en "Confirmando tu pago…" y sondea `GET /me/suscripcion` cada
  3 s hasta 30 s.
- **Idempotente:** reenviar el mismo `token_compra` de la misma cuenta devuelve el mismo snapshot, sin
  crear otro pago ni otra compra (el cliente re-valida las compras a medias al iniciar sesión).
- Errores:
  - `409` con `TIENDA_EN_USO` (ver 2.5).
  - `400` si el DTO no valida o la compra es rechazada por la tienda (el cliente no dice "no se pudo
    pagar": se queda confirmando; la tienda pudo haber cobrado).
  - `5xx` / sin red: igual, el cliente sondea.
- El servidor debe: validar con la tienda, ligar la compra a la cuenta, reconocerla (acknowledge) en
  Google Play, deduplicar por `purchase_token` y registrar el pago en el historial.

### 2.3 `POST /me/suscripcion/restaurar`

- Autenticación: Bearer JWT. Consume: `purchaseFlowStore.ts:restaurarCompra` →
  `shared/api/suscripcion.ts:restaurarCompras`.
- Request (`RestaurarComprasInput`), con **body anidado** (`@IsArray`, `@ArrayMaxSize(10)`,
  `@ValidateNested({ each: true })` y `@Type(() => CompraRestaurarDto)`; sin `@Type` el
  `forbidNonWhitelisted` no valida los elementos o los rechaza mal):

```json
{
  "tienda": "google_play",
  "compras": [
    { "producto_id": "suscripcion_mensual", "token_compra": "kdhfgsd.AO-J1OyXYZ" }
  ]
}
```

- Respuesta `200` con el snapshot. Si queda `activa` → pantalla de pago exitoso; `pago_en_proceso` →
  variante efectivo; cualquier otro estado → el cliente muestra "No encontramos una suscripción para
  restaurar…". Por tanto, si no hay ninguna compra válida para la cuenta, se devuelve el snapshot actual
  sin cambios (no un error).
- Mismas reglas que validar: ligar a la cuenta, `409 TIENDA_EN_USO`, deduplicación. Procesa las compras
  del arreglo y devuelve el snapshot final; si una compra pertenece a otra cuenta responde 409.

### 2.4 Campo `suscripcion` en `POST /auth/login`, `POST /auth/register` y `GET /me`

- Se agrega el mismo `SuscripcionSnapshot` (con `historial`) como campo opcional `suscripcion`:
  - en `AuthResponse` (login y register): al nivel de `user` y de los tokens, no dentro de `user`;
  - en `MeResponse` (`GET /me`): como campo del objeto que ya devuelve ese endpoint.
- El frontend hoy lo ignora (`setSubscriptionFromAuth` existe pero no tiene llamadores; `AuthUser` y
  `AuthResponse` no lo declaran). Se conecta en la etapa 2. Con `forbidNonWhitelisted` no hay problema:
  solo afecta a DTO de entrada.
- Si el cálculo del snapshot fallara, login/register/me **no deben fallar**: se omite el campo (es
  opcional) y se registra el error. El cliente cae a `GET /me/suscripcion`.

### 2.5 `409 TIENDA_EN_USO`

- Lo responden `validar-compra` y `restaurar` cuando el `token_compra` ya está ligado a **otra** cuenta de
  la app, o (etapa 4b) cuando el identificador ofuscado de la compra pertenece a otra cuenta.
- Código: `throw new ConflictException('TIENDA_EN_USO: esta cuenta de Google Play ya está en uso por otra cuenta')`.
- El cliente lo detecta con `esErrorTiendaEnUso` (`status === 409` y mensaje que contiene `TIENDA_EN_USO`)
  y muestra su propio texto.

### 2.6 `403 SUSCRIPCION_REQUERIDA` en `POST /tickets` y `POST/PATCH/DELETE /productos`

- Cuando el estado efectivo es `prueba_vencida`, `vencida` o `pago_en_proceso`.
- Código: `throw new ForbiddenException('SUSCRIPCION_REQUERIDA: tu suscripción no está activa')`
  (respuesta `{ "statusCode": 403, "message": "SUSCRIPCION_REQUERIDA: tu suscripción no está activa", "error": "Forbidden" }`).
  El cliente lo detecta con `esErrorSuscripcionRequerida` (`status === 403` y mensaje con el código).
- **No se bloquean:** `GET /productos`, `GET /productos/catalogo` (la búsqueda de `/buscar-producto` debe
  seguir funcionando para la venta en curso), `GET /reportes/*`, `GET /me`, `GET /me/suscripcion`, los
  endpoints de auth y los de compra.
- **Excepción `borrador_iniciado_en`** (solo `POST /tickets`): body opcional

```json
{
  "items": [{ "producto_id": "0b6f2c1e-9f7a-4d1e-8d52-3a1c9f4e7b10", "cantidad": 2 }],
  "borrador_iniciado_en": "2026-03-17T00:05:00-06:00"
}
```

  Regla: la venta se acepta aunque la cuenta esté bloqueada si `borrador_iniciado_en` es anterior al
  momento del bloqueo (`bloqueo_desde`) y todo cae dentro de la ventana
  `VENTANA_BORRADOR_HORAS` (propuesta: 24 h; a definir):
  `bloqueo_desde − ventana ≤ borrador_iniciado_en < bloqueo_desde` y `ahora ≤ bloqueo_desde + ventana`.
  `bloqueo_desde` = `prueba_fin` (prueba vencida), `acceso_hasta` (cancelada vencida) o `estado_desde`
  (cobro fallido, reembolso, pago en proceso). Un `borrador_iniciado_en` futuro o con formato inválido
  da 400 (`@IsOptional @IsISO8601`). Como el guard corre antes que el `ValidationPipe`, la excepción se
  evalúa en `TicketsService` (con el DTO ya validado), no en un guard.
- Hasta que el DTO lo acepte, el frontend no lo envía (`ENVIAR_BORRADOR_INICIADO_EN = false` en
  `shared/api/tickets.ts`, porque `forbidNonWhitelisted` daría 400 a todas las ventas).

### 2.7 `ahora_servidor`

Va en toda respuesta que devuelva un snapshot (`GET /me/suscripcion`, `validar-compra`, `restaurar` y el
campo `suscripcion` de auth). El cliente calcula `desfaseServidorMs = Date.parse(ahora_servidor) −
Date.now()` y lo usa para todas sus decisiones de fechas.

### 2.8 Endpoint push de RTDN (solo servidor a servidor)

- `POST /tienda/google/rtdn` (ruta propuesta). **Sin `JwtAuthGuard`** y con `@SkipThrottle()`. Lo llama
  Pub/Sub (push) con un token OIDC en `Authorization: Bearer …` que se verifica (etapa 5). No lo consume el
  frontend. Responde `2xx` para confirmar el mensaje (cualquier no-2xx hace que Pub/Sub reintente).

### 2.9 Reportes

`GET /reportes/*` **nunca** se bloquea, en ningún estado.

### 2.10 Ampliación pendiente (etapa 4b)

El cliente hoy pasa a la tienda el id de la cuenta (`getMe().id`) como `cuentaId`. Con la tienda real hay
que enviar el identificador ofuscado `cuenta_ofuscada` (sección 3.6), que **solo el servidor puede
calcular** (usa un secreto). Se propone añadir `cuenta_ofuscada` (string) a `GET /me` y a `AuthUser` del
frontend. Es una ampliación del contrato: se documenta aquí y en el README del frontend antes de la etapa
4b (ver regla 4 de la sección 0).

---

## 3. Modelo de datos

Convenciones: UUID con `gen_random_uuid()`; fechas `timestamptz`; nombres de restricciones
`PK_`, `FK_`, `UQ_`, `CHK_`, `IDX_` como las migraciones existentes; montos con `numeric(10,2)` y el
`numericTransformer` (`src/database/transformers/numeric.transformer.ts`).

### 3.1 Diagrama de relaciones

```
usuarios (1) ──────── (1) suscripciones
   │                        │
   │                        └──── (N) compras ──────┐
   │                                                  │ (0..1 por pago)
   ├────────────────────────────────── (N) pagos_historial
   │
   └─ (0..1, SET NULL) ◄── eventos_tienda   (también referencia compras, SET NULL)
```

- `suscripciones.usuario_id` → `usuarios.id` (UNIQUE; 1 a 1).
- `compras.usuario_id` → `usuarios.id`; `compras.suscripcion_id` → `suscripciones.id`.
- `pagos_historial.usuario_id` → `usuarios.id`; `pagos_historial.compra_id` → `compras.id` (puede ser NULL).
- `eventos_tienda.usuario_id` y `eventos_tienda.compra_id`: opcionales (un evento puede llegar sin que se
  conozca la compra).

### 3.2 Tabla `suscripciones`

| Columna | Tipo | Nulo | Default | Restricciones |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | `PK_suscripciones` |
| `usuario_id` | `uuid` | NOT NULL | — | `UQ_suscripciones_usuario_id`; `FK_suscripciones_usuario_id` → `usuarios(id)` **ON DELETE CASCADE** |
| `estado` | `varchar(20)` | NOT NULL | `'prueba'` | `CHK_suscripciones_estado` IN (`prueba`,`prueba_vencida`,`activa`,`cancelada`,`vencida`,`pago_en_proceso`) |
| `prueba_inicio` | `timestamptz` | NOT NULL | — | |
| `prueba_fin` | `timestamptz` | NOT NULL | — | `CHK_suscripciones_prueba` CHECK (`prueba_fin > prueba_inicio`) |
| `acceso_hasta` | `timestamptz` | NULL | — | |
| `proximo_cobro` | `timestamptz` | NULL | — | |
| `renovacion_automatica` | `boolean` | NOT NULL | `false` | |
| `tienda` | `varchar(20)` | NULL | — | `CHK_suscripciones_tienda` CHECK (`tienda IN ('google_play','app_store')`) (varchar con CHECK, no enum, para no romper el contrato del frontend) |
| `motivo` | `varchar(20)` | NULL | — | `CHK_suscripciones_motivo` IN (`prueba_terminada`,`cancelada`,`cobro_fallido`,`reembolso`) |
| `estado_desde` | `timestamptz` | NOT NULL | `now()` | Momento del último cambio de `estado`; base de `bloqueo_desde` y de la ventana de `borrador_iniciado_en` |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

Índices: el UNIQUE de `usuario_id` ya sirve de índice de búsqueda. No hace falta otro.

### 3.3 Tabla `compras`

| Columna | Tipo | Nulo | Default | Restricciones |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | `PK_compras` |
| `usuario_id` | `uuid` | NOT NULL | — | `FK_compras_usuario_id` → `usuarios(id)` ON DELETE CASCADE |
| `suscripcion_id` | `uuid` | NOT NULL | — | `FK_compras_suscripcion_id` → `suscripciones(id)` ON DELETE CASCADE |
| `tienda` | `varchar(20)` | NOT NULL | — | `CHK_compras_tienda` IN (`google_play`,`app_store`) |
| `producto_id` | `varchar(100)` | NOT NULL | — | |
| `purchase_token` | `text` | NOT NULL | — | **`UQ_compras_tienda_purchase_token` UNIQUE (`tienda`, `purchase_token`)** |
| `order_id` | `varchar(100)` | NULL | — | Id de pedido de la tienda (verificar en la documentación oficial) |
| `estado` | `varchar(20)` | NOT NULL | `'pendiente'` | `CHK_compras_estado` IN (`pendiente`,`confirmada`,`reembolsada`,`expirada`) |
| `periodo_inicio` | `timestamptz` | NULL | — | Inicio del período vigente según la tienda |
| `periodo_fin` | `timestamptz` | NULL | — | Fin del período vigente según la tienda |
| `reconocida_en` | `timestamptz` | NULL | — | Momento del acknowledge; NULL = pendiente de reconocer |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

Índices: `IDX_compras_usuario_id` (`usuario_id`), `IDX_compras_suscripcion_id` (`suscripcion_id`).
Nota: un índice B-tree tiene límite de tamaño por entrada (del orden de 2,7 KB); por eso el DTO limita
`token_compra` a 2048 caracteres. Si los tokens reales fueran más largos (a verificar), se cambia el
UNIQUE a un hash del token. Un `purchase_token` de una suscripción se mantiene igual en las renovaciones
(verificar en la documentación oficial), así que hay una fila `compras` por suscripción de la tienda y
varias filas de `pagos_historial` por ella.

### 3.4 Tabla `pagos_historial`

| Columna | Tipo | Nulo | Default | Restricciones |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | `PK_pagos_historial` |
| `usuario_id` | `uuid` | NOT NULL | — | `FK_pagos_historial_usuario_id` → `usuarios(id)` ON DELETE CASCADE |
| `compra_id` | `uuid` | NULL | — | `FK_pagos_historial_compra_id` → `compras(id)` ON DELETE SET NULL |
| `tienda` | `varchar(20)` | NOT NULL | — | `CHK_pagos_historial_tienda` |
| `external_id` | `varchar(100)` | NOT NULL | — | `UQ_pagos_historial_tienda_external_id` UNIQUE (`tienda`, `external_id`). Es el `id` del contrato (ej. `GPA.3301-1234-5678-90123`) |
| `periodo` | `char(7)` | NOT NULL | — | `CHK_pagos_historial_periodo` CHECK (`periodo ~ '^[0-9]{4}-(0[1-9]\|1[0-2])$'`) |
| `cobrado_en` | `timestamptz` | NOT NULL | — | |
| `monto` | `numeric(10,2)` | NOT NULL | — | `CHK_pagos_historial_monto` CHECK (`monto >= 0`); entidad con `numericTransformer` |
| `moneda` | `char(3)` | NOT NULL | `'MXN'` | |
| `estado` | `varchar(20)` | NOT NULL | — | `CHK_pagos_historial_estado` IN (`pagado`,`reembolsado`,`fallido`) |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

Índice: `IDX_pagos_historial_usuario_cobrado` (`usuario_id`, `cobrado_en` DESC).
`periodo` se calcula con el mes de `cobrado_en` en `America/Mexico_City`.

### 3.5 Tabla `eventos_tienda`

| Columna | Tipo | Nulo | Default | Restricciones |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | `PK_eventos_tienda` |
| `tienda` | `varchar(20)` | NOT NULL | `'google_play'` | `CHK_eventos_tienda_tienda` |
| `message_id` | `varchar(100)` | NOT NULL | — | **`UQ_eventos_tienda_message_id` UNIQUE** (idempotencia: el `messageId` de Pub/Sub) |
| `tipo` | `varchar(60)` | NULL | — | Tipo de notificación (ej. `SUBSCRIPTION_RENEWED`; verificar en la documentación oficial) |
| `payload` | `jsonb` | NOT NULL | — | Mensaje completo decodificado |
| `usuario_id` | `uuid` | NULL | — | FK → `usuarios(id)` ON DELETE SET NULL |
| `compra_id` | `uuid` | NULL | — | FK → `compras(id)` ON DELETE SET NULL |
| `recibido_en` | `timestamptz` | NOT NULL | `now()` | |
| `procesado_en` | `timestamptz` | NULL | — | NULL = recibido pero no procesado |
| `resultado` | `varchar(40)` | NULL | — | Ej. `aplicado`, `ignorado`, `compra_desconocida`, `error` |
| `error` | `text` | NULL | — | |

Índice: `IDX_eventos_tienda_recibido_en` (`recibido_en`).

### 3.6 `cuenta_ofuscada` (calculada, no guardada)

`cuenta_ofuscada = HMAC-SHA256(usuario.id, SUSCRIPCION_HMAC_SECRETO)` en hexadecimal (o la codificación
que quepa en el límite).

- **Por qué calculada:** es determinista, no expone el `id` real del usuario a la tienda y no requiere una
  columna ni sincronizar nada. Se usa como `obfuscatedAccountId` de Google Play al comprar y se compara
  con el que devuelve la tienda al validar.
- **Límite de longitud de `obfuscatedAccountId`:** verificar en la documentación oficial (si fuese menor
  que 64 caracteres, se trunca la codificación a la longitud permitida y se documenta).
- **No rotar el secreto:** cambiarlo invalida la correspondencia con las compras ya hechas. Se documenta
  en el README del módulo.
- El frontend no puede calcularlo (no tiene el secreto): lo recibe del servidor (sección 2.10).

### 3.7 Regla de derivación de cada campo del snapshot

Se parte de la fila `suscripciones` y del `ahora` del servidor; `ef = estadoEfectivo(fila, ahora)`.

| Campo | Regla |
|---|---|
| `estado` | `ef.estado` (sección 1.3) |
| `prueba_inicio` | `fila.prueba_inicio` con `aIsoNegocio` |
| `prueba_fin` | `fila.prueba_fin` con `aIsoNegocio`. Nunca cambia al pagar |
| `acceso_hasta` | `fila.acceso_hasta` (nulo si nunca hubo compra, o si `pago_en_proceso` sin compra previa confirmada) |
| `proximo_cobro` | `fila.proximo_cobro` solo si `ef.estado = activa` y `renovacion_automatica = true`; en otro caso `null` |
| `renovacion_automatica` | `fila.renovacion_automatica`; siempre `false` si `ef.estado` no es `activa` |
| `tienda` | `fila.tienda` (`null` hasta la primera compra; `google_play` desde `pago_en_proceso`) |
| `motivo` | `ef.motivo` solo si `ef.estado` es `prueba_vencida` o `vencida`; `null` en cualquier otro caso |
| `ahora_servidor` | `ahora` con `aIsoNegocio` |
| `historial` | filas de `pagos_historial` del usuario, `cobrado_en` descendente, máximo 24, mapeadas a `{ id: external_id, periodo, cobrado_en, monto, moneda, estado }` |

Fechas de la prueba: `prueba_inicio` = momento del registro (o de la migración);
`prueba_fin` = 23:59:59 del día 14 contando el día de inicio, en `America/Mexico_City`
(= día de inicio + 13 días, a las 23:59:59). Ejemplo: registro el 3 de marzo → `2026-03-16T23:59:59-06:00`.
Implementación en SQL: `(date_trunc('day', inicio AT TIME ZONE 'America/Mexico_City') + interval '14 days' - interval '1 second') AT TIME ZONE 'America/Mexico_City'`.
Implementación en TypeScript: helper `finDePrueba(inicio: Date)` en `src/suscripciones/fechas.ts` con
tests (3 de marzo → 16 de marzo 23:59:59-06:00).

### 3.8 Migración de datos de las cuentas existentes (decisión 2)

- Las cuentas existentes reciben **14 días de prueba desde el día de la migración `D`**, que cuenta como
  el **día 1**: `prueba_inicio` = momento de la migración; `prueba_fin` = `D + 13 días` a las 23:59:59 en
  `America/Mexico_City` (el mismo cálculo que un registro; si se migra el 3 de marzo, `prueba_fin` es el
  16 de marzo a las 23:59:59-06:00).
- Se hace en una migración **de datos separada** de la de estructura (etapa 1):
  `1787710000000-CreateSuscripcionesTables.ts` (estructura) y
  `1787720000000-BackfillPruebaSuscripciones.ts` (datos). Esbozo del `up` de la segunda:

```sql
INSERT INTO "suscripciones" ("usuario_id", "estado", "prueba_inicio", "prueba_fin", "estado_desde")
SELECT u."id", 'prueba', now(),
       (date_trunc('day', now() AT TIME ZONE 'America/Mexico_City')
          + interval '14 days' - interval '1 second') AT TIME ZONE 'America/Mexico_City',
       now()
FROM "usuarios" u
WHERE NOT EXISTS (SELECT 1 FROM "suscripciones" s WHERE s."usuario_id" = u."id");
```

- Es idempotente (`NOT EXISTS`). El `down` borra las filas con `estado = 'prueba'` creadas por la
  migración (documentar la limitación: no distingue las creadas por registros posteriores; el `down` de la
  de estructura elimina las tablas completas).

---

## 4. Variables de entorno nuevas

Solo nombres y propósito. Documentarlas en `.env.example` **sin valores** (con un comentario cada una),
como ya se hace con las demás.

| Variable | Para qué sirve |
|---|---|
| `VALIDACION_TIENDA` | `simulada` o `google`. Elige el verificador de compras. `simulada` acepta tokens de prueba y **no debe poder usarse con `NODE_ENV=production`** (fail-fast en el arranque, como `BREVO_API_KEY`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Credenciales de la cuenta de servicio de Google con acceso a la Play Developer API (contenido del JSON, en una línea o en base64) |
| `PLAY_PACKAGE_NAME` | Nombre de paquete de la app en Google Play (`com.canales.ticket`) |
| `PRODUCTO_SUSCRIPCION_ID` | Id del producto de suscripción (el servidor rechaza un `producto_id` distinto) |
| `PUBSUB_PUSH_AUDIENCIA` | Audiencia esperada del token OIDC que Pub/Sub adjunta al push de RTDN |
| `PUBSUB_PUSH_EMAIL` | Correo de la cuenta de servicio que firma el push (se compara con el token) |
| `SUSCRIPCION_HMAC_SECRETO` | Secreto del HMAC-SHA256 de `cuenta_ofuscada`. No se rota |
| `VENTANA_BORRADOR_HORAS` | Ventana de la excepción `borrador_iniciado_en` (por defecto 24) |

Los nombres de las variables de Google/Pub/Sub se confirman en la etapa que las usa, según lo que pida la
librería de cliente elegida (verificar en la documentación oficial).

---

## 5. Etapas

Estructura fija de cada etapa: Objetivo · Analizar · Desarrollar · Integrar con el frontend · Pruebas
manuales · Criterios de aceptación · Fuera de alcance · Documentación a actualizar.

Archivos nuevos previstos del módulo (se crean según la etapa):

```
src/suscripciones/
  suscripciones.module.ts       suscripciones.service.ts        suscripciones.controller.ts
  estado-efectivo.ts            fechas.ts                       README.md
  entities/  suscripcion.entity.ts  compra.entity.ts  pago-historial.entity.ts  evento-tienda.entity.ts
  dto/       validar-compra.dto.ts  restaurar-compras.dto.ts  compra-restaurar.dto.ts
  interfaces/suscripcion-response.interface.ts
  guards/    suscripcion-activa.guard.ts
  verificadores/ verificador-tienda.interface.ts  verificador-simulado.ts  verificador-google.ts
  rtdn/      rtdn.controller.ts  rtdn.service.ts  pubsub-auth.ts          (etapa 5)
```

### Etapa 1. Modelo de datos y prueba de 14 días

**Objetivo.** Crear la rama del backend, las cuatro tablas, sus entidades, la prueba de 14 días para
cuentas nuevas y existentes y `SuscripcionesService.snapshot()` con el estado efectivo. Sin endpoints.

**Analizar.**
- Backend: `CLAUDE.md`; `src/database/data-source.ts` y `src/app.module.ts` (listas de entidades);
  `src/auth/auth.service.ts` (`register`, `toUserResponse`) y `src/auth/auth.module.ts`;
  `src/usuarios/entities/usuario.entity.ts`; `src/database/transformers/numeric.transformer.ts`;
  migración modelo `src/database/migrations/1787680000000-CreatePasswordResetTokens.ts`.
- Frontend: `src/shared/api/suscripcion.ts` (tipos); `src/shared/utils/subscriptionDates.ts`
  (`aIsoNegocio`, UTC−6); `src/shared/utils/subscriptionState.ts`.

**Desarrollar.**
1. `git switch -c feature/suscripcion` desde `main` (backend).
2. Migración de estructura `1787710000000-CreateSuscripcionesTables.ts` (sección 3.2–3.5, con `up` y
   `down`) y migración de datos `1787720000000-BackfillPruebaSuscripciones.ts` (sección 3.8).
3. Entidades (`Suscripcion`, `Compra`, `PagoHistorial` con `numericTransformer`, `EventoTienda`),
   registradas en `data-source.ts` **y** `app.module.ts`.
4. `src/suscripciones/fechas.ts` (`aIsoNegocio`, `finDePrueba`, `periodoNegocio`) y
   `estado-efectivo.ts` (función pura, sección 1.3).
5. `SuscripcionesModule` (`TypeOrmModule.forFeature`, exporta el servicio) y `SuscripcionesService`:
   - `crearPrueba(usuarioId, inicio = ahora)` idempotente (`INSERT … ON CONFLICT (usuario_id) DO NOTHING`);
   - `snapshot(usuario)` que devuelve el `SuscripcionSnapshot` de la sección 2.1 (con historial vacío por
     ahora); si el usuario no tiene fila (carrera con el registro), la crea con
     `prueba_inicio = usuario.createdAt`.
6. En `AuthService.register`, llamar a `crearPrueba` justo después de guardar el usuario (en la misma
   transacción si es viable sin reescribir el flujo; si no, tras el `save` con captura y registro del
   error, ya que `snapshot()` repara la ausencia). No cambiar la respuesta de `register` en esta etapa.
7. Tests unitarios: `estado-efectivo.spec.ts` (tabla de la sección 1.3 con fixtures del 3 de marzo),
   `fechas.spec.ts` (fin de prueba 3 de marzo → 16 de marzo 23:59:59-06:00; cambio de día; `aIsoNegocio`),
   `suscripciones.service.spec.ts` (snapshot por estado; creación idempotente). Test e2e
   `test/suscripcion-prueba.e2e-spec.ts` con Postgres real y el patrón de
   `test/forgot-password.e2e-spec.ts` (insertar usuario por repositorio, limpiar en `afterAll`): tras crear
   un usuario y llamar a `crearPrueba`, la fila existe y `prueba_fin` es el día 14 a las 23:59:59.
8. `src/suscripciones/README.md` (módulo nuevo, con el formato de los demás README).
9. `.env.example`: no se necesitan variables todavía.

**Integrar con el frontend.** Ninguno. (Opcional: dejar anotada en
`src/features/suscripcion/README.md` la existencia de las tablas.)

**Pruebas manuales.**
- `npx typeorm-ts-node-commonjs -d src/database/data-source.ts migration:run` y revisar con `psql`:
  `SELECT usuario_id, estado, prueba_inicio, prueba_fin FROM suscripciones;` (una fila por usuario).
- Registrar una cuenta nueva con `POST /auth/register` (campos de `RegisterDto`: `email`, `password`,
  `phone`, `aceptoTerminos`) y comprobar la fila en `suscripciones`.
- Probar `migration:revert` dos veces y volver a ejecutar `migration:run`.

**Criterios de aceptación.**
- La rama `feature/suscripcion` existe en el backend y el commit de la etapa está sobre ella.
- `migration:run` crea las cuatro tablas con todas las restricciones de la sección 3 y backfillea todas
  las cuentas; `migration:revert` las deshace sin error.
- Toda cuenta (existente o nueva) tiene exactamente una fila; `prueba_fin` es el día 14 a las 23:59:59
  (America/Mexico_City), por ejemplo 3 de marzo → 16 de marzo.
- `snapshot()` devuelve los 10 campos del contrato con los tipos correctos y `ahora_servidor` en ISO con
  `-06:00`.
- `npx tsc --noEmit -p tsconfig.json`, `npx eslint "src/**/*.ts"` (solo revisión), `npm test` y
  `npm run test:e2e` pasan.

**Fuera de alcance.** Endpoints, campo en auth, bloqueo, compras, RTDN, cambios en el frontend.

**Documentación a actualizar.** `src/suscripciones/README.md` (nuevo); README de `src/auth` (alta de la
prueba al registrarse); `src/usuarios/README.md` (relación con `suscripciones`); `CLAUDE.md` del backend
(estructura de carpetas, número de migraciones, módulo nuevo) con `claude-md-sync`; en el frontend,
`src/features/suscripcion/README.md` (sección "Checklist para el backend": marcar el punto 1 y 2).

### Etapa 2. Lectura del estado

**Objetivo.** `GET /me/suscripcion` con historial y `ahora_servidor`, y el campo `suscripcion` en login,
register y `GET /me`. Conectar el frontend a la lectura real.

**Analizar.**
- Backend: `src/auth/auth.controller.ts`, `auth.service.ts` (`login`, `register`, `toMeResponse`),
  `auth.module.ts`, `interfaces/auth-response.interface.ts`; `src/suscripciones/` de la etapa 1.
- Frontend: `src/shared/api/suscripcion.ts` (`getSuscripcion`, `normalizarSnapshot`);
  `src/shared/api/compras.ts` (el adaptador usa `USE_SUBSCRIPTION_MOCK`);
  `src/shared/api/auth.ts` (`AuthUser`, `AuthResponse`, `getMe`);
  `src/shared/store/subscriptionStore.ts` (`setSubscriptionFromAuth`, `aplicarSnapshotDelServidor`);
  `src/shared/store/sessionStore.ts`; `src/features/auth/LoginScreen.tsx` y `RegisterScreen.tsx`.

**Desarrollar.**
1. `SuscripcionesController` con `GET /me/suscripcion` (`@UseGuards(JwtAuthGuard)`,
   `@CurrentUser()`, `200`); el servicio añade `historial` (24 pagos más recientes).
2. `AuthModule` importa `SuscripcionesModule`. `AuthService` inyecta `SuscripcionesService` y añade
   `suscripcion` a la respuesta de `login`, `register` y `toMeResponse` (tipos: `AuthResponse`
   y `MeResponse` con `suscripcion?: SuscripcionSnapshot`). Si el cálculo falla, se omite el campo y se
   registra el error (sin romper el login).
3. `toMeResponse` hoy es síncrono (`me()` devuelve `MeResponse`): pasa a ser asíncrono; ajustar el
   controller y los tests existentes de `auth.service.spec.ts`.
4. Tests unitarios (servicio, controller) y e2e: `GET /me/suscripcion` con prueba vigente, con prueba
   vencida (forzando `prueba_fin` en el pasado por repositorio) y con 401 sin token; login/register/me
   incluyen `suscripcion`.

**Integrar con el frontend.**
- `src/shared/api/auth.ts`: añadir `suscripcion?: SuscripcionSnapshotLegado` (tipo importado con
  `import type` de `suscripcion.ts`) a `AuthUser` y a `AuthResponse`.
- Conectar `setSubscriptionFromAuth(normalizarSnapshot(res.suscripcion))` en `LoginScreen`,
  `RegisterScreen` y en `sessionStore` (carga de sesión con `getMe()`), solo cuando el campo venga.
- Revisar `normalizarSnapshot`: el backend nunca envía los campos de compatibilidad, pero la función se
  conserva para leer cachés antiguas.
- **Advertencia:** `USE_SUBSCRIPTION_MOCK` también apaga `comprasMock` (`compras.ts` elige el adaptador
  con el mismo interruptor). Al poner `false` para probar la lectura real, el flujo de compra pasa al
  adaptador real, que es un stub que siempre responde error, y las filas "DEV: …" desaparecen. Propuesta
  para seguir probando compras hasta la etapa 4a: **separar el interruptor de compras** en una constante
  propia (por ejemplo `USE_PURCHASES_MOCK = __DEV__ && true` en `compras.ts`) y usarla solo para elegir
  el adaptador; `USE_SUBSCRIPTION_MOCK` queda para `suscripcion.ts`. Con la etapa 4a, los tokens que
  genera `comprasMock` (`mock-compra-`, `mock-pendiente-`, `mock-tienda-en-uso-`, `mock-compra-a-medias-`)
  son los que acepta el verificador simulado del servidor.
- En esta etapa se prueba con `USE_SUBSCRIPTION_MOCK = false` y `USE_PURCHASES_MOCK = true`. Las compras no
  se prueban aún contra el servidor (el endpoint no existe hasta la 4a).

**Pruebas manuales.**
- `curl -s http://localhost:3000/me/suscripcion -H "Authorization: Bearer $TOKEN"` para una cuenta nueva
  y una cuenta migrada.
- `POST /auth/login` y `GET /me` muestran `suscripcion`.
- En la app: iniciar sesión, ver "Prueba: N días" en el panel; en base de datos mover `prueba_fin` al
  pasado y comprobar que Ticket y Productos se bloquean al refrescar (la hoja de pago y el candado salen
  del snapshot, aunque el servidor todavía no rechaza escrituras).

**Criterios de aceptación.**
- La respuesta de `GET /me/suscripcion` tiene exactamente los campos de la sección 2.1; con prueba
  vigente `estado = prueba`; con `prueba_fin` pasado `estado = prueba_vencida` y
  `motivo = prueba_terminada`.
- `suscripcion` aparece en login, register y `GET /me` y es idéntico al de `GET /me/suscripcion`.
- El frontend arranca con `USE_SUBSCRIPTION_MOCK = false`, muestra el estado real y `tsc` pasa con
  el interruptor en `true` y en `false`.
- Un error del cálculo del snapshot no rompe login/register/me.

**Fuera de alcance.** Bloqueo con 403, compras, RTDN, retiro de mocks, `GET /me/suscripcion/historial`.

**Documentación a actualizar.** READMEs de `src/auth` (campo `suscripcion`) y `src/suscripciones`
(endpoint); `CLAUDE.md` del backend con `claude-md-sync`; frontend: `src/features/suscripcion/README.md`
(secciones b y j: `suscripcion` en auth ya conectado; interruptor de compras separado) y
`src/features/auth/README.md` si cambia el flujo de login.

### Etapa 3. Bloqueo en el servidor

**Objetivo.** Rechazar con `403 SUSCRIPCION_REQUERIDA` las escrituras de tickets y productos cuando el
estado efectivo es E3, E7 o E8, con la excepción de la venta en curso (`borrador_iniciado_en`).

**Analizar.**
- Backend: `src/tickets/` (controller, `tickets.service.ts`, `dto/create-ticket.dto.ts`,
  `tickets.module.ts`); `src/productos/` (controller, service, DTO, módulo);
  `src/reportes/` (confirmar que no se toca); `src/main.ts` (formato de error).
- Frontend: `src/shared/api/tickets.ts` (`ENVIAR_BORRADOR_INICIADO_EN`, `createTicket`);
  `src/features/ticket/BuscarProductoScreen.tsx` (`handleConfirmGuardar`, 403, modo 4.4);
  `src/features/ticket/hooks/useTicketDraft.ts` (`iniciadoEn`); `src/features/productos/` (no maneja el
  403 de forma específica).

**Desarrollar.**
1. `SuscripcionesService.estaBloqueada(usuarioId)` y
   `assertPuedeEscribir(usuarioId, { borradorIniciadoEn? })` que lanza
   `ForbiddenException('SUSCRIPCION_REQUERIDA: tu suscripción no está activa')`. Calcula
   `bloqueo_desde` y aplica la ventana de la sección 2.6 (`VENTANA_BORRADOR_HORAS`, por defecto 24).
2. `SuscripcionActivaGuard` (se ejecuta después de `JwtAuthGuard`, usa `request.user`) para
   `POST /productos`, `PATCH /productos/:id`, `DELETE /productos/:id`. **No** se aplica a los `GET` de
   productos ni a reportes.
3. `POST /tickets`: no usa el guard (los guards corren antes del pipe y no ven el body validado); llama a
   `assertPuedeEscribir` desde `TicketsService.create` con `dto.borrador_iniciado_en`. `CreateTicketDto`
   añade `borrador_iniciado_en?: string` con `@IsOptional() @IsISO8601()`. `TicketsModule` y
   `ProductosModule` importan `SuscripcionesModule`.
4. Tests unitarios (estados bloqueados y no bloqueados; ventana con límites exactos; borrador futuro
   da 400) y e2e (prueba vencida: `POST /tickets` 403 y `POST /productos` 403 con el mensaje exacto;
   `GET /reportes/*` 200; con `borrador_iniciado_en` dentro de ventana 201).
5. **Orden de despliegue:** el backend con el DTO nuevo se despliega **antes** de activar la constante
   del frontend.

**Integrar con el frontend.**
- `src/shared/api/tickets.ts`: `ENVIAR_BORRADOR_INICIADO_EN = true`.
- Probar la venta en curso en `BuscarProductoScreen` y `useTicketDraft`: armar un ticket, forzar el
  bloqueo en base de datos (mover `prueba_fin` justo después de `iniciadoEn`) y guardar; debe aceptarse
  dentro de la ventana y rechazarse fuera de ella (el cliente conserva el borrador y llama a
  `refreshSubscription`).
- Opcional: manejo específico del 403 en `features/productos` (pendiente 16 del README del frontend).

**Pruebas manuales.**
- `UPDATE suscripciones SET prueba_fin = now() - interval '1 hour' WHERE usuario_id = '<id>';` y luego
  `curl -i -X POST /tickets …` → `403` con `SUSCRIPCION_REQUERIDA: tu suscripción no está activa`.
- Mismo `POST /tickets` con `"borrador_iniciado_en"` anterior al bloqueo y dentro de 24 h → `201`.
- `GET /reportes/...` → `200` con la cuenta bloqueada.
- En la app: el mensaje 403 aparece en el modal "¿Desea guardar el ticket?" con el código incluido.

**Criterios de aceptación.**
- Estados `prueba_vencida`, `vencida` y `pago_en_proceso` rechazan `POST /tickets` y `POST/PATCH/DELETE
  /productos` con `403` y el mensaje fijado; `prueba`, `activa` y `cancelada` vigente no.
- Los `GET` de productos y todos los reportes funcionan siempre.
- `POST /tickets` acepta `borrador_iniciado_en` y no devuelve 400 a un body sin él.
- La ventana se aplica por ambos lados y es configurable por `VENTANA_BORRADOR_HORAS`.
- Los tests existentes de tickets y productos siguen en verde.

**Fuera de alcance.** Compras, RTDN, mocks, manejo de UI del 403 en Productos (salvo lo opcional).

**Documentación a actualizar.** READMEs de `src/tickets` y `src/productos` (403 y
`borrador_iniciado_en`), `src/suscripciones`; `.env.example` (`VENTANA_BORRADOR_HORAS`); `CLAUDE.md` del
backend con `claude-md-sync`; frontend: README de suscripción (secciones b y j: 403 y borrador conectados).

### Etapa 4. Compra con Google Play

Las dos subetapas comparten endpoints, DTO, tablas y reglas (`TIENDA_EN_USO`, deduplicación, historial);
solo cambia el **verificador**, detrás de una interfaz. La 4a permite integrar el frontend sin esperar las
credenciales ni el producto en Play Console.

Interfaz común (esbozo):

```ts
interface VerificadorTienda {
  verificar(input: { productoId: string; tokenCompra: string }): Promise<ResultadoVerificacion>;
  reconocer(tokenCompra: string): Promise<void>;                 // acknowledge
}
// ResultadoVerificacion: { estado: 'activa' | 'pendiente' | 'rechazada'; orderId; periodoInicio; periodoFin;
//   autoRenovacion; cuentaOfuscada?; monto?; moneda?; }
```

Selección por `VALIDACION_TIENDA` con un proveedor de Nest (`useFactory`).

#### Etapa 4a. Compra con verificador simulado

**Objetivo.** `validar-compra` y `restaurar` completos en el servidor (deduplicación, `TIENDA_EN_USO`,
historial, `pago_en_proceso`) con un verificador simulado que acepta tokens de prueba.

**Analizar.**
- Backend: `src/suscripciones/` (etapas 1–3); `src/main.ts` (errores); `src/auth/auth.service.ts`
  (patrón de captura de violaciones únicas, `QueryFailedError` / código `23505`).
- Frontend: `src/shared/api/suscripcion.ts` (`ValidarCompraInput`, `RestaurarComprasInput`,
  `esErrorTiendaEnUso`); `src/shared/store/purchaseFlowStore.ts` (`validarConServidor`,
  `revisarComprasPendientes`, `restaurarCompra`, sondeo); `src/shared/api/comprasMock.ts` (formas de token
  y escenarios); README de suscripción (secciones b y g).

**Desarrollar.**
1. DTO `ValidarCompraDto` (`tienda`, `producto_id`, `token_compra`), `RestaurarComprasDto` y
   `CompraRestaurarDto` (anidado con `@ValidateNested({ each: true })` + `@Type`).
2. `VerificadorSimulado` (activo con `VALIDACION_TIENDA=simulada`): según el prefijo del token,
   `mock-compra-…` → `activa` (periodo: ahora y ahora + 1 mes); `mock-pendiente-…` → `pendiente`;
   `mock-tienda-en-uso-…` → simula que la compra ya pertenece a otra cuenta (409); `mock-compra-a-medias-…`
   → como `mock-compra-`; cualquier otro → `rechazada` (400). Monto y moneda provisionales y marcados
   como tales (por ejemplo 99.00 MXN).
3. `SuscripcionesService.validarCompra(usuario, dto)` en una transacción con
   `SELECT … FOR UPDATE` sobre la fila `suscripciones` del usuario:
   - producto distinto de `PRODUCTO_SUSCRIPCION_ID` → 400;
   - buscar `compras` por (`tienda`, `purchase_token`): misma cuenta → devolver el snapshot actual
     (idempotente); otra cuenta → `ConflictException('TIENDA_EN_USO: esta cuenta de Google Play ya está en uso por otra cuenta')`;
   - verificar; `activa` → insertar `compras` (`confirmada`, `reconocida_en`), `pagos_historial`
     (`pagado`) y actualizar `suscripciones` (`estado = activa`, `acceso_hasta`/`proximo_cobro` = fin del
     período, `renovacion_automatica = true`, `tienda = google_play`, `motivo = null`, `estado_desde`);
     `pendiente` → `compras` (`pendiente`) y `estado = pago_en_proceso`;
   - capturar la violación del UNIQUE (`23505`) por carrera y repetir la lectura (misma regla de
     idempotencia o 409);
   - devolver el snapshot con `historial` y `ahora_servidor`.
   - Una cuenta ya `activa` con renovación no crea otra suscripción: se trata como "Restaurar" (ver R-2).
4. `restaurar(usuario, dto)`: aplica la misma regla a cada compra del arreglo, ignora las inválidas sin
   fallar y devuelve el snapshot final (si no hay nada que restaurar, el snapshot actual).
5. `SuscripcionesController`: `POST /me/suscripcion/validar-compra` y `POST /me/suscripcion/restaurar`
   (`200`, `JwtAuthGuard`, `@Throttle` propuesto de 10 por minuto).
6. Tests: unitarios del servicio (activa, pendiente, idempotencia, otra cuenta, carrera simulada, producto
   erróneo); e2e con `VALIDACION_TIENDA=simulada`: pagar, repetir el mismo token (mismo snapshot, un solo
   pago), pagar con el mismo token desde otra cuenta (409), pago pendiente, `restaurar`.

**Integrar con el frontend.**
- Poner `USE_SUBSCRIPTION_MOCK = false` y mantener `USE_PURCHASES_MOCK = true` (etapa 2): `comprasMock`
  genera tokens `mock-…` que el servidor simulado valida de verdad.
- Probar en la app: pagar (E3 → E4 y pantalla de pago exitoso), compra pendiente (E8 y "Revisar de
  nuevo"), `TIENDA_EN_USO` (texto "Esta cuenta de Google Play ya está en uso por otra cuenta"), compra
  a medias (cerrar la app tras comprar; al iniciar sesión se re-valida), "Restaurar compra".
- Sin cambios de código obligatorios en el frontend si el contrato coincide.

**Pruebas manuales.**
- `curl -s -X POST localhost:3000/me/suscripcion/validar-compra -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{"tienda":"google_play","producto_id":"<PRODUCTO_SUSCRIPCION_ID>","token_compra":"mock-compra-123"}'`
  → `estado: "activa"`; repetirlo → mismo snapshot; con otra cuenta → `409`.
- Con `mock-pendiente-1` → `pago_en_proceso`.
- Un body con un campo extra → `400` (por `forbidNonWhitelisted`).

**Criterios de aceptación.**
- Respuestas idénticas a los ejemplos de la sección 2; `409` y `400` con los mensajes fijados.
- Reenviar el mismo token no crea otra fila en `compras` ni en `pagos_historial`.
- Con `VALIDACION_TIENDA=simulada` y `NODE_ENV=production` el arranque falla.
- Dos validaciones concurrentes del mismo token dejan una sola compra (probado).
- `tsc`, eslint (solo revisión), `npm test` y `npm run test:e2e` pasan.

**Fuera de alcance.** Llamadas reales a Google, acknowledge real, RTDN, librería IAP, retiro de mocks.

**Documentación a actualizar.** README de `src/suscripciones` (endpoints, verificador simulado, tokens de
prueba); `.env.example` (`VALIDACION_TIENDA`, `PRODUCTO_SUSCRIPCION_ID`); `CLAUDE.md` del backend con
`claude-md-sync`; frontend: README de suscripción (sección g: servidor simulado en lugar de mock del
cliente; sección j).

#### Etapa 4b. Compra con verificador real (Google Play Developer API)

**Objetivo.** Reemplazar el verificador simulado por uno real, con acknowledge y comprobación de
`cuenta_ofuscada`, e instalar la compra real en la app.

**Analizar.**
- Backend: `src/suscripciones/verificadores/` (4a); configuración (`ConfigService`).
- Frontend: `src/shared/api/compras.ts` (`AdaptadorCompras`, `adaptadorReal` stub, `cuentaId`);
  `src/shared/store/purchaseFlowStore.ts` (`cuentaId` hoy es `getMe().id`);
  `src/shared/constants/subscription.ts` (`PRODUCTO_SUSCRIPCION_ID`, `PAQUETE_ANDROID`); `app.json`.
- Documentación oficial de Google (todo lo siguiente: **verificar en la documentación oficial**).

**Desarrollar.**
1. `VerificadorGoogle`: consulta la compra en Google Play con la Play Developer API
   (`purchases.subscriptionsv2.get`: verificar en la documentación oficial; elegir la librería de cliente
   —por ejemplo `googleapis`— y confirmar que funciona con la versión de Node del proyecto).
2. Interpretar el estado de la suscripción (activa, pendiente de pago, etc.) y las fechas del período
   (verificar en la documentación oficial los nombres de campos y estados).
3. **Acknowledge** de la compra tras validarla y ligarla (`purchases.subscriptions.acknowledge` o el método
   equivalente: verificar en la documentación oficial). Sin acknowledge Google reembolsa la compra pasados
   unos días (el frontend documenta 3; verificar en la documentación oficial). Si el acknowledge falla,
   dejar `reconocida_en = NULL` y reintentar en la siguiente lectura o notificación; no fallar la
   activación.
4. **Comprobar `cuenta_ofuscada`:** comparar el identificador de cuenta ofuscado que la API devuelve con
   `HMAC-SHA256(usuario.id)`; si pertenece a otra cuenta → `409 TIENDA_EN_USO`. Si la compra no trae
   identificador (verificar en la documentación oficial), decidir si se rechaza o se liga (a decidir).
5. Exponer `cuenta_ofuscada` en `GET /me` (sección 2.10), calculado con `SUSCRIPCION_HMAC_SECRETO`.
6. Tests unitarios con el cliente de Google simulado (jest mock): activa, pendiente, token inválido,
   cuenta ofuscada ajena, fallo de acknowledge. **No** se usan llamadas reales en CI.
7. `.env.example`: `GOOGLE_SERVICE_ACCOUNT_JSON`, `PLAY_PACKAGE_NAME`, `SUSCRIPCION_HMAC_SECRETO`.

**Integrar con el frontend.**
- Elegir y verificar la librería IAP contra Expo 57 y React Native 0.86, con build de desarrollo
  (`expo-dev-client`; no funciona en Expo Go). Candidatas citadas en el README del frontend: `expo-iap`,
  `react-native-iap`, `react-native-purchases` (verificar compatibilidad, mantenimiento y plugin de
  config antes de elegir).
- `src/shared/api/compras.ts`: implementar `adaptadorReal` (`obtenerPrecio`, `comprarSuscripcion`,
  `comprasDisponibles`, `terminarTransaccion`), incluido el listener de compras para las compras a medias.
- `src/shared/store/purchaseFlowStore.ts`: usar `cuenta_ofuscada` de `GET /me` en lugar de `getMe().id` como
  `cuentaId`; ampliar `AuthUser` en `auth.ts` con `cuenta_ofuscada?: string`.
- Sustituir `PRODUCTO_SUSCRIPCION_ID = 'PENDIENTE'` por el id real (también aparece en la URL de
  gestión de Google Play de `urlGestionar`) y mostrar el precio de la tienda.
- Quitar `comprasMock.ts`, el interruptor `USE_PURCHASES_MOCK` y la fila "DEV: próxima compra"
  (`devResultadoCompraActual` / `devRotarResultadoCompra` en `compras.ts`, y su uso en
  `features/cuenta/UserSidePanel.tsx`).
- Crear el producto de suscripción en Play Console y registrar los license testers (ver R-5).

**Pruebas manuales.**
- Con `VALIDACION_TIENDA=google` y una cuenta de licencia de prueba: comprar en la app, ver la fila en
  `compras` con `reconocida_en` no nulo, el pago en `pagos_historial` y el snapshot `activa`.
- Comprar con una segunda cuenta de la app usando la misma cuenta de Google Play → `409 TIENDA_EN_USO`.
- Compra con método diferido (si el entorno de pruebas lo permite) → `pago_en_proceso`.
- Cerrar la app a mitad de la compra y reabrir: la compra se valida en silencio.

**Criterios de aceptación.**
- Una compra real de prueba termina en `activa` con acknowledge confirmado.
- Una compra ligada a otra cuenta (por `cuenta_ofuscada` o por token) da 409.
- No quedan referencias a `comprasMock` en el frontend; `tsc` pasa.
- Las credenciales no aparecen en logs ni en el repositorio.

**Fuera de alcance.** RTDN, App Store, retiro de `suscripcionMock`.

**Documentación a actualizar.** README de `src/suscripciones` (verificador real, variables, `cuenta_ofuscada`),
README de `src/auth` (`GET /me` con `cuenta_ofuscada`); `.env.example`; `CLAUDE.md` con `claude-md-sync`;
frontend: README de suscripción (secciones b, g y j) y `flujo_subscripcion.md` si procede.

### Etapa 5. Notificaciones RTDN (Pub/Sub push)

**Objetivo.** Mantener el estado de la cuenta al día con las notificaciones de Google Play (Real-time
Developer Notifications) entregadas por Pub/Sub push (verificar en la documentación oficial), con
idempotencia y las transiciones de estado definidas.

**Analizar.**
- Backend: `src/suscripciones/` (servicio, verificador real, entidades `EventoTienda`);
  `src/main.ts` (el filtro de errores y el límite de body de 1 MB).
- Frontend: README de suscripción (secciones b "Notificaciones de las tiendas" y f; "Pago recibido" en
  `avisosStore`); `src/shared/store/subscriptionStore.ts` (cuándo vuelve a consultar).
- Documentación oficial: formato del mensaje de RTDN, tipos de notificación, autenticación del push
  (verificar en la documentación oficial).

**Desarrollar.**
1. Configuración externa (no es código): tema y suscripción push de Pub/Sub, y el tema de RTDN en Play
   Console (verificar en la documentación oficial).
2. `RtdnController`: `POST /tienda/google/rtdn`, sin `JwtAuthGuard`, con `@SkipThrottle()`. El body usa
   una `interface` (no una clase DTO), porque `forbidNonWhitelisted` rechazaría campos que Pub/Sub añada.
   Validar a mano la forma mínima (`message.data`, `message.messageId`).
3. **Verificación del push:** comprobar el token OIDC del encabezado `Authorization` (firma, audiencia
   `PUBSUB_PUSH_AUDIENCIA`, correo `PUBSUB_PUSH_EMAIL`; verificar en la documentación oficial). Con
   `VALIDACION_TIENDA=simulada` la verificación se puede omitir **solo fuera de producción**, para probar
   con `curl`.
4. **Idempotencia:** `INSERT INTO eventos_tienda … ON CONFLICT (message_id) DO NOTHING`; si ya existía y
   estaba procesado, responder `2xx` sin hacer nada. Guardar `payload`, `tipo`, `resultado`, `error`.
5. **Procesamiento:** decodificar `message.data` (base64 → JSON). Para una notificación de suscripción,
   usar el `purchaseToken` para localizar la fila `compras` y **consultar el estado actual** a la tienda
   (`purchases.subscriptionsv2.get`: verificar en la documentación oficial) en lugar de fiarse solo del
   tipo de notificación; así el orden de llegada no importa. Compra desconocida → `resultado =
   compra_desconocida` y `2xx`. Notificación de prueba → `2xx`.
6. **Transiciones** (los nombres de los tipos de notificación están sujetos a verificar en la
   documentación oficial):

| Evento de la tienda | Transición en el servidor |
|---|---|
| Renovada | `activa`, `renovacion_automatica = true`, `acceso_hasta` y `proximo_cobro` = nuevo fin de período, `motivo = null`; nueva fila `pagos_historial` (`pagado`, `external_id` = id del pedido, deduplicada) |
| Cancelada (el usuario desactiva la renovación) | `cancelada`, `renovacion_automatica = false`, `proximo_cobro = null`, `acceso_hasta` se conserva |
| Cobro fallido, cuenta en espera (on hold) o en reintento de cobro (la tienda lo avisa, p. ej. `IN_GRACE_PERIOD` o `ON_HOLD`; nombres: verificar en la documentación oficial) | `vencida` con `motivo = cobro_fallido` desde el primer aviso, `renovacion_automatica = false`; fila `pagos_historial` `fallido` (id determinista, p. ej. `fallido-<AAAA-MM>`) |
| Recuperada (la tienda logra cobrar) | `activa` con el nuevo período, `motivo = null`; pago `pagado` |
| Reactivada tras cancelar (restarted) | `activa`, `renovacion_automatica = true` (sin cobro inmediato) |
| Revocada o reembolsada | `vencida` con `motivo = reembolso`; el pago correspondiente pasa a `reembolsado` |
| Expirada | `vencida` con `motivo = cancelada` si venía cancelada; si no, `cobro_fallido` |
| Pago diferido confirmado (compra pendiente que se completa) | `activa` y pago `pagado`; acknowledge si faltaba |

7. Cada transición actualiza `estado_desde`. Tras procesar, `procesado_en = now()`.
8. Tests: unitarios del mapeo (tabla anterior) con un verificador falso; e2e que envía mensajes con
   `message_id` repetido (un solo efecto), compra desconocida, orden invertido y push sin token (401/403).

**Integrar con el frontend.**
- Sin cambios de código obligatorios (el cliente vuelve a consultar al primer plano, al enfocar pestañas o
  con "Actualizar").
- Probar con la app: pago recibido tras cobro fallido (E7 `cobro_fallido` → E4 muestra "Pago recibido" una
  vez), cancelar en Google Play y verificar E5, reactivar y verificar E4, reembolso (E7 con texto de
  reembolso).
- Quitar la fila "DEV: simular aviso de la tienda" y el arreglo `avisosTiendaDev` de
  `features/cuenta/UserSidePanel.tsx`, junto con `devAvanzar` en `shared/api/suscripcion.ts` (si la etapa 6
  no los ha quitado ya).

**Pruebas manuales.**
- Con `VALIDACION_TIENDA=simulada` (fuera de producción): `curl -X POST localhost:3000/tienda/google/rtdn
  -H "content-type: application/json" -d '{"message":{"data":"<base64>","messageId":"t1"},"subscription":"x"}'`
  repetido dos veces → el segundo no cambia nada.
- Con la tienda real: cancelar y reactivar desde la página de suscripciones de Google Play con una cuenta
  de licencia de prueba y observar la fila en `eventos_tienda` y el snapshot.

**Criterios de aceptación.**
- Cada transición de la tabla se prueba con un test.
- Un `message_id` repetido no duplica pagos ni cambia el estado.
- Un push sin token válido es rechazado; uno válido con evento desconocido se confirma (`2xx`).
- Ningún evento queda sin fila en `eventos_tienda`.

**Fuera de alcance.** Reconciliación periódica contra la API (ver R-3), App Store, retiro de mocks.

**Documentación a actualizar.** README de `src/suscripciones` (RTDN, tabla de transiciones, configuración
de Pub/Sub); `.env.example` (`PUBSUB_PUSH_AUDIENCIA`, `PUBSUB_PUSH_EMAIL`); `CLAUDE.md` con
`claude-md-sync`; frontend: README de suscripción (sección b: notificaciones implementadas).

### Etapa 6. Retiro del mock e integración final

**Objetivo.** Eliminar todo lo simulado del frontend, dejar la documentación al día y hacer una prueba de
punta a punta en Android. **App Store e iOS quedan fuera.**

**Analizar.**
- Frontend: sección g ("Retirar el mock", lista exacta) del README `src/features/suscripcion/README.md`;
  `src/shared/api/suscripcion.ts`, `src/shared/api/compras.ts`, `src/shared/api/suscripcionMock.ts`,
  `src/shared/api/comprasMock.ts`, `src/features/cuenta/UserSidePanel.tsx`.
- Backend: todo `src/suscripciones/` (estado final de los README y del verificador).

**Desarrollar (en el frontend, en su rama `feature/suscripcion`).** Seguir la lista del README:
1. `shared/api/suscripcion.ts`: quitar `USE_SUBSCRIPTION_MOCK`, el import `* as mock`, las ramas
   `if (USE_SUBSCRIPTION_MOCK)` de `getSuscripcion`, `validarCompra` y `restaurarCompras`, y las
   funciones `devEscenarioActual`, `devRotarEscenario`, `devAvanzar`, `devSinRed`, `devAlternarSinRed`
   (y los imports de `AsyncStorage` y `CLAVE_AVISO_PRUEBA_FECHA` si dejan de usarse). Se conservan el tipo
   legado y `normalizarSnapshot` para leer cachés antiguas.
2. `shared/api/compras.ts`: quitar `import * as comprasMock`, la selección del adaptador y las funciones
   `devResultadoCompraActual` / `devRotarResultadoCompra`.
3. Borrar `shared/api/suscripcionMock.ts` y `shared/api/comprasMock.ts`.
4. `features/cuenta/UserSidePanel.tsx`: quitar los imports `dev*`, los estados `escenarioDev`,
   `compraDev`, `sinRedDev`, los handlers `handlePressEscenarioDev`, `handlePressRepetirBienvenidaDev`,
   `handlePressCompraDev`, `handlePressSinRedDev`, `handlePressAvisoTiendaDev`, el arreglo
   `avisosTiendaDev` y el bloque `if (__DEV__ && escenarioDev !== null)`.
5. Comprobación (no debe devolver nada):
   `grep -rnE "suscripcionMock|comprasMock|devEscenario|devRotar|devAvanzar|devSinRed|devAlternarSinRed|devResultadoCompra" src --include=*.ts --include=*.tsx`.
6. Actualizar los README (`features/suscripcion`, `features/cuenta`, `shared`) y `flujo_subscripcion.md`
   del frontend (contrato real documentado; sección "Pendientes para producción").
7. Backend: `VALIDACION_TIENDA=google` en el entorno real; revisar que los README de módulo están al día.

**Integrar con el frontend.** Es la propia etapa. Prueba de punta a punta en Android (dev build):
registro → bienvenida → prueba → días 12–14 (cambiando `prueba_fin` en base de datos) → bloqueo → pago real
de prueba → activa → cancelar y reactivar → cobro fallido → "Pago recibido" → reembolso.

**Pruebas manuales.** Lista del punto anterior; además: sin red con fecha vencida (variante sin conexión),
error 5xx del servidor (no bloquea), dos teléfonos con la misma cuenta, cierre de sesión estando bloqueado.

**Criterios de aceptación.**
- El `grep` de comprobación no devuelve nada; `npx tsc --noEmit` y `npm run lint` del frontend sin errores
  nuevos.
- Recorrido completo en Android sin ninguna fuente simulada.
- README y `flujo_subscripcion.md` del frontend describen el contrato real; la sección "Pendientes" del
  README refleja lo que queda (iOS).

**Fuera de alcance.** App Store e iOS (`ios.bundleIdentifier`, `appAccountToken`), cambios de producto,
texto legal definitivo.

**Documentación a actualizar.** Los README de los módulos tocados del backend, `CLAUDE.md` del backend con
`claude-md-sync`; en el frontend, `src/features/suscripcion/README.md`, `src/features/cuenta/README.md`,
`src/shared/README.md`, `CLAUDE.md` y `flujo_subscripcion.md`.

---

## 6. Riesgos y decisiones abiertas

Todo lo marcado "a verificar" se comprueba en la documentación oficial o en pruebas reales antes de
implementarlo.

| Id | Tema | Detalle |
|---|---|---|
| R-1 | Período de gracia y account hold en Play Console | A verificar si se pueden desactivar o configurar. Si Google reintenta el cobro (gracia o en espera), la app ya bloquea desde el primer cobro fallido, pero la tienda puede seguir reintentando y recuperar el cobro: el servidor debe volver a `activa` (tabla de la etapa 5). |
| R-2 | Compra nueva durante los reintentos de cobro | A verificar si Google crea una suscripción nueva o responde que ya existe. En el segundo caso el cliente la trata como "Restaurar". El servidor deduplica por `purchase_token` y debe evitar dos suscripciones activas para una cuenta. |
| R-3 | Latencia o pérdida de RTDN | Las notificaciones pueden tardar o perderse; una cuenta `activa` con renovación no vence por fecha. Mitigación a evaluar: reconciliación periódica contra la API (job) o consulta bajo demanda cuando `acceso_hasta` pasó hace más de un margen (a definir). Fuera de las etapas actuales. |
| R-4 | Precio real e id del producto | Hoy el frontend usa `$XXX.00` y `PRODUCTO_SUSCRIPCION_ID = 'PENDIENTE'`. A definir el precio, el id del producto y, si aplica, el id del plan base. El monto del historial en 4b: a verificar si la API lo entrega o si hay que tomarlo de otra fuente. |
| R-5 | License testers | A verificar cómo se configuran las cuentas de prueba, qué ciclos de renovación aceleran (en pruebas el mes dura minutos) y cómo afecta a la derivación de `acceso_hasta`. |
| R-6 | Pagos diferidos (OXXO) en México | A verificar el comportamiento de una compra pendiente (estado, plazo de caducidad, notificación al confirmar o expirar) y qué ve el usuario mientras tanto (`pago_en_proceso`, E8). |
| R-7 | Cambio de hora y zona horaria | El frontend usa UTC−6 fijo; Postgres usa `America/Mexico_City` en la migración y en el cálculo de `periodo`. Si México volviera a tener horario de verano, ambos criterios divergirían. Decisión inicial: el backend usa la zona con nombre; la función `aIsoNegocio` debe leer el desfase real de la zona. **Reemplazada el 2026-10-12** (ver sección 8): `fechas.ts` usa un desfase fijo `ZONA_NEGOCIO_OFFSET_MIN = -360`, idéntico al frontend, y la zona con nombre solo se usa en SQL. |
| R-8 | Longitud de `purchase_token` | A verificar frente al límite del índice UNIQUE (sección 3.3). |
| R-9 | `obfuscatedAccountId` | A verificar longitud máxima, codificación aceptada y qué ocurre en compras hechas sin él (4b, punto 4). |
| R-10 | Reembolsos | A verificar cómo notifica Google un reembolso o una anulación y si la notificación de suscripción basta o hace falta la API de compras anuladas. |
| R-11 | Cuenta eliminada | No hay endpoint de baja de cuenta hoy; los `ON DELETE CASCADE` cubren el borrado de `usuarios`, pero la suscripción de la tienda seguiría cobrando. A decidir si se avisa en la futura baja. |

---

## 7. Futuro: App Store

Fuera de las etapas actuales. La columna `tienda` conserva `varchar` con CHECK (`google_play`,
`app_store`) para no romper el contrato. Notas para cuando se aborde:

- Validación y estado con la **App Store Server API** (transacciones y estado de suscripciones).
- Notificaciones con **App Store Server Notifications v2** (equivalente de RTDN).
- Ligar la compra a la cuenta con `appAccountToken` (equivalente de `obfuscatedAccountId`).
- En el frontend: definir `ios.bundleIdentifier` en `app.json`, probar en iOS (`onDismiss`, hoja de pago,
  badge) y un adaptador de compras para iOS.
- El DTO pasaría de `@IsIn(['google_play'])` a admitir `app_store`, con un segundo verificador detrás de la
  misma interfaz.

---

## 8. Registro de decisiones

| Fecha | Decisión |
|---|---|
| 2026-10-11 | El archivo se llama `flujo_suscripcion.md` y va en la raíz del backend. |
| 2026-10-11 | Cuentas existentes: reciben 14 días de prueba desde el día de la migración (ese día cuenta como el día 1): `prueba_inicio` = fecha de la migración y `prueba_fin` = día 14 a las 23:59:59 en `America/Mexico_City` (3 de marzo → 16 de marzo). Se hace en la migración de datos de la etapa 1. |
| 2026-10-11 | Solo Google Play. App Store e iOS quedan fuera de las etapas (solo la sección 7). La columna `tienda` conserva `varchar` con CHECK (`google_play`, `app_store`) para no romper el contrato del frontend. |
| 2026-10-11 | La verificación de compras va primero en modo simulado en el servidor (`VALIDACION_TIENDA=simulada\|google`, acepta tokens de prueba) y después en modo real con la Google Play Developer API: dos subetapas (4a y 4b) dentro de la etapa de compra, porque comparten endpoints, DTO, tablas y reglas y solo cambia el verificador detrás de una interfaz. La 4a permite integrar el frontend sin esperar credenciales ni el producto en Play Console. |
| 2026-10-11 | Ramas y commits: el trabajo del backend va en la rama `feature/suscripcion` (se crea en la etapa 1), con un commit por etapa; el frontend sigue en su rama `feature/suscripcion`. |
| 2026-10-11 | Los códigos de error `SUSCRIPCION_REQUERIDA` (403) y `TIENDA_EN_USO` (409) viajan al inicio del `message` con un texto legible; el frontend los detecta con `includes` y el usuario ve el mensaje completo. |
| 2026-10-11 | `ahora_servidor` va dentro del JSON del snapshot, no como cabecera. |
| 2026-10-11 | `cuenta_ofuscada` se calcula (HMAC-SHA256 del id del usuario con un secreto), no se guarda. |
| 2026-10-12 | Etapa 1: las restricciones CHECK se llaman `CHK_*` (no `CK_*` como decía la sección 3), que es la convención real del repo (ej. `CHK_productos_costo`). La sección 3 se corrigió. |
| 2026-10-12 | Etapa 1: la prueba se crea en `AuthService.register` dentro de la MISMA transacción que el `save` del usuario (`usuarioRepository.manager.transaction`), con `prueba_inicio = usuario.createdAt`, dentro del `try/catch` existente (el `23505` sigue traduciéndose a 409). `snapshot()` repara además cualquier cuenta sin fila. |
| 2026-10-12 | Etapa 1: `fechas.ts` usa un desfase fijo `ZONA_NEGOCIO_OFFSET_MIN = -360`, idéntico al frontend (sustituye lo que decía el riesgo R-7); SQL usa `America/Mexico_City`. Equivalentes desde 2022 (sin horario de verano). El riesgo R-7 queda documentado en `src/suscripciones/README.md`. |
| 2026-10-12 | Etapa 1: nombres de las FK de `eventos_tienda`: `FK_eventos_tienda_usuario_id` (→ `usuarios`, SET NULL) y `FK_eventos_tienda_compra_id` (→ `compras`, SET NULL). |
| 2026-10-12 | Etapa 1: `Usuario` no tiene relación inversa hacia `suscripciones` (ni hacia las demás tablas nuevas); las relaciones se declaran solo en las entidades hijas, porque una inversa rompería `buildUsuario()` de `auth.service.spec.ts` (`tsc` compila también los specs). |
| 2026-10-12 | Etapa 1: `crearPrueba` usa SQL parametrizado con `ON CONFLICT ("usuario_id") DO NOTHING` en vez de `.orIgnore()` del query builder (que emitiría un `ON CONFLICT DO NOTHING` sin destino). |

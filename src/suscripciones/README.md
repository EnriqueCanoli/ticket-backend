# `suscripciones`

## 1. Propósito

Modelo de datos y lógica base de la suscripción mensual (prueba gratis de 14 días, después pago por
Google Play). Es dueño exclusivo de las tablas `suscripciones`, `compras`, `pagos_historial` y
`eventos_tienda`. El plan completo por etapas vive en `flujo_suscripcion.md` (raíz del repo, sin
trackear en git); el contrato con el frontend está en `src/features/suscripcion/README.md` del repo
`c:\dev\ticket` y en `src/shared/api/suscripcion.ts`.

**Estado: etapa 2 de 6.** Existen las tablas, las entidades, la prueba de 14 días (cuentas nuevas y
existentes), el estado efectivo, `SuscripcionesService.snapshot()` con el historial real,
`GET /me/suscripcion` y el campo opcional `suscripcion` en auth (login, register y `GET /me`).
**Todavía no hay** bloqueo (403), ni compras, ni RTDN.

## 2. Estructura real

```
src/suscripciones/
├── suscripciones.module.ts        # forFeature de las 4 entidades; registra el controller; exporta SuscripcionesService
├── suscripciones.controller.ts    # GET /me/suscripcion
├── suscripciones.service.ts       # crearPrueba(), snapshot(), historial() (privado), MAX_HISTORIAL
├── estado-efectivo.ts             # estadoEfectivo(fila, ahora): función pura (tabla 1.3 del plan)
├── fechas.ts                      # aIsoNegocio, finDePrueba, periodoNegocio, ZONA_NEGOCIO_OFFSET_MIN
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
`suscripciones.controller.spec.ts` (unitarios, sin BD), `test/suscripcion-prueba.e2e-spec.ts` y
`test/suscripcion-lectura.e2e-spec.ts` (Postgres real).

## 2.1 Endpoint

### `GET /me/suscripcion`

- Guard: `JwtAuthGuard`. Sin body, sin DTO y **sin `@Throttle` propio** (aplica el global de 60/min).
- Éxito `200`: `SuscripcionSnapshot` (10 claves, snake_case, fechas `aIsoNegocio`, `ahora_servidor`
  dentro del JSON). Sin token o con token inválido: `401`.
- Si `snapshot()` falla sale el `500`: el cliente lo trata como `errorServidor` y nunca bloquea.
- El mismo snapshot viaja en el campo opcional `suscripcion` de `POST /auth/login`,
  `POST /auth/register` y `GET /me` (ver `src/auth/README.md`).

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
- Si una cuenta no tiene fila (carrera o fallo anterior), `snapshot()` la crea con
  `prueba_inicio = usuario.createdAt` y vuelve a leer.

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
- **Etapa 3:** guard y `403 SUSCRIPCION_REQUERIDA` en `POST /tickets` y `POST/PATCH/DELETE
  /productos`; `borrador_iniciado_en`.
- **Etapa 4 (4a simulada, 4b real):** `validar-compra` y `restaurar`, `409 TIENDA_EN_USO`,
  verificadores, acknowledge, `cuenta_ofuscada`.
- **Etapa 5:** RTDN de Pub/Sub (`eventos_tienda`).
- **Etapa 6:** retiro del mock del frontend e integración final.

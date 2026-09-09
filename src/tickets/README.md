# `tickets`

## 1. Propósito

Módulo de creación de ventas. Expone un único endpoint (`POST /tickets`) que recibe una lista de
líneas `{ producto_id, cantidad }`, resuelve precio/costo vigentes server-side, persiste `ticket` +
`ticket_items` en una transacción, y devuelve el ticket completo con sus líneas.

Es **create-only**: no hay `GET`/listado de tickets en este módulo — la lectura de historial/ventas
vive en `src/reportes/` (que inyecta `TicketItem` directamente y hace sus propios queries, ver
`src/reportes/README.md`).

## 2. Endpoint — `POST /tickets`

- Guard: `JwtAuthGuard`. `usuario_id` se resuelve exclusivamente de `@CurrentUser()` (JWT), nunca
  del body.
- Status éxito: `201` (`@HttpCode` explícito).
- Body — `CreateTicketDto`: `{ items: CreateTicketItemDto[] }`, `@IsArray() @ArrayMinSize(1)
  @ValidateNested({each:true})`.
- Item — `CreateTicketItemDto`:
  | campo | tipo/validación |
  |---|---|
  | `producto_id` | `@IsUUID()` |
  | `cantidad` | `@IsNumber({maxDecimalPlaces:3}) @IsPositive() @Max(9999999.999)` |

  `ValidationPipe` global (`whitelist:true, forbidNonWhitelisted:true`, sin `transform:true`) →
  cualquier campo extra (`usuario_id`, `total`, `precio_venta_unitario`, `costo_unitario`,
  `subtotal`, `id` en items) da `400` con `message` como array.
- Respuesta `201`:
  ```
  {
    id, usuario_id, total, created_at,
    items: [{ id, producto_id, nombre_producto, cantidad, precio_venta_unitario, costo_unitario, subtotal }]
  }
  ```
  Todos los numéricos llegan como `number` JSON. **No hay `updated_at`** en el ticket — es
  inmutable, sin pantalla de edición.
- Errores:
  - `400` por validación de DTO (array de mensajes).
  - `400` con `message` **string simple** `"Los siguientes producto_id no existen: <ids
    deduplicados>"` cuando algún `producto_id` no existe **o pertenece a otro usuario**
    (indistinguibles a propósito — evita leak de existencia de IDs ajenos).
  - `401` estándar de `JwtAuthGuard`.

## 3. Reglas de negocio (mecanismo exacto del snapshot)

1. Deduplica `producto_id`s del request.
2. Un único `find({ where: { id: In(uniqueProductoIds), usuarioId } })` **antes** de abrir la
   transacción — catálogo del usuario del token. Si falta alguno → `BadRequestException`, no se
   abre transacción, no se crea nada.
3. Dentro de la transacción: por cada item **del request original, sin deduplicar** (repetidos
   generan líneas separadas, nunca se fusionan), snapshotea `precio_venta_unitario =
   producto.precioVenta` y `costo_unitario = producto.costo` del **mismo objeto `producto`** leído
   en el paso 2 (no una relectura dentro de la transacción). `subtotal = cantidad *
   precio_venta_unitario`. `total = SUM(subtotal)` calculado en JS (`reduce`), no `SUM` de SQL.
4. Inserta `ticket` (`usuario_id`, `total`), luego todas las `ticket_items`, misma transacción.
5. `nombre_producto` de la respuesta sale del mismo objeto `producto` del paso 2 — **no hay columna
   `nombre_producto` en `ticket_items`**, no está snapshoteado en BD, solo en la respuesta HTTP.
6. No existe concepto de "borrador" — el ticket se crea ya confirmado, atómico, sin estado
   intermedio. No hay columna de estado en `tickets`.

## 4. Restricciones de BD

- `tickets`: PK uuid, `usuario_id uuid NOT NULL` FK `→ usuarios(id)` **sin `ON DELETE` explícito**
  (= `NO ACTION`/RESTRICT), `total numeric(12,2)` con `CHECK (total >= 0)`, `created_at timestamptz
  DEFAULT now()`. Índice `IDX_tickets_usuario_id`.
- `ticket_items`: PK uuid, `ticket_id` FK `→ tickets(id) ON DELETE CASCADE`. `producto_id` FK `→
  productos(id) ON DELETE RESTRICT` — **crítico**: un `DELETE` real de un producto referenciado por
  cualquier `ticket_items` falla a nivel Postgres. `cantidad numeric(10,3) CHECK > 0`,
  `precio_venta_unitario`/`costo_unitario`/`subtotal` `CHECK >= 0`. Índices
  `IDX_ticket_items_ticket_id`, `IDX_ticket_items_producto_id`.
- **Por eso `productos` nunca hace hard-delete**: la restricción `ON DELETE RESTRICT` obliga al
  soft-delete (`producto.activo = false`) — ver `src/productos/README.md`.

## 5. Gotchas no obvios

1. **`tickets.service.ts` NO filtra por `productos.activo`** — a diferencia de
   `ProductosService` (que sí filtra `activo:true` en `search`/`findCatalogo`/`update`/`remove`).
   Un producto **soft-eliminado** (`activo=false`) todavía puede usarse para crear un ticket nuevo
   si el cliente ya tiene su `producto_id` (ej. catálogo cacheado stale en el móvil), sin que el
   servidor lo rechace. No es evidente al leer solo este módulo, hay que cruzar con
   `productos.service.ts` para notarlo.
2. **`nombre_producto` no es un dato de auditoría confiable a largo plazo** — no se snapshotea (a
   diferencia de precio/costo). Si el nombre del producto cambia después, cualquier endpoint futuro
   de "detalle de ticket" que haga JOIN fresco (este módulo no expone lectura) mostraría el nombre
   actual, inconsistente con lo que se vendió en el momento.
3. **`producto_id` de otra cuenta y `producto_id` inexistente son indistinguibles** para el cliente
   (mismo `400`, mismo mensaje) — deliberado.
4. **Todo-o-nada estricto**: si un solo `producto_id` falla la validación de existencia, ningún
   ticket se crea (el chequeo ocurre antes de abrir la transacción) — no hay ticket parcial.
5. **La FK `tickets.usuario_id → usuarios.id` no tiene `ON DELETE` explícito** (a diferencia de
   `ticket_items.ticket_id`, que sí tiene `CASCADE`) — Postgres aplicaría `NO ACTION`/RESTRICT por
   defecto; borrar un usuario con tickets fallaría a nivel BD (no hay endpoint de borrado de cuenta
   hoy, ver `src/usuarios/README.md`).
6. **`total` se calcula en JS con `reduce`, no con `SUM` de SQL** — precisión mitigada porque cada
   `subtotal` ya viene con 2 decimales al persistir en la columna `numeric(12,2)`, pero el valor en
   memoria antes del `INSERT` es un `number` de JS.
7. `@Max(9999999.999)` en `cantidad` (dto) evita `numeric field overflow` de Postgres — no confundir
   con un límite de negocio de stock.
8. **El `subtotal`/`total` persistido puede diferir en centavos del monto que el usuario tecleó
   para un ítem a granel**, por la limitación de 3 decimales de `cantidad`. En el frontend
   (`src/features/ticket/BuscarProductoScreen.tsx`, `handleMontoChange`), para productos
   `es_a_granel` el usuario tipea un "monto final" ($) y la app deriva `cantidad = monto / precio`,
   redondeada a 3 decimales con `formatCantidad` (`src/features/vendido/formatCantidad.ts`,
   `Number(valor.toFixed(3))`) — así lo exige este DTO (`@IsNumber({maxDecimalPlaces:3})`). El
   payload de `POST /tickets` manda solo esa `cantidad` ya redondeada; nunca el monto original. Acá
   en `tickets.service.ts` (línea ~65) se recalcula `subtotal = cantidad * precio_venta_unitario`
   con esa `cantidad` de 3 decimales y un `precio_venta_unitario` de 2 decimales — el producto
   exacto puede tener hasta 5 decimales, así que Postgres redondea al persistir en
   `numeric(12,2)`/`numeric(10,2)`, y ese redondeo no necesariamente reconstruye el monto original.
   Ejemplo concreto: precio = 23.50, usuario tipea monto = 50.00 → `cantidad` derivada =
   50/23.50 = 2.1276... → redondeada a `2.128` → `subtotal` recalculado = 2.128 × 23.50 = 50.008 →
   persistido como `50.01`, un centavo distinto de lo que el usuario tecleó. El frontend ya detectó
   una manifestación de este problema y la parchó **solo para lo que se muestra en pantalla**: el
   total visible en `BuscarProductoScreen.tsx` usa `montoFinal` directo para ítems a granel en vez
   de `precio * cantidad`, justamente para no mostrar este error de redondeo (ver
   `src/features/ticket/README.md` sección "e", gotcha de `montoFinal`). Pero esa corrección es
   solo cosmética del lado cliente — no cambia qué se manda al backend, así que el `ticket_items.subtotal`
   y `tickets.total` que quedan en la base de datos sí arrastran el redondeo descrito arriba, aunque
   la pantalla haya mostrado el monto exacto antes de guardar. Corregirlo de raíz (por ejemplo,
   aceptando `subtotal`/`monto` como dato de negocio en vez de derivar todo de `cantidad`, o
   ampliando la escala de `cantidad`) requeriría una migración de esquema evaluada aparte — no se
   resuelve solo con un cambio de redondeo en el código actual.

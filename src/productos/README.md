# `productos`

## 1. Propósito

CRUD del catálogo de productos, privado por cuenta (`productos.usuario_id`). Expone búsqueda
acotada para el flujo de armar ticket, listado completo para la pantalla de administración de
catálogo, alta (con dos variantes: alta rápida sin costo / alta completa con costo), edición
parcial, y borrado lógico (soft-delete). También contiene la única lógica de negocio no trivial del
dominio "producto": la derivación server-side de `costo_validado` y la corrección retroactiva del
histórico de ventas (`ticket_items.costo_unitario`) cuando se confirma el costo real por primera
vez.

Sin prefijo global de rutas. Las 5 rutas usan `@UseGuards(JwtAuthGuard)` y resuelven `usuario_id`
exclusivamente vía `@CurrentUser()` (JWT) — nunca de body/query/params. El orden de declaración en
el controller es deliberado: `GET /productos/catalogo` (ruta estática) está declarada antes que las
rutas con `:id`.

## 2. Endpoints

### `GET /productos` — búsqueda

- Query `SearchProductosDto`: `search: string` — `@IsString() @IsNotEmpty() @Matches(/\S/, {message:'search should not be empty'})`.
- Lógica: `term = escapeLikePattern(search.trim())` (escapa `\`, `%`, `_` para tratar el término
  como substring literal); `find({ where: { nombre: ILike('%'+term+'%'), usuarioId, activo: true },
  order: { nombre: 'ASC' }, take: 20 })`. Límite hardcoded de **20 resultados, sin paginación**.
  `ILIKE` es case-insensitive pero **sin normalización de acentos** — "Café" no matchea buscando
  "Cafe" (a diferencia de la constraint de duplicados al crear, que sí usa `unaccent`).
- Respuesta `200` — array de `ProductoSearchResult`: `{ id, nombre, precio_venta, es_a_granel }`
  (**sin** `costo`/`costo_validado`). `[]` si no hay matches (no es error).
- Errores: `400` (search ausente/vacío-solo-espacios/query param extra por `forbidNonWhitelisted`),
  `401`.

### `GET /productos/catalogo` — listado completo

- Sin `@Query()` declarado en el controller → el `ValidationPipe` global **nunca corre** sobre la
  query string de esta ruta: cualquier query param extra se ignora silenciosamente (única excepción
  a `forbidNonWhitelisted` entre los 5 endpoints del módulo).
- Lógica: `find({ where: { usuarioId, activo: true }, order: { nombre: 'ASC' } })` — sin `take`, sin
  límite server-side.
- Respuesta `200` — array de `ProductoCatalogoItem`: `{ id, nombre, costo, precio_venta,
  costo_validado, es_a_granel }` (sin timestamps, sin `activo`). `[]` si no hay productos.
- Errores: solo `401`.

### `POST /productos` — alta

- Body `CreateProductoDto`:
  | campo | tipo/validación |
  |---|---|
  | `nombre` | `@IsString() @IsNotEmpty() @Matches(/\S/) @MaxLength(150)` |
  | `precio_venta` | `@IsNumber({maxDecimalPlaces:2}) @Min(0) @Max(99999999.99)` |
  | `costo?` | opcional, misma regla que `precio_venta` |
  | `es_a_granel?` | opcional, `@IsBoolean()` |

  No declara `costo_validado`/`activo`/`usuario_id`/`id`/timestamps → `400` si el cliente los manda.
  `@Max(99999999.99)` existe explícitamente para evitar `numeric field overflow` de Postgres (la
  columna es `numeric(10,2)` = 8 dígitos enteros + 2 decimales).
- Lógica: `costo_validado = (dto.costo !== undefined)` — chequeo **estricto**, no truthy (`costo: 0`
  cuenta como presente → `costo_validado: true, costo: 0`). Si no viene `costo`: se persiste el
  placeholder `costo = 1`, `costo_validado = false`. `es_a_granel = dto.es_a_granel ?? false`. Sin
  `nombre.trim()` a nivel código (no hay `transform:true` global) — se guarda tal cual con espacios
  si el cliente los manda.
- **No hay `findOne()` previo de duplicado** — el único control de nombre duplicado es el
  `try/catch` alrededor de `save()`: `23505` sobre el índice único → `409 ConflictException('Ya
  existe un producto con ese nombre')`; cualquier otro `unique_violation` → `409
  ConflictException('El registro ya existe')` (genérico).
- Respuesta `201` — `ProductoResponse`: `{ id, nombre, precio_venta, costo, costo_validado,
  es_a_granel, created_at, updated_at }`.
- Errores: `400` (validación/campo extra), `401`, `409` (nombre duplicado, mismo usuario,
  case/acento-insensitive).

### `PATCH /productos/:id` — edición parcial

- `:id` vía `@Param('id', ParseUUIDPipe)` — `400` (`message` string simple `"Validation failed (uuid
  is expected)"`) si no es UUID sintácticamente válido, **antes** de llegar al service.
- Body `UpdateProductoDto` — los 4 campos (`nombre`, `costo`, `precio_venta`, `es_a_granel`) son
  `@IsOptional()`, mismas reglas que `CreateProductoDto`.
- Lógica:
  1. Si los 4 campos vienen `undefined` → `400 BadRequestException('At least one of nombre, costo,
     precio_venta, es_a_granel must be provided')`, **antes** de tocar la BD.
  2. `findOne({ where: { id, usuarioId, activo: true } })` → si no hay match, `404
     NotFoundException('Producto not found')` — **mismo mensaje genérico** para: id inexistente, id
     de otro usuario, o producto ya `activo=false` (no distingue las tres causas, evita filtrar
     info entre cuentas).
  3. Aplica solo campos presentes; `costo_validado` se fuerza **siempre** a `true`, venga o no
     `costo` en el body.
  4. **Corrección retroactiva de histórico**: si el producto pasa de `costo_validado=false` a
     `true` por primera vez y el `costo` cambió, en una **transacción** se hace `save(producto)` +
     `UPDATE ticket_items SET costo_unitario = <nuevo> WHERE producto_id = <id> AND costo_unitario =
     <costo viejo>` — corrige solo las líneas de venta que tenían el costo placeholder viejo
     (filtro defensivo por valor exacto, no por rango de fechas). No toca `precio_venta_unitario`,
     `subtotal` ni `tickets.total`. Si el producto ya estaba validado antes, el cambio de costo solo
     aplica hacia adelante. **Efecto completamente silencioso para el cliente** — la respuesta HTTP
     no cambia.
  5. Mismo control de nombre duplicado (`409`) que `create()`.
- Respuesta `200` — mismo shape `ProductoResponse` que `POST`.
- Errores: `400` (UUID inválido, body sin campos, validación DTO), `401`, `404` (genérico, 3
  causas), `409` (nombre duplicado).

### `DELETE /productos/:id` — soft-delete

- `:id` vía `ParseUUIDPipe`, mismo comportamiento que `PATCH`. Sin body.
- Mismo criterio de búsqueda `{ id, usuarioId, activo: true }` → `404` genérico si no hay match
  (**incluye double-delete**: un segundo `DELETE` sobre el mismo id da `404`, no `200` idempotente).
- `producto.activo = false`. **Efecto secundario**: si `costo_validado === false` y existe al menos
  un `ticket_items` con ese `producto_id` (`existsBy({ productoId })`), se fuerza `costo_validado =
  true` (sin tocar `costo`, que queda en el placeholder `1`) — porque tras el soft-delete el
  producto ya no es alcanzable por `PATCH` (mismo filtro `activo=true`), así que sería la última
  oportunidad de confirmar costo perdida para siempre. Si nunca se vendió, no se toca nada.
- **No hay `DELETE FROM` real en ningún punto** — la fila persiste, protegida por la FK
  `ticket_items.producto_id ... ON DELETE RESTRICT`.
- Respuesta `200` — `ProductoDeleteResponse`: `{ id, activo }` (siempre `activo: false` en éxito).
  No usa `204`.
- Errores: `400` (UUID inválido), `401`, `404` (genérico, 3 causas incluyendo double-delete).

### Formato de errores

Sin `ExceptionFilter` custom. `400` de `class-validator` → `message` array; `400` de
`BadRequestException`/`ParseUUIDPipe` manuales → `message` string simple; `404`/`409` → string
simple.

## 3. Reglas de negocio no obvias

- **`costo_validado` es derivado, nunca input directo** — el DTO nunca lo declara (whitelist lo
  rechazaría). En `create()` depende de si `costo` vino presente (`!== undefined`); en `update()` se
  fuerza siempre a `true`.
- **Soft-delete** vía columna `activo` (default `true`). Todas las lecturas y las búsquedas previas
  a `update`/`remove` filtran `activo = true`. No existe endpoint de "restaurar".
- **Corrección retroactiva de histórico** (`PATCH`, primera confirmación de costo) es el único lugar
  del módulo que muta datos de `tickets`/`ticket_items`, fuera de su propio dominio. Transaccional,
  filtrada por igualdad exacta del costo viejo.
- **Sin `nombre.trim()` a nivel DTO** — `search()` sí hace `trim()` manual en el service antes de
  filtrar; `create()`/`update()` no.

## 4. Restricciones de BD

Tabla `productos`:

- `id uuid PK DEFAULT gen_random_uuid()`.
- `usuario_id uuid NOT NULL`, FK `→ usuarios(id)` **sin `ON DELETE` explícito** (default Postgres
  `NO ACTION`/RESTRICT). Índice `IDX_productos_usuario_id`, más el compuesto de abajo.
- `nombre varchar(150) NOT NULL`.
- `costo numeric(10,2) NOT NULL DEFAULT 1`, `CHECK (costo >= 0)` (a nivel BD, además del `@Min(0)`
  del DTO).
- `precio_venta numeric(10,2) NOT NULL DEFAULT 0`, `CHECK (precio_venta >= 0)`.
- `costo_validado boolean NOT NULL DEFAULT true` — el default de columna es `true`, pero en la
  práctica ningún camino de código lo deja actuar: `create()`/`update()` siempre lo setean
  explícito.
- `activo boolean NOT NULL DEFAULT true`, índice compuesto `IDX_productos_usuario_id_activo
  (usuario_id, activo)`.
- `es_a_granel boolean NOT NULL DEFAULT false`.
- `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`.
- **Índice único parcial funcional**: `UQ_productos_usuario_id_nombre_lower ON (usuario_id,
  LOWER(immutable_unaccent(nombre))) WHERE activo = true` — `immutable_unaccent` es un wrapper
  `IMMUTABLE` sobre `unaccent()` (que es `STABLE`), necesario porque Postgres exige funciones
  `IMMUTABLE` en expresiones de índice.

Relación con `ticket_items` (tabla del módulo `tickets`): `ticket_items.producto_id → productos(id)
ON DELETE RESTRICT` — **es la restricción que obliga al soft-delete** en vez de un `DELETE FROM
productos` real (documentado explícitamente en un comentario de la entidad).

## 5. Decisiones de diseño / gotchas

- El `409` de nombre duplicado depende **enteramente** del `catch` alrededor de `save()` — no hay
  `findOne()` de pre-chequeo ni en `create()` ni en `update()`.
- `GET /productos/catalogo` es la **única** ruta del módulo que no aplica `forbidNonWhitelisted`
  sobre la query string (el método no declara `@Query()`, así que el `ValidationPipe` global nunca
  corre ahí) — no asumir por simetría que las 5 rutas rechazan query params extra.
- El soft-delete "confirma" silenciosamente `costo_validado` en productos ya vendidos y nunca
  confirmados, como saneamiento de reportes históricos — no visible sin leer el comentario del
  service, el shape de respuesta de `DELETE` (`{id, activo}`) no lo insinúa.
- `TicketItem` se inyecta en `ProductosModule`/`ProductosService` por dos motivos distintos: vía
  `Repository` para el `existsBy` de `remove()`, y vía el `EntityManager` de la transacción (no el
  repository inyectado) para el `UPDATE` de corrección retroactiva.

## 6. Precio/costo/margen

`precio_venta` y `costo` viven en `productos` como valores "vigentes" (no versionados) — se
snapshotean en `ticket_items.precio_venta_unitario`/`costo_unitario` al momento de vender (ver
`src/tickets/README.md`). Este módulo no calcula margen/ganancia — solo mantiene el valor vigente y
decide cuándo está "confirmado" (`costo_validado`). `costo_validado=false` es el estado del "alta
rápida" (solo `nombre` + `precio_venta`) — señala en `src/reportes/` que la ganancia mostrada para
ese producto puede no ser real hasta que se confirme el costo vía `PATCH`.

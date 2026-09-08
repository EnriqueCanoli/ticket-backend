# `reportes`

## 1. Propósito

Expone 2 endpoints de solo lectura (`GET /reportes/dia`, `GET /reportes/mes`) que reportean, sobre
las tablas `tickets`/`ticket_items`/`productos` ya existentes (**sin tablas propias**), las ventas y
ganancias del usuario autenticado: líneas de venta del día calendario actual, y totales agregados
por producto del mes/año pedido. No crea/modifica datos.

`ReportesModule` registra `Ticket`, `TicketItem`, `Producto` en `TypeOrmModule.forFeature`, pero el
service solo inyecta `Repository<TicketItem>`, navegando `ti.ticket`/`ti.producto` vía relaciones
del `QueryBuilder`.

## 2. Endpoints

### `GET /reportes/dia`

- Guard: `JwtAuthGuard`.
- Query: `tz?: string` — IANA opcional, validado en el controller con `new
  Intl.DateTimeFormat(undefined, { timeZone: tz })`; si `tz` viene pero es inválido → `400
  BadRequestException('tz must be a valid IANA time zone')` **antes** de tocar la BD. Si no viene,
  el service resuelve el fallback (ver §3).
- Respuesta `200` — `ReporteDiaItem[]`:
  ```
  { id, producto_id, nombre_producto, cantidad: number, venta: number, costo: number, hora: "HH:mm", costo_validado: boolean }
  ```
  `[]` si no hay ventas ese día (no es error). **`costo` acá es el costo TOTAL de la línea**
  (`cantidad * costo_unitario`), no el costo unitario — sumarlo entre líneas da el total correcto
  solo porque ya viene multiplicado.
- Errores: `400` (tz inválido), `401`.

### `GET /reportes/mes`

- Guard: `JwtAuthGuard`.
- Query:
  | param | validación |
  |---|---|
  | `mes` | **obligatorio**, `@Query('mes', ParseIntPipe)`; ausente o no matchea `/^-?\d+$/` → `400 "Validation failed (numeric string is expected)"`; validado a mano `1-12` después → `400 "mes must be between 1 and 12"` |
  | `anio?` | `@Query('anio', new ParseIntPipe({optional:true}))`; ausente → `undefined` sin error; presente pero no entero → mismo 400 de `ParseIntPipe`; presente y `<1` → `400 "anio must be a positive integer"` |
  | `tz?` | misma validación que `/dia` |

  `ParseIntPipe` acepta enteros **negativos** (`/^-?\d+$/`); el rechazo de negativos/cero para
  `mes`/`anio` ocurre en el chequeo manual del controller, no en el pipe.
- Respuesta `200` — `ReporteMesItem[]`:
  ```
  { producto_id, nombre_producto, cantidad: number, venta: number, ganancia: number, costo_validado: boolean }
  ```
  Agrupado por producto, `ORDER BY nombre ASC`. `[]` si no hay ventas ese mes/año.
- Errores: 4 variantes de `400` (arriba) + `401`.

### Nota sobre `ValidationPipe` global

Ninguno de los 2 endpoints usa un DTO de `class-validator` con `@Query()` — extraen params
individualmente con `@Query('nombre', Pipe)`. Consecuencia: `forbidNonWhitelisted` **nunca aplica**
a la query string de este módulo — query params extra no declarados se ignoran silenciosamente,
nunca dan `400`.

## 3. Reglas de negocio — timezone (crítico)

Constante `TIMEZONE_FALLBACK = 'America/Mexico_City'`, usada cuando el cliente no manda `tz`.

**`/dia`** — rango de día vía `QueryBuilder` con expresiones SQL crudas en `andWhere`/`addSelect`:
```sql
t.createdAt >= (CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria)::date::timestamp AT TIME ZONE :zonaHoraria
t.createdAt <  ((CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria)::date::timestamp + interval '1 day') AT TIME ZONE :zonaHoraria
```
`hora`: `TO_CHAR(t.createdAt AT TIME ZONE :zonaHoraria, 'HH24:MI')`.

**`/mes`**:
```sql
anioExpr = COALESCE(:anio::int, EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria))::int)
t.createdAt >= make_date(anioExpr, :mes, 1)::timestamp AT TIME ZONE :zonaHoraria
t.createdAt <  (make_date(anioExpr, :mes, 1)::timestamp + interval '1 month') AT TIME ZONE :zonaHoraria
```
`anio` ausente se pasa como `null` SQL, resuelto por `COALESCE` **en cada request** (nunca cacheado
en JS — evita el bug clásico de `new Date().getFullYear()` fijado al arranque del proceso).

**Gotcha crítico** (con test de regresión dedicado en `reportes.service.spec.ts`, que verifica por
string-match la presencia de `'::date::timestamp'` y `'1)::timestamp'` en el SQL generado): el
`::timestamp` explícito entre `::date`/`make_date(...)` y el `AT TIME ZONE` exterior **es
obligatorio**. Sin él, Postgres resuelve la ambigüedad de casts implícitos de `date` prefiriendo
`timestamptz` (tipo preferido de la categoría datetime), lo que reinterpreta la fecha truncada como
medianoche en la zona de la **sesión** de Postgres (UTC) en vez de `:zonaHoraria` — reintroduciendo
en silencio exactamente el bug que este diseño busca eliminar. Un futuro refactor que "simplifique"
quitando ese cast reintroduce el bug sin que TypeScript lo detecte.

Los bounds quedan como **constantes por query** (no se envuelve `t.createdAt` en ninguna función) →
el filtro sigue siendo sargable.

**Ganancia**: `SUM(ti.subtotal - ti.cantidad * ti.costo_unitario)` por producto — ganancia por línea
sumada, no `SUM(venta) - SUM(costo)` calculado aparte (equivalente matemáticamente, pero es la forma
real en el código).

**No hay filtrado de tickets "no confirmados" o "cancelados"** porque ese concepto **no existe en el
schema**: `Ticket` no tiene columna de estado — es inmutable (ver `src/tickets/README.md`). Toda
fila en `tickets` es por definición una venta confirmada. No asumir que falta un filtro `WHERE
estado = 'confirmado'` — no falta, porque no hay tal columna.

`costo_validado` en ambos endpoints refleja el estado **actual** de `productos.costo_validado` (vía
el mismo `innerJoin` usado para `nombre_producto`), **no un snapshot al momento de la venta** — puede
cambiar de `false` a `true` retroactivamente sin tocar la venta.

## 4. Restricciones de BD relevantes

Sin tablas propias. Índices relevantes de `tickets`/`ticket_items`:

- `IDX_tickets_usuario_id` — sirve el filtro `t.usuarioId = :usuarioId` de ambos endpoints.
- `IDX_ticket_items_ticket_id`, `IDX_ticket_items_producto_id`.
- **No hay índice sobre `tickets.created_at`**, ni compuesto `(usuario_id, created_at)` — el filtro
  de rango de fecha en ambos reportes se apoya solo en el índice de `usuario_id` para reducir el
  conjunto antes de escanear por fecha. Aceptable al volumen actual (cuenta chica, un día/mes de
  ventas); candidato obvio de índice futuro si el volumen crece.

Constraints en `ticket_items` (`cantidad > 0`, `costo_unitario >= 0`, `subtotal >= 0`) garantizan
que `costo`/`ganancia` calculados nunca operen sobre negativos inesperados.

## 5. Decisiones de diseño / gotchas

1. **`::timestamp` explícito** (detallado en §3) — el gotcha más importante del módulo.
2. **`costo` en `/reportes/dia` es costo total de línea**, no unitario (ver §2).
3. **`anio` sin default calculado en JS** — resuelto con `COALESCE` + `EXTRACT(YEAR FROM ...)`
   evaluado en cada request, para evitar que un proceso de Node de larga vida quede "atascado" en el
   año de arranque al cruzar Año Nuevo.
4. **`nombre_producto` no está snapshoteado** — refleja el nombre vigente del producto, no el que
   tenía al momento de la venta (a diferencia de precio/costo, que sí se snapshotean en
   `ticket_items`). Reportes históricos de meses pasados muestran el nombre actual si el producto
   fue renombrado.
5. **Sin paginación en ninguno de los 2 endpoints** — volumen acotado asumido (una cuenta, un
   día/mes).
6. **`tz` siempre viaja bindeado como parámetro del `QueryBuilder`**, nunca interpolado como string
   en el SQL — sin riesgo de injection vía `tz`, a pesar de ser un raw SQL fragment con `AT TIME
   ZONE :zonaHoraria`.
7. El PIN de 4 dígitos de la app es puramente gate de UI del cliente — el backend de `reportes` no
   sabe nada de él, ambos endpoints devuelven datos completos con solo el JWT.

# API de productos — guía de integración para el cliente móvil

> Generado a partir de la **lectura del código real** en `ticket-backend/src/productos/`
> (`productos.controller.ts`, `productos.service.ts`, `dto/search-productos.dto.ts`,
> `dto/create-producto.dto.ts`, `dto/update-producto.dto.ts`,
> `interfaces/producto-response.interface.ts`, `entities/producto.entity.ts`) y de
> `database/migrations/1786850000000-AddActivoToProductos.ts`. También se leyeron las piezas
> compartidas ya documentadas en `ticket-backend/src/auth/API_INTEGRATION.md` (`main.ts`,
> `JwtAuthGuard`, `JwtStrategy`, `CurrentUser`). No se ejecutó el servidor ni se hicieron requests
> en vivo — todo lo documentado aquí se dedujo estáticamente del código fuente.
>
> El código es la fuente de verdad. Este documento reemplaza, para efectos de integración del
> frontend, al diseño de `c:\dev\ticket\src\features\productos\ENDPOINTS.md` (la propuesta previa
> a implementar). Las diferencias encontradas entre diseño y código están señaladas explícitamente
> en la [última sección](#diferencias-vs-diseño-original).

## Índice

1. [Convenciones generales](#1-convenciones-generales)
2. [GET /productos](#2-get-productos)
3. [POST /productos](#3-post-productos)
4. [GET /productos/catalogo](#4-get-productoscatalogo)
5. [PATCH /productos/:id](#5-patch-productosid)
6. [DELETE /productos/:id](#6-delete-productosid)
7. [Diferencias vs. diseño original](#diferencias-vs-diseño-original)

---

## 1. Convenciones generales

- **Sin prefijo global**: las 5 rutas son literalmente `GET /productos`, `POST /productos`,
  `GET /productos/catalogo`, `PATCH /productos/:id`, `DELETE /productos/:id`, tal como están
  declaradas en `productos.controller.ts` (`@Controller()` vacío + ruta completa por método,
  mismo patrón que `auth/` y `tickets/`).
- **Sesión requerida en las 5**: header `Authorization: Bearer <access_token>`. Los 5 métodos
  están decorados con `@UseGuards(JwtAuthGuard)` — mismo guard que protege `GET /me`, mismos `401`
  y mismo body de error genérico de Passport documentados en `auth/API_INTEGRATION.md` §5:
  ```json
  { "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }
  ```
- **Catálogo privado por cuenta, sin excepción**: `productos.usuario_id` (`producto.entity.ts`) se
  resuelve siempre del JWT vía `@CurrentUser()` (`productos.controller.ts`), nunca del
  body/query/params. Esto aplica también a `:id` en `PATCH`/`DELETE`: un `id` sintácticamente
  válido pero de otra cuenta se trata exactamente igual que un `id` inexistente (mismo `404`
  genérico — ver [§5](#5-patch-productosid) y [§6](#6-delete-productosid)). No se expone
  `usuario_id` en ninguna respuesta.
- **`ValidationPipe` global** (`main.ts`): `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`,
  sin `transform: true`. Consecuencias directas para el cliente:
  - Cualquier campo del body/query **no declarado** en el DTO correspondiente hace fallar la
    request entera con **`400`** (`forbidNonWhitelisted`), no se ignora silenciosamente. Esto
    aplica a `GET /productos` (`SearchProductosDto`), `POST /productos` (`CreateProductoDto`) y
    `PATCH /productos/:id` (`UpdateProductoDto`). **No aplica a `GET /productos/catalogo`**: ese
    método no declara ningún parámetro `@Query()`, así que el `ValidationPipe` nunca se ejecuta
    sobre la query string de esa ruta — cualquier query param que el cliente agregue ahí se
    ignora silenciosamente, nunca produce `400` (ver detalle en [§4](#4-get-productoscatalogo) y
    la [diferencia 3](#diferencias-vs-diseño-original)).
  - Al no haber `transform: true`, el valor que finalmente recibe el controller/service es el
    **valor original enviado por el cliente**, no una versión normalizada. Ningún DTO de este
    módulo hace `trim()` automático de strings — ver notas puntuales en cada endpoint.
- **`costo_validado` y `activo` nunca son input del cliente**: ningún DTO del módulo
  (`SearchProductosDto`, `CreateProductoDto`, `UpdateProductoDto`) declara estos campos. Si el
  cliente los manda, la request completa falla `400` por `forbidNonWhitelisted`. Ambos son siempre
  calculados por el servidor.
- **Formato de error**: no hay `ExceptionFilter` custom (no se encontró ninguno en
  `productos.module.ts`, `app.module.ts` ni `main.ts`), así que todos los errores usan el formato
  default de Nest:
  - `400` de validación de DTO (`class-validator`): `message` es un **arreglo** de strings.
    ```json
    { "statusCode": 400, "message": ["..."], "error": "Bad Request" }
    ```
  - `400` lanzado a mano con `BadRequestException` desde `ProductosService.update` (caso "ningún
    campo presente" en `PATCH`, ver [§5](#5-patch-productosid)) y `400` de `ParseUUIDPipe` sobre
    `:id` (formato de UUID inválido en `PATCH`/`DELETE`): `message` es un **string simple**, no un
    arreglo.
  - `404` lanzado a mano con `NotFoundException('Producto not found')` desde
    `ProductosService.update`/`remove`: mismo string simple, mismo mensaje literal en los dos
    endpoints y para las tres causas posibles (ver [§5](#5-patch-productosid) y
    [§6](#6-delete-productosid)).
- **Campos monetarios**: `precio_venta` y `costo` son columnas `numeric(10,2)` en Postgres, pero
  `producto.entity.ts` les aplica `numericTransformer` (`database/transformers/numeric.transformer.ts`,
  `from: v => parseFloat(v)`), así que **sí llegan como número JSON**, no como string — el
  frontend puede operar sobre ellos directamente (`.toFixed(2)`, aritmética) sin parsear.
- **Fechas**: `created_at`/`updated_at` son columnas `timestamptz` (`CreateDateColumn`/
  `UpdateDateColumn`) que Nest serializa a JSON como string ISO 8601. `PATCH` actualiza
  `updated_at` automáticamente (`@UpdateDateColumn`, se refresca en cualquier `save()`).
- **Soft-delete (`productos.activo`)**: columna `boolean NOT NULL DEFAULT true`
  (`database/migrations/1786850000000-AddActivoToProductos.ts`), con índice compuesto
  `(usuario_id, activo)`. Un producto con `activo = false` (marcado por `DELETE /productos/:id`)
  queda excluido de `GET /productos`, `GET /productos/catalogo`, y de cualquier `PATCH`/`DELETE`
  posterior sobre su `id` (tratado como inexistente). La fila **no se borra físicamente** de la
  tabla — sigue existiendo para no violar el `ON DELETE RESTRICT` de `ticket_items.producto_id` ni
  perder el histórico de ventas. No existe ningún endpoint para revertir `activo` a `true`.
- **Nota sobre la columna `costo_validado` a nivel de entidad**: `producto.entity.ts:59` declara
  `default: true` para esa columna, pero **ningún flujo del código actual llega a usar ese
  default**: tanto `ProductosService.create` (siempre pasa `costoValidado` explícito, `true` o
  `false` según si vino `costo`) como `ProductosService.update` (siempre fuerza `true`) setean el
  valor a mano antes de `save()`. El default de columna solo aplicaría a un `INSERT` que no pase
  por estos dos métodos, algo que no ocurre hoy.

---

## 2. GET /productos

Búsqueda server-side por nombre, acotada a productos activos
(`ProductosController.search` → `ProductosService.search`).

**Headers**: `Authorization: Bearer <access_token>`. Sin body.

### Query params — `SearchProductosDto` (`dto/search-productos.dto.ts`)

| Param | Tipo | Validación real (class-validator) |
|---|---|---|
| `search` | `string` | `@IsString()` + `@IsNotEmpty()` + `@Matches(/\S/, { message: 'search should not be empty' })` — requerido, y debe contener al menos un carácter no-espacio. Un valor de solo espacios (`"   "`) falla `400` gracias al `@Matches`, aunque pasaría `@IsNotEmpty()` por sí solo. |

- No hay longitud mínima adicional: `"a"` (1 carácter no-espacio) ya es válido.
- **El valor que llega al controller no está trimmeado** (no hay `transform: true` en el
  `ValidationPipe` global): si el cliente manda `search: "  perro  "`, la validación pasa (hay
  caracteres no-espacio), pero el string completo con espacios es lo que recibe el DTO. El
  `.trim()` real ocurre **dentro de `ProductosService.search`** (`const term = search.trim();`,
  `productos.service.ts:41`) antes de construir el filtro — así que el resultado de la búsqueda sí
  queda correcto, solo que el trim no pasa por el DTO.

```
GET /productos?search=perro
```

### Comportamiento de búsqueda (`productos.service.ts`)

- Filtro: `ILIKE '%<search.trim()>%'` sobre `productos.nombre` (`ILike` de TypeORM), **acotado a
  `productos.usuario_id = <usuario del token>` Y `productos.activo = true`**
  (`productos.service.ts:44`) — case-insensitive, sin normalización de acentos. Un producto de
  otra cuenta nunca aparece en los resultados, y un producto borrado (soft-delete) tampoco,
  aunque su nombre coincida exactamente con el término buscado.
- Orden: `nombre ASC`.
- Límite: `take: 20` (`SEARCH_RESULT_LIMIT = 20`, `productos.service.ts:15`) — server-side, el
  cliente no puede pedir más ni paginar; no hay parámetro `page`/`limit` en el DTO.

### Response — éxito `200 OK`

Array de `ProductoSearchResult` (`interfaces/producto-response.interface.ts`), construido por
`toSearchResult()`:

```json
[
  { "id": "uuid", "nombre": "Perron adulto Kg", "precio_venta": 27.00 },
  { "id": "uuid", "nombre": "Perron adulto Bulto", "precio_venta": 547.00 }
]
```

Solo estos 3 campos — **no** incluye `costo` ni `costo_validado` (el mapper `toSearchResult()` los
omite explícitamente, `productos.service.ts:145-151`).

Si no hay coincidencias (incluyendo el caso en que el único producto con ese nombre está inactivo):
`200 OK` con `[]` (no es un error).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `search` ausente, o presente pero vacío/solo-espacios (falla `@IsNotEmpty`/`@Matches`), o hay algún query param extra no declarado en `SearchProductosDto` (`forbidNonWhitelisted`) |
| `401` | Header `Authorization` ausente, mal formado, token inválido/expirado, o el usuario del token ya no existe — mismo comportamiento default de `JwtAuthGuard`/Passport documentado en `auth/API_INTEGRATION.md` §5 |

---

## 3. POST /productos

Alta de producto (`ProductosController.create` → `ProductosService.create`). Lo usan dos flujos
de cliente distintos según si mandan `costo` o no (alta rápida desde el buscador de ticket vs.
alta completa desde la pantalla de catálogo), pero el endpoint es el mismo para ambos.

**Headers**: `Authorization: Bearer <access_token>`, `Content-Type: application/json`.

### Request body — `CreateProductoDto` (`dto/create-producto.dto.ts`)

| Campo | Tipo | Validación real (class-validator) |
|---|---|---|
| `nombre` | `string` | `@IsString()` + `@IsNotEmpty()` + `@Matches(/\S/, { message: 'nombre should not be empty' })` + `@MaxLength(150)` — requerido, al menos un carácter no-espacio, máximo 150 caracteres. |
| `precio_venta` | `number` | `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min(0)` — requerido, número (no string numérico: no hay `transform: true`), hasta 2 decimales, `>= 0`. |
| `costo` | `number` | **Opcional**: `@IsOptional()` + `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min(0)` — si se manda, misma regla que `precio_venta` (hasta 2 decimales, `>= 0`). Si se omite, el servidor aplica el default de alta rápida (ver abajo). |

- Igual que en `search`, **no hay trim automático** de `nombre`: si el cliente manda
  `"  Producto  "`, la validación pasa (tiene caracteres no-espacio) y **se guarda tal cual, con
  los espacios**, porque `ProductosService.create` usa `dto.nombre` directamente sin `.trim()`
  (`productos.service.ts:63-69`) — a diferencia de `search`, donde el service sí hace el trim
  antes de usarlo. Ver [diferencias](#diferencias-vs-diseño-original).
- `costo_validado` **no está declarado** en el DTO: si el cliente lo manda (o cualquier otro
  campo no declarado, ej. `id`, `activo`, `created_at`), la request completa falla `400`
  (`forbidNonWhitelisted`).
- `usuario_id` tampoco está declarado en el DTO (mismo motivo): el producto creado queda asignado
  siempre al usuario del token, no a uno elegido por el cliente.

```json
// Alta rápida (sin costo)
{ "nombre": "Producto nuevo", "precio_venta": 45.50 }
```

```json
// Alta completa (con costo)
{ "nombre": "Alpiste Normal", "costo": 10.00, "precio_venta": 23.00 }
```

### Comportamiento del servidor — `costo`/`costo_validado` (`productos.service.ts:60-73`)

```
costoValidado = dto.costo !== undefined
si costoValidado:
    producto.costo = dto.costo
    producto.costo_validado = true
si no:
    producto.costo = 1               // DEFAULT_COSTO
    producto.costo_validado = false  // DEFAULT_COSTO_VALIDADO
```

- La condición es literalmente `dto.costo !== undefined`: mandar `costo: 0` **sí** cuenta como
  "costo presente" (`0 !== undefined`), así que produce `costo_validado: true` con `costo: 0` —
  no hay tratamiento especial para el valor `0`.
- `producto.activo` no se setea explícitamente en `create()`: queda en `true` por el `default`
  de columna (`producto.entity.ts:67`, ver [§1](#1-convenciones-generales)) — todo producto nace
  activo.
- No hay validación de nombre duplicado: `ProductosService.create` no consulta si ya existe un
  producto con el mismo `nombre` antes de insertar.

### Response — éxito `201 Created`

Shape `ProductoResponse` (`interfaces/producto-response.interface.ts`), construido por
`toResponse()`:

```json
{
  "id": "uuid",
  "nombre": "Alpiste Normal",
  "precio_venta": 23.00,
  "costo": 10.00,
  "costo_validado": true,
  "created_at": "2026-08-17T12:00:00.000Z",
  "updated_at": "2026-08-17T12:00:00.000Z"
}
```

Nunca incluye `activo` — ningún mapper de este módulo lo expone en `ProductoResponse` (el único
endpoint que devuelve `activo` es `DELETE /productos/:id`, ver [§6](#6-delete-productosid)).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `nombre` ausente, vacío/solo-espacios, o `> 150` caracteres; `precio_venta` ausente, no numérico, negativo, o con más de 2 decimales; `costo` presente pero no numérico, negativo, o con más de 2 decimales; o algún campo extra no declarado (`costo_validado`, `activo`, `usuario_id`, `id`, `created_at`, `updated_at`, etc.) por `forbidNonWhitelisted` |
| `401` | Mismo comportamiento que en `GET /productos` (ver arriba) |

---

## 4. GET /productos/catalogo

Devuelve el catálogo completo activo del usuario, sin filtro de búsqueda ni límite
(`ProductosController.findCatalogo` → `ProductosService.findCatalogo`).

**Headers**: `Authorization: Bearer <access_token>`. Sin body.

```
GET /productos/catalogo
```

- El método del controller **no declara ningún parámetro `@Query()`** (`productos.controller.ts:56-61`,
  solo recibe `@CurrentUser()`), a diferencia de `GET /productos`. Consecuencia observable: el
  `ValidationPipe` global nunca se ejecuta sobre la query string de esta ruta, así que **cualquier
  query param que el cliente agregue se ignora silenciosamente** — `GET /productos/catalogo?foo=bar`
  responde `200` exactamente igual que `GET /productos/catalogo` sin params, **no** produce `400`.
  Esto es una excepción real al patrón `forbidNonWhitelisted` que sí aplica a los otros 4
  endpoints del módulo — ver [diferencia 3](#diferencias-vs-diseño-original).

### Comportamiento del servidor (`productos.service.ts:80-87`)

- Filtro: `productos.usuario_id = <usuario del token>` **y** `productos.activo = true` — un
  producto borrado (soft-delete) nunca aparece aquí.
- Sin `search`: a diferencia de `GET /productos`, devuelve todo el catálogo activo del usuario,
  sin filtrar por nombre.
- Orden: `nombre ASC`.
- **Sin límite server-side** (no hay `take` en la query, a diferencia de `GET /productos`): se
  devuelve el catálogo completo, sin importar cuántos productos tenga el usuario.

### Response — éxito `200 OK`

Array de `ProductoCatalogoItem` (`interfaces/producto-response.interface.ts`), construido por
`toCatalogoItem()`:

```json
[
  { "id": "uuid-1", "nombre": "Alpiste Normal", "costo": 10.00, "precio_venta": 23.00, "costo_validado": true },
  { "id": "uuid-2", "nombre": "Maseca", "costo": 1.00, "precio_venta": 22.00, "costo_validado": false }
]
```

A diferencia de `GET /productos`, sí incluye `costo` y `costo_validado`; no incluye
`created_at`/`updated_at`/`activo`.

Si el usuario no tiene productos activos: `200 OK` con `[]` (no es un error).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `401` | Mismo comportamiento que en `GET /productos` (ver arriba) |

No hay `400` posible en este endpoint: no tiene body, y cualquier query param que el cliente
mande se ignora sin validar (ver nota arriba).

---

## 5. PATCH /productos/:id

Edición parcial de un producto existente (`ProductosController.update` → `ProductosService.update`).

**Headers**: `Authorization: Bearer <access_token>`, `Content-Type: application/json`.

### Path param

| Param | Tipo | Validación real |
|---|---|---|
| `id` | `string (uuid)` | `@Param('id', ParseUUIDPipe)` (`productos.controller.ts:74`) — debe ser un UUID sintácticamente válido (cualquier versión, `ParseUUIDPipe` sin `version` configurada), si no `400` **antes** de llegar al controller/service. Body default de Nest para este pipe, `message` como string simple: `{"statusCode":400,"message":"Validation failed (uuid is expected)","error":"Bad Request"}` (no hay `exceptionFactory` custom en el código). |

### Request body — `UpdateProductoDto` (`dto/update-producto.dto.ts`)

| Campo | Tipo | Validación real (class-validator) |
|---|---|---|
| `nombre` | `string` | Opcional (`@IsOptional()`). Si está presente: `@IsString()` + `@IsNotEmpty()` + `@Matches(/\S/, { message: 'nombre should not be empty' })` + `@MaxLength(150)` — misma regla que en `POST`. |
| `costo` | `number` | Opcional. Si está presente: `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min(0)`. |
| `precio_venta` | `number` | Opcional. Si está presente: `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min(0)`. |

- Los tres campos son individualmente opcionales a nivel de DTO (`class-validator` no valida "al
  menos uno"), pero **`ProductosService.update` exige que al menos uno esté presente**: si
  `dto.nombre === undefined && dto.costo === undefined && dto.precio_venta === undefined`, lanza
  `BadRequestException('At least one of nombre, costo, precio_venta must be provided')`
  (`productos.service.ts:97-99`) — `400` con `message` como **string simple**, no arreglo. Esta
  verificación ocurre **antes** de buscar el producto en base de datos: un body vacío (`{}`) da
  `400` incluso si el `id` de la URL no existe.
- Igual que en `POST`, **no hay trim automático** de `nombre`: `ProductosService.update` asigna
  `producto.nombre = dto.nombre` directamente (`productos.service.ts:108-110`), sin `.trim()`.
- **Campos explícitamente NO aceptados** (no declarados en el DTO, `400` por
  `forbidNonWhitelisted` si se mandan): `costo_validado`, `activo`, `usuario_id`, `id`,
  `created_at`, `updated_at`.

```json
{ "nombre": "Alpiste Normal", "costo": 11.00, "precio_venta": 24.00 }
```

### Comportamiento del servidor (`productos.service.ts:109-176`)

1. Valida que al menos un campo venga en el body (ver arriba), si no `400`.
2. Busca el producto por `id` **y** `usuarioId` (del JWT) **y** `activo = true`
   (`productos.service.ts:124-126`). Si no aparece ninguna fila, `404` con
   `NotFoundException('Producto not found')` — **mismo error genérico** para las tres causas
   posibles: el `id` no existe, existe pero es de otro usuario, o existe pero ya está
   `activo = false` (soft-borrado). El cliente no puede distinguir cuál ocurrió a partir de la
   respuesta — a propósito, para no filtrar entre cuentas si un producto ajeno existe o no.
3. Aplica únicamente los campos presentes en el body; los ausentes conservan su valor actual.
4. **`costo_validado` se fuerza siempre a `true`** (`producto.costoValidado = true;`,
   `productos.service.ts:146`), sin importar qué campos vinieron en el body — incluso si el
   cliente solo mandó `nombre` sin tocar `costo`.
5. `save()` persiste los cambios; `updated_at` se refresca automáticamente
   (`@UpdateDateColumn`).
6. **Efecto secundario silencioso — corrección retroactiva del histórico en la primera
   confirmación de costo** (`productos.service.ts:148-173`): si el producto tenía
   `costo_validado: false` **antes** de este `PATCH` (es decir, este es el primer `PATCH` que lo
   marca como `costo_validado: true`) y el valor de `costo` efectivamente cambió respecto al que
   tenía guardado, el servidor actualiza además, en la **misma transacción**
   (`dataSource.transaction`), todas las filas de `ticket_items` cuyo `producto_id` sea este
   producto y cuyo `costo_unitario` sea igual al costo viejo — dejándolas con el costo recién
   confirmado. Esto corrige la ganancia mostrada por ventas ya registradas mientras el producto
   tenía el costo placeholder (`costo: 1`, ver §3) sin costo real todavía. **No se modifica**
   `precio_venta_unitario`, `subtotal` de `ticket_items`, ni `total` de `tickets` — el precio de
   venta siempre fue el real, lo único corregido es el costo histórico. Si el producto **ya**
   tenía `costo_validado: true` (una edición de costo posterior a la primera confirmación), el
   histórico **no se toca**: ese cambio aplica solo hacia adelante, y las ventas ya registradas
   conservan su `costo_unitario` original como snapshot. Este efecto es completamente silencioso
   para el cliente: la respuesta de este endpoint no cambia (mismo `ProductoResponse`, sin campos
   nuevos) sea que la corrección haya ocurrido o no — el único efecto observable es que
   `GET /reportes/dia` y `GET /reportes/mes` (`reportes/API_INTEGRATION.md`) empiezan a devolver la
   ganancia corregida para las ventas pasadas de ese producto la próxima vez que se consulten.

### Response — éxito `200 OK`

Mismo shape `ProductoResponse` que `POST /productos`, ya con `costo_validado: true`:

```json
{
  "id": "uuid",
  "nombre": "Alpiste Normal",
  "precio_venta": 24.00,
  "costo": 11.00,
  "costo_validado": true,
  "created_at": "2026-01-10T09:00:00.000Z",
  "updated_at": "2026-08-17T12:05:00.000Z"
}
```

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `id` no es un UUID sintácticamente válido (`ParseUUIDPipe`, `message` string simple) |
| `400` | Ningún campo presente en el body — `nombre`, `costo` y `precio_venta` los tres `undefined` (`message` string simple, lanzado a mano) |
| `400` | `nombre` presente pero vacío/solo-espacios/`> 150` chars; `costo`/`precio_venta` presentes pero negativos/no numéricos/`> 2` decimales; o campo extra no declarado (`message` arreglo, `class-validator`) |
| `401` | No autenticado — mismo comportamiento que en `GET /productos` |
| `404` | `id` no existe, o existe pero pertenece a otro usuario, o existe pero `activo = false` — **mismo body genérico** `{"statusCode":404,"message":"Producto not found","error":"Not Found"}` para las tres causas, intencionalmente, para no revelar cuál ocurrió |

---

## 6. DELETE /productos/:id

Soft-delete de un producto (`ProductosController.remove` → `ProductosService.remove`). **No**
hace `DELETE FROM productos`: solo marca `activo = false`.

**Headers**: `Authorization: Bearer <access_token>`. Sin body (el controller no declara
`@Body()`) → no hace falta `Content-Type`.

```
DELETE /productos/:id
```

### Path param

| Param | Tipo | Validación real |
|---|---|---|
| `id` | `string (uuid)` | Mismas reglas que en `PATCH` (`@Param('id', ParseUUIDPipe)`, `productos.controller.ts:85`): `400` con `message` string si no es UUID sintácticamente válido. |

### Comportamiento del servidor (`productos.service.ts:131-143`)

1. Busca el producto por `id` **y** `usuarioId` (del JWT) **y** `activo = true`
   (`productos.service.ts:132-134`) — idéntico criterio de búsqueda que `PATCH`. Si no aparece
   ninguna fila, `404` con `NotFoundException('Producto not found')`, **mismo error genérico** para
   las tres causas posibles: `id` inexistente, de otro usuario, o **ya** `activo = false` (un
   segundo `DELETE` sobre el mismo producto responde `404`, no `200` idempotente — el double-delete
   se trata igual que "no existe").
2. `producto.activo = false;` y `save()` — actualiza también `updated_at` automáticamente. No hay
   `DELETE FROM productos` en ningún punto del código: la fila persiste (por el
   `ON DELETE RESTRICT` de `ticket_items.producto_id` y para no perder histórico de ventas).

### Response — éxito `200 OK`

Shape `ProductoDeleteResponse` (`interfaces/producto-response.interface.ts`):

```json
{ "id": "uuid", "activo": false }
```

`activo` siempre `false` en una respuesta exitosa (si fuera `true` no habría pasado el filtro
`where: { ..., activo: true }` del paso 1). Cuerpo mínimo de confirmación, no `204 No Content`
(consistente con que ningún endpoint de este backend usa `204`).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `id` no es un UUID sintácticamente válido |
| `401` | No autenticado — mismo comportamiento que en `GET /productos` |
| `404` | `id` no existe, pertenece a otro usuario, o ya está `activo = false` — mismo body genérico `{"statusCode":404,"message":"Producto not found","error":"Not Found"}` para las tres causas |

---

## Diferencias vs. diseño original

Comparado contra `c:\dev\ticket\src\features\productos\ENDPOINTS.md` completo (secciones 1 a 8).
El código sigue el diseño con fidelidad muy alta: las 5 rutas, el guard de sesión en todas, el
shape exacto de las 4 respuestas de éxito, el filtro `activo = true` en `GET /productos` y
`GET /productos/catalogo`, la lógica condicional `costo`/`costo_validado` de `POST`, el `404`
genérico unificando las tres causas en `PATCH`/`DELETE`, la exigencia de al menos un campo en
`PATCH`, el `200` con `{id, activo}` en `DELETE` en vez de `204`, la ausencia de endpoint de
"restaurar", el soft-delete vía `activo = false` sin `DELETE FROM`, la migración con `default true`
+ índice compuesto `(usuario_id, activo)`, y la ausencia de límite server-side en
`GET /productos/catalogo`. Las diferencias puntuales encontradas:

1. **`nombre` sigue sin trimearse automáticamente, y ahora esto también aplica a `PATCH`.** El
   diseño (§4) describía la regla de `nombre` en `PATCH` como "misma regla que `POST`" sin
   detallar el mecanismo. Igual que ya pasaba en `POST /productos` (diferencia ya señalada en la
   versión anterior de este documento), el `ValidationPipe` global no usa `transform: true`, así
   que la validación real es `@Matches(/\S/)` (rechaza solo-espacios) en vez de un trim explícito,
   y `ProductosService.update` asigna `producto.nombre = dto.nombre` sin `.trim()`
   (`productos.service.ts:108-110`). Un `nombre: "  Producto  "` en un `PATCH` se guarda con los
   espacios, igual que en `POST`. **Recomendación para el cliente móvil**: seguir trimeando
   `nombre` antes de enviarlo, tanto en `POST` como en `PATCH`.

2. **`GET /productos/catalogo` no valida ni rechaza query params extra — no aplica
   `forbidNonWhitelisted`.** El diseño (§1) establece como convención general de los 4 endpoints
   que "cualquier campo no declarado en el DTO correspondiente sigue haciendo fallar la request
   completa con `400`", pero el propio diseño (§2) ya anticipaba una posible excepción para este
   endpoint específico ("lo más simple es no declarar DTO de query en absoluto para este
   endpoint"). El código tomó esa opción: `findCatalogo` no declara ningún parámetro `@Query()`
   (`productos.controller.ts:56-61`), así que el `ValidationPipe` global nunca se ejecuta sobre la
   query string de esa ruta. Efecto observable: `GET /productos/catalogo?cualquier_cosa=x`
   responde `200` igual que sin el param — nunca `400`, a diferencia de `GET /productos`,
   `POST /productos` y `PATCH /productos/:id`, que sí rechazan cualquier campo extra. No es una
   contradicción con el diseño (que dejó la puerta abierta a esto), pero sí es una excepción real
   a la convención general que vale la pena que el cliente conozca explícitamente.

3. **`ParseUUIDPipe` (no un `@IsUUID()` de DTO) es lo que valida el formato de `:id` en
   `PATCH`/`DELETE`.** El diseño (§4, §5) solo especificaba el resultado ("`400` si `id` no es un
   UUID sintácticamente válido"), sin detallar el mecanismo. El código usa
   `@Param('id', ParseUUIDPipe)` en ambos métodos del controller — esto significa que el `400` de
   `id` mal formado ocurre **antes** de que el request llegue al controller/service, con el
   `message` como **string simple** (`"Validation failed (uuid is expected)"`, formato default de
   Nest para este pipe), a diferencia de los `400` de `class-validator` sobre el body, donde
   `message` es un arreglo. Dato nuevo, no una discrepancia de comportamiento observable para el
   cliente (sigue siendo `400`), pero relevante si el cliente llegara a parsear el `message` crudo.

No se encontraron diferencias en: rutas y métodos HTTP de los 5 endpoints, requisito de
`Authorization: Bearer` en todos, códigos de éxito (`200`/`201`), shape exacto de las 4 respuestas
de éxito (incluida la ausencia de `costo`/`costo_validado`/`activo` en `GET /productos`, la
presencia de `costo`/`costo_validado` sin timestamps en `GET /productos/catalogo`, y `{id, activo}`
en `DELETE`), el filtro `activo = true` agregado a `GET /productos` y `GET /productos/catalogo`,
la lógica `costo !== undefined → costo_validado = true` de `POST`, el `404` genérico unificando
"no existe" / "es de otro usuario" / "ya está inactivo" en `PATCH` y `DELETE`, la exigencia de al
menos un campo presente en `PATCH` (`400` si no), el tratamiento de un segundo `DELETE` sobre el
mismo producto como `404` (no `200` idempotente), la ausencia de endpoint de "restaurar", el uso
de soft-delete (`UPDATE ... SET activo = false`) en vez de `DELETE FROM`, el `200` con body en
`DELETE` en vez de `204`, la migración (`default true`, índice `(usuario_id, activo)`, sin
backfill necesario), la ausencia de límite server-side en `GET /productos/catalogo` (vs. el
`take: 20` de `GET /productos`), y la serialización de campos monetarios como número JSON.

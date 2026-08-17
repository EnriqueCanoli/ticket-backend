# API de productos — guía de integración para el cliente móvil

> Generado a partir de la **lectura del código real** en `ticket-backend/src/productos/`
> (`productos.controller.ts`, `productos.service.ts`, `dto/search-productos.dto.ts`,
> `dto/create-producto.dto.ts`, `interfaces/producto-response.interface.ts`,
> `entities/producto.entity.ts`, `productos.module.ts`) y de las piezas compartidas ya
> documentadas en `ticket-backend/src/auth/API_INTEGRATION.md` (`main.ts`, `JwtAuthGuard`,
> `JwtStrategy`). No se ejecutó el servidor ni se hicieron requests en vivo — todo lo
> documentado aquí se dedujo estáticamente del código fuente.
>
> El código es la fuente de verdad. Este documento reemplaza, para efectos de integración del
> frontend, a la sección 2 y 3 de `c:\dev\ticket\src\features\ticket\ENDPOINTS.md` (el diseño
> previo a implementar). Las diferencias encontradas entre diseño y código están señaladas
> explícitamente en la [última sección](#diferencias-vs-diseño-original).

## Índice

1. [Convenciones generales](#1-convenciones-generales)
2. [GET /productos](#2-get-productos)
3. [POST /productos](#3-post-productos)
4. [Diferencias vs. diseño original](#diferencias-vs-diseño-original)

---

## 1. Convenciones generales

- **Sin prefijo global**: las rutas son literalmente `GET /productos` y `POST /productos`, tal
  como están declaradas en `productos.controller.ts` (`@Controller()` vacío + ruta completa por
  método, mismo patrón que `auth/`).
- **Sesión requerida en los 2**: header `Authorization: Bearer <access_token>`. Ambos métodos
  están decorados con `@UseGuards(JwtAuthGuard)`, el mismo guard que protege `GET /me` — mismos
  401 y mismo body de error genérico de Passport documentados en
  `auth/API_INTEGRATION.md` §5.
- **Catálogo privado por cuenta**: `productos.usuario_id` (`producto.entity.ts`) se resuelve del
  JWT vía `@CurrentUser()` (`productos.controller.ts`), nunca del body/query — mismo mecanismo que
  ya usa `tickets.controller.ts`. En la práctica: `GET /productos` solo busca entre los productos
  del usuario autenticado, y `POST /productos` crea el producto a nombre de ese mismo usuario. No
  se expone `usuario_id` en ninguna respuesta (el cliente ya sabe de quién es el catálogo por su
  propia sesión) — el shape de `ProductoSearchResult`/`ProductoResponse` no cambia por esto.
- **`ValidationPipe` global** (`main.ts`): `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
  — el mismo pipe que usa `auth/`, sin `transform: true`. Consecuencias directas para el cliente:
  - Cualquier campo del body/query **no declarado** en el DTO correspondiente hace fallar la
    request entera con **`400`** (`forbidNonWhitelisted`), no se ignora silenciosamente.
  - Al no haber `transform: true`, el valor que finalmente recibe el controller/service es el
    **valor original enviado por el cliente**, no una versión normalizada. En particular, ningún
    DTO de este módulo hace `trim()` automático de strings — ver notas puntuales en cada
    endpoint.
- **Formato de error**: no hay `ExceptionFilter` custom (no se encontró ninguno en
  `productos.module.ts`, `app.module.ts` ni `main.ts`), así que todos los errores usan el formato
  default de Nest, igual que en `auth/`:
  ```json
  { "statusCode": 400, "message": ["..."], "error": "Bad Request" }
  ```
- **Campos monetarios**: `precio_venta` y `costo` son columnas `numeric(10,2)` en Postgres, pero
  `producto.entity.ts` les aplica `numericTransformer` (`database/transformers/numeric.transformer.ts`,
  `from: v => parseFloat(v)`), así que **sí llegan como número JSON**, no como string — el
  frontend puede operar sobre ellos directamente (`.toFixed(2)`, aritmética) sin parsear.
- **Fechas**: `created_at`/`updated_at` son columnas `timestamptz` (`CreateDateColumn`/
  `UpdateDateColumn`) que Nest serializa a JSON como string ISO 8601.

---

## 2. GET /productos

Búsqueda server-side por nombre (`ProductosController.search` → `ProductosService.search`).

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
  `productos.service.ts:32`) antes de construir el filtro — así que el resultado de la búsqueda
  sí queda correcto, solo que el trim no pasa por el DTO.

```
GET /productos?search=perro
```

### Comportamiento de búsqueda (`productos.service.ts`)

- Filtro: `ILIKE '%<search.trim()>%'` sobre `productos.nombre` (`ILike` de TypeORM), **acotado a
  `productos.usuario_id = <usuario del token>`** — case-insensitive, sin normalización de acentos.
  Un producto de otra cuenta nunca aparece en los resultados, sin importar el término buscado.
- Orden: `nombre ASC`.
- Límite: `take: 20` (`SEARCH_RESULT_LIMIT = 20`, `productos.service.ts:9`) — server-side, el
  cliente no puede pedir más ni paginar; no hay parámro `page`/`limit` en el DTO.

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
omite explícitamente, `productos.service.ts:56-62`).

Si no hay coincidencias: `200 OK` con `[]` (no es un error).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `search` ausente, o presente pero vacío/solo-espacios (falla `@IsNotEmpty`/`@Matches`), o hay algún query param extra no declarado en `SearchProductosDto` (`forbidNonWhitelisted`) |
| `401` | Header `Authorization` ausente, mal formado, token inválido/expirado, o el usuario del token ya no existe — mismo comportamiento default de `JwtAuthGuard`/Passport documentado en `auth/API_INTEGRATION.md` §5, body genérico `{"statusCode":401,"message":"Unauthorized","error":"Unauthorized"}` |

---

## 3. POST /productos

Alta rápida de producto (`ProductosController.create` → `ProductosService.create`).

**Headers**: `Authorization: Bearer <access_token>`, `Content-Type: application/json`.

### Request body — `CreateProductoDto` (`dto/create-producto.dto.ts`)

| Campo | Tipo | Validación real (class-validator) |
|---|---|---|
| `nombre` | `string` | `@IsString()` + `@IsNotEmpty()` + `@Matches(/\S/, { message: 'nombre should not be empty' })` + `@MaxLength(150)` — requerido, al menos un carácter no-espacio, máximo 150 caracteres. |
| `precio_venta` | `number` | `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min(0)` — requerido, número (no string numérico: no hay `transform: true`), hasta 2 decimales, `>= 0`. |

- Igual que en `search`, **no hay trim automático** de `nombre`: si el cliente manda
  `"  Producto  "`, la validación pasa (tiene caracteres no-espacio) y **se guarda tal cual, con
  los espacios**, porque `ProductosService.create` usa `dto.nombre` directamente sin `.trim()`
  (`productos.service.ts:44-51`) — a diferencia de `search`, donde el service sí hace el trim
  antes de usarlo. Ver [diferencias](#diferencias-vs-diseño-original).
- `costo` y `costo_validado` **no están declarados** en el DTO: si el cliente los manda (o
  cualquier otro campo, ej. `id`, `created_at`), la request completa falla `400`
  (`forbidNonWhitelisted`).
- `usuario_id` tampoco está declarado en el DTO (mismo motivo): el producto creado queda asignado
  siempre al usuario del token, no a uno elegido por el cliente.

```json
{ "nombre": "Producto nuevo", "precio_venta": 45.50 }
```

### Response — éxito `201 Created`

Shape `ProductoResponse` (`interfaces/producto-response.interface.ts`), construido por
`ProductosService.create` → `toResponse()`:

```json
{
  "id": "uuid",
  "nombre": "Producto nuevo",
  "precio_venta": 45.50,
  "costo": 1.00,
  "costo_validado": false,
  "created_at": "2026-08-17T12:00:00.000Z",
  "updated_at": "2026-08-17T12:00:00.000Z"
}
```

- `costo` se fija siempre en `1` (`DEFAULT_COSTO = 1`, `productos.service.ts:16`) y
  `costo_validado` siempre en `false` (`DEFAULT_COSTO_VALIDADO = false`, `productos.service.ts:17`),
  sin importar lo que traiga el default de la columna en la entidad (`producto.entity.ts:44`
  declara `default: true` para `costo_validado` a nivel de columna, pero el service **siempre**
  pasa `costoValidado: false` explícitamente al crear, así que ese default de columna nunca aplica
  en este flujo — solo aplicaría a un `INSERT` que no pase por `ProductosService.create`, algo que
  no ocurre en el código actual).
- No hay validación de nombre duplicado: `ProductosService.create` no consulta si ya existe un
  producto con el mismo `nombre` antes de insertar.

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `nombre` ausente, vacío/solo-espacios, o `> 150` caracteres; `precio_venta` ausente, no numérico, negativo, o con más de 2 decimales; o algún campo extra no declarado (`costo`, `costo_validado`, `id`, etc.) por `forbidNonWhitelisted` |
| `401` | Mismo comportamiento que en `GET /productos` (ver arriba) |

---

## Diferencias vs. diseño original

Comparado contra `c:\dev\ticket\src\features\ticket\ENDPOINTS.md`, secciones 2 y 3. El código
sigue el diseño con fidelidad muy alta (rutas, guard de sesión, shapes de respuesta exactos,
límite de búsqueda de 20, orden `nombre ASC`, defaults de `costo`/`costo_validado`, ausencia de
validación de nombre duplicado, campos numéricos como número JSON). Las diferencias puntuales
encontradas:

1. **`search` y `nombre` no se trimean automáticamente vía el DTO**, a diferencia de lo que el
   diseño daba a entender ("`400` si, luego de `trim()`, queda vacío", ENDPOINTS.md §2). El
   `ValidationPipe` global no usa `transform: true` (mismo patrón ya señalado en
   `auth/API_INTEGRATION.md` diferencia 1 para `email`), así que la validación real se hace con
   `@Matches(/\S/)` (rechaza strings de solo espacios) en vez de un trim explícito.
   - En `GET /productos`, esto no tiene efecto observable para el cliente: el service igual hace
     `search.trim()` antes de construir el filtro (`productos.service.ts:32`), así que el
     resultado de la búsqueda es el mismo que si el DTO trimeara.
   - En `POST /productos` sí hay un efecto observable: `nombre` se persiste **tal cual lo envía el
     cliente, sin trim**, porque `ProductosService.create` no llama `.trim()` sobre `dto.nombre`.
     Un `nombre: "  Producto  "` termina guardado con los espacios. **Recomendación para el
     cliente móvil**: hacer `.trim()` sobre `nombre` antes de enviarlo a `POST /productos`, igual
     que se recomienda para `email` en `auth/`.

2. **Mensajes de validación con texto propio, no especificados en el diseño.** El diseño no fijaba
   el string de `message` para los casos de "vacío tras trim". El código usa literalmente
   `"search should not be empty"` y `"nombre should not be empty"` (mensajes custom de
   `@Matches`) — dato nuevo, útil si el cliente llegara a mostrar el mensaje crudo del backend,
   pero no una discrepancia de comportamiento.

No se encontraron diferencias en: rutas y métodos HTTP, requisito de `Authorization: Bearer`,
código de éxito (200/201), shape exacto de ambas respuestas (incluida la ausencia de
`costo`/`costo_validado` en `GET /productos`), comportamiento `ILIKE` case-insensitive sin
normalización de acentos, orden `nombre ASC`, límite server-side de 20 resultados, defaults
`costo = 1` / `costo_validado = false` en el alta rápida, rechazo de campos extra
(`forbidNonWhitelisted`) para `costo`, `costo_validado`, `id`, `created_at`, `updated_at` en
`POST /productos`, ausencia de validación de nombre duplicado, y serialización de campos
monetarios como número JSON.

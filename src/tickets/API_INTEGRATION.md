# API de tickets — guía de integración para el cliente móvil

> Generado a partir de la **lectura del código real** en `ticket-backend/src/tickets/`
> (`tickets.controller.ts`, `tickets.service.ts`, `dto/create-ticket.dto.ts`,
> `dto/create-ticket-item.dto.ts`, `interfaces/ticket-response.interface.ts`,
> `entities/ticket.entity.ts`, `entities/ticket-item.entity.ts`, `tickets.module.ts`) y de las
> piezas compartidas ya documentadas en `ticket-backend/src/auth/API_INTEGRATION.md` (`main.ts`,
> `JwtAuthGuard`, `JwtStrategy`, `CurrentUser`). También se leyó
> `ticket-backend/src/productos/entities/producto.entity.ts` y
> `ticket-backend/src/database/transformers/numeric.transformer.ts` para confirmar el shape de
> los campos snapshoteados. No se ejecutó el servidor ni se hicieron requests en vivo — todo lo
> documentado aquí se dedujo estáticamente del código fuente.
>
> El código es la fuente de verdad. Este documento reemplaza, para efectos de integración del
> frontend, a la sección 4 de `c:\dev\ticket\src\features\ticket\ENDPOINTS.md` (el diseño previo a
> implementar). Las diferencias encontradas entre diseño y código están señaladas explícitamente
> en la [última sección](#diferencias-vs-diseño-original).

## Índice

1. [Convenciones generales](#1-convenciones-generales)
2. [POST /tickets](#2-post-tickets)
3. [Diferencias vs. diseño original](#diferencias-vs-diseño-original)

---

## 1. Convenciones generales

- **Sin prefijo global**: la ruta es literalmente `POST /tickets`, declarada en
  `tickets.controller.ts` (`@Controller()` vacío + ruta completa en el método, mismo patrón que
  `auth/` y `productos/`).
- **Sesión requerida**: header `Authorization: Bearer <access_token>`. El endpoint está decorado
  con `@UseGuards(JwtAuthGuard)` — mismo guard, mismos 401 y mismo body de error genérico de
  Passport documentados en `auth/API_INTEGRATION.md` §5.
- **`usuario_id` se resuelve del token, nunca del body**: el controller usa
  `@CurrentUser() usuario: Usuario` (`auth/decorators/current-user.decorator.ts`), que lee
  `request.user` — el objeto `Usuario` completo que `JwtStrategy.validate()` adjuntó tras resolver
  `payload.sub` contra la base de datos (mismo mecanismo que `GET /me`). El controller pasa
  `usuario.id` al service (`tickets.controller.ts:17-18`).
- **`ValidationPipe` global** (`main.ts`): `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`,
  sin `transform: true` — mismo pipe que `auth/` y `productos/`. Cualquier campo no declarado en
  `CreateTicketDto` o `CreateTicketItemDto` hace fallar la request entera con `400`.
- **Formato de error**: sin `ExceptionFilter` custom, formato default de Nest:
  ```json
  { "statusCode": 400, "message": ["..."], "error": "Bad Request" }
  ```
  Nota: el `400` de "producto_id no existe" (ver abajo) es lanzado a mano con
  `BadRequestException` desde el service, así que su `message` es un **string simple**, no un
  arreglo — a diferencia de los `400` de validación de DTO, donde `message` sí es un arreglo de
  strings de `class-validator`.
- **Campos monetarios/cantidad**: `total`, `precio_venta_unitario`, `costo_unitario`, `subtotal` y
  `cantidad` son columnas `numeric` en Postgres, pero todas usan `numericTransformer`
  (`from: v => parseFloat(v)`) en las entidades `Ticket`/`TicketItem`, así que llegan como
  **número JSON**, no como string.
- **Fechas**: `created_at` (`timestamptz`, `CreateDateColumn`) serializado como string ISO 8601.
  El ticket **no tiene `updated_at`** — la entidad `Ticket` solo declara `createdAt`
  (`entities/ticket.entity.ts:45-46`; el ticket se trata como inmutable, no hay update).
- **Transacción**: `TicketsService.create` corre dentro de `dataSource.transaction(...)` — el
  `INSERT` de `tickets` y el de todas sus `ticket_items` ocurren en una sola transacción de base
  de datos.

---

## 2. POST /tickets

Crea un ticket con sus líneas (`TicketsController.create` → `TicketsService.create`).

**Headers**: `Authorization: Bearer <access_token>`, `Content-Type: application/json`.

### Request body — `CreateTicketDto` (`dto/create-ticket.dto.ts`)

| Campo | Tipo | Validación real (class-validator) |
|---|---|---|
| `items` | `array` | `@IsArray()` + `@ArrayMinSize(1)` + `@ValidateNested({ each: true })` con `@Type(() => CreateTicketItemDto)` — requerido, al menos 1 elemento, cada elemento se valida como `CreateTicketItemDto`. |

### Request body — `CreateTicketItemDto` (`dto/create-ticket-item.dto.ts`), por cada item

| Campo | Tipo | Validación real (class-validator) |
|---|---|---|
| `producto_id` | `string (uuid)` | `@IsUUID()` — formato UUID válido (cualquier versión aceptada por `class-validator`, no se restringe a v4 específicamente). No valida existencia en BD a este nivel (eso ocurre en el service, ver abajo). |
| `cantidad` | `number` | `@IsNumber({ maxDecimalPlaces: 3 })` + `@IsPositive()` — requerido, número (no string numérico: no hay `transform: true`), hasta 3 decimales, estrictamente `> 0`. No hay piso de `0.1`. |

**Campos explícitamente NO aceptados** (no declarados; `400` por `forbidNonWhitelisted` si se
mandan): en la raíz, `usuario_id` y `total`; en cada item, `precio_venta_unitario`,
`costo_unitario`, `subtotal`, `id`.

```json
{
  "items": [
    { "producto_id": "uuid-1", "cantidad": 2 },
    { "producto_id": "uuid-2", "cantidad": 0.5 }
  ]
}
```

### Comportamiento del servidor (`tickets.service.ts`)

1. Junta los `producto_id` de todos los items y los deduplica (`new Set(...)`).
2. Busca **todos** esos productos de una sola vez, acotado al catálogo del usuario autenticado
   (`productoRepository.find({ where: { id: In(...), usuarioId } })`, mismo `usuarioId` resuelto
   del JWT que se usa para el `ticket.usuario_id`). Un `producto_id` que existe pero pertenece a
   otra cuenta **no** aparece en el resultado de este `find` — se trata exactamente igual que un
   `producto_id` inexistente, mismo `400` (ver abajo), no hay un caso de error distinto para
   "existe pero no es tuyo". Si falta alguno, lanza `BadRequestException` con un mensaje que
   **lista los IDs faltantes ya deduplicados** (ver [errores](#errores)) — **antes** de abrir la
   transacción, así que no se crea ningún registro si esto falla.
3. Dentro de la transacción: por cada item del request (sin deduplicar — un mismo `producto_id`
   repetido produce una línea de `ticket_items` por cada aparición, nunca se fusionan),
   snapshotea `precio_venta_unitario = producto.precioVenta` y `costo_unitario = producto.costo`
   **del objeto `producto` obtenido en el paso 2** (no de una consulta nueva dentro de la
   transacción), y calcula `subtotal = cantidad * precio_venta_unitario`.
4. Calcula `total = SUM(subtotal)` de todas las líneas.
5. Inserta el `ticket` (con `usuario_id` y `total`) y luego todos los `ticket_items`, en la misma
   transacción.
6. Arma la respuesta: `nombre_producto` de cada línea sale del **mismo objeto `producto`** leído
   en el paso 2 (`linea.producto.nombre`) — no es un `JOIN`/consulta separada ejecutada al momento
   de construir la respuesta. En la práctica es "el nombre vigente al momento de procesar la
   request" (un único `find` justo al inicio del método, antes de la transacción), no un dato
   snapshoteado en la fila de `ticket_items` (que en efecto no tiene columna `nombre_producto`, la
   BD no lo persiste) — ver matiz en [diferencias](#diferencias-vs-diseño-original).

### Response — éxito `201 Created`

Shape `TicketResponse` (`interfaces/ticket-response.interface.ts`):

```json
{
  "id": "uuid-ticket",
  "usuario_id": "uuid-usuario",
  "total": 68.50,
  "created_at": "2026-08-17T12:00:00.000Z",
  "items": [
    {
      "id": "uuid-item-1",
      "producto_id": "uuid-1",
      "nombre_producto": "Perron adulto Kg",
      "cantidad": 2,
      "precio_venta_unitario": 27.00,
      "costo_unitario": 1.00,
      "subtotal": 54.00
    },
    {
      "id": "uuid-item-2",
      "producto_id": "uuid-2",
      "nombre_producto": "Salsa Valentina",
      "cantidad": 0.5,
      "precio_venta_unitario": 29.00,
      "costo_unitario": 18.00,
      "subtotal": 14.50
    }
  ]
}
```

No hay `updated_at` en la raíz (ver [convenciones](#1-convenciones-generales)).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `items` ausente, no es array, o es `[]` (`@IsArray`/`@ArrayMinSize(1)`) |
| `400` | Algún `items[].producto_id` con formato inválido (no UUID) (`@IsUUID()`) |
| `400` | Algún `items[].cantidad` ausente, `<= 0`, no numérico, o con más de 3 decimales (`@IsNumber({maxDecimalPlaces:3})`/`@IsPositive()`) |
| `400` | Algún campo extra no declarado en la raíz o en algún item (`usuario_id`, `total`, `precio_venta_unitario`, `costo_unitario`, `subtotal`, `id`, etc.) — `forbidNonWhitelisted`, `message` es un arreglo |
| `400` | Algún `items[].producto_id` (deduplicado) no existe en `productos`, **o existe pero pertenece a otro usuario** (no al dueño del token) — ambos casos son indistinguibles para el cliente, mismo `BadRequestException` lanzada a mano en `tickets.service.ts`, mensaje **string simple** con el formato exacto `` `Los siguientes producto_id no existen: ${missingIds.join(', ')}` ``, ej. `"Los siguientes producto_id no existen: uuid-x, uuid-y"` |
| `401` | Header `Authorization` ausente, mal formado, token inválido/expirado, o usuario del token ya no existe — mismo comportamiento default de `JwtAuthGuard`/Passport documentado en `auth/API_INTEGRATION.md` §5 |

---

## Diferencias vs. diseño original

Comparado contra `c:\dev\ticket\src\features\ticket\ENDPOINTS.md`, sección 4. El código sigue el
diseño con fidelidad muy alta (ruta, guard de sesión, `usuario_id` resuelto del JWT y nunca del
body, validación de `items`/`producto_id`/`cantidad`, snapshot de precios en el momento de crear
la línea, `total = SUM(subtotal)` nunca confiado del cliente, transacción única, no fusión de
`producto_id` repetidos, `400` en vez de `404` para `producto_id` inexistente, shape de respuesta
campo por campo idéntico). Las diferencias/matices puntuales encontrados:

1. **`nombre_producto` no sale de un `JOIN` re-ejecutado al momento de construir la respuesta,
   sino del mismo objeto `producto` obtenido en la consulta inicial de existencia (`find` con
   `In(uniqueProductoIds)`, `tickets.service.ts:35-38`), hecha **antes** de abrir la transacción.**
   El diseño (ENDPOINTS.md §4, texto bajo el ejemplo de respuesta) describía esto como "un `JOIN`
   contra `productos.nombre` vigente al momento de la consulta, no snapshoteado", dando a entender
   una consulta separada en el momento de responder. En el código real es la **misma** lectura de
   `productos` que ya se usa para: (a) confirmar que todos los `producto_id` existen, y (b)
   snapshotear `precio_venta_unitario`/`costo_unitario`. Para cualquier request individual esto es
   indistinguible en la práctica (todo ocurre en la misma fracción de segundo, antes de la
   transacción), pero es una diferencia real de mecanismo: si el `nombre` de un producto cambiara
   *mientras* la transacción de un ticket está en curso (ventana muy estrecha, entre el `find`
   inicial y el `COMMIT`), la respuesta reflejaría el nombre de **antes** del cambio, no un `JOIN`
   fresco post-commit. No afecta el contrato de la API (mismo campo, mismo tipo, mismo
   comportamiento de "no snapshoteado en BD"), es una precisión de implementación.

2. **`message` del error `400` de "producto_id no existe" es un string, no un arreglo.** El
   diseño no especificaba el tipo exacto de `message` para este caso más allá de "listar el/los
   `producto_id` que no se encontraron" (ENDPOINTS.md §4, tabla de errores). El código usa
   `BadRequestException(string)` directamente (no pasa por `class-validator`), así que
   `message` es un string simple (`"Los siguientes producto_id no existen: ..."`), a diferencia de
   los demás `400` de este mismo endpoint (fallas de DTO), donde `message` es un arreglo de
   strings. El cliente no puede asumir que todo `400` de este endpoint tiene `message` como
   arreglo — debe manejar ambos casos si quiere mostrar el detalle.

3. **Los IDs faltantes que se listan en el mensaje de error están deduplicados**, no es una lista
   con posibles repetidos por cada item del request. El diseño no especificaba esto (solo decía
   "listar el/los `producto_id` que no se encontraron"); el código deduplica porque construye la
   lista de búsqueda con `new Set(productoIds)` antes de calcular `missingIds`
   (`tickets.service.ts:33,40`). No es una discrepancia de comportamiento observable relevante,
   solo una precisión: si el cliente mandó el mismo `producto_id` inexistente dos veces, aparece
   una sola vez en el mensaje.

No se encontraron diferencias en: ruta y método HTTP, requisito de `Authorization: Bearer`,
código de éxito `201`, resolución de `usuario_id` desde el JWT (nunca del body), reglas de
`producto_id`/`cantidad` (UUID, `> 0`, hasta 3 decimales, sin piso de `0.1`), rechazo de campos
extra (`usuario_id`, `total`, `precio_venta_unitario`, `costo_unitario`, `subtotal`, `id`) por
`forbidNonWhitelisted`, comportamiento de "todo o nada" si algún `producto_id` no existe (`400`,
no se crea ticket parcial, y es `400` en vez de `404`), snapshot de `precio_venta_unitario`/
`costo_unitario` al momento de crear la línea, cálculo de `subtotal`/`total`, no fusión de líneas
con `producto_id` repetido, transacción única para `ticket` + `ticket_items`, shape exacto de la
respuesta (incluidos los nombres de campo en snake_case y la inclusión de `nombre_producto` pese
a no ser columna de `ticket_items`), y serialización de campos numéricos como número JSON.

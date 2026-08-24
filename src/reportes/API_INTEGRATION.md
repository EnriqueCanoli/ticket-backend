# API de reportes — guía de integración para el cliente móvil

> Generado a partir de la **lectura del código real** en `ticket-backend/src/reportes/`
> (`reportes.controller.ts`, `reportes.service.ts`, `interfaces/reporte-response.interface.ts`,
> `reportes.module.ts`) y de las piezas compartidas ya documentadas en
> `ticket-backend/src/auth/API_INTEGRATION.md` (`main.ts`, `JwtAuthGuard`, `JwtStrategy`,
> `CurrentUser`). También se leyeron `ticket-backend/src/tickets/entities/ticket.entity.ts` y
> `ticket-backend/src/tickets/entities/ticket-item.entity.ts` para confirmar nombres de columna y
> relaciones usadas en los `JOIN`. No se ejecutó el servidor ni se hicieron requests en vivo — todo
> lo documentado aquí se dedujo estáticamente del código fuente.
>
> El código es la fuente de verdad. Este documento reemplaza, para efectos de integración del
> frontend, a `c:\dev\ticket\src\features\vendido\ENDPOINTS.md` (el diseño previo a implementar).
> Las diferencias encontradas entre diseño y código están señaladas explícitamente en la
> [última sección](#diferencias-vs-diseño-original) — la más relevante es el comportamiento de
> `anio` en `GET /reportes/mes`, documentado en detalle en [§3](#3-get-reportesmes).

## Índice

1. [Convenciones generales](#1-convenciones-generales)
2. [GET /reportes/dia](#2-get-reportesdia)
3. [GET /reportes/mes](#3-get-reportesmes)
4. [Diferencias vs. diseño original](#diferencias-vs-diseño-original)

---

## 1. Convenciones generales

- **Sin prefijo global**: las rutas son literalmente `GET /reportes/dia` y `GET /reportes/mes`, tal
  como están declaradas en `reportes.controller.ts` (`@Controller()` vacío + ruta completa por
  método, mismo patrón que `auth/`, `productos/` y `tickets/`).
- **Sesión requerida en los 2**: header `Authorization: Bearer <access_token>`. Los 2 métodos están
  decorados con `@UseGuards(JwtAuthGuard)` — mismo guard que protege el resto de la API, mismos
  `401` y mismo body de error genérico de Passport documentados en `auth/API_INTEGRATION.md` §5:
  ```json
  { "statusCode": 401, "message": "Unauthorized", "error": "Unauthorized" }
  ```
- **Alcance estrictamente por cuenta, sin excepción**: ambos endpoints filtran siempre por
  `t.usuarioId = <usuario del token>` (`reportes.controller.ts:36-37`, `:70`), resuelto vía
  `@CurrentUser() usuario: Usuario` — nunca de query/body. Un usuario nunca ve ventas de otra
  cuenta.
- **`ValidationPipe` global** (`main.ts`): `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`,
  sin `transform: true` — mismo pipe que el resto de módulos. **Ninguno de los dos endpoints declara
  un DTO de query** (`@Query()` sobre una clase): `GET /reportes/dia` no tiene ningún `@Query()` en
  absoluto, y `GET /reportes/mes` extrae `mes`/`anio` con `@Query('mes', ...)`/`@Query('anio', ...)`
  por parámetro individual, no con un objeto validado por `class-validator`. Consecuencia
  observable: **`forbidNonWhitelisted` nunca se aplica a la query string de ninguno de los dos
  endpoints** — cualquier query param extra que el cliente agregue se ignora silenciosamente, nunca
  produce `400`. Mismo patrón/mecanismo que `GET /productos/catalogo` (ver
  `productos/API_INTEGRATION.md` §4). Ver [diferencia 2](#diferencias-vs-diseño-original).
- **Validación de `mes`/`anio` vía `ParseIntPipe` por parámetro** (`reportes.controller.ts:59-60`),
  no vía DTO: como el `ValidationPipe` global no usa `transform: true`, un DTO con `@IsInt()` sobre
  un query param fallaría siempre (los query params llegan como `string` crudo). `ParseIntPipe` no
  valida rangos, así que el rango `1`–`12` de `mes` y que `anio` sea positivo se valida a mano en el
  controller, **después** de que `ParseIntPipe` ya convirtió el valor a `number` (o lo rechazó antes
  de llegar ahí).
- **Formato de error**: no hay `ExceptionFilter` custom (no se encontró ninguno en
  `reportes.module.ts`, `app.module.ts` ni `main.ts`), así que todos los errores usan el formato
  default de Nest. Los `400` de este módulo tienen `message` como **string simple** en todos los
  casos observables (nunca arreglo, porque no hay validación de DTO involucrada — ver detalle por
  endpoint).
- **Campos monetarios y de cantidad como número JSON, pero no vía `numericTransformer`**: ambos
  endpoints usan `createQueryBuilder(...).getRawMany()` con agregados/expresiones (`SUM`,
  `cantidad * costoUnitario`, etc.), que devuelven objetos planos **sin pasar por el
  `numericTransformer`** que sí aplica en las entidades `Producto`/`TicketItem`/`Ticket` (ver
  `productos/API_INTEGRATION.md` §1, `tickets/API_INTEGRATION.md` §1). El driver `pg` entrega esas
  columnas `numeric` como `string`. `ReportesService` las convierte a mano con `Number(...)` en
  `toReporteDiaItem`/`toReporteMesItem` (`reportes.service.ts:110-130`) antes de responder — el
  cliente sí recibe número JSON (`"venta": 46`, no `"venta": "46.00"`), pero es responsabilidad
  explícita del service, no de un transformer de entidad.
- **`t.createdAt` (columna `timestamptz`)**: ambos endpoints arman su rango de fechas en SQL
  (`CURRENT_DATE` para `dia`, `make_date(...)` + `EXTRACT(YEAR FROM CURRENT_DATE)` para `mes`),
  nunca con `Date` de JavaScript — así "hoy"/"año actual" quedan definidos por la zona horaria de la
  **sesión de Postgres**, no por la del proceso de Node ni la del dispositivo del cliente. No se
  encontró configuración explícita de timezone en `src/` (ni en `main.ts` ni en la config de
  TypeORM): el comportamiento depende de la config de sesión/SO del servidor de base de datos.
- **`GET /reportes/dia` y `GET /reportes/mes` nunca lanzan `404`**: ambos responden `200 OK` con
  `[]` cuando no hay filas que cumplan el filtro (usuario sin ventas ese día/mes) — no es un error.
- **`costo_validado` en ambos endpoints**: viene del `innerJoin` contra `productos` que ya existía
  para `nombre_producto`, y refleja el estado **actual** de `productos.costo_validado`, no un
  snapshot tomado al momento de la venta — ver el detalle y el porqué en [§2](#2-get-reportesdia) y
  [§3](#3-get-reportesmes).
- **`reportes.module.ts` registra `Ticket`, `TicketItem` y `Producto`** en `TypeOrmModule.forFeature`,
  aunque `ReportesService` solo inyecta el repositorio de `TicketItem`: recorre las otras dos tablas
  vía relaciones del `QueryBuilder` (`ti.ticket`, `ti.producto`), no con repositorios propios — nota
  de implementación, sin efecto en el contrato HTTP.

---

## 2. GET /reportes/dia

Devuelve las líneas de venta individuales del día calendario actual (según la sesión de Postgres)
del usuario autenticado (`ReportesController.getDia` → `ReportesService.getDia`).

**Headers**: `Authorization: Bearer <access_token>`. Sin body ni query params.

```
GET /reportes/dia
```

El método del controller no declara ningún parámetro `@Query()` (`reportes.controller.ts:36`, solo
recibe `@CurrentUser()`) — cualquier query param que el cliente agregue se ignora silenciosamente
(ver [§1](#1-convenciones-generales)).

### Comportamiento del servidor (`reportes.service.ts:49-68`)

- `JOIN` interno (`innerJoin`) de `ticket_items` contra `tickets` (`ti.ticket`) y `productos`
  (`ti.producto`).
- Filtro: `t.usuarioId = <usuario del token>` **y** `t.createdAt >= CURRENT_DATE` **y**
  `t.createdAt < CURRENT_DATE + interval '1 day'` — el rango completo se calcula en SQL, no en JS.
- `costo` es el **costo total de la línea** (`ti.cantidad * ti.costoUnitario`), no el costo
  unitario.
- `hora` se formatea en SQL: `TO_CHAR(t.createdAt, 'HH24:MI')` — string `"HH:mm"` en formato 24
  horas, con la misma referencia horaria (sesión de Postgres) usada para decidir el rango del día.
  El cliente no necesita convertir ningún timestamp ni aplicar su propia zona horaria.
- Orden: `t.createdAt ASC` (más antigua primero).
- Sin límite ni paginación.
- El filtro de rango es sobre `tickets.created_at` (no existe `created_at` propio en
  `ticket_items`): todas las líneas de un mismo ticket comparten el mismo `created_at`, así que un
  ticket entero cae o no cae dentro del día, nunca a medias.

### Response — éxito `200 OK`

Array de `ReporteDiaItem` (`interfaces/reporte-response.interface.ts`), construido por
`toReporteDiaItem()`:

```json
[
  {
    "id": "uuid-ticket-item",
    "producto_id": "uuid-producto",
    "nombre_producto": "Alpiste Normal",
    "cantidad": 2,
    "venta": 46,
    "costo": 20,
    "hora": "08:05",
    "costo_validado": true
  }
]
```

Si el usuario no tiene ventas hoy: `200 OK` con `[]` (no es un error).

**`costo_validado`**: viene del mismo `innerJoin('ti.producto', 'p')` ya usado para `nombre_producto`
(`.addSelect('p.costoValidado', 'costo_validado')`, `reportes.service.ts`) — es el valor **actual**
de `productos.costo_validado` para el producto de esa línea, no un snapshot congelado al momento de
la venta. Por eso una línea de una venta ya registrada puede pasar de `false` a `true` entre dos
llamadas a este endpoint, sin que la venta se haya vuelto a tocar: basta con que el producto se
valide después (`PATCH /productos/:id` con `costo`) — mismo momento en el que, si el costo cambió,
se dispara la corrección retroactiva de `ticket_items.costo_unitario` ya documentada en
`productos/API_INTEGRATION.md` (punto 6 de la sección `PATCH /productos/:id`).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `401` | Header `Authorization` ausente, mal formado, token inválido/expirado, o el usuario del token ya no existe — mismo comportamiento default de `JwtAuthGuard`/Passport documentado en `auth/API_INTEGRATION.md` §5 |

No hay `400` posible: el endpoint no acepta ningún input (ni body ni query params validados).

---

## 3. GET /reportes/mes

Devuelve los totales del mes/año pedidos, agregados por producto, del usuario autenticado
(`ReportesController.getMes` → `ReportesService.getMes`).

**Headers**: `Authorization: Bearer <access_token>`. Sin body.

### Query params

| Param | Tipo | Requerido | Validación real |
|---|---|---|---|
| `mes` | `integer` | **Sí** | `@Query('mes', ParseIntPipe)` (`reportes.controller.ts:59`). Debe ser un entero (`ParseIntPipe`, ver mecanismo abajo) y estar en `1`–`12` (chequeo manual en el controller, `reportes.controller.ts:63-65`). |
| `anio` | `integer` | **No** | `@Query('anio', new ParseIntPipe({ optional: true }))` (`reportes.controller.ts:60`). Si viene, debe ser un entero `>= 1` (chequeo manual, `reportes.controller.ts:66-68`). Ver comportamiento exacto cuando se omite más abajo. |

```
GET /reportes/mes?mes=7
GET /reportes/mes?mes=1&anio=2026
```

#### Mecanismo de `ParseIntPipe` (aplica a ambos params)

`ParseIntPipe` corre **antes** que los chequeos manuales de rango del controller. Su regla interna
(`node_modules/@nestjs/common/pipes/parse-int.pipe.js`) es `/^-?\d+$/` sobre el valor crudo:

- Acepta enteros con signo (`"7"`, `"-3"`), **rechaza** decimales (`"7.5"`), notación no numérica, o
  cualquier string que no matchee ese regex exactamente.
- Si falla, lanza `400` **antes** de que el controller llegue a ejecutar cualquier lógica propia,
  con el body default de Nest para este pipe (`message` como **string simple**, no arreglo):
  ```json
  { "statusCode": 400, "message": "Validation failed (numeric string is expected)", "error": "Bad Request" }
  ```
- Para `mes` (`ParseIntPipe` sin opciones): si el query param **no viene en absoluto**
  (`GET /reportes/mes` sin `mes`), el valor que recibe el pipe es `undefined`, que **no** matchea el
  regex numérico → mismo `400` de arriba (`mes` es efectivamente obligatorio, aunque el mensaje no lo
  diga explícitamente).
- Para `anio` (`ParseIntPipe({ optional: true })`): si el valor es `undefined`/`null` (el param no
  vino), el pipe lo detecta como "ausente" y **devuelve `undefined` sin lanzar error** — es lo que
  hace posible que `anio` sea opcional. Si el param sí vino pero no es un entero válido, sí lanza el
  mismo `400` de arriba (la opción `optional` solo exime la ausencia, no un valor inválido presente).

Una vez que ambos pipes resuelven sin error, el controller valida los rangos a mano:

```ts
if (mes < 1 || mes > 12) throw new BadRequestException(`mes must be between 1 and 12`);
if (anio !== undefined && anio < 1) throw new BadRequestException('anio must be a positive integer');
```

(`reportes.controller.ts:63-68`) — estos dos `400` sí tienen mensaje custom, string simple:
`"mes must be between 1 and 12"` y `"anio must be a positive integer"` respectivamente. Nota:
`ParseIntPipe` acepta enteros negativos (`"-3"` matchea el regex), así que un `anio` o `mes`
negativo **sí** llega a este chequeo manual — no lo bloquea `ParseIntPipe`, lo bloquea esta
validación de rango explícita.

### Comportamiento exacto de `anio` cuando no se manda (default)

**Confirmado leyendo el código actual**: ya no existe ningún `DefaultValuePipe` con
`new Date().getFullYear()` en este endpoint. El flujo real es:

1. **Controller** (`reportes.controller.ts:60`): `@Query('anio', new ParseIntPipe({ optional: true })) anio: number | undefined`.
   Cuando el cliente no manda `anio`, el pipe devuelve literalmente `undefined` — no se calcula
   ningún año por default en JavaScript en este punto. `undefined` se pasa tal cual a
   `reportesService.getMes(usuario.id, mes, anio)`.
2. **Service** (`reportes.service.ts:85-104`): `rangoParams = { anio: anio ?? null, mes }` — si
   `anio` es `undefined`, el parámetro SQL `:anio` viaja como `null`. La expresión de año usada en
   ambos `andWhere` es:
   ```sql
   COALESCE(:anio::int, EXTRACT(YEAR FROM CURRENT_DATE)::int)
   ```
   Cuando `:anio` es `null`, `COALESCE` resuelve al año que devuelve `EXTRACT(YEAR FROM
   CURRENT_DATE)` — **evaluado por Postgres en el momento exacto de ejecutar esa query**, contra la
   fecha actual real del servidor de base de datos, no un valor calculado una sola vez al arrancar
   el proceso de Node ni cacheado entre requests. Cada request sin `anio` vuelve a evaluar
   `CURRENT_DATE` de cero.
3. El rango de fechas del mes se arma con `make_date(<añoResuelto>, :mes, 1)` hasta
   `make_date(<añoResuelto>, :mes, 1) + interval '1 month'`, usando ese año ya resuelto (explícito o
   por `COALESCE`) de forma idéntica en ambos casos — no hay una rama de código distinta para "con
   año" vs. "sin año", es la misma expresión SQL en los dos casos.

**Por qué esto importa para el cliente**: si el servidor de Node lleva varios días/semanas corriendo
sin reiniciarse y cruza un Año Nuevo, `GET /reportes/mes?mes=1` (sin `anio`) seguirá resolviendo
correctamente al año nuevo en cada request — no queda "atascado" en el año en que arrancó el
proceso. Esto es exactamente lo que el comentario en `reportes.controller.ts:48-54` y
`reportes.service.ts:76-84` documenta como motivo explícito de esta implementación (evitar el bug
de un default calculado una sola vez en JS). Ver también [diferencia 1](#diferencias-vs-diseño-original).

### Casos límite

- **Mes/año sin ventas**: `200 OK` con `[]` (el `INNER JOIN` simplemente no produce filas; no hay
  tratamiento especial ni error).
- **Cruce de año al pedir "el mes anterior" a enero**: no hay lógica especial en el backend para
  esto — es responsabilidad del cliente. Para pedir diciembre del año pasado desde una pantalla que
  tiene "enero" seleccionado, el cliente debe llamar explícitamente
  `GET /reportes/mes?mes=12&anio=<añoActual - 1>`, nunca `mes=0`. Como `anio` es un parámetro
  explícito y siempre disponible (no solo un default implícito), esto es posible sin necesidad de un
  endpoint adicional.
- **`anio` fuera de cualquier rango razonable pero sintácticamente válido** (ej. `anio=1900` o
  `anio=9999`): no hay validación de rango superior/inferior más allá de `>= 1` — el backend ejecuta
  la query igual, y devuelve `[]` si no hay ventas en ese rango (`make_date` de Postgres soporta esos
  años sin error).
- **`mes`/`anio` con ceros a la izquierda** (`mes=07`): `ParseIntPipe` los acepta (el regex
  `/^-?\d+$/` no distingue), `parseInt("07", 10)` → `7`, se comporta igual que `mes=7`.

### Comportamiento del servidor — resto de la query (`reportes.service.ts:85-107`)

- `JOIN` interno de `ticket_items` contra `tickets` y `productos`, filtrado por
  `t.usuarioId = <usuario del token>` y el rango de fechas descrito arriba.
- `INNER JOIN` (no `LEFT JOIN`): un producto sin ninguna venta ese mes simplemente no aparece en el
  resultado.
- Agregación por producto: `SUM(ti.cantidad)` → `cantidad`, `SUM(ti.subtotal)` → `venta`,
  `SUM(ti.subtotal - ti.cantidad * ti.costoUnitario)` → `ganancia` (ganancia por línea sumada, no
  `SUM(venta) - SUM(costo)` calculado aparte).
- `GROUP BY p.id, p.nombre`; orden: `p.nombre ASC`.

### Response — éxito `200 OK`

Array de `ReporteMesItem` (`interfaces/reporte-response.interface.ts`), construido por
`toReporteMesItem()`:

```json
[
  { "producto_id": "uuid-1", "nombre_producto": "Alpiste Normal", "cantidad": 27, "venta": 612, "ganancia": 268, "costo_validado": false },
  { "producto_id": "uuid-2", "nombre_producto": "Perron Adulto Bulto", "cantidad": 6, "venta": 3282, "ganancia": 762, "costo_validado": true }
]
```

Si el usuario no tuvo ventas ese mes/año: `200 OK` con `[]` (no es un error).

**`costo_validado`**: mismo campo y mismo mecanismo que en [§2](#2-get-reportesdia) — viene del
`innerJoin('ti.producto', 'p')` (`.addSelect('p.costoValidado', 'costo_validado')`, agregado también
a `GROUP BY` junto con `p.nombre` porque `getMes` agrupa). Como cada fila de `getMes` ya está
agrupada por `producto_id` (un solo producto por fila, sin mezclar productos distintos), el campo es
simplemente el estado **actual** de `costo_validado` de ese producto — refleja el mismo cambio
retroactivo (`false` → `true`) que puede ocurrir entre dos llamadas si el producto se valida en el
medio, sin que las ventas de ese mes se hayan vuelto a tocar.

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | `mes` ausente, no matchea `/^-?\d+$/` (no es un entero sintáctico), o el `ParseIntPipe` lo rechaza por cualquier otro motivo — `message`: `"Validation failed (numeric string is expected)"` |
| `400` | `mes` sintácticamente entero pero fuera de `1`–`12` (incluye negativos y `0`) — `message`: `"mes must be between 1 and 12"` |
| `400` | `anio` presente pero no matchea `/^-?\d+$/` — `message`: `"Validation failed (numeric string is expected)"` |
| `400` | `anio` presente, sintácticamente entero, pero `< 1` (incluye negativos y `0`) — `message`: `"anio must be a positive integer"` |
| `401` | No autenticado — mismo comportamiento que `GET /reportes/dia` |

`anio` **ausente** nunca produce `400` por sí solo — ver [comportamiento del default](#comportamiento-exacto-de-anio-cuando-no-se-manda-default)
arriba. Ningún query param extra no declarado (`foo=bar`) produce `400` en este endpoint (ver
[§1](#1-convenciones-generales)).

---

## Diferencias vs. diseño original

Comparado contra `c:\dev\ticket\src\features\vendido\ENDPOINTS.md` completo (secciones 1 a 5). El
código sigue el diseño con fidelidad alta: las 2 rutas, el guard de sesión en ambas, el alcance
estrictamente por cuenta, el shape exacto de ambas respuestas de éxito (`producto_id` +
`nombre_producto`, `costo` como total de línea en `dia`, `hora` como `"HH:mm"` preformateado por el
servidor, `ganancia = SUM(venta_linea - costo_linea)` en `mes`), el `INNER JOIN` sin fila sintética
para productos sin ventas, `ORDER BY nombre ASC` como default no ligado a ninguna pantalla, `[]`
(no error) cuando no hay ventas, ausencia de paginación, conversión manual de agregados
string→number, y el mecanismo de `ParseIntPipe` por parámetro en vez de un DTO de
`class-validator`. Las diferencias puntuales encontradas:

1. **`anio` ya no se resuelve con un default calculado en JavaScript al momento del request — se
   corrigió para resolverse en SQL contra la fecha real de Postgres en cada request.** El diseño
   (§3, tabla de query params) especificaba "Default: año actual según el reloj del servidor" sin
   fijar el mecanismo, y su nota de implementación (§5.6) sugería explícitamente
   `@Query('anio', new DefaultValuePipe(añoActualDelServidor), ParseIntPipe) anio: number` — un
   patrón donde, si `añoActualDelServidor` se calculara una sola vez con `new Date().getFullYear()`
   en el momento en que se evalúa el decorador (carga del módulo / arranque del proceso), quedaría
   **fijo** en ese valor mientras el proceso de Node siga corriendo, desalineándose silenciosamente
   si el servidor cruza un Año Nuevo sin reiniciarse. El código implementado evita ese riesgo por
   construcción: el controller usa `ParseIntPipe({ optional: true })` (sin ningún `DefaultValuePipe`)
   y deja `anio` como `undefined` cuando no viene; el service pasa `null` como parámetro SQL y usa
   `COALESCE(:anio::int, EXTRACT(YEAR FROM CURRENT_DATE)::int)`, evaluado por Postgres en cada
   ejecución de la query — mismo criterio de "fecha real del servidor de base de datos, por
   request" que ya usa `GET /reportes/dia` con `CURRENT_DATE`. Ver detalle completo en
   [§3](#comportamiento-exacto-de-anio-cuando-no-se-manda-default).

2. **Ninguno de los dos endpoints rechaza query params extra (`forbidNonWhitelisted` no aplica).**
   El diseño (§3, tabla de errores) incluía como posible `400` "Algún query param extra no
   declarado", condicionado explícitamente a "si el DTO se implementa con `@Query()`" (§5.6) — el
   propio diseño dejaba abierta la posibilidad de que no aplicara. El código optó por
   `@Query('mes', ParseIntPipe)`/`@Query('anio', ...)` por parámetro individual (sin una clase DTO
   para toda la query), así que el `ValidationPipe` global nunca valida el objeto de query completo
   en ninguno de los dos endpoints — `GET /reportes/mes?mes=7&foo=bar` responde `200` igual que sin
   `foo`, nunca `400`. Mismo mecanismo/precedente que `GET /productos/catalogo`
   (`productos/API_INTEGRATION.md` diferencia 2).

3. **Mensajes de error `400` ahora documentados con texto exacto y con una capa adicional no
   anticipada por el diseño.** El diseño (§3, tabla de errores) describía las condiciones
   ("`mes` ausente, no es un entero, o fuera de 1–12") sin distinguir mecanismos. El código real
   tiene **dos capas independientes** de `400` para `mes`/`anio`: la de `ParseIntPipe`
   (`"Validation failed (numeric string is expected)"`, cuando el valor ni siquiera es
   sintácticamente un entero, incluyendo su ausencia total en el caso de `mes`) y la de los chequeos
   manuales de rango en el controller (`"mes must be between 1 and 12"` / `"anio must be a positive
   integer"`, cuando sí es un entero pero fuera de rango). Dato nuevo para el cliente, no una
   discrepancia de comportamiento (sigue siendo `400` en todos los casos), pero relevante si el
   cliente quisiera mostrar el `message` crudo del backend.

No se encontraron diferencias en: rutas y métodos HTTP, requisito de `Authorization: Bearer` en
ambos, código de éxito `200` en los dos, shape exacto de `ReporteDiaItem`/`ReporteMesItem`
(incluyendo `costo` como costo total de línea y `hora` como `"HH:mm"` de servidor, no ISO), lógica
de `ganancia` en `mes`, `INNER JOIN` sin filas sintéticas, `ORDER BY nombre ASC` en `mes` y
`ORDER BY created_at ASC` en `dia`, ausencia de paginación en ambos, `[]` (no error) cuando no hay
ventas en el período pedido, alcance estrictamente por `usuario_id` del token, conversión manual
string→number de los campos agregados, y que `anio` sea un parámetro explícito (no implícito) para
permitir pedir cualquier año, incluido el cruce de año al pedir "el mes anterior" a enero.

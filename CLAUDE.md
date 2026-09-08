# Mapa del repo — backend de punto de venta (NestJS / TypeORM / Postgres)

> Mapa de orientación rápida. Para detalle profundo de un módulo, ver el `README.md` dentro de su
> carpeta (`src/<módulo>/README.md`) — no se duplica ese contenido acá.

## 1. Descripción general

Backend de una app móvil de punto de venta para negocios pequeños en México (ej. tienda de mascotas/
abarrotes): gestiona un catálogo de productos privado por cuenta, ventas ("tickets") y reportes de
ventas/ganancias. Incluye login/registro con JWT + refresh tokens y un PIN de 4 dígitos que el
backend solo expone — nunca valida. Este repo es solo el backend (NestJS + Postgres); el frontend
(Expo/React Native) vive en `c:\dev\ticket`.

## 2. Estructura de carpetas

- `src/auth/` — registro, login, JWT, refresh tokens (rotación + detección de reuso), logout, `/me`,
  `/me/pin`. Ver `src/auth/README.md` (incluye también la documentación de la entidad `Usuario`, ver
  más abajo).
- `src/productos/` — catálogo de productos por cuenta (`usuario_id`), búsqueda, alta/edición/
  soft-delete, `costo_validado`. Ver `src/productos/README.md`.
- `src/tickets/` — creación de tickets de venta (único endpoint, create-only), snapshot de
  precio/costo server-side. Ver `src/tickets/README.md`.
- `src/reportes/` — reportes de ventas/ganancias del día y del mes, sin tablas propias (reportea
  sobre `tickets`/`ticket_items`/`productos`), con manejo de timezone en SQL. Ver
  `src/reportes/README.md`.
- `src/usuarios/` — **no es un módulo funcional**: solo contiene la entidad `Usuario`
  (`entities/usuario.entity.ts`), sin controller/service/module propio. `auth` es su único
  consumidor con acceso real de datos (`Repository<Usuario>`); `productos`/`tickets` solo tienen la
  relación `@ManyToOne` por FK. Ver `src/usuarios/README.md`.
- `src/database/` — dos configs de conexión a Postgres **separadas y deliberadamente no unificadas**:
  - `data-source.ts` — `DataSource` standalone usado por el CLI de TypeORM para correr migraciones.
    Lee variables de entorno directo de `process.env` (vía `dotenv/config`), porque en ese contexto
    no hay contenedor de Nest disponible para usar `ConfigService`.
  - La conexión en runtime vive en `src/app.module.ts` (`TypeOrmModule.forRootAsync`), vía
    `ConfigService`. Reusa las mismas variables de entorno que `data-source.ts` (no las credenciales
    hardcodeadas ni el código de config en sí).
  - `migrations/` — 11 migraciones, única fuente de verdad del schema (`synchronize: false` en
    ambas configs). Convención de nombre: `<timestamp-ms>-<DescripciónPascalCase>.ts` (ej.
    `1786831831517-InitialSchema.ts`, `1786860000000-RenamePinHashToPinInUsuarios.ts`).
  - `transformers/numeric.transformer.ts` — transformer TypeORM para columnas `numeric` ↔ `number`
    de JS.
- `src/main.ts` — bootstrap: `ValidationPipe` global (`whitelist: true, forbidNonWhitelisted: true`,
  **sin `transform`**, ver §3), sin CORS configurado, sin prefijo global de rutas, puerto vía
  `process.env.PORT ?? 3000`.
- `src/app.module.ts` — importa `ConfigModule` (global), `ThrottlerModule.forRoot` (60 req/60s,
  único guard global vía `APP_GUARD` → `ThrottlerGuard`), `TypeOrmModule.forRootAsync`
  (`synchronize: false`, entidades listadas explícitas, `uuidExtension: 'pgcrypto'`, SSL condicional
  por `DB_SSL`), y los 4 módulos de dominio (`AuthModule`, `ProductosModule`, `TicketsModule`,
  `ReportesModule` — `usuarios` no se importa como módulo porque no lo es).
- `src/app.controller.ts`/`app.service.ts` — boilerplate default de Nest CLI (`GET /` →
  `getHello()`), sin uso de negocio, no removido.
- Configuración de raíz: `package.json` (scripts, ver §5), `tsconfig.json` (sin `strict: true`
  monolítico — usa flags sueltos: `strictNullChecks: true`, `noImplicitAny: false`,
  `strictBindCallApply: false`; sin alias de paths), `tsconfig.build.json`, `nest-cli.json`
  (`sourceRoot: src`, `deleteOutDir: true`, resto default), `eslint.config.mjs` (flat config),
  `.prettierrc`, `.env`/`.env.example` (ver §5). `README.md` en la raíz es el boilerplate default de
  `nest new` — no forma parte de este mapa, no tocar salvo instrucción explícita.

## 3. Decisiones de diseño ya tomadas

Verificadas contra el código actual (no asumidas de documentación previa) — **no cambiar sin
discutirlo explícitamente**:

- **PIN de 4 dígitos sin hashear, en texto plano** (`usuarios.pin`, `varchar(4)`) — decisión
  explícita de producto: antes se guardaba hasheado con bcrypt y se migró deliberadamente a texto
  plano (`RenamePinHashToPinInUsuarios`). El PIN es un gate puramente de UI del cliente frontend; el
  backend nunca lo valida, solo lo expone vía `GET /me/pin`. No hay ningún DTO ni endpoint que
  reciba/compare un PIN.
- **`costo_validado` derivado server-side, con corrección retroactiva del histórico de
  `ticket_items`**: cuando un producto pasa de `costo_validado=false` a `true` por primera vez vía
  `PATCH /productos/:id` y el costo cambió, se corrige (en una transacción) `costo_unitario` de las
  líneas de venta afectadas — sin tocar `precio_venta_unitario`/`subtotal`/`total`. Efecto
  secundario adicional confirmado: el soft-delete (`DELETE /productos/:id`) también auto-confirma
  `costo_validado=true` si el producto ya fue vendido y nunca se confirmó — porque tras el borrado
  lógico ya no sería alcanzable por `PATCH`, sería la última oportunidad perdida. Ver
  `src/productos/README.md`.
- **Catálogo de productos privado por cuenta**, resuelto siempre desde el JWT (`@CurrentUser()`),
  nunca de body/query/params — ningún DTO de `productos` declara `usuario_id`, el `ValidationPipe`
  global lo rechazaría igual (`forbidNonWhitelisted`).
- **Soft-delete de productos, nunca `DELETE FROM` real** — forzado por la FK
  `ticket_items.producto_id → productos(id) ON DELETE RESTRICT`. `remove()` solo hace
  `producto.activo = false`.
- **Rotación de refresh tokens con detección de reuso y revocación en cascada**: cada
  `POST /auth/refresh` exitoso rota el token (`revoked_at` + `replaced_by_id` apuntando al nuevo).
  Si se reintenta usar un token ya rotado (`revoked_at` no nulo **y** `replaced_by_id` no nulo —
  distingue de una revocación por logout, que no setea `replaced_by_id`), se interpreta como robo y
  se revocan en cascada TODOS los refresh tokens activos del usuario, silenciosamente (mismo 401
  genérico). `logout()` es una función separada que nunca dispara esta cascada.
- **Mitigación de timing/enumeración en `POST /auth/login`**: `bcrypt.compare` corre siempre contra
  un `DUMMY_PASSWORD_HASH` precalculado si el usuario no existe, para que un email inexistente pague
  el mismo costo de bcrypt que uno real; mensaje de error genérico idéntico para "no existe" y
  "password incorrecto". Asimétrico a propósito respecto de `/auth/register`, que sí revela si un
  email existe (409 vs 201) — mitigado en cambio con throttling mucho más agresivo en `register`
  (3 req/30min) que en `login` (5 req/min). No igualar estos límites ni quitar el dummy hash sin
  entender que rompe la mitigación.
- **`ValidationPipe` global sin `transform: true`** (solo `whitelist: true, forbidNonWhitelisted:
  true`) — la coacción de tipos y la normalización se hacen a mano: `ParseIntPipe`/`ParseUUIDPipe`
  explícitos por parámetro en vez de DTOs con `@Type()`, y normalización manual de `email`
  (`trim().toLowerCase()`) dentro de los services (`auth.service.ts`), no vía `@Transform()` en los
  DTOs (que no se aplicaría sin `transform: true`).
- **`synchronize: false` en ambas configuraciones de TypeORM** (runtime en `app.module.ts` y CLI en
  `database/data-source.ts`) — el schema real vive solo en `src/database/migrations/`, nunca se
  infiere de los decoradores de las entidades en runtime.

## 4. Convenciones del proyecto

- **Estructura de un módulo de dominio** (patrón visible en `auth/`, `productos/`, `tickets/`,
  `reportes/`): `*.module.ts` + `*.controller.ts` + `*.service.ts` + `dto/` (validación
  `class-validator`) + `entities/` (entidades TypeORM) + `interfaces/` (forma de la respuesta HTTP,
  separada de la entidad de BD) + `README.md` propio. Agregar `guards/`/`strategies/`/`decorators/`/
  `validators/` solo si el módulo necesita su propia lógica de auth/autorización, como hace `auth/`.
  `usuarios/` es la excepción mínima: solo `entities/` + `README.md`, sin controller/service, porque
  no tiene comportamiento propio — no usar como plantilla para un módulo nuevo con lógica real.
- **La lógica de negocio vive en el `*.service.ts`**, nunca en el controller (los controllers solo
  resuelven guards/params y delegan) ni en las entidades (que son solo definición de columnas/
  relaciones TypeORM, sin métodos de negocio).
- **Los DTOs son la única capa de validación de shape/tipo del input** (`class-validator`), pero
  dado que `transform: true` está deshabilitado (§3), no asumas que un DTO coacciona tipos
  automáticamente — verificá si el controller usa un pipe explícito (`ParseIntPipe`,
  `ParseUUIDPipe`) o si el service normaliza a mano.
- **Migraciones**: nombre `<timestamp-ms>-<DescripciónPascalCase>.ts` en `src/database/migrations/`,
  corridas con el CLI de TypeORM apuntando a `src/database/data-source.ts` (no hay script npm
  dedicado, ver §5). Cada cambio de schema es una migración nueva — nunca se edita una migración ya
  aplicada ni se depende de `synchronize`.
- **Rutas nuevas**: agregar el endpoint en el `*.controller.ts` del módulo correspondiente, con
  `@UseGuards(JwtAuthGuard)` si requiere sesión y `@CurrentUser()` para resolver el usuario — nunca
  aceptar `usuario_id` como input del cliente si el dato debe quedar aislado por cuenta (ver
  decisión de catálogo privado en §3).
- **Sin prefijo global de rutas** y **sin CORS configurado** en `main.ts` — si se necesita alguno,
  es un cambio deliberado a discutir, no un default asumible.

## 5. Cómo correr y probar el proyecto

- **Arrancar en desarrollo**: `npm run start:dev` (`nest start --watch`). También:
  `npm run start:debug`, `npm run build && npm run start:prod`.
- **Migraciones**: no hay script npm dedicado — se corren con el CLI de TypeORM contra
  `src/database/data-source.ts`, ej. `npx typeorm-ts-node-commonjs -d src/database/data-source.ts
  migration:run` (mismo binario para `migration:generate`/`migration:revert`).
- **Lint**: `npm run lint` (`eslint ... --fix`). **Format**: `npm run format` (prettier).
- **Variables de entorno esperadas** (solo nombres — confirmar valores reales en `.env`, nunca
  commitear el archivo):
  - `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` — conexión Postgres, usadas por
    ambas configs de `src/database/`.
  - `DB_SSL` — usada en código (`app.module.ts`, `data-source.ts`) para habilitar SSL
    (`rejectUnauthorized: false`), típicamente con Postgres serverless (ej. Neon). **No está
    listada en `.env.example`** pese a estar en uso — si se toca `.env.example`, agregarla.
  - `JWT_SECRET` — sin default, el arranque falla si falta (`getOrThrow`).
  - `ACCESS_TOKEN_TTL` (default `900`s), `REFRESH_TOKEN_TTL` (default `2592000`s) — opcionales.
  - `PORT` — opcional, default `3000`, tampoco listada en `.env.example`.
- **Tests**: sí hay suite configurada (Jest, config embebida en `package.json`, sin
  `jest.config.*` separado). `npm test` corre specs unitarios (`*.spec.ts` dentro de `src/`), `npm
  run test:e2e` corre `test/app.e2e-spec.ts` (config `test/jest-e2e.json`), `npm run test:cov` para
  cobertura. **Cobertura real es baja**: de los módulos de dominio, solo `reportes/` tiene specs
  (`reportes.controller.spec.ts`, `reportes.service.spec.ts` — incluyen un test de regresión
  dedicado al manejo de timezone en SQL, ver `src/reportes/README.md`); `auth/`, `productos/`,
  `tickets/`, `usuarios/` no tienen specs propios. No asumir cobertura de tests al modificar esos
  módulos — verificar manualmente o agregar specs si el cambio lo amerita.

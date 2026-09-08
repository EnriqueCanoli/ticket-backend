# `auth`

## 1. Propósito

Registro/login con JWT + refresh token opaco rotativo, revocación de sesión (logout) y dos
endpoints de perfil (`/me`, `/me/pin`). Es dueño exclusivo de la tabla `refresh_tokens`. La entidad
`Usuario` vive físicamente en `src/usuarios/` (ver [sección 7](#7-entidad-usuario-src usuariosentitiesusuarioentityts))
pero `auth` es su único consumidor con acceso real de datos (el único módulo con
`Repository<Usuario>` inyectado) — ver `src/usuarios/README.md` para el detalle de por qué esa
entidad no tiene módulo propio.

Sin prefijo global de rutas (`@Controller()` vacío en `auth.controller.ts`).

## 2. Endpoints

### `POST /auth/register`

- Guard: ninguno. Throttle propio: **3 req / 30 min por IP** (`@Throttle({default:{limit:3,ttl:1800000}})`)
  — más estricto que el resto porque este endpoint sí revela por diseño si un email existe
  (409 vs 201), así que se frena la enumeración masiva.
- Body `RegisterDto`:
  | campo | tipo/validación |
  |---|---|
  | `email` | `@IsEmail()` |
  | `password` | `@Matches(/^(?=.*\d).{6,}$/)` **+ `@MaxBcryptBytes()`** (custom: rechaza si `Buffer.byteLength(value,'utf8') > 72`; bcrypt trunca en silencio pasado ese límite, así que se rechaza explícito en vez de truncar — password con emojis/acentos "cortos" puede fallar por bytes, no por caracteres) |
  | `phone` | `@Matches(/^\d{10}$/)` |
  | `aceptoTerminos` | `@IsBoolean()` + `@Equals(true)` |

  `ValidationPipe` global (`whitelist:true, forbidNonWhitelisted:true`, **sin `transform:true`**) →
  campo extra en el body = `400`.
- Éxito `201` — `AuthResponse`:
  ```
  { user: { id, email, phone, created_at }, access_token, refresh_token, token_type: 'Bearer', expires_in }
  ```
- Errores:
  - `400` validación DTO / campo no whitelisted.
  - `409` — dos caminos, ambos posibles:
    - Pre-check `findOne({email})` normalizado → `'El email ya está registrado'`.
    - **Race condition** capturada en el `catch(QueryFailedError)` del `save()`: si es `23505`
      sobre `UQ_usuarios_email_lower` → mismo mensaje de email; **si es cualquier otra violación
      única (notablemente `UQ_usuarios_phone`, teléfono duplicado) → 409 genérico `'El registro ya
      existe'`**. No hay pre-check de teléfono — el único guardrail contra phone duplicado es la
      constraint de BD atrapada por este catch.
  - `429` throttler.

### `POST /auth/login`

- Guard: ninguno. Throttle propio: **5 req / min por IP**.
- Body `LoginDto`: `email` (`@IsEmail()`), `password` (mismo regex + `@MaxBcryptBytes()` que register).
- Éxito `200`: mismo shape `AuthResponse` que register.
- `401` único mensaje `'Credenciales inválidas'` tanto para email inexistente como para password
  incorrecto. Mitigación de timing: `bcrypt.compare` corre siempre — si `usuario` es `null`, compara
  contra un `DUMMY_PASSWORD_HASH` precomputado — para que un email inexistente pague el mismo costo
  de bcrypt que uno real.
- `429` throttler.

### `POST /auth/refresh`

- Guard: ninguno (el propio `refresh_token` es la credencial). **Sin `@Throttle` propio ⇒ cae bajo
  el throttler global** (60 req/min por IP — ver [sección 7 del throttler](#throttler)).
- Body `RefreshTokenDto`: `refresh_token: string` — `@IsString() @IsNotEmpty()`.
- Éxito `200` — `TokenPairResponse` (**sin `user`**):
  ```
  { access_token, refresh_token, token_type: 'Bearer', expires_in }
  ```
- Errores, todos `401` mensaje único `'Refresh token inválido'`:
  - No existe fila con ese `token_hash` (SHA-256 hex del valor recibido).
  - Fila con `revoked_at` no nulo.
  - `expires_at <= now()`.
- Éxito real (rotación): genera nuevo par, marca el token viejo `revoked_at=now()` +
  `replaced_by_id=<id del nuevo>` (dos `save()` sin transacción explícita entre sí — ver gotcha en
  [sección 5](#5-decisiones-de-diseño--gotchas)).

### `POST /auth/logout`

- Guard: `JwtAuthGuard` (`Authorization: Bearer`). `usuario_id` se resuelve **solo** de
  `@CurrentUser()` (JWT), nunca del body.
- Body: mismo `RefreshTokenDto`.
- Comportamiento: busca `{token_hash, usuario_id}` — aislamiento real, un refresh token de otro
  usuario nunca se toca. Si no existe o ya estaba revocado → **no-op silencioso, sin excepción**,
  igual `200`. Si existe y vigente → `revoked_at=now()`; **no** toca `replaced_by_id` ni dispara la
  cascada de revocación (esa es exclusiva de la detección de reuso en `/auth/refresh`, ver abajo).
- Éxito `200` (no `204`), body vacío.
- Errores: `400` DTO inválido, `401` guard JWT. **No hay 401/404 por refresh_token inválido/ajeno en
  el body** — a propósito, es un no-op.

### `GET /me`

- Guard: `JwtAuthGuard`.
- Éxito `200` — `MeResponse`: `{ id, email, phone, created_at, updated_at }`.
- `401` (formato default de Passport, `{"statusCode":401,"message":"Unauthorized","error":"Unauthorized"}`
  — distinto del mensaje custom de login/refresh) en: header ausente, token mal formado/firma
  inválida, expirado, o `sub` del payload ya no existe en `usuarios` (borrado — hoy no hay endpoint
  de borrado de cuenta, pero `JwtStrategy.validate()` lo contempla igual).

### `GET /me/pin`

- Guard: `JwtAuthGuard`, idéntico a `/me`.
- Éxito `200`: `{ pin: string }` — 4 dígitos, ceros a la izquierda preservados. Reusa el `Usuario` ya
  cargado por `JwtStrategy`, sin query adicional.
- Mismos `401` que `/me`.
- El PIN es **puramente un gate de UI del cliente** — este endpoint solo lo expone, el backend nunca
  lo valida en ningún flujo.

### Throttler

- **Global** (`ThrottlerGuard` vía `APP_GUARD` en `app.module.ts`): 60 req/min por IP — aplica a todo
  endpoint sin `@Throttle` propio, **incluyendo `refresh`, `logout`, `/me`, `/me/pin`**.
- `register`: 3 req/30min por IP. `login`: 5 req/min por IP.
- Excedido → `429`, formato default de `ThrottlerException`.

### Formato de errores

Sin `ExceptionFilter` custom. `400` de `class-validator` → `message` es **array**; `400` de
`BadRequestException`/pipes manuales → `message` string simple; `404`/`409` → string simple. Los
`401` tienen **dos formatos según el endpoint**: `login`/`refresh` usan mensajes custom
(`'Credenciales inválidas'` / `'Refresh token inválido'`); `me`/`me/pin`/`logout` (vía guard) usan
el default de Passport (`'Unauthorized'`) — un cliente que branchee por texto de mensaje debe tener
esto en cuenta.

## 3. Reglas de negocio / mecánica no obvia

- **Access token**: JWT firmado con `JWT_SECRET` (sin default — el arranque falla si falta).
  Payload `{ sub, email }`. TTL `ACCESS_TOKEN_TTL` (default `900`s = 15min), leído dos veces por
  separado (config de `JwtModule` y en `AuthService`) — mismo valor en la práctica pero dos parseos
  independientes de la misma env var, no un único source of truth.
- **Refresh token**: opaco, `randomBytes(64).toString('hex')` (128 chars hex), persistido como
  SHA-256 hex (no bcrypt — justificado porque ya es alta entropía, no hace falta salt/cost factor).
  TTL `REFRESH_TOKEN_TTL` (default `2592000`s = 30 días).
- **Rotación + detección de reuso**: en cada `/auth/refresh` exitoso el token usado queda
  `revoked_at=now()` + `replaced_by_id=<nuevo>`. Si alguien reintenta usar un token con
  `revoked_at` no nulo **y** `replaced_by_id` no nulo (fue rotado, no revocado por logout), se
  interpreta como robo: `revokeAllActiveTokensForUser(usuarioId)` revoca en cascada **todas** las
  sesiones activas del usuario — `UPDATE refresh_tokens SET revoked_at=now() WHERE usuario_id=$1 AND
  revoked_at IS NULL`, silencioso, sin señal extra en la respuesta HTTP (mismo 401 genérico de
  siempre).
  - `replaced_by_id` es la señal que distingue "rotado y reusado" (dispara cascada) de "revocado por
    logout" (no dispara nada) — ambos casos tienen `revoked_at` no nulo.
- **bcryptjs, `SALT_ROUNDS=10`**, fijo en código, no viene de env var.
- **Normalización de `email` (`trim().toLowerCase()`) ocurre a mano en `AuthService`**, no vía
  `@Transform` en el DTO — porque el `ValidationPipe` global no tiene `transform:true` (mismo patrón
  que `ProductosService.search()`).
- **No hay cron/job que purgue `refresh_tokens` expirados o revocados** — la tabla crece
  indefinidamente.
- **El backend no distingue error de red vs. sesión inválida** — esa distinción (status 0 vs 401)
  vive enteramente en el cliente frontend; el backend solo produce 401/400/409/429 normales.
- **No existe endpoint de "logout de todos los dispositivos"** — `revokeAllActiveTokensForUser` solo
  se invoca internamente en la detección de reuso, no hay ruta pública que lo dispare a demanda.

## 4. Restricciones de BD

### `usuarios`

Ver detalle completo de la entidad en [sección 7](#7-entidad-usuario-src-usuarios). Constraints
relevantes para `auth`:

- `UQ_usuarios_email_lower` — índice único **funcional** sobre `LOWER(email)` (no `unique:true` en
  el decorador de la entidad, a propósito: esa constraint no es expresable con el decorador
  estándar). Reemplazó un `UNIQUE` case-sensitive original.
- `UQ_usuarios_phone` — unique simple sobre `phone`.
- `pin varchar(4)` — sin unique (dos cuentas pueden compartir PIN), texto plano (ver
  [sección 5](#5-decisiones-de-diseño--gotchas)). Originalmente era `pin_hash varchar(255)`,
  renombrada/achicada con backfill de PIN aleatorio 0000-9999 para filas existentes.

### `refresh_tokens`

- `id uuid PK`.
- `usuario_id uuid NOT NULL` + FK `→ usuarios(id) ON DELETE CASCADE` + índice
  `IDX_refresh_tokens_usuario_id`.
- `token_hash varchar(255) NOT NULL UNIQUE`.
- `expires_at timestamptz NOT NULL`, `created_at timestamptz DEFAULT now()`.
- `revoked_at timestamptz NULL`.
- `replaced_by_id uuid NULL` + FK autoreferencial `→ refresh_tokens(id) ON DELETE SET NULL`.

## 5. Decisiones de diseño / gotchas

- **PIN de 4 dígitos sin hashear, en texto plano** (`usuarios.pin`) — decisión explícita de
  producto, no descuido. Es un gate puramente de UI local en el frontend; el backend nunca lo
  valida, solo lo expone vía `GET /me/pin`. No "corregir" agregando hashing sin pedido nuevo del
  dueño del producto.
- **La cascada de revocación al detectar reuso es silenciosa** — el cliente que reintenta un token
  robado ve el mismo 401 genérico de siempre, sin flag/código que indique "se invalidaron todas tus
  sesiones". Cualquier UX que dependa de detectar esto tiene que inferirlo (el siguiente refresh
  legítimo también fallará).
- **El pre-check de duplicados en `register()` solo cubre `email`, no `phone`** — un teléfono
  duplicado cae en el catch genérico de `QueryFailedError` y devuelve `'El registro ya existe'`
  (mensaje genérico), no un 409 específico de teléfono.
- **`logout()` y `refresh()` no usan transacción** — ambos hacen `save()`(s) sueltos sobre entidades
  ya leídas, no atómicos entre sí (relevante solo en escenarios de falla parcial de infraestructura,
  no en operación normal).
- **`MaxBcryptBytes()` (72 bytes UTF-8)** existe porque bcrypt trunca en silencio passwords más
  largos — sin este validador, dos passwords distintos que compartan los primeros 72 bytes serían
  indistinguibles para bcrypt.

## 6. Discrepancias encontradas vs. el `API_INTEGRATION.md` previo (ya eliminado)

Documentadas aquí porque el documento viejo ya no existe en el repo:

1. El doc viejo afirmaba que el `findOne` de `register()` no normalizaba email (sensible a
   mayúsculas/minúsculas) — **desactualizado**; el código normaliza `trim().toLowerCase()` antes de
   la query y del `save()`.
2. `@MaxBcryptBytes()` no estaba documentado en ninguna tabla de validación.
3. El manejo de colisión `23505` para `phone` (o cualquier constraint única no-email) no estaba
   documentado — el doc solo cubría el 409 de email.
4. El throttler global (60 req/min, vía `APP_GUARD`) no se mencionaba — el doc solo cubría los
   `@Throttle` explícitos de `register`/`login`.

## 7. Entidad `Usuario` (`src/usuarios/`)

`src/usuarios/` no es un módulo funcional — no tiene controller, service, DTO ni `UsuariosModule`
propio. Contiene únicamente `entities/usuario.entity.ts`, registrada directamente en
`TypeOrmModule.forRootAsync()` (`app.module.ts`) y expuesta como repository solo en
`AuthModule` (`TypeOrmModule.forFeature([Usuario, RefreshToken])`) — **`auth` es el único módulo con
`Repository<Usuario>` inyectado**; `productos`/`tickets` solo tienen la relación `@ManyToOne` hacia
`Usuario` por su FK, y `reportes` ni eso, solo el tipo para tipar `req.user`.

Ver documentación completa de la entidad (columnas, relaciones, FKs entrantes de `tickets` y
`productos` con sus `ON DELETE`) en `src/usuarios/README.md`.

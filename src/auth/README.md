# `auth`

## 1. Propósito

Registro/login con JWT + refresh token opaco rotativo, revocación de sesión (logout), recuperación
de contraseña vía código de 6 dígitos por email (`forgot-password`/`reset-password`), dos
endpoints de perfil (`/me`, `/me/pin`) y la regeneración del PIN (`POST /me/pin/regenerate`). Es dueño exclusivo de las tablas `refresh_tokens` y
`password_reset_tokens`. La entidad
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
  inválida, expirado, `sub` del payload ya no existe en `usuarios` (borrado — hoy no hay endpoint
  de borrado de cuenta, pero `JwtStrategy.validate()` lo contempla igual), o el claim `tv` del token
  no coincide con `usuarios.token_version` (token emitido antes de un reset de contraseña, ver
  sección 3). Aplica igual a todo endpoint con `JwtAuthGuard`.
- No expone `token_version`: el mapper `toMeResponse()` es explícito.

### `GET /me/pin`

- Guard: `JwtAuthGuard`, idéntico a `/me`.
- Éxito `200`: `{ pin: string }` — 4 dígitos, ceros a la izquierda preservados. Reusa el `Usuario` ya
  cargado por `JwtStrategy`, sin query adicional.
- Mismos `401` que `/me`.
- El PIN es **puramente un gate de UI del cliente** — este endpoint solo lo expone, el backend nunca
  lo valida en ningún flujo.

### `POST /me/pin/regenerate`

- Guard: `JwtAuthGuard`. Throttle propio: **5 req / min por IP** (mismo límite que `login`: ambos
  verifican una contraseña con bcrypt). Éxito `200` (`@HttpCode(HttpStatus.OK)`).
- Body `RegeneratePinDto`:
  | campo | tipo/validación |
  |---|---|
  | `password` | `@Matches(/^(?=.*\d).{6,}$/)` + `@MaxBcryptBytes()`, con los mensajes en español de `POST /auth/reset-password` |
- Éxito `200`: `{ pin: string }`, el PIN nuevo de 4 dígitos, ya persistido.
- Escritura: `usuarioRepository.update({ id, passwordHash: <hash verificado> }, { pin })`. Solo toca
  `pin` (y `updated_at`), y solo si `password_hash` sigue siendo el que se acaba de verificar contra
  la entidad que cargó `JwtStrategy`. Nunca `save()` de la entidad completa: podría revertir un
  `password_hash` recién cambiado por un reset concurrente.
- Errores:
  - `400` `"Contraseña incorrecta"` (string simple) si la contraseña no coincide, **o** si el
    `update` afectó 0 filas (un reset concurrente cambió la contraseña entre la lectura y la
    escritura: la contraseña verificada ya no es la vigente). **Nunca `401`**: un 401 dispararía el
    auto-refresh de `authenticatedRequest()` en el cliente.
  - `400` validación del DTO (`message` array, en español).
  - `401` guard JWT (incluido un token previo a un reset, por `tv`).
  - `429` throttler.
- Contrato detallado: `API generar nuevo PIN.md` (raíz del repo).

### `POST /auth/forgot-password`

- Guard: ninguno. Throttle propio: **3 req / 15 min por IP**
  (`@Throttle({default:{limit:3,ttl:900000}})`). Pública.
- Body `ForgotPasswordDto`:
  | campo | tipo/validación |
  |---|---|
  | `email` | `@IsEmail()` — mensaje `"Ingresa un correo válido"` |
- Éxito **siempre** `200`: `{ message: string }` con el mismo mensaje genérico
  exista o no la cuenta — anti-enumeración deliberada, no distingue por diseño.
- Si el email existe: dentro de una transacción con `SELECT ... FOR UPDATE`
  (lock: `pessimistic_write`) sobre la fila de `usuarios` (serializa llamadas
  concurrentes al mismo usuario, ver BE-03 en sección 3), borra cualquier
  `password_reset_tokens` previo de ese usuario y genera un código de 6
  dígitos (`randomInt(0, 1_000_000)` con padding a la izquierda), que
  persiste hasheado (mismo `hashOpaqueToken` SHA-256 que `refresh_tokens`)
  con TTL `PASSWORD_RESET_CODE_TTL_SECONDS` (default 900s = 15min). Ya fuera
  de la transacción, dispara el envío del email **sin `await`**
  (fire-and-forget, con `.catch()` que solo loguea) — así el tiempo de
  respuesta no depende de si hubo que generar/enviar un código, evitando un
  oráculo de temporización equivalente al de `login()`.
- Envío real vía Brevo (`MailService.sendPasswordResetCode`, HTTP directo con
  `fetch`, sin SDK). Si falta `BREVO_API_KEY` y `NODE_ENV !== 'production'`,
  el código se loguea por consola (`[DEV] Código de reset para <email>: <code>`)
  en vez de enviarse — permite probar el flujo completo sin cuenta de Brevo.
- `429` throttler.

### `POST /auth/reset-password`

- Guard: ninguno. Throttle propio: **10 req / 15 min por IP**
  (`@Throttle({default:{limit:10,ttl:900000}})`). Pública.
- Body `ResetPasswordDto`:
  | campo | tipo/validación |
  |---|---|
  | `email` | `@IsEmail()` — `"Ingresa un correo válido"` |
  | `code` | `@Matches(/^\d{6}$/)` — exactamente 6 dígitos — `"El código son 6 dígitos"` |
  | `password` | mismo regex + `@MaxBcryptBytes()` que `register`/`login`, con mensajes `"La contraseña debe tener al menos 6 caracteres y al menos un número"` y `"La contraseña no puede pesar más de 72 bytes (los acentos pesan 2, los emojis hasta 4)"` |

  Sin `confirmPassword` (solo se valida en el cliente). Los mensajes en español de
  `ForgotPasswordDto`, `ResetPasswordDto` y `RegeneratePinDto` viven en `dto/messages.ts` y forman
  parte del contrato con el frontend (que usa las mismas reglas). `LoginDto`/`RegisterDto` y el
  `defaultMessage` de `MaxBcryptBytes` siguen en inglés (fuera de este flujo).
- Éxito `200` **con cuerpo vacío** (no devuelve tokens — no hay auto-login).
  Efectos, todos en la misma transacción: guarda la nueva contraseña con
  una escritura parcial (`manager.update(Usuario, { id }, { passwordHash,
  tokenVersion: () => '"token_version" + 1' })`, nunca `save()` de la
  entidad completa, que podría revertir un `pin` regenerado en paralelo),
  **incrementa `token_version`** (todo access token emitido antes responde
  `401` de inmediato en cualquier endpoint con `JwtAuthGuard`, en todos los
  dispositivos, ver sección 3), marca el token de reset
  usado (`used_at`), y revoca en cascada **todos** los refresh tokens
  activos del usuario (`UPDATE refresh_tokens SET revoked_at=now() WHERE
  usuario_id=$1 AND revoked_at IS NULL`, dentro de la misma transacción con
  lock) — cierra todas las sesiones existentes. Esta query es la misma que
  usa `revokeAllActiveTokensForUser()` (detección de reuso en
  `/auth/refresh`), pero **duplicada inline** acá en vez de reusar ese
  método: necesita correr sobre el `manager` transaccional (mismo `SELECT
  ... FOR UPDATE`, ver sección 5), no sobre el `refreshTokenRepository`
  inyectado que usa ese método privado.
- `400` — **todas** las siguientes causas colapsan al mismo mensaje genérico
  `'El código es inválido o expiró'`, a propósito, para no revelar cuál fue
  (mismo criterio anti-enumeración que otros flujos de este módulo):
  - Email inexistente.
  - No hay ningún token de reset vigente (`used_at IS NULL`) para ese usuario.
  - El token vigente más reciente ya alcanzó 5 intentos fallidos
    (`attempts >= 5`) — no se sigue incrementando después de eso.
  - El token vigente más reciente ya expiró (`expires_at <= now()`).
  - El código no coincide con el hash guardado — este caso además incrementa
    `attempts` en 1 antes de responder.
  - Error de validación de DTO (contraseña débil, código no numérico, campo
    extra) usa el `400` default de `class-validator`/`ValidationPipe`
    global — mismo formato (`message` array) que el resto del módulo, no el
    mensaje genérico de arriba.
- No valida que la contraseña nueva sea distinta de la anterior. No toca
  `usuarios.pin` (feature no relacionada).
- `429` throttler.

### Throttler

- **Global** (`ThrottlerGuard` vía `APP_GUARD` en `app.module.ts`): 60 req/min por IP — aplica a todo
  endpoint sin `@Throttle` propio, **incluyendo `refresh`, `logout`, `/me`, `/me/pin`**.
- `register`: 3 req/30min por IP. `login`: 5 req/min por IP. `forgot-password`:
  3 req/15min por IP. `reset-password`: 10 req/15min por IP. `me/pin/regenerate`: 5 req/min por IP.
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
  Payload `{ sub, email, tv }`. TTL `ACCESS_TOKEN_TTL` (default `900`s = 15min), leído dos veces por
  separado (config de `JwtModule` y en `AuthService`) — mismo valor en la práctica pero dos parseos
  independientes de la misma env var, no un único source of truth.
- **`token_version` y claim `tv`**: `issueTokenPair()` firma `tv = usuario.tokenVersion` (las tres
  rutas que lo llaman —`register` con la entidad recién creada con `tokenVersion: 0` explícito,
  `login` y `refresh` con el usuario recién leído— tienen el valor fresco de la BD).
  `JwtStrategy.validate()` delega en `AuthService.validateAccessTokenPayload()`, que responde `401`
  si el usuario no existe o si `(payload.tv ?? 0) !== usuario.tokenVersion`. Solo
  `resetPassword()` incrementa la columna. Motivos del contador frente a `password_changed_at` vs.
  `iat`: `iat` tiene precisión de segundos (un token y un reset en el mismo segundo no tienen umbral
  correcto) y el contador no depende de relojes. Costo: cero consultas extra, `validate()` ya leía
  al usuario en cada request.
  - **Compatibilidad**: los access tokens emitidos antes de existir el claim no traen `tv` y se leen
    como `0`, igual al `DEFAULT 0` de la columna: siguen valiendo hasta vencer mientras el usuario no
    haya hecho ningún reset. El despliegue no cierra sesiones.
  - El frontend no decodifica el JWT, así que `tv` le es transparente: ante el `401`,
    `authenticatedRequest()` intenta refrescar, el refresh también da `401` (refresh tokens
    revocados) y el cliente borra los tokens y vuelve al login.
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
- **Normalización de `email` (`trim().toLowerCase()`) ocurre vía `@Transform` en los 4 DTOs que
  reciben email** (`LoginDto`, `RegisterDto`, `ForgotPasswordDto`, `ResetPasswordDto` — BE-04, ver
  `src/auth/dto/transforms.ts`). El `@Transform` corre **aunque el `ValidationPipe` global no tenga
  `transform:true`**: `plainToInstance` construye siempre la instancia que se valida, así que
  `@IsEmail()` valida sobre el valor ya transformado independientemente de esa opción (verificado
  instanciando el `ValidationPipe` real del proyecto). El `trim().toLowerCase()` manual que además
  sigue en `AuthService` es una defensa adicional redundante e inofensiva (idempotente), no la única
  vía de normalización.
- **No hay cron/job que purgue `refresh_tokens` expirados o revocados** — la tabla crece
  indefinidamente.
- **El backend no distingue error de red vs. sesión inválida** — esa distinción (status 0 vs 401)
  vive enteramente en el cliente frontend; el backend solo produce 401/400/409/429 normales.
- **`forgotPassword()` es atómico frente a llamadas concurrentes (BE-03, corregido)**: borra
  el token previo e inserta el nuevo dentro de una transacción con `SELECT ... FOR UPDATE`
  (lock: `pessimistic_write`) sobre la fila de `usuarios` del usuario — se bloquea esa fila y
  no la del token porque esta última puede no existir todavía, y `usuarios` sí existe siempre.
  Antes del fix, el borrado y la inserción eran dos statements sueltos sin transacción ni
  lock: bajo peticiones concurrentes a `POST /auth/forgot-password` para el mismo usuario,
  cada `DELETE` corría contra una foto tomada antes de que las demás hicieran commit (Postgres
  en `READ COMMITTED`, el nivel por defecto), así que ninguna veía las filas insertadas por las
  otras — resultado: 2+ filas vigentes simultáneas, todas válidas en `POST /auth/reset-password`
  (incluida la "vieja", incluso después de que la "nueva" ya se hubiera usado con éxito). El
  índice único parcial `UQ_password_reset_tokens_usuario_id_vigente` (sección 4) es la defensa
  de BD en profundidad para el mismo invariante. `resetPassword()` además desempata su
  `ORDER BY createdAt DESC` con `id DESC` por si dos filas llegaran a compartir `created_at`.
- **No existe endpoint de "logout de todos los dispositivos" dedicado** — `revokeAllActiveTokensForUser`
  como método solo se invoca internamente en la detección de reuso de `/auth/refresh`. `POST
  /auth/reset-password` produce el mismo efecto (revoca todos los refresh tokens activos del
  usuario) pero como side-effect de cambiar la contraseña, con su propia query inline dentro de la
  transacción — no hay ninguna ruta pública pensada para disparar la cascada de revocación a
  demanda sin más consecuencias.

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
- `token_version integer NOT NULL DEFAULT 0` — migración `AddTokenVersionToUsuarios1787690000000`.
  Solo la incrementa `resetPassword()`; nunca se expone en respuestas HTTP.

### `refresh_tokens`

- `id uuid PK`.
- `usuario_id uuid NOT NULL` + FK `→ usuarios(id) ON DELETE CASCADE` + índice
  `IDX_refresh_tokens_usuario_id`.
- `token_hash varchar(255) NOT NULL UNIQUE`.
- `expires_at timestamptz NOT NULL`, `created_at timestamptz DEFAULT now()`.
- `revoked_at timestamptz NULL`.
- `replaced_by_id uuid NULL` + FK autoreferencial `→ refresh_tokens(id) ON DELETE SET NULL`.

### `password_reset_tokens`

- `id uuid PK`.
- `usuario_id uuid NOT NULL` + FK `→ usuarios(id) ON DELETE CASCADE` + índice
  `IDX_password_reset_tokens_usuario_id`.
- `code_hash varchar(255) NOT NULL` — SHA-256 hex del código de 6 dígitos, **sin** `UNIQUE`
  (a diferencia de `refresh_tokens.token_hash`): el código no es globalmente único entre
  usuarios, la búsqueda siempre es por `usuario_id` + comparación de hash.
- `expires_at timestamptz NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`.
- `used_at timestamptz NULL` — `NULL` = vigente; se setea al usarse (uso único).
- `attempts integer NOT NULL DEFAULT 0` — intentos fallidos contra ese token; a los 5 se
  invalida sin seguir incrementando.
- `UQ_password_reset_tokens_usuario_id_vigente` — índice único **parcial**
  (`WHERE used_at IS NULL`) sobre `usuario_id`, migración
  `AddUniqueActivePasswordResetTokenPerUsuario1787700000000`. Como máximo un
  token vigente por usuario a la vez: `forgotPassword()` borra cualquier fila
  previa de ese `usuario_id` e inserta la nueva dentro de una transacción con
  lock sobre la fila de `usuarios` (ver BE-03, sección 3), y este índice es
  la defensa de BD en profundidad para el mismo invariante.

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
- **Escrituras parciales en `resetPassword()`/`regeneratePin()`**: ambos parten de una entidad
  `Usuario` leída antes de escribir (`resetPassword` antes de abrir la transacción, `regeneratePin`
  en `JwtStrategy`). Por eso escriben con `update()` solo las columnas que les corresponden: un reset
  no revierte un `pin` recién regenerado, y `regeneratePin` está condicionado a
  `password_hash = <hash verificado>` (con `affected === 0` responde `400 "Contraseña incorrecta"`),
  así que no revierte el `password_hash` de un reset concurrente ni regenera el PIN con una
  contraseña que ya no vale. `update()` sigue fijando `updated_at` (TypeORM agrega
  `updated_at = CURRENT_TIMESTAMP` por `@UpdateDateColumn`).
- **Riesgo residual conocido (no corregido, fuera de alcance): `refresh()` concurrente con un
  reset.** `refresh()` no es transaccional: (1) lee el refresh token vigente, (2) emite un par nuevo
  con `issueTokenPair()`, (3) marca el viejo como revocado. Si un `POST /auth/refresh` corre en
  paralelo exacto con el reset y su paso (2) inserta el refresh token nuevo **después** de la
  revocación masiva del reset, ese refresh token nuevo queda vigente. El access token emitido junto
  con él lleva el `tv` viejo (401 inmediato), pero el refresh token sirve para pedir otro par, ya con
  el `tv` nuevo. La ventana es muy estrecha (milisegundos) y requiere tener un refresh token válido
  previo al reset. Corrección propuesta (toca la rotación, por eso no se hizo): hacer `refresh()`
  transaccional y bloquear la fila del usuario con `SELECT ... FOR UPDATE` (el `UPDATE` del reset
  también la bloquea, así que se serializan), o guardar `token_version` en `refresh_tokens` al
  emitirlo y rechazar en `refresh()` los que no coincidan con `usuarios.token_version`.
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
`AuthModule` (`TypeOrmModule.forFeature([Usuario, RefreshToken, PasswordResetToken])`) — **`auth` es
el único módulo con `Repository<Usuario>` inyectado**; `productos`/`tickets` solo tienen la relación `@ManyToOne` hacia
`Usuario` por su FK, y `reportes` ni eso, solo el tipo para tipar `req.user`.

Ver documentación completa de la entidad (columnas, relaciones, FKs entrantes de `tickets` y
`productos` con sus `ON DELETE`) en `src/usuarios/README.md`.

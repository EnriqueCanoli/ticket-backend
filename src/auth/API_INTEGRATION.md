# API de autenticación — guía de integración para el cliente móvil

> Generado a partir de la **lectura del código real** en `ticket-backend/src/auth/`
> (`auth.controller.ts`, `auth.service.ts`, DTOs en `dto/`, `interfaces/auth-response.interface.ts`,
> `strategies/jwt.strategy.ts`, `guards/jwt-auth.guard.ts`, `entities/refresh-token.entity.ts`,
> `usuarios/entities/usuario.entity.ts`, `main.ts`, `app.module.ts`, `auth.module.ts`). No se
> ejecutó el servidor ni se hicieron requests en vivo — todo lo documentado aquí se dedujo
> estáticamente del código fuente.
>
> El código es la fuente de verdad. Este documento reemplaza, para efectos de integración del
> frontend, a `c:\dev\ticket\src\features\auth\AUTH_ENDPOINTS.md` (el diseño previo a
> implementar). Las diferencias encontradas entre diseño y código están señaladas explícitamente
> en la [última sección](#diferencias-vs-diseño-original).

## Índice

1. [Convenciones generales](#1-convenciones-generales)
2. [POST /auth/register](#2-post-authregister)
3. [POST /auth/login](#3-post-authlogin)
4. [POST /auth/refresh](#4-post-authrefresh)
5. [GET /me](#5-get-me)
6. [GET /me/pin](#6-get-mepin)
7. [Diferencias vs. diseño original](#diferencias-vs-diseño-original)

---

## 1. Convenciones generales

- **Sin prefijo global**: las rutas son literalmente `POST /auth/register`, `POST /auth/login`,
  `POST /auth/refresh` y `GET /me` (este último **sin** `/auth`), tal como están declaradas en
  `auth.controller.ts` (`@Controller()` vacío + rutas completas por método).
- **`ValidationPipe` global** (`main.ts`): `new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`.
  Esto tiene dos consecuencias directas para el cliente, en los 3 endpoints con body
  (`register`, `login`, `refresh`):
  - Cualquier campo del body **no declarado** en el DTO correspondiente (ej. enviar
    `confirmPassword` a `/auth/register`) hace que la request entera falle con **`400`** — no se
    ignora silenciosamente.
  - No hay ningún `@Transform` en los DTOs (no se usa `class-transformer` para normalizar
    input). Los valores viajan tal como los envía el cliente, sin trim ni casteo automático.
- **Formato de error**: no hay `ExceptionFilter` custom en el proyecto (no se encontró ninguno
  registrado en `app.module.ts`, `main.ts` ni `auth.module.ts`), así que todos los errores usan el
  formato por defecto de Nest para `HttpException`:
  ```json
  { "statusCode": 401, "message": "Credenciales inválidas", "error": "Unauthorized" }
  ```
  Para errores `400` de validación (`class-validator` + `ValidationPipe`), `message` es un arreglo
  de strings (uno por regla violada, incluyendo mensajes custom definidos en los DTOs y, si
  aplica, el mensaje de `forbidNonWhitelisted` por cada campo extra):
  ```json
  {
    "statusCode": 400,
    "message": [
      "password must be at least 6 characters long and contain at least 1 number",
      "property confirmPassword should not exist"
    ],
    "error": "Bad Request"
  }
  ```
- **Sesión**: access token JWT (`Authorization: Bearer <access_token>`) + refresh token opaco
  (string hex, no JWT) persistido hasheado (SHA-256) en la tabla `refresh_tokens`, rotado en cada
  uso de `/auth/refresh`. TTLs configurables vía env vars, con los mismos nombres y defaults del
  diseño original: `ACCESS_TOKEN_TTL` (default `900` s = 15 min) y `REFRESH_TOKEN_TTL` (default
  `2592000` s = 30 días) — ver `auth.service.ts` líneas 27-42.
- **Todas las fechas** (`created_at`, `updated_at`) son columnas `Date` en TypeORM que Nest
  serializa a JSON como string ISO 8601 (ej. `"2026-08-15T12:00:00.000Z"`).

---

## 2. POST /auth/register

Crea una cuenta nueva y devuelve la sesión ya autenticada (auto-login).

**Headers**: `Content-Type: application/json`. No requiere `Authorization`.

### Request body — `RegisterDto` (`dto/register.dto.ts`)

| Campo | Tipo | Validación real (class-validator) |
|---|---|---|
| `email` | `string` | `@IsEmail()` — formato de email válido. **No hay `@Transform` de trim**: si el valor trae espacios al inicio/fin, la validación puede fallar en vez de limpiarse automáticamente (ver [diferencias](#diferencias-vs-diseño-original)). |
| `password` | `string` | `@Matches(/^(?=.*\d).{6,}$/)` — mínimo 6 caracteres **y** al menos 1 dígito. Mensaje: `"password must be at least 6 characters long and contain at least 1 number"` |
| `phone` | `string` | `@Matches(/^\d{10}$/)` — exactamente 10 dígitos, sin espacios ni formato. Mensaje: `"phone must be exactly 10 digits"` |

- `confirmPassword` **no debe enviarse**: al no estar declarado en `RegisterDto` y estar activo
  `forbidNonWhitelisted`, cualquier campo extra (incluido este) hace fallar la request con `400`.
- No hay campo de PIN en el request. El backend genera un PIN internamente — ver
  [diferencias, punto 3](#diferencias-vs-diseño-original).

```json
{
  "email": "user@example.com",
  "password": "abc123",
  "phone": "5512345678"
}
```

### Response — éxito `201 Created`

Shape exacto (`AuthResponse`, `interfaces/auth-response.interface.ts`), construido por
`AuthService.register` → `toUserResponse()` + `issueTokenPair()`:

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "phone": "5512345678",
    "created_at": "2026-08-15T12:00:00.000Z"
  },
  "access_token": "eyJhbGciOi...",
  "refresh_token": "3f9a...opaque (128 hex chars)",
  "token_type": "Bearer",
  "expires_in": 900
}
```

Nota: `user` **no** incluye `updated_at` (solo lo incluye `GET /me`) ni, por supuesto,
`password_hash`/`pin` — `toUserResponse()` es un mapper explícito campo por campo, nunca
serializa la entidad completa.

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | Falla alguna regla de `RegisterDto` (email inválido, password sin dígito o < 6 chars, phone ≠ 10 dígitos, campo faltante) **o** el body trae un campo no declarado en el DTO (`forbidNonWhitelisted`) |
| `409` | `auth.service.ts:46-49` — ya existe un `Usuario` con ese `email` exacto (`ConflictException('El email ya está registrado')`). Nota: la búsqueda es `findOne({ where: { email: dto.email } })`, sin `LOWER()` ni normalización — es sensible a mayúsculas/minúsculas tal como esté guardado el email existente. |
| `429` | Rate-limiting por IP (`@nestjs/throttler`, `ThrottlerGuard`): más de 3 requests en 30 minutos desde la misma IP a `/auth/register` (`@Throttle({ default: { limit: 3, ttl: 1800000 } })` en `auth.controller.ts`). Límite dedicado, más estricto que el resto de la API (`/auth/login` sigue en 5/60s) — mitigación deliberada del hallazgo H8: a diferencia de `/auth/login`, `/auth/register` sí revela por diseño si un email existe (409 vs. 201), así que se frena la enumeración masiva de correos con un límite bajo por IP. No elimina el hueco (solo confirmación por correo lo haría), es una mitigación. Formato estándar de excepción de Nest, `message` como string: `{"statusCode":429,"message":"ThrottlerException: Too Many Requests"}`. |

---

## 3. POST /auth/login

Autentica una cuenta existente.

**Headers**: `Content-Type: application/json`. No requiere `Authorization`.

### Request body — `LoginDto` (`dto/login.dto.ts`)

| Campo | Tipo | Validación real |
|---|---|---|
| `email` | `string` | `@IsEmail()` (mismas notas que en register) |
| `password` | `string` | `@Matches(/^(?=.*\d).{6,}$/)` — mismo mensaje que en register |

```json
{
  "email": "user@example.com",
  "password": "abc123"
}
```

### Response — éxito `200 OK`

Mismo shape `AuthResponse` que `/auth/register` (`auth.service.ts:71-92`):

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "phone": "5512345678",
    "created_at": "2026-08-15T12:00:00.000Z"
  },
  "access_token": "eyJhbGciOi...",
  "refresh_token": "3f9a...opaque",
  "token_type": "Bearer",
  "expires_in": 900
}
```

### Errores

| Código | Condición exacta en el código |
|---|---|
| `400` | Falla alguna regla de `LoginDto`, o campo extra no declarado |
| `401` | **Dos causas distintas, mismo mensaje genérico** `"Credenciales inválidas"` (`INVALID_CREDENTIALS_MESSAGE`, `auth.service.ts:20`): (a) no existe `Usuario` con ese `email` (`auth.service.ts:77-79`), o (b) existe pero `bcrypt.compare(dto.password, usuario.passwordHash)` devuelve `false` (`auth.service.ts:81-84`). El cliente **no puede distinguir** ambos casos a partir de la respuesta — es intencional (evita enumeración de emails registrados). Además, `bcrypt.compare` se ejecuta **siempre** (contra un hash señuelo si el email no existe), para que el tiempo de respuesta tampoco delate cuál de los dos casos ocurrió. |
| `429` | Rate-limiting por IP (`@nestjs/throttler`, `ThrottlerGuard`): más de 5 requests en 60 segundos desde la misma IP a `/auth/login` (`@Throttle({ default: { limit: 5, ttl: 60000 } })` en `auth.controller.ts`). Formato estándar de excepción de Nest, `message` como string: `{"statusCode":429,"message":"ThrottlerException: Too Many Requests"}`. |

---

## 4. POST /auth/refresh

Intercambia un refresh token vigente por un par nuevo (rotación). El anterior queda revocado.

**Headers**: `Content-Type: application/json`. No requiere `Authorization` (el propio
`refresh_token` en el body es la credencial).

### Request body — `RefreshTokenDto` (`dto/refresh-token.dto.ts`)

| Campo | Tipo | Validación real |
|---|---|---|
| `refresh_token` | `string` | `@IsString()` + `@IsNotEmpty()` — no vacío |

```json
{
  "refresh_token": "3f9a...opaque"
}
```

### Response — éxito `200 OK`

Shape `TokenPairResponse` — **sin** `user`, a diferencia de register/login (`auth.service.ts:94-127`):

```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "8b2c...opaque-nuevo",
  "token_type": "Bearer",
  "expires_in": 900
}
```

### Errores

Todos los casos de `401` usan el mismo mensaje genérico `"Refresh token inválido"`
(`INVALID_REFRESH_TOKEN_MESSAGE`, `auth.service.ts:23`) — el cliente no puede distinguir cuál
ocurrió a partir de la respuesta:

| Código | Condición exacta en el código |
|---|---|
| `400` | `refresh_token` faltante, vacío o no-string (`RefreshTokenDto`), o campo extra no declarado |
| `401` | No existe ningún `RefreshToken` cuyo `token_hash` (SHA-256 del valor recibido) coincida (`auth.service.ts:101-103`) |
| `401` | El token encontrado ya está revocado (`revokedAt` no nulo, `auth.service.ts:105-113`). **Efecto lateral**: si además `replacedById` no es nulo (o sea, es un token que ya fue rotado y se está reintentando usar — señal de robo), el backend revoca en cascada **todos** los refresh tokens activos de ese usuario (`revokeAllActiveTokensForUser`, `auth.service.ts:192-197`) antes de responder el 401. Esto invalida sesiones en otros dispositivos silenciosamente — el cliente solo ve el mismo 401 genérico, sin ninguna señal explícita de que se disparó la revocación en cascada. |
| `401` | El token encontrado está vigente pero `expiresAt <= Date.now()` (`auth.service.ts:115-117`) |

---

## 5. GET /me

Devuelve el perfil de la cuenta autenticada.

**Headers**: **requerido** `Authorization: Bearer <access_token>`. Sin body.

Protegido por `JwtAuthGuard` (`AuthGuard('jwt')` de Passport) usando `JwtStrategy`
(`strategies/jwt.strategy.ts`): extrae el token del header `Authorization: Bearer <token>`
(`ExtractJwt.fromAuthHeaderAsBearerToken()`), valida firma y expiración
(`ignoreExpiration: false`), y si pasa, llama a `AuthService.validateUserById(payload.sub)` para
confirmar que el usuario del token todavía existe en la base de datos.

### Response — éxito `200 OK`

Shape `MeResponse` (`toMeResponse()`, `auth.service.ts:138-143`) — es `UserResponse` +
`updated_at`:

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "phone": "5512345678",
  "created_at": "2026-08-15T12:00:00.000Z",
  "updated_at": "2026-08-15T12:00:00.000Z"
}
```

`password_hash` y `pin` nunca se incluyen (mismo mapper explícito `toUserResponse()`, con
`updated_at` agregado aparte).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `401` | Header `Authorization` ausente o no tiene el esquema `Bearer <token>` — comportamiento **default** de `passport-jwt`/`AuthGuard`, no hay lógica custom. Body: `{"statusCode":401,"message":"Unauthorized","error":"Unauthorized"}` |
| `401` | Token con firma inválida o mal formado — mismo default de Passport, mismo body genérico `"Unauthorized"` |
| `401` | Token expirado (`ignoreExpiration: false` en `jwt.strategy.ts:17`) — mismo default de Passport |
| `401` | Token válido pero el `sub` (id de usuario) ya no existe en `usuarios` — `JwtStrategy.validate()` captura el error de `validateUserById` y relanza `new UnauthorizedException()` sin mensaje custom (`jwt.strategy.ts:25-32`), así que el body también es el genérico `"Unauthorized"` (no `"Credenciales inválidas"` como en `/auth/login`) |

---

## 6. GET /me/pin

Devuelve el PIN de desbloqueo del usuario autenticado, resuelto siempre a partir del JWT (nunca
de un parámetro de la request).

**Headers**: requerido `Authorization: Bearer <access_token>`. Sin body.

Protegido por `JwtAuthGuard`/`JwtStrategy`, exactamente igual que `GET /me` (ver sección 5): el
usuario del payload (`sub`) se resuelve vía `AuthService.validateUserById(payload.sub)`, que ya
trae la entidad `Usuario` completa (incluida la columna `pin`), así que `toPinResponse()` no
dispara ninguna consulta adicional a la base de datos.

### Response — éxito `200 OK`

Shape `PinResponse` (`toPinResponse()`, `auth.service.ts`):

```json
{
  "pin": "0427"
}
```

`pin` es siempre un string de 4 dígitos, con ceros a la izquierda preservados (el PIN se guarda
como `varchar(4)`, no como número).

### Errores

| Código | Condición exacta en el código |
|---|---|
| `401` | Header `Authorization` ausente o no tiene el esquema `Bearer <token>` — comportamiento **default** de `passport-jwt`/`AuthGuard`, no hay lógica custom. Body: `{"statusCode":401,"message":"Unauthorized","error":"Unauthorized"}` |
| `401` | Token con firma inválida o mal formado — mismo default de Passport, mismo body genérico `"Unauthorized"` |
| `401` | Token expirado (`ignoreExpiration: false` en `jwt.strategy.ts:17`) — mismo default de Passport |
| `401` | Token válido pero el `sub` (id de usuario) ya no existe en `usuarios` — `JwtStrategy.validate()` captura el error de `validateUserById` y relanza `new UnauthorizedException()` sin mensaje custom (`jwt.strategy.ts:25-32`), así que el body también es el genérico `"Unauthorized"` (no `"Credenciales inválidas"` como en `/auth/login`) |

---

## Diferencias vs. diseño original

Comparado contra `c:\dev\ticket\src\features\auth\AUTH_ENDPOINTS.md`. En general el código sigue
el diseño con fidelidad alta (rutas, códigos HTTP, shapes de respuesta, nombres de campos en
snake_case, TTLs y sus nombres de env var, regex de password/phone, mensaje genérico de login,
rotación de refresh token con detección de reuso). Las diferencias puntuales encontradas:

1. **Validación de `email` sin trim/normalización.** El diseño (sección 3, basado en
   `emailSchema` del frontend) asumía "trim, no vacío, formato válido". El código solo usa
   `@IsEmail()` de `class-validator`, sin ningún `@Transform` de `class-transformer` para hacer
   trim. Si el cliente llegara a enviar el email con espacios accidentales, la request puede
   fallar con `400` en vez de limpiarse silenciosamente en el backend. **Recomendación para el
   cliente móvil**: hacer `.trim()` sobre el email antes de enviarlo, no asumir que el backend lo
   normaliza.

2. **`whitelist: true` + `forbidNonWhitelisted: true` en el `ValidationPipe` global** (`main.ts`)
   no estaba explícito en el diseño (que solo mencionaba `whitelist` y `forbidNonWhitelisted`
   como "recomendación" genérica, sección 1). En el código sí está activo, con una consecuencia
   concreta que el diseño no llegó a especificar: **cualquier campo extra en el body (ej. enviar
   `confirmPassword` a `/auth/register`) hace fallar la request completa con `400`**, en vez de
   ser ignorado. El cliente debe asegurarse de enviar exactamente los campos documentados en cada
   DTO, sin campos adicionales.

3. **Generación automática de PIN en `/auth/register`, no contemplada en el diseño.**
   `AUTH_ENDPOINTS.md` declara explícitamente la verificación de PIN "fuera de alcance" (sección
   6: "endpoint separado, no es parte de este flujo"). Sin embargo, el código sí genera un PIN de
   4 dígitos en cada registro (`generatePin()`, `auth.service.ts`). Ese PIN se guarda en texto
   plano en `usuarios.pin` (decisión explícita de producto: por ahora no se hashea). **El PIN
   nunca se devuelve en la respuesta de `/auth/register`, `/auth/login` ni `GET /me`**
   (`toUserResponse()`/`toMeResponse()` no lo incluyen) — el cliente lo obtiene mediante el
   endpoint dedicado [`GET /me/pin`](#6-get-mepin).

4. **Mensaje de error `401` distinto entre `/auth/login` y `GET /me`.** El diseño usaba
   `"Credenciales inválidas"` como ejemplo genérico de error `401` sin distinguir endpoints. En el
   código, `/auth/login` sí devuelve ese mensaje custom, pero los `401` de `GET /me` (token
   ausente, inválido, expirado, o usuario ya no existente) vienen del comportamiento default de
   Passport/Nest y devuelven el mensaje genérico `"Unauthorized"` — el texto es distinto según el
   endpoint.

5. **Mensaje de error `401` de `/auth/refresh` documentado ahora con texto exacto.** El diseño
   describía las condiciones de error pero no fijaba el string de `message`. El código usa
   literalmente `"Refresh token inválido"` (`INVALID_REFRESH_TOKEN_MESSAGE`) para las tres causas
   (no encontrado, revocado, expirado) — dato nuevo, no una discrepancia, pero útil para que el
   cliente no dependa de un texto distinto.

6. **Detalle interno menor**: el hash de password se hace con la librería `bcryptjs` (JS puro)
   en vez de `bcrypt` (binario nativo) que mencionaba el diseño como opción. No afecta el
   contrato de la API (mismo algoritmo, mismo formato de hash), es solo una nota de
   implementación.

No se encontraron diferencias en: rutas y métodos HTTP, códigos de éxito (201/200/200/200), shape
de `user` y de los tokens, reglas de `password`/`phone`, TTLs y sus nombres de env var, exclusión
de `password_hash` de todas las respuestas y de `pin` de `/auth/register`, `/auth/login` y
`GET /me` (solo `GET /me/pin` lo devuelve), ausencia de `confirmPassword` en el request,
auto-login en `/auth/register`, y la lógica de rotación + detección de reuso en `/auth/refresh`.

# API — Generar nuevo PIN (`POST /me/pin/regenerate`)

## 1. Resumen

Permite a un usuario ya autenticado reingresar su contraseña de login para generar y persistir un
PIN nuevo de 4 dígitos, reemplazando el PIN anterior. Es el endpoint que consume la acción "Generar
PIN" del panel lateral de cuenta (`UserSidePanel.tsx` → `GenerarPinModal.tsx` en el frontend): el
usuario escribe su contraseña, confirma, y recibe el PIN nuevo para anotarlo (se muestra una única
vez, igual que el PIN inicial que se ve en `WelcomePinModal.tsx` al registrarse).

## 2. Método, ruta y guard

| | |
|---|---|
| Método | `POST` |
| Ruta | `/me/pin/regenerate` (sin prefijo `/auth`, igual que `GET /me` y `GET /me/pin`) |
| Guard | `JwtAuthGuard` (`@UseGuards(JwtAuthGuard)`) |
| Header requerido | `Authorization: Bearer <access_token>` |
| Status de éxito | `200 OK` (`@HttpCode(HttpStatus.OK)`, no `201`) |
| Throttle propio | `5 req / min por IP` (`@Throttle({ default: { limit: 5, ttl: 60000 } })`) |

**URL completa**: el frontend arma la URL concatenando `EXPO_PUBLIC_API_URL` (variable de entorno,
ver `.env.example` en la raíz del repo frontend, ej. `http://localhost:3000` en desarrollo) con el
path del endpoint — mismo criterio que usa `src/shared/api/auth.ts` y `src/shared/api/pin.ts` para
el resto de los endpoints. No hay un host hardcodeado en ningún lugar del código; en runtime la URL
completa sería, por ejemplo:

```
POST http://localhost:3000/me/pin/regenerate
```

## 3. Autenticación

- Requiere `JwtAuthGuard`, el mismo guard que protege `GET /me` y `GET /me/pin`. El `usuario` se
  resuelve enteramente del `sub` del JWT (`@CurrentUser()`), nunca de un parámetro del body.
- Si el header `Authorization` falta, el token está mal formado, la firma es inválida, el token
  expiró, o el `sub` ya no corresponde a ningún usuario existente, el guard responde `401` con el
  formato default de Passport: `{"statusCode":401,"message":"Unauthorized","error":"Unauthorized"}`
  (mismo formato que `GET /me`/`GET /me/pin`, distinto del `401` con mensaje custom que usan
  `/auth/login`/`/auth/refresh`).
- **Compatibilidad con el auto-refresh del frontend**: este endpoint es un candidato normal para
  `authenticatedRequest()` (`src/shared/api/auth.ts`), el wrapper que ya usan `GET /me` y (se
  recomienda, ver sección 8) debería usar `GET /me/pin`. Ese wrapper:
  1. Si al access token guardado le quedan ≤30s o ya expiró, refresca proactivamente antes de
     intentar la request.
  2. Si a pesar de eso la request responde `401`, refresca una vez de forma reactiva y reintenta la
     request original con el access token nuevo.
  3. Si el refresh también falla, borra los tokens locales y notifica sesión inválida.

  Esto es compatible sin fricción con `POST /me/pin/regenerate` **porque el caso de negocio
  "contraseña incorrecta" no responde `401` sino `400`** (ver sección 6) — si respondiera `401`, cada
  vez que el usuario tipeara mal su contraseña, `authenticatedRequest()` interpretaría eso como
  "sesión vencida", dispararía un refresh y una rotación real del refresh token de forma innecesaria
  en cada intento fallido. Al ser `400`, el error de negocio pasa directo a quien llamó sin tocar el
  ciclo de tokens.

## 4. Rate limiting

- **5 solicitudes por minuto por IP**, límite dedicado (`@Throttle({ default: { limit: 5, ttl: 60000
  } })`), el mismo límite numérico que usa `POST /auth/login` — la justificación documentada en el
  propio controller es que ambos endpoints verifican una contraseña contra un hash bcrypt (misma
  naturaleza anti-fuerza-bruta), aunque acá el atacante ya necesitaría un access token válido robado
  para siquiera poder intentarlo.
- Si se excede: `429`, con el formato default de `ThrottlerException` de `@nestjs/throttler` (no hay
  `ExceptionFilter` custom en el módulo `auth` que lo reformatee). El `README.md` de `auth` no deja
  registrado el body exacto de ese `429` para ningún endpoint del módulo — no se documenta un shape
  específico acá para no inventarlo; asumir el formato default de la librería
  (`{"statusCode":429,"message":"ThrottlerException: Too Many Requests"}`) pero verificarlo contra
  una respuesta real antes de depender de su shape exacto en el cliente.
- Este límite es por IP, no por usuario — un usuario detrás de una IP compartida (ej. NAT de oficina)
  puede agotar el límite por intentos de otro dispositivo en la misma red.

## 5. Request

### Shape del body

```json
{
  "password": "string"
}
```

`RegeneratePinDto` (`src/auth/dto/regenerate-pin.dto.ts`) declara un único campo:

| Campo | Tipo | Validación | Mensaje de error si falla |
|---|---|---|---|
| `password` | `string` | `@Matches(/^(?=.*\d).{6,}$/)` — mínimo 6 caracteres, al menos 1 dígito, sin más restricciones de charset | `"La contraseña debe tener al menos 6 caracteres y al menos un número"` |
| `password` | `string` | `@MaxBcryptBytes()` (validador custom) — rechaza si `Buffer.byteLength(password, 'utf8') > 72`; bcrypt trunca en silencio pasado ese límite, así que se rechaza explícito en vez de dejar que trunque | `"La contraseña no puede pesar más de 72 bytes (los acentos pesan 2, los emojis hasta 4)"` |

Es exactamente la misma regla de validación de `password` que usan `LoginDto` y `RegisterDto` — no
hay una regla de "contraseña fuerte" adicional acá, es solo el shape mínimo esperable de cualquier
contraseña de esta app. Los mensajes, en cambio, están en español (constantes en
`src/auth/dto/messages.ts`, compartidas con `ResetPasswordDto`); `LoginDto`/`RegisterDto` conservan
sus mensajes en inglés.

El `ValidationPipe` global (`whitelist: true, forbidNonWhitelisted: true`, **sin** `transform: true`)
aplica igual que en el resto de la API: cualquier campo extra en el body (ej. mandar también un
`pin` o `confirmPassword`) responde `400` por campo no permitido, no se descarta silenciosamente.

### Ejemplo de body de error de validación (400 de class-validator)

Password vacío o sin dígito, por ejemplo `{ "password": "abc" }`:

```json
{
  "statusCode": 400,
  "message": [
    "La contraseña debe tener al menos 6 caracteres y al menos un número"
  ],
  "error": "Bad Request"
}
```

`message` es siempre un **array** de strings cuando el 400 viene de `class-validator` (uno por regla
violada — si el password fuera además demasiado largo en bytes, el array traería ambos mensajes),
consistente con el resto de los DTOs del módulo `auth` (ver `src/auth/README.md`, sección "Formato de
errores").

## 6. Response de éxito

- Status: **`200 OK`**.
- Body (interfaz `PinResponse`, reusada de `GET /me/pin` — `src/auth/interfaces/auth-response.interface.ts`):

```json
{
  "pin": "0472"
}
```

- `pin` es siempre un `string` de **4 dígitos con ceros a la izquierda preservados** (generado con
  `randomInt(0, 10000).toString().padStart(4, '0')`, rango `"0000"`–`"9999"`) — nunca tratarlo como
  número en el cliente, porque `"0472"` como number pierde el cero inicial.
- El PIN nuevo queda persistido de inmediato antes de responder, con una escritura parcial
  condicionada: `usuarioRepository.update({ id, passwordHash: <hash verificado> }, { pin })` (ver
  sección 12). Si la respuesta llega al cliente, el cambio ya es efectivo en el backend; no hay un
  paso de confirmación posterior.

## 7. Response de error de negocio (contraseña incorrecta)

- Status: **`400 Bad Request`** — **no `401`**. Esta distinción es intencional y está documentada en
  un comentario del propio `AuthService.regeneratePin()`: un `401` en un endpoint ya autenticado
  dispara en el cliente (`authenticatedRequest()`) un intento de refresh + reintento automático,
  pensado para "mi access token venció", no para "tipeé mal mi contraseña". Usar `401` acá gatillaría
  una rotación real e innecesaria del refresh token en cada intento fallido de contraseña. Ver
  también sección 3 de este documento.
- Body:

```json
{
  "statusCode": 400,
  "message": "Contraseña incorrecta",
  "error": "Bad Request"
}
```

- Acá `message` es un **string simple**, no un array — porque viene de un `BadRequestException`
  lanzado a mano en el servicio (`throw new BadRequestException('Contraseña incorrecta')`), no de
  `class-validator`. Un cliente que necesite distinguir "error de validación de DTO" de "contraseña
  incorrecta" puede chequear si `message` es array o string, o comparar el string directo contra
  `"Contraseña incorrecta"`.
- El PIN **no se modifica** en este caso (confirmado por test: `expect(usuario.pin).toBe(originalPin)`
  y `expect(usuarioRepository.update).not.toHaveBeenCalled()` en `src/auth/auth.service.spec.ts`).
- El mismo `400 "Contraseña incorrecta"` se responde si la contraseña coincidía pero el `update`
  condicionado afectó 0 filas: un `POST /auth/reset-password` concurrente cambió la contraseña entre
  la lectura y la escritura, así que la contraseña verificada ya no es la vigente (sección 12).

## 8. Todos los status codes posibles

| Status | Cuándo ocurre | Shape de `message` |
|---|---|---|
| `200` | Contraseña correcta: PIN nuevo generado y persistido. | — (no aplica, es éxito) |
| `400` | `password` no cumple `@Matches`/`@MaxBcryptBytes`, o el body trae un campo no declarado (`forbidNonWhitelisted`). | array de strings |
| `400` | `password` no coincide con el hash guardado del usuario autenticado (contraseña incorrecta), o un reset concurrente cambió la contraseña antes de escribir el PIN. | string simple: `"Contraseña incorrecta"` |
| `401` | Header `Authorization` ausente, JWT mal formado/firma inválida, expirado, el `sub` del payload ya no existe como usuario, o el access token se emitió antes de un reset de contraseña (claim `tv` distinto de `usuarios.token_version`) — y el cliente no logró refrescar la sesión antes de que este endpoint respondiera. | string simple: `"Unauthorized"` (formato default de Passport) |
| `429` | Se superaron las 5 solicitudes/minuto por IP contra este endpoint. | formato default de `ThrottlerException` (no verificado byte a byte contra una respuesta real, ver sección 4) |

## 9. Integración en el frontend

**Ya integrado.** El frontend (`c:\dev\ticket`) consume este endpoint con `regenerarPinRemoto()` en
`src/shared/api/pin.ts`, invocada desde `handlePressGenerarPin()` en
`src/features/cuenta/GenerarPinModal.tsx`. Sigue el mismo patrón que `fetchPinRemoto()` para
`GET /me/pin` (wrapper `authenticatedRequest`, tipo `PinResponse`). El código de referencia de abajo
es el diseño que se usó; la fuente de verdad del cliente es ese archivo:

```typescript
// src/shared/api/pin.ts (agregar junto a fetchPinRemoto existente)

import { authenticatedRequest } from '@/shared/api/auth';

// Ver C:\Users\Papeleria Aldana\Desktop\ticket-backend\API generar nuevo PIN.md —
// fuente de verdad del contrato real de este endpoint.

export type PinResponse = {
  pin: string;
};

/**
 * Obtiene el PIN de desbloqueo del usuario autenticado desde GET /me/pin
 * (resuelto del JWT en el backend, nunca de un parámetro).
 */
export async function fetchPinRemoto(): Promise<PinResponse> {
  return authenticatedRequest<PinResponse>('/me/pin', { method: 'GET' });
}

/**
 * POST /me/pin/regenerate. Reingresa la contraseña de login del usuario autenticado
 * para generar y persistir un PIN nuevo de 4 dígitos, que reemplaza al anterior.
 *
 * Contraseña incorrecta responde 400 (no 401): es un ApiError de negocio normal,
 * no dispara el auto-refresh/rotación de authenticatedRequest(). Quien llama debe
 * capturar ApiError y mostrar error.messages[0] (ej. "Contraseña incorrecta") sin
 * tratarlo como sesión inválida.
 */
export async function regenerarPinRemoto(password: string): Promise<PinResponse> {
  return authenticatedRequest<PinResponse>('/me/pin/regenerate', {
    method: 'POST',
    body: { password },
  });
}
```

Manejo de errores esperado en quien invoque `regenerarPinRemoto()`, siguiendo el mismo patrón de
`ApiError` que ya expone `src/shared/api/auth.ts` (`status` + `messages: string[]`):

```typescript
try {
  const { pin } = await regenerarPinRemoto(password);
  // éxito: ver sección 10
} catch (error) {
  if (error instanceof ApiError && error.status === 400) {
    // error.messages[0] — "Contraseña incorrecta" o un mensaje de validación de DTO
  }
  // status !== 400 (ej. 401 ya no recuperable, 429, 0 = sin red): manejar aparte
}
```

## 10. Qué hacer con la respuesta en el frontend

Contexto de producto (la implementación de UI detallada no es parte de este documento, ya vive en
los componentes existentes): en éxito, `GenerarPinModal.tsx` se cierra y se muestra el PIN nuevo en
`WelcomePinModal.tsx` (mismo modal que ya muestra el PIN inicial al registrarse, reusando sus props
`pin`/`visible`/`onDismiss`). En el caso de contraseña incorrecta (`400`), `GenerarPinModal.tsx` no
se cierra: el mensaje de error se muestra entre el input de contraseña y el botón "Generar PIN",
dejando que el usuario reintente sin perder el modal. Ver `src/features/cuenta/README.md` del
frontend para el detalle del flujo.

## 11. Estado actual

- **Backend**: implementado y testeado. `POST /me/pin/regenerate` existe en
  `src/auth/auth.controller.ts`, la lógica en `AuthService.regeneratePin()`
  (`src/auth/auth.service.ts`) y el DTO en `src/auth/dto/regenerate-pin.dto.ts`. La escritura es un
  `usuarioRepository.update({ id, passwordHash }, { pin })` condicionado (ver sección 12). Tests
  unitarios en `src/auth/auth.service.spec.ts`: contraseña correcta (se llama a `update` con
  `{ id, passwordHash }` y `{ pin }`, nunca a `save`), contraseña incorrecta (no hay `update`) y
  `affected: 0` por reset concurrente (400 `"Contraseña incorrecta"`). Los mensajes en español del
  DTO se prueban en `src/auth/dto/recovery-dtos.spec.ts`.
- **Frontend**: integrado. `regenerarPinRemoto()` en `src/shared/api/pin.ts`, usada por
  `GenerarPinModal.tsx` (`src/features/cuenta/GenerarPinModal.tsx`).

## 12. Notas de seguridad

- **No usa el patrón "dummy hash" timing-safe que sí usa `login()`.** Ese patrón existe en `login()`
  para que un intento con un email inexistente pague el mismo costo de `bcrypt.compare` que uno con
  email real, y así no filtrar por temporización qué correos están registrados — es un problema de
  **anonimato del llamante**. Acá el llamante ya está autenticado e identificado por el JWT
  (`JwtAuthGuard` + `@CurrentUser()`) antes de llegar al service: no hay ningún email de por medio
  cuya existencia haya que ocultar, así que ese patrón no aplica y no se replicó.
- **El PIN se sigue guardando en texto plano** (`usuarios.pin varchar(4)`, sin hashear) — decisión de
  producto ya tomada y documentada en `src/auth/README.md` (secciones 3 y 5), no un descuido de esta
  implementación. El PIN es puramente un gate de UI local en el frontend (`pinStore.ts`/`PinGate`);
  el backend nunca lo valida, solo lo expone vía `GET /me/pin` y ahora lo regenera vía este endpoint.
  No se debe "corregir" agregando hashing sin un pedido nuevo del dueño del producto.
- **Escritura condicionada sobre `password_hash` como protección ante un reset concurrente.**
  `regeneratePin()` recibe la entidad `Usuario` que `JwtStrategy` leyó al inicio de la request. Un
  `save()` de esa entidad completa reescribiría también el `password_hash` leído entonces y podría
  revertir el que un `POST /auth/reset-password` simultáneo acababa de guardar. Por eso escribe
  solo `pin` con `update({ id, passwordHash: <hash verificado> }, { pin })`: si el reset ganó la
  carrera, el `update` afecta 0 filas y se responde `400 "Contraseña incorrecta"` (no se regenera el
  PIN con una contraseña que ya no vale). Simétricamente, `resetPassword()` escribe solo
  `password_hash` y `token_version`, así que tampoco revierte un PIN recién regenerado.
- **Después de un reset de contraseña**, el access token con el que se llamaba a este endpoint deja
  de valer de inmediato (401 por el claim `tv`, ver `src/auth/README.md` §3).
- El PIN nuevo no se envía por ningún canal fuera de la respuesta HTTP de este endpoint (a
  diferencia del código de recuperación de contraseña, que sí viaja por email) — el único momento en
  que el usuario lo ve es en esta respuesta, mostrada una vez en `WelcomePinModal.tsx`.

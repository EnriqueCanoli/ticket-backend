import { Equals, IsBoolean, IsEmail, Matches } from 'class-validator';
import { MaxBcryptBytes } from '../validators/max-bcrypt-bytes.validator';

/**
 * AUTH_ENDPOINTS.md sección 3 (POST /auth/register). Reglas tomadas de
 * `emailSchema`/`passwordSchema`/`phoneSchema` (frontend, zod):
 * - password: mínimo 6 caracteres, al menos 1 dígito, máximo 72 bytes UTF-8
 *   (límite real de bcrypt, ver MaxBcryptBytes).
 * - phone: exactamente 10 dígitos, sin espacios/formato.
 *
 * `confirmPassword` no viaja al backend (ver sección 5, punto 1 del doc).
 *
 * `aceptoTerminos`: no basta con validarlo en el cliente — el patrón de este
 * repo (ver auditorías previas) es no confiar solo en la validación del
 * cliente. `@Equals(true)` rechaza con 400 tanto el `false` explícito como
 * cualquier valor que no sea literalmente `true`; `@IsBoolean()` cubre el
 * caso de que falte o venga con otro tipo (sin `transform: true` en el
 * ValidationPipe global, un `undefined` llega tal cual al validador).
 */
export class RegisterDto {
  @IsEmail()
  email: string;

  @Matches(/^(?=.*\d).{6,}$/, {
    message:
      'password must be at least 6 characters long and contain at least 1 number',
  })
  @MaxBcryptBytes()
  password: string;

  @Matches(/^\d{10}$/, {
    message: 'phone must be exactly 10 digits',
  })
  phone: string;

  @IsBoolean()
  @Equals(true, {
    message:
      'debes aceptar los Términos y Condiciones y la Política de Privacidad',
  })
  aceptoTerminos: boolean;
}

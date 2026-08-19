import { IsEmail, Matches } from 'class-validator';

/**
 * AUTH_ENDPOINTS.md sección 3 (POST /auth/register). Reglas tomadas de
 * `emailSchema`/`passwordSchema`/`phoneSchema` (frontend, zod):
 * - password: mínimo 6 caracteres, al menos 1 dígito.
 * - phone: exactamente 10 dígitos, sin espacios/formato.
 *
 * `confirmPassword` no viaja al backend (ver sección 5, punto 1 del doc).
 */
export class RegisterDto {
  @IsEmail()
  email: string;

  @Matches(/^(?=.*\d).{6,}$/, {
    message:
      'password must be at least 6 characters long and contain at least 1 number',
  })
  password: string;

  @Matches(/^\d{10}$/, {
    message: 'phone must be exactly 10 digits',
  })
  phone: string;
}

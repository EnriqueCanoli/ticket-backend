import { IsEmail, Matches } from 'class-validator';
import { MaxBcryptBytes } from '../validators/max-bcrypt-bytes.validator';

/** AUTH_ENDPOINTS.md sección 3 (POST /auth/login). Mismas reglas de formato que RegisterDto. */
export class LoginDto {
  @IsEmail()
  email: string;

  @Matches(/^(?=.*\d).{6,}$/, {
    message:
      'password must be at least 6 characters long and contain at least 1 number',
  })
  @MaxBcryptBytes()
  password: string;
}

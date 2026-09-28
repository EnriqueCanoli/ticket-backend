import { IsEmail, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxBcryptBytes } from '../validators/max-bcrypt-bytes.validator';
import { trimAndLowercase } from './transforms';

/** AUTH_ENDPOINTS.md sección 3 (POST /auth/login). Mismas reglas de formato que RegisterDto. */
export class LoginDto {
  @Transform(trimAndLowercase)
  @IsEmail()
  email: string;

  @Matches(/^(?=.*\d).{6,}$/, {
    message:
      'password must be at least 6 characters long and contain at least 1 number',
  })
  @MaxBcryptBytes()
  password: string;
}

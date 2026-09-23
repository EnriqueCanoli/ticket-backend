import { IsEmail, Matches } from 'class-validator';
import { MaxBcryptBytes } from '../validators/max-bcrypt-bytes.validator';

export class ResetPasswordDto {
  @IsEmail()
  email: string;

  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code: string;

  @Matches(/^(?=.*\d).{6,}$/, {
    message:
      'password must be at least 6 characters long and contain at least 1 number',
  })
  @MaxBcryptBytes()
  password: string;
}

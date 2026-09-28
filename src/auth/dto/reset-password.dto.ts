import { IsEmail, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxBcryptBytes } from '../validators/max-bcrypt-bytes.validator';
import {
  EMAIL_FORMAT_MESSAGE,
  PASSWORD_FORMAT_MESSAGE,
  PASSWORD_MAX_BYTES_MESSAGE,
  RESET_CODE_FORMAT_MESSAGE,
} from './messages';
import { trimAndLowercase } from './transforms';

export class ResetPasswordDto {
  @Transform(trimAndLowercase)
  @IsEmail({}, { message: EMAIL_FORMAT_MESSAGE })
  email: string;

  @Matches(/^\d{6}$/, { message: RESET_CODE_FORMAT_MESSAGE })
  code: string;

  @Matches(/^(?=.*\d).{6,}$/, { message: PASSWORD_FORMAT_MESSAGE })
  @MaxBcryptBytes({ message: PASSWORD_MAX_BYTES_MESSAGE })
  password: string;
}

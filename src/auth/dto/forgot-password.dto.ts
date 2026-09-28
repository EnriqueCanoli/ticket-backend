import { IsEmail } from 'class-validator';
import { Transform } from 'class-transformer';
import { EMAIL_FORMAT_MESSAGE } from './messages';
import { trimAndLowercase } from './transforms';

export class ForgotPasswordDto {
  @Transform(trimAndLowercase)
  @IsEmail({}, { message: EMAIL_FORMAT_MESSAGE })
  email: string;
}

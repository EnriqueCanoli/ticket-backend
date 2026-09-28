import { Matches } from 'class-validator';
import { MaxBcryptBytes } from '../validators/max-bcrypt-bytes.validator';
import {
  PASSWORD_FORMAT_MESSAGE,
  PASSWORD_MAX_BYTES_MESSAGE,
} from './messages';

/** POST /me/pin/regenerate. Mismas reglas de `password` que LoginDto, con mensajes en español. */
export class RegeneratePinDto {
  @Matches(/^(?=.*\d).{6,}$/, { message: PASSWORD_FORMAT_MESSAGE })
  @MaxBcryptBytes({ message: PASSWORD_MAX_BYTES_MESSAGE })
  password: string;
}

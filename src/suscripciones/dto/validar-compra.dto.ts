import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body de POST /me/suscripcion/validar-compra (exactamente estos tres campos). */
export class ValidarCompraDto {
  @IsString()
  @IsIn(['google_play'])
  tienda: 'google_play';

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  producto_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  token_compra: string;
}

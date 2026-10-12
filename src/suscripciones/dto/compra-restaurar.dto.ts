import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Elemento de `compras` en POST /me/suscripcion/restaurar. */
export class CompraRestaurarDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  producto_id: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  token_compra: string;
}

import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, ValidateNested } from 'class-validator';
import { CompraRestaurarDto } from './compra-restaurar.dto';

/** Body de POST /me/suscripcion/restaurar. Se admite un arreglo vacío. */
export class RestaurarComprasDto {
  @IsIn(['google_play'])
  tienda: 'google_play';

  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CompraRestaurarDto)
  compras: CompraRestaurarDto[];
}

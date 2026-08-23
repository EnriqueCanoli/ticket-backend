import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * PATCH /productos/:id (features/productos/ENDPOINTS.md sección 4). Los tres
 * campos son opcionales individualmente (semántica estándar de `PATCH`), pero
 * se exige al menos uno presente — validado en `ProductosService.update`
 * (`class-validator` no tiene un decorador nativo simple para "al menos uno
 * de N campos", ver ENDPOINTS.md §8.5).
 *
 * Deliberadamente NO declara `costo_validado`, `activo`, `usuario_id`, `id`,
 * `created_at` ni `updated_at`: el `ValidationPipe` global
 * (`forbidNonWhitelisted: true`) responde `400` si el cliente los manda.
 * `costo_validado` se fuerza siempre a `true` en el servicio, sin importar
 * qué campos vinieron.
 */
export class UpdateProductoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'nombre should not be empty' })
  @MaxLength(150)
  nombre?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  costo?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99999999.99)
  precio_venta?: number;
}

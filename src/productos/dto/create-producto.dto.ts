import { IsNotEmpty, IsNumber, IsString, Matches, MaxLength, Min } from 'class-validator';

/**
 * POST /productos (ENDPOINTS.md sección 3). Alta rápida desde el buscador de
 * ticket: el cliente solo manda `nombre` y `precio_venta`.
 *
 * Deliberadamente NO declara `costo`, `costo_validado`, `id`, `created_at`
 * ni `updated_at`: el `ValidationPipe` global (`forbidNonWhitelisted: true`,
 * ver `main.ts`) responde `400` si el cliente los manda, en vez de
 * ignorarlos silenciosamente — es el mecanismo que impide que el cliente
 * fuerce campos que debe calcular el backend (ver README_DB_PROPUESTA.md
 * §3.2: `costo = 1`, `costo_validado = false`).
 */
export class CreateProductoDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'nombre should not be empty' })
  @MaxLength(150)
  nombre: string;

  /** `numeric(10,2)` en BD (README §3.2): hasta 2 decimales, `>= 0`. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  precio_venta: number;
}

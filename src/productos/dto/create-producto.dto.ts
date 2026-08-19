import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * POST /productos (ENDPOINTS.md sección 3, features/productos/ENDPOINTS.md
 * sección 3 — modificado). Dos flujos distintos del cliente comparten este
 * DTO:
 * - Alta rápida desde el buscador de ticket: solo manda `nombre` +
 *   `precio_venta` (comportamiento original, sin cambios).
 * - Alta completa desde ProductosScreen: manda además `costo`, ahora
 *   aceptado opcionalmente.
 *
 * Deliberadamente NO declara `costo_validado`, `activo`, `id`, `created_at`
 * ni `updated_at`: el `ValidationPipe` global (`forbidNonWhitelisted: true`,
 * ver `main.ts`) responde `400` si el cliente los manda, en vez de
 * ignorarlos silenciosamente — es el mecanismo que impide que el cliente
 * fuerce campos que debe calcular el backend (ver README_DB_PROPUESTA.md
 * §3.2: `costo_validado` se deriva de si `costo` vino o no en el body).
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

  /**
   * Opcional (features/productos/ENDPOINTS.md §3): si viene, el servicio lo
   * usa y marca `costo_validado = true`; si no, se mantiene el default
   * `costo = 1` / `costo_validado = false`. Misma regla de validación que
   * `precio_venta`.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  costo?: number;
}

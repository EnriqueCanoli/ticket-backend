import { IsNumber, IsPositive, IsUUID, Max } from 'class-validator';

/**
 * Item anidado de `POST /tickets` (ENDPOINTS.md sección 4).
 *
 * Deliberadamente NO declara `precio_venta_unitario`, `costo_unitario`,
 * `subtotal` ni `id`: esos valores se snapshotean en el backend a partir del
 * producto vigente al momento de crear la línea (README_DB_PROPUESTA.md
 * §5.2), nunca se reciben del cliente — `forbidNonWhitelisted` los rechaza
 * con `400` si igual se mandan.
 */
export class CreateTicketItemDto {
  @IsUUID()
  producto_id: string;

  /**
   * `numeric(10,3)` en BD (README §3.4): hasta 3 decimales. `@IsPositive()`
   * exige estrictamente `> 0` (no hay piso de `0.1`: ese mínimo es solo una
   * conveniencia de UI en `handleCantidadBlur`, no una regla de negocio —
   * ver ENDPOINTS.md sección 4). `@Max` evita el overflow de Postgres
   * (`numeric field overflow`, 500) para valores con más de 7 dígitos enteros.
   */
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  @Max(9999999.999)
  cantidad: number;
}

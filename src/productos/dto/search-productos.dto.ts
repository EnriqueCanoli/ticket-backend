import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * GET /productos (ENDPOINTS.md sección 2). `search` requerido, `400` si está
 * ausente o si, luego de `trim()`, queda vacío.
 *
 * `@IsNotEmpty()` por sí solo no cubre "solo espacios" (`' ' !== ''`), por
 * eso se suma `@Matches(/\S/)`. El `trim()` real del término de búsqueda se
 * hace en `ProductosService.search`, no acá: el `ValidationPipe` global no
 * usa `transform: true` (ver `main.ts`), así que no reemplazaría el valor
 * que finalmente recibe el controller por la versión transformada.
 */
export class SearchProductosDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'search should not be empty' })
  search: string;
}

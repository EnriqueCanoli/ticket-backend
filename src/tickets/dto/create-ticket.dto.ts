import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateTicketItemDto } from './create-ticket-item.dto';

/**
 * `POST /tickets` (ENDPOINTS.md sección 4). El cliente manda únicamente la
 * lista de líneas.
 *
 * Deliberadamente NO declara `usuario_id` (se toma del JWT vía
 * `@CurrentUser()`, nunca del body) ni `total` (se calcula en el backend
 * como `SUM(subtotal)`, README §5.3 — nunca se confía en un total mandado
 * por el cliente) — `forbidNonWhitelisted` rechaza la request con `400` si
 * igual se mandan.
 */
export class CreateTicketDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateTicketItemDto)
  items: CreateTicketItemDto[];
}

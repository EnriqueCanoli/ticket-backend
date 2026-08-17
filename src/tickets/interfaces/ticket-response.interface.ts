/**
 * Shape de cada línea en la respuesta de `POST /tickets` (ENDPOINTS.md
 * sección 4). `nombre_producto` no es columna de `ticket_items`: se arma con
 * un lookup contra el `producto` vigente al momento de la respuesta, no
 * snapshoteado (a diferencia de los precios).
 */
export interface TicketItemResponse {
  id: string;
  producto_id: string;
  nombre_producto: string;
  cantidad: number;
  precio_venta_unitario: number;
  costo_unitario: number;
  subtotal: number;
}

/** Shape de la respuesta `201 Created` de `POST /tickets` (ENDPOINTS.md sección 4). */
export interface TicketResponse {
  id: string;
  usuario_id: string;
  total: number;
  created_at: Date;
  items: TicketItemResponse[];
}

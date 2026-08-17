/**
 * Shape de cada elemento de `GET /productos` (ENDPOINTS.md sección 2 y §5.1):
 * acotado a lo que el buscador de `BuscarProductoScreen.tsx` necesita, sin
 * `costo`/`costo_validado`.
 */
export interface ProductoSearchResult {
  id: string;
  nombre: string;
  precio_venta: number;
}

/** Shape de `POST /productos` (ENDPOINTS.md sección 3): entidad completa ya creada. */
export interface ProductoResponse {
  id: string;
  nombre: string;
  precio_venta: number;
  costo: number;
  costo_validado: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Shape de cada elemento de `GET /productos` (ENDPOINTS.md sección 2 y §5.1):
 * acotado a lo que el buscador de `BuscarProductoScreen.tsx` necesita, sin
 * `costo`/`costo_validado`. Sí incluye `es_a_granel`: el carrito lo necesita para
 * decidir si la línea del ticket permite capturar el total en lugar de la cantidad.
 */
export interface ProductoSearchResult {
  id: string;
  nombre: string;
  precio_venta: number;
  es_a_granel: boolean;
}

/**
 * Shape de `POST /productos` y `PATCH /productos/:id`
 * (features/productos/ENDPOINTS.md secciones 3 y 4): entidad completa.
 */
export interface ProductoResponse {
  id: string;
  nombre: string;
  precio_venta: number;
  costo: number;
  costo_validado: boolean;
  es_a_granel: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Shape de cada elemento de `GET /productos/catalogo`
 * (features/productos/ENDPOINTS.md sección 2): todos los campos que necesita
 * la tabla de `ProductosScreen.tsx`, sin timestamps.
 */
export interface ProductoCatalogoItem {
  id: string;
  nombre: string;
  costo: number;
  precio_venta: number;
  costo_validado: boolean;
  es_a_granel: boolean;
}

/** Shape de `DELETE /productos/:id` (features/productos/ENDPOINTS.md sección 5). */
export interface ProductoDeleteResponse {
  id: string;
  activo: boolean;
}

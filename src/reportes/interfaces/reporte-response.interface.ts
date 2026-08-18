/**
 * Shape de cada elemento de `GET /reportes/dia` (features/vendido/ENDPOINTS.md
 * sección 2). `costo` es el costo total de la línea (`cantidad *
 * costo_unitario`), no el costo unitario — ver §5.5. `hora` es un string
 * `"HH:mm"` preformateado por el servidor (`TO_CHAR` en SQL), no un timestamp
 * ISO — ver §5.2.
 */
export interface ReporteDiaItem {
  id: string;
  producto_id: string;
  nombre_producto: string;
  cantidad: number;
  venta: number;
  costo: number;
  hora: string;
}

/**
 * Shape de cada elemento de `GET /reportes/mes` (features/vendido/ENDPOINTS.md
 * sección 3): totales agregados por producto dentro del mes/año pedidos.
 * `ganancia = SUM(venta_linea - costo_linea)` por producto.
 */
export interface ReporteMesItem {
  producto_id: string;
  nombre_producto: string;
  cantidad: number;
  venta: number;
  ganancia: number;
}

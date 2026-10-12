/**
 * Forma de la respuesta HTTP de la suscripción (contrato con el frontend,
 * `src/shared/api/suscripcion.ts`; flujo_suscripcion.md, sección 2.1).
 * Separada de las entidades de BD. snake_case y fechas ISO 8601 con zona
 * `-06:00` sin milisegundos (ver `aIsoNegocio` en `../fechas.ts`).
 *
 * No existe el estado `gracia` ni el campo `gracia_fin`: el período de gracia
 * se eliminó y el backend nunca debe producirlos.
 */

export type EstadoSuscripcionServidor =
  | 'prueba'
  | 'prueba_vencida'
  | 'activa'
  | 'cancelada'
  | 'vencida'
  | 'pago_en_proceso';

export type MotivoSuscripcion =
  'prueba_terminada' | 'cancelada' | 'cobro_fallido' | 'reembolso';

export type TiendaSuscripcion = 'google_play' | 'app_store';

export type EstadoPagoHistorial = 'pagado' | 'reembolsado' | 'fallido';

export interface PagoHistorialResponse {
  /** `external_id` del pago (ej. `GPA.3301-1234-5678-90123`). */
  id: string;
  /** `YYYY-MM` en la zona de negocio. */
  periodo: string;
  /** ISO 8601 con zona. */
  cobrado_en: string;
  monto: number;
  moneda: string;
  estado: EstadoPagoHistorial;
}

export interface SuscripcionSnapshot {
  estado: EstadoSuscripcionServidor;
  prueba_inicio: string;
  prueba_fin: string;
  acceso_hasta: string | null;
  proximo_cobro: string | null;
  renovacion_automatica: boolean;
  tienda: TiendaSuscripcion | null;
  motivo: MotivoSuscripcion | null;
  ahora_servidor: string;
  historial: PagoHistorialResponse[];
}

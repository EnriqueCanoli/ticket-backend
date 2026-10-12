import type { EstadoSuscripcionServidor } from './interfaces/suscripcion-response.interface';

/**
 * Mensaje del 403 de bloqueo. El código `SUSCRIPCION_REQUERIDA` va AL INICIO
 * porque el cliente lo detecta con `includes` (frontend,
 * `esErrorSuscripcionRequerida`).
 */
export const MENSAJE_SUSCRIPCION_REQUERIDA =
  'SUSCRIPCION_REQUERIDA: tu suscripción no está activa';

/**
 * Estados efectivos que bloquean las escrituras (POST /tickets y
 * POST/PATCH/DELETE /productos). Sin ventana de tolerancia: solo cuenta la
 * hora del servidor.
 */
export const ESTADOS_BLOQUEADOS = [
  'prueba_vencida',
  'vencida',
  'pago_en_proceso',
] as const;

export function esEstadoBloqueado(estado: EstadoSuscripcionServidor): boolean {
  return (ESTADOS_BLOQUEADOS as readonly string[]).includes(estado);
}

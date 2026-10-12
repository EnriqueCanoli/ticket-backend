import { Suscripcion } from './entities/suscripcion.entity';
import type {
  EstadoSuscripcionServidor,
  MotivoSuscripcion,
} from './interfaces/suscripcion-response.interface';

export interface EstadoEfectivo {
  estado: EstadoSuscripcionServidor;
  motivo: MotivoSuscripcion | null;
}

type FilaParaEstado = Pick<
  Suscripcion,
  'estado' | 'motivo' | 'pruebaFin' | 'accesoHasta' | 'renovacionAutomatica'
>;

/** `true` si `ahora` es estrictamente posterior a `fecha` (igual que `yaPaso` del frontend). */
function yaPaso(fecha: Date | null, ahora: Date): boolean {
  return fecha !== null && ahora.getTime() > fecha.getTime();
}

/**
 * Estado efectivo de la suscripción (flujo_suscripcion.md, sección 1.3): el
 * estado guardado ajustado por el paso del tiempo. No hay proceso que
 * actualice filas por fecha, así que se deriva en cada lectura y en cada
 * decisión de bloqueo. Función pura. Nunca devuelve `gracia`.
 *
 * - `prueba` con `ahora > prueba_fin` → `prueba_vencida` / `prueba_terminada`.
 * - `cancelada` con `acceso_hasta` no nulo y vencido → `vencida` / `cancelada`.
 * - `activa` sin renovación, con `acceso_hasta` no nulo y vencido →
 *   `vencida` / `cancelada`.
 * - `activa` con renovación → `activa` (no vence por fecha; depende de los
 *   eventos de la tienda, riesgo R-3).
 * - Cualquier otro caso: lo guardado.
 */
export function estadoEfectivo(
  fila: FilaParaEstado,
  ahora: Date,
): EstadoEfectivo {
  switch (fila.estado) {
    case 'prueba':
      if (yaPaso(fila.pruebaFin, ahora)) {
        return { estado: 'prueba_vencida', motivo: 'prueba_terminada' };
      }
      break;
    case 'cancelada':
      if (yaPaso(fila.accesoHasta, ahora)) {
        return { estado: 'vencida', motivo: 'cancelada' };
      }
      break;
    case 'activa':
      if (fila.renovacionAutomatica) {
        return { estado: 'activa', motivo: null };
      }
      if (yaPaso(fila.accesoHasta, ahora)) {
        return { estado: 'vencida', motivo: 'cancelada' };
      }
      break;
    default:
      break;
  }
  return { estado: fila.estado, motivo: fila.motivo };
}

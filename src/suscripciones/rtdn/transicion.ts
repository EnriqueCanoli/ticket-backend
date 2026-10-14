import type { Compra, EstadoCompra } from '../entities/compra.entity';
import type { Suscripcion } from '../entities/suscripcion.entity';
import { periodoNegocio } from '../fechas';
import type {
  EstadoPagoHistorial,
  MotivoSuscripcion,
} from '../interfaces/suscripcion-response.interface';
import type { SuscripcionGoogle } from '../verificadores/google-play-api';
import { dineroANumero } from '../verificadores/verificador-google';

/** Avisos que Google da por una devolución del dinero: bloquean siempre (F3). */
export const TIPOS_REEMBOLSO: ReadonlySet<string> = new Set([
  'SUBSCRIPTION_REVOKED',
  'VOIDED_PURCHASE',
]);

export type FilaTransicion = Pick<
  Suscripcion,
  | 'estado'
  | 'motivo'
  | 'accesoHasta'
  | 'proximoCobro'
  | 'renovacionAutomatica'
  | 'tienda'
>;

export type CompraTransicion = Pick<
  Compra,
  'id' | 'estado' | 'orderId' | 'periodoFin'
>;

export interface ContextoTransicion {
  productoId: string;
  /** El `latestSuccessfulOrderId` de Google ya figura en `pagos_historial`. */
  pedidoRegistrado: boolean;
  /** Datos del pedido nuevo (orders.get); null si no se consultó o falló. */
  pedido: {
    monto: number | null;
    moneda: string | null;
    creadoEn: Date | null;
  } | null;
  /** `eventTimeMillis` del aviso (respaldo de `cobrado_en`). */
  eventoEn: Date | null;
  /** Pedido que Google reembolsó (voided) o el último de la compra (REVOKED). */
  orderIdReembolso: string | null;
}

export interface PagoPlan {
  externalId: string;
  periodo: string;
  cobradoEn: Date;
  monto: number;
  moneda: string;
  estado: Extract<EstadoPagoHistorial, 'pagado' | 'fallido'>;
}

export interface CambiosSuscripcion {
  estado?: Suscripcion['estado'];
  motivo?: MotivoSuscripcion | null;
  renovacionAutomatica?: boolean;
  accesoHasta?: Date | null;
  proximoCobro?: Date | null;
  tienda?: Suscripcion['tienda'];
}

export interface CambiosCompra {
  estado?: EstadoCompra;
  periodoFin?: Date | null;
  orderId?: string | null;
}

export type ResultadoTransicion =
  'aplicado' | 'sin_cambios' | 'ignorado' | 'delegar_pendiente';

export interface PlanTransicion {
  resultado: ResultadoTransicion;
  compra: CambiosCompra;
  suscripcion: CambiosSuscripcion;
  /** El ejecutor fija `estado_desde = ahora` solo si `suscripcion.estado` cambia. */
  pagos: PagoPlan[];
  /** `external_id` del pago que pasa a `reembolsado`. */
  reembolsarPago: string | null;
  avisos: string[];
}

const ACTIVE = 'SUBSCRIPTION_STATE_ACTIVE';
const CANCELED = 'SUBSCRIPTION_STATE_CANCELED';
const EXPIRED = 'SUBSCRIPTION_STATE_EXPIRED';
const ON_HOLD = 'SUBSCRIPTION_STATE_ON_HOLD';
const IN_GRACE = 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
const PAUSED = 'SUBSCRIPTION_STATE_PAUSED';
const PENDING = 'SUBSCRIPTION_STATE_PENDING';
const PENDING_CANCELED = 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';

function fecha(texto: string | null | undefined): Date | null {
  if (!texto) return null;
  const f = new Date(texto);
  return Number.isNaN(f.getTime()) ? null : f;
}

function mismaFecha(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function vacio(resultado: ResultadoTransicion): PlanTransicion {
  return {
    resultado,
    compra: {},
    suscripcion: {},
    pagos: [],
    reembolsarPago: null,
    avisos: [],
  };
}

/**
 * Deja solo los campos de `deseado` que difieren de la fila actual, para
 * decidir `sin_cambios`.
 */
function soloDiferencias(
  fila: FilaTransicion,
  deseado: CambiosSuscripcion,
): CambiosSuscripcion {
  const salida: CambiosSuscripcion = {};
  if (deseado.estado !== undefined && deseado.estado !== fila.estado) {
    salida.estado = deseado.estado;
  }
  if (deseado.motivo !== undefined && deseado.motivo !== fila.motivo) {
    salida.motivo = deseado.motivo;
  }
  if (
    deseado.renovacionAutomatica !== undefined &&
    deseado.renovacionAutomatica !== fila.renovacionAutomatica
  ) {
    salida.renovacionAutomatica = deseado.renovacionAutomatica;
  }
  if (
    deseado.accesoHasta !== undefined &&
    !mismaFecha(deseado.accesoHasta, fila.accesoHasta)
  ) {
    salida.accesoHasta = deseado.accesoHasta;
  }
  if (
    deseado.proximoCobro !== undefined &&
    !mismaFecha(deseado.proximoCobro, fila.proximoCobro)
  ) {
    salida.proximoCobro = deseado.proximoCobro;
  }
  if (deseado.tienda !== undefined && deseado.tienda !== fila.tienda) {
    salida.tienda = deseado.tienda;
  }
  return salida;
}

function soloDiferenciasCompra(
  compra: CompraTransicion,
  deseado: CambiosCompra,
): CambiosCompra {
  const salida: CambiosCompra = {};
  if (deseado.estado !== undefined && deseado.estado !== compra.estado) {
    salida.estado = deseado.estado;
  }
  if (
    deseado.periodoFin !== undefined &&
    !mismaFecha(deseado.periodoFin, compra.periodoFin)
  ) {
    salida.periodoFin = deseado.periodoFin;
  }
  if (deseado.orderId !== undefined && deseado.orderId !== compra.orderId) {
    salida.orderId = deseado.orderId;
  }
  return salida;
}

function cerrar(
  fila: FilaTransicion,
  compra: CompraTransicion,
  plan: PlanTransicion,
): PlanTransicion {
  plan.suscripcion = soloDiferencias(fila, plan.suscripcion);
  plan.compra = soloDiferenciasCompra(compra, plan.compra);
  const hayCambios =
    Object.keys(plan.suscripcion).length > 0 ||
    Object.keys(plan.compra).length > 0 ||
    plan.pagos.length > 0 ||
    plan.reembolsarPago !== null;
  plan.resultado = hayCambios ? 'aplicado' : 'sin_cambios';
  return plan;
}

/**
 * Transición de una compra ya ligada según el estado que Google acaba de
 * dar (función pura; el ejecutor la aplica en una transacción). Tabla en
 * `src/suscripciones/README.md`. El tipo de aviso solo aporta el motivo
 * (REVOKED / voided = reembolso, F3); el estado sale siempre de `google`.
 *
 * - `otraCompraVigente`: otra compra confirmada con `periodo_fin > ahora` (F7);
 *   los avisos negativos de esta compra no tocan la cuenta.
 */
export function transicionDesdeGoogle(
  fila: FilaTransicion,
  compra: CompraTransicion,
  google: SuscripcionGoogle,
  tipo: string,
  ahora: Date,
  otraCompraVigente: boolean,
  contexto: ContextoTransicion,
): PlanTransicion {
  const estadoG = google.subscriptionState ?? '';
  const linea = google.lineItems?.find(
    (item) => item.productId === contexto.productoId,
  );
  const expiry = fecha(linea?.expiryTime);
  const ultimoPedido = linea?.latestSuccessfulOrderId ?? null;
  const autoRenovacion = linea?.autoRenewingPlan?.autoRenewEnabled === true;
  const esReembolso = TIPOS_REEMBOLSO.has(tipo);
  const reembolsoVigente =
    fila.estado === 'vencida' && fila.motivo === 'reembolso';

  // F3: un pedido NUEVO pagado (no registrado y distinto del reembolsado) con
  // Google en ACTIVE es un pago real y reactiva la cuenta.
  const pedidoNuevoPagado =
    estadoG === ACTIVE &&
    ultimoPedido !== null &&
    !contexto.pedidoRegistrado &&
    ultimoPedido !== contexto.orderIdReembolso;

  if (esReembolso) {
    const plan = vacio('aplicado');
    plan.reembolsarPago = contexto.orderIdReembolso;
    if (!pedidoNuevoPagado) {
      plan.compra.estado = 'reembolsada';
      if (!otraCompraVigente) {
        plan.suscripcion = {
          estado: 'vencida',
          motivo: 'reembolso',
          renovacionAutomatica: false,
          proximoCobro: null,
        };
      }
      return cerrar(fila, compra, plan);
    }
    // Hay un pedido nuevo pagado: el reembolso afecta solo al pedido viejo y
    // lo demás se resuelve como una activación normal.
    const activacion = planActivo({
      fila,
      compra,
      expiry,
      autoRenovacion,
      ultimoPedido,
      ahora,
      contexto,
      google,
      linea,
    });
    activacion.reembolsarPago = plan.reembolsarPago;
    return cerrar(fila, compra, activacion);
  }

  // Un aviso sin pedido nuevo nunca quita el motivo `reembolso`.
  if (reembolsoVigente && !pedidoNuevoPagado) {
    const plan = vacio('sin_cambios');
    if (
      (estadoG === EXPIRED ||
        (estadoG === CANCELED && expiry && expiry <= ahora)) &&
      compra.estado === 'confirmada'
    ) {
      plan.compra.estado = 'expirada';
    }
    return cerrar(fila, compra, plan);
  }

  if (estadoG === PENDING || estadoG === PENDING_CANCELED) {
    return vacio(
      compra.estado === 'pendiente' ? 'delegar_pendiente' : 'ignorado',
    );
  }

  if (!linea) return vacio('ignorado');

  switch (estadoG) {
    case ACTIVE: {
      if (expiry === null) return vacio('ignorado');
      return cerrar(
        fila,
        compra,
        planActivo({
          fila,
          compra,
          expiry,
          autoRenovacion,
          ultimoPedido,
          ahora,
          contexto,
          google,
          linea,
        }),
      );
    }

    case CANCELED:
    case EXPIRED: {
      const vigente = estadoG === CANCELED && expiry !== null && expiry > ahora;
      if (vigente) {
        // F4: sigue trabajando hasta `expiryTime`.
        const plan = vacio('aplicado');
        plan.compra = {
          estado: 'confirmada',
          periodoFin: expiry,
          ...(ultimoPedido ? { orderId: ultimoPedido } : {}),
        };
        if (!otraCompraVigente) {
          plan.suscripcion = {
            estado: 'cancelada',
            renovacionAutomatica: false,
            proximoCobro: null,
            accesoHasta: expiry,
            tienda: 'google_play',
            motivo: null,
          };
        }
        agregarPagoNuevo(plan, {
          fila,
          ultimoPedido,
          ahora,
          contexto,
          linea,
        });
        return cerrar(fila, compra, plan);
      }

      const plan = vacio('aplicado');
      plan.compra.estado = 'expirada';
      const reemplazo =
        google.canceledStateContext?.replacementCancellation !== undefined &&
        google.canceledStateContext.replacementCancellation !== null;
      if (!otraCompraVigente && !reemplazo) {
        const sistema =
          google.canceledStateContext?.systemInitiatedCancellation !==
            undefined &&
          google.canceledStateContext.systemInitiatedCancellation !== null;
        let motivo: MotivoSuscripcion = 'cancelada';
        if (
          sistema ||
          (fila.estado === 'vencida' && fila.motivo === 'cobro_fallido')
        ) {
          motivo = 'cobro_fallido';
        }
        plan.suscripcion = {
          estado: 'vencida',
          motivo,
          renovacionAutomatica: false,
          proximoCobro: null,
          ...(expiry ? { accesoHasta: expiry } : {}),
        };
      }
      return cerrar(fila, compra, plan);
    }

    case ON_HOLD:
    case IN_GRACE: {
      // F1 y F2: se bloquea en cuanto llega el aviso y el fallo se anota.
      const plan = vacio('aplicado');
      if (!otraCompraVigente) {
        plan.suscripcion = {
          estado: 'vencida',
          motivo: 'cobro_fallido',
          renovacionAutomatica: false,
          proximoCobro: null,
        };
        const yaBloqueada =
          fila.estado === 'vencida' && fila.motivo === 'cobro_fallido';
        if (!yaBloqueada) {
          const cobradoEn = fila.accesoHasta ?? ahora;
          const periodo = periodoNegocio(cobradoEn);
          const precio = linea.autoRenewingPlan?.recurringPrice;
          plan.pagos.push({
            externalId: `fallido-${compra.id}-${periodo}`,
            periodo,
            cobradoEn,
            monto: (precio ? dineroANumero(precio) : null) ?? 0,
            moneda: precio?.currencyCode ?? 'MXN',
            estado: 'fallido',
          });
        }
      }
      return cerrar(fila, compra, plan);
    }

    case PAUSED: {
      const plan = vacio('aplicado');
      if (!otraCompraVigente) {
        plan.suscripcion = {
          estado: 'vencida',
          motivo: 'cancelada',
          renovacionAutomatica: false,
          proximoCobro: null,
        };
      }
      return cerrar(fila, compra, plan);
    }

    default:
      return vacio('ignorado');
  }
}

interface EntradaPlanActivo {
  fila: FilaTransicion;
  compra: CompraTransicion;
  expiry: Date | null;
  autoRenovacion: boolean;
  ultimoPedido: string | null;
  ahora: Date;
  contexto: ContextoTransicion;
  google: SuscripcionGoogle;
  linea: NonNullable<SuscripcionGoogle['lineItems']>[number] | undefined;
}

function planActivo(e: EntradaPlanActivo): PlanTransicion {
  const plan = vacio('aplicado');
  plan.compra = {
    estado: 'confirmada',
    periodoFin: e.expiry,
    ...(e.ultimoPedido ? { orderId: e.ultimoPedido } : {}),
  };
  plan.suscripcion = {
    estado: 'activa',
    renovacionAutomatica: e.autoRenovacion,
    accesoHasta: e.expiry,
    proximoCobro: e.autoRenovacion ? e.expiry : null,
    tienda: 'google_play',
    motivo: null,
  };
  agregarPagoNuevo(plan, e);
  return plan;
}

/** Fila `pagado` si el último pedido de Google aún no está registrado. */
function agregarPagoNuevo(
  plan: PlanTransicion,
  e: Pick<
    EntradaPlanActivo,
    'fila' | 'ultimoPedido' | 'ahora' | 'contexto' | 'linea'
  >,
): void {
  if (e.ultimoPedido === null || e.contexto.pedidoRegistrado) return;
  const respaldo = e.linea?.autoRenewingPlan?.recurringPrice;
  let monto = e.contexto.pedido?.monto ?? null;
  let moneda = e.contexto.pedido?.moneda ?? null;
  if (monto === null || moneda === null) {
    monto = respaldo ? dineroANumero(respaldo) : null;
    moneda = respaldo?.currencyCode ?? null;
    plan.avisos.push(
      monto === null
        ? `El pedido ${e.ultimoPedido} no trae monto: se registra 0`
        : `El pedido ${e.ultimoPedido} no trae total: se usa el precio recurrente`,
    );
  }
  const cobradoEn =
    e.contexto.pedido?.creadoEn ?? e.contexto.eventoEn ?? e.ahora;
  plan.pagos.push({
    externalId: e.ultimoPedido,
    periodo: periodoNegocio(cobradoEn),
    cobradoEn,
    monto: monto ?? 0,
    moneda: moneda ?? 'MXN',
    estado: 'pagado',
  });
}

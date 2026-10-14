import { createHash } from 'node:crypto';
import { sumarUnMesNegocio } from '../fechas';
import type {
  GooglePlayApi,
  SuscripcionGoogle,
} from '../verificadores/google-play-api';
import {
  MONEDA_SIMULADA,
  MONTO_SIMULADO,
} from '../verificadores/verificador-simulado';

export interface ConsultaEstadoGoogle {
  token: string;
  productoId: string;
  /** `notificationType` del aviso; null en una reconciliación. Solo lo usa la fuente simulada. */
  tipoNotificacion: number | null;
  /** Compra guardada (si existe). Solo lo usa la fuente simulada. */
  compra: {
    estado: string;
    orderId: string | null;
    periodoFin: Date | null;
  } | null;
}

/**
 * Estado actual de una suscripción en la tienda. En modo google es
 * `purchases.subscriptionsv2.get`; en modo simulada se construye a partir del
 * tipo de aviso (F12). Un fallo se propaga con su código HTTP.
 */
export interface FuenteEstadoGoogle {
  obtener(consulta: ConsultaEstadoGoogle): Promise<SuscripcionGoogle>;
}

export const FUENTE_ESTADO_GOOGLE = Symbol('FUENTE_ESTADO_GOOGLE');

export class FuenteEstadoReal implements FuenteEstadoGoogle {
  constructor(private readonly api: GooglePlayApi) {}

  obtener({ token }: ConsultaEstadoGoogle): Promise<SuscripcionGoogle> {
    return this.api.obtenerSuscripcion(token);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 24);
}

/** Error con `status` 404, como el que da Google para un token inexistente. */
function tokenInexistente(): Error & { status: number } {
  return Object.assign(new Error('Compra simulada inexistente'), {
    status: 404,
  });
}

/**
 * Fuente simulada (solo desarrollo y pruebas con curl, F12). Tabla:
 *
 * | notificationType                                   | Estado simulado                         |
 * |----------------------------------------------------|-----------------------------------------|
 * | 2 RENEWED, 1 RECOVERED                             | ACTIVE, orderId nuevo `SIM-<hash>-R<n>`, expiry = +1 mes de max(ahora, periodo_fin) |
 * | 4 PURCHASED, 9 DEFERRED                            | ACTIVE, expiry = +1 mes de max(ahora, periodo_fin) |
 * | 7 RESTARTED                                        | ACTIVE, expiry = periodo_fin            |
 * | 3 CANCELED                                         | CANCELED, expiry = periodo_fin          |
 * | 5 ON_HOLD, 6 IN_GRACE_PERIOD                       | ON_HOLD, expiry en el pasado            |
 * | 12 REVOKED, 13 EXPIRED                             | EXPIRED                                 |
 * | 20 PENDING_PURCHASE_CANCELED                       | el mismo estado de la compra guardada   |
 * | otro / null (reconciliación)                       | ACTIVE con la fecha guardada            |
 *
 * Una compra no guardada solo existe si el token empieza por `mock-`; en otro
 * caso responde 404 (token inválido). Monto 99.00 MXN: solo modo simulado (desarrollo y tests); el monto real sale de Google (E3).
 */
export class FuenteEstadoSimulada implements FuenteEstadoGoogle {
  constructor(private readonly reloj: () => Date = () => new Date()) {}

  obtener(consulta: ConsultaEstadoGoogle): Promise<SuscripcionGoogle> {
    try {
      return Promise.resolve(this.construir(consulta));
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private construir({
    token,
    productoId,
    tipoNotificacion,
    compra,
  }: ConsultaEstadoGoogle): SuscripcionGoogle {
    if (!compra && !token.startsWith('mock-')) throw tokenInexistente();

    const ahora = this.reloj();
    const base = `SIM-${hashToken(token)}`;
    const periodoFin = compra?.periodoFin ?? null;
    const referencia =
      periodoFin && periodoFin.getTime() > ahora.getTime() ? periodoFin : ahora;
    const siguiente = sumarUnMesNegocio(referencia);

    let estado = 'SUBSCRIPTION_STATE_ACTIVE';
    let expiry: Date = periodoFin ?? siguiente;
    let autoRenew = true;
    let orderId = compra?.orderId ?? base;

    switch (tipoNotificacion) {
      case 1:
      case 2: {
        expiry = siguiente;
        const previo = /-R(\d+)$/.exec(compra?.orderId ?? '');
        orderId = `${base}-R${previo ? Number(previo[1]) + 1 : 1}`;
        break;
      }
      case 4:
      case 9:
        expiry = siguiente;
        break;
      case 7:
        expiry = periodoFin ?? siguiente;
        break;
      case 3:
        estado = 'SUBSCRIPTION_STATE_CANCELED';
        autoRenew = false;
        expiry = periodoFin ?? siguiente;
        break;
      case 5:
      case 6:
        estado = 'SUBSCRIPTION_STATE_ON_HOLD';
        autoRenew = false;
        expiry =
          periodoFin && periodoFin.getTime() <= ahora.getTime()
            ? periodoFin
            : new Date(ahora.getTime() - 3_600_000);
        break;
      case 12:
      case 13:
        estado = 'SUBSCRIPTION_STATE_EXPIRED';
        autoRenew = false;
        expiry = periodoFin ?? ahora;
        break;
      case 20:
        estado =
          compra?.estado === 'pendiente'
            ? 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'
            : 'SUBSCRIPTION_STATE_ACTIVE';
        break;
      default:
        break;
    }

    if (token.startsWith('mock-pendiente-') && !compra) {
      estado = 'SUBSCRIPTION_STATE_PENDING';
    }

    return {
      subscriptionState: estado,
      startTime: ahora.toISOString(),
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      lineItems: [
        {
          productId: productoId,
          expiryTime: expiry.toISOString(),
          latestSuccessfulOrderId: orderId,
          autoRenewingPlan: {
            autoRenewEnabled: autoRenew,
            recurringPrice: {
              currencyCode: MONEDA_SIMULADA,
              units: String(MONTO_SIMULADO),
              nanos: 0,
            },
          },
        },
      ],
    };
  }
}

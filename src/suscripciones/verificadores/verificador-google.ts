import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { GooglePlayApi, SuscripcionGoogle } from './google-play-api';
import type {
  EntradaVerificacion,
  ResultadoVerificacion,
  VerificadorTienda,
} from './verificador-tienda.interface';

export const MENSAJE_TIENDA_NO_DISPONIBLE =
  'TIENDA_NO_DISPONIBLE: no pudimos confirmar el pago con la tienda, intenta de nuevo';

const RECHAZADA: ResultadoVerificacion = {
  estado: 'rechazada',
  orderId: null,
  periodoInicio: null,
  periodoFin: null,
  autoRenovacion: false,
  cuentaOfuscada: null,
  monto: null,
  moneda: null,
  yaReconocida: false,
};

/** Códigos HTTP con los que Google dice "esa compra no existe / no es válida". */
const HTTP_COMPRA_INVALIDA = new Set([400, 404, 410]);

interface DineroGoogle {
  units?: string | null;
  nanos?: number | null;
  currencyCode?: string | null;
}

/** Código HTTP de un error de gaxios/googleapis, o null si no fue una respuesta HTTP. */
export function estadoHttp(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  for (const candidato of [e.response?.status, e.status, e.code]) {
    const numero =
      typeof candidato === 'string' ? Number(candidato) : candidato;
    if (typeof numero === 'number' && Number.isInteger(numero)) {
      return numero;
    }
  }
  return null;
}

/** `Money` de Google (units como texto + nanos) → número con 2 decimales. */
export function dineroANumero(dinero: DineroGoogle): number | null {
  if (dinero.units == null && dinero.nanos == null) return null;
  const unidades = Number(dinero.units ?? 0);
  const nanos = dinero.nanos ?? 0;
  if (!Number.isFinite(unidades) || !Number.isFinite(nanos)) return null;
  return Math.round((unidades + nanos / 1e9) * 100) / 100;
}

/**
 * Verificador real (etapa 4b) sobre la Google Play Developer API
 * (`purchases.subscriptionsv2.get`).
 *
 * | subscriptionState (SUBSCRIPTION_STATE_*)  | Resultado                    |
 * |-------------------------------------------|------------------------------|
 * | ACTIVE                                    | activa (autoRenewEnabled)    |
 * | CANCELED con expiryTime futuro            | activa, sin renovación       |
 * | CANCELED con expiryTime pasado            | rechazada                    |
 * | PENDING                                   | pendiente                    |
 * | IN_GRACE_PERIOD, ON_HOLD (E5)             | rechazada                    |
 * | PAUSED, EXPIRED, PENDING_PURCHASE_CANCELED, UNSPECIFIED | rechazada      |
 *
 * Los errores de red, timeout, 401, 403, 429 y 5xx NUNCA se convierten en
 * `rechazada`: dan `TIENDA_NO_DISPONIBLE` (503). Nunca se registran el token,
 * las credenciales ni la respuesta cruda (los mensajes de error de la
 * librería pueden incluir la URL con el token, así que solo se registra el
 * código HTTP).
 */
export class VerificadorGoogle implements VerificadorTienda {
  private readonly logger = new Logger(VerificadorGoogle.name);

  constructor(
    private readonly api: GooglePlayApi,
    private readonly reloj: () => Date = () => new Date(),
  ) {}

  async verificar(
    entrada: EntradaVerificacion,
  ): Promise<ResultadoVerificacion> {
    let compra: SuscripcionGoogle;
    try {
      compra = await this.api.obtenerSuscripcion(entrada.tokenCompra);
    } catch (error) {
      const http = estadoHttp(error);
      if (http !== null && HTTP_COMPRA_INVALIDA.has(http)) {
        return { ...RECHAZADA };
      }
      this.logger.warn(
        `Google Play no disponible al verificar una compra (http ${http ?? 'sin respuesta'})`,
      );
      throw new ServiceUnavailableException(MENSAJE_TIENDA_NO_DISPONIBLE);
    }

    const linea = compra.lineItems?.find(
      (item) => item.productId === entrada.productoId,
    );
    if (!linea) return { ...RECHAZADA };

    const ahora = this.reloj();
    const expiracion = this.fecha(linea.expiryTime);

    let estado: 'activa' | 'pendiente' | 'rechazada';
    let autoRenovacion = false;
    switch (compra.subscriptionState ?? '') {
      case 'SUBSCRIPTION_STATE_ACTIVE':
        estado = 'activa';
        autoRenovacion = linea.autoRenewingPlan?.autoRenewEnabled === true;
        break;
      case 'SUBSCRIPTION_STATE_CANCELED':
        estado =
          expiracion !== null && expiracion > ahora ? 'activa' : 'rechazada';
        break;
      case 'SUBSCRIPTION_STATE_PENDING':
        estado = 'pendiente';
        break;
      default:
        // IN_GRACE_PERIOD y ON_HOLD (E5), PAUSED, EXPIRED,
        // PENDING_PURCHASE_CANCELED y UNSPECIFIED.
        estado = 'rechazada';
    }
    if (estado === 'rechazada') return { ...RECHAZADA };

    // `latestOrderId` no existe en subscriptionsv2 (solo en el v1 antiguo).
    const orderId = linea.latestSuccessfulOrderId ?? null;
    if (compra.testPurchase) {
      this.logger.log(
        `Compra de prueba (testPurchase) del usuario ${entrada.usuarioId ?? 'desconocido'} (orderId ${orderId ?? 'sin pedido'})`,
      );
    }

    const yaReconocida =
      compra.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    const cuentaOfuscada =
      compra.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null;

    if (estado === 'pendiente') {
      return {
        estado,
        orderId,
        periodoInicio: null,
        periodoFin: null,
        autoRenovacion: false,
        cuentaOfuscada,
        monto: null,
        moneda: null,
        yaReconocida,
      };
    }

    const { monto, moneda } = await this.montoPagado(
      orderId,
      linea.autoRenewingPlan?.recurringPrice,
    );
    return {
      estado,
      orderId,
      // `startTime` es el momento en que se concedió la suscripción (alta
      // original), no el inicio del período en curso; sirve de referencia
      // para `cobrado_en`/`periodo`. Las renovaciones llegan por RTDN (etapa 5).
      periodoInicio: this.fecha(compra.startTime),
      // E2: las fechas son las de Google, no `sumarUnMesNegocio`.
      periodoFin: expiracion,
      autoRenovacion,
      cuentaOfuscada,
      monto,
      moneda,
      yaReconocida,
    };
  }

  /**
   * Acknowledge. "Ya reconocida" cuenta como éxito: si Google rechaza la
   * llamada con 400/409, se relee la compra y, si ya figura como reconocida,
   * no es un error.
   */
  async reconocer(entrada: EntradaVerificacion): Promise<void> {
    try {
      await this.api.reconocer(entrada.productoId, entrada.tokenCompra);
    } catch (error) {
      const http = estadoHttp(error);
      if (http === 400 || http === 409) {
        try {
          const compra = await this.api.obtenerSuscripcion(entrada.tokenCompra);
          if (
            compra.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
          ) {
            return;
          }
        } catch {
          // Se informa el fallo original.
        }
      }
      throw new Error(
        `Google Play rechazó el acknowledge (http ${http ?? 'sin respuesta'})`,
      );
    }
  }

  /** E3: total pagado por el cliente (orders.get); respaldo `recurringPrice`. */
  private async montoPagado(
    orderId: string | null,
    precioRecurrente: DineroGoogle | null | undefined,
  ): Promise<{ monto: number | null; moneda: string | null }> {
    if (orderId !== null) {
      try {
        const total = (await this.api.obtenerPedido(orderId)).total;
        const monto = total ? dineroANumero(total) : null;
        if (total && monto !== null && total.currencyCode) {
          return { monto, moneda: total.currencyCode };
        }
        this.logger.warn(
          `El pedido ${orderId} no trae total; se usa el precio recurrente`,
        );
      } catch (error) {
        this.logger.warn(
          `No se pudo leer el pedido ${orderId} (http ${estadoHttp(error) ?? 'sin respuesta'}); se usa el precio recurrente`,
        );
      }
    } else {
      this.logger.warn(
        'La compra no trae orderId; se usa el precio recurrente',
      );
    }
    if (!precioRecurrente) return { monto: null, moneda: null };
    const monto = dineroANumero(precioRecurrente);
    if (monto === null || !precioRecurrente.currencyCode) {
      return { monto: null, moneda: null };
    }
    return { monto, moneda: precioRecurrente.currencyCode };
  }

  private fecha(texto: string | null | undefined): Date | null {
    if (!texto) return null;
    const fecha = new Date(texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }
}

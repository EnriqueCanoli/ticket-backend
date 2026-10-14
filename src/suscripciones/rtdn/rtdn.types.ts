import { createHash } from 'node:crypto';

/**
 * Cuerpo del push de Pub/Sub. Es una INTERFACE (no una clase DTO) a propósito:
 * el `ValidationPipe` global usa `forbidNonWhitelisted` y rechazaría cualquier
 * campo que Pub/Sub añada.
 */
export interface SobrePubSub {
  message?: {
    data?: string;
    messageId?: string;
    message_id?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
  deliveryAttempt?: number;
}

export const LONGITUD_MAXIMA_MESSAGE_ID = 100;

export type TipoEvento =
  | `SUBSCRIPTION_${string}`
  | 'VOIDED_PURCHASE'
  | 'TEST'
  | 'ONE_TIME_PRODUCT'
  | 'PENDING_REFUND_REVIEW'
  | 'DESCONOCIDO';

/** Nombres de `subscriptionNotification.notificationType` (documentación oficial de RTDN). */
export const NOMBRES_TIPO_SUSCRIPCION: Readonly<Record<number, string>> = {
  1: 'RECOVERED',
  2: 'RENEWED',
  3: 'CANCELED',
  4: 'PURCHASED',
  5: 'ON_HOLD',
  6: 'IN_GRACE_PERIOD',
  7: 'RESTARTED',
  8: 'PRICE_CHANGE_CONFIRMED',
  9: 'DEFERRED',
  10: 'PAUSED',
  11: 'PAUSE_SCHEDULE_CHANGED',
  12: 'REVOKED',
  13: 'EXPIRED',
  17: 'ITEMS_CHANGED',
  18: 'CANCELLATION_SCHEDULED',
  19: 'PRICE_CHANGE_UPDATED',
  20: 'PENDING_PURCHASE_CANCELED',
  22: 'PRICE_STEP_UP_CONSENT_UPDATED',
};

/** Tipos que no afectan al estado y se confirman sin consultar a Google. */
const TIPOS_SUSCRIPCION_IGNORADOS: ReadonlySet<number> = new Set([11]);

export type MensajeRtdn =
  | {
      clase: 'suscripcion';
      tipoNumero: number;
      tipo: TipoEvento;
      token: string;
      ignorado: boolean;
    }
  | {
      clase: 'voided';
      tipo: 'VOIDED_PURCHASE';
      token: string;
      orderId: string;
      productType: number | null;
      refundType: number | null;
    }
  | { clase: 'prueba'; tipo: 'TEST' }
  | { clase: 'otro'; tipo: TipoEvento };

export interface MensajeDecodificado {
  mensaje: MensajeRtdn;
  paquete: string | null;
  eventoEn: Date | null;
  /** Payload apto para guardar: los tokens van como `sha256:<16 hex>` (F8). */
  payload: Record<string, unknown>;
}

const CLAVES_TOKEN = new Set([
  'purchaseToken',
  'linkedPurchaseToken',
  'expiredPurchaseToken',
  'pendingRefundToken',
]);

export function huellaToken(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

/** Copia profunda con todo token sustituido por su huella (F8). */
export function sanitizarPayload(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(sanitizarPayload);
  if (typeof valor === 'object' && valor !== null) {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor)) {
      salida[clave] =
        CLAVES_TOKEN.has(clave) && typeof v === 'string'
          ? huellaToken(v)
          : sanitizarPayload(v);
    }
    return salida;
  }
  return valor;
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : null;
}

export function nombreTipoSuscripcion(numero: number): TipoEvento {
  return `SUBSCRIPTION_${NOMBRES_TIPO_SUSCRIPCION[numero] ?? String(numero)}`;
}

/**
 * Decodifica `message.data` (base64 → JSON). Devuelve null si no es un JSON de
 * objeto. NUNCA lanza.
 */
export function decodificarMensaje(
  data: string | undefined,
): MensajeDecodificado | null {
  if (typeof data !== 'string' || data === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const cuerpo = objeto(json);
  if (!cuerpo) return null;

  const paquete =
    typeof cuerpo.packageName === 'string' ? cuerpo.packageName : null;
  const milis = Number(cuerpo.eventTimeMillis);
  const eventoEn = Number.isFinite(milis) && milis > 0 ? new Date(milis) : null;
  const payload = sanitizarPayload(cuerpo) as Record<string, unknown>;

  const suscripcion = objeto(cuerpo.subscriptionNotification);
  const voided = objeto(cuerpo.voidedPurchaseNotification);
  let mensaje: MensajeRtdn;

  if (
    suscripcion &&
    typeof suscripcion.notificationType === 'number' &&
    typeof suscripcion.purchaseToken === 'string' &&
    suscripcion.purchaseToken !== ''
  ) {
    const numero = suscripcion.notificationType;
    mensaje = {
      clase: 'suscripcion',
      tipoNumero: numero,
      tipo: nombreTipoSuscripcion(numero),
      token: suscripcion.purchaseToken,
      ignorado:
        TIPOS_SUSCRIPCION_IGNORADOS.has(numero) ||
        !(numero in NOMBRES_TIPO_SUSCRIPCION),
    };
  } else if (
    voided &&
    typeof voided.purchaseToken === 'string' &&
    voided.purchaseToken !== ''
  ) {
    mensaje = {
      clase: 'voided',
      tipo: 'VOIDED_PURCHASE',
      token: voided.purchaseToken,
      orderId: typeof voided.orderId === 'string' ? voided.orderId : '',
      productType:
        typeof voided.productType === 'number' ? voided.productType : null,
      refundType:
        typeof voided.refundType === 'number' ? voided.refundType : null,
    };
  } else if (objeto(cuerpo.testNotification)) {
    mensaje = { clase: 'prueba', tipo: 'TEST' };
  } else if (objeto(cuerpo.oneTimeProductNotification)) {
    mensaje = { clase: 'otro', tipo: 'ONE_TIME_PRODUCT' };
  } else if (objeto(cuerpo.pendingRefundReviewNotification)) {
    mensaje = { clase: 'otro', tipo: 'PENDING_REFUND_REVIEW' };
  } else {
    mensaje = { clase: 'otro', tipo: 'DESCONOCIDO' };
  }
  return { mensaje, paquete, eventoEn, payload };
}

import {
  androidpublisher,
  auth as googleAuth,
} from '@googleapis/androidpublisher';
import type { androidpublisher_v3 } from '@googleapis/androidpublisher';
import type { CredencialesGoogle } from '../config-suscripcion';

export type SuscripcionGoogle =
  androidpublisher_v3.Schema$SubscriptionPurchaseV2;
export type PedidoGoogle = androidpublisher_v3.Schema$Order;

/** Tiempo máximo de cada llamada a Google. */
export const TIMEOUT_GOOGLE_MS = 10_000;

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * Frontera con la Google Play Developer API. Se mockea siempre en los tests.
 * Un fallo se propaga tal cual (con `code`/`status` numérico si fue una
 * respuesta HTTP); `VerificadorGoogle` decide qué hacer. NUNCA se registra el
 * token, las credenciales ni la respuesta cruda.
 */
export interface GooglePlayApi {
  /** purchases.subscriptionsv2.get */
  obtenerSuscripcion(token: string): Promise<SuscripcionGoogle>;
  /** purchases.subscriptions.acknowledge */
  reconocer(productoId: string, token: string): Promise<void>;
  /** orders.get */
  obtenerPedido(orderId: string): Promise<PedidoGoogle>;
}

export const GOOGLE_PLAY_API = Symbol('GOOGLE_PLAY_API');

export class GooglePlayApiReal implements GooglePlayApi {
  private readonly api: androidpublisher_v3.Androidpublisher;

  constructor(
    private readonly paquete: string,
    credenciales: CredencialesGoogle,
  ) {
    const authCliente = new googleAuth.GoogleAuth({
      credentials: credenciales,
      scopes: [SCOPE],
    });
    this.api = androidpublisher({ version: 'v3', auth: authCliente });
  }

  async obtenerSuscripcion(token: string): Promise<SuscripcionGoogle> {
    const respuesta = await this.api.purchases.subscriptionsv2.get(
      { packageName: this.paquete, token },
      { timeout: TIMEOUT_GOOGLE_MS },
    );
    return respuesta.data;
  }

  async reconocer(productoId: string, token: string): Promise<void> {
    await this.api.purchases.subscriptions.acknowledge(
      { packageName: this.paquete, subscriptionId: productoId, token },
      { timeout: TIMEOUT_GOOGLE_MS },
    );
  }

  async obtenerPedido(orderId: string): Promise<PedidoGoogle> {
    const respuesta = await this.api.orders.get(
      { packageName: this.paquete, orderId },
      { timeout: TIMEOUT_GOOGLE_MS },
    );
    return respuesta.data;
  }
}

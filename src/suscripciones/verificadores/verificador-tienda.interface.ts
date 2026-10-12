export type EstadoVerificacion = 'activa' | 'pendiente' | 'rechazada';

export interface ResultadoVerificacion {
  estado: EstadoVerificacion;
  orderId: string | null;
  periodoInicio: Date | null;
  periodoFin: Date | null;
  autoRenovacion: boolean;
  /** Id de cuenta que la tienda asocia a la compra; null si no viene. */
  cuentaOfuscada: string | null;
  monto: number | null;
  moneda: string | null;
}

export interface EntradaVerificacion {
  productoId: string;
  tokenCompra: string;
}

export interface VerificadorTienda {
  verificar(entrada: EntradaVerificacion): Promise<ResultadoVerificacion>;
  /** Acknowledge de la compra en la tienda. */
  reconocer(entrada: EntradaVerificacion): Promise<void>;
}

export const VERIFICADOR_TIENDA = Symbol('VERIFICADOR_TIENDA');

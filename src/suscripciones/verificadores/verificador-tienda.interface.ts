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
  /** La tienda ya la reconoció (acknowledge); el simulado siempre false. */
  yaReconocida: boolean;
}

export interface EntradaVerificacion {
  productoId: string;
  tokenCompra: string;
  /** Solo para registrar en el log (nunca el token); opcional. */
  usuarioId?: string;
}

export interface VerificadorTienda {
  verificar(entrada: EntradaVerificacion): Promise<ResultadoVerificacion>;
  /** Acknowledge de la compra en la tienda. */
  reconocer(entrada: EntradaVerificacion): Promise<void>;
}

export const VERIFICADOR_TIENDA = Symbol('VERIFICADOR_TIENDA');
